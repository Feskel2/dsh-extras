/**
 * lib/yandex-tts.js — dependency-free Yandex SpeechKit TTS v1 REST client.
 *
 * The module owns three concerns:
 *  1. turning a Markdown assistant answer into text that is pleasant to hear
 *     (`stripMarkdownForSpeech` / `prepareSpeechText`);
 *  2. splitting that text so that every request obeys the real Yandex limits —
 *     at most 5000 characters **and** at most 15 KB for the URL-encoded POST
 *     body (`splitIntoChunks`, `estimateRequestBytes`); Cyrillic expands six
 *     times under URL encoding, so chunking must measure the encoded body, not
 *     the raw character count;
 *  3. calling `https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize`
 *     with retries, a timeout, cancellation, and Russian error messages with
 *     actionable hints (`synthesizeChunk`, `TtsError`).
 *
 * Only `node:` builtins are used. The module performs no network I/O at import
 * time and has no side effects.
 *
 * @module dsh-voice-reply/lib/yandex-tts
 */

import { Buffer } from 'node:buffer';

/** Yandex SpeechKit TTS v1 REST endpoint (POST, form-urlencoded). */
export const DEFAULT_ENDPOINT = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';

/** Default voice (a Russian female voice available in the v1 API). */
export const DEFAULT_VOICE = 'alena';

/** Default language. */
export const DEFAULT_LANG = 'ru-RU';

/** Default response format: mp3 (the API default is oggopus, we prefer mp3). */
export const DEFAULT_FORMAT = 'mp3';

/** Default speaking speed (Yandex accepts 0.1 – 3.0). */
export const DEFAULT_SPEED = 1;

/** Hard Yandex limit: at most 5000 characters of text per request. */
export const MAX_TEXT_CHARS = 5000;

/** Hard Yandex limit: the URL-encoded POST body must not exceed 15 KB. */
export const MAX_BODY_BYTES = 15000;

/** Base delay for exponential backoff between retryable attempts, in ms. */
export const RETRY_BASE_MS = 250;

/**
 * Yandex SpeechKit TTS v1 voices.
 *
 * Only v1 voices are listed: `dasha`, `julia`, `lera`, `masha` and friends are
 * v3-only and must not be offered. `emotions` is present only for the voices
 * where the official documentation lists supported emotions; it is an array of
 * API values (`neutral`, `good`, `evil`, `whisper`, `friendly`).
 *
 * @type {ReadonlyArray<{ id: string, label: string, lang: string, gender: 'F'|'M', emotions?: ReadonlyArray<string> }>}
 */
export const VOICES = Object.freeze([
  Object.freeze({
    id: 'alena',
    label: 'Alena — женский, нейтральный',
    lang: 'ru-RU',
    gender: 'F',
    emotions: Object.freeze(['neutral', 'good']),
  }),
  Object.freeze({
    id: 'filipp',
    label: 'Filipp — мужской, нейтральный',
    lang: 'ru-RU',
    gender: 'M',
  }),
  Object.freeze({
    id: 'ermil',
    label: 'Ermil — мужской, нейтральный',
    lang: 'ru-RU',
    gender: 'M',
    emotions: Object.freeze(['neutral', 'good']),
  }),
  Object.freeze({
    id: 'jane',
    label: 'Jane — женский, нейтральный',
    lang: 'ru-RU',
    gender: 'F',
    emotions: Object.freeze(['neutral', 'good', 'evil']),
  }),
  Object.freeze({
    id: 'omazh',
    label: 'Omazh — женский, нейтральный',
    lang: 'ru-RU',
    gender: 'F',
    emotions: Object.freeze(['neutral', 'evil']),
  }),
  Object.freeze({
    id: 'zahar',
    label: 'Zahar — мужской, нейтральный',
    lang: 'ru-RU',
    gender: 'M',
    emotions: Object.freeze(['neutral', 'good']),
  }),
  Object.freeze({
    id: 'marina',
    label: 'Marina — женский, нейтральный',
    lang: 'ru-RU',
    gender: 'F',
    emotions: Object.freeze(['neutral', 'whisper', 'friendly']),
  }),
  Object.freeze({
    id: 'madi_ru',
    label: 'Madi — мужской, русский',
    lang: 'ru-RU',
    gender: 'M',
  }),
  Object.freeze({
    id: 'amira',
    label: 'Amira — женский, казахский',
    lang: 'kk-KK',
    gender: 'F',
  }),
  Object.freeze({
    id: 'madi',
    label: 'Madi — мужской, казахский',
    lang: 'kk-KK',
    gender: 'M',
  }),
  Object.freeze({
    id: 'nigora',
    label: 'Nigora — женский, узбекский',
    lang: 'uz-UZ',
    gender: 'F',
  }),
  Object.freeze({
    id: 'john',
    label: 'John — мужской, английский',
    lang: 'en-US',
    gender: 'M',
  }),
  Object.freeze({
    id: 'lea',
    label: 'Lea — женский, немецкий',
    lang: 'de-DE',
    gender: 'F',
  }),
]);

