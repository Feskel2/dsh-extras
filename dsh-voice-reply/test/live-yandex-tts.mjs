#!/usr/bin/env node
/**
 * Live (manual) probe for the Yandex SpeechKit TTS v1 API.
 *
 * This is NOT part of the unit suite: it makes a real network call and needs
 * the credentials from `plugin-config.json`. Run it by hand:
 *
 *   node test/live-yandex-tts.mjs
 *   node test/live-yandex-tts.mjs --text "Проверка" --voice alena
 *
 * It reads `<plugin dir>/plugin-config.json` (apiKey / iamToken / folderId /
 * endpoint / voice / lang / format / speed), synthesizes one short Russian
 * phrase to an mp3 file inside `os.tmpdir()`, and prints the result.
 *
 * Expected today: the existing API key was issued for STT only
 * (`yc.ai.speechkitStt.execute`), so TTS answers 401 Permission denied. That is
 * a credentials scope problem, not a plugin bug — the probe prints a clear
 * diagnosis and exits with code 2. Exit codes: 0 success, 1 config/usage
 * problem, 2 Yandex/network failure (includes the 401 case).
 */

import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENDPOINT, DEFAULT_FORMAT, DEFAULT_LANG, DEFAULT_SPEED, DEFAULT_VOICE, TtsError, extForFormat, synthesizeChunk } from '../lib/yandex-tts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(HERE, '..', 'plugin-config.json');
const DEFAULT_TEXT = 'Привет! Это проверка синтеза речи через Yandex SpeechKit в плагине голосовых ответов.';

/**
 * Read `plugin-config.json`; throws a friendly error when it is missing.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function readPluginConfig() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (error) {
    throw new Error(`Не удалось прочитать ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('конфиг не является JSON-объектом');
    return parsed;
  } catch (error) {
    throw new Error(`Некорректный JSON в ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pick a string config value with a fallback for blank/missing entries.
 *
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function configValue(config, key, fallback = '') {
  const value = config[key];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Parse `--key value` / `--key=value` command-line options.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const body = argument.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      options[body.slice(0, equals)] = body.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[body] = next;
        index += 1;
      } else {
        options[body] = 'true';
      }
    }
  }
  return options;
}

/**
 * Mask a secret so the probe never prints keystream material to logs.
 *
 * @param {string} secret
 * @returns {string}
 */
