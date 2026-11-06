/**
 * Browser-half smoke test without a browser or a bundler.
 *
 * Loads the plain `client.js` script in a Node VM context where
 * `window.__ModuleLoader__.load` captures the module factory, then drives the
 * factory with fake React / snapshot-store / primitives modules and a fake
 * client Cordis context. It asserts the real registration contract
 * (`settings.topmostNotify`, `settings.general.item#topmost-notify`,
 * `shell.overlay#topmost-notify-toast`), renders both components, exercises the
 * write path (saved / failed / busy) and proves that broken services never
 * throw out of `apply()`.
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
    case 'react':
      return {
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        useRef: (value) => ({ current: value }),
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
/** One Host-owned `ConfigForm` with test levers. */
function makeForm({ enabled = true, mutedSessions = [], status = 'ready', writable = true } = {}) {
  const writes = []
  const mutations = []
  const snapshot = {
    status,
    value: { enabled, mutedSessions },
    base: {},
    user: {},
    revision: 7,
    writable,
  }
  return {
    writes,
    mutations,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push([field, value])
      snapshot.value = { ...snapshot.value, [field]: value }
      return true
    },
    mutate: async (ops) => {
      mutations.push(ops)
      for (const op of Array.isArray(ops) ? ops : []) {
        if (op?.op === 'set' && Array.isArray(op.path) && op.path.length === 1) {
          snapshot.value = { ...snapshot.value, [op.path[0]]: op.value }
        }
      }
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

function registration(record, slot, id) {
  const hit = record.register.find((row) => row.entry.name === slot && row.entry.id === id)
  assert.ok(hit !== undefined, `registers ${slot}#${id}`)
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  assert.deepEqual(main.record.inject, ['settings.general.item', 'shell.overlay', 'conversation.session.header.utilities'], 'injects the three slots')

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
  const [copy, control] = rowNode.props.children
  assert.equal(copy.props.children[0].props.children, 'T:title', 'row title is localized')
  assert.equal(copy.props.children[0].props.style.fontSize, 14, 'title size')
  assert.equal(copy.props.children[1].props.children, 'T:description', 'row description is localized')
  assert.equal(copy.props.children[1].props.style.color, 'var(--dsw-alias-label-secondary)', 'description color')
  assert.equal(control.type, Switch, 'row renders the primitives Switch')
  assert.equal(control.props.checked, true, 'checked follows form.value.enabled')
  assert.equal(control.props.label, 'T:title', 'switch accessible label')
  assert.equal(control.props.disabled, false, 'ready + writable row is enabled')

  control.props.onChange(false)
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
} finally {
  console.warn = originalWarn
}

console.log(`PASS client-smoke: ${scenarios} scenarios`)
console.log('  locale: settings.topmostNotify (en, ru, zh)')
console.log('  registrations: settings.general.item#topmost-notify(order 95), shell.overlay#topmost-notify-toast,')
console.log('                 conversation.session.header.utilities#topmost-notify-mute(order 50)')
console.log('  row: checked from form.value.enabled, disabled on busy/loading/unwritable')
console.log('  write: form.set("enabled", value) -> notice saved/failed, sequence++')
console.log('  toast: text+tone from the shared mutation store, dismiss clears it')
console.log('  bell: mute/unmute writes mutedSessions, ignores a second click while busy, survives refusal')
console.log(`  contained failures (console.warn calls): ${warnings.length}`)
