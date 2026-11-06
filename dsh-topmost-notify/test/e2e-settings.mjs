/**
 * E2E-проверка страницы настроек плагина dsh-topmost-notify.
 *
 * Требует изолированного экземпляра DSH Web с установленным бандлом
 * dsh-topmost-notify (см. README «Разработка» / artifacts стенда):
 *
 *   $env:DSH_HOME='D:\dsh-data-test'
 *   $env:DSH_PROFILE_DIR='D:\dsh-data-test\profiles\web'
 *   $env:DSH_TOPMOST_NOTIFY_DRY_RUN='1'   # уведомления пишутся в лог, окна не мешают
 *   node test/e2e-settings.mjs http://127.0.0.1:3099
 *
 * Проверяет: карточку бандла → строку topmost-notify → страницу (все контролы,
 * значения по умолчанию), сохранение времени показа, загрузку своего .wav и
 * (если есть фикстур) .mp3, кнопки прослушивания/показа окна через локальный
 * HTTP API, сохранение значений после перезагрузки страницы и скриншот.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticatePage, closeBrowser, launchBrowser, openPage, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const ARTIFACTS = path.join(ROOT, 'artifacts')
const URL_ARG = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3099'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? path.join(process.env.DSH_HOME ?? '', 'profiles', 'web')
const PATCH_PATH = path.join(PROFILE_DIR, 'cordis.patch.yml')
const INSTALLED = path.join(PROFILE_DIR, 'node_modules', 'dsh-topmost-notify')
const DEBUG_LOG = path.join(INSTALLED, 'host', 'notify-debug.log')
const SOUNDS_DIR = path.join(INSTALLED, 'sounds')
const FIXTURES_DIR = path.join(HERE, 'fixtures')
/** First MP3 fixture committed by the host tests, if any. */
const MP3_FIXTURE = fs.existsSync(FIXTURES_DIR)
  ? fs.readdirSync(FIXTURES_DIR).filter((name) => name.toLowerCase().endsWith('.mp3')).map((name) => path.join(FIXTURES_DIR, name))[0]
  : undefined
const WAV_FIXTURE = path.join(ROOT, 'host', 'chime.wav')
const CHECKS = []
const FAILURES = []

/**
 * Record one check.
 * @param {string} name - check name.
 * @param {boolean} ok - result.
 * @param {unknown} [detail] - evidence.
 * @returns {void}
 */