function maskSecret(secret) {
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} симв.)`;
}

/** @param {string} message */
function printHeader(message) {
  process.stdout.write(`${message}\n`);
}

/** @param {string} label @param {string} value */
function printKeyValue(label, value) {
  process.stdout.write(`  ${label.padEnd(14)} ${value}\n`);
}

/**
 * Explain a 401 response: the usual cause is an STT-scoped key.
 *
 * @param {TtsError} error
 * @param {Record<string, unknown>} config
 */
function printAuthDiagnosis(error, config) {
  if (error.status === 401) {
    printHeader('');
    printHeader('ДИАГНОЗ: 401 Unauthorized — ключ не имеет доступа к синтезу речи.');
    printHeader('Скорее всего, API-ключ создан для распознавания речи (STT, скоуп');
    printHeader('yc.ai.speechkitStt.execute) и у него нет скоупа синтеза речи');
    printHeader('yc.ai.speechkitTts.execute.');
    printHeader('');
    printHeader('Что делать:');
    printHeader('  1. Yandex Cloud → Identity and Access Management → Сервисные аккаунты');
    printHeader('     → создать/выбрать аккаунт с ролью ai.speechkit-tts.user на каталоге;');
    printHeader('  2. выпустить для него API-ключ со скоупом yc.ai.speechkitTts.execute');
    printHeader('     (или IAM-токен + folderId);');
    printHeader('  3. вписать apiKey (или iamToken/folderId) в plugin-config.json плагина');
    printHeader(`     ${CONFIG_PATH};`);
    printHeader('  4. повторить: node test/live-yandex-tts.mjs');
    printHeader('');
    printHeader('Это ожидаемое поведение до замены ключа, а не ошибка кода плагина.');
    const apiKey = configValue(config, 'apiKey');
    if (apiKey !== '') printHeader(`Текущий ключ в конфиге: ${maskSecret(apiKey)}`);
    return;
  }
  if (error.status === 403) {
    printHeader('');
    printHeader('ДИАГНОЗ: 403 Forbidden — сервисному аккаунту не хватает роли.');
    printHeader('Назначьте роль ai.speechkit-tts.user на каталог (folderId) в Yandex Cloud IAM.');
  }
}

/** @returns {Promise<void>} */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  printHeader('Yandex SpeechKit TTS — live probe (ручная проверка, не входит в unit-тесты)');

  let config;
  try {
    config = await readPluginConfig();
  } catch (error) {
    printHeader(`ОШИБКА КОНФИГА: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const apiKey = configValue(config, 'apiKey');
  const iamToken = configValue(config, 'iamToken');
  const folderId = configValue(config, 'folderId');
  const endpoint = configValue(config, 'endpoint', DEFAULT_ENDPOINT);
  const text = args.text || DEFAULT_TEXT;
  const voice = args.voice || configValue(config, 'voice', DEFAULT_VOICE);
  const lang = args.lang || configValue(config, 'lang', DEFAULT_LANG);
  const format = args.format || configValue(config, 'format', DEFAULT_FORMAT);
  const speed = Number(args.speed ?? configValue(config, 'speed', String(DEFAULT_SPEED)));

  printHeader('');
  printHeader(`Конфиг: ${CONFIG_PATH}`);
  printKeyValue('endpoint', endpoint);
  printKeyValue('auth', iamToken !== '' ? 'IAM-токен' : apiKey !== '' ? `API-ключ ${maskSecret(apiKey)}` : 'НЕТ (не настроено)');
  printKeyValue('folderId', folderId !== '' ? folderId : '(не задан)');
  printKeyValue('voice/lang', `${voice} / ${lang}`);
  printKeyValue('format/speed', `${format} / ${speed}`);
  printKeyValue('text', `${text.length} симв.: «${text.length > 60 ? `${text.slice(0, 60)}…` : text}»`);

  if (apiKey === '' && iamToken === '') {
    printHeader('');
    printHeader('ОШИБКА: в plugin-config.json нет ни apiKey, ни iamToken — синтез невозможен.');
    printHeader('Впишите TTS-scoped apiKey (скоуп yc.ai.speechkitTts.execute) и повторите запуск.');
    process.exitCode = 1;
    return;
  }

  printHeader('');
  printHeader('Синтез…');
  const startedAt = Date.now();
  let result;
  try {
    result = await synthesizeChunk({
      text,
      voice,
      lang,
      format,
      speed,
      apiKey: apiKey || undefined,
      iamToken: iamToken || undefined,
      folderId: folderId || undefined,
      endpoint,
      timeoutMs: 20000,
      maxAttempts: 2,
    });
  } catch (error) {
    if (!(error instanceof TtsError)) {
      printHeader(`НЕОЖИДАННАЯ ОШИБКА: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exitCode = 2;
      return;
    }
    printHeader(`ОШИБКА: ${error.message}`);
    printKeyValue('code', error.code);
    printKeyValue('status', String(error.status ?? '—'));
    printKeyValue('retryable', String(error.retryable));
    if (error.detail !== '') printKeyValue('detail', error.detail);
    if (error.hint !== '') printKeyValue('hint', error.hint);
    printAuthDiagnosis(error, config);
    process.exitCode = 2;
    return;
  }

  const extension = extForFormat(format);
  const outputPath = path.join(os.tmpdir(), `dsh-voice-reply-live-${Date.now()}.${extension}`);
  await writeFile(outputPath, result.audio);

  printHeader('');
  printHeader('УСПЕХ');
  printKeyValue('status', String(result.status));
  printKeyValue('mime', result.mime);
  printKeyValue('bytes', `${result.bytes} байт`);
  printKeyValue('chars', `${text.length} симв.`);
  printKeyValue('elapsed', `${Date.now() - startedAt} мс`);
  printKeyValue('файл', outputPath);
  printHeader(`Откройте файл в любом плеере: ${outputPath}`);
}

main().catch((error) => {
  process.stderr.write(`FATAL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
