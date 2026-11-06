/**
 * speech-to-text-yandex — DSH-провайдер распознавания речи через Yandex SpeechKit.
 *
 * Плагин регистрирует в сервисе `speechToText` распознаватель `yandex-speechkit`
 * (location: 'cloud'), поэтому встроенный микрофон Web-UI работает с облаком
 * ровно так же, как с локальным SenseVoice: выбор провайдера и языка — в
 * настройках Voice input, аудио уходит на Yandex STT, текст вставляется в черновик.
 *
 * API: синхронное распознавание SpeechKit REST v1
 *   POST https://stt.api.cloud.yandex.net/speech/v1/stt:recognize
 *   Authorization: Api-Key <key>          (или Bearer <IAM> + folderId)
 *   ?lang=ru-RU&format=lpcm&sampleRateHertz=16000&topic=general
 *   тело: сырой PCM16 LE mono 16 kHz БЕЗ WAV-заголовка
 * Ограничения одного запроса: ≤ 30 с и ≤ 1 МБ, поэтому аудио режется на куски
 * (по умолчанию 25 с, максимум 28 с) по самому тихому участку у границы, а
 * результаты склеиваются в порядке следования.
 *
 * ВАЖНО: плагин ОДНОФАЙЛОВЫЙ (без относительных импортов) — так его грузит
 * HMR/loader локального профиля. Зависимостей нет, только node:builtins.
 *
 * Конфигурация: plugin-config.json рядом с плагином (правится без перезапуска,
 * файл перечитывается на каждый запрос) + необязательные поля из
 * cordis.patch.yml (имеют приоритет) + переменные окружения для секретов:
 * YANDEX_STT_API_KEY, YANDEX_STT_FOLDER_ID, YANDEX_STT_IAM_TOKEN (и
 * совместимые YANDEX_SPEECHKIT_* / YC_*). Пустое поле в файле → берётся env;
 * env приоритетнее файла.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'speech-to-text-yandex';
export const inject = ['speechToText'];

const PROVIDER_ID = 'yandex-speechkit';
const PROVIDER_NAME = 'Yandex SpeechKit';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
const MAX_API_SECONDS = 28; // запас к лимиту 30 с
const MAX_API_BYTES = 900 * 1024; // запас к лимиту 1 МБ
const DEFAULT_ENDPOINT = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';

/**
 * Языки, которые принимает провайдер (короткие коды для UI).
 * `auto` — реальное автоопределение языка SpeechKit: проверено живыми запросами,
 * английская и русская речь распознаются без указания языка.
 */
const LANGUAGES = [
  'auto', 'ru', 'en', 'de', 'fr', 'es', 'it', 'pl', 'tr',
  'kk', 'uz', 'he', 'nl', 'fi', 'pt', 'pt-br', 'sv',
];

/** Короткий код UI → код SpeechKit. */
const LANGUAGE_MAP = {
  auto: 'auto',
  ru: 'ru-RU',
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  pl: 'pl-PL',
  tr: 'tr-TR',
  kk: 'kk-KZ',
  uz: 'uz-UZ',
  he: 'he-IL',
  nl: 'nl-NL',
  fi: 'fi-FI',
  pt: 'pt-PT',
  'pt-br': 'pt-BR',
  sv: 'sv-SE',
};

const DEFAULTS = {
  endpoint: DEFAULT_ENDPOINT,
  topic: 'general',
  profanityFilter: false,
  rawResults: false,
  chunkSeconds: 25,
  searchBackSeconds: 3,
  minChunkSeconds: 1,
  requestTimeoutMs: 45_000,
  maxAttempts: 3,
  retryBaseMs: 500,
  maxAudioSeconds: 600,
  maxResponseBytes: 64 * 1024,
  debug: true,
  logFile: '.state/events.log',
  logMaxBytes: 512 * 1024,
};

/** Запрос отклонён до обращения к сети (формат аудио, лимиты). */
class SpeechInputError extends Error {}

/** Ошибка SpeechKit/транспорта с признаком, имеет ли смысл повтор. */
class SpeechKitError extends Error {
  constructor(message, { status, code, retryable = false, cause } = {}) {
    super(message);
    this.name = 'SpeechKitError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (cause !== undefined) this.cause = cause;
  }
}