/**
 * Supported response formats and the MIME type / file extension used for each.
 *
 * `lpcm` is raw little-endian PCM; the plugin serves it as `audio/wav` because
 * the host HTTP contract only distinguishes `audio/mpeg`, `audio/ogg` and
 * `audio/wav`. mp3 is the plugin default.
 *
 * @type {Readonly<Record<string, Readonly<{ mime: string, ext: string }>>>}
 */
export const FORMATS = Object.freeze({
  mp3: Object.freeze({ mime: 'audio/mpeg', ext: 'mp3' }),
  oggopus: Object.freeze({ mime: 'audio/ogg', ext: 'ogg' }),
  lpcm: Object.freeze({ mime: 'audio/wav', ext: 'wav' }),
});

const VOICE_BY_ID = new Map(VOICES.map((voice) => [voice.id, voice]));
const FORMAT_KEYS = Object.freeze(Object.keys(FORMATS));

/**
 * Error raised for every expected TTS failure (configuration, validation,
 * Yandex HTTP errors, network failures, timeouts and cancellation).
 *
 * `message` is already user-facing Russian text and may be shown in the UI
 * as-is. `hint` is extra actionable guidance. `detail` carries the raw
 * upstream detail (Yandex `error_message`/`message`, or a network error
 * message) for logs — it must not contain secrets.
 *
 * `code` follows the host HTTP API contract:
 * `not-configured | bad-request | unauthorized | forbidden | quota | upstream | timeout | internal`.
 */
export class TtsError extends Error {
  /**
   * @param {string} message User-facing Russian message.
   * @param {object} [options]
   * @param {string} [options.code] Machine-readable error code.
   * @param {number|null} [options.status] HTTP status, when the failure came from Yandex.
   * @param {boolean} [options.retryable] Whether the same request is worth retrying.
   * @param {string} [options.hint] Actionable Russian hint.
   * @param {string} [options.detail] Raw upstream/network detail for logs.
   * @param {unknown} [options.cause] Original error, if any.
   */
  constructor(message, options = {}) {
    const { code = 'internal', status = null, retryable = false, hint = '', detail = '', cause } = options;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TtsError';
    /** @type {string} */
    this.code = code;
    /** @type {number|null} */
    this.status = status ?? null;
    /** @type {boolean} */
    this.retryable = retryable;
    /** @type {string} */
    this.hint = hint;
    /** @type {string} */
    this.detail = detail;
  }
}

/**
 * Convert any value to a string, mapping `null`/`undefined` to an empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Normalize an optional string parameter: trim, and treat blank as absent.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function emptyToUndefined(value) {
  const text = toText(value).trim();
  return text === '' ? undefined : text;
}

/**
 * Count Unicode code points (a 5000-character Yandex budget is counted in
 * characters, not UTF-16 code units, so an emoji costs one character).
 *
 * @param {string} value
 * @returns {number}
 */
function codePointLength(value) {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * UTF-8 byte width of a Unicode code point.
 *
 * @param {number} codePoint
 * @returns {1|2|3|4}
 */
function utf8Width(codePoint) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Characters that the `application/x-www-form-urlencoded` serializer keeps
 * unescaped: ASCII alphanumerics plus `*`, `-`, `.` and `_`.
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
function isFormUnreserved(codePoint) {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) || // 0-9
    (codePoint >= 0x41 && codePoint <= 0x5a) || // A-Z
    (codePoint >= 0x61 && codePoint <= 0x7a) || // a-z
    codePoint === 0x2a || // *
    codePoint === 0x2d || // -
    codePoint === 0x2e || // .
    codePoint === 0x5f // _
  );
}

/**
 * Length of a single code point as it appears URL-form-encoded: a space is `+`
 * (1 char), an unreserved ASCII character stays (1 char), and everything else
 * becomes `%XX` per UTF-8 byte (3 chars per byte — so Cyrillic is 6 chars and
 * an emoji is 12 chars).
 *
 * @param {number} codePoint
 * @returns {number}
 */
function formEncodedCodePointLength(codePoint) {
  if (codePoint === 0x20) return 1;
  if (isFormUnreserved(codePoint)) return 1;
  return utf8Width(codePoint) * 3;
}

/**
 * Build the exact `application/x-www-form-urlencoded` body sent to Yandex.
 *
 * Field order: `text`, `voice`, `lang`, `format`, `speed`, then `emotion` (only
 * when non-empty) and `folderId` (only in IAM mode, provided by the caller).
 *
 * @param {{ text: string, voice: string, lang: string, format: string, speed: number|string, emotion?: string, folderId?: string }} fields
 * @returns {string}
 */
