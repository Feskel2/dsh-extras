/**
 * Browser-half smoke test without a browser or a bundler.
 *
 * Loads the plain `client.js` script in a Node VM context where
 * `window.__ModuleLoader__.load` captures the module factory, then drives the
 * factory with fake React / snapshot-store / primitives modules and a fake
 * client Cordis context. It asserts the real registration contract
 * (`settings.topmostNotify`, `settings.general.item#topmost-notify`,
 * `shell.overlay#topmost-notify-toast`,
 * `conversation.session.header.utilities#topmost-notify-mute` and
 * `plugins.row.config` key `dsh-topmost-notify#topmost-notify`), renders the
 * rows, the bell, the toast and the v1.1 plugin settings page, exercises the
 * write path (saved / failed / busy), the sound upload and preview requests
 * (mocked `fetch`) and proves that broken services, a broken form or a broken
 * fetch never throw out of `apply()` or out of a component.
 *
 * Run: node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// --- capture the __ModuleLoader__ registration ------------------------------
let captured
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}
runInThisContext(readFileSync(join(ROOT, 'client.js'), 'utf8'), { filename: 'client.js' })

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
assert.ok(captured !== undefined, 'client.js calls window.__ModuleLoader__.load')
assert.equal(captured.id, manifest.name, 'module id equals the package name')
assert.equal(captured.id, 'dsh-topmost-notify', 'module id')
assert.equal(typeof captured.factory, 'function', 'loader entry has a factory')

// --- fake browser modules ---------------------------------------------------
/** Minimal replacement for `createSnapshotStore` (getSnapshot/update/subscribe). */
function createSnapshotStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    update(mutate) {
      const draft = { ...state }
      mutate(draft)
      state = draft
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (_ignored) {}
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// --- minimal React hooks harness (persistent per mounted component identity) --
// Slot components are functions; the harness gives them a stable cell store so
// `useState`/`useEffect`/`useRef` behave like React across manual re-renders.
const hookStores = new Map()
let activeHooks = null

function hooksOf(component) {
  let store = hookStores.get(component)
  if (store === undefined) {
    store = { cursor: 0, states: [], refs: [], effects: [], pending: [] }
    hookStores.set(component, store)
  }
  return store
}

function useRefHook(initial) {
  const store = activeHooks
  const index = store.cursor++
  if (store.refs[index] === undefined) store.refs[index] = { current: initial }
  return store.refs[index]
}

function useStateHook(initial) {
  const store = activeHooks
  const index = store.cursor++
  if (!(index in store.states)) store.states[index] = typeof initial === 'function' ? initial() : initial
  const setState = (next) => {
    store.states[index] = typeof next === 'function' ? next(store.states[index]) : next
  }
  return [store.states[index], setState]
}

function useEffectHook(fn, deps) {
  const store = activeHooks
  const index = store.cursor++
  const previous = store.effects[index]
  const changed =
    previous === undefined ||
    deps === undefined ||
    previous.deps === undefined ||
    deps.length !== previous.deps.length ||
    deps.some((value, position) => !Object.is(value, previous.deps[position]))
  if (!changed) return
  if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
  const record = { deps: deps === undefined ? undefined : Array.from(deps), cleanup: undefined }
  store.effects[index] = record
  store.pending.push({ record, fn })
}

const reactStub = {
  useState: useStateHook,
  useEffect: useEffectHook,
  useRef: useRefHook,
  useCallback: (fn) => fn,
  useMemo: (factory) => factory(),
}

/**
 * Render one component with the fake hooks and run the effects mounted or
 * changed by this render (the e2e renderer is not available here).
 * @param {Function} component - component function.
 * @param {object} props - composed props.
 * @returns {any} rendered element tree of plain descriptors.
 */
function renderHooks(component, props) {
  const store = hooksOf(component)
  activeHooks = store
  store.cursor = 0
  let element
  try {
    element = component(props)
  } finally {
    activeHooks = null
  }
  const pending = store.pending.splice(0)
  for (const { record, fn } of pending) record.cleanup = fn()
  return element
}

/**
 * A fresh mount identity per scenario: each returned renderer owns an isolated
 * hook store while rendering the same real slot component.
 * @param {Function} component - slot component.
 * @returns {(props: object) => any} renderer for that mount.
 */
function mount(component) {
  function Mounted(props) {
    return component(props)
  }
  return (props) => renderHooks(Mounted, props)
}

const Switch = function Switch() {
  return null
}
const Toast = function Toast() {
  return null
}

/** `require` table of the browser module loader, restricted to what the plugin requests. */
function fakeRequire(id) {
  switch (id) {
    case '@deepseek-ai/dsh-client-store':
      return { createSnapshotStore }
    case 'react':
      return reactStub
    case 'react/jsx-runtime':
      return {
        Fragment: Symbol('Fragment'),
        jsx(type, props, key) {
          return { type, props, key }
        },
        jsxs(type, props, key) {
          return { type, props, key }
        },
      }
    case '@deepseek-ai/dsh-client-ui-primitives':
      return { Switch, Toast }
    default:
      throw new Error(`unexpected client module request: ${id}`)
  }
}

const plugin = captured.factory(fakeRequire)
assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms'], 'inject lists the browser services')
assert.equal(typeof plugin.apply, 'function', 'apply export')

// --- fake Host config form --------------------------------------------------
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  durationMs: 1000,
  questionDurationMs: 1500,
  completedSoundEnabled: true,
  questionSoundEnabled: true,
  completedSoundFile: '',
  questionSoundFile: '',
  showSessionTitle: true,
  showAnswerExcerpt: true,
  notifyQuestions: true,
  mutedSessions: [],
})

/** One Host-owned `ConfigForm` with test levers. */
function makeForm(overrides = {}) {
  const writes = []
  const mutations = []
  const revisions = []
  const snapshot = {
    status: 'ready',
    value: { ...DEFAULT_CONFIG, ...overrides },
    base: {},
    user: {},
    revision: 7,
    writable: true,
  }
  return {
    writes,
    mutations,
    revisions,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push([field, value])
      snapshot.value = { ...snapshot.value, [field]: value }
      snapshot.revision += 1
      return true
    },
    mutate: async (ops, revision) => {
      mutations.push(ops)
      revisions.push(revision)
      for (const op of Array.isArray(ops) ? ops : []) {
        if (op?.op === 'set' && Array.isArray(op.path) && op.path.length === 1) {
          snapshot.value = { ...snapshot.value, [op.path[0]]: op.value }
        }
      }
      snapshot.revision += 1
      return true
    },
    unset: async () => true,
    // test-only levers
    setStatus(next) {
      snapshot.status = next
    },
    setWritable(next) {
      snapshot.writable = next
    },
  }
}