/* ------------------------------------------------------------------ */
/* Конфигурация                                                       */
/* ------------------------------------------------------------------ */

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function booleanOr(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Прочитать plugin-config.json. Битый файл — явная ошибка (иначе провайдер
 * молча работал бы с чужими настройками), отсутствующий — пустой объект.
 * @param {string} pluginDir - каталог плагина.
 * @returns {Record<string, unknown>} разобранная конфигурация.
 */
function readFileConfig(pluginDir) {
  const file = path.join(pluginDir, 'plugin-config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error(`speech-to-text-yandex: не удалось прочитать ${file}: ${error?.message ?? error}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ожидался JSON-объект');
    }
    return parsed;
  } catch (error) {
    throw new Error(`speech-to-text-yandex: ${file} содержит некорректный JSON: ${error?.message ?? error}`);
  }
}

/** Убрать префикс схемы авторизации, если пользователь вставил его вместе с ключом. */
function bareSecret(value) {
  return value.trim().replace(/^(api-key|apikey|bearer)\s+/i, '');
}

/**
 * Собрать действующую конфигурацию: defaults ← plugin-config.json ← env ← patch.
 * @param {string} pluginDir - каталог плагина.
 * @param {Record<string, unknown>} patchConfig - config из cordis.patch.yml.
 * @returns {Record<string, unknown>} нормализованная конфигурация запроса.
 */
function resolveConfig(pluginDir, patchConfig = {}) {
  const file = readFileConfig(pluginDir);
  const env = process.env;
  const pick = (...values) => values.find(nonEmpty);
  const pickAny = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

  const apiKeyRaw = pick(patchConfig.apiKey, env.YANDEX_STT_API_KEY, env.YANDEX_SPEECHKIT_API_KEY, env.YC_API_KEY, file.apiKey);
  const iamTokenRaw = pick(patchConfig.iamToken, env.YANDEX_STT_IAM_TOKEN, env.YANDEX_SPEECHKIT_IAM_TOKEN, env.YC_IAM_TOKEN, file.iamToken);
  const folderId = pick(patchConfig.folderId, env.YANDEX_STT_FOLDER_ID, env.YANDEX_SPEECHKIT_FOLDER_ID, env.YC_FOLDER_ID, file.folderId);

  const authMode = nonEmpty(iamTokenRaw) ? 'iam' : 'api-key';
  const secret = authMode === 'iam' ? bareSecret(iamTokenRaw) : bareSecret(apiKeyRaw ?? '');

  const endpoint = pick(patchConfig.endpoint, file.endpoint) ?? DEFAULTS.endpoint;
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error(`speech-to-text-yandex: некорректный endpoint: ${endpoint}`);
  }
  if (!/^https?:$/.test(endpointUrl.protocol)) {
    throw new Error(`speech-to-text-yandex: endpoint должен быть http(s): ${endpoint}`);
  }

  const chunkSeconds = clampNumber(pickAny(patchConfig.chunkSeconds, file.chunkSeconds), 5, MAX_API_SECONDS, DEFAULTS.chunkSeconds);
  // Минимум куска не может спорить с целевым размером: иначе окно поиска тишины
  // становится отрицательным и обе границы нарушаются.
  const minChunkSeconds = Math.min(
    clampNumber(pickAny(patchConfig.minChunkSeconds, file.minChunkSeconds), 0.2, 10, DEFAULTS.minChunkSeconds),
    chunkSeconds / 2,
  );

  return {
    authMode,
    secret,
    folderId: typeof folderId === 'string' ? folderId.trim() : '',
    endpoint: endpointUrl.href,
    topic: pick(patchConfig.topic, file.topic) ?? DEFAULTS.topic,
    profanityFilter: booleanOr(pickAny(patchConfig.profanityFilter, file.profanityFilter), DEFAULTS.profanityFilter),
    rawResults: booleanOr(pickAny(patchConfig.rawResults, file.rawResults), DEFAULTS.rawResults),
    chunkSeconds,
    searchBackSeconds: clampNumber(pickAny(patchConfig.searchBackSeconds, file.searchBackSeconds), 0, 10, DEFAULTS.searchBackSeconds),
    minChunkSeconds,
    requestTimeoutMs: clampNumber(pickAny(patchConfig.requestTimeoutMs, file.requestTimeoutMs), 250, 300_000, DEFAULTS.requestTimeoutMs),
    maxAttempts: Math.round(clampNumber(pickAny(patchConfig.maxAttempts, file.maxAttempts), 1, 6, DEFAULTS.maxAttempts)),
    retryBaseMs: clampNumber(pickAny(patchConfig.retryBaseMs, file.retryBaseMs), 0, 10_000, DEFAULTS.retryBaseMs),
    maxAudioSeconds: clampNumber(pickAny(patchConfig.maxAudioSeconds, file.maxAudioSeconds), 1, 3600, DEFAULTS.maxAudioSeconds),
    maxResponseBytes: clampNumber(pickAny(patchConfig.maxResponseBytes, file.maxResponseBytes), 1024, 1024 * 1024, DEFAULTS.maxResponseBytes),
    debug: booleanOr(pickAny(patchConfig.debug, file.debug), DEFAULTS.debug),
    logFile: pick(patchConfig.logFile, file.logFile) ?? DEFAULTS.logFile,
    logMaxBytes: clampNumber(pickAny(patchConfig.logMaxBytes, file.logMaxBytes), 4096, 16 * 1024 * 1024, DEFAULTS.logMaxBytes),
  };
}

