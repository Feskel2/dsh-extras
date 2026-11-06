/**
 * Static smoke test for the dsh-voice-reply browser half (REVISION 2).
 *
 * Runs `client.js` like the browser module loader does (a classic script that
 * calls `window.__ModuleLoader__.load`), materializes the factory with fake
 * `react` / `react/jsx-runtime`, calls `apply(fakeCtx)` and asserts:
 *   - the loader id and factory shape, `inject = ['slots','locale']`, and that
 *     `configForms` is gone entirely;
 *   - the four slot registrations (names, ids/keys, orders, locale, inject) and
 *     the `{ player, settings }` face they share;
 *   - the locale dictionaries and their required keys;
 *   - no fetch during `factory()`, one lazy GET `/status` prefetch from `apply`;
 *   - the settings store: refresh -> ready, POST /preferences -> state,
 *     retry-on-failure, status probed once, summary budget persistence;
 *   - the plugin's own settings page (`plugins.row.config`): draft, presets,
 *     validation, save/reset and the auto-speak switch;
 *   - the player store (statuses, error localization, chunk cache, chunk order);
 *   - the auto-speak driver gated by the settings store (history seeded
 *     silently, a new ended Turn speaks once, disabled preferences never speak);
 *   - each slot component never throws and renders its stable data attributes.
 *
 * Run with: node test/client-static.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, '..', 'client.js')
const source = readFileSync(CLIENT_PATH, 'utf8')
const DEBUG = process.env.DSH_TEST_DEBUG === '1'

const checks = []
function pass(name) {
  checks.push(name)
  console.log(`ok ${checks.length} - ${name}`)
}

/** Wait for real (main-context) time so async store work settles. */
function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* Minimal React hooks harness (persistent per component identity)     */
/* ------------------------------------------------------------------ */

const hookStores = new Map()
let activeStore = null

function storeFor(component) {
  let store = hookStores.get(component)
  if (store === undefined) {
    store = { cursor: 0, refs: [], states: [], effects: [], subscriptions: [], pending: [] }
    hookStores.set(component, store)
  }
  return store
}

function useRefStub(initial) {
  const store = activeStore
  const index = store.cursor++
  if (store.refs[index] === undefined) store.refs[index] = { current: initial }
  return store.refs[index]
}

function useStateStub(initial) {
  const store = activeStore
  const index = store.cursor++
  if (!(index in store.states)) store.states[index] = typeof initial === 'function' ? initial() : initial
  const setState = (next) => {
    store.states[index] = typeof next === 'function' ? next(store.states[index]) : next
  }
  return [store.states[index], setState]
}

function useEffectStub(fn, deps) {
  const store = activeStore
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

function useCallbackStub(fn) {
  return fn
}

function useMemoStub(factory) {
  return factory()
}

function useSyncExternalStoreStub(subscribe, getSnapshot) {
  const store = activeStore
  const index = store.cursor++
  if (store.subscriptions[index] === undefined) store.subscriptions[index] = subscribe(() => {}) || (() => {})
  return getSnapshot()
}

const reactStub = {
  useState: useStateStub,
  useEffect: useEffectStub,
  useCallback: useCallbackStub,
  useMemo: useMemoStub,
  useRef: useRefStub,
  useSyncExternalStore: useSyncExternalStoreStub,
}
const Fragment = Symbol('react.fragment')
const jsxStub = {
  Fragment,
  jsx: (type, props, key) => ({ type, props: props || {}, key: key === undefined ? null : key }),
  jsxs: (type, props, key) => ({ type, props: props || {}, key: key === undefined ? null : key }),
}

/**
 * Render one component function with the fake hooks, then run the effects that
 * mounted/changed in this render (the e2e renderer is not available here).
 * @param {Function} component - slot component.
 * @param {object} props - composed slot props.
 * @returns {any} rendered element tree of plain descriptors.
 */
function renderHooks(component, props) {
  const store = storeFor(component)
  activeStore = store
  store.cursor = 0
  let element
  try {
    element = component(props)
  } finally {
    activeStore = null
  }
  const pending = store.pending.splice(0)
  for (const { record, fn } of pending) record.cleanup = fn()
  return element
}

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

/* ------------------------------------------------------------------ */
/* Fake browser environment                                            */
/* ------------------------------------------------------------------ */

const loaderRegistrations = []
const warnings = []
const fetchCalls = []
const audioUrls = []
let fetchBehavior = async () => {
  throw new Error('network is disabled in the static test')
}
let audioAutoEnd = true
let audioBlockNext = false

class FakeAudio {
  constructor(url) {
    audioUrls.push(String(url))
    this.url = String(url)
    this.onended = null
    this.onerror = null
    this._src = ''
  }
  set src(value) {
    this._src = value
  }
  get src() {
    return this._src
  }
  play() {
    if (audioBlockNext) {
      audioBlockNext = false
      return Promise.reject({ name: 'NotAllowedError', message: 'play() failed because the user did not interact with the document first' })
    }
    if (audioAutoEnd) {
      const self = this
      setTimeout(() => {
        if (typeof self.onended === 'function') self.onended()
      }, 0)
    }
    return Promise.resolve()
  }
  pause() {}
}

class FakeAbortController {
  constructor() {
    this.signal = { aborted: false }
  }
  abort() {
    this.signal.aborted = true
  }
}

const sandbox = {
  console: {
    warn: (...args) => {
      warnings.push(args)
      if (DEBUG) console.log('DEBUG-WARN', args.map((value) => (value && value.stack ? value.stack : value)))
    },
    error: (...args) => warnings.push(args),
    log: () => {},
  },
  fetch: (url, init) => {
    fetchCalls.push(String(url))
    return Promise.resolve().then(() => fetchBehavior(String(url), init || null))
  },
  Audio: FakeAudio,
  AbortController: FakeAbortController,
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // Keep short waits alive (the fake audio ended event), but never hold the
    // process for the settings notice timer after the summary is printed.
    if (handle && typeof handle.unref === 'function' && typeof ms === 'number' && ms >= 100) handle.unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle),
  window: {
    __ModuleLoader__: {
      load(registration) {
        loaderRegistrations.push(registration)
      },
    },
  },
}
sandbox.globalThis = sandbox

const context = vm.createContext(sandbox)

/* ------------------------------------------------------------------ */
/* 1. Parse + load shape                                               */
/* ------------------------------------------------------------------ */

const script = new vm.Script(source, { filename: CLIENT_PATH })
pass('client.js parses as a classic browser script')

