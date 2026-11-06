/**
 * Test-only ESM resolver hook: the plugin is installed by DSH, whose Loader
 * resolves `@deepseek-ai/*` bare imports against the dsh installation. Plain
 * `node` has no such mapping, so the host test registers this hook to fall back
 * to the dsh installation's packaged modules when normal resolution fails.
 * Not part of the shipped plugin.
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const DSH_PACKAGES = 'D:/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/**
 * Resolve bare `@deepseek-ai/*` imports against the dsh installation when the
 * ordinary node resolution cannot find them.
 * @param {string} specifier - import specifier.
 * @param {object} context - resolver context.
 * @param {Function} nextResolve - previous resolver.
 * @returns {Promise<object>} resolution.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const match = /^@deepseek-ai\/([^/]+)$/u.exec(specifier)
    if (match === null) throw error
    const name = match[1]
    for (const entry of ['lib/index.mjs', 'lib/index.js', 'index.js', 'lib/index.cjs']) {
      const file = path.join(DSH_PACKAGES, name, entry)
      if (!existsSync(file)) continue
      return nextResolve(pathToFileURL(file).href, context)
    }
    throw error
  }
}