/** Проверить, что секрет вообще задан; без него сеть не трогаем. */
function assertCredentials(config) {
  if (nonEmpty(config.secret)) return;
  throw new SpeechKitError(
    'Yandex SpeechKit не настроен: задайте apiKey (или iamToken) в ' +
      'plugin-config.json рядом с плагином (файл перечитывается на каждый запрос) либо в ' +
      'переменной окружения YANDEX_STT_API_KEY / YANDEX_STT_IAM_TOKEN (переменные читаются ' +
      'при старте процесса — понадобится перезапуск dsh web).',
    { retryable: false },
  );
}

/* ------------------------------------------------------------------ */
/* Журнал плагина (локальный файл, без аудио и секретов)              */
/* ------------------------------------------------------------------ */

function appendEvent(pluginDir, patchConfig, event) {
  let config;
  try {
    config = resolveConfig(pluginDir, patchConfig);
  } catch {
    config = { debug: true, logFile: DEFAULTS.logFile, logMaxBytes: DEFAULTS.logMaxBytes };
  }
  if (!config.debug) return;
  try {
    const file = path.resolve(pluginDir, config.logFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const info = fs.statSync(file);
      if (info.size > config.logMaxBytes) fs.renameSync(file, `${file}.1`);
    } catch {
      /* файла ещё нет */
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* журнал не должен ломать распознавание */
  }
}

/* ------------------------------------------------------------------ */
/* WAV / PCM                                                          */
/* ------------------------------------------------------------------ */

/**
 * Разобрать канонический WAV браузера: PCM16, mono, 16 kHz.
 * Заголовок читается по чанкам (RIFF может содержать LIST/JUNK/fact),
 * а не «минус 44 байта».
 * @param {Uint8Array|Buffer} audio - байты записи.
 * @param {number} maxAudioSeconds - предохранитель по длительности.
 * @returns {{pcm: Buffer, seconds: number}} PCM без заголовка и длительность.
 */
function parsePcmWav(audio, maxAudioSeconds = DEFAULTS.maxAudioSeconds) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio.buffer ?? audio, audio.byteOffset ?? 0, audio.byteLength ?? audio.length);
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new SpeechInputError('Ожидался WAV-файл (RIFF/WAVE), получены другие данные');
  }
  let format;
  let data;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) throw new SpeechInputError('WAV-файл повреждён: чанк выходит за границу файла');
    if (id === 'fmt ') {
      if (size < 16) throw new SpeechInputError('WAV-файл повреждён: короткий fmt-чанк');
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data' && data === undefined) {
      data = buffer.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (format === undefined) throw new SpeechInputError('WAV-файл повреждён: нет fmt-чанка');
  if (data === undefined) throw new SpeechInputError('WAV-файл повреждён: нет data-чанка');
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new SpeechInputError(
      `Ожидался PCM16 mono WAV, получено: format=${format.audioFormat}, channels=${format.channels}, bits=${format.bitsPerSample}`,
    );
  }
  if (format.sampleRate !== SAMPLE_RATE) {
    throw new SpeechInputError(`Ожидалась частота 16000 Гц, получено ${format.sampleRate} Гц`);
  }
  if (data.length === 0) throw new SpeechInputError('Запись пуста: в WAV нет аудиоданных');
  if (data.length % BYTES_PER_SAMPLE !== 0) throw new SpeechInputError('WAV-файл повреждён: нечётное число байт PCM');
  const seconds = data.length / BYTES_PER_SECOND;
  if (seconds > maxAudioSeconds) {
    throw new SpeechInputError(`Запись длиннее ${maxAudioSeconds} с (${seconds.toFixed(1)} с) — распознавание отклонено`);
  }
  return { pcm: data, seconds };
}

