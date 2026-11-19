// dshx-multi-ask — browser half.
//
// A "多模型同问" page type in the right sidebar (one per session). Pick several
// models, type one question, and every selected model answers at the same time
// in its own card. Each model keeps its own thread for follow-ups. Ways in:
//   * the sidebar's "+" guide card "多模型同问";
//   * Ctrl+Shift+M (⌘⇧M on mac);
//   * /multi [question] in the composer (host command; the question is asked
//     here, not in the main chat);
//   * right-click on the session title → 「多模型同问」.
// Rounds are kept per session in localStorage; the model selection is global.
window.__ModuleLoader__.load({
  id: 'dshx-multi-ask',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return {} } })()
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'dshx-multi-ask'
    const TYPE_ID = 'dshx-multi-ask/tab'
    const KIND = 'dshx-multi-ask'
    const BASE = '/dshx-multi-ask'
    const STORE_PREFIX = 'dshx-multi-ask.v1.'
    const SEL_KEY = STORE_PREFIX + 'selected'
    const CTX_KEY = STORE_PREFIX + 'withContext'
    const PENDING_EVENT = 'dshx-multi-ask:pending'
    const MAX_STORED_ROUNDS = 30
    const SEP = '\u0000'
    const COMP_KEY = STORE_PREFIX + 'companions'
    const COMPANION_EVENT = 'dshx-multi-ask:companion'
    const COMPANION_CHANGE = 'dshx-multi-ask:companions-changed'
    /** sessionId -> questions sent from the main composer, waiting for the panel. */
    const companionQueue = new Map()
    const reactDom = (() => { try { return require('react-dom') } catch { return null } })()

    // ------------------------------------------------------------- styles
    const CSS = `
.dshx-ma{display:flex;flex-direction:column;height:100%;min-height:0;font:var(--dsw-font-sm-14, 14px/1.55 system-ui);color:var(--dsw-alias-label-primary)}
.dshx-ma-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none}
.dshx-ma-bar .grow{flex:1}
.dshx-ma-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:var(--dsw-radius-sm, 6px);padding:3px 8px;cursor:pointer}
.dshx-ma-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshx-ma-btn:disabled{opacity:.45;cursor:default;background:transparent}
.dshx-ma-btn.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshx-ma-chip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;padding:1px 4px 1px 8px;color:var(--dsw-alias-label-secondary);max-width:180px}
.dshx-ma-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-ma-chip button{all:unset;cursor:pointer;padding:0 4px;opacity:.6}
.dshx-ma-chip button:hover{opacity:1}
.dshx-ma-picker{flex:none;max-height:45%;overflow:auto;border-bottom:.5px solid var(--dsw-alias-border-l3);padding:6px 12px 10px;font-size:12.5px}
.dshx-ma-picker input[type=search]{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm, 6px);padding:4px 8px;margin:4px 0 6px;outline:none}
.dshx-ma-group{margin:6px 0 2px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshx-ma-opt{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:6px;cursor:pointer}
.dshx-ma-opt:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshx-ma-list{flex:1;min-height:0;overflow:auto;padding:10px 12px 4px}
.dshx-ma-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.7;padding:20px 6px}
.dshx-ma-empty b{color:var(--dsw-alias-label-secondary);font-weight:600}
.dshx-ma-q{margin:12px 0 8px auto;max-width:92%;width:fit-content;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg, 12px);padding:7px 11px}
.dshx-ma-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;margin-bottom:16px}
.dshx-ma-card{min-width:0;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg, 12px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshx-ma-card-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshx-ma-card-head .name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-ma-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.dshx-ma-dot.streaming{background:#3b82f6;animation:dshxMaPulse 1.2s ease-in-out infinite}
.dshx-ma-dot.done{background:#22c55e}
.dshx-ma-dot.error{background:var(--dsw-alias-state-error-primary, #ef4444)}
.dshx-ma-card-body{padding:8px 11px;word-break:break-word;max-height:520px;overflow:auto}
.dshx-ma-card-body.full{max-height:none}
.dshx-ma-card-body pre.plain{white-space:pre-wrap;font:inherit;margin:0}
.dshx-ma-card-foot{display:flex;gap:8px;align-items:center;padding:2px 8px 4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshx-ma-card-foot .grow{flex:1}
.dshx-ma-err{color:var(--dsw-alias-state-error-primary);font-size:13px;white-space:pre-wrap}
.dshx-ma-thinking{color:var(--dsw-alias-label-tertiary);font-size:13px;animation:dshxMaPulse 1.4s ease-in-out infinite}
@keyframes dshxMaPulse{50%{opacity:.4}}
.dshx-ma-input{flex:none;margin:6px 10px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl, 16px);background:var(--dsw-alias-bg-layer-1);padding:8px 10px 6px}
.dshx-ma-input textarea{width:100%;box-sizing:border-box;resize:none;border:none;outline:none;background:transparent;color:inherit;font:inherit;min-height:22px;max-height:180px}
.dshx-ma-input .row{display:flex;align-items:center;gap:6px;margin-top:4px}
.dshx-ma-input .hint{flex:1;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshx-ma-input label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dshx-ma-send{font:inherit;font-size:12.5px;border:none;border-radius:999px;padding:4px 12px;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);white-space:nowrap}
.dshx-ma-send:disabled{opacity:.35;cursor:default}
.dshx-ma-title{display:inline-flex;align-items:center;gap:6px}
.dshx-ma-comp{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:999px;font:var(--dsw-font-xs-13, 13px/1.4 system-ui);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dshx-ma-comp:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshx-ma-comp.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshx-ma-comp .n{font-size:11px;min-width:16px;height:16px;line-height:16px;text-align:center;border-radius:8px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}
.dshx-ma-pop{position:fixed;z-index:2147483000;width:300px;max-height:min(460px,70vh);display:flex;flex-direction:column;background:var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel, 0 6px 24px rgba(0,0,0,.18));border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg, 12px);font:var(--dsw-font-xs-13, 13px/1.4 system-ui);color:var(--dsw-alias-label-primary)}
.dshx-ma-pop-head{padding:10px 12px 4px;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.dshx-ma-pop .dshx-ma-picker{border:none;max-height:none;flex:1;min-height:0}
.dshx-ma-pop-foot{display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dshx-ma-pop-foot .grow{flex:1}
.dshx-ma-pop-foot label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshx-ma-guide-icon{width:100%;height:100%;display:block}
`
    function ensureStyle() {
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="' + NS + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = NS
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------- icons
    const GLYPH = [
      'M3.5 5.5A2 2 0 0 1 5.5 3.5h5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H7.5l-2.5 2v-2a2 2 0 0 1-1.5-2z',
      'M14.5 8.5h4a2 2 0 0 1 2 2v3a2 2 0 0 1-1.5 2v2l-2.5-2h-2.5a2 2 0 0 1-2-2v-1',
      'M8 17.5h-.5a2 2 0 0 0-2 2v0',
    ]
    function Glyph(props) {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', width: 16, height: 16, 'aria-hidden': true, ...props },
        GLYPH.slice(0, 2).map((d, i) => h('path', { key: i, d })))
    }
    function GuideIcon() {
      return h('svg', { viewBox: '0 0 48 48', className: 'dshx-ma-guide-icon', 'aria-hidden': true },
        h('rect', { x: 4, y: 4, width: 40, height: 40, rx: 12, fill: 'var(--dsw-alias-bg-layer-1)', stroke: 'var(--dsw-alias-border-l3)' }),
        h('g', { transform: 'translate(12 12)', stroke: 'var(--dsw-alias-label-secondary)', fill: 'none', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          GLYPH.slice(0, 2).map((d, i) => h('path', { key: i, d }))))
    }

    // -------------------------------------------------------------- store
    const readJson = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback } catch { return fallback } }
    const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota */ } }

    /** Rounds: [{ id, question, answers: { [key]: { key, provider, model, name, answer, status, error?, ms?, usage? } } , order: [key] }] */
    const loadRounds = (sessionId) => {
      const parsed = readJson(STORE_PREFIX + 'rounds.' + sessionId, [])
      if (!Array.isArray(parsed)) return []
      return parsed.filter((r) => r && typeof r.question === 'string' && r.answers && Array.isArray(r.order)).map((r) => {
        const answers = {}
        for (const key of r.order) {
          const a = r.answers[key]
          if (a) answers[key] = a.status === 'streaming' ? { ...a, status: 'stopped' } : a
        }
        return { ...r, answers }
      })
    }
    const saveRounds = (sessionId, rounds) => {
      try {
        const kept = rounds.slice(-MAX_STORED_ROUNDS)
        if (kept.length === 0) localStorage.removeItem(STORE_PREFIX + 'rounds.' + sessionId)
        else localStorage.setItem(STORE_PREFIX + 'rounds.' + sessionId, JSON.stringify(kept))
      } catch { /* quota: keep in memory */ }
    }

    /** The globally selected extra models (shared by panel and composer button). */
    function readSelection() {
      const v = readJson(SEL_KEY, [])
      return Array.isArray(v) ? v.filter((s) => s && s.key && s.provider && s.model) : []
    }
    const sameSelection = (a, b) => a.length === b.length && a.every((s, i) => s.key === b[i].key)

    /** Per-session switch: does the main composer also send to the extra models? */
    function readCompanions() { const v = readJson(COMP_KEY, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
    function companionOn(sessionId) { return readCompanions()[sessionId] === true }
    function setCompanion(sessionId, on) {
      const all = readCompanions()
      if (on) all[sessionId] = true
      else delete all[sessionId]
      writeJson(COMP_KEY, all)
      window.dispatchEvent(new CustomEvent(COMPANION_CHANGE))
    }

    /** Thread for one model: earlier rounds where it answered successfully. */
    function threadFor(rounds, key) {
      const out = []
      for (const round of rounds) {
        if (round.fromMain) continue
        const a = round.answers[key]
        if (a && a.status === 'done' && a.answer) out.push({ question: round.question, answer: a.answer })
      }
      return out
    }

    async function fetchJson(path, init) {
      const response = await fetch(BASE + path, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let body = {}
      try { body = text ? JSON.parse(text) : {} } catch { body = { error: text.slice(0, 300) } }
      if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status)
      return body
    }

    let modelsPromise = null
    const loadModels = () => (modelsPromise ??= fetchJson('/models').then((b) => b.groups || []).catch((e) => { modelsPromise = null; throw e }))

    /**
     * Stream one model's answer. `onEvent` receives each NDJSON event.
     * @returns a promise that settles when the stream ends.
     */
    async function streamAsk(payload, signal, onEvent) {
      const response = await fetch(BASE + '/ask', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok || !response.body) {
        let message = 'HTTP ' + response.status
        try { message = (await response.json()).error || message } catch { /* keep */ }
        onEvent({ type: 'error', message })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let settled = false
      const handle = (line) => {
        if (!line.trim()) return
        let event
        try { event = JSON.parse(line) } catch { return }
        if (event.type === 'done' || event.type === 'error') settled = true
        onEvent(event)
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n')) !== -1) { handle(buffer.slice(0, index)); buffer = buffer.slice(index + 1) }
      }
      handle(buffer)
      if (!settled) onEvent({ type: 'error', message: '连接中断' })
    }

    const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '换行', unwrapLabel: '不换行' } }, footnotes: '脚注' }

    function AnswerCard({ answer, onRetry, onStop }) {
      const text = answer.answer || ''
      const [copied, setCopied] = useState(false)
      const [full, setFull] = useState(false)
      const streaming = answer.status === 'streaming'
      const body = text
        ? (typeof primitives.MarkdownText === 'function'
          ? h(primitives.MarkdownText, { text, streaming, labels: markdownLabels })
          : h('pre', { className: 'plain' }, text))
        : streaming ? h('div', { className: 'dshx-ma-thinking' }, answer.thinking ? '思考中…' : '等待回答…') : null
      const tokens = answer.usage && (answer.usage.outputTokens ?? answer.usage.output)
      return h('div', { className: 'dshx-ma-card', 'data-model': answer.key },
        h('div', { className: 'dshx-ma-card-head' },
          h('span', { className: 'dshx-ma-dot ' + (answer.status || '') }),
          h('span', { className: 'name', title: answer.provider + ' / ' + answer.model }, answer.name || answer.model),
          streaming
            ? h('button', { type: 'button', className: 'dshx-ma-btn', onClick: onStop, title: '停止这个模型' }, '停止')
            : h('button', { type: 'button', className: 'dshx-ma-btn', onClick: onRetry, title: '让这个模型重新回答' }, '重试')),
        h('div', { className: 'dshx-ma-card-body' + (full ? ' full' : '') },
          body,
          answer.error ? h('div', { className: 'dshx-ma-err' }, '⚠ ' + answer.error) : null),
        !streaming && (text || answer.ms) ? h('div', { className: 'dshx-ma-card-foot' },
          answer.ms ? h('span', null, (answer.ms / 1000).toFixed(1) + 's') : null,
          typeof tokens === 'number' ? h('span', null, tokens + ' tok') : null,
          answer.status === 'stopped' ? h('span', null, '已停止') : null,
          h('span', { className: 'grow' }),
          text ? h('button', { type: 'button', className: 'dshx-ma-btn', onClick: () => setFull((v) => !v) }, full ? '收起' : '展开') : null,
          text ? h('button', { type: 'button', className: 'dshx-ma-btn', onClick: () => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) } }, copied ? '已复制' : '复制') : null,
        ) : null)
    }

    function ModelPicker({ groups, selected, toggle, error }) {
      const [filter, setFilter] = useState('')
      const f = filter.trim().toLowerCase()
      return h('div', { className: 'dshx-ma-picker' },
        h('input', { type: 'search', placeholder: '搜索模型…', value: filter, onChange: (e) => setFilter(e.target.value) }),
        error ? h('div', { className: 'dshx-ma-err' }, '模型列表读取失败：' + error) : null,
        groups.length === 0 && !error ? h('div', { className: 'dshx-ma-thinking' }, '读取模型列表…') : null,
        groups.map((group) => {
          const models = group.models.filter((m) => !f || m.name.toLowerCase().includes(f) || m.id.toLowerCase().includes(f) || group.name.toLowerCase().includes(f))
          if (models.length === 0) return null
          return h(React.Fragment, { key: group.id },
            h('div', { className: 'dshx-ma-group' }, group.name),
            models.map((m) => {
              const key = group.id + SEP + m.id
              return h('label', { key, className: 'dshx-ma-opt' },
                h('input', { type: 'checkbox', checked: selected.some((s) => s.key === key), onChange: () => toggle({ key, provider: group.id, model: m.id, name: m.name }) }),
                h('span', null, m.name))
            }))
        }))
    }

    function MultiAskBody(props) {
      const { sessionId } = props
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const visible = info?.tab?.visible !== false
      const [rounds, setRounds] = useState(() => loadRounds(sessionId))
      const [draft, setDraft] = useState('')
      const [groups, setGroups] = useState([])
      const [groupsError, setGroupsError] = useState('')
      const [selected, setSelected] = useState(readSelection)
      const [withContext, setWithContext] = useState(() => readJson(CTX_KEY, false) === true)
      const [picking, setPicking] = useState(() => selected.length === 0)
      const controllers = useRef(new Map())
      const listRef = useRef(null)
      const inputRef = useRef(null)
      const roundsRef = useRef(rounds)
      roundsRef.current = rounds
      const busy = rounds.some((r) => Object.values(r.answers).some((a) => a.status === 'streaming'))

      useEffect(() => { ensureStyle() }, [])
      useEffect(() => { saveRounds(sessionId, rounds) }, [sessionId, rounds])
      useEffect(() => {
        if (sameSelection(readSelection(), selected)) return
        writeJson(SEL_KEY, selected)
        window.dispatchEvent(new CustomEvent(COMPANION_CHANGE))
      }, [selected])
      useEffect(() => {
        const onChange = () => setSelected((list) => { const next = readSelection(); return sameSelection(list, next) ? list : next })
        window.addEventListener(COMPANION_CHANGE, onChange)
        return () => window.removeEventListener(COMPANION_CHANGE, onChange)
      }, [])
      useEffect(() => { writeJson(CTX_KEY, withContext) }, [withContext])
      useEffect(() => { loadModels().then((g) => { setGroups(g); setGroupsError('') }, (e) => setGroupsError(e?.message || String(e))) }, [])
      useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight }, [rounds.length])
      useEffect(() => { if (visible) setTimeout(() => inputRef.current?.focus(), 30) }, [visible])
      useEffect(() => () => { for (const c of controllers.current.values()) c.abort() }, [])

      // Drop selections whose model disappeared once the list is known.
      useEffect(() => {
        if (groups.length === 0) return
        const known = new Set(groups.flatMap((g) => g.models.map((m) => g.id + SEP + m.id)))
        setSelected((list) => (list.every((s) => known.has(s.key)) ? list : list.filter((s) => known.has(s.key))))
      }, [groups])

      const patchAnswer = useCallback((roundId, key, patch) => {
        setRounds((list) => list.map((r) => {
          if (r.id !== roundId || !r.answers[key]) return r
          const prev = r.answers[key]
          return { ...r, answers: { ...r.answers, [key]: { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) } } }
        }))
      }, [])

      /** Run one model for one round (also used by retry). */
      const runOne = useCallback((roundId, target, question, history, context) => {
        const ckey = roundId + SEP + target.key
        controllers.current.get(ckey)?.abort()
        const controller = new AbortController()
        controllers.current.set(ckey, controller)
        const started = Date.now()
        const onEvent = (event) => {
          if (event.type === 'meta') { if (event.name) patchAnswer(roundId, target.key, { name: event.name }) }
          else if (event.type === 'thinking') patchAnswer(roundId, target.key, (a) => (a.thinking ? {} : { thinking: true }))
          else if (event.type === 'text') patchAnswer(roundId, target.key, (a) => ({ answer: (a.answer || '') + event.text }))
          else if (event.type === 'done') patchAnswer(roundId, target.key, (a) => ({ status: 'done', ms: event.ms || Date.now() - started, usage: event.usage || undefined, ...(event.empty && !a.answer ? { error: '模型没有给出文字回答' } : {}) }))
          else if (event.type === 'error') patchAnswer(roundId, target.key, { status: event.message === '已停止' ? 'stopped' : 'error', error: event.message === '已停止' ? undefined : event.message, ms: Date.now() - started })
        }
        streamAsk({ sessionId, provider: target.provider, model: target.model, question, history, withContext: context }, controller.signal, onEvent)
          .catch((error) => {
            if (controller.signal.aborted) patchAnswer(roundId, target.key, { status: 'stopped', ms: Date.now() - started })
            else patchAnswer(roundId, target.key, { status: 'error', error: error?.message || String(error) })
          })
          .finally(() => { if (controllers.current.get(ckey) === controller) controllers.current.delete(ckey) })
      }, [sessionId, patchAnswer])

      const ask = useCallback((raw, targetsOverride, fromMain) => {
        const question = String(raw || '').trim()
        const targets = targetsOverride || readSelection()
        if (!question) return
        if (targets.length === 0) { if (!fromMain) setPicking(true); return }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const prior = roundsRef.current
        const answers = {}
        for (const t of targets) answers[t.key] = { key: t.key, provider: t.provider, model: t.model, name: t.name, answer: '', status: 'streaming' }
        // From the main composer: the extra models see the same conversation as the main model.
        const context = fromMain ? true : withContext
        setRounds((list) => [...list, { id, question, withContext: context, ...(fromMain ? { fromMain: true } : {}), order: targets.map((t) => t.key), answers }])
        if (!fromMain) setDraft('')
        setPicking(false)
        // Main-composer rounds carry the main transcript instead of a private thread.
        for (const t of targets) runOne(id, t, question, fromMain ? [] : threadFor(prior, t.key), context)
      }, [withContext, runOne])

      const retry = useCallback((roundId, key) => {
        const index = roundsRef.current.findIndex((r) => r.id === roundId)
        if (index === -1) return
        const round = roundsRef.current[index]
        const a = round.answers[key]
        if (!a) return
        patchAnswer(roundId, key, { answer: '', status: 'streaming', error: undefined, ms: undefined, usage: undefined, thinking: false })
        runOne(roundId, a, round.question, round.fromMain ? [] : threadFor(roundsRef.current.slice(0, index), key), round.withContext === true)
      }, [runOne, patchAnswer])

      const stopOne = (roundId, key) => controllers.current.get(roundId + SEP + key)?.abort()
      const stopAll = () => { for (const c of controllers.current.values()) c.abort() }

      // /multi hand-off: fetch queued questions on mount and when signalled.
      const askRef = useRef(ask)
      askRef.current = ask
      useEffect(() => {
        let cancelled = false
        const pull = async () => {
          try {
            const { questions } = await fetchJson('/pending?sessionId=' + encodeURIComponent(sessionId))
            if (cancelled || !Array.isArray(questions) || questions.length === 0) return
            askRef.current(questions[questions.length - 1])
          } catch { /* host half missing: nothing queued */ }
        }
        const onSignal = (event) => { if (!event.detail || event.detail === sessionId) void pull() }
        void pull()
        window.addEventListener(PENDING_EVENT, onSignal)
        return () => { cancelled = true; window.removeEventListener(PENDING_EVENT, onSignal) }
      }, [sessionId])

      // Main-composer companion: questions the user sent to the main model.
      useEffect(() => {
        const take = () => {
          const list = companionQueue.get(sessionId)
          if (!list || list.length === 0) return
          companionQueue.delete(sessionId)
          for (const q of list) askRef.current(q, undefined, true)
        }
        const onSignal = (event) => { if (!event.detail || event.detail === sessionId) take() }
        take()
        window.addEventListener(COMPANION_EVENT, onSignal)
        return () => window.removeEventListener(COMPANION_EVENT, onSignal)
      }, [sessionId])

      const toggle = (target) => setSelected((list) => (list.some((s) => s.key === target.key) ? list.filter((s) => s.key !== target.key) : [...list, target]))

      const chips = useMemo(() => selected.map((s) => h('span', { key: s.key, className: 'dshx-ma-chip', title: s.provider + ' / ' + s.model },
        h('span', null, s.name || s.model),
        h('button', { type: 'button', onClick: () => toggle(s), 'aria-label': '移除' }, '×'))), [selected])

      return h('div', { className: 'dshx-ma', 'data-dshx-multi-ask': sessionId },
        h('div', { className: 'dshx-ma-bar' },
          h('button', { type: 'button', className: 'dshx-ma-btn' + (picking ? ' on' : ''), onClick: () => setPicking((v) => !v), title: '选择要同时提问的模型' }, '模型 (' + selected.length + ') ' + (picking ? '▴' : '▾')),
          chips,
          h('span', { className: 'grow' }),
          h('button', { type: 'button', className: 'dshx-ma-btn', disabled: busy || rounds.length === 0, onClick: () => setRounds([]), title: '清空这里的全部问答' }, '清空')),
        picking ? h(ModelPicker, { groups, selected, toggle, error: groupsError }) : null,
        h('div', { className: 'dshx-ma-list', ref: listRef },
          rounds.length === 0
            ? h('div', { className: 'dshx-ma-empty' },
              h('div', null, h('b', null, '多模型同问'), '：一个问题同时发给多个 AI，回答并排显示，方便对比参考。'),
              h('div', null, '① 点左上角「模型」勾选几个模型　② 输入问题发送　③ 每个模型各自独立回答；追问时每个模型接着自己的上下文。'),
              h('div', null, '勾选「带上主对话」会把当前对话的记录作为背景一起发过去。问答不会写入主对话。'),
              h('div', { style: { marginTop: 8 } }, '入口：', h('b', null, 'Ctrl+Shift+M'), ' · 输入框里 ', h('b', null, '/multi 问题'), ' · 右侧栏 + 号'),
              h('div', null, '提示：把右侧栏拖宽，回答会自动排成多列。'))
            : rounds.map((round) => h(React.Fragment, { key: round.id },
              h('div', { className: 'dshx-ma-q', title: round.withContext ? '已附带主对话' : undefined }, (round.fromMain ? '↗ 主对话 · ' : '') + (round.withContext ? '📎 ' : '') + round.question),
              h('div', { className: 'dshx-ma-grid' },
                round.order.filter((k) => round.answers[k]).map((k) => h(AnswerCard, {
                  key: k,
                  answer: round.answers[k],
                  onRetry: () => retry(round.id, k),
                  onStop: () => stopOne(round.id, k),
                })))))),
        h('div', { className: 'dshx-ma-input' },
          h('textarea', {
            ref: inputRef,
            rows: Math.min(8, Math.max(1, draft.split('\n').length)),
            value: draft,
            placeholder: selected.length ? '同时问 ' + selected.length + ' 个模型…' : '先在上方选择模型…',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) ask(draft) }
              else if (e.key === 'Escape' && busy) { e.preventDefault(); stopAll() }
            },
          }),
          h('div', { className: 'row' },
            h('label', { title: '把当前主对话的记录作为背景一起发给每个模型' },
              h('input', { type: 'checkbox', checked: withContext, onChange: (e) => setWithContext(e.target.checked) }), '带上主对话'),
            h('span', { className: 'hint' }, 'Enter 发送 · Shift+Enter 换行'),
            busy
              ? h('button', { type: 'button', className: 'dshx-ma-send', onClick: stopAll }, '全部停止')
              : h('button', { type: 'button', className: 'dshx-ma-send', disabled: !draft.trim() || selected.length === 0, onClick: () => ask(draft) }, '发送给 ' + selected.length + ' 个'))))
    }

    /** Subscribe to selection / switch changes made anywhere in this window. */
    function useCompanionState(sessionId) {
      const read = () => ({ on: companionOn(sessionId), selected: readSelection() })
      const [state, setState] = useState(read)
      useEffect(() => {
        const sync = () => setState((prev) => { const next = read(); return prev.on === next.on && sameSelection(prev.selected, next.selected) ? prev : next })
        sync()
        window.addEventListener(COMPANION_CHANGE, sync)
        window.addEventListener('storage', sync)
        return () => { window.removeEventListener(COMPANION_CHANGE, sync); window.removeEventListener('storage', sync) }
      }, [sessionId])
      return state
    }

    /**
     * Composer control next to the main model selector: tick extra models, and
     * every message sent to the main model is also asked to them; their answers
     * stream into the 多模型同问 sidebar panel.
     */
    function makeCompanionButton(openPanel) {
      return function CompanionButton(props) {
        const { sessionId } = props
        const { on, selected } = useCompanionState(sessionId)
        const [open, setOpen] = useState(false)
        const [groups, setGroups] = useState([])
        const [error, setError] = useState('')
        const [pos, setPos] = useState(null)
        const btnRef = useRef(null)
        const popRef = useRef(null)
        useEffect(() => { ensureStyle() }, [])
        useEffect(() => {
          if (!open) return
          loadModels().then((g) => { setGroups(g); setError('') }, (e) => setError(e?.message || String(e)))
          const rect = btnRef.current?.getBoundingClientRect?.()
          if (rect) setPos({ right: Math.max(12, window.innerWidth - rect.right), bottom: Math.max(12, window.innerHeight - rect.top + 8) })
          const onDown = (event) => {
            if (popRef.current?.contains(event.target) || btnRef.current?.contains(event.target)) return
            setOpen(false)
          }
          const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
          window.addEventListener('pointerdown', onDown, true)
          window.addEventListener('keydown', onKey, true)
          return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true) }
        }, [open])
        if (typeof sessionId !== 'string' || !sessionId) return null

        const toggle = (target) => {
          const list = readSelection()
          const next = list.some((s) => s.key === target.key) ? list.filter((s) => s.key !== target.key) : [...list, target]
          writeJson(SEL_KEY, next)
          if (next.length > 0 && !companionOn(sessionId)) setCompanion(sessionId, true)
          else if (next.length === 0) setCompanion(sessionId, false)
          else window.dispatchEvent(new CustomEvent(COMPANION_CHANGE))
        }
        const active = on && selected.length > 0
        const label = active ? '同问' : '+ 同问'
        const title = active
          ? '发送时也同时问：' + selected.map((s) => s.name || s.model).join('、') + '（回答在右侧「多模型同问」）'
          : '勾选更多模型，发给主模型的消息会同时发给它们'
        const pop = open ? h('div', {
          ref: popRef,
          className: 'dshx-ma-pop',
          role: 'dialog',
          'aria-label': '同时提问的模型',
          style: pos ? { right: pos.right + 'px', bottom: pos.bottom + 'px' } : { right: '24px', bottom: '120px' },
        },
          h('div', { className: 'dshx-ma-pop-head' }, '勾选的模型会和主模型一起收到你发的每条消息，回答并排显示在右侧「多模型同问」面板。'),
          h(ModelPicker, { groups, selected, toggle, error }),
          h('div', { className: 'dshx-ma-pop-foot' },
            h('label', null, h('input', { type: 'checkbox', checked: on, disabled: selected.length === 0, onChange: (e) => setCompanion(sessionId, e.target.checked) }), '发送时同问'),
            h('span', { className: 'grow' }),
            h('button', { type: 'button', className: 'dshx-ma-btn', onClick: () => { setOpen(false); openPanel(sessionId) } }, '打开面板'),
            h('button', { type: 'button', className: 'dshx-ma-btn', disabled: selected.length === 0, onClick: () => { writeJson(SEL_KEY, []); setCompanion(sessionId, false) } }, '清空'))) : null
        return h(React.Fragment, null,
          h('button', {
            ref: btnRef,
            type: 'button',
            className: 'dshx-ma-comp' + (active ? ' on' : ''),
            title,
            'aria-expanded': open,
            'data-dshx-multi-ask-companion': sessionId,
            onClick: () => setOpen((v) => !v),
          }, h(Glyph, { width: 14, height: 14 }), label, active ? h('span', { className: 'n' }, String(selected.length)) : null),
          pop && reactDom?.createPortal ? reactDom.createPortal(pop, document.body) : pop)
      }
    }

    /**
     * Background long-poll per session with the switch on: picks up prompts the
     * user sent to the main model and hands them to the panel.
     */
    function startCompanionFeed(onQuestions) {
      const loops = new Map()
      let stopped = false
      const run = (sessionId) => {
        const state = { abort: new AbortController() }
        loops.set(sessionId, state)
        ;(async () => {
          let backoff = 1000
          while (!stopped && loops.get(sessionId) === state) {
            try {
              const { questions } = await fetchJson('/feed?sessionId=' + encodeURIComponent(sessionId), { signal: state.abort.signal })
              backoff = 1000
              if (Array.isArray(questions) && questions.length > 0 && loops.get(sessionId) === state) onQuestions(sessionId, questions)
            } catch {
              if (state.abort.signal.aborted) return
              await new Promise((r) => setTimeout(r, backoff))
              backoff = Math.min(backoff * 2, 30000)
            }
          }
        })()
      }
      const sync = () => {
        if (stopped) return
        const selectedCount = readSelection().length
        // Each poll holds one HTTP connection: keep at most 3 (most recently switched on).
        const wanted = new Set(Object.keys(readCompanions()).filter((id) => selectedCount > 0 && companionOn(id)).slice(-3))
        for (const [id, state] of loops) if (!wanted.has(id)) { state.abort.abort(); loops.delete(id) }
        for (const id of wanted) if (!loops.has(id)) run(id)
      }
      sync()
      window.addEventListener(COMPANION_CHANGE, sync)
      window.addEventListener('storage', sync)
      return () => {
        stopped = true
        window.removeEventListener(COMPANION_CHANGE, sync)
        window.removeEventListener('storage', sync)
        for (const state of loops.values()) state.abort.abort()
        loops.clear()
      }
    }

    function MultiAskTitle() {
      return h('span', { className: 'dshx-ma-title' }, h(Glyph, null), '多模型同问')
    }

    // ---------------------------------------------------------------- apply
    exports.name = NS
    exports.inject = ['slots', 'sidebarRight', 'sidebarRightTabs']
    exports.__test = { threadFor, loadRounds, saveRounds, readSelection, companionOn, setCompanion, startCompanionFeed, makeCompanionButton, companionQueue }

    exports.apply = (ctx) => {
      ensureStyle()

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TYPE_ID,
        kind: KIND,
        priority: 'extension',
        keepMounted: true,
        title: () => '多模型同问',
        guide: [{
          id: 'open',
          order: 31,
          title: () => '多模型同问',
          description: () => '一个问题同时问多个 AI',
          icon: GuideIcon,
        }],
      }), NS + ': tab type')

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TYPE_ID,
        inject: (sessionId) => ({ sessionId }),
      }, MultiAskBody))

      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TYPE_ID,
      }, MultiAskTitle))

      const signal = (sessionId) => setTimeout(() => window.dispatchEvent(new CustomEvent(PENDING_EVENT, { detail: sessionId })), 60)
      const open = (sessionId, target) => {
        try {
          const t = target ?? ctx.sidebarRight.commandTarget?.()
          if (t !== undefined && typeof ctx.sidebarRight.openTabFromTarget === 'function') ctx.sidebarRight.openTabFromTarget(KIND, t)
          else ctx.sidebarRight.openTab(KIND)
        } catch (error) {
          try { ctx.sidebarRight.openTab(KIND) } catch { console.warn('[dshx-multi-ask] open failed', error) }
        }
        if (sessionId) signal(sessionId)
      }

      // Composer: "同问" button right before the main model selector.
      const openPanel = (sessionId) => open(sessionId)
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: NS + '.companion',
        order: 900,
        label: () => '同问',
        inject: (sessionId) => ({ sessionId }),
      }, makeCompanionButton(openPanel)))

      // Messages sent to the main model -> also to the selected models.
      ctx.effect(() => startCompanionFeed((sessionId, questions) => {
        const list = companionQueue.get(sessionId) ?? []
        companionQueue.set(sessionId, [...list, ...questions].slice(-5))
        try {
          const target = ctx.sidebarRight.commandTarget?.()
          if (target !== undefined && typeof ctx.sidebarRight.openTabFromTarget === 'function') ctx.sidebarRight.openTabFromTarget(KIND, target)
          else ctx.sidebarRight.openTab(KIND)
        } catch (error) { console.warn('[dshx-multi-ask] open failed', error) }
        setTimeout(() => window.dispatchEvent(new CustomEvent(COMPANION_EVENT, { detail: sessionId })), 60)
      }), NS + ': companion feed')

      // /multi (host command) -> open the panel in this window.
      ctx.effect(() => ctx.on('command/executed', (sessionId, commandName, result) => {
        if (commandName === 'multi' && result?.kind !== 'error') {
          try { ctx.sidebarRight.openTab(KIND) } catch (error) { console.warn('[dshx-multi-ask] open failed', error) }
          signal(sessionId)
        }
      }), NS + ': /multi')

      // Right-click on the session title / breadcrumb.
      ctx.inject(['contextMenus'], (scope) => {
        const menus = scope.get('contextMenus')
        scope.effect(() => menus.register({
          id: NS + '.session',
          target: 'session',
          order: 51,
          resolve: (value) => (typeof value?.sessionId === 'string' ? [{
            id: 'open-multi-ask',
            label: '多模型同问',
            commandId: 'dshx-multi-ask.open',
            run: () => open(value.sessionId),
          }] : []),
        }), NS + ': session menu')
      })

      // Ctrl+Shift+M
      ctx.inject(['shortcuts'], (scope) => {
        const shortcuts = scope.get('shortcuts')
        const chord = { code: 'KeyM', modifiers: ['control', 'shift'] }
        const mac = { code: 'KeyM', modifiers: ['meta', 'shift'] }
        scope.effect(() => shortcuts.register({
          id: 'dshx-multi-ask.open',
          label: () => '打开多模型同问',
          aliases: ['multi ask', 'compare models', '多模型', '多模型同问'],
          defaults: { 'desktop:macos': mac, 'desktop:windows': chord, 'desktop:linux': chord, 'web:macos': mac, 'web:windows': chord },
          regions: ['page', 'editable'],
          modals: [],
          resolve: ({ target: element }) => {
            const target = ctx.sidebarRight.commandTarget(element)
            if (target === undefined) return { status: 'blocked', reason: '先打开一个对话' }
            return {
              status: 'handled',
              run: () => {
                ctx.sidebarRight.openTabFromTarget(KIND, target)
                setTimeout(() => document.querySelector('.dshx-ma-input textarea')?.focus(), 80)
              },
            }
          },
        }), NS + ': shortcut')
      })
    }

    return exports
  },
})
