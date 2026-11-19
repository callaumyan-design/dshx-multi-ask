import fs from 'node:fs'
import vm from 'node:vm'
const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let mod
const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }), useCallback: (f) => f, useMemo: (f) => f() }
const store = new Map()
const dispatched = []
const sandbox = {
  window: {
    __ModuleLoader__: { load: (d) => { mod = d.factory((n) => { if (n === 'react') return React; throw new Error('no ' + n) }) } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: (e) => dispatched.push(e),
  },
  document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
  navigator: {},
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  console, setTimeout: (f) => f(), CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail } },
}
vm.runInNewContext(src, sandbox)
const reg = { tabs: [], slots: [], shortcuts: [], on: [], menus: [] }
const services = {
  shortcuts: { register: (d) => { reg.shortcuts.push(d); return () => {} } },
  contextMenus: { register: (d) => { reg.menus.push(d); return () => {} } },
}
const ctx = {
  effect: (f) => f(),
  sidebarRightTabs: { register: (d) => { reg.tabs.push(d); return () => {} } },
  slots: { inject: (_n, f) => f(), register: (d, C) => { reg.slots.push([d, C]); return () => {} } },
  sidebarRight: { openTab: (k) => { reg.opened = k }, commandTarget: () => ({ paneId: 'p' }), openTabFromTarget: (k) => { reg.fromTarget = k } },
  on: (e, f) => { reg.on.push([e, f]); return () => {} },
  inject: (keys, f) => f({ get: (k) => services[k], effect: (g) => g() }),
}
mod.apply(ctx)
let n = 0
const assert = (c, m) => { if (!c) throw new Error(m); n++ }
const slot = (name) => reg.slots.find((s) => s[0].name === name)
assert(mod.name === 'dshx-multi-ask', 'name')
assert(reg.tabs[0].kind === 'dshx-multi-ask' && reg.tabs[0].guide[0].title() === '多模型同问', 'tab type')
assert(slot('sidebar.right.pane.tab')[0].key === reg.tabs[0].id && slot('sidebar.right.pane.tab.title')[0].key === reg.tabs[0].id, 'tab slots keyed by type id')
reg.on[0][1]('s1', 'multi', { kind: 'success' }); assert(reg.opened === 'dshx-multi-ask', '/multi opens tab')
assert(dispatched.some((e) => e.type === 'dshx-multi-ask:pending' && e.detail === 's1'), '/multi signals pending')
reg.opened = undefined; reg.on[0][1]('s1', 'btw', { kind: 'success' }); assert(reg.opened === undefined, 'other commands ignored')
const sc = reg.shortcuts[0]
assert(sc.defaults['desktop:windows'].code === 'KeyM' && sc.defaults['desktop:windows'].modifiers.join() === 'control,shift', 'ctrl+shift+m')
sc.resolve({ target: {} }).run(); assert(reg.fromTarget === 'dshx-multi-ask', 'shortcut opens')
const menu = reg.menus[0].resolve({ sessionId: 's7' })
reg.fromTarget = undefined; menu[0].run(); assert(menu[0].label === '多模型同问' && reg.fromTarget === 'dshx-multi-ask', 'session menu opens')

const Body = slot('sidebar.right.pane.tab')[1]
const tree = Body({ sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) })
assert(tree.p.className === 'dshx-ma', 'body renders')

// thread selection
const { threadFor, saveRounds, loadRounds } = mod.__test
const rounds = [
  { id: 'r1', question: 'Q1', order: ['a', 'b'], answers: { a: { status: 'done', answer: 'A1' }, b: { status: 'error', answer: '' } } },
  { id: 'r2', question: 'Q2', order: ['a', 'b'], answers: { a: { status: 'done', answer: 'A2' }, b: { status: 'done', answer: 'B2' } } },
]
assert(threadFor(rounds, 'a').length === 2 && threadFor(rounds, 'b').length === 1 && threadFor(rounds, 'b')[0].answer === 'B2', 'per-model thread')
saveRounds('s5', [{ id: 'r', question: 'Q', order: ['a'], answers: { a: { status: 'streaming', answer: 'half' } } }])
assert(loadRounds('s5')[0].answers.a.status === 'stopped', 'streaming restored as stopped')
saveRounds('s5', []); assert(!store.has('dshx-multi-ask.v1.rounds.s5'), 'empty clears store')
assert(threadFor([{ id: 'r0', question: 'M', fromMain: true, order: ['a'], answers: { a: { status: 'done', answer: 'x' } } }, ...rounds], 'a').length === 2, 'main-composer rounds excluded from private thread')

// --- composer companion button
const comp = reg.slots.find((s) => s[0].name === 'conversation.input.right')
assert(comp && comp[0].id === 'dshx-multi-ask.companion' && comp[0].inject('s1').sessionId === 's1', 'companion registered before model selector')
const Btn = comp[1]
const flat = (node, out = []) => { if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach((x) => flat(x, out)); return out } out.push(node); flat(node.c, out); return out }
let btnTree = Btn({ sessionId: 's1' })
let btn = flat(btnTree).find((x) => x.t === 'button')
assert(btn.c.includes('+ 同问'), 'off state label')
const { readSelection, companionOn, setCompanion, startCompanionFeed, companionQueue } = mod.__test
store.set('dshx-multi-ask.v1.selected', JSON.stringify([{ key: 'p\u0000m', provider: 'p', model: 'm', name: 'M' }, { key: 'q\u0000n', provider: 'q', model: 'n', name: 'N' }]))
setCompanion('s1', true)
assert(companionOn('s1') && !companionOn('s2') && readSelection().length === 2, 'per-session switch + shared selection')
btn = flat(Btn({ sessionId: 's1' })).find((x) => x.t === 'button')
assert(btn.c.includes('同问') && btn.p.title.includes('M、N'), 'on state label + title lists models')
assert(Btn({ sessionId: undefined }) === null, 'no session -> hidden')

// --- feed poller hands main prompts to the panel
const fetched = []
let resolveFeed
sandbox.fetch = (url, init) => { fetched.push(url); return new Promise((resolve, reject) => { resolveFeed = resolve; init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted'))) }) }
sandbox.AbortController = AbortController
const got = []
const stop = startCompanionFeed((sid, qs) => got.push([sid, qs]))
assert(fetched.length === 1 && fetched[0].startsWith('/dshx-multi-ask/feed?sessionId=s1'), 'polls only switched-on sessions')
resolveFeed({ ok: true, text: async () => JSON.stringify({ questions: ['同一个问题'] }) })
await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r))
assert(got[0][0] === 's1' && got[0][1][0] === '同一个问题', 'feed result delivered')
setCompanion('s1', false)
stop()
assert(typeof companionQueue.get === 'function', 'queue exported')
console.log('PASS', n)