/** Среднеквадратичная амплитуда окна PCM16 (0…1). */
function frameRms(pcm, startSample, sampleCount) {
  let sum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = pcm.readInt16LE((startSample + index) * BYTES_PER_SAMPLE);
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, sampleCount)) / 32768;
}

/**
 * Найти границу реза в пределах [target - searchBack, target] по самому
 * тихому окну 100 мс — так слова реже рвутся пополам.
 * @returns {number} индекс сэмпла границы.
 */
function findQuietSplit(pcm, startSample, targetSample, searchBackSamples, sampleRate) {
  const windowSamples = Math.round(sampleRate * 0.1);
  const from = Math.max(startSample + 1, targetSample - Math.max(0, searchBackSamples));
  let best = targetSample;
  let bestRms = Infinity;
  for (let center = from; center + windowSamples <= targetSample; center += Math.round(sampleRate * 0.05)) {
    const rms = frameRms(pcm, center, windowSamples);
    if (rms < bestRms) {
      bestRms = rms;
      best = center + Math.round(windowSamples / 2);
    }
  }
  return Math.min(targetSample, Math.max(startSample + 1, best));
}

/**
 * Нарезать PCM на куски, каждый из которых укладывается в лимиты одного
 * запроса SpeechKit (≤ 28 с и ≤ 900 КБ).
 * @param {Buffer} pcm - сырой PCM16 mono 16 kHz.
 * @param {Record<string, unknown>} config - действующая конфигурация.
 * @returns {{pcm: Buffer, seconds: number}[]} куски в порядке следования.
 */
function splitPcm(pcm, config) {
  const totalSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const maxSamples = Math.min(Math.floor(MAX_API_SECONDS * SAMPLE_RATE), Math.floor(MAX_API_BYTES / BYTES_PER_SAMPLE));
  const chunkSamples = Math.min(Math.floor(config.chunkSeconds * SAMPLE_RATE), maxSamples);
  const minSamples = Math.max(1, Math.floor(config.minChunkSeconds * SAMPLE_RATE));
  const searchBackSamples = Math.floor(config.searchBackSeconds * SAMPLE_RATE);

  const parts = [];
  let start = 0;
  while (start < totalSamples) {
    const remaining = totalSamples - start;
    if (remaining <= maxSamples) {
      parts.push({ start, end: totalSamples });
      break;
    }
    const target = Math.min(start + chunkSamples, totalSamples);
    const split = findQuietSplit(pcm, start, target, Math.min(searchBackSamples, chunkSamples - minSamples), SAMPLE_RATE);
    const end = split > start && split < target ? split : target;
    parts.push({ start, end });
    start = end;
  }
  return parts.map(({ start: from, end }) => ({
    pcm: pcm.subarray(from * BYTES_PER_SAMPLE, end * BYTES_PER_SAMPLE),
    seconds: (end - from) / SAMPLE_RATE,
  }));
}

/* ------------------------------------------------------------------ */
/* Сеть                                                               */
/* ------------------------------------------------------------------ */

function abortError(reason, fallbackMessage) {
  if (reason instanceof Error) return reason;
  return new Error(fallbackMessage);
}

/** Пауза, прерываемая отменой. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason, 'Speech transcription cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal?.reason, 'Speech transcription cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Текст для пользователя по HTTP-статусу SpeechKit. */
function humanizeError(status, code, message) {
  const detail = message ? `: ${message}` : '';
  switch (status) {
    case 400:
      return `SpeechKit отклонил аудио (400 INVALID_ARGUMENT)${detail}`;
    case 401:
      return (
        'SpeechKit: неверный API-ключ (401 UNAUTHENTICATED). Проверьте apiKey в plugin-config.json ' +
        'и что сервисный аккаунт существует' + detail
      );
    case 403:
      return (
        'SpeechKit: доступ запрещён (403 PERMISSION_DENIED). Выдайте сервисному аккаунту роль ' +
        'ai.speechkit-stt.user на каталог' + detail
      );
    case 429:
      return 'SpeechKit: превышена квота запросов (429 RESOURCE_EXHAUSTED) — попробуйте позже' + detail;
    case 500:
    case 501:
    case 503:
    case 504:
      return `SpeechKit временно недоступен (${status}) — повторите позже${detail}`;
    default:
      return `SpeechKit вернул HTTP ${status}${code ? ` (${code})` : ''}${detail}`;
  }
}