assert.ok(!/@deepseek-ai\/dsh-client-ui-primitives/.test(source), 'must not reference the primitives package')
assert.ok(!/^\s*import\s/m.test(source), 'must not use ESM import statements')
assert.ok(!/<[A-Za-z][^>]*>/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'must not contain JSX markup')
assert.ok(!/configForms/.test(source), 'REVISION 2: the configForms service must be gone')
assert.ok(!/whileServed/.test(source), 'REVISION 2: no whileServed guard is possible without configForms')
const requiredIds = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
assert.deepEqual([...new Set(requiredIds)].sort(), ['react', 'react/jsx-runtime'])
pass('only react + react/jsx-runtime are required, no JSX, no primitives, no configForms')

script.runInContext(context)
assert.equal(loaderRegistrations.length, 1, 'loader.load must run exactly once')
const registration = loaderRegistrations[0]
assert.equal(registration.id, 'dsh-voice-reply')
assert.equal(typeof registration.factory, 'function')
pass("loader registration is { id: 'dsh-voice-reply', factory(require) }")

const requireCalls = []
const exported = registration.factory((id) => {
  requireCalls.push(id)
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return jsxStub
  throw new Error(`unexpected require(${id})`)
})
assert.deepEqual([...new Set(requireCalls)].sort(), ['react', 'react/jsx-runtime'])
assert.equal(typeof exported, 'object')
assert.deepEqual(Array.from(exported.inject), ['slots', 'locale'])
assert.equal(typeof exported.apply, 'function')
assert.equal(fetchCalls.length, 0, 'factory() must not fetch')
assert.equal(audioUrls.length, 0, 'factory() must not create audio elements')
pass('factory returns { inject: [slots, locale], apply } and has no side effects')

/* ------------------------------------------------------------------ */
/* 2. apply(fakeCtx) + lazy settings prefetch                          */
/* ------------------------------------------------------------------ */

const effects = []
const registrations = []
const injections = []
const localeRegistrations = []
const localeBinds = []
const disposers = []

