// dshx-multi-ask — host half.
//
// Ask the same question to several models at once and read their answers side
// by side in a right-sidebar panel. The browser fires one POST /ask per model
// in parallel; each request is an independent, streamed model call. Nothing is
// written to any session log.
//
// Each model keeps its OWN thread: the browser sends, per model, the earlier
// question/answer pairs that model produced, so follow-ups continue each
// model's own line of thought.
//
// Optional "带上主对话": the current conversation's visible transcript is
// rendered to plain text (tool calls and results summarised, capped by
// maxContextChars, newest kept) and put in front of the first question. Plain
// text instead of the raw message array, so every provider accepts it no
// matter which tools or block types the main session used.
//
// ROUTES (same-origin, behind the connection trust fence when present)
//
//   POST /dshx-multi-ask/ask      { provider, model, question, history?, sessionId?, withContext? }
//                                 -> application/x-ndjson stream of
//                                    {type:'meta'|'thinking'|'text'|'done'|'error', …}
//   GET  /dshx-multi-ask/models   -> { groups: [{ id, name, models: [{id,name}] }] }
//   GET  /dshx-multi-ask/pending?sessionId=<id>  -> { questions: string[] }  (consumes)
//
// COMMAND  /multi [question] — opens the panel; a question is handed to the
// panel and asked to every selected model (it is NOT sent to the main model).

import { createAssistantMessage, createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'dshx-multi-ask'
export const inject = ['webServer', 'sessions', 'llm']

export const Config = z.object({
  maxTurns: z.natural().default(20).description('每个模型追问时最多带上多少轮之前的问答'),
  maxContextChars: z.natural().default(60000).description('“带上主对话”时最多附带多少字符的主对话记录（保留最新部分）'),
  maxOutputTokens: z.natural().default(0).description('每个回答的输出上限；0 = 模型默认值'),
  requestTimeoutSeconds: z.natural().default(600).description('单个模型请求的超时（秒）'),
})

const BASE = '/dshx-multi-ask'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_QUESTION_CHARS = 40000
const MAX_TOOL_SNIPPET = 1500
const PENDING_TTL_MS = 5 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const userSource = { kind: 'plugin', plugin: name }

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

/** Candidate ids for a session id from the browser (`session-<uuid>` or bare uuid). */
export function idCandidates(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) return []
  const out = [sessionId]
  const bare = sessionId.startsWith('session-') ? sessionId.slice(8) : sessionId
  if (UUID.test(bare)) {
    for (const id of ['session-' + bare.toLowerCase(), bare.toLowerCase()]) if (!out.includes(id)) out.push(id)
  }
  return out
}

// ------------------------------------------------------------- history

/**
 * Normalize one model's earlier thread sent by the browser.
 * @param raw - `[{ question, answer }]`.
 * @param max - most recent pairs to keep (0 = none).
 * @returns cleaned pairs, newest last.
 */
export function cleanHistory(raw, max) {
  if (!Array.isArray(raw)) return []
  const pairs = []
  for (const item of raw) {
    const question = typeof item?.question === 'string' ? item.question.slice(0, MAX_QUESTION_CHARS) : ''
    const answer = typeof item?.answer === 'string' ? item.answer.slice(0, 200000) : ''
    if (question.trim() && answer.trim()) pairs.push({ question, answer })
  }
  return max > 0 ? pairs.slice(-max) : []
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + ` …（截断，共 ${s.length} 字）` : s
}

function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[图片]')
    else if (block?.type === 'file') parts.push('[文件' + (block.name ? ' ' + block.name : '') + ']')
  }
  return parts.join('\n')
}

/**
 * Render a session's derived messages as a plain-text transcript. The system
 * prompt is left out; tool calls and results are summarised.
 * @param messages - `session.deriveMessages()`.
 * @param maxChars - cap; the newest part is kept.
 * @returns the transcript text ('' when nothing visible).
 */
export function renderTranscript(messages, maxChars) {
  if (!Array.isArray(messages) || maxChars <= 0) return ''
  const lines = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'user') {
      const text = blocksText(message.content).trim()
      if (text) lines.push('【用户】\n' + text)
    } else if (message.role === 'assistant') {
      const parts = []
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'text' && block.text?.trim()) parts.push(block.text.trim())
        else if (block?.type === 'tool-call') parts.push(`[调用工具 ${block.name ?? '?'} ${clip(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}), 300)}]`)
      }
      if (parts.length) lines.push('【助手】\n' + parts.join('\n'))
    } else if (message.role === 'tool') {
      const text = blocksText(message.content).trim()
      lines.push('【工具结果】\n' + (text ? clip(text, MAX_TOOL_SNIPPET) : '(无文本)'))
    }
  }
  let out = lines.join('\n\n')
  if (out.length > maxChars) out = '…（更早的内容已省略）\n' + out.slice(out.length - maxChars)
  return out
}

