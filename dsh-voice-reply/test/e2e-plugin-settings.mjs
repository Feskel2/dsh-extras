/**
 * E2E check for the plugin's own settings page: Plugins → Голосовые ответы →
 * Настроить. Verifies the summary-budget control, its persistence through
 * POST /dsh-voice-reply/preferences, range validation, and that a long answer is
 * actually summarized before it reaches Yandex TTS (local mock endpoint).
 *
 * Run: node test/e2e-plugin-settings.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticatePage, closeBrowser, launchBrowser, openPage, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = path.join(HERE, '..', 'artifacts')
const URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const configFile = path.join(HERE, '..', 'plugin-config.json')

const failures = []
const checks = []
const network = []
let savedConfigRaw = null
let mockServer = null
const spokenRequests = []

/**
 * Record one check.
 * @param {string} name - check name.
 * @param {boolean} ok - result.
 * @param {unknown} [detail] - context.
 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`)
}

/**
 * Point the live plugin at a local mock of the Yandex TTS endpoint.
 * @returns {Promise<void>} completion.
 */
async function startMockTts() {
  mockServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const params = new URLSearchParams(body)
      spokenRequests.push({ text: params.get('text') ?? '', bytes: Buffer.byteLength(body) })
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(Buffer.from('FAKE-MP3'))
    })
  })
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  const port = mockServer.address().port
  savedConfigRaw = fs.readFileSync(configFile, 'utf8')
  const config = JSON.parse(savedConfigRaw)
  config.endpoint = `http://127.0.0.1:${port}/speech/v1/tts:synthesize`
  config.format = 'mp3'
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

fs.mkdirSync(ARTIFACTS, { recursive: true })
await startMockTts()

const browser = await launchBrowser()
const page = await openPage(browser.port, URL)
page.onEvent((message) => {
  if (message.method === 'Network.requestWillBeSent' && String(message.params.request.url).includes('/dsh-voice-reply/preferences')) {
    network.push({
      kind: 'request',
      method: message.params.request.method,
      url: message.params.request.url,
      postData: message.params.request.postData,
    })
  }
  if (message.method === 'Network.responseReceived' && String(message.params.response.url).includes('/dsh-voice-reply/preferences')) {
    network.push({ kind: 'response', status: message.params.response.status, url: message.params.response.url })
  }
})