// --- fake client context ----------------------------------------------------
/** Record every service call the plugin makes. */
function createCtx({ form = makeForm() } = {}) {
  const record = {
    form,
    effects: 0,
    locale: [],
    configGet: [],
    whileServed: [],
    inject: [],
    register: [],
  }
  const ctx = {
    effect(fn) {
      record.effects++
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register(ns, dict) {
        record.locale.push({ ns, dict })
        return () => {}
      },
    },
    configForms: {
      get(ns) {
        record.configGet.push(ns)
        return record.form
      },
      whileServed(namespaces, register) {
        record.whileServed.push(namespaces)
        const off = register(new Set(namespaces))
        return () => {
          if (typeof off === 'function') off()
        }
      },
    },
    slots: {
      inject(name, register) {
        record.inject.push(name)
        const off = register()
        return () => {
          if (typeof off === 'function') off()
        }
      },
      register(entry, Component) {
        record.register.push({ entry, Component })
        return () => {}
      },
    },
    get() {
      return undefined
    },
  }
  return { ctx, record }
}

function registration(record, slot, idOrKey) {
  const hit = record.register.find(
    (row) => row.entry.name === slot && (row.entry.id === idOrKey || row.entry.key === idOrKey),
  )
  assert.ok(hit !== undefined, `registers ${slot}#${idOrKey}`)
  return hit
}

/** Render a slot component with the composed props shape the slot ledger supplies. */
function renderRow(record, component, { mutation, setEnabled } = {}) {
  const face = component.face
  return component({
    t: (key) => `T:${key}`,
    useForm: (selector) => selector(record.form.getSnapshot()),
    useMutation: (selector) => selector(mutation ?? face.hooks.mutation.getSnapshot()),
    setEnabled: setEnabled ?? face.setEnabled,
    dismiss: face.dismiss,
  })
}

function renderToast(component, state) {
  const face = component.face
  return component({
    t: (key) => `T:${key}`,
    useMutation: (selector) => selector(state),
    dismiss: face.dismiss,
  })
}

function renderSessionToggle(record, component, { sessionId = 'session-a', setMuted } = {}) {
  const face = component.face
  return component({
    t: (key) => `T:${key}`,
    sessionId,
    useForm: (selector) => selector(record.form.getSnapshot()),
    setMuted: setMuted ?? face.setMuted,
  })
}

// --- rendered-tree helpers --------------------------------------------------
/** Visit every element descriptor in a rendered tree. */
function walk(element, visit) {
  if (element === null || element === undefined || typeof element !== 'object') return
  visit(element)
  const children = element.props === undefined ? undefined : element.props.children
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visit)
  } else {
    walk(children, visit)
  }
}

/** Find the first element descriptor matching a predicate. */
function findElement(element, predicate) {
  let found = null
  walk(element, (candidate) => {
    if (found === null && predicate(candidate)) found = candidate
  })
  return found
}

/** Predicate: element carries a `data-*` test hook (its value may be `''`). */
function hasAttr(name) {
  return (element) => element.props !== undefined && Object.prototype.hasOwnProperty.call(element.props, name)
}

/** Find a control by its `data-*` test hook. */
function control(tree, name) {
  const hit = findElement(tree, hasAttr(name))
  assert.ok(hit !== undefined, `page renders [${name}]`)
  return hit
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Localized `t` backed by the real Russian dictionary (with `{name}` params). */
function makeT(dict, language) {
  return (key, params) => {
    const languageDict = dict[language] ?? {}
    const template =
      typeof languageDict[key] === 'string' ? languageDict[key] : typeof dict.en[key] === 'string' ? dict.en[key] : key
    if (params === undefined || params === null) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }
}

// --- fake `fetch` for the v1.1 host routes ----------------------------------
const fetchCalls = []
let fetchHandler = async () => {
  throw new Error('network is disabled in the smoke test')
}
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init })
  return fetchHandler(url, init)
}

/** Build a fetch-like JSON response. */
function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body }
}

const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args)
let scenarios = 0

