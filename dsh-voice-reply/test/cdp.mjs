/**
 * Minimal Chrome DevTools Protocol helper for DSH Web UI checks.
 *
 * No third-party dependencies: Node's global `fetch`/`WebSocket` drive a
 * disposable headless Chrome profile against the local GUI URL. Used by the
 * Lead for visual/E2E verification of the dsh-voice-reply plugin; not part of
 * the shipped plugin runtime.
 */
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Defaults for the local Web GUI. */
export const DEFAULT_APP_URL = 'http://127.0.0.1:3080'

/** Known Chrome/Edge locations on Windows. */
export const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

/**
 * Sleep for a moment.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the pause.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Find a browser executable.
 * @returns {string} absolute path.
 * @throws {Error} when none exists.
 */
export function findBrowser() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (found === undefined) throw new Error('Chrome/Edge not found')
  return found
}

/**
 * Launch a disposable headless browser with remote debugging enabled.
 * @param {{ port?: number, width?: number, height?: number, headless?: boolean }} [options] - launch options.
 * @returns {Promise<{ process: import('node:child_process').ChildProcess, userDataDir: string, port: number }>} handle.
 */
export async function launchBrowser(options = {}) {
  const port = options.port ?? 9333
  const width = options.width ?? 1440
  const height = options.height ?? 1000
  const headless = options.headless !== false
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-reply-e2e-'))
  const args = [
    headless ? '--headless=new' : '--start-maximized',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`,
    'about:blank',
  ]
  const child = spawn(findBrowser(), args, { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + 20000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error('headless browser did not expose the DevTools endpoint')
    }
    await sleep(200)
  }
  return { process: child, userDataDir, port }
}

/**
 * Best-effort teardown of a launched browser and its temporary profile.
 * @param {{ process: import('node:child_process').ChildProcess, userDataDir: string }} handle - launch result.
 * @returns {void}
 */
export function closeBrowser(handle) {
  try {
    handle.process.kill()
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(handle.userDataDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * One page CDP session with request/response plumbing and collected events.
 */
export class Page {
  /**
   * @param {WebSocket} ws - debugger socket.
   */
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.consoleMessages = []
    this.exceptions = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry !== undefined) {
          this.pending.delete(message.id)
          if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
          else entry.resolve(message.result)
        }
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type))
          .join(' ')
        this.consoleMessages.push({ type: message.params.type, text })
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'exception')
      } else if (message.method === 'Log.entryAdded') {
        this.consoleMessages.push({ type: `log:${message.params.entry.level}`, text: message.params.entry.text })
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  /**
   * Send one CDP command.
   * @param {string} method - CDP method.
   * @param {Record<string, unknown>} [params] - parameters.
   * @returns {Promise<any>} command result.
   */
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Subscribe to raw CDP events.
   * @param {(message: any) => void} listener - event listener.
   * @returns {() => void} unsubscribe.
   */
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Enable the domains used by the checks. */
  async enable() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Log.enable')
    await this.send('Network.enable')
    try {
      // Headless windows are not OS-focused; emulate focus so the plugin's
      // "only speak while the page is active" gate behaves like a real user tab.
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    } catch {
      /* optional domain */
    }
    try {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      })
    } catch {
      /* optional */
    }
  }

  /**
   * Evaluate a JavaScript expression in the page.
   * @param {string} expression - expression; may be an async IIFE.
   * @param {{ awaitPromise?: boolean, returnByValue?: boolean }} [options] - evaluation options.
   * @returns {Promise<any>} the value.
   */
  async evaluate(expression, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result?.value
  }

  /**
   * Poll a page predicate until it becomes truthy.
   * @param {string} expression - expression returning a truthy value.
   * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options] - wait options.
   * @returns {Promise<any>} the truthy value.
   */
  async waitFor(expression, options = {}) {
    const timeoutMs = options.timeoutMs ?? 20000
    const intervalMs = options.intervalMs ?? 200
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await this.evaluate(expression).catch(() => undefined)
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${options.label ?? expression.slice(0, 80)}`)
      await sleep(intervalMs)
    }
  }

  /**
   * Capture a screenshot PNG.
   * @param {string} file - destination path.
   * @returns {Promise<string>} the path written.
   */
  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }

  /** Close the page socket. */
  close() {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Local browser auth (disposable headless profile)                   */
/* ------------------------------------------------------------------ */

/**
 * Base64url-encode a byte buffer without padding (matches DSH's own encoding).
 * @param {Buffer} value - bytes.
 * @returns {string} base64url text.
 */
function base64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Decode base64url text and verify it round-trips.
 * @param {string} value - base64url text.
 * @returns {Buffer|undefined} bytes, or undefined when malformed.
 */
function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return base64url(decoded) === value ? decoded : undefined
}