function buildRequestBody(fields) {
  const params = new URLSearchParams();
  params.set('text', toText(fields.text));
  params.set('voice', fields.voice);
  params.set('lang', fields.lang);
  params.set('format', fields.format);
  params.set('speed', String(fields.speed));
  const emotion = emptyToUndefined(fields.emotion);
  if (emotion) params.set('emotion', emotion);
  const folderId = emptyToUndefined(fields.folderId);
  if (folderId) params.set('folderId', folderId);
  return params.toString();
}

/**
 * Estimate the exact byte size of the URL-encoded request body that
 * `synthesizeChunk` will send for the given text and voice settings.
 *
 * The result is an exact measurement (the form body is pure ASCII after
 * percent-encoding, so its byte length equals its string length), not an
 * approximation. Use it to trim chunks or to assert the 15000-byte limit.
 *
 * @param {string} text The chunk text (the `text` form field).
 * @param {object} [options]
 * @param {string} [options.voice='alena'] Voice id that will be sent.
 * @param {string} [options.lang='ru-RU'] Language that will be sent.
 * @param {string} [options.format='mp3'] Format that will be sent.
 * @param {number|string} [options.speed=1] Speed that will be sent.
 * @param {string} [options.emotion] Emotion, only counted when non-empty.
 * @param {string} [options.folderId] Folder id, only counted when non-empty.
 * @returns {number} Body size in bytes.
 */
export function estimateRequestBytes(text = '', options = {}) {
  const {
    voice = DEFAULT_VOICE,
    lang = DEFAULT_LANG,
    format = DEFAULT_FORMAT,
    speed = DEFAULT_SPEED,
    emotion,
    folderId,
  } = options ?? {};
  return Buffer.byteLength(
    buildRequestBody({
      text: toText(text),
      voice: toText(voice) || DEFAULT_VOICE,
      lang: toText(lang) || DEFAULT_LANG,
      format: toText(format) || DEFAULT_FORMAT,
      speed,
      emotion,
      folderId,
    }),
    'utf8',
  );
}

/**
 * Speakable-text cleanup for Markdown assistant answers.
 *
 * Removes fenced and inline code markers (code fence content is dropped, inline
 * code content is kept), images, HTML tags, heading/quote/list/table markers,
 * emphasis and strikethrough marks, horizontal rules and link URLs — link
 * labels are kept and bare URLs become the Russian word `ссылка`. Whitespace
 * is collapsed so the result is one speakable line.
 *
 * @param {unknown} raw Markdown source.
 * @returns {string} Plain text ready for speech, possibly empty.
 */
export function stripMarkdownForSpeech(raw) {
  let text = toText(raw).replace(/\r\n?/g, '\n');

  // HTML comments and fenced code blocks (closed, then unterminated).
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/```[^\n]*\n[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[^\n]*\n[\s\S]*?~~~/g, ' ');
  text = text.replace(/```[\s\S]*$/g, ' ');
  text = text.replace(/~~~[\s\S]*$/g, ' ');

  // Inline code: drop the backticks, keep the content (identifiers/commands
  // are still meaningful when read aloud).
  text = text.replace(/`([^`\n]*)`/g, '$1');
  text = text.replace(/`/g, '');

  // Images are not speakable; markdown links keep their label.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/^[ \t]*\[[^\]]+]:[ \t]*\S+.*$/gm, ' ');

  // Autolinks and bare URLs.
  text = text.replace(/<(?:https?:\/\/|mailto:)[^>]*>/gi, 'ссылка');
  text = text.replace(/(?:https?:\/\/|www\.)[^\s<>()"'`\u0400-\u04FF]+/gi, (match) => {
    const trailing = match.match(/[.,;:!?…]+$/);
    return trailing ? `ссылка${trailing[0]}` : 'ссылка';
  });

  // HTML tags.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

  // Heading / blockquote / list / horizontal-rule markers at line starts.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]*$/gm, ' ');
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, '');
  text = text.replace(/^[ \t]{0,3}(?:-[ \t]*){3,}$/gm, ' ');
  text = text.replace(/^[ \t]{0,3}(?:\*[ \t]*){3,}$/gm, ' ');
  text = text.replace(/^[ \t]{0,3}(?:_[ \t]*){3,}$/gm, ' ');

  // Markdown tables: drop the |---|---| separator row, turn pipes into spaces.
  text = text.replace(/^[ \t]*\|?[ \t:|-]*-{2,}[ \t:|-]*\|?[ \t]*$/gm, ' ');
  text = text.replace(/\|/g, ' ');

  // Emphasis and strikethrough (bold before italic).
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  text = text.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1');
  text = text.replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1');

  // Leftover emphasis markers (keep #, _ and other meaningful ASCII).
  text = text.replace(/[*~]+/g, ' ');

  // Whitespace collapse: the result is a single speakable line.
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate clean speech text to `limit` characters, preferring a sentence end,
 * then a word boundary, and only as a last resort a hard cut.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncateForSpeech(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const minKeep = Math.max(1, Math.floor(limit * 0.6));

  for (let index = slice.length - 1; index >= minKeep; index -= 1) {
    if (/[.!?…]/.test(slice[index])) return slice.slice(0, index + 1).trim();
  }
  for (let index = slice.length - 1; index >= minKeep; index -= 1) {
    if (/\s/.test(slice[index])) return slice.slice(0, index).trim();
  }
  return slice.trim();
}