try {
  // --- 1. registration contract --------------------------------------------
  const main = createCtx()
  plugin.apply(main.ctx)

  assert.equal(main.record.locale.length, 1, 'one locale dictionary')
  const dictionary = main.record.locale[0]
  assert.equal(dictionary.ns, 'settings.topmostNotify', 'locale namespace')
  for (const language of ['en', 'ru', 'zh']) {
    assert.ok(dictionary.dict[language] !== undefined, `dictionary has ${language}`)
    for (const key of ['title', 'description', 'saved', 'failed']) {
      assert.equal(typeof dictionary.dict[language][key], 'string', `${language}.${key} is text`)
    }
  }
  assert.equal(dictionary.dict.ru.title, 'Уведомление о завершении задачи', 'Russian row title')

  assert.deepEqual(main.record.configGet, ['topmost-notify'], 'reads the Host config form')
  assert.deepEqual(main.record.whileServed, [['topmost-notify'], ['topmost-notify']], 'row and bell live while the namespace is served')
  assert.deepEqual(
    main.record.inject,
    ['settings.general.item', 'shell.overlay', 'conversation.session.header.utilities', 'plugins.row.config'],
    'injects the four slots',
  )

  const row = registration(main.record, 'settings.general.item', 'topmost-notify')
  assert.equal(row.entry.id, 'topmost-notify', 'row id')
  assert.equal(row.entry.order, 95, 'row order')
  assert.equal(row.entry.locale, 'settings.topmostNotify', 'row locale')
  assert.equal(typeof row.entry.inject, 'function', 'row inject face factory')
  const rowFace = row.entry.inject()
  assert.equal(rowFace.hooks.form, main.record.form, 'form hook exposes the Host form')
  assert.equal(typeof rowFace.hooks.mutation.getSnapshot, 'function', 'mutation hook is a store')
  assert.equal(typeof rowFace.setEnabled, 'function', 'setEnabled verb')
  assert.equal(typeof rowFace.setMuted, 'function', 'setMuted verb')
  assert.equal(typeof rowFace.dismiss, 'function', 'dismiss verb')
  row.Component.face = rowFace
  scenarios++

  // --- 2. row render + saved write -----------------------------------------
  let rowNode = renderRow(main.record, row.Component)
  assert.ok(rowNode !== null, 'row renders a non-empty node')
  assert.equal(rowNode.type, 'div', 'row root is a div')
  assert.equal(rowNode.props.style.padding, '16px 0', 'row padding')
  assert.equal(rowNode.props.style.display, 'flex', 'row flex layout')
  assert.equal(rowNode.props.style.gap, 24, 'row gap')
  assert.equal(rowNode.props.style.borderBottom, '.5px solid var(--dsw-alias-border-l2)', 'row separator')
  const [copy, control0] = rowNode.props.children
  assert.equal(copy.props.children[0].props.children, 'T:title', 'row title is localized')
  assert.equal(copy.props.children[0].props.style.fontSize, 14, 'title size')
  assert.equal(copy.props.children[1].props.children, 'T:description', 'row description is localized')
  assert.equal(copy.props.children[1].props.style.color, 'var(--dsw-alias-label-secondary)', 'description color')
  assert.equal(control0.type, Switch, 'row renders the primitives Switch')
  assert.equal(control0.props.checked, true, 'checked follows form.value.enabled')
  assert.equal(control0.props.label, 'T:title', 'switch accessible label')
  assert.equal(control0.props.disabled, false, 'ready + writable row is enabled')

  control0.props.onChange(false)
  await tick()
  assert.deepEqual(main.record.form.writes, [['enabled', false]], 'toggle writes the enabled field')
  const saved = rowFace.hooks.mutation.getSnapshot()
  assert.equal(saved.busy, false, 'write settled')
  assert.equal(saved.notice, 'saved', 'accepted write shows the saved notice')
  assert.equal(saved.sequence, 1, 'notice sequence advanced')
  rowNode = renderRow(main.record, row.Component)
  assert.equal(rowNode.props.children[1].props.checked, false, 'checked follows the written value')
  scenarios++

  // --- 3. disabled states ---------------------------------------------------
  main.record.form.setStatus('loading')
  assert.equal(renderRow(main.record, row.Component).props.children[1].props.disabled, true, 'loading disables the switch')
  main.record.form.setStatus('ready')
  main.record.form.setWritable(false)
  assert.equal(renderRow(main.record, row.Component).props.children[1].props.disabled, true, 'read-only disables the switch')
  main.record.form.setWritable(true)
  assert.equal(renderRow(main.record, row.Component).props.children[1].props.disabled, false, 'writable restores the switch')
  scenarios++

  // --- 4. toast in shell.overlay -------------------------------------------
  const toast = registration(main.record, 'shell.overlay', 'topmost-notify-toast')
  assert.equal(toast.entry.locale, 'settings.topmostNotify', 'toast locale')
  assert.equal(typeof toast.entry.inject, 'function', 'toast inject face factory')
  const toastFace = toast.entry.inject()
  toast.Component.face = toastFace
  assert.equal(toastFace.hooks.mutation, rowFace.hooks.mutation, 'toast and row share one mutation store')
  assert.equal(renderToast(toast.Component, { busy: false, notice: null, sequence: 0 }), null, 'no notice renders nothing')
  const savedToast = renderToast(toast.Component, toastFace.hooks.mutation.getSnapshot())
  assert.equal(savedToast.type, Toast, 'saved notice renders the primitives Toast')
  assert.equal(savedToast.props.text, 'T:saved', 'toast text localized')
  assert.equal(savedToast.props.tone, 'success', 'saved toast is a success tone')
  assert.equal(savedToast.key, saved.sequence, 'toast keyed by sequence')
  toastFace.dismiss()
  assert.equal(toastFace.hooks.mutation.getSnapshot().notice, null, 'dismiss clears the notice')
  assert.equal(renderToast(toast.Component, toastFace.hooks.mutation.getSnapshot()), null, 'dismissed toast disappears')
  scenarios++

  // --- 4b. per-chat mute bell ----------------------------------------------
  const bell = registration(main.record, 'conversation.session.header.utilities', 'topmost-notify-mute')
  assert.equal(bell.entry.locale, 'settings.topmostNotify', 'bell locale')
  assert.equal(bell.entry.order, 50, 'bell order')
  assert.equal(typeof bell.entry.inject, 'function', 'bell inject face factory')
  const bellFace = bell.entry.inject()
  bell.Component.face = bellFace
  assert.equal(bellFace.hooks.form, main.record.form, 'bell reads the same Host form')
  assert.equal(typeof bellFace.setMuted, 'function', 'bell setMuted verb')

  let bellNode = renderSessionToggle(main.record, bell.Component)
  assert.ok(bellNode !== null, 'bell renders for a session')
  assert.equal(bellNode.type, 'button', 'bell root is a button')
  assert.equal(bellNode.props['aria-pressed'], 'false', 'not muted by default')
  assert.equal(bellNode.props.children, '🔔', 'bell shows the on icon')
  assert.equal(bellNode.props.title, 'T:muteOn', 'bell label prompts to mute')

  bellNode.props.onClick()
  await tick()
  assert.deepEqual(main.record.form.mutations, [[{
    op: 'set',
    path: ['mutedSessions'],
    value: ['session-a'],
  }]], 'clicking the bell adds the session to mutedSessions')
  const bellSaved = bellFace.hooks.mutation.getSnapshot()
  assert.equal(bellSaved.notice, 'saved', 'mute write shows saved')
  assert.equal(bellSaved.busy, false, 'mute write settled')

  bellNode = renderSessionToggle(main.record, bell.Component)
  assert.equal(bellNode.props['aria-pressed'], 'true', 'muted state is exposed')
  assert.equal(bellNode.props.children, '🔕', 'bell shows the muted icon')
  assert.equal(bellNode.props.title, 'T:muteOff', 'bell label prompts to turn on')

  bellNode.props.onClick()
  await tick()
  assert.deepEqual(main.record.form.getSnapshot().value.mutedSessions, [], 'clicking again unmutes')
  assert.deepEqual(main.record.form.mutations[1], [{
    op: 'set',
    path: ['mutedSessions'],
    value: [],
  }], 'unmute writes an empty list')

  // A second click while the write is pending is ignored.
  const pendingForm = makeForm({ mutedSessions: ['session-b'] })
  const pendingCtx = createCtx({ form: pendingForm })
  plugin.apply(pendingCtx.ctx)
  const pendingBell = registration(pendingCtx.record, 'conversation.session.header.utilities', 'topmost-notify-mute')
  const pendingFace = pendingBell.entry.inject()
  pendingBell.Component.face = pendingFace
  const pendingNode = renderSessionToggle(pendingCtx.record, pendingBell.Component, { sessionId: 'session-a' })
  pendingNode.props.onClick()
  pendingNode.props.onClick()
  await tick()
  assert.equal(pendingForm.mutations.length, 1, 'first click mutes, second is ignored while busy')
  assert.deepEqual(pendingForm.getSnapshot().value.mutedSessions.sort(), ['session-a', 'session-b'], 'other chats keep their mutes')

  // A refusing write leaves the state unmuted.
  const refusingMuteForm = makeForm()
  refusingMuteForm.mutate = async () => false
  const refusingMuteCtx = createCtx({ form: refusingMuteForm })
  plugin.apply(refusingMuteCtx.ctx)
  const refusingBell = registration(refusingMuteCtx.record, 'conversation.session.header.utilities', 'topmost-notify-mute')
  const refusingBellFace = refusingBell.entry.inject()
  refusingBell.Component.face = refusingBellFace
  const refusingMuteNode = renderSessionToggle(refusingMuteCtx.record, refusingBell.Component)
  refusingMuteNode.props.onClick()
  await tick()
  const refused = refusingBellFace.hooks.mutation.getSnapshot()
  assert.equal(refused.notice, 'failed', 'refused mute shows the failed notice')
  assert.deepEqual(refusingMuteForm.getSnapshot().value.mutedSessions, [], 'refused mute leaves the chat unmuted')
  scenarios++

  // --- 5. busy state and failed write --------------------------------------
  let release
  const slowForm = makeForm()
  slowForm.set = (field, value) => {
    slowForm.writes.push([field, value])
    return new Promise((resolve) => {
      release = () => resolve(true)
    })
  }
  const slow = createCtx({ form: slowForm })
  plugin.apply(slow.ctx)
  const slowRow = registration(slow.record, 'settings.general.item', 'topmost-notify')
  const slowFace = slowRow.entry.inject()
  slowRow.Component.face = slowFace
  let slowNode = renderRow(slow.record, slowRow.Component)
  slowNode.props.children[1].props.onChange(true)
  assert.equal(slowFace.hooks.mutation.getSnapshot().busy, true, 'pending write marks the store busy')
  assert.equal(slowForm.writes.length, 1, 'first write queued')
  slowNode.props.children[1].props.onChange(false)
  assert.equal(slowForm.writes.length, 1, 'a second click is ignored while busy')
  assert.equal(renderRow(slow.record, slowRow.Component).props.children[1].props.disabled, true, 'busy disables the switch')
  release()
  await tick()
  assert.equal(slowFace.hooks.mutation.getSnapshot().busy, false, 'settled write clears busy')
  assert.equal(slowFace.hooks.mutation.getSnapshot().notice, 'saved', 'settled write shows saved')

  const refusing = createCtx()
  refusing.record.form.set = async () => {
    throw new Error('host refused the write')
  }
  plugin.apply(refusing.ctx)
  const refusingRow = registration(refusing.record, 'settings.general.item', 'topmost-notify')
  const refusingFace = refusingRow.entry.inject()
  refusingRow.Component.face = refusingFace
  const refusingNode = renderRow(refusing.record, refusingRow.Component)
  refusingNode.props.children[1].props.onChange(true)
  await tick()
  const failed = refusingFace.hooks.mutation.getSnapshot()
  assert.equal(failed.busy, false, 'failed write clears busy')
  assert.equal(failed.notice, 'failed', 'refused write shows the failed notice')
  const failedToast = renderToast(toast.Component, failed)
  assert.equal(failedToast.props.text, 'T:failed', 'failed toast text')
  assert.equal(failedToast.props.tone, undefined, 'failed toast has no success tone')
  scenarios++

  // --- 6. resilience: broken services / components never throw --------------
  const noopEffect = (fn) => {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }
  const brokenContexts = [
    {},
    {
      effect: noopEffect,
      locale: {
        register() {
          throw new Error('duplicate locale namespace')
        },
      },
      configForms: {
        get() {
          return makeForm()
        },
        whileServed(namespaces, register) {
          return register(new Set(namespaces))
        },
      },
      slots: {
        inject(_name, register) {
          return register()
        },
        register() {
          return () => {}
        },
      },
    },
    {
      effect: noopEffect,
      locale: { register() { return () => {} } },
      configForms: {
        get() {
          throw new Error('settings service unavailable')
        },
        whileServed(namespaces, register) {
          return register(new Set(namespaces))
        },
      },
      slots: {
        inject() {
          throw new Error('slot service unavailable')
        },
        register() {
          return () => {}
        },
      },
    },
  ]
  for (const broken of brokenContexts) assert.doesNotThrow(() => plugin.apply(broken), 'apply never throws')

  assert.equal(row.Component({}), null, 'row renders nothing without hooks')
  assert.equal(row.Component({ t: () => 'title', useForm() { throw new Error('no form') }, useMutation() { throw new Error('no store') } }), null, 'row survives a throwing hook')
  assert.equal(bell.Component({}), null, 'bell renders nothing without hooks')
  assert.equal(bell.Component({ sessionId: 'session-a', useForm() { throw new Error('no form') }, t: (key) => key }), null, 'bell survives a throwing hook')
  assert.equal(toast.Component({}), null, 'toast renders nothing without hooks')
  assert.equal(toast.Component({ t: () => 'saved', useMutation() { throw new Error('no store') }, dismiss() {} }), null, 'toast survives a throwing hook')
  const throwingWriterNode = renderRow(main.record, row.Component, {
    setEnabled() {
      throw new Error('writer exploded')
    },
  })
  assert.doesNotThrow(() => throwingWriterNode.props.children[1].props.onChange(true), 'a throwing writer is contained')
  const throwingMuteNode = renderSessionToggle(main.record, bell.Component, {
    setMuted() {
      throw new Error('mute writer exploded')
    },
  })
  assert.doesNotThrow(() => throwingMuteNode.props.onClick(), 'a throwing mute writer is contained')
  const throwingDismiss = toast.Component({
    t: (key) => key,
    useMutation: (selector) => selector({ notice: 'saved', sequence: 1, busy: false }),
    dismiss() {
      throw new Error('dismiss exploded')
    },
  })
  assert.doesNotThrow(() => throwingDismiss.props.onDone(), 'a throwing dismiss is contained')
  scenarios++

  // --- 7. plugins.row.config registration ---------------------------------
  const pluginPage = registration(main.record, 'plugins.row.config', 'dsh-topmost-notify#topmost-notify')
  assert.equal(pluginPage.entry.name, 'plugins.row.config', 'row config slot name')
  assert.equal(pluginPage.entry.key, 'dsh-topmost-notify#topmost-notify', 'row config key is bundle#row')
  assert.equal(pluginPage.entry.locale, 'settings.topmostNotify', 'row config locale')
  assert.equal(typeof pluginPage.entry.inject, 'function', 'row config inject face factory')
  const pluginFace = pluginPage.entry.inject()
  assert.equal(typeof pluginFace.setEnabled, 'function', 'row config shares the plugin face')
  scenarios++

  const ruT = makeT(dictionary.dict, 'ru')
  const enT = makeT(dictionary.dict, 'en')
  const zhT = makeT(dictionary.dict, 'zh')

  /** Owner props of the `plugins.row.config` slot for one Host form. */
  function pluginPageProps(form, extra = {}) {
    const ownerForm =
      form === undefined
        ? undefined
        : {
            state: form.getSnapshot(),
            mutate: (ops, revision) => form.mutate(ops, revision),
          }
    return {
      view: 'page',
      form: ownerForm,
      t: ruT,
      ...pluginFace,
      ...extra,
    }
  }

  // --- 8. summary view ----------------------------------------------------
  assert.equal(
    pluginPage.Component({ view: 'summary', t: ruT }),
    dictionary.dict.ru['pluginSettings.summary'],
    'summary returns the localized one-line description',
  )
  assert.equal(pluginPage.Component({ view: 'summary', t: enT }), dictionary.dict.en['pluginSettings.summary'], 'summary is English when asked')
  assert.equal(pluginPage.Component({ view: 'summary', t: zhT }), dictionary.dict.zh['pluginSettings.summary'], 'summary is Chinese when asked')
  assert.equal(pluginPage.Component({ view: 'summary' }), 'pluginSettings.summary', 'summary without a translator degrades to the key')
  scenarios++

  // --- 9. page renders the defaults ---------------------------------------
  const renderPage = mount(pluginPage.Component)
  const defaultForm = makeForm()
  let tree = renderPage(pluginPageProps(defaultForm))
  assert.ok(tree !== null, 'page renders')
  assert.equal(tree.type, 'div', 'page root is a div')
  assert.equal(tree.props['data-topmost-notify-settings'], '', 'page root carries the settings hook')

  const enabledToggle = control(tree, 'data-tn-enabled')
  assert.equal(enabledToggle.type, 'button', 'enabled is a switch button')
  assert.equal(enabledToggle.props.role, 'switch', 'enabled is a role=switch')
  assert.equal(enabledToggle.props['aria-checked'], 'true', 'enabled defaults to true')
  assert.equal(enabledToggle.props.disabled, false, 'writable page enables the switch')

  const completedInput = control(tree, 'data-tn-duration-completed')
  assert.equal(completedInput.type, 'input', 'completed duration is an input')
  assert.equal(completedInput.props.type, 'number', 'completed duration is a number input')
  assert.equal(completedInput.props.value, '1', 'completed duration defaults to 1 s')
  assert.equal(completedInput.props.min, 0.3, 'duration min is 0.3 s')
  assert.equal(completedInput.props.max, 10, 'duration max is 10 s')
  assert.equal(completedInput.props.step, 0.1, 'duration step is 0.1 s')
  const completedRange = control(tree, 'data-tn-duration-completed-range')
  assert.equal(completedRange.props.type, 'range', 'completed duration has a slider')
  assert.equal(completedRange.props.value, 1, 'slider starts at the draft value')
  const questionInput = control(tree, 'data-tn-duration-question')
  assert.equal(questionInput.props.value, '1.5', 'question duration defaults to 1.5 s')
  const questionRange = control(tree, 'data-tn-duration-question-range')
  assert.equal(questionRange.props.value, 1.5, 'question slider starts at the draft value')

  for (const [kind, bundled] of [
    ['completed', 'chime.wav'],
    ['question', 'chime-question.wav'],
  ]) {
    const fileInput = control(tree, `data-tn-${kind}-file`)
    assert.equal(fileInput.type, 'input', `${kind} file control is an input`)
    assert.equal(fileInput.props.type, 'file', `${kind} file control is a file input`)
    assert.equal(fileInput.props.accept, '.mp3,.wav,audio/mpeg,audio/wav', `${kind} file accept filter`)
    assert.equal(fileInput.props.disabled, false, `${kind} file input is enabled`)
    const name = control(tree, `data-tn-${kind}-file-name`)
    assert.equal(name.props.children, ruT('pluginSettings.builtin'), `${kind} file name shows the bundled signal`)
    assert.equal(name.props.title, bundled, `${kind} file name exposes the bundled file`)
    const mode = control(tree, `data-tn-${kind}-file-mode`)
    assert.equal(mode.type, 'select', `${kind} source is a select`)
    assert.equal(mode.props.value, 'builtin', `${kind} source defaults to the bundled signal`)
    const toggle = control(tree, `data-tn-${kind}-sound-enabled`)
    assert.equal(toggle.props['aria-checked'], 'true', `${kind} sound defaults to on`)
    const preview = control(tree, `data-tn-${kind}-preview`)
    assert.equal(preview.props.disabled, false, `${kind} preview is enabled`)
    const resetSound = control(tree, `data-tn-${kind}-file-reset`)
    assert.equal(resetSound.type, 'button', `${kind} has a file reset button`)
    const windowButton = control(tree, `data-tn-${kind}-window`)
    assert.equal(windowButton.props.disabled, false, `${kind} window preview is enabled`)
  }
  assert.equal(control(tree, 'data-tn-notify-questions').props['aria-checked'], 'true', 'notifyQuestions defaults to true')
  assert.equal(control(tree, 'data-tn-show-session-title').props['aria-checked'], 'true', 'showSessionTitle defaults to true')
  assert.equal(control(tree, 'data-tn-show-answer-excerpt').props['aria-checked'], 'true', 'showAnswerExcerpt defaults to true')

  const saveButton = control(tree, 'data-tn-save')
  assert.equal(saveButton.type, 'button', 'save is a button')
  assert.equal(saveButton.props.disabled, true, 'save is disabled without changes')
  assert.equal(control(tree, 'data-tn-reset').props.disabled, false, 'reset is available on a ready page')
  assert.equal(findElement(tree, hasAttr('data-tn-notice')), null, 'no notice initially')
  assert.equal(findElement(tree, hasAttr('data-tn-unsaved')), null, 'no unsaved hint initially')
  scenarios++

  // --- 10. page edits and save: seconds -> milliseconds, changed fields only --
  fetchCalls.length = 0
  const editForm = makeForm()
  const renderEditPage = mount(pluginPage.Component)
  tree = renderEditPage(pluginPageProps(editForm))

  control(tree, 'data-tn-duration-completed').props.onChange({ target: { value: '2.5' } })
  tree = renderEditPage(pluginPageProps(editForm))
  assert.equal(control(tree, 'data-tn-duration-completed').props.value, '2.5', 'typed seconds stay in the draft')
  assert.equal(control(tree, 'data-tn-duration-completed-range').props.value, 2.5, 'slider follows the draft')

  control(tree, 'data-tn-duration-question-range').props.onChange({ target: { value: '3' } })
  tree = renderEditPage(pluginPageProps(editForm))
  assert.equal(control(tree, 'data-tn-duration-question').props.value, '3', 'question seconds follow the slider')

  control(tree, 'data-tn-notify-questions').props.onClick()
  tree = renderEditPage(pluginPageProps(editForm))
  assert.equal(control(tree, 'data-tn-notify-questions').props['aria-checked'], 'false', 'notifyQuestions toggles off')

  control(tree, 'data-tn-show-session-title').props.onClick()
  tree = renderEditPage(pluginPageProps(editForm))
  assert.equal(control(tree, 'data-tn-show-session-title').props['aria-checked'], 'false', 'showSessionTitle toggles off')

  control(tree, 'data-tn-save').props.onClick()
  await tick()
  assert.equal(editForm.mutations.length, 1, 'save sends one mutation batch')
  assert.deepEqual(editForm.mutations[0], [
    { op: 'set', path: ['durationMs'], value: 2500 },
    { op: 'set', path: ['questionDurationMs'], value: 3000 },
    { op: 'set', path: ['showSessionTitle'], value: false },
    { op: 'set', path: ['notifyQuestions'], value: false },
  ], 'save writes only the changed fields with milliseconds')
  assert.deepEqual(editForm.revisions, [7], 'save fences on the current revision')

  tree = renderEditPage(pluginPageProps(editForm))
  const savedNotice = control(tree, 'data-tn-notice')
  assert.equal(savedNotice.props['data-tn-notice'], 'saved', 'save shows the saved notice state')
  assert.equal(savedNotice.props.children, ruT('pluginSettings.notice.saved'), 'save notice is localized')
  assert.equal(control(tree, 'data-tn-save').props.disabled, true, 'save disables again after the accepted write')
  assert.equal(findElement(tree, hasAttr('data-tn-unsaved')), null, 'no unsaved hint after save')
  control(tree, 'data-tn-save').props.onClick()
  await tick()
  assert.equal(editForm.mutations.length, 1, 'a clean save does not write again')

  // A refusing Host write keeps the draft and shows the failure.
  const refuseForm = makeForm()
  refuseForm.mutate = async () => false
  const renderRefusePage = mount(pluginPage.Component)
  tree = renderRefusePage(pluginPageProps(refuseForm))
  control(tree, 'data-tn-enabled').props.onClick()
  tree = renderRefusePage(pluginPageProps(refuseForm))
  control(tree, 'data-tn-save').props.onClick()
  await tick()
  tree = renderRefusePage(pluginPageProps(refuseForm))
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'failed', 'refused write shows failed')
  assert.equal(control(tree, 'data-tn-save').props.disabled, false, 'refused write keeps the draft saveable')
  scenarios++

  // --- 11. footer reset drops the draft -----------------------------------
  const resetForm = makeForm()
  const renderResetPage = mount(pluginPage.Component)
  tree = renderResetPage(pluginPageProps(resetForm))
  control(tree, 'data-tn-enabled').props.onClick()
  tree = renderResetPage(pluginPageProps(resetForm))
  assert.equal(control(tree, 'data-tn-enabled').props['aria-checked'], 'false', 'draft change is visible')
  assert.ok(findElement(tree, hasAttr('data-tn-unsaved')) !== null, 'unsaved hint is shown')
  assert.equal(control(tree, 'data-tn-save').props.disabled, false, 'save is enabled by a change')
  control(tree, 'data-tn-reset').props.onClick()
  tree = renderResetPage(pluginPageProps(resetForm))
  assert.equal(control(tree, 'data-tn-enabled').props['aria-checked'], 'true', 'reset restores the accepted value')
  assert.equal(control(tree, 'data-tn-save').props.disabled, true, 'reset disables save again')
  assert.equal(resetForm.mutations.length, 0, 'reset never writes to the Host')
  assert.equal(findElement(tree, hasAttr('data-tn-notice')), null, 'reset clears the notice')
  scenarios++

  // --- 12. invalid duration keeps save disabled ---------------------------
  const invalidForm = makeForm()
  const renderInvalidPage = mount(pluginPage.Component)
  tree = renderInvalidPage(pluginPageProps(invalidForm))
  control(tree, 'data-tn-duration-completed').props.onChange({ target: { value: '42' } })
  tree = renderInvalidPage(pluginPageProps(invalidForm))
  assert.equal(control(tree, 'data-tn-save').props.disabled, true, 'out-of-range seconds disable save')
  assert.equal(
    findElement(tree, (element) => element.props !== undefined && element.props.role === 'status' && element.props.children === ruT('pluginSettings.range')) !== null,
    true,
    'out-of-range seconds show the bounds hint',
  )
  control(tree, 'data-tn-duration-completed').props.onChange({ target: { value: 'abc' } })
  tree = renderInvalidPage(pluginPageProps(invalidForm))
  assert.equal(control(tree, 'data-tn-save').props.disabled, true, 'non-numeric seconds disable save')
  scenarios++

  // --- 13. sound upload: validation, request shape, draft update -----------
  fetchCalls.length = 0
  const uploadForm = makeForm()
  const renderUploadPage = mount(pluginPage.Component)
  tree = renderUploadPage(pluginPageProps(uploadForm))
  control(tree, 'data-tn-completed-file').props.onChange({
    target: { files: [{ name: 'song.txt', size: 1024, type: 'text/plain' }] },
  })
  await tick()
  tree = renderUploadPage(pluginPageProps(uploadForm))
  assert.equal(fetchCalls.length, 0, 'a non-audio file is rejected before any request')
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'fileType', 'wrong extension notice')
  assert.equal(control(tree, 'data-tn-notice').props.children, ruT('pluginSettings.notice.fileType'), 'wrong extension notice is localized')

  control(tree, 'data-tn-completed-file').props.onChange({
    target: { files: [{ name: 'big.mp3', size: 12 * 1024 * 1024 + 1, type: 'audio/mpeg' }] },
  })
  await tick()
  tree = renderUploadPage(pluginPageProps(uploadForm))
  assert.equal(fetchCalls.length, 0, 'an oversized file is rejected before any request')
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'fileSize', 'oversized file notice')

  control(tree, 'data-tn-completed-file').props.onChange({
    target: { files: [{ name: 'empty.wav', size: 0, type: 'audio/wav' }] },
  })
  await tick()
  tree = renderUploadPage(pluginPageProps(uploadForm))
  assert.equal(fetchCalls.length, 0, 'an empty file is rejected before any request')
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'fileEmpty', 'empty file notice')

  const pickedFile = { name: 'my ring.wav', size: 2048, type: 'audio/wav' }
  fetchHandler = async () => jsonResponse({
    ok: true,
    kind: 'completed',
    path: 'C:\\plugins\\dsh-topmost-notify\\sounds\\completed-1.wav',
    name: 'completed-1.wav',
    bytes: 2048,
    format: 'wav',
  })
  control(tree, 'data-tn-completed-file').props.onChange({ target: { files: [pickedFile] } })
  await tick()
  assert.equal(fetchCalls.length, 1, 'a valid file is uploaded right away')
  const uploadCall = fetchCalls[0]
  assert.equal(uploadCall.url, '/dsh-topmost-notify/sounds?kind=completed', 'upload route carries the kind')
  assert.equal(uploadCall.init.method, 'POST', 'upload is a POST')
  assert.equal(uploadCall.init.body, pickedFile, 'upload body is the File itself')
  assert.equal(uploadCall.init.headers['content-type'], 'audio/wav', 'upload content-type follows the file')
  assert.equal(uploadCall.init.headers['x-file-name'], encodeURIComponent('my ring.wav'), 'upload name header is encodeURIComponent')
  tree = renderUploadPage(pluginPageProps(uploadForm))
  const uploadedName = control(tree, 'data-tn-completed-file-name')
  assert.equal(uploadedName.props.children, 'my ring.wav', 'the picked file name is shown right after the upload')
  assert.equal(uploadedName.props.title, 'C:\\plugins\\dsh-topmost-notify\\sounds\\completed-1.wav', 'the file hook keeps the stored path')
  assert.equal(control(tree, 'data-tn-completed-file-mode').props.value, 'custom', 'upload switches the source to the custom file')
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'uploaded', 'upload shows its own notice')
  assert.equal(control(tree, 'data-tn-save').props.disabled, false, 'upload leaves an unsaved draft change')

  control(tree, 'data-tn-save').props.onClick()
  await tick()
  assert.deepEqual(uploadForm.mutations[0], [{
    op: 'set',
    path: ['completedSoundFile'],
    value: 'C:\\plugins\\dsh-topmost-notify\\sounds\\completed-1.wav',
  }], 'save stores the uploaded path')

  // A failing transport keeps the draft untouched.
  fetchCalls.length = 0
  fetchHandler = async () => {
    throw new Error('network down')
  }
  const failingForm = makeForm()
  const renderFailingUpload = mount(pluginPage.Component)
  tree = renderFailingUpload(pluginPageProps(failingForm))
  control(tree, 'data-tn-completed-file').props.onChange({
    target: { files: [{ name: 'ring.wav', size: 2048, type: 'audio/wav' }] },
  })
  await tick()
  tree = renderFailingUpload(pluginPageProps(failingForm))
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'fileFailed', 'network failure notice')
  assert.equal(control(tree, 'data-tn-completed-file-mode').props.value, 'builtin', 'failed upload keeps the builtin source')
  assert.equal(control(tree, 'data-tn-save').props.disabled, true, 'failed upload leaves no draft change')

  // A Host format refusal (400) is reported as a format problem.
  fetchCalls.length = 0
  fetchHandler = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'bad-request' } }) })
  const refusedUploadForm = makeForm()
  const renderRefusedUpload = mount(pluginPage.Component)
  tree = renderRefusedUpload(pluginPageProps(refusedUploadForm))
  control(tree, 'data-tn-completed-file').props.onChange({
    target: { files: [{ name: 'fake.mp3', size: 2048, type: 'audio/mpeg' }] },
  })
  await tick()
  tree = renderRefusedUpload(pluginPageProps(refusedUploadForm))
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'fileType', 'a 400 upload refusal is a format notice')

  // The question kind uses its own route parameter.
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({
    ok: true,
    kind: 'question',
    path: 'C:\\plugins\\dsh-topmost-notify\\sounds\\question-2.mp3',
    name: 'question-2.mp3',
    bytes: 16,
    format: 'mp3',
  })
  const questionUploadForm = makeForm()
  const renderQuestionUpload = mount(pluginPage.Component)
  tree = renderQuestionUpload(pluginPageProps(questionUploadForm))
  control(tree, 'data-tn-question-file').props.onChange({
    target: { files: [{ name: 'ask.mp3', size: 16, type: 'audio/mpeg' }] },
  })
  await tick()
  assert.equal(fetchCalls[0].url, '/dsh-topmost-notify/sounds?kind=question', 'question upload route carries the kind')
  tree = renderQuestionUpload(pluginPageProps(questionUploadForm))
  assert.equal(control(tree, 'data-tn-question-file-name').props.children, 'ask.mp3', 'question picked name is shown right after the upload')
  scenarios++

  // --- 14. sound-source reset returns to the bundled signal ---------------
  const sourceForm = makeForm({ completedSoundFile: 'C:\\plugins\\sounds\\completed-1.wav' })
  const renderSourcePage = mount(pluginPage.Component)
  tree = renderSourcePage(pluginPageProps(sourceForm))
  assert.equal(control(tree, 'data-tn-completed-file-mode').props.value, 'custom', 'a configured file selects the custom source')
  assert.equal(control(tree, 'data-tn-completed-file-name').props.children, 'completed-1.wav', 'configured file name is shown')
  control(tree, 'data-tn-completed-file-mode').props.onChange({ target: { value: 'builtin' } })
  tree = renderSourcePage(pluginPageProps(sourceForm))
  assert.equal(control(tree, 'data-tn-completed-file-mode').props.value, 'builtin', 'source select switches to builtin')
  assert.equal(control(tree, 'data-tn-completed-file-name').props.children, ruT('pluginSettings.builtin'), 'builtin source name is shown')
  control(tree, 'data-tn-completed-file').props.onChange?.({})
  control(tree, 'data-tn-completed-file-reset').props.onClick()
  tree = renderSourcePage(pluginPageProps(sourceForm))
  assert.equal(control(tree, 'data-tn-completed-file-mode').props.value, 'builtin', 'file reset keeps the bundled source')
  control(tree, 'data-tn-save').props.onClick()
  await tick()
  assert.deepEqual(sourceForm.mutations[0], [{
    op: 'set',
    path: ['completedSoundFile'],
    value: '',
  }], 'clearing the custom file writes an empty path')
  scenarios++

  // --- 15. previews: request shapes and failures --------------------------
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true })
  const previewForm = makeForm()
  const renderPreviewPage = mount(pluginPage.Component)
  tree = renderPreviewPage(pluginPageProps(previewForm))
  control(tree, 'data-tn-completed-preview').props.onClick()
  await tick()
  assert.equal(fetchCalls.length, 1, 'preview-sound posts once')
  assert.equal(fetchCalls[0].url, '/dsh-topmost-notify/preview-sound', 'preview-sound route')
  assert.equal(fetchCalls[0].init.method, 'POST', 'preview-sound is a POST')
  assert.equal(fetchCalls[0].init.headers['content-type'], 'application/json', 'preview-sound sends JSON')
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { kind: 'completed', sound: true }, 'preview-sound body carries the draft sound')

  control(tree, 'data-tn-completed-window').props.onClick()
  await tick()
  assert.equal(fetchCalls[1].url, '/dsh-topmost-notify/preview', 'window preview route')
  assert.deepEqual(JSON.parse(fetchCalls[1].init.body), { kind: 'completed', durationMs: 1000, sound: true }, 'window preview body carries duration and sound')

  control(tree, 'data-tn-question-preview').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(fetchCalls[2].init.body), { kind: 'question', sound: true }, 'question preview-sound body')
  control(tree, 'data-tn-question-window').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(fetchCalls[3].init.body), { kind: 'question', durationMs: 1500, sound: true }, 'question window preview body')

  fetchCalls.length = 0
  const customPreviewForm = makeForm({
    completedSoundFile: 'C:\\plugins\\sounds\\completed-1.wav',
    durationMs: 2500,
  })
  const renderCustomPreviewPage = mount(pluginPage.Component)
  tree = renderCustomPreviewPage(pluginPageProps(customPreviewForm))
  control(tree, 'data-tn-completed-preview').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    kind: 'completed',
    sound: 'C:\\plugins\\sounds\\completed-1.wav',
  }, 'custom file is previewed by its path')
  fetchCalls.length = 0
  control(tree, 'data-tn-completed-window').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    kind: 'completed',
    durationMs: 2500,
    sound: 'C:\\plugins\\sounds\\completed-1.wav',
  }, 'window preview uses the configured duration')

  fetchCalls.length = 0
  const mutedSoundForm = makeForm({ completedSoundEnabled: false })
  const renderMutedSoundPage = mount(pluginPage.Component)
  tree = renderMutedSoundPage(pluginPageProps(mutedSoundForm))
  assert.equal(control(tree, 'data-tn-completed-preview').props.disabled, true, 'a disabled sound cannot be auditioned')
  control(tree, 'data-tn-completed-window').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    kind: 'completed',
    durationMs: 1000,
    sound: false,
  }, 'window preview is silent when the sound is off')

  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: false }, false)
  const previewFailForm = makeForm()
  const renderPreviewFailPage = mount(pluginPage.Component)
  tree = renderPreviewFailPage(pluginPageProps(previewFailForm))
  control(tree, 'data-tn-completed-preview').props.onClick()
  await tick()
  tree = renderPreviewFailPage(pluginPageProps(previewFailForm))
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'previewFailed', 'a refused preview shows the failure notice')
  scenarios++

  // --- 16. broken / missing form never throws -----------------------------
  const brokenPage = mount(pluginPage.Component)
  const throwingForm = {
    get state() {
      throw new Error('form exploded')
    },
  }
  tree = brokenPage({ view: 'page', form: throwingForm, t: ruT })
  assert.ok(tree !== null, 'a throwing form still renders the page shell')
  assert.equal(tree.props['data-topmost-notify-settings'], '', 'broken form keeps the root hook')
  assert.equal(control(tree, 'data-tn-enabled').props.disabled, true, 'broken form disables the controls')
  assert.equal(control(tree, 'data-tn-save').props.disabled, true, 'broken form disables save')

  const loadingPage = mount(pluginPage.Component)
  tree = loadingPage({ view: 'page', form: { state: { status: 'loading' } }, t: ruT })
  assert.ok(tree !== null, 'a loading form renders the page shell')
  assert.equal(control(tree, 'data-tn-enabled').props.disabled, true, 'loading form disables the controls')

  const noFormPage = mount(pluginPage.Component)
  tree = noFormPage({ view: 'page', t: ruT })
  assert.ok(tree !== null, 'a missing form renders the page shell')
  assert.equal(control(tree, 'data-tn-duration-completed').props.value, '1', 'missing form falls back to defaults')
  assert.equal(control(tree, 'data-tn-save').props.disabled, true, 'missing form disables save')

  const barePage = mount(pluginPage.Component)
  assert.ok(barePage({ view: 'page' }) !== null, 'page without props does not throw')
  assert.equal(pluginPage.Component({ view: 'summary', form: throwingForm }), 'pluginSettings.summary', 'summary survives a throwing form')

  // A throwing mutate is contained and reported through the notice.
  const throwMutateForm = makeForm()
  throwMutateForm.mutate = () => {
    throw new Error('mutate exploded')
  }
  const throwMutatePage = mount(pluginPage.Component)
  tree = throwMutatePage(pluginPageProps(throwMutateForm))
  control(tree, 'data-tn-enabled').props.onClick()
  tree = throwMutatePage(pluginPageProps(throwMutateForm))
  assert.doesNotThrow(() => control(tree, 'data-tn-save').props.onClick(), 'a throwing mutate is contained')
  await tick()
  tree = throwMutatePage(pluginPageProps(throwMutateForm))
  assert.equal(control(tree, 'data-tn-notice').props['data-tn-notice'], 'failed', 'a throwing mutate shows the failure notice')
  scenarios++

  // --- 17. locale completeness: page keys in en / ru / zh ----------------
  const languageDictionaries = ['en', 'ru', 'zh'].map((language) => dictionary.dict[language])
  const englishKeys = Object.keys(dictionary.dict.en).sort()
  for (const language of ['ru', 'zh']) {
    assert.deepEqual(Object.keys(dictionary.dict[language]).sort(), englishKeys, `${language} has the same key set as en`)
  }
  const pageKeys = englishKeys.filter((key) => key.startsWith('pluginSettings.'))
  assert.ok(pageKeys.length >= 40, 'the page contributes the full pluginSettings key set')
  for (const language of languageDictionaries) {
    for (const key of pageKeys) {
      assert.equal(typeof language[key], 'string', `${key} is text in every language`)
      assert.ok(language[key].trim() !== '', `${key} is not empty`)
    }
  }
  for (const required of [
    'pluginSettings.intro',
    'pluginSettings.enabled.title',
    'pluginSettings.durations.title',
    'pluginSettings.durationCompleted.title',
    'pluginSettings.durationQuestion.title',
    'pluginSettings.completedSound.title',
    'pluginSettings.questionSound.title',
    'pluginSettings.mode.builtin',
    'pluginSettings.mode.custom',
    'pluginSettings.preview',
    'pluginSettings.window',
    'pluginSettings.notifyQuestions.title',
    'pluginSettings.showSessionTitle.title',
    'pluginSettings.showAnswerExcerpt.title',
    'pluginSettings.save',
    'pluginSettings.reset',
    'pluginSettings.unsaved',
    'pluginSettings.notice.saved',
    'pluginSettings.notice.failed',
    'pluginSettings.notice.fileType',
    'pluginSettings.notice.fileSize',
    'pluginSettings.notice.fileFailed',
    'pluginSettings.summary',
  ]) {
    assert.equal(typeof dictionary.dict.ru[required], 'string', `ru.${required} exists`)
  }

  // --- 18. locale/*.json meta for the Plugins bundle card ----------------
  for (const language of ['en', 'ru', 'zh']) {
    const meta = JSON.parse(readFileSync(join(ROOT, 'locale', `${language}.json`), 'utf8'))
    assert.equal(typeof meta.meta?.title, 'string', `${language}.json meta.title is text`)
    assert.ok(meta.meta.title.trim() !== '', `${language}.json meta.title is not empty`)
    assert.equal(typeof meta.meta?.description, 'string', `${language}.json meta.description is text`)
    assert.ok(meta.meta.description.trim() !== '', `${language}.json meta.description is not empty`)
  }
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'locale', 'ru.json'), 'utf8')).meta.title, 'Уведомления о задачах', 'Russian bundle title')
  scenarios++
} finally {
  console.warn = originalWarn
  globalThis.fetch = undefined
}

console.log(`PASS client-smoke: ${scenarios} scenarios`)
console.log('  locale: settings.topmostNotify (en, ru, zh) + locale/*.json bundle meta')
console.log('  registrations: settings.general.item#topmost-notify(order 95), shell.overlay#topmost-notify-toast,')
console.log('                 conversation.session.header.utilities#topmost-notify-mute(order 50),')
console.log('                 plugins.row.config#dsh-topmost-notify#topmost-notify')
console.log('  row: checked from form.value.enabled, disabled on busy/loading/unwritable')
console.log('  write: form.set("enabled", value) -> notice saved/failed, sequence++')
console.log('  toast: text+tone from the shared mutation store, dismiss clears it')
console.log('  bell: mute/unmute writes mutedSessions, ignores a second click while busy, survives refusal')
console.log('  page: summary + defaults, seconds<->ms save of changed fields only, reset, upload validation, previews')
console.log(`  contained failures (console.warn calls): ${warnings.length}`)
if (process.env.DSH_TEST_DEBUG === '1') {
  for (const entry of warnings) console.log('  debug warn:', ...entry)
}
