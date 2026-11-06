/**
 * Browser E2E for "speak only after the user returns to the tab/chat".
 *
 * Flow: start a real new Session, submit a prompt, immediately simulate the DSH
 * page being hidden and unfocused, wait for the Turn to finish, and verify:
 *   - no /speak request and no audio while the page is inactive;
 *   - after the page becomes visible/focused again, the finished answer is
 *     spoken once (real Yandex TTS), audio is served and playback completes.
 *
 * Run: node test/e2e-deferred-speech.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticatePage, closeBrowser, launchBrowser, openPage, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = path.join(HERE, '..', 'artifacts')
const URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'

const failures = []
const checks = []
const network = []

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

fs.mkdirSync(ARTIFACTS, { recursive: true })
const browser = await launchBrowser()
const page = await openPage(browser.port, URL)
page.onEvent((message) => {
  if (message.method === 'Network.requestWillBeSent' && String(message.params.request.url).includes('/dsh-voice-reply/')) {
    const url = String(message.params.request.url)
    if (!url.endsWith('/status')) network.push({ at: Date.now(), kind: 'request', method: message.params.request.method, url })
  }
  if (message.method === 'Network.responseReceived' && String(message.params.response.url).includes('/dsh-voice-reply/')) {
    const url = String(message.params.response.url)
    if (!url.endsWith('/status')) network.push({ at: Date.now(), kind: 'response', status: message.params.response.status, url })
  }
})

try {
  await authenticatePage(page, URL)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await page.waitFor("document.body.innerText.includes('Рабочие пространства')", { timeoutMs: 30000, label: 'sidebar' })
  await sleep(1500)

  /* ---- new session + prompt ---- */
  const newSession = await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Новая сессия');
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('new-session button clicked', newSession === true)
  await page.waitFor(`document.querySelector('[contenteditable="true"]') !== null`, { timeoutMs: 15000, label: 'composer editor' })
  await page.evaluate(`(() => { document.querySelector('[contenteditable="true"]').focus(); return true; })()`)
  await page.send('Input.insertText', { text: 'Ответь одним коротким предложением: проверка отложенной озвучки.' })
  await sleep(300)
  const sent = await page.evaluate(`(() => {
    const target = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('Отправить сообщение'));
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('prompt submitted', sent === true)

  /* ---- simulate another tab/window being active ---- */
  const hiddenState = await page.evaluate(`(() => {
    window.__voiceReplyRestore = () => {
      try { delete document.visibilityState; } catch (error) { /* own property may not exist */ }
      try { delete document.hasFocus; } catch (error) { /* own property may not exist */ }
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      return true;
    };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.hasFocus = () => false;
    return { visibility: document.visibilityState, focused: document.hasFocus() };
  })()`)
  check('page emulated as hidden and unfocused', hiddenState.visibility === 'hidden' && hiddenState.focused === false, hiddenState)

  /* ---- wait for the Turn to finish while hidden ---- */
  await page.waitFor("document.querySelectorAll('[data-voice-reply-action]').length > 0", { timeoutMs: 240000, label: 'finalized answer action' })
  await sleep(5000)
  const whileHidden = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-voice-reply-action]')];
    const chip = document.querySelector('[data-voice-reply-chip]');
    return {
      states: nodes.map((n) => n.getAttribute('data-voice-reply-state')),
      chip: chip === null ? null : { state: chip.getAttribute('data-voice-reply-state'), text: (chip.innerText || '').slice(0, 160) },
      visibility: document.visibilityState,
    };
  })()`)
  const speakRequestsWhileHidden = network.filter((entry) => entry.kind === 'request' && entry.url.includes('/speak'))
  check('no speak request while the page is hidden', speakRequestsWhileHidden.length === 0, { network, whileHidden, speakRequestsWhileHidden })
  check('no playback chip while the page is hidden', whileHidden.chip === null, whileHidden)
  check('speaker action stays idle while hidden', whileHidden.states.every((state) => state === 'idle'), whileHidden)
  await page.screenshot(path.join(ARTIFACTS, 'e2e-deferred-hidden.png'))

  /* ---- return to the tab: the answer should start speaking ---- */
  const restoredAt = Date.now()
  await page.evaluate(`(() => { window.__voiceReplyRestore(); return true; })()`)
  const started = await page
    .waitFor(`document.querySelector('[data-voice-reply-chip]')?.getAttribute('data-voice-reply-state') === 'playing'`, {
      timeoutMs: 30000,
      label: 'speech after return',
    })
    .then(() => true)
    .catch(() => false)
  const speakAfterReturn = network.filter((entry) => entry.kind === 'request' && entry.url.includes('/speak') && entry.at >= restoredAt)
  check('answer starts speaking after returning to the tab', started, { speakAfterReturn })
  check('speak request happened only after the return', speakAfterReturn.length > 0, { speakAfterReturn })
  const audioServed = network.some((entry) => entry.kind === 'response' && entry.url.includes('/audio/') && entry.status === 200 && entry.at >= restoredAt)
  check('audio is served after the return', audioServed, network)
  await page.screenshot(path.join(ARTIFACTS, 'e2e-deferred-playing.png'))
  const finished = await page
    .waitFor(`document.querySelector('[data-voice-reply-chip]') === null`, { timeoutMs: 60000, label: 'deferred playback completion' })
    .then(() => true)
    .catch(() => false)
  check('deferred playback finishes', finished)
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-deferred-failure.png'))
  } catch {
    /* ignore */
  }
} finally {
  const summary = { ok: failures.length === 0, failures, checks, network, console: page.consoleMessages.slice(-40), exceptions: page.exceptions.slice(-20) }
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-deferred-report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  page.close()
  closeBrowser(browser)
}

if (failures.length > 0) process.exitCode = 1