/**
 * Read the browser-session signing secret DSH stored in `.credentials.yaml`.
 * The secret is returned only in memory and never printed. The parser is
 * intentionally minimal (this file is a flat `records:` map of grants).
 * @param {string} [home] - DSH home directory.
 * @returns {Buffer} 32-byte secret.
 */
export function readBrowserSessionSecret(home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')) {
  const file = path.join(home, '.credentials.yaml')
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/u)
  const keyIndex = lines.findIndex((line) => /^\s{2}client-connection\/browser-session:\s*$/u.test(line))
  if (keyIndex === -1) throw new Error('client-connection/browser-session record not found')
  const block = []
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s{0,3}\S/u.test(line) && line.trim() !== '') break
    if (/^\s{2}[A-Za-z0-9._-]+\//u.test(line)) break
    block.push(line)
  }
  const secretLine = block.find((line) => /^\s+secret:\s*\S+/u.test(line))
  if (secretLine === undefined) throw new Error('browser-session secret field not found')
  const value = secretLine.replace(/^\s+secret:\s*/u, '').trim()
  const secret = decodeBase64url(value)
  if (secret === undefined || secret.byteLength !== 32) throw new Error('browser-session secret is malformed')
  return secret
}

/**
 * Mint the signed `dsh-auth-*` cookie for one loopback authority, exactly as
 * the Host's browser-auth module does after a valid launch-token exchange.
 * @param {{ url?: string, home?: string, maxAgeDays?: number }} [options] - cookie options.
 * @returns {{ name: string, value: string, expiresAt: number }} cookie material.
 */
export function mintAuthCookie(options = {}) {
  const url = new URL(options.url ?? DEFAULT_APP_URL)
  const authority = url.host
  const secret = readBrowserSessionSecret(options.home)
  const name = `dsh-auth-${base64url(crypto.createHash('sha256').update(authority).digest())}`
  const issuedAt = Date.now()
  const expiresAt = issuedAt + (options.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000
  const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = crypto.createHmac('sha256', secret).update(body).digest()
  return { name, value: `v1.${body}.${base64url(signature)}`, expiresAt }
}

/**
 * Install the browser-session cookie into the connected page.
 * @param {Page} page - connected page.
 * @param {string} url - GUI origin.
 * @returns {Promise<void>} completion.
 */
export async function authenticatePage(page, url = DEFAULT_APP_URL) {
  const cookie = mintAuthCookie({ url })
  const target = new URL(url)
  await page.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    domain: target.hostname,
    path: '/',
    httpOnly: true,
    secure: target.protocol === 'https:',
    sameSite: 'Strict',
    expires: Math.floor(cookie.expiresAt / 1000),
  })
}

/**
 * Open one page target and connect to it.
 * @param {number} port - DevTools port.
 * @param {string} url - initial URL.
 * @returns {Promise<Page>} connected page.
 */
export async function openPage(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!response.ok) throw new Error(`could not open a page target: HTTP ${response.status}`)
  const target = await response.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('debugger socket failed')), { once: true })
  })
  const page = new Page(ws)
  await page.enable()
  return page
}