/**
 * Clean a raw assistant answer and truncate it to `maxChars`.
 *
 * @param {unknown} raw Raw Markdown answer.
 * @param {{ maxChars?: number }} [options]
 * @param {number} [options.maxChars] Maximum characters to keep; omitted or
 *   non-finite means "do not truncate". The plugin default is 4000.
 * @returns {{ text: string, chars: number, truncated: boolean }} `text` is the
 *   cleaned (and maybe truncated) speakable text, `chars` equals `text.length`,
 *   `truncated` is `true` when the source was longer than `maxChars`.
 */
export function prepareSpeechText(raw, { maxChars } = {}) {
  const cleaned = stripMarkdownForSpeech(raw);
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(0, Math.floor(Number(maxChars))) : null;
  if (limit !== null && cleaned.length > limit) {
    const text = truncateForSpeech(cleaned, limit);
    return { text, chars: text.length, truncated: true };
  }
  return { text: cleaned, chars: cleaned.length, truncated: false };
}

/**
 * Find a pleasant cut position for a chunk in `[start, hardEnd)`.
 *
 * Preference order: sentence end (`.`, `!`, `?`, `…` followed by whitespace or
 * the end), then a newline, then any whitespace, then clause punctuation
 * (`,`, `;`, `:`, `—`). The search only looks at the second half of the window
 * so that chunks are not needlessly short; if nothing matches, the hard cut is
 * kept.
 *
 * @param {string} text
 * @param {number} start
 * @param {number} hardEnd
 * @returns {number}
 */
function backtrackToBoundary(text, start, hardEnd) {
  const minEnd = start + Math.max(1, Math.floor((hardEnd - start) * 0.5));

  for (let index = hardEnd - 1; index >= minEnd; index -= 1) {
    if (/[.!?…]/.test(text[index])) {
      const next = text[index + 1];
      if (next === undefined || /\s/.test(next)) return index + 1;
    }
  }
  for (let index = hardEnd - 1; index >= minEnd; index -= 1) {
    if (text[index] === '\n') return index;
  }
  for (let index = hardEnd - 1; index >= minEnd; index -= 1) {
    if (/\s/.test(text[index])) return index;
  }
  for (let index = hardEnd - 1; index >= minEnd; index -= 1) {
    if (/[,;:—–]/.test(text[index])) return index + 1;
  }
  return hardEnd;
}

/**
 * Split speakable text into chunks that satisfy both Yandex limits.
 *
 * Every returned chunk is measured against the **encoded** request body, not
 * the raw character count: a Cyrillic character costs 6 bytes of
 * `application/x-www-form-urlencoded` payload, so a "12000-byte" budget yields
 * ~2000 Russian characters per chunk. The default budget of 12000 encoded
 * bytes leaves headroom below the hard 15000-byte Yandex limit for the voice,
 * language, format and speed fields (and for a folderId in IAM mode, when it is
 * passed here). Splits prefer sentence boundaries, then whitespace, then
 * clause punctuation; the text is never reordered and no non-whitespace
 * characters are dropped.
 *
 * @param {unknown} text Cleaned speech text (for example
 *   `prepareSpeechText(...).text`).
 * @param {object} [options]
 * @param {number} [options.maxEncodedBytes=12000] Body-size budget in encoded
 *   bytes, including all form fields.
 * @param {number} [options.maxCharsPerChunk=5000] Per-chunk character cap
 *   (Unicode code points).
 * @param {string} [options.voice='alena'] Voice id used for budget accounting.
 * @param {string} [options.lang='ru-RU'] Language used for budget accounting.
 * @param {string} [options.format='mp3'] Format used for budget accounting.
 * @param {number|string} [options.speed=1] Speed used for budget accounting.
 * @param {string} [options.emotion] Emotion used for budget accounting.
 * @param {string} [options.folderId] Folder id used for budget accounting
 *   (IAM mode only).
 * @returns {string[]} Ordered chunks; an empty array for blank input.
 * @throws {TtsError} When `maxEncodedBytes` leaves no room for any text.
 */