/**
 * Один POST-запрос к SpeechKit с собственным таймаутом.
 * @param {URL} url - endpoint с query-параметрами.
 * @param {object} init - заголовки и тело.
 * @param {AbortSignal|undefined} callerSignal - отмена вызывающей стороны.
 * @param {number} timeoutMs - максимальное время ожидания ответа.
 * @returns {Promise<Response>} ответ сервера.
 */
async function fetchWithTimeout(url, init, callerSignal, timeoutMs) {
  if (callerSignal?.aborted) throw abortError(callerSignal.reason, 'Speech transcription cancelled');
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortError(callerSignal?.reason, 'Speech transcription cancelled'));
  callerSignal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('SpeechKit request timed out'));
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (callerSignal?.aborted) throw abortError(callerSignal.reason, 'Speech transcription cancelled');
    if (timedOut) throw new SpeechKitError(`SpeechKit не ответил за ${timeoutMs} мс`, { retryable: true, cause: error });
    throw new SpeechKitError(`Сетевая ошибка при обращении к SpeechKit: ${error?.message ?? error}`, { retryable: true, cause: error });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Распознать один кусок PCM через SpeechKit REST v1 (с ретраями на 429/5xx).
 * @param {Buffer} pcm - кусок PCM16 mono 16 kHz без заголовка.
 * @param {Record<string, unknown>} config - действующая конфигурация.
 * @param {AbortSignal|undefined} signal - отмена.
 * @returns {Promise<string>} распознанный текст (возможно пустой).
 */
