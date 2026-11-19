import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs0 from 'node:fs'
fs0.mkdirSync(new URL('./plug/', import.meta.url), { recursive: true })
fs0.copyFileSync(new URL('../index.js', import.meta.url), new URL('./plug/index.js', import.meta.url))
const m = await import('./plug/index.js')
let pass = 0; const ok = (c, n) => { assert.ok(c, n); pass++ }

// history cleaning
const pairs = m.cleanHistory([{ question: 'q1', answer: 'a1' }, { question: 'bad' }, { question: 'q2', answer: 'a2' }], 1)
ok(pairs.length === 1 && pairs[0].question === 'q2', 'history capped + invalid dropped')
ok(m.cleanHistory('x', 5).length === 0, 'non-array history')

// transcript
const hist = [
  { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT SECRET' }] },
  { role: 'user', content: [{ type: 'text', text: '帮我看看 a.ts' }] },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: '好的' }, { type: 'tool-call', id: 'a', name: 'read', arguments: '{"path":"a.ts"}' }] },
  { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
  { role: 'assistant', content: [{ type: 'text', text: '文件里有个 bug' }] },
]
const t = m.renderTranscript(hist, 100000)
ok(!t.includes('SYSTEM PROMPT'), 'system prompt left out')
ok(!t.includes('hmm'), 'reasoning left out')
ok(t.includes('【用户】') && t.includes('[调用工具 read') && t.includes('截断'), 'transcript sections + tool clipped')
const tCap = m.renderTranscript(hist, 50)
ok(tCap.startsWith('…（更早') && tCap.endsWith('文件里有个 bug'), 'cap keeps newest')
ok(m.renderTranscript(hist, 0) === '', 'cap 0 = none')

// build
const route = { provider: 'p', model: 'm' }
const b1 = m.buildMessages([], 'why?', '', route)
ok(b1.length === 1 && b1[0].role === 'user' && b1[0].content[0].text === 'why?', 'plain single question')
const b2 = m.buildMessages([{ question: 'q1', answer: 'a1' }], 'q2', 'CTX', route)
ok(b2.length === 3 && b2[0].content[0].text.includes('<conversation>') && b2[0].content[0].text.includes('q1'), 'context on first question')
ok(b2[1].role === 'assistant' && b2[1].source.model === 'm' && b2[2].content[0].text === 'q2', 'thread then follow-up unframed')
ok(m.idCandidates('session-AAAAAAAA-1111-2222-3333-444444444444').includes('session-aaaaaaaa-1111-2222-3333-444444444444'), 'id normalize')

// pending /multi
m.pushPending('s1', 'hello'); ok(m.takePending(['s1'])[0] === 'hello', 'pending take'); ok(m.takePending(['s1']).length === 0, 'pending consumed')
const cmd = m.commandDefinition()
ok(cmd.name === 'multi' && cmd.recordInput === false, 'command def')
const r = cmd.handler({ agent: { session: { id: 's2' } }, rawInput: ' 哪个好 ' })
ok(r.kind === 'success' && m.takePending(['s2'])[0] === '哪个好', '/multi queues')

// ask handler: parallel calls to two models
const sent = []
const appended = []
const session = { id: 's3', deriveMessages: () => hist, append: (...a) => appended.push(a) }
const ctx = {
  sessions: { get: (id) => id === 's3' ? session : undefined },
  llm: {
    listProviders: () => [{ id: 'p', name: 'P' }, { id: 'q', name: 'Q' }, { id: 'broken' }],
    listModels: async (id) => { if (id === 'broken') throw new Error('down'); return id === 'p' ? [{ id: 'm', name: 'Model M' }] : [{ id: 'n' }] },
    async *stream(o) {
      sent.push(o)
      await new Promise((res) => setTimeout(res, 20))
      if (o.model === 'n') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'boom' } } }; return }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: o.model + '-Hel' }
      yield { type: 'text-delta', index: 0, text: 'lo' }
      yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 3, outputTokens: 2 } }
    },
  },
}
const h = m.createHandlers(ctx, () => ({ maxTurns: 20, maxContextChars: 60000, maxOutputTokens: 0, requestTimeoutSeconds: 60 }))
function fakeRes() { const e = new EventEmitter(); e.chunks = []; e.writableEnded = false; e.headersSent = false
  e.writeHead = (st) => { e.status = st; e.headersSent = true }; e.write = (c) => e.chunks.push(c); e.end = (c) => { if (c) e.chunks.push(c); e.writableEnded = true }; return e }
function fakeReq(body, method = 'POST') { const r = Readable.from([Buffer.from(JSON.stringify(body))]); r.method = method; return r }
const evs = (res) => res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l))