export function splitIntoChunks(
  text,
  {
    maxEncodedBytes = 12000,
    maxCharsPerChunk = MAX_TEXT_CHARS,
    voice = DEFAULT_VOICE,
    lang = DEFAULT_LANG,
    format = DEFAULT_FORMAT,
    speed = DEFAULT_SPEED,
    emotion,
    folderId,
  } = {},
) {
  const source = toText(text);
  if (source.trim() === '') return [];

  const budget = Math.floor(Number(maxEncodedBytes));
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new TtsError('Некорректный лимит размера запроса TTS', {
      code: 'bad-request',
      hint: 'Параметр maxEncodedBytes должен быть положительным числом байт.',
    });
  }

  const charLimit = Number.isFinite(Number(maxCharsPerChunk))
    ? Math.max(1, Math.floor(Number(maxCharsPerChunk)))
    : MAX_TEXT_CHARS;

  const baseBytes = estimateRequestBytes('', {
    voice,
    lang,
    format,
    speed,
    emotion: emptyToUndefined(emotion),
    folderId: emptyToUndefined(folderId),
  });
  const textBudget = budget - baseBytes;
  if (textBudget < 8) {
    throw new TtsError('Слишком маленький лимит тела запроса TTS', {
      code: 'bad-request',
      hint: `maxEncodedBytes=${budget} не оставляет места для текста (служебные поля занимают ${baseBytes} байт).`,
    });
  }

  const chunks = [];
  const length = source.length;
  let position = 0;

  while (position < length) {
    // Whitespace between chunks (and leading whitespace) is separator only.
    while (position < length && /\s/.test(source[position])) position += 1;
    if (position >= length) break;

    let end = position;
    let cost = 0;
    let characters = 0;
    while (end < length) {
      const codePoint = source.codePointAt(end);
      const width = codePoint > 0xffff ? 2 : 1;
      const charCost = formEncodedCodePointLength(codePoint);
      if (characters >= charLimit || cost + charCost > textBudget) break;
      cost += charCost;
      characters += 1;
      end += width;
    }

    if (end === position) {
      // A single character exceeds the whole budget: keep it rather than loop.
      end = position + (source.codePointAt(position) > 0xffff ? 2 : 1);
    } else if (end < length) {
      end = backtrackToBoundary(source, position, end);
    }

    const chunk = source.slice(position, end).trim();
    if (chunk !== '') chunks.push(chunk);
    position = end;
  }

  return chunks;
}

/**
 * Resolve and validate a format id.
 *
 * @param {unknown} format
 * @returns {{ key: string, mime: string, ext: string }}
 * @throws {TtsError} When the format is not supported.
 */
function resolveFormat(format) {
  const key = toText(format ?? DEFAULT_FORMAT).trim().toLowerCase();
  const entry = FORMATS[key];
  if (!entry) {
    throw new TtsError(`Формат «${toText(format)}» не поддерживается Yandex SpeechKit`, {
      code: 'bad-request',
      hint: `Допустимые форматы: ${FORMAT_KEYS.join(', ')} (по умолчанию mp3).`,
    });
  }
  return { key, mime: entry.mime, ext: entry.ext };
}

/**
 * MIME type for a response format.
 *
 * @param {string} format One of `FORMATS` (`mp3`, `oggopus`, `lpcm`).
 * @returns {string} `audio/mpeg`, `audio/ogg` or `audio/wav`.
 * @throws {TtsError} When the format is not supported.
 */
export function mimeForFormat(format) {
  return resolveFormat(format).mime;
}

/**
 * File extension (without a dot) for a response format.
 *
 * @param {string} format One of `FORMATS` (`mp3`, `oggopus`, `lpcm`).
 * @returns {string} `mp3`, `ogg` or `wav`.
 * @throws {TtsError} When the format is not supported.
 */
export function extForFormat(format) {
  return resolveFormat(format).ext;
}

/**
 * Resolve and validate a voice id.
 *
 * @param {unknown} voice
 * @returns {{ id: string, label: string, lang: string, gender: 'F'|'M', emotions?: ReadonlyArray<string> }}
 * @throws {TtsError} When the voice is not in the v1 voice table.
 */
function resolveVoice(voice) {
  const id = toText(voice ?? DEFAULT_VOICE).trim().toLowerCase();
  const entry = VOICE_BY_ID.get(id);
  if (!entry) {
    throw new TtsError(`Голос «${toText(voice)}» не поддерживается Yandex SpeechKit`, {
      code: 'bad-request',
      hint: `Доступные голоса: ${VOICES.map((item) => item.id).join(', ')}.`,
    });
  }
  return entry;
}

/**
 * Validate a speaking speed.
 *
 * @param {unknown} speed
 * @returns {number} Normalized numeric speed.
 * @throws {TtsError} When the value is outside 0.1 – 3.0.
 */
function resolveSpeed(speed) {
  const value = typeof speed === 'number' ? speed : Number(toText(speed ?? DEFAULT_SPEED).trim());
  if (!Number.isFinite(value) || value < 0.1 || value > 3) {
    throw new TtsError(`Недопустимая скорость речи «${toText(speed)}»`, {
      code: 'bad-request',
      hint: 'Скорость (speed) должна быть числом от 0.1 до 3.0.',
    });
  }
  return value;
}