/** The first question, optionally prefixed with the main transcript. */
export function framedQuestion(question, transcript) {
  if (!transcript) return question
  return [
    '下面是我和另一个 AI 助手的一段对话记录，供你参考：',
    '<conversation>',
    transcript,
    '</conversation>',
    '',
    '基于以上背景，请回答我的问题（直接回答，用我提问的语言）：',
    question,
  ].join('\n')
}

/**
 * Build the message list for one model.
 * @param pairs - this model's earlier thread.
 * @param question - the new question.
 * @param transcript - main transcript text or ''.
 * @param route - `{ provider, model }`, used to attribute earlier answers.
 * @returns messages ready for `llm.stream`.
 */
export function buildMessages(pairs, question, transcript, route) {
  const messages = []
  pairs.forEach((pair, index) => {
    messages.push(createUserMessage({ content: [{ type: 'text', text: index === 0 ? framedQuestion(pair.question, transcript) : pair.question }], source: userSource }))
    messages.push(createAssistantMessage({ content: [{ type: 'text', text: pair.answer }], source: { provider: route.provider, model: route.model } }))
  })
  messages.push(createUserMessage({ content: [{ type: 'text', text: pairs.length === 0 ? framedQuestion(question, transcript) : question }], source: userSource }))
  return messages
}

// -------------------------------------------------------------- pending /multi

const pending = new Map()

export function pushPending(sessionId, question) {
  const now = Date.now()
  const list = (pending.get(sessionId) ?? []).filter((item) => now - item.at < PENDING_TTL_MS)
  list.push({ question, at: now })
  pending.set(sessionId, list.slice(-5))
}

export function takePending(ids) {
  const now = Date.now()
  const out = []
  for (const id of ids) {
    const list = pending.get(id)
    if (list === undefined) continue
    pending.delete(id)
    for (const item of list) if (now - item.at < PENDING_TTL_MS) out.push(item.question)
  }
  return out
}

// ------------------------------------------------- companion feed (main composer)
//
// When the user turns on "同问" next to the composer's model selector, the
// browser keeps a long-poll open on /feed for that session. Every user prompt
// that then enters the session's inbox (i.e. what the user just sent to the
// main model) is copied into the feed, and the browser asks the extra models
// with it. Sessions nobody is listening to are never recorded.

const FEED_LISTEN_TTL_MS = 90 * 1000
const FEED_WAIT_MS = 25 * 1000
const feeds = new Map()

/** Canonical feed key: bare lowercase uuid when the id carries one. */
export function feedKey(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return ''
  const bare = sessionId.startsWith('session-') ? sessionId.slice(8) : sessionId
  return UUID.test(bare) ? bare.toLowerCase() : sessionId
}

function feedOf(key) {
  let feed = feeds.get(key)
  if (feed === undefined) { feed = { queue: [], waiters: new Set(), seen: 0 }; feeds.set(key, feed) }
  return feed
}

/** Text of a user prompt message ('' when it has none). */
export function promptText(message) {
  if (message?.role !== 'user' || message?.source?.kind !== 'user') return ''
  return blocksText(message.content).trim()
}

/**
 * Record a prompt for a listened-to session and wake its waiters.
 * @returns whether the prompt was recorded.
 */
export function feedPush(sessionId, text, now = Date.now()) {
  const key = feedKey(sessionId)
  const feed = feeds.get(key)
  if (!key || !text || feed === undefined || now - feed.seen > FEED_LISTEN_TTL_MS) return false
  feed.queue.push(text.slice(0, MAX_QUESTION_CHARS))
  feed.queue = feed.queue.slice(-5)
  const waiters = [...feed.waiters]
  feed.waiters.clear()
  for (const wake of waiters) wake()
  return true
}

/** Take queued prompts; marks the session as listened to. */
export function feedTake(sessionId, now = Date.now()) {
  const key = feedKey(sessionId)
  if (!key) return []
  const feed = feedOf(key)
  feed.seen = now
  const out = feed.queue
  feed.queue = []
  return out
}