function check(name, ok, detail) {
  CHECKS.push({ name, ok, detail })
  if (!ok) FAILURES.push(`${name}: ${JSON.stringify(detail)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 400)}`}`)
}

/** Read the profile patch as text. */
function readPatch() {
  try {
    return fs.readFileSync(PATCH_PATH, 'utf8')
  } catch {
    return ''
  }
}

/** Read the dry-run lines of the installed notifier log. */
function dryRuns() {
  try {
    return fs
      .readFileSync(DEBUG_LOG, 'utf8')
      .split('\n')
      .filter((line) => line.includes(' dry-run '))
      .map((line) => JSON.parse(line.slice(line.indexOf(' dry-run ') + ' dry-run '.length)))
  } catch {
    return []
  }
}

/** Delete the notifier log so one step's dry runs are unambiguous. */
function resetLog() {
  try {
    fs.rmSync(DEBUG_LOG, { force: true })
  } catch {
    /* best effort */
  }
}

/** Wait until a predicate over the patch text is true. */
async function waitPatch(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = readPatch()
    if (predicate(text)) return text
    if (Date.now() > deadline) throw new Error(`timeout waiting for the patch: ${label}`)
    await sleep(200)
  }
}

/** Set one React-controlled input's value and notify React about it. */
const SET_INPUT = `(selector, value, eventName) => {
  const input = document.querySelector(selector)
  if (input === null) return false
  const proto = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(input, String(value))
  input.dispatchEvent(new Event(eventName, { bubbles: true }))
  return true
}`

/** Click the first element matching a CSS selector or accessible text. */
const CLICK = `(selector) => {
  const node = document.querySelector(selector)
  if (node === null) return false
  node.click()
  return true
}`

fs.mkdirSync(ARTIFACTS, { recursive: true })
let browser
let page
try {
  browser = await launchBrowser({ port: 9336 })
  page = await openPage(browser.port, URL_ARG)
  page.onEvent((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      console.log('PAGE EXCEPTION', JSON.stringify(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text))
    }
  })
  await authenticatePage(page, URL_ARG)
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false })
  } catch {
    /* optional */
  }
  await page.send('Page.navigate', { url: URL_ARG })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await page.waitFor("document.body.innerText.includes('Рабочие пространства')", { timeoutMs: 30000, label: 'sidebar' })
  await sleep(1500)

  /* ---- 1. Plugins → bundle → row → settings page ------------------------- */
  const openedPlugins = await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button, [role="button"]')].find((b) => (b.innerText || '').trim() === 'Плагины')
    if (target === undefined) return false
    target.click()
    return true
  })()`)
  check('Plugins page opened', openedPlugins === true)
  await page.waitFor("document.body.innerText.includes('Уведомления о задачах')", { timeoutMs: 20000, label: 'bundle card' })
  await sleep(600)

  const openedCard = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('Уведомления о задачах'))
    if (b === undefined) return false
    b.click()
    return true
  })()`)
  check('bundle card opened', openedCard === true)
  await page.waitFor(`document.querySelector('[data-plugin-detail="dsh-topmost-notify"]') !== null`, { timeoutMs: 15000, label: 'bundle detail' })
  await sleep(600)

  const openedRow = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('Настроить'))
    if (b === undefined) return false
    b.click()
    return true
  })()`)
  check('row Configure opened', openedRow === true)
  const pageFound = await page
    .waitFor(`document.querySelector('[data-topmost-notify-settings]') !== null`, { timeoutMs: 15000, label: 'plugin settings page' })
    .then(() => true)
    .catch(() => false)
  check('plugin settings page rendered', pageFound)
  if (!pageFound) {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-settings-missing.png'))
    throw new Error('settings page did not render')
  }

  const rendered = await page.evaluate(`(() => {
    const root = document.querySelector('[data-topmost-notify-settings]')
    const q = (selector) => root.querySelector(selector)
    const read = (selector) => {
      const node = q(selector)
      if (node === null) return null
      return { value: node.value ?? null, text: (node.innerText || '').trim(), disabled: node.disabled === true }
    }
    return {
      text: (root.innerText || '').slice(0, 1200),
      completed: read('[data-tn-duration-completed]'),
      completedRange: read('[data-tn-duration-completed-range]'),
      question: read('[data-tn-duration-question]'),
      questionRange: read('[data-tn-duration-question-range]'),
      completedSound: read('[data-tn-completed-sound-enabled]'),
      questionSound: read('[data-tn-question-sound-enabled]'),
      completedFile: read('[data-tn-completed-file]'),
      questionFile: read('[data-tn-question-file]'),
      completedName: read('[data-tn-completed-file-name]'),
      questionName: read('[data-tn-question-file-name]'),
      save: read('[data-tn-save]'),
      reset: read('[data-tn-reset]'),
      previewSound: read('[data-tn-completed-preview]'),
      previewWindow: read('[data-tn-completed-window]'),
      notice: read('[data-tn-notice]'),
    }
  })()`)
  check('page shows time and sound sections', /время|звук/i.test(rendered.text), rendered.text.slice(0, 200))
  check('completed duration defaults to 1.0 s', rendered.completed?.value === '1', rendered.completed)
  check('question duration defaults to 1.5 s', rendered.question?.value === '1.5', rendered.question)
  check('duration sliders are present and mirror inputs', rendered.completedRange?.value === '1' && rendered.questionRange?.value === '1.5', {
    completed: rendered.completedRange,
    question: rendered.questionRange,
  })
  check('both sound switches are on by default', rendered.completedSound?.value !== null && rendered.questionSound?.value !== null, {
    completed: rendered.completedSound,
    question: rendered.questionSound,
  })
  check('file inputs accept mp3/wav', rendered.completedFile !== null && rendered.questionFile !== null, {
    completed: rendered.completedFile,
    question: rendered.questionFile,
  })
  check('preview buttons are enabled', rendered.previewSound?.disabled === false && rendered.previewWindow?.disabled === false, {
    sound: rendered.previewSound,
    window: rendered.previewWindow,
  })
  check('save is disabled without edits', rendered.save?.disabled === true, rendered.save)

  /* ---- 2. durations + save ---------------------------------------------- */
  await page.evaluate(`(${SET_INPUT})('[data-tn-duration-completed]', 2.5, 'input')`)
  await page.evaluate(`(${SET_INPUT})('[data-tn-duration-question]', 3, 'input')`)
  await sleep(300)
  const dirty = await page.evaluate(`(() => {
    const save = document.querySelector('[data-tn-save]')
    return save === null ? null : save.disabled === false
  })()`)
  check('save becomes enabled after edits', dirty === true, dirty)
  await page.evaluate(`(${CLICK})('[data-tn-save]')`)
  await waitPatch((text) => /durationMs:\s*2500/.test(text) && /questionDurationMs:\s*3000/.test(text), 'saved durations')
  check('durations persisted to the profile patch', true)

  /* ---- 3. custom WAV upload + save -------------------------------------- */
  await page.send('DOM.enable')
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeId: fileNodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-tn-completed-file]' })
  check('completed file input found in the DOM', fileNodeId > 0)
  await page.send('DOM.setFileInputFiles', { nodeId: fileNodeId, files: [WAV_FIXTURE] })
  await page.waitFor(`(() => {
    const node = document.querySelector('[data-tn-completed-file-name]')
    return node !== null && (node.innerText || '').includes('chime.wav')
  })()`, { timeoutMs: 15000, label: 'uploaded wav name' })
  const uploadedWav = await page.evaluate(`(() => {
    const node = document.querySelector('[data-tn-completed-file-name]')
    return node === null ? '' : (node.innerText || '').trim()
  })()`)
  check('uploaded WAV name shown on the page', /chime\.wav/i.test(uploadedWav), uploadedWav)
  const wavFiles = fs.existsSync(SOUNDS_DIR) ? fs.readdirSync(SOUNDS_DIR).filter((name) => name.startsWith('completed-') && name.endsWith('.wav')) : []
  check('uploaded WAV stored in sounds/', wavFiles.length > 0, wavFiles)
  await page.evaluate(`(${CLICK})('[data-tn-save]')`)
  await waitPatch((text) => /completedSoundFile:\s*\S+completed-/.test(text), 'saved wav path')
  check('custom WAV path persisted to the profile patch', true)

  /* ---- 4. preview endpoints through the page ---------------------------- */
  resetLog()
  await page.evaluate(`(${CLICK})('[data-tn-completed-preview]')`)
  await sleep(1200)
  const soundPreview = dryRuns().filter((run) => run.kind === 'completed')
  check('sound preview reached the host (dry-run)', soundPreview.length >= 1, soundPreview)
  resetLog()
  await page.evaluate(`(${CLICK})('[data-tn-completed-window]')`)
  await sleep(1200)
  const windowPreview = dryRuns().filter((run) => run.kind === 'completed')
  check('window preview reached the host (dry-run)', windowPreview.length >= 1, windowPreview)

  /* ---- 5. MP3 upload (when the fixture exists) -------------------------- */
  if (MP3_FIXTURE !== undefined) {
    const mp3Name = path.basename(MP3_FIXTURE)
    const { nodeId: mp3NodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-tn-question-file]' })
    await page.send('DOM.setFileInputFiles', { nodeId: mp3NodeId, files: [MP3_FIXTURE] })
    await page.waitFor(`(() => {
      const node = document.querySelector('[data-tn-question-file-name]')
      return node !== null && (node.innerText || '').includes(${JSON.stringify(mp3Name)})
    })()`, { timeoutMs: 15000, label: 'uploaded mp3 name' })
    const mp3Files = fs.readdirSync(SOUNDS_DIR).filter((name) => name.startsWith('question-') && name.endsWith('.mp3'))
    check('uploaded MP3 stored in sounds/', mp3Files.length > 0, mp3Files)
    await page.evaluate(`(${CLICK})('[data-tn-save]')`)
    await waitPatch((text) => /questionSoundFile:\s*\S+question-.*\.mp3/.test(text), 'saved mp3 path')
    check('custom MP3 path persisted to the profile patch', true)
    resetLog()
    await page.evaluate(`(${CLICK})('[data-tn-question-preview]')`)
    await sleep(1200)
    const mp3Preview = dryRuns().filter((run) => run.kind === 'question')
    check('MP3 preview reached the host (dry-run)', mp3Preview.length >= 1, mp3Preview)
  } else {
    console.log(`SKIP  MP3 fixture not found at ${MP3_FIXTURE}`)
  }

  await page.screenshot(path.join(ARTIFACTS, 'e2e-settings.png'))

  /* ---- 6. reload: persisted values survive ------------------------------ */
  await page.send('Page.reload', { ignoreCache: false })
  await page.waitFor("document.body.innerText.includes('Рабочие пространства')", { timeoutMs: 30000, label: 'sidebar after reload' })
  await sleep(1500)
  await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button, [role="button"]')].find((b) => (b.innerText || '').trim() === 'Плагины')
    if (target !== undefined) target.click()
  })()`)
  await page.waitFor("document.body.innerText.includes('Уведомления о задачах')", { timeoutMs: 20000, label: 'bundle card after reload' })
  await sleep(600)
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('Уведомления о задачах'))
    if (b !== undefined) b.click()
  })()`)
  await page.waitFor(`document.querySelector('[data-plugin-detail="dsh-topmost-notify"]') !== null`, { timeoutMs: 15000 })
  await sleep(500)
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('Настроить'))
    if (b !== undefined) b.click()
  })()`)
  await page.waitFor(`document.querySelector('[data-topmost-notify-settings]') !== null`, { timeoutMs: 15000, label: 'settings page after reload' })
  const reloaded = await page.evaluate(`(() => {
    const root = document.querySelector('[data-topmost-notify-settings]')
    const read = (selector) => {
      const node = root.querySelector(selector)
      return node === null ? null : node.value
    }
    return {
      completed: read('[data-tn-duration-completed]'),
      question: read('[data-tn-duration-question]'),
      completedName: (root.querySelector('[data-tn-completed-file-name]')?.innerText || '').trim(),
    }
  })()`)
  check('durations persisted after reload', reloaded.completed === '2.5' && reloaded.question === '3', reloaded)
  check('stored sound name persisted after reload', /completed-\d+\.wav/i.test(reloaded.completedName), reloaded.completedName)

  await page.screenshot(path.join(ARTIFACTS, 'e2e-settings.png'))
} catch (error) {
  FAILURES.push(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  if (page !== undefined) {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-settings-failure.png')).catch(() => {})
  }
} finally {
  if (page !== undefined) page.close()
  if (browser !== undefined) closeBrowser(browser)
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  fs.writeFileSync(
    path.join(ARTIFACTS, 'e2e-settings-report.json'),
    `${JSON.stringify({ url: URL_ARG, ok: FAILURES.length === 0, checks: CHECKS, failures: FAILURES }, null, 2)}\n`,
    'utf8',
  )
  console.log(`\nchecks=${CHECKS.length} failures=${FAILURES.length}`)
  if (FAILURES.length > 0) {
    console.log(FAILURES.join('\n'))
    process.exitCode = 1
  }
}