/**
 * Validate an emotion against the chosen voice.
 *
 * @param {unknown} emotion
 * @param {{ id: string, emotions?: ReadonlyArray<string> }} voiceEntry
 * @returns {string|undefined} The emotion to send, or `undefined` when absent.
 * @throws {TtsError} When the voice does not support the emotion.
 */
function resolveEmotion(emotion, voiceEntry) {
  const value = emptyToUndefined(emotion);
  if (value === undefined) return undefined;
  const allowed = voiceEntry.emotions ?? [];
  if (!allowed.includes(value)) {
    throw new TtsError(`Эмоция «${value}» недоступна для голоса «${voiceEntry.id}»`, {
      code: 'bad-request',
      hint:
        allowed.length > 0
          ? `Доступные эмоции: ${allowed.join(', ')}.`
          : 'Параметр emotion поддерживается только русскими голосами Yandex SpeechKit; для этого голоса его нужно опустить.',
    });
  }
  return value;
}

/**
 * Build the Russian `not-configured` error raised when no credentials exist.
 *
 * @returns {TtsError}
 */
function notConfiguredError() {
  return new TtsError('Yandex SpeechKit не настроен: нет API-ключа или IAM-токена', {
    code: 'not-configured',
    hint: 'Укажите apiKey (сервисный аккаунт) или iamToken + folderId в plugin-config.json плагина voice-reply.',
    detail: 'apiKey and iamToken are both empty',
  });
}

/**
 * Parse a Yandex error payload, which is either
 * `{ "error_code": "...", "error_message": "..." }` or
 * `{ "code": "...", "message": "..." }` (or a non-JSON gateway error page).
 *
 * @param {string} rawBody
 * @returns {{ code: string, message: string, detail: string }}
 */
function parseYandexErrorPayload(rawBody) {
  const text = toText(rawBody).trim();
  if (text === '') return { code: '', message: '', detail: '' };
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === 'object') {
      let code = payload.error_code ?? payload.code ?? '';
      if (code && typeof code === 'object') code = JSON.stringify(code);
      let message = payload.error_message ?? payload.message ?? payload.error_description ?? '';
      if (message && typeof message === 'object') message = JSON.stringify(message);
      const detail = toText(message) || text.slice(0, 500);
      return { code: toText(code), message: toText(message), detail };
    }
  } catch {
    // Not JSON (proxy/HTML error page): fall through to the raw snippet.
  }
  return { code: '', message: '', detail: text.slice(0, 500) };
}

/**
 * Map a non-2xx Yandex response to a {@link TtsError}.
 *
 * 400/401/403 are never retryable; 429 and 5xx are. `message` is user-facing
 * Russian, `hint` names the exact scope/role to fix, `detail` keeps the raw
 * upstream message.
 *
 * @param {number} status HTTP status.
 * @param {string} rawBody Response body.
 * @returns {TtsError}
 */
function mapHttpError(status, rawBody) {
  const { code: upstreamCode, message: upstreamMessage, detail } = parseYandexErrorPayload(rawBody);
  const suffix = upstreamCode ? ` (${status} ${upstreamCode})` : ` (${status})`;
  const baseDetail = detail || upstreamMessage || `HTTP ${status}`;

  if (status === 401) {
    return new TtsError(`Yandex SpeechKit отклонил ключ${suffix}`, {
      code: 'unauthorized',
      status,
      retryable: false,
      hint:
        'Ключу нужен скоуп yc.ai.speechkitTts.execute (ключ только для синтеза речи). ' +
        'Создайте в Yandex Cloud API-ключ сервисного аккаунта с этим скоупом и обновите apiKey в plugin-config.json.',
      detail: baseDetail,
    });
  }
  if (status === 403) {
    return new TtsError(`Yandex SpeechKit запретил доступ${suffix}`, {
      code: 'forbidden',
      status,
      retryable: false,
      hint:
        'Назначьте сервисному аккаунту роль ai.speechkit-tts.user на каталог (folderId) в Yandex Cloud IAM ' +
        'и убедитесь, что ключ выпущен для этого каталога.',
      detail: baseDetail,
    });
  }
  if (status === 429) {
    return new TtsError(`Yandex SpeechKit: превышена квота${suffix}`, {
      code: 'quota',
      status,
      retryable: true,
      hint:
        'Запрос будет повторён автоматически. Если ошибка повторяется, увеличьте квоты Yandex SpeechKit ' +
        'или уменьшите длину текста.',
      detail: baseDetail,
    });
  }
  if (status >= 500) {
    return new TtsError(`Yandex SpeechKit вернул ошибку сервера${suffix}`, {
      code: 'upstream',
      status,
      retryable: true,
      hint: 'Временный сбой на стороне Yandex; запрос будет повторён автоматически, повторите позже.',
      detail: baseDetail,
    });
  }
  if (status >= 400) {
    return new TtsError(`Yandex SpeechKit отклонил запрос${suffix}`, {
      code: 'bad-request',
      status,
      retryable: false,
      hint:
        'Проверьте текст (не длиннее 5000 символов), голос, язык и формат (mp3, oggopus, lpcm), ' +
        'а также что тело запроса не превышает 15 КБ.',
      detail: baseDetail,
    });
  }
  return new TtsError(`Неожиданный ответ Yandex SpeechKit${suffix}`, {
    code: 'upstream',
    status,
    retryable: false,
    hint: 'Проверьте endpoint в plugin-config.json и повторите запрос.',
    detail: baseDetail,
  });
}