// ------------------------------------------------------------------- http

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function rejectedBy(ctx, req, res) {
  let connection
  try { connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined } catch { connection = undefined }
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  const status = connection.requestRejection(req)
  if (status === undefined) return false
  res.statusCode = status
  res.end()
  return true
}

export function createHandlers(ctx, getConfig, logger) {
  const controller = () => {
    try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined }
  }

  async function resolveSession(sessionId) {
    const ids = idCandidates(sessionId)
    for (const id of ids) {
      const live = ctx.sessions.get(id)
      if (live !== undefined) return live
    }
    const facade = controller()
    if (facade === undefined || typeof facade.resolveAgent !== 'function') throw new Error('主对话尚未载入，请先打开它。')
    let lastError
    for (const id of ids) {
      try {
        const result = await facade.resolveAgent(id)
        if (result?.agent?.session !== undefined) return result.agent.session
        if (result && 'error' in result) lastError = result.error
      } catch (error) { lastError = error }
    }
    throw new Error('无法载入主对话：' + describeError(lastError))
  }

  /** Cached model list per provider, refreshed every minute. */
  const modelCache = new Map()
  async function modelsOf(provider) {
    const hit = modelCache.get(provider)
    if (hit && Date.now() - hit.at < 60000) return hit.models
    const models = await ctx.llm.listModels(provider)
    modelCache.set(provider, { at: Date.now(), models })
    return models
  }

  return {
    async ask(req, res) {
      if ((req.method ?? 'GET') !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      const question = typeof body.question === 'string' ? body.question.trim() : ''
      if (!question) return sendJson(res, 400, { error: '问题不能为空' })
      if (question.length > MAX_QUESTION_CHARS) return sendJson(res, 400, { error: '问题太长' })
      const provider = typeof body.provider === 'string' ? body.provider : ''
      const model = typeof body.model === 'string' ? body.model : ''
      if (!provider || !model) return sendJson(res, 400, { error: '缺少 provider / model' })
      let models
      try { models = await modelsOf(provider) } catch (error) { return sendJson(res, 400, { error: '模型提供方不可用：' + provider + '（' + describeError(error) + '）' }) }
      const info = models.find((m) => m.id === model)
      if (info === undefined) return sendJson(res, 400, { error: '模型不可用：' + provider + '/' + model })

      const config = getConfig()
      let transcript = ''
      if (body.withContext === true) {
        const session = await resolveSession(body.sessionId)
        transcript = renderTranscript(session.deriveMessages(), config.maxContextChars)
      }
      const route = { provider, model }
      const pairs = cleanHistory(body.history, config.maxTurns)
      const messages = buildMessages(pairs, question, transcript, route)

      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), Math.max(10, config.requestTimeoutSeconds || 600) * 1000)
      const onClose = () => { if (!res.writableEnded) abort.abort() }
      res.on('close', onClose)

      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      const emit = (value) => { if (!res.writableEnded) res.write(JSON.stringify(value) + '\n') }
      emit({ type: 'meta', provider, model, name: info.name ?? model, contextChars: transcript.length, turns: pairs.length })

      const started = Date.now()
      const assembler = new BlockAssembler()
      let firstTokenMs
      try {
        const options = {
          provider,
          model,
          ...(config.maxOutputTokens > 0 ? { maxTokens: config.maxOutputTokens } : {}),
          messages,
          signal: abort.signal,
        }
        for await (const chunk of ctx.llm.stream(options)) {
          assembler.push(chunk)
          if (chunk.type === 'text-delta' && chunk.text) {
            if (firstTokenMs === undefined) firstTokenMs = Date.now() - started
            emit({ type: 'text', text: chunk.text })
          } else if (chunk.type === 'reasoning-delta') emit({ type: 'thinking' })
        }
        const finish = assembler.finish
        if (finish?.kind === 'error' || finish?.kind === 'aborted') {
          const failure = finish.failure
          const message = failure ? [failure.code, failure.message].filter(Boolean).join(': ') : finish.kind
          emit({ type: 'error', message: abort.signal.aborted ? '已停止' : message })
        } else {
          const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
          emit({
            type: 'done',
            finish: finish?.kind ?? 'stop',
            usage: assembler.usage ?? null,
            ms: Date.now() - started,
            ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
            ...(text.trim() === '' ? { empty: true } : {}),
          })
        }
      } catch (error) {
        logger?.warn?.('%s/%s failed: %s', provider, model, describeError(error))
        emit({ type: 'error', message: abort.signal.aborted ? '已停止' : describeError(error) })
      } finally {
        clearTimeout(timeout)
        res.off?.('close', onClose)
        if (!res.writableEnded) res.end()
      }
    },

    async models(req, res) {
      if ((req.method ?? 'GET') !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const groups = []
      for (const provider of ctx.llm.listProviders()) {
        try {
          const models = await modelsOf(provider.id)
          if (models.length) groups.push({ id: provider.id, name: provider.name ?? provider.id, models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) })
        } catch { /* a broken provider must not hide the others */ }
      }
      sendJson(res, 200, { groups })
    },

    async pending(req, res) {
      if ((req.method ?? 'GET') !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      sendJson(res, 200, { questions: takePending(idCandidates(url.searchParams.get('sessionId') ?? '')) })
    },

    /** Long-poll: returns as soon as a main-composer prompt arrives, or empty after ~25s. */
    async feed(req, res) {
      if ((req.method ?? 'GET') !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const key = feedKey(sessionId)
      if (!key) return sendJson(res, 400, { error: '缺少 sessionId' })
      const now = feedTake(sessionId)
      if (now.length > 0) return sendJson(res, 200, { questions: now })
      const waitParam = url.searchParams.get('waitMs')
      const waitMs = waitParam === null || waitParam === '' ? NaN : Number(waitParam)
      const feed = feedOf(key)
      await new Promise((resolve) => {
        const timer = setTimeout(done, Number.isFinite(waitMs) && waitMs >= 0 ? Math.min(waitMs, FEED_WAIT_MS) : FEED_WAIT_MS)
        function done() { clearTimeout(timer); feed.waiters.delete(done); res.off?.('close', done); resolve() }
        feed.waiters.add(done)
        res.on?.('close', done)
      })
      if (res.writableEnded || res.destroyed) return
      sendJson(res, 200, { questions: feedTake(sessionId) })
    },
  }
}

