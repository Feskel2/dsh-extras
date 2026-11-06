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
let initialVoice = null
let initialSpeed = null
let initialEmotion = null

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
      spokenRequests.push({
        text: params.get('text') ?? '',
        bytes: Buffer.byteLength(body),
        voice: params.get('voice'),
        emotion: params.get('emotion'),
        speed: params.get('speed'),
      })
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
  if (message.method === 'Network.requestWillBeSent' && String(message.params.request.url).includes('/dsh-voice-reply/preview')) {
    network.push({
      kind: 'request',
      method: message.params.request.method,
      url: message.params.request.url,
      postData: message.params.request.postData,
    })
  }
  if (message.method === 'Network.responseReceived' && String(message.params.response.url).includes('/dsh-voice-reply/preview')) {
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
  check('status exposes the voice catalogue', Array.isArray(statusBefore?.voices) && statusBefore.voices.length > 0, statusBefore?.voices?.length)
  check(
    'status exposes the accepted intonation and its options',
    typeof statusBefore?.emotion === 'string' && Array.isArray(statusBefore?.emotionOptions),
    { emotion: statusBefore?.emotion, options: statusBefore?.emotionOptions },
  )
  const initialBudget = statusBefore.summaryMaxChars
  initialVoice = statusBefore.voice
  initialSpeed = statusBefore.speed
  initialEmotion = statusBefore.emotion ?? ''
  const initialVoiceEntry = (statusBefore.voices ?? []).find((voice) => voice.id === initialVoice)
  const initialEmotions = Array.isArray(initialVoiceEntry?.emotions) ? initialVoiceEntry.emotions : []

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
      const voice = root === null ? null : root.querySelector('[data-voice-reply-voice-select]');
      const emotion = root === null ? null : root.querySelector('[data-voice-reply-emotion-select]');
      const speed = root === null ? null : root.querySelector('[data-voice-reply-speed-range]');
      const speedValue = root === null ? null : root.querySelector('[data-voice-reply-speed-value]');
      const preview = root === null ? null : root.querySelector('[data-voice-reply-preview]');
      const previewEmotion = root === null ? null : root.querySelector('[data-voice-reply-preview-emotion]');
      return {
        text: root === null ? '' : (root.innerText || '').slice(0, 700),
        input: input === null ? null : { value: input.value, min: input.min, max: input.max, step: input.step, disabled: input.disabled },
        range: range === null ? null : { value: range.value, disabled: range.disabled },
        save: save === null ? null : { disabled: save.disabled, text: (save.innerText || '').trim() },
        auto: auto === null ? null : auto.getAttribute('aria-checked'),
        voice: voice === null ? null : { value: voice.value, options: voice.options.length, disabled: voice.disabled },
        emotion:
          emotion === null
            ? null
            : {
                value: emotion.value,
                options: [...emotion.options].map((option) => option.value),
                disabled: emotion.disabled,
              },
        speed: speed === null ? null : { value: speed.value, min: speed.min, max: speed.max, step: speed.step, disabled: speed.disabled },
        speedValue: speedValue === null ? null : (speedValue.innerText || '').trim(),
        preview: preview === null ? null : { disabled: preview.disabled, text: (preview.innerText || '').trim() },
        previewEmotion: previewEmotion === null ? null : { disabled: previewEmotion.disabled, text: (previewEmotion.innerText || '').trim() },
      };
    })()`)
    check('page shows the Max chars control', /Максимум символов/i.test(rendered.text), rendered)
    check('numeric input has the Host budget and bounds', rendered.input?.value === String(initialBudget) && rendered.input?.min === '100' && rendered.input?.max === '2000', rendered.input)
    check('range control mirrors the budget', rendered.range?.value === String(initialBudget), rendered.range)
    check('save is disabled without edits', rendered.save?.disabled === true, rendered.save)
    check('auto-speak switch present', rendered.auto?.toString() === 'true' || rendered.auto?.toString() === 'false', rendered.auto)
    check('voice selector shows the Host catalogue', rendered.voice?.value === initialVoice && rendered.voice?.options > 1, rendered.voice)
    const expectedInitialEmotion = initialEmotions.length === 0
      ? ''
      : initialEmotions.includes(initialEmotion)
        ? initialEmotion
        : initialEmotions.includes('neutral')
          ? 'neutral'
          : initialEmotions[0]
    check(
      'intonation selector shows the voice options',
      rendered.emotion !== null &&
        JSON.stringify(rendered.emotion.options) === JSON.stringify(initialEmotions.length === 0 ? [''] : initialEmotions) &&
        rendered.emotion.value === expectedInitialEmotion &&
        rendered.emotion.disabled === (initialEmotions.length === 0),
      rendered.emotion,
    )
    check('intonation preview button is present', rendered.previewEmotion?.disabled === false, rendered.previewEmotion)
    check('speed slider mirrors the Host speed', rendered.speed?.value === String(initialSpeed) && rendered.speed?.min === '0.1' && rendered.speed?.max === '3', rendered.speed)
    check('speed readout is rendered', /1\.32|1\.5/.test(rendered.speedValue ?? ''), rendered.speedValue)
    check('voice preview button is present', rendered.preview?.disabled === false && /Прослушать/i.test(rendered.preview?.text ?? ''), rendered.preview)
    await page.screenshot(path.join(ARTIFACTS, 'e2e-plugin-settings.png'))

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

    /* ---- choose another voice/speed/intonation, preview it and save it ---- */
    const targetVoice = initialVoice === 'alena' ? 'marina' : 'alena'
    const targetSpeed = Math.abs(initialSpeed - 1.5) < 0.01 ? 1.1 : 1.5
    const targetEmotion = targetVoice === 'marina' ? 'whisper' : 'good'
    await page.evaluate(`(() => {
      const voice = document.querySelector('[data-voice-reply-voice-select]');
      const speed = document.querySelector('[data-voice-reply-speed-range]');
      if (voice === null || speed === null) return false;
      const voiceSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      voiceSetter.call(voice, ${JSON.stringify(targetVoice)});
      voice.dispatchEvent(new Event('change', { bubbles: true }));
      const speedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      speedSetter.call(speed, ${JSON.stringify(String(targetSpeed))});
      speed.dispatchEvent(new Event('input', { bubbles: true }));
      speed.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await sleep(500)
    const voiceDraftState = await page.evaluate(`(() => {
      const voice = document.querySelector('[data-voice-reply-voice-select]');
      const speed = document.querySelector('[data-voice-reply-speed-range]');
      const save = document.querySelector('[data-voice-reply-summary-save]');
      return {
        voice: voice === null ? null : voice.value,
        speed: speed === null ? null : speed.value,
        saveDisabled: save === null ? null : save.disabled,
      };
    })()`)
    check('voice draft is selected', voiceDraftState.voice === targetVoice, voiceDraftState)
    check('speed draft is selected', Number(voiceDraftState.speed) === targetSpeed, voiceDraftState)

    const emotionEdited = await page.evaluate(`(() => {
      const emotion = document.querySelector('[data-voice-reply-emotion-select]');
      if (emotion === null) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(emotion, ${JSON.stringify(targetEmotion)});
      emotion.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    check('intonation draft edited', emotionEdited === true)
    await sleep(400)
    const emotionDraftState = await page.evaluate(`(() => {
      const emotion = document.querySelector('[data-voice-reply-emotion-select]');
      const save = document.querySelector('[data-voice-reply-summary-save]');
      return {
        value: emotion === null ? null : emotion.value,
        disabled: emotion === null ? null : emotion.disabled,
        options: emotion === null ? [] : [...emotion.options].map((option) => option.value),
        saveDisabled: save === null ? null : save.disabled,
      };
    })()`)
    check('intonation draft is selected', emotionDraftState.value === targetEmotion, emotionDraftState)
    check('the new voice offers its own intonations', emotionDraftState.options.includes(targetEmotion), emotionDraftState)
    check('voice/speed/intonation edits enable saving', voiceDraftState.saveDisabled === false && emotionDraftState.saveDisabled === false, {
      voice: voiceDraftState,
      emotion: emotionDraftState,
    })

    const previewClicked = await page.evaluate(`(() => {
      const button = document.querySelector('[data-voice-reply-preview]');
      if (button === null) return false;
      button.click();
      return true;
    })()`)
    check('voice preview clicked', previewClicked === true)
    await sleep(1500)
    const previewRequest = network.filter((entry) => entry.kind === 'request' && entry.url.endsWith('/preview')).pop()
    const previewResponse = network.filter((entry) => entry.kind === 'response' && entry.url.endsWith('/preview')).pop()
    let previewBody = null
    try {
      previewBody = previewRequest === undefined ? null : JSON.parse(previewRequest.postData)
    } catch {
      previewBody = null
    }
    check('preview requests the draft voice and speed', previewBody?.voice === targetVoice && previewBody?.speed === targetSpeed, previewBody)
    check('preview requests the draft intonation', previewBody?.emotion === targetEmotion, previewBody)
    check('preview succeeds', previewResponse?.status === 200, previewResponse)
    check('the mock TTS received the draft intonation', spokenRequests.at(-1)?.emotion === targetEmotion, spokenRequests.at(-1))
    const previewStopLabel = await page.evaluate(`(() => {
      const button = document.querySelector('[data-voice-reply-preview]');
      return button === null ? '' : (button.innerText || '').trim();
    })()`)
    if (/Остановить|Stop/i.test(previewStopLabel)) {
      await page.evaluate(`(() => {
        const button = document.querySelector('[data-voice-reply-preview]');
        if (button !== null) button.click();
        return true;
      })()`)
      await sleep(300)
    }

    const voiceSaveClicked = await page.evaluate(`(() => {
      const save = document.querySelector('[data-voice-reply-summary-save]');
      if (save === null) return false;
      save.click();
      return true;
    })()`)
    check('voice/speed save clicked', voiceSaveClicked === true)
    await sleep(1500)
    const voicePreferenceRequest = network
      .filter((entry) => entry.kind === 'request' && entry.url.endsWith('/preferences'))
      .pop()
    let voicePreferenceBody = null
    try {
      voicePreferenceBody = voicePreferenceRequest === undefined ? null : JSON.parse(voicePreferenceRequest.postData)
    } catch {
      voicePreferenceBody = null
    }
    check('save posts the chosen voice and speed', voicePreferenceBody?.voice === targetVoice && voicePreferenceBody?.speed === targetSpeed, voicePreferenceBody)
    check('save posts the chosen intonation', voicePreferenceBody?.emotion === targetEmotion, voicePreferenceBody)
    const statusAfterVoiceSave = await page.evaluate(`(async () => (await fetch('/dsh-voice-reply/status')).json())()`)
    check('status reflects the voice', statusAfterVoiceSave?.voice === targetVoice, statusAfterVoiceSave?.voice)
    check('status reflects the speed', statusAfterVoiceSave?.speed === targetSpeed, statusAfterVoiceSave?.speed)
    check('status reflects the intonation', statusAfterVoiceSave?.emotion === targetEmotion, statusAfterVoiceSave?.emotion)
    await page.screenshot(path.join(ARTIFACTS, 'e2e-plugin-settings-voice.png'))

    /* ---- a long answer is summarized before TTS ---- */
    spokenRequests.length = 0
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
  if (initialVoice !== null && initialSpeed !== null) {
    try {
      await fetch(`${URL}/dsh-voice-reply/preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice: initialVoice, speed: initialSpeed, emotion: initialEmotion ?? '' }),
      })
    } catch {
      /* best effort: config restoration below still runs */
    }
  }
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