/**
 * Error raised when the caller aborted the synthesis through `AbortSignal`.
 *
 * Uses the `timeout` code because the host HTTP error contract only defines
 * `timeout` for "no usable answer was produced"; `detail` is `aborted`.
 *
 * @returns {TtsError}
 */
function abortedError() {
  return new TtsError('Синтез речи отменён', {
    code: 'timeout',
    retryable: false,
    hint: 'Запрос был отменён (AbortSignal); повторите озвучивание при необходимости.',
    detail: 'aborted',
  });
}

/**
 * Error raised when a single attempt exceeded `timeoutMs`.
 *
 * @param {number} timeoutMs
 * @returns {TtsError}
 */
function timeoutError(timeoutMs) {
  return new TtsError(`Yandex SpeechKit не ответил за ${timeoutMs} мс`, {
    code: 'timeout',
    retryable: true,
    hint: 'Проверьте доступность tts.api.cloud.yandex.net и сеть/прокси или увеличьте timeoutMs.',
    detail: `timeout after ${timeoutMs} ms`,
  });
}

/**
 * Error raised when the HTTP request itself failed (DNS, TLS, reset).
 *
 * @param {unknown} cause
 * @returns {TtsError}
 */
function networkError(cause) {
  const detail = cause instanceof Error ? cause.message : toText(cause);
  return new TtsError('Не удалось связаться с Yandex SpeechKit', {
    code: 'upstream',
    retryable: true,
    hint: 'Проверьте сеть, прокси и доступность tts.api.cloud.yandex.net; запрос будет повторён автоматически.',
    detail: detail || 'network error',
    cause,
  });
}

/**
 * Throw when the caller's signal is already aborted.
 *
 * @param {AbortSignal|undefined} signal
 * @returns {void}
 * @throws {TtsError}
 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortedError();
}

/**
 * Combine the caller's `AbortSignal` with a per-attempt timeout.
 *
 * @param {AbortSignal|undefined} externalSignal
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, didTimeout: () => boolean, wasAbortedByCaller: () => boolean, cleanup: () => void }}
 */
