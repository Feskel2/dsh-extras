/**
 * Settings-row E2E for dsh-voice-reply: opens Settings → General through the
 * account menu, verifies the auto-speak row, toggles it, checks the host route
 * POST /dsh-voice-reply/preferences and the status value, then restores the
 * original value. Creates no Session.
 *
 * Run: node test/e2e-settings.mjs
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
  if (message.method === 'Network.responseReceived' && String(message.params.response.url).includes('/dsh-voice-reply/preferences')) {
    network.push({ kind: 'response', status: message.params.response.status, url: message.params.response.url })
  }
  if (message.method === 'Network.requestWillBeSent' && String(message.params.request.url).includes('/dsh-voice-reply/preferences')) {
    network.push({ kind: 'request', method: message.params.request.method, url: message.params.request.url, postData: message.params.request.postData })
  }
})

try {
  await authenticatePage(page, URL)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor("document.title === 'DeepSeek Harness'", { timeoutMs: 30000, label: 'app title' })
  await sleep(1500)

  const statusBefore = await page.evaluate(`(async () => (await fetch('/dsh-voice-reply/status')).json())()`)
  check('status before toggle', typeof statusBefore?.autoSpeak === 'boolean', statusBefore)

  /* ---- account menu → Settings ---- */
  const menuOpened = await page.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const target = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('Меню аккаунта'));
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('account menu opened', menuOpened === true)
  await sleep(500)
  const settingsClicked = await page.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], button')];
    const target = items.find((el) => (el.innerText || '').trim().startsWith('Настройки'));
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('Settings entry clicked', settingsClicked === true, settingsClicked)
  await page.waitFor("document.body.innerText.includes('Настройки')", { timeoutMs: 10000, label: 'settings dialog' })
  const generalTab = await page.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="tab"], button')];
    const target = items.find((el) => (el.innerText || '').trim() === 'Общие');
    if (target === undefined) return false;
    target.click();
    return true;
  })()`)
  check('General tab opened', generalTab === true)
  await sleep(600)
  const rowFound = await page
    .waitFor("document.querySelector('[data-voice-reply-settings]') !== null", { timeoutMs: 15000, label: 'auto-speak settings row' })
    .then(() => true)
    .catch(() => false)
  check('auto-speak row exists in Settings → General', rowFound)
  if (!rowFound) {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-settings-missing.png'))
  } else {
    const row = await page.evaluate(`(() => {
      const root = document.querySelector('[data-voice-reply-settings]');
      const sw = root === null ? null : root.querySelector('[role="switch"]');
      return {
        text: root === null ? '' : (root.innerText || '').slice(0, 240),
        checked: sw === null ? null : sw.getAttribute('aria-checked'),
        disabled: sw === null ? null : sw.disabled === true,
      };
    })()`)
    check('row renders title/description', /озвуч/i.test(row.text), row)
    check('row switch has a boolean state', row.checked === 'true' || row.checked === 'false', row)

    const initialChecked = row.checked === 'true'
    const toggled = await page.evaluate(`(() => {
      const sw = document.querySelector('[data-voice-reply-settings] [role="switch"]');
      if (sw === null) return false;
      sw.click();
      return true;
    })()`)
    check('switch is clickable', toggled === true)
    await sleep(1500)
    const prefsResponse = network.filter((entry) => entry.kind === 'response').pop()
    check('toggle persists through POST /preferences', prefsResponse?.status === 200, network)
    const statusAfter = await page.evaluate(`(async () => (await fetch('/dsh-voice-reply/status')).json())()`)
    check('status reflects the toggle', statusAfter?.autoSpeak === !initialChecked, { before: statusBefore?.autoSpeak, after: statusAfter?.autoSpeak })
    const switchAfter = await page.evaluate(`(() => {
      const sw = document.querySelector('[data-voice-reply-settings] [role="switch"]');
      return sw === null ? null : sw.getAttribute('aria-checked');
    })()`)
    check('switch shows the accepted value', switchAfter === String(!initialChecked), { initialChecked, switchAfter })
    await page.screenshot(path.join(ARTIFACTS, 'e2e-settings.png'))

    /* restore */
    await page.evaluate(`(() => {
      const sw = document.querySelector('[data-voice-reply-settings] [role="switch"]');
      if (sw !== null && sw.getAttribute('aria-checked') !== ${JSON.stringify(String(initialChecked))}) sw.click();
      return true;
    })()`)
    await sleep(1200)
    const restored = await page.evaluate(`(async () => (await fetch('/dsh-voice-reply/status')).json())()`)
    check('original preference restored', restored?.autoSpeak === initialChecked, restored)
  }
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot(path.join(ARTIFACTS, 'e2e-settings-failure.png'))
  } catch {
    /* ignore */
  }
} finally {
  const summary = { ok: failures.length === 0, failures, checks, network, console: page.consoleMessages.slice(-30), exceptions: page.exceptions.slice(-10) }
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-settings-report.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  page.close()
  closeBrowser(browser)
}

if (failures.length > 0) process.exitCode = 1