// ---------------------------------------------------------------- command

export function commandDefinition() {
  return {
    name: 'multi',
    description: '多模型同问：把一个问题同时发给多个 AI，并排比较回答',
    input: { hint: '[问题] —— 不填则只打开多模型面板' },
    recordInput: false,
    handler({ agent, rawInput }) {
      const question = String(rawInput ?? '').trim()
      const sessionId = agent?.session?.id ?? agent?.id
      if (question && typeof sessionId === 'string') pushPending(sessionId, question.slice(0, MAX_QUESTION_CHARS))
      return { kind: 'success', text: question ? '↗ 已发到多模型面板（不会进入主对话）' : '↗ 已打开多模型面板' }
    },
  }
}

// ------------------------------------------------------------------ apply

export function apply(ctx, config = {}) {
  const logger = (() => { try { return ctx.logger?.(name) } catch { return undefined } })()
  const num = (v, d) => (Number.isSafeInteger(v) && v >= 0 ? v : d)
  const live = {
    maxTurns: num(config.maxTurns, 20),
    maxContextChars: num(config.maxContextChars, 60000),
    maxOutputTokens: num(config.maxOutputTokens, 0),
    requestTimeoutSeconds: num(config.requestTimeoutSeconds, 600),
  }
  const handlers = createHandlers(ctx, () => live, logger)
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + path,
    handler: async (req, res) => {
      if (rejectedBy(ctx, req, res)) return
      try {
        await handler(req, res)
      } catch (error) {
        logger?.warn?.('%s failed: %s', path, describeError(error))
        if (!res.headersSent) sendJson(res, 500, { error: describeError(error) })
        else if (!res.writableEnded) { res.write(JSON.stringify({ type: 'error', message: describeError(error) }) + '\n'); res.end() }
      }
    },
  }), name + ': ' + path)

  route('/ask', handlers.ask)
  route('/models', handlers.models)
  route('/pending', handlers.pending)
  route('/feed', handlers.feed)

  // Copy what the user sends to the main model into the companion feed.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('agent/inbox/inserted', (payload) => {
      try {
        const text = promptText(payload?.message)
        if (!text) return
        const agent = payload?.agent
        const sessionId = agent?.session?.id ?? agent?.sessionId ?? agent?.id
        feedPush(sessionId, text)
      } catch (error) { logger?.warn?.('feed failed: %s', describeError(error)) }
    }), name + ': companion feed')
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (inner) => {
        try { inner.commands.register(commandDefinition()) } catch (error) { logger?.warn?.('/multi not registered: %s', describeError(error)) }
      })
    } catch { logger?.warn?.('commands service unavailable; /multi not registered') }
  }
}