function createAttemptAbort(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const limit = Number(timeoutMs);
  if (Number.isFinite(limit) && limit > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    wasAbortedByCaller: () => Boolean(externalSignal && externalSignal.aborted) && !timedOut,
    cleanup() {
      if (timer !== null) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * Sleep for a retry delay, aborting early when the caller's signal aborts.
 *
 * @param {number} delayMs
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 * @throws {TtsError} When aborted.
 */
function sleep(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortedError());
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      reject(abortedError());
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exponential backoff with jitter for retryable failures.
 *
 * Attempt 1 waits 125–375 ms, attempt 2 waits 250–750 ms, and so on.
 *
 * @param {number} attempt 1-based attempt number that just failed.
 * @returns {number} Delay in milliseconds.
 */
function backoffDelay(attempt) {
  const base = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.round(base / 2 + Math.random() * base);
}

/**
 * Synthesize one chunk of text through the Yandex SpeechKit TTS v1 REST API.
 *
 * Sends `POST <endpoint>` with an `application/x-www-form-urlencoded;charset=UTF-8`
 * body. Authentication is either `Authorization: Api-Key <apiKey>` (service
 * account; `folderId` must **not** be sent) or `Authorization: Bearer <iamToken>`
 * plus a `folderId` form field (IAM mode). `emotion` is sent only when non-empty
 * and only for voices that support it; `sampleRateHertz` is never sent for
 * `mp3`/`oggopus`.
 *
 * The call retries `maxAttempts` times in total on 429, 5xx, network errors and
 * timeouts, with exponential backoff plus jitter. 400/401/403 are never
 * retried. Every failure is mapped to a {@link TtsError} with a user-facing
 * Russian message and an actionable hint.
 *
 * @param {object} options
 * @param {string} options.text Text to synthesize (one chunk; at most 5000
 *   characters and at most 15 KB after URL encoding — use
 *   {@link splitIntoChunks} for longer answers).
 * @param {string} [options.voice='alena'] Voice id from {@link VOICES}.
 * @param {string} [options.emotion] Yandex emotion, empty/undefined to omit.
 * @param {number|string} [options.speed=1] Speaking speed, 0.1 – 3.0.
 * @param {string} [options.lang='ru-RU'] Language of the text.
 * @param {string} [options.format='mp3'] Response format: `mp3`, `oggopus` or `lpcm`.
 * @param {string} [options.apiKey] Service-account API key (Api-Key auth).
 * @param {string} [options.iamToken] IAM token (Bearer auth); takes precedence
 *   over `apiKey` when both are provided.
 * @param {string} [options.folderId] Yandex Cloud folder id, IAM mode only.
 * @param {string} [options.endpoint=DEFAULT_ENDPOINT] Synthesis URL.
 * @param {number} [options.timeoutMs=30000] Per-attempt timeout in milliseconds.
 * @param {number} [options.maxAttempts=3] Total attempts, including the first one.
 * @param {typeof fetch} [options.fetchImpl] `fetch` implementation (defaults to
 *   the global `fetch`); the tests inject a recording implementation/mock server.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @returns {Promise<{ audio: Buffer, mime: string, bytes: number, status: number }>}
 *   Raw audio bytes, MIME type for `format`, byte length and HTTP status.
 * @throws {TtsError} On validation/configuration errors, HTTP errors, network
 *   errors, timeouts or cancellation.
 */
export async function synthesizeChunk({
  text,
  voice = DEFAULT_VOICE,
  emotion = undefined,
  speed = DEFAULT_SPEED,
  lang = DEFAULT_LANG,
  format = DEFAULT_FORMAT,
  apiKey = undefined,
  iamToken = undefined,
  folderId = undefined,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 30000,
  maxAttempts = 3,
  fetchImpl = undefined,
  signal = undefined,
} = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TtsError('Нет доступной реализации fetch для запроса к Yandex SpeechKit', {
      code: 'internal',
      hint: 'Запустите плагин на Node.js 18+ (встроенный fetch) или передайте fetchImpl.',
    });
  }

  const textValue = toText(text);
  if (textValue.trim() === '') {
    throw new TtsError('Пустой текст для синтеза речи', {
      code: 'bad-request',
      hint: 'Передайте непустой текст ответа ассистента.',
    });
  }
  const characters = codePointLength(textValue);
  if (characters > MAX_TEXT_CHARS) {
    throw new TtsError(`Текст длиннее ${MAX_TEXT_CHARS} символов (${characters})`, {
      code: 'bad-request',
      hint: 'Разделите текст на части через splitIntoChunks() и синтезируйте их по очереди.',
    });
  }

  const voiceEntry = resolveVoice(voice);
  const formatEntry = resolveFormat(format);
  const speedValue = resolveSpeed(speed);
  const emotionValue = resolveEmotion(emotion, voiceEntry);
  const langValue = toText(lang).trim() || DEFAULT_LANG;

  const iamValue = emptyToUndefined(iamToken);
  const apiKeyValue = emptyToUndefined(apiKey);
  const isIam = iamValue !== undefined;
  if (!isIam && apiKeyValue === undefined) throw notConfiguredError();
  const folderValue = isIam ? emptyToUndefined(folderId) : undefined;
  const authorization = isIam ? `Bearer ${iamValue}` : `Api-Key ${apiKeyValue}`;

  const body = buildRequestBody({
    text: textValue,
    voice: voiceEntry.id,
    lang: langValue,
    format: formatEntry.key,
    speed: speedValue,
    emotion: emotionValue,
    folderId: folderValue,
  });
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new TtsError(`Тело запроса TTS больше ${MAX_BODY_BYTES} байт (${bodyBytes})`, {
      code: 'bad-request',
      hint: 'Текст слишком длинный после URL-кодирования (кириллица расширяется примерно в 6 раз). Разделите его через splitIntoChunks().',
    });
  }

  const attempts = Number.isFinite(Number(maxAttempts)) ? Math.max(1, Math.floor(Number(maxAttempts))) : 3;
  const headers = {
    Authorization: authorization,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Accept: 'audio/*',
  };

  /** @type {TtsError|null} */
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);

    const attemptAbort = createAttemptAbort(signal, timeoutMs);
    let response;
    let audio;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: attemptAbort.signal,
      });
      audio = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const abortedByCaller = attemptAbort.wasAbortedByCaller();
      const timedOut = attemptAbort.didTimeout();
      attemptAbort.cleanup();
      if (abortedByCaller) throw abortedError();
      lastError = timedOut ? timeoutError(timeoutMs) : networkError(error);
      if (!lastError.retryable || attempt >= attempts) throw lastError;
      await sleep(backoffDelay(attempt), signal);
      continue;
    }
    attemptAbort.cleanup();

    if (response.ok) {
      return {
        audio,
        mime: formatEntry.mime,
        bytes: audio.length,
        status: response.status,
      };
    }

    lastError = mapHttpError(response.status, audio.toString('utf8'));
    if (!lastError.retryable || attempt >= attempts) throw lastError;
    await sleep(backoffDelay(attempt), signal);
  }

  // Unreachable in practice: the loop always returns or throws.
  throw lastError ?? new TtsError('Синтез речи не удался по неизвестной причине', { code: 'internal' });
}