async function recognizeChunk(pcm, config, signal) {
  const lang = LANGUAGE_MAP[config.language];
  if (lang === undefined) {
    throw new SpeechInputError(`Язык "${config.language}" не поддерживается Yandex SpeechKit`);
  }
  const url = new URL(config.endpoint);
  url.searchParams.set('lang', lang);
  url.searchParams.set('format', 'lpcm');
  url.searchParams.set('sampleRateHertz', String(SAMPLE_RATE));
  if (nonEmpty(config.topic)) url.searchParams.set('topic', String(config.topic));
  if (config.profanityFilter) url.searchParams.set('profanityFilter', 'true');
  if (config.rawResults) url.searchParams.set('rawResults', 'true');

  const headers = { 'content-type': 'application/octet-stream' };
  if (config.authMode === 'iam') {
    headers.authorization = `Bearer ${config.secret}`;
    if (nonEmpty(config.folderId)) url.searchParams.set('folderId', config.folderId);
  } else {
    headers.authorization = `Api-Key ${config.secret}`;
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        { method: 'POST', headers, body: pcm },
        signal,
        config.requestTimeoutMs,
      );
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > config.maxResponseBytes) {
        throw new SpeechKitError('SpeechKit вернул слишком большой ответ', { retryable: true });
      }
      let payload = null;
      try {
        payload = raw === '' ? null : JSON.parse(raw);
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const code = payload?.error_code ?? payload?.code ?? '';
        const message = payload?.error_message ?? payload?.message ?? raw.slice(0, 300);
        throw new SpeechKitError(humanizeError(response.status, code, message), {
          status: response.status,
          code,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      if (payload === null) {
        throw new SpeechKitError('SpeechKit вернул ответ, который не удалось разобрать как JSON', { retryable: true });
      }
      return typeof payload.result === 'string' ? payload.result : '';
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason, 'Speech transcription cancelled');
      const retryable = error instanceof SpeechKitError ? error.retryable : false;
      if (!retryable || attempt >= config.maxAttempts) throw error;
      await sleep(config.retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 150), signal);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Провайдер                                                          */
/* ------------------------------------------------------------------ */

/**
 * Создать SpeechProvider для сервиса `speechToText`.
 * @param {object} options - каталог плагина и config из cordis.patch.yml.
 * @returns {object} провайдер с info и transcribe.
 */
export function createProvider({ pluginDir, patchConfig = {}, logger } = {}) {
  const info = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    location: 'cloud',
    languages: Object.freeze([...LANGUAGES]),
  };

  return {
    info,
    /**
     * Распознать одну запись. Куски уходят последовательно, текст склеивается
     * в порядке аудио; отмена прерывает текущий запрос и очередь.
     * @param {{audio: Uint8Array, language: string}} input - WAV и язык.
     * @param {AbortSignal} signal - отмена вызывающей стороны.
     * @returns {Promise<{text: string, audioSeconds: number, inferenceSeconds: number}>} результат.
     */
    async transcribe(input, signal) {
      const startedAt = performance.now();
      const config = resolveConfig(pluginDir, patchConfig);
      config.language = input.language;
      assertCredentials(config);

      const { pcm, seconds } = parsePcmWav(input.audio, config.maxAudioSeconds);
      if (LANGUAGE_MAP[input.language] === undefined) {
        throw new SpeechInputError(`Язык "${input.language}" не поддерживается Yandex SpeechKit`);
      }
      const chunks = splitPcm(pcm, config);

      const texts = [];
      try {
        for (const chunk of chunks) {
          if (signal?.aborted) throw abortError(signal.reason, 'Speech transcription cancelled');
          const text = await recognizeChunk(chunk.pcm, config, signal);
          if (nonEmpty(text)) texts.push(text.trim());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendEvent(pluginDir, patchConfig, {
          event: 'transcribe.error',
          providerId: PROVIDER_ID,
          language: config.language,
          audioSeconds: Number(seconds.toFixed(2)),
          chunks: chunks.length,
          inferenceSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
          status: error instanceof SpeechKitError ? error.status : undefined,
          code: error instanceof SpeechKitError ? error.code : undefined,
          message: message.slice(0, 500),
        });
        logger?.warn?.(`[speech-to-text-yandex] ${message}`);
        throw error;
      }

      const text = texts.join(' ').replace(/\s+/g, ' ').trim();
      const inferenceSeconds = (performance.now() - startedAt) / 1000;
      appendEvent(pluginDir, patchConfig, {
        event: 'transcribe.ok',
        providerId: PROVIDER_ID,
        language: config.language,
        lang: LANGUAGE_MAP[config.language],
        audioSeconds: Number(seconds.toFixed(2)),
        chunks: chunks.length,
        inferenceSeconds: Number(inferenceSeconds.toFixed(2)),
        chars: text.length,
      });
      return { text, audioSeconds: seconds, inferenceSeconds };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Подключение к DSH                                                  */
/* ------------------------------------------------------------------ */

/**
 * Зарегистрировать облачный распознаватель в `speechToText`.
 * Подготовка ресурсов не нужна: preview-состояние провайдера — `ready`.
 * @param {object} ctx - Cordis-контекст с сервисом speechToText.
 * @param {Record<string, unknown>} config - config из cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  const patchConfig = config && typeof config === 'object' ? config : {};
  const provider = createProvider({ pluginDir, patchConfig, logger: ctx.logger });

  ctx.effect(() => {
    appendEvent(pluginDir, patchConfig, { event: 'activate', providerId: PROVIDER_ID });
    let unregister;
    try {
      unregister = ctx.speechToText.register(provider);
      appendEvent(pluginDir, patchConfig, {
        event: 'provider.registered',
        providerId: PROVIDER_ID,
        languages: provider.info.languages.length,
      });
    } catch (error) {
      appendEvent(pluginDir, patchConfig, {
        event: 'provider.register-failed',
        providerId: PROVIDER_ID,
        message: String(error?.message ?? error).slice(0, 500),
      });
      throw error;
    }
    return async () => {
      appendEvent(pluginDir, patchConfig, { event: 'dispose', providerId: PROVIDER_ID });
      await unregister();
    };
  });
}

/** Внутренности для автотестов (вне плагина не используются). */
export const testables = {
  parsePcmWav,
  splitPcm,
  resolveConfig,
  recognizeChunk,
  LANGUAGE_MAP,
  LANGUAGES,
  PROVIDER_ID,
  SpeechInputError,
  SpeechKitError,
};