const fakeCtx = {
  effect(fn, label) {
    effects.push(label === undefined ? '<unlabeled>' : String(label))
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  slots: {
    inject(name, factoryFn) {
      injections.push(name)
      const dispose = factoryFn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
    bind(namespace) {
      localeBinds.push(namespace)
      return (key) => `«${key}»`
    },
  },
}

let applyResult
assert.doesNotThrow(() => {
  applyResult = exported.apply(fakeCtx)
})
assert.equal(applyResult, undefined, 'apply must be synchronous')
assert.equal(fetchCalls.length, 1, 'apply performs exactly one lazy status prefetch')
assert.ok(fetchCalls[0].endsWith('/dsh-voice-reply/status'), 'the prefetch is GET /status')
assert.equal(audioUrls.length, 0, 'apply must not create audio elements')
assert.equal(disposers.length, 2, 'dictionaries and the stores cleanup must be disposable')
pass('apply(fakeCtx) runs synchronously, prefetches /status once and creates no audio')

assert.equal(localeRegistrations.length, 1)
assert.equal(localeRegistrations[0].namespace, 'voiceReply')
assert.deepEqual(Object.keys(localeRegistrations[0].dictionaries).sort(), ['en', 'ru', 'zh'])
assert.deepEqual(localeBinds, ['voiceReply'])
pass('locale dictionary {en, ru, zh} registered for namespace "voiceReply" and bound')

const REQUIRED_KEYS = [
  'action.play',
  'action.stop',
  'action.loading',
  'autoSpeak.title',
  'autoSpeak.description',
  'status.playing',
  'status.error',
  'status.blocked',
  'settings.saved',
  'settings.failed',
  'error.notConfigured',
  'error.generic',
  'pluginSettings.title',
  'pluginSettings.description',
  'pluginSettings.summary',
  'pluginSettings.chars',
  'pluginSettings.maxChars.title',
  'pluginSettings.maxChars.description',
  'pluginSettings.estimatePrefix',
  'pluginSettings.estimateSuffix',
  'pluginSettings.presets',
  'pluginSettings.presetShort',
  'pluginSettings.presetDefault',
  'pluginSettings.presetDetailed',
  'pluginSettings.save',
  'pluginSettings.saved',
  'pluginSettings.reset',
  'pluginSettings.autoSpeak.title',
  'pluginSettings.autoSpeak.description',
  'pluginSettings.voice',
  'pluginSettings.voice.description',
  'pluginSettings.emotion',
  'pluginSettings.emotion.description',
  'pluginSettings.emotion.default',
  'pluginSettings.emotion.unsupported',
  'pluginSettings.emotionValue.neutral',
  'pluginSettings.emotionValue.good',
  'pluginSettings.emotionValue.evil',
  'pluginSettings.emotionValue.whisper',
  'pluginSettings.emotionValue.friendly',
  'pluginSettings.speed',
  'pluginSettings.speed.description',
  'pluginSettings.preview',
  'pluginSettings.previewStop',
  'pluginSettings.previewLoading',
  'pluginSettings.previewError',
  'pluginSettings.range',
  'pluginSettings.unsaved',
]
const dictionaries = localeRegistrations[0].dictionaries
const enKeys = Object.keys(dictionaries.en).sort()
assert.deepEqual(Object.keys(dictionaries.ru).sort(), enKeys, 'ru keys must match en')
assert.deepEqual(Object.keys(dictionaries.zh).sort(), enKeys, 'zh keys must match en')
for (const key of REQUIRED_KEYS) {
  for (const locale of ['en', 'ru', 'zh']) {
    const value = dictionaries[locale][key]
    assert.equal(typeof value, 'string', `${locale}.${key} must be a string`)
    assert.ok(value.trim() !== '', `${locale}.${key} must not be empty`)
  }
}
assert.ok(/[\u0400-\u04FF]/.test(dictionaries.ru['autoSpeak.title']), 'Russian copy must be Russian')
assert.ok(/[\u0400-\u04FF]/.test(dictionaries.ru['error.generic']), 'Russian error copy must be Russian')
pass('all required locale keys exist in en/ru/zh, Russian copy is Russian')

assert.deepEqual(injections, [
  'conversation.chat.assistant-actions',
  'conversation.composer.dock',
  'settings.general.item',
  'plugins.row.config',
])
assert.equal(registrations.length, 4)
const expectedSlots = [
  { name: 'conversation.chat.assistant-actions', id: 'voice-reply', order: 40 },
  { name: 'conversation.composer.dock', id: 'voice-reply-autospeak', order: 30 },
  { name: 'settings.general.item', id: 'voice-reply', order: 96 },
  { name: 'plugins.row.config', key: 'dsh-voice-reply#voice-reply' },
]
for (const expected of expectedSlots) {
  const found = registrations.find((entry) => entry.spec.name === expected.name)
  assert.ok(found !== undefined, `slot ${expected.name} must be registered`)
  if (expected.id !== undefined) assert.equal(found.spec.id, expected.id)
  if (expected.key !== undefined) assert.equal(found.spec.key, expected.key)
  if (expected.order !== undefined) assert.equal(found.spec.order, expected.order)
  assert.equal(found.spec.locale, 'voiceReply')
  assert.equal(typeof found.spec.inject, 'function')
  assert.equal(typeof found.component, 'function')
}
pass('four slot registrations have the contract ids/keys, orders and locale')

const actionRegistration = registrations.find((entry) => entry.spec.name === 'conversation.chat.assistant-actions')
const dockRegistration = registrations.find((entry) => entry.spec.name === 'conversation.composer.dock')
const settingsRegistration = registrations.find((entry) => entry.spec.name === 'settings.general.item')
const pluginSettingsRegistration = registrations.find((entry) => entry.spec.name === 'plugins.row.config')

const sessionFace = actionRegistration.spec.inject('session-1')
assert.ok(sessionFace && typeof sessionFace === 'object')
assert.deepEqual(Object.keys(sessionFace).sort(), ['player', 'settings'])
assert.equal(typeof sessionFace.player.subscribe, 'function')
assert.equal(typeof sessionFace.player.getState, 'function')
assert.equal(typeof sessionFace.player.speak, 'function')
assert.equal(typeof sessionFace.player.toggle, 'function')
assert.equal(typeof sessionFace.player.stop, 'function')
assert.equal(typeof sessionFace.settings.subscribe, 'function')
assert.equal(typeof sessionFace.settings.getState, 'function')
assert.equal(typeof sessionFace.settings.refresh, 'function')
assert.equal(typeof sessionFace.settings.setAutoSpeak, 'function')
assert.equal(typeof sessionFace.settings.setSummaryMaxChars, 'function')
assert.equal(typeof sessionFace.settings.savePreferences, 'function')
const settingsFace = settingsRegistration.spec.inject()
assert.equal(settingsFace.player, sessionFace.player, 'player must be a singleton')
assert.equal(settingsFace.settings, sessionFace.settings, 'settings must be a singleton')
const pluginSettingsFace = pluginSettingsRegistration.spec.inject()
assert.equal(pluginSettingsFace.player, sessionFace.player)
assert.equal(pluginSettingsFace.settings, sessionFace.settings)
const sessionFaceDock = dockRegistration.spec.inject('session-1')
assert.equal(sessionFaceDock.player, sessionFace.player)
assert.equal(sessionFaceDock.settings, sessionFace.settings)
pass('inject faces expose the shared { player, settings } singletons')

/* ------------------------------------------------------------------ */
/* 3. Settings store: failure, retry, ready, POST /preferences         */
/* ------------------------------------------------------------------ */

const settings = sessionFace.settings
assert.equal(settings.getState().status, 'idle')
await tick(5)
assert.equal(settings.getState().status, 'error', 'the prefetch failure leaves the store in error')
assert.equal(settings.getState().error, '«settings.failed»', 'settings errors are localized')
assert.equal(settings.getState().autoSpeak, true, 'defaults keep autoSpeak on until the Host answers')
assert.equal(settings.getState().summaryMaxChars, 500, 'defaults keep the 500-character budget until the Host answers')

// The row is usable but disabled while the preferences are not known.
const t = (key) => `t:${key}`
const disabledRow = renderHooks(settingsRegistration.component, Object.assign({}, sessionFace, { t }))
const disabledSwitch = findElement(
  disabledRow,
  (element) => element.type === 'button' && element.props.role === 'switch',
)
assert.ok(disabledSwitch !== null)
assert.equal(disabledSwitch.props.disabled, true, 'the switch is disabled while the store is not ready')
// Let the row's own mount refresh settle before the next phase swaps the Host
// behaviour (the fake fetch evaluates its behaviour in a later microtask).
await tick(5)
pass('settings prefetch failure surfaces as a localized error and disables the row')

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const healthyStatus = {
  ok: true,
  plugin: 'voice-reply',
  configured: true,
  autoSpeak: true,
  enabled: true,
  voice: 'alena',
  lang: 'ru-RU',
  emotion: '',
  speed: 1.32,
  format: 'mp3',
  mime: 'audio/mpeg',
  summaryMaxChars: 700,
  summaryLimits: { min: 100, max: 2000, step: 50 },
  voices: [
    { id: 'alena', label: 'Alena — женский, нейтральный', lang: 'ru-RU', gender: 'F', emotions: ['neutral', 'good'] },
    { id: 'marina', label: 'Marina — женский, нейтральный', lang: 'ru-RU', gender: 'F', emotions: ['neutral', 'whisper', 'friendly'] },
    { id: 'john', label: 'John — мужской, английский', lang: 'en-US', gender: 'M' },
  ],
  error: null,
}
const spokenChunks = [
  { index: 0, url: '/dsh-voice-reply/audio/aa-0.mp3', mime: 'audio/mpeg', bytes: 10 },
  { index: 1, url: '/dsh-voice-reply/audio/aa-1.mp3', mime: 'audio/mpeg', bytes: 10 },
]
const speakPayloads = []
const preferencePayloads = []
const previewPayloads = []

/**
 * Install one Host behaviour: healthy routes by default; `preferencesError`
 * refuses writes, `preferencesEnabled: false` answers with the master switch off.
 */
function installHost(options = {}) {
  fetchBehavior = async (url, init) => {
    if (url.endsWith('/status')) {
      if (options.statusError) return jsonResponse({ ok: false, error: { code: 'bad-request', message: 'unavailable' } }, 500)
      return jsonResponse(options.status ? Object.assign({}, healthyStatus, options.status) : healthyStatus)
    }
    if (url.endsWith('/speak')) {
      if (options.speakError) {
        return jsonResponse({ ok: false, error: { code: 'unauthorized', message: 'Ключ отклонён (401)', hint: 'Скоуп yc.ai.speechkitTts.execute' } }, 401)
      }
      speakPayloads.push(init && typeof init.body === 'string' ? JSON.parse(init.body) : null)
      return jsonResponse({ ok: true, key: 'k', cached: false, chunks: spokenChunks })
    }
    if (url.endsWith('/preview')) {
      if (options.previewError) {
        return jsonResponse({ ok: false, error: { code: 'upstream', message: 'Не удалось синтезировать пример' } }, 502)
      }
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {}
      previewPayloads.push(body)
      return jsonResponse({ ok: true, key: 'p', voice: body.voice, emotion: body.emotion ?? '', speed: body.speed, chunks: [spokenChunks[0]] })
    }
    if (url.endsWith('/preferences')) {
      if (options.preferencesError) {
        return jsonResponse({ ok: false, error: { code: 'bad-request', message: 'Не удалось сохранить настройку' } }, 400)
      }
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {}
      preferencePayloads.push(body)
      const autoSpeak = typeof body.autoSpeak === 'boolean' ? body.autoSpeak : true
      const enabled = options.preferencesEnabled === false ? false : true
      const summaryMaxChars =
        typeof body.summaryMaxChars === 'number' ? body.summaryMaxChars : options.status?.summaryMaxChars ?? 700
      const voice = typeof body.voice === 'string' ? body.voice : options.status?.voice ?? healthyStatus.voice
      const emotion = typeof body.emotion === 'string' ? body.emotion : options.status?.emotion ?? healthyStatus.emotion
      const speed = typeof body.speed === 'number' ? body.speed : options.status?.speed ?? healthyStatus.speed
      return jsonResponse({ ok: true, autoSpeak, enabled, summaryMaxChars, voice, lang: healthyStatus.lang, emotion, speed })
    }
    return jsonResponse({ ok: false, error: { code: 'bad-request', message: 'not found' } }, 404)
  }
}

installHost()
const statusCalls = () => fetchCalls.filter((url) => url.endsWith('/status')).length
const preferencesCalls = () => fetchCalls.filter((url) => url.endsWith('/preferences')).length
const speakPosts = () => fetchCalls.filter((url) => url.endsWith('/speak')).length

const settingsStatusBefore = statusCalls()
assert.equal(await settings.refresh(), true, 'refresh retries after the failed prefetch')
assert.equal(settings.getState().status, 'ready')
assert.equal(settings.getState().autoSpeak, true)
assert.equal(settings.getState().enabled, true)
assert.equal(settings.getState().summaryMaxChars, 700, 'the Host summary budget is mirrored')
assert.equal(settings.getState().summaryLimits.min, 100)
assert.equal(settings.getState().summaryLimits.max, 2000)
assert.equal(settings.getState().summaryLimits.step, 50)
assert.equal(settings.getState().voice, 'alena')
assert.equal(settings.getState().emotion, '', 'the accepted intonation starts empty (the voice default)')
assert.equal(settings.getState().speed, 1.32)
assert.equal(settings.getState().voices.length, 3)
assert.equal(settings.getState().voices.find((voice) => voice.id === 'john').lang, 'en-US')
assert.equal(JSON.stringify(settings.getState().voices.find((voice) => voice.id === 'alena').emotions), '["neutral","good"]')
assert.equal(settings.getState().voices.find((voice) => voice.id === 'john').emotions.length, 0, 'a voice without intonations keeps an empty list')
assert.equal(settings.getState().speed, 1.32)
assert.equal(statusCalls() - settingsStatusBefore, 1, 'refresh probed /status exactly once')
assert.equal(await settings.refresh(), true)
assert.equal(statusCalls() - settingsStatusBefore, 1, 'a known store refreshes without another request')
pass('settings.refresh() loads once, stays cached and exposes autoSpeak/enabled/summary limits')

assert.equal(await settings.setAutoSpeak(false), true)
assert.equal(settings.getState().autoSpeak, false, 'the POST answer updates the store')
assert.equal(settings.getState().enabled, true)
assert.equal(preferencesCalls(), 1)
assert.deepEqual(preferencePayloads.at(-1), { autoSpeak: false })
assert.equal(settings.getState().busy, false)
pass('settings.setAutoSpeak(false) persists through POST /preferences and mirrors the answer')

installHost({ preferencesError: true })
assert.equal(await settings.setAutoSpeak(true), false, 'a refused write reports failure')
assert.equal(settings.getState().autoSpeak, false, 'a refused write keeps the accepted value')
assert.equal(settings.getState().status, 'ready', 'a refused write does not poison the ready state')
assert.equal(settings.getState().busy, false)
assert.equal(settings.getState().error, '«settings.failed»')
installHost()
assert.equal(await settings.setAutoSpeak(true), true)
assert.equal(settings.getState().autoSpeak, true)
pass('settings.setAutoSpeak failure keeps the accepted value and reports failure')

const preferencesBeforeSummary = preferencesCalls()
assert.equal(await settings.setSummaryMaxChars(400), true)
assert.equal(settings.getState().summaryMaxChars, 400, 'the POST answer mirrors the accepted budget')
assert.equal(settings.getState().enabled, true)
assert.equal(preferencesCalls() - preferencesBeforeSummary, 1)
assert.deepEqual(preferencePayloads.at(-1), { summaryMaxChars: 400 })
assert.equal(settings.getState().busy, false)

installHost({ preferencesError: true })
assert.equal(await settings.setSummaryMaxChars(600), false, 'a refused budget write reports failure')
assert.equal(settings.getState().summaryMaxChars, 400, 'a refused budget write keeps the accepted value')
assert.equal(settings.getState().status, 'ready')
installHost()
assert.equal(await settings.setSummaryMaxChars(700), true)
assert.equal(settings.getState().summaryMaxChars, 700)
pass('settings.setSummaryMaxChars persists the budget via POST /preferences and mirrors the answer')

/* ------------------------------------------------------------------ */
/* 4. Chat snapshot fixture + action component                         */
/* ------------------------------------------------------------------ */

function makeSnapshot(lastTurn) {
  const turnEnds = new Map()
  const nodes = new Map()
  const order = []
  for (let turn = 0; turn <= lastTurn; turn += 1) {
    turnEnds.set(turn, 100 + turn)
    const messageId = `msg-turn-${turn}`
    const text = `Ответ ассистента ${turn}`
    const stepKey = `step:${turn}`
    nodes.set(stepKey, {
      kind: 'assistant-step',
      data: {
        status: 'settled',
        turn,
        step: 1,
        time: 0,
        blocks: [{ kind: 'text', text }],
        finalNode: { messageId, seq: 10 + turn, blocks: [{ kind: 'text', text }], kind: 'assistant' },
      },
    })
    order.push(stepKey)
    const tailKey = `tail:${turn}`
    nodes.set(tailKey, {
      kind: 'turn-tail',
      data: {
        turn,
        seq: 100 + turn,
        time: 0,
        closing: {
          status: 'settled',
          turn,
          step: 1,
          time: 0,
          blocks: [{ kind: 'text', text }],
          finalNode: { messageId, seq: 10 + turn, blocks: [{ kind: 'text', text }], kind: 'assistant' },
        },
      },
    })
    order.push(tailKey)
  }
  return {
    order,
    nodes: { get: (key) => nodes.get(key) },
    legacy: { turnEnds, nodes: [] },
  }
}

let activeSnapshot = makeSnapshot(1)
const useChatStub = (selector) => selector(activeSnapshot)

const actionProps = Object.assign({}, sessionFace, { messageId: 'msg-turn-1', useChat: useChatStub, t })
const fetchBaselineForRender = fetchCalls.length
const actionElement = renderHooks(actionRegistration.component, actionProps)
assert.ok(actionElement !== null, 'the action must render for a known finalized answer')
assert.equal(actionElement.type, 'button')
assert.equal(actionElement.props['data-voice-reply-action'], '')
assert.equal(actionElement.props['data-voice-reply-state'], 'idle')
assert.equal(actionElement.props['data-voice-reply-message-id'], 'msg-turn-1')
assert.equal(actionElement.props.title, 't:action.play')
assert.equal(actionElement.props['aria-label'], 't:action.play')
assert.equal(actionElement.props['aria-pressed'], 'false')
assert.equal(actionElement.props.disabled, false)
assert.equal(typeof actionElement.props.onClick, 'function')
const hiddenAction = renderHooks(actionRegistration.component, Object.assign({}, actionProps, { messageId: 'msg-absent' }))
assert.equal(hiddenAction, null, 'the action must hide when the answer text is missing')
assert.equal(fetchCalls.length, fetchBaselineForRender, 'action renders must not fetch')
pass('action renders a 28px button with data-voice-reply-action/state/message-id and hides without text')

/* ------------------------------------------------------------------ */
/* 5. Player: failing Host route -> localized error                    */
/* ------------------------------------------------------------------ */

const player = sessionFace.player
// The deliberately unreachable Host route is diagnosed on the console once;
// capture it so the global "no warnings" assertion still means something.
const expectedWarnings = []
const savedWarn = sandbox.console.warn
sandbox.console.warn = (...args) => expectedWarnings.push(args)
fetchBehavior = async () => {
  throw new Error('network is disabled in the static test')
}
await player.speak({ messageId: 'msg-turn-1', text: 'Ответ ассистента 1' })
sandbox.console.warn = savedWarn
assert.equal(player.getState().status, 'error')
assert.equal(player.getState().error, '«error.generic»', 'player errors must be localized')
assert.equal(expectedWarnings.length, 1, 'an unreachable Host route is diagnosed exactly once')
player.stop()
assert.equal(player.getState().status, 'idle')
pass('failing /status yields a friendly localized error state and stop() returns to idle')

/* ------------------------------------------------------------------ */
/* 6. Player: success path, sequential chunks, per-message cache       */
/* ------------------------------------------------------------------ */

installHost()
const playerStatusBefore = statusCalls()
const playerPostsBefore = speakPosts()
const audioBefore = audioUrls.length

const observedStatuses = []
const unsubscribe = player.subscribe(() => {
  observedStatuses.push(player.getState().status)
})
audioAutoEnd = true
await player.speak({ messageId: 'msg-a', text: 'Первый ответ' })
assert.equal(player.getState().status, 'idle', 'playback must return to idle after the last chunk')
assert.equal(speakPosts() - playerPostsBefore, 1, 'one /speak POST per new answer')
assert.equal(audioUrls.length - audioBefore, 2, 'both chunks must be played sequentially')
assert.deepEqual(audioUrls.slice(-2), ['/dsh-voice-reply/audio/aa-0.mp3', '/dsh-voice-reply/audio/aa-1.mp3'])
assert.equal(speakPayloads.length, 1)
assert.equal(speakPayloads[0].messageId, 'msg-a')
assert.equal(speakPayloads[0].text, 'Первый ответ')
assert.ok(observedStatuses.includes('loading'), 'loading must be published')
assert.ok(observedStatuses.includes('playing'), 'playing must be published')
unsubscribe()

const postsAfterFirst = speakPosts()
const audioAfterFirst = audioUrls.length
const statusAfterFirst = statusCalls()
await player.speak({ messageId: 'msg-a', text: 'Первый ответ' })
assert.equal(speakPosts() - postsAfterFirst, 0, 'replay of the same answer must not re-synthesize')
assert.equal(audioUrls.length - audioAfterFirst, 2, 'replay must play the cached chunks')
assert.equal(statusCalls() - statusAfterFirst, 0, 'GET /status stays cached for the player')
assert.equal(statusCalls() - playerStatusBefore, 1, 'the player probed /status once')
pass('player plays chunks sequentially, returns to idle, caches /status and per-message chunks')

/* ------------------------------------------------------------------ */
/* 7. Auto-speak through the settings gate                             */
/* ------------------------------------------------------------------ */

const dockProps = Object.assign({}, sessionFaceDock, {
  sessionId: 'session-1',
  useChat: useChatStub,
  t,
})
activeSnapshot = makeSnapshot(1)
assert.equal(renderHooks(dockRegistration.component, dockProps), null, 'idle chip must be hidden')
const postsAtMount = speakPosts()
await tick(5)
assert.equal(speakPosts(), postsAtMount, 'mounted history must never be spoken')

activeSnapshot = makeSnapshot(2)
renderHooks(dockRegistration.component, dockProps)
await tick(5)
assert.equal(speakPosts() - postsAtMount, 1, 'a newly ended Turn must be spoken once')
const postsAfterAutoSpeak = speakPosts()
renderHooks(dockRegistration.component, dockProps)
await tick(5)
assert.equal(speakPosts(), postsAfterAutoSpeak, 'the same ended Turn must never be spoken twice')
pass('auto-speak seeds history, speaks a new ended Turn once and never double-speaks')

assert.equal(await settings.setAutoSpeak(false), true)
activeSnapshot = makeSnapshot(3)
renderHooks(dockRegistration.component, dockProps)
await tick(5)
assert.equal(speakPosts(), postsAfterAutoSpeak, 'autoSpeak=false from the settings store must not speak')

installHost({ preferencesEnabled: false })
assert.equal(await settings.setAutoSpeak(true), true, 'the Host accepted the write')
assert.equal(settings.getState().enabled, false, 'the master switch is mirrored from the POST answer')
activeSnapshot = makeSnapshot(4)
renderHooks(dockRegistration.component, dockProps)
await tick(5)
assert.equal(speakPosts(), postsAfterAutoSpeak, 'enabled=false from the settings store must not speak')

installHost()
assert.equal(await settings.setAutoSpeak(true), true)
assert.equal(settings.getState().enabled, true)
pass('auto-speak is gated by autoSpeak and enabled from the settings store')

/* ------------------------------------------------------------------ */
/* 8. Ambient chip: hidden, playing and error states                   */
/* ------------------------------------------------------------------ */

audioAutoEnd = false
const playingPromise = player.speak({ messageId: 'msg-chip', text: 'Чип' })
for (let attempt = 0; attempt < 100 && player.getState().status !== 'playing'; attempt += 1) {
  await tick(1)
}
assert.equal(player.getState().status, 'playing')
const playingChip = renderHooks(dockRegistration.component, dockProps)
assert.ok(playingChip !== null, 'the chip must be visible while playing')
assert.equal(playingChip.type, 'div')
assert.ok('data-voice-reply-chip' in playingChip.props)
assert.equal(playingChip.props['data-voice-reply-state'], 'playing')
const playingStop = findElement(
  playingChip,
  (element) => element.type === 'button' && element.props.title === 't:action.stop',
)
assert.ok(playingStop !== null, 'the playing chip must offer a stop button')
player.stop()
await playingPromise
audioAutoEnd = true
pass('ambient chip appears while playing with a stop button and hides again on stop')

installHost({ speakError: true })
await player.speak({ messageId: 'msg-chip-2', text: 'Ошибка' })
assert.equal(player.getState().status, 'error')
assert.equal(player.getState().error, 'Ключ отклонён (401)', 'Host error message is shown as-is')
const errorChip = renderHooks(dockRegistration.component, dockProps)
assert.ok(errorChip !== null)
assert.equal(errorChip.props['data-voice-reply-state'], 'error')
const dismissButton = findElement(
  errorChip,
  (element) => element.type === 'button' && element.props.title === 't:status.dismiss',
)
assert.ok(dismissButton !== null, 'the error chip must offer a dismiss button')
dismissButton.props.onClick()
assert.equal(player.getState().status, 'idle')
assert.equal(renderHooks(dockRegistration.component, dockProps), null, 'the chip must hide in idle')
pass('ambient chip shows the Host error text with a dismiss button, hidden when idle')

/* ------------------------------------------------------------------ */
/* 9. Autoplay refusal turns into the blocked state                    */
/* ------------------------------------------------------------------ */

installHost()
audioBlockNext = true
await player.speak({ messageId: 'msg-blocked', text: 'Блок' })
assert.equal(player.getState().status, 'blocked')
assert.equal(player.getState().error, '«status.blocked»', 'the blocked message must be localized')
assert.equal(player.getState().hint, '«status.blockedHint»', 'the blocked state must carry the short hint')
const blockedChip = renderHooks(dockRegistration.component, dockProps)
assert.ok(blockedChip !== null)
assert.equal(blockedChip.props['data-voice-reply-state'], 'blocked')
const blockedDismiss = findElement(
  blockedChip,
  (element) => element.type === 'button' && element.props.title === 't:status.dismiss',
)
assert.ok(blockedDismiss !== null)
blockedDismiss.props.onClick()
assert.equal(player.getState().status, 'idle')
pass('NotAllowedError from audio.play() becomes the blocked state with a short hint')

/* ------------------------------------------------------------------ */
/* 10. Settings row: switch + POST /preferences + notices              */
/* ------------------------------------------------------------------ */

installHost()
assert.equal(await settings.refresh(), true)
const rowProps = Object.assign({}, sessionFace, { t })
const row = renderHooks(settingsRegistration.component, rowProps)
assert.ok(row !== null, 'the settings row must render')
assert.equal(row.type, 'div')
assert.ok('data-voice-reply-settings' in row.props)
const switchButton = findElement(row, (element) => element.type === 'button' && element.props.role === 'switch')
assert.ok(switchButton !== null, 'the row must expose a role=switch toggle')
assert.equal(switchButton.props['aria-checked'], 'true')
assert.equal(switchButton.props.disabled, false)
const rowText = JSON.stringify(row)
assert.ok(rowText.includes('t:autoSpeak.title'), 'the row title must be localized')
assert.ok(rowText.includes('t:autoSpeak.description'), 'the row description must be localized')

const preferencesBeforeToggle = preferencesCalls()
switchButton.props.onClick()
// The store publishes busy synchronously, so the next render is disabled.
const busyRow = renderHooks(settingsRegistration.component, rowProps)
const busySwitch = findElement(busyRow, (element) => element.type === 'button' && element.props.role === 'switch')
assert.ok(busySwitch !== null)
assert.equal(busySwitch.props.disabled, true, 'the switch is disabled while the write is in flight')
await tick(5)
assert.equal(preferencesCalls() - preferencesBeforeToggle, 1, 'toggling writes one POST /preferences')
assert.deepEqual(preferencePayloads.at(-1), { autoSpeak: false })
assert.equal(settings.getState().autoSpeak, false)
const savedRow = renderHooks(settingsRegistration.component, rowProps)
const savedSwitch = findElement(savedRow, (element) => element.type === 'button' && element.props.role === 'switch')
assert.ok(savedSwitch !== null)
assert.equal(savedSwitch.props['aria-checked'], 'false', 'the switch mirrors the persisted value')
assert.ok(JSON.stringify(savedRow).includes('t:settings.saved'), 'a successful write must show settings.saved')

installHost({ preferencesError: true })
const failingBefore = preferencesCalls()
const failingRow = renderHooks(settingsRegistration.component, rowProps)
const failingSwitch = findElement(failingRow, (element) => element.type === 'button' && element.props.role === 'switch')
assert.ok(failingSwitch !== null)
assert.equal(failingSwitch.props.disabled, false, 'a refused previous write must leave the row usable')
failingSwitch.props.onClick()
await tick(5)
assert.equal(preferencesCalls() - failingBefore, 1)
const failedRow = renderHooks(settingsRegistration.component, rowProps)
assert.ok(JSON.stringify(failedRow).includes('t:settings.failed'), 'a refused write must show settings.failed')
assert.equal(settings.getState().status, 'ready', 'a refused write keeps the ready state')
pass('settings row renders role=switch, writes autoSpeak via POST and shows the outcome')

/* ------------------------------------------------------------------ */
/* 11. Plugin settings page (plugins.row.config)                       */
/* ------------------------------------------------------------------ */

installHost()
assert.equal(await settings.refresh(), true)
assert.equal(settings.getState().summaryMaxChars, 700)
if (settings.getState().autoSpeak !== true) {
  assert.equal(await settings.setAutoSpeak(true), true)
}

const pluginPageProps = Object.assign({}, pluginSettingsFace, { view: 'page', t })
const pluginPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
assert.ok(pluginPage !== null, 'the plugin settings page must render')
assert.ok('data-voice-reply-plugin-settings' in pluginPage.props)
const summaryInput = findElement(
  pluginPage,
  (element) => element.type === 'input' && 'data-voice-reply-summary-input' in element.props,
)
assert.ok(summaryInput !== null, 'the page must expose the numeric summary input')
assert.equal(summaryInput.props.value, '700')
assert.equal(summaryInput.props.min, 100)
assert.equal(summaryInput.props.max, 2000)
assert.equal(summaryInput.props.step, 50)
const initialSave = findElement(
  pluginPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-save' in element.props,
)
assert.ok(initialSave !== null)
assert.equal(initialSave.props.disabled, true, 'save stays disabled without edits')
const secondsLabel = findElement(
  pluginPage,
  (element) => element.props !== undefined && 'data-voice-reply-summary-seconds' in element.props,
)
assert.ok(secondsLabel !== null, 'the page must show the speech-duration estimate')
assert.equal(secondsLabel.props['data-voice-reply-summary-seconds'], '47')
const voiceSelect = findElement(
  pluginPage,
  (element) => element.type === 'select' && 'data-voice-reply-voice-select' in element.props,
)
assert.ok(voiceSelect !== null, 'the page must expose the voice selector')
assert.equal(voiceSelect.props.value, 'alena')
assert.equal(voiceSelect.props.children.length, 3)
assert.ok(JSON.stringify(voiceSelect.props.children).includes('John'), 'the Host voice catalogue is offered')
const emotionSelect = findElement(
  pluginPage,
  (element) => element.type === 'select' && 'data-voice-reply-emotion-select' in element.props,
)
assert.ok(emotionSelect !== null, 'the page must expose the intonation selector')
assert.equal(emotionSelect.props.value, 'neutral', 'the voice default is presented as neutral')
assert.equal(emotionSelect.props.disabled, false)
assert.equal(
  JSON.stringify(emotionSelect.props.children.map((option) => option.props.value)),
  JSON.stringify(['neutral', 'good']),
  'only the intonations of the selected voice are offered',
)
const previewEmotionButton = findElement(
  pluginPage,
  (element) => element.type === 'button' && 'data-voice-reply-preview-emotion' in element.props,
)
assert.ok(previewEmotionButton !== null, 'the page must expose the intonation preview button')
assert.equal(previewEmotionButton.props.disabled, false)
const speedRange = findElement(
  pluginPage,
  (element) => element.type === 'input' && 'data-voice-reply-speed-range' in element.props,
)
assert.ok(speedRange !== null, 'the page must expose the speed slider')
assert.equal(speedRange.props.value, 1.32)
assert.equal(speedRange.props.min, 0.1)
assert.equal(speedRange.props.max, 3)
const speedValue = findElement(
  pluginPage,
  (element) => element.props !== undefined && 'data-voice-reply-speed-value' in element.props,
)
assert.ok(speedValue !== null)
assert.ok(JSON.stringify(speedValue.props.children).includes('1.32'))
const previewButton = findElement(
  pluginPage,
  (element) => element.type === 'button' && 'data-voice-reply-preview' in element.props,
)
assert.ok(previewButton !== null, 'the page must expose the voice preview button')
assert.equal(previewButton.props.disabled, false)
pass('plugin settings page renders the input, bounds, presets and speech estimate')

summaryInput.props.onChange({ target: { value: '400' } })
const editedPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const editedSave = findElement(
  editedPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-save' in element.props,
)
assert.ok(editedSave !== null)
assert.equal(editedSave.props.disabled, false, 'save becomes available after an edit')
assert.ok(JSON.stringify(editedPage).includes('t:pluginSettings.unsaved'), 'unsaved changes are announced')
const preferencesBeforePageSave = preferencesCalls()
editedSave.props.onClick()
await tick(5)
assert.equal(preferencesCalls() - preferencesBeforePageSave, 1, 'saving writes one POST /preferences')
assert.deepEqual(preferencePayloads.at(-1), { summaryMaxChars: 400 })
assert.equal(settings.getState().summaryMaxChars, 400)
const savedPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
assert.ok(JSON.stringify(savedPage).includes('t:pluginSettings.saved'), 'a successful save shows the outcome')
pass('plugin settings page saves the summary budget through POST /preferences')

const invalidInput = findElement(
  savedPage,
  (element) => element.type === 'input' && 'data-voice-reply-summary-input' in element.props,
)
invalidInput.props.onChange({ target: { value: '50' } })
const invalidPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const invalidSave = findElement(
  invalidPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-save' in element.props,
)
assert.equal(invalidSave.props.disabled, true, 'an out-of-range draft cannot be saved')
assert.ok(JSON.stringify(invalidPage).includes('t:pluginSettings.range'), 'the allowed range is shown')
const rangeInput = findElement(
  invalidPage,
  (element) => element.type === 'input' && 'data-voice-reply-summary-range' in element.props,
)
assert.equal(rangeInput.props.value, 400, 'the slider falls back to the accepted value')

const resetButton = findElement(
  invalidPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-reset' in element.props,
)
assert.ok(resetButton !== null)
resetButton.props.onClick()
const resetPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const resetInput = findElement(
  resetPage,
  (element) => element.type === 'input' && 'data-voice-reply-summary-input' in element.props,
)
assert.equal(resetInput.props.value, '400', 'reset restores the accepted value')
pass('plugin settings page validates the range and reset restores the accepted budget')

const previewBefore = audioUrls.length
const previewPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const previewButtonFresh = findElement(
  previewPage,
  (element) => element.type === 'button' && 'data-voice-reply-preview' in element.props,
)
previewButtonFresh.props.onClick()
await tick(10)
assert.equal(previewPayloads.length, 1, 'preview requests one short sample from the Host')
assert.deepEqual(previewPayloads.at(-1), { voice: 'alena', emotion: 'neutral', speed: 1.32 })
assert.equal(audioUrls.length - previewBefore, 1, 'the preview sample is played through the shared player')
assert.equal(player.getState().status, 'idle', 'the preview playback returns to idle')
pass('plugin settings page previews the draft voice, intonation and speed through /preview')

const voicePage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const voiceSelectEdit = findElement(
  voicePage,
  (element) => element.type === 'select' && 'data-voice-reply-voice-select' in element.props,
)
voiceSelectEdit.props.onChange({ target: { value: 'john' } })
const speedEditedPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const speedRangeEdit = findElement(
  speedEditedPage,
  (element) => element.type === 'input' && 'data-voice-reply-speed-range' in element.props,
)
speedRangeEdit.props.onChange({ target: { value: '1.5' } })
const editedVoicePage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const voiceSave = findElement(
  editedVoicePage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-save' in element.props,
)
assert.equal(voiceSave.props.disabled, false, 'voice/speed edits enable saving')
const preferencesBeforeVoiceSave = preferencesCalls()
voiceSave.props.onClick()
await tick(5)
assert.equal(preferencesCalls() - preferencesBeforeVoiceSave, 1)
assert.deepEqual(preferencePayloads.at(-1), { voice: 'john', emotion: '', speed: 1.5 })
assert.equal(settings.getState().voice, 'john')
assert.equal(settings.getState().emotion, '')
assert.equal(settings.getState().speed, 1.5)
const savedVoicePage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
assert.ok(JSON.stringify(savedVoicePage).includes('t:pluginSettings.saved'))
installHost({ status: { voice: 'alena', speed: 1.32 } })
assert.equal(await settings.savePreferences({ voice: 'alena', speed: 1.32 }), true)
assert.equal(settings.getState().voice, 'alena')
assert.equal(settings.getState().speed, 1.32)
pass('plugin settings page saves the selected voice and speed through POST /preferences')

/* ---- intonation: draft, preview, save and voice-dependent options ---- */
const emotionResetPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const emotionResetButton = findElement(
  emotionResetPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-reset' in element.props,
)
assert.ok(emotionResetButton !== null)
emotionResetButton.props.onClick()
const emotionBasePage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const emotionBaseSelect = findElement(
  emotionBasePage,
  (element) => element.type === 'select' && 'data-voice-reply-emotion-select' in element.props,
)
assert.equal(emotionBaseSelect.props.value, 'neutral', 'reset keeps the voice-default intonation')
emotionBaseSelect.props.onChange({ target: { value: 'good' } })
const emotionEditedPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const emotionSave = findElement(
  emotionEditedPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-save' in element.props,
)
assert.equal(emotionSave.props.disabled, false, 'an intonation edit enables saving')
const emotionPreviewButton = findElement(
  emotionEditedPage,
  (element) => element.type === 'button' && 'data-voice-reply-preview-emotion' in element.props,
)
assert.ok(emotionPreviewButton !== null)
emotionPreviewButton.props.onClick()
await tick(10)
assert.deepEqual(previewPayloads.at(-1), { voice: 'alena', emotion: 'good', speed: 1.32 }, 'the sample uses the chosen intonation')
const preferencesBeforeEmotionSave = preferencesCalls()
emotionSave.props.onClick()
await tick(5)
assert.equal(preferencesCalls() - preferencesBeforeEmotionSave, 1)
assert.deepEqual(preferencePayloads.at(-1), { emotion: 'good' })
assert.equal(settings.getState().emotion, 'good')
pass('plugin settings page previews and saves the selected intonation')

const marinaPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const marinaVoiceSelect = findElement(
  marinaPage,
  (element) => element.type === 'select' && 'data-voice-reply-voice-select' in element.props,
)
marinaVoiceSelect.props.onChange({ target: { value: 'marina' } })
const marinaEditedPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const marinaEmotionSelect = findElement(
  marinaEditedPage,
  (element) => element.type === 'select' && 'data-voice-reply-emotion-select' in element.props,
)
assert.equal(
  JSON.stringify(marinaEmotionSelect.props.children.map((option) => option.props.value)),
  JSON.stringify(['neutral', 'whisper', 'friendly']),
  'switching the voice offers that voice intonations',
)
assert.equal(marinaEmotionSelect.props.value, 'neutral', 'an intonation the new voice lacks falls back to neutral')
marinaEmotionSelect.props.onChange({ target: { value: 'whisper' } })
const marinaSavedPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const marinaSave = findElement(
  marinaSavedPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-save' in element.props,
)
marinaSave.props.onClick()
await tick(5)
assert.deepEqual(preferencePayloads.at(-1), { voice: 'marina', emotion: 'whisper' })
assert.equal(settings.getState().voice, 'marina')
assert.equal(settings.getState().emotion, 'whisper')

const noEmotionPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const noEmotionVoiceSelect = findElement(
  noEmotionPage,
  (element) => element.type === 'select' && 'data-voice-reply-voice-select' in element.props,
)
noEmotionVoiceSelect.props.onChange({ target: { value: 'john' } })
const noEmotionEditedPage = renderHooks(pluginSettingsRegistration.component, pluginPageProps)
const noEmotionSelect = findElement(
  noEmotionEditedPage,
  (element) => element.type === 'select' && 'data-voice-reply-emotion-select' in element.props,
)
assert.equal(noEmotionSelect.props.disabled, true, 'a voice without intonations disables the selector')
assert.equal(JSON.stringify(noEmotionSelect.props.children.map((option) => option.props.value)), JSON.stringify(['']))
assert.ok(
  JSON.stringify(noEmotionEditedPage).includes('t:pluginSettings.emotion.unsupported'),
  'the page explains that this voice has no intonations',
)
const noEmotionSave = findElement(
  noEmotionEditedPage,
  (element) => element.type === 'button' && 'data-voice-reply-summary-save' in element.props,
)
noEmotionSave.props.onClick()
await tick(5)
assert.deepEqual(preferencePayloads.at(-1), { voice: 'john', emotion: '' })
assert.equal(settings.getState().voice, 'john')
assert.equal(settings.getState().emotion, '')
installHost({ status: { voice: 'alena', emotion: '', speed: 1.32 } })
assert.equal(await settings.savePreferences({ voice: 'alena', emotion: '' }), true)
pass('a voice without intonations keeps the selector disabled and clears the intonation')

const autoSpeakSwitch = findElement(
  resetPage,
  (element) => element.type === 'button' && 'data-voice-reply-plugin-autospeak' in element.props,
)
assert.ok(autoSpeakSwitch !== null, 'the page must expose the auto-speak switch')
assert.equal(autoSpeakSwitch.props['aria-checked'], 'true')
const preferencesBeforeAutoSpeak = preferencesCalls()
autoSpeakSwitch.props.onClick()
await tick(5)
assert.equal(preferencesCalls() - preferencesBeforeAutoSpeak, 1)
assert.deepEqual(preferencePayloads.at(-1), { autoSpeak: false })
assert.equal(settings.getState().autoSpeak, false)
pass('plugin settings page toggles auto-speak through the same store')

const summaryLine = renderHooks(pluginSettingsRegistration.component, Object.assign({}, pluginSettingsFace, { view: 'summary', t }))
assert.equal(typeof summaryLine, 'string')
assert.ok(summaryLine.includes(String(settings.getState().summaryMaxChars)), 'the row summary reports the accepted budget')
assert.ok(summaryLine.includes('t:pluginSettings.chars'))
pass('plugin settings summary view reports the accepted budget')

installHost()
assert.equal(await settings.setAutoSpeak(true), true)

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

console.log('')
console.log(`PASS ${checks.length} checks against ${CLIENT_PATH}`)
console.log(`fetch calls observed: ${fetchCalls.length}; audio elements created: ${audioUrls.length}`)
assert.equal(warnings.length, 0, `no warnings were expected, got: ${JSON.stringify(warnings)}`)