const resA = fakeRes(), resB = fakeRes()
const t0 = Date.now()
await Promise.all([
  h.ask(fakeReq({ provider: 'p', model: 'm', question: 'compare?', sessionId: 's3', withContext: true }), resA),
  h.ask(fakeReq({ provider: 'q', model: 'n', question: 'compare?' }), resB),
])
ok(Date.now() - t0 < 200, 'two models ran concurrently')
const ea = evs(resA)
ok(resA.status === 200 && ea[0].type === 'meta' && ea[0].name === 'Model M' && ea[0].contextChars > 0, 'meta with context')
ok(ea.filter((e) => e.type === 'text').map((e) => e.text).join('') === 'm-Hello', 'streamed text A')
ok(ea.at(-1).type === 'done' && typeof ea.at(-1).firstTokenMs === 'number', 'done A')
const eb = evs(resB)
ok(eb.at(-1).type === 'error' && eb.at(-1).message.includes('boom'), 'model B error isolated')
const sa = sent.find((o) => o.model === 'm')
ok(sa.sessionId === undefined && sa.tools === undefined, 'no sessionId, no tools')
ok(sa.messages.length === 1 && sa.messages[0].content[0].text.includes('文件里有个 bug'), 'context transcript included')
ok(sent.find((o) => o.model === 'n').messages[0].content[0].text === 'compare?', 'no context when not asked')
ok(appended.length === 0, 'main session never appended')

const resC = fakeRes()
await h.ask(fakeReq({ provider: 'p', model: 'nope', question: 'x' }), resC)
ok(resC.status === 400, 'unknown model rejected')
const resD = fakeRes()
await h.ask(fakeReq({ provider: 'p', model: 'm', question: '   ' }), resD)
ok(resD.status === 400, 'empty question')
const resE = fakeRes()
await h.ask(fakeReq({ question: 'x' }), resE)
ok(resE.status === 400, 'missing route')
const resF = fakeRes()
await h.ask(fakeReq({ provider: 'broken', model: 'z', question: 'x' }), resF)
ok(resF.status === 400, 'broken provider rejected')

const resM = fakeRes()
await h.models(fakeReq({}, 'GET'), resM)
const groups = JSON.parse(resM.chunks.join('')).groups
ok(groups.length === 2 && groups[0].models[0].name === 'Model M' && groups[1].models[0].name === 'n', 'models list skips broken provider')

// follow-up thread per model
sent.length = 0
await h.ask(fakeReq({ provider: 'p', model: 'm', question: 'and?', history: [{ question: 'compare?', answer: 'm-Hello' }] }), fakeRes())
ok(sent[0].messages.length === 3 && sent[0].messages[2].content[0].text === 'and?', 'follow-up carries own thread')

// companion feed
const SID = 'session-0b1c2d3e-1111-2222-3333-444444444444'
ok(m.feedPush(SID, 'nobody listening') === false, 'feed ignores sessions nobody listens to')
ok(m.feedTake(SID).length === 0, 'first take registers listener')
ok(m.promptText({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: ' hi ' }] }) === 'hi', 'user prompt text')
ok(m.promptText({ role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'x' }] }) === '', 'non-user sources ignored')
ok(m.feedPush('0B1C2D3E-1111-2222-3333-444444444444', 'q-a') === true, 'push via bare uuid id')
ok(m.feedTake(SID)[0] === 'q-a', 'take via prefixed id')
ok(m.feedPush(SID, 'stale', Date.now() + 10 * 60 * 1000) === false, 'listener expires')
m.feedTake(SID)
// long-poll wakes on push
const resFeed = fakeRes()
const pFeed = h.feed(Object.assign(Readable.from([]), { method: 'GET', url: '/dshx-multi-ask/feed?sessionId=' + SID }), resFeed)
await new Promise((r) => setTimeout(r, 20))
ok(!resFeed.writableEnded, 'long-poll waits')
m.feedPush(SID, '同一个问题')
await pFeed
ok(JSON.parse(resFeed.chunks.join('')).questions[0] === '同一个问题', 'long-poll woken by prompt')
const resFeed2 = fakeRes()
await h.feed(Object.assign(Readable.from([]), { method: 'GET', url: '/dshx-multi-ask/feed?sessionId=' + SID + '&waitMs=10' }), resFeed2)
ok(JSON.parse(resFeed2.chunks.join('')).questions.length === 0, 'long-poll times out empty')

// apply registers routes + command + inbox listener
const routes = []
const cmds = []
const listeners = {}
m.apply({
  ...ctx,
  effect: (f) => f(),
  on: (e, f) => { listeners[e] = f; return () => {} },
  webServer: { register: (r) => { routes.push(r.path); return () => {} } },
  inject: (_k, f) => f({ commands: { register: (c) => cmds.push(c.name) } }),
}, {})
ok(routes.join() === '/dshx-multi-ask/ask,/dshx-multi-ask/models,/dshx-multi-ask/pending,/dshx-multi-ask/feed' && cmds[0] === 'multi', 'apply wiring')
m.feedTake(SID)
listeners['agent/inbox/inserted']({ agent: { id: SID, session: { id: SID } }, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '主对话里发的' }] } })
listeners['agent/inbox/inserted']({ agent: { id: SID, session: { id: SID } }, message: { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: 'auto' }] } })
ok(m.feedTake(SID).join() === '主对话里发的', 'inbox listener copies only user prompts')
console.log('PASS', pass)