try {
  await authenticatePage(page, URL)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await page.waitFor("document.body.innerText.includes('Рабочие пространства')", { timeoutMs: 30000, label: 'sidebar' })
  await sleep(1200)

  const statusBefore = await page.evaluate(`(async () => (await fetch('/dsh-voice-reply/status')).json())()`)
  check('status exposes summaryMaxChars and limits', Number.isFinite(statusBefore?.summaryMaxChars), statusBefore)
  const initialBudget = statusBefore.summaryMaxChars

  /* ---- Plugins → bundle → Configure ---- */
  const opened = await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button, [role="button"]')].find((b) => (b.innerText || '').trim() === 'Плагины');
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('Plugins page opened', opened === true)
  await page.waitFor("document.body.innerText.includes('Голосовые ответы')", { timeoutMs: 20000, label: 'bundle card' })
  await sleep(600)
  const cardOpened = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('Посмотреть Голосовые ответы'));
    if (b === undefined) return false;
    b.click();
    return true;
  })()`)
  check('bundle detail page opened', cardOpened === true)
  await page.waitFor(`document.querySelector('[data-plugin-detail="dsh-voice-reply"]') !== null`, { timeoutMs: 15000, label: 'bundle detail' })
  await sleep(600)
  const configureOpened = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('Настроить Голосовые ответы'));
    if (b === undefined) return false;
    b.click();
    return true;
  })()`)
  check('Configure control clicked', configureOpened === true)
  const pageFound = await page
    .waitFor(`document.querySelector('[data-voice-reply-plugin-settings]') !== null`, { timeoutMs: 15000, label: 'plugin settings page' })
    .then(() => true)
    .catch(() => false)
  check('plugin settings page rendered', pageFound)
  if (!pageFound) {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-plugin-settings-missing.png'))
  } else {
    const rendered = await page.evaluate(`(() => {
      const root = document.querySelector('[data-voice-reply-plugin-settings]');
      const input = root === null ? null : root.querySelector('[data-voice-reply-summary-input]');
      const range = root === null ? null : root.querySelector('[data-voice-reply-summary-range]');
      const save = root === null ? null : root.querySelector('[data-voice-reply-summary-save]');
      const auto = root === null ? null : root.querySelector('[data-voice-reply-plugin-autospeak]');
      return {
        text: root === null ? '' : (root.innerText || '').slice(0, 500),
        input: input === null ? null : { value: input.value, min: input.min, max: input.max, step: input.step, disabled: input.disabled },
        range: range === null ? null : { value: range.value, disabled: range.disabled },
        save: save === null ? null : { disabled: save.disabled, text: (save.innerText || '').trim() },
        auto: auto === null ? null : auto.getAttribute('aria-checked'),
      };
    })()`)
    check('page shows the Max chars control', /Максимум символов/i.test(rendered.text), rendered)
    check('numeric input has the Host budget and bounds', rendered.input?.value === String(initialBudget) && rendered.input?.min === '100' && rendered.input?.max === '2000', rendered.input)
    check('range control mirrors the budget', rendered.range?.value === String(initialBudget), rendered.range)
    check('save is disabled without edits', rendered.save?.disabled === true, rendered.save)
    check('auto-speak switch present', rendered.auto?.toString() === 'true' || rendered.auto?.toString() === 'false', rendered.auto)

    /* ---- change the budget to 350 and save ---- */
    const edited = await page.evaluate(`(() => {
      const input = document.querySelector('[data-voice-reply-summary-input]');
      if (input === null) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '350');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    check('summary input edited', edited === true)
    await sleep(500)
    const editedState = await page.evaluate(`(() => {
      const root = document.querySelector('[data-voice-reply-plugin-settings]');
      const save = root === null ? null : root.querySelector('[data-voice-reply-summary-save]');
      return { saveDisabled: save === null ? null : save.disabled, text: root === null ? '' : (root.innerText || '') };
    })()`)
    check('save becomes available after an edit', editedState.saveDisabled === false, editedState)
    const clicked = await page.evaluate(`(() => {
      const save = document.querySelector('[data-voice-reply-summary-save]');
      if (save === null) return false;
      save.click();
      return true;
    })()`)
    check('save clicked', clicked === true)
    await sleep(1500)
    const preferenceRequest = network.filter((entry) => entry.kind === 'request' && entry.url.endsWith('/preferences')).pop()
    const preferenceResponse = network.filter((entry) => entry.kind === 'response' && entry.url.endsWith('/preferences')).pop()
    check('save posts summaryMaxChars', preferenceRequest?.postData === '{"summaryMaxChars":350}', preferenceRequest)
    check('save succeeds', preferenceResponse?.status === 200, preferenceResponse)
    const statusAfterSave = await page.evaluate(`(async () => (await fetch('/dsh-voice-reply/status')).json())()`)
    check('status reflects the new budget', statusAfterSave?.summaryMaxChars === 350, statusAfterSave?.summaryMaxChars)
    await page.screenshot(path.join(ARTIFACTS, 'e2e-plugin-settings.png'))

    /* ---- a long answer is summarized before TTS ---- */
    const unique = Date.now().toString(36)
    const answer = `# Подробный ответ ${unique}\n\n${'Это длинное пояснение, которое не нужно читать голосом целиком, потому что слушателю важна только суть. '.repeat(12)}\n\n\`\`\`js\nconst hidden = "код не должен озвучиваться";\n\`\`\`\n\nИтог: плагин озвучивает короткое содержание, а не весь ответ. Уникальный маркер: ${unique}.`
    const spoken = await page.evaluate(`(async () => {
      const response = await fetch('/dsh-voice-reply/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ${JSON.stringify(answer)}, messageId: 'e2e-summary-${unique}' }),
      });
      return { status: response.status, json: await response.json() };
    })()`)
    check('speak response is 200', spoken.status === 200, spoken)
    check('speak reports a summary', spoken.json?.summarized === true, spoken.json)
    check('speak is not served from an earlier cache run', spoken.json?.cached === false, spoken.json?.cached)
    check('spoken text respects the 350-char budget', spoken.json?.chars <= 350, spoken.json?.chars)
    check('the mock TTS received a short text', spokenRequests.length > 0 && spokenRequests[0].text.length <= 350, spokenRequests)
    check('the mock TTS did not receive the code', spokenRequests.length > 0 && !spokenRequests[0].text.includes('код не должен озвучиваться'), spokenRequests[0]?.text)
    check('speak text is not the full answer', spokenRequests.length > 0 && spokenRequests[0].text.length < answer.length, { spoken: spokenRequests[0]?.text.length, full: answer.length })

    /* ---- validation: an out-of-range value cannot be saved ---- */
    const invalid = await page.evaluate(`(() => {
      const input = document.querySelector('[data-voice-reply-summary-input]');
      if (input === null) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '50');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    check('out-of-range value entered', invalid === true)
    await sleep(400)
    const invalidState = await page.evaluate(`(() => {
      const root = document.querySelector('[data-voice-reply-plugin-settings]');
      const save = root === null ? null : root.querySelector('[data-voice-reply-summary-save]');
      return { saveDisabled: save === null ? null : save.disabled, text: root === null ? '' : (root.innerText || '') };
    })()`)
    check('out-of-range value cannot be saved', invalidState.saveDisabled === true, invalidState)
    check('the allowed range is shown', /100/.test(invalidState.text) && /2000/.test(invalidState.text), invalidState.text.slice(-300))

    /* ---- restore the initial budget ---- */
    await page.evaluate(`(() => {
      const input = document.querySelector('[data-voice-reply-summary-input]');
      if (input === null) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(String(initialBudget))});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await sleep(400)
    await page.evaluate(`(() => {
      const save = document.querySelector('[data-voice-reply-summary-save]');
      if (save !== null && save.disabled === false) save.click();
      return true;
    })()`)
    await sleep(1200)
    const restored = await page.evaluate(`(async () => (await fetch('/dsh-voice-reply/status')).json())()`)
    check('original budget restored', restored?.summaryMaxChars === initialBudget, restored?.summaryMaxChars)
  }
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-plugin-settings-failure.png'))
  } catch {
    /* ignore */
  }
} finally {
  if (savedConfigRaw !== null) fs.writeFileSync(configFile, savedConfigRaw, 'utf8')
  if (mockServer !== null) await new Promise((resolve) => mockServer.close(resolve))
  const summary = {
    ok: failures.length === 0,
    failures,
    checks,
    network,
    spokenRequests: spokenRequests.map((request) => ({ chars: request.text.length, bytes: request.bytes, preview: request.text.slice(0, 160) })),
    console: page.consoleMessages.slice(-30),
    exceptions: page.exceptions.slice(-10),
  }
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-plugin-settings-report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  page.close()
  closeBrowser(browser)
}

if (failures.length > 0) process.exitCode = 1
