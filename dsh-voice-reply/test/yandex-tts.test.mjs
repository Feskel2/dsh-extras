/**
 * Unit tests for lib/yandex-tts.js.
 *
 * Run with:
 *   node --test test/yandex-tts.test.mjs
 *
 * The tests never touch the real Yandex API: all network calls go to a local
 * node:http mock server bound to 127.0.0.1:0 (or to an injected fetch stub).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Buffer } from 'node:buffer';

import {
  DEFAULT_ENDPOINT,
  VOICES,
  FORMATS,
  TtsError,
  stripMarkdownForSpeech,
  prepareSpeechText,
  splitIntoChunks,
  mimeForFormat,
  extForFormat,
  synthesizeChunk,
  estimateRequestBytes,
} from '../lib/yandex-tts.js';

// A tiny fake MP3 body (ID3 header + frame sync); content does not matter.
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00, 0x00]);

/**
 * Start a mock Yandex TTS server on 127.0.0.1 with an ephemeral port.
 *
 * @param {(request: { method: string, url: string, headers: Record<string, string|string[]|undefined>, body: string, params: URLSearchParams, bodyBytes: number }, res: http.ServerResponse, state: { requests: any[] }) => void} handler
 * @returns {Promise<{ endpoint: string, state: { requests: any[] }, close: () => Promise<void> }>}
 */
function listen(handler) {
  /** @type {{ requests: any[] }} */
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const pieces = [];
    req.on('data', (piece) => pieces.push(piece));
    req.on('end', () => {
      const body = Buffer.concat(pieces).toString('utf8');
      const request = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        params: new URLSearchParams(body),
        bodyBytes: Buffer.byteLength(body, 'utf8'),
      };
      state.requests.push(request);
      try {
        handler(request, res, state);
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('mock server has no port'));
        return;
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.port}/speech/v1/tts:synthesize`,
        state,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Run `run` with a mock server, always closing the server afterwards.
 *
 * @template T
 * @param {(request: any, res: http.ServerResponse, state: { requests: any[] }) => void} handler
 * @param {(mock: { endpoint: string, state: { requests: any[] } }) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withServer(handler, run) {
  const mock = await listen(handler);
  try {
    return await run(mock);
  } finally {
    await mock.close();
  }
}

/** @param {http.ServerResponse} res */
function respondAudio(res, status = 200) {
  res.writeHead(status, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length });
  res.end(AUDIO);
}

/** @param {http.ServerResponse} res */
function respondError(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Await a rejection and assert it is a TtsError with the expected shape.
 *
 * @param {Promise<unknown>|(() => Promise<unknown>)} subject
 * @param {{ code?: string, status?: number|null, retryable?: boolean, messageIncludes?: string, hintIncludes?: string, detailIncludes?: string }} [expected]
 * @returns {Promise<TtsError>}
 */
async function assertTtsError(subject, expected = {}) {
  let caught;
  try {
    await (typeof subject === 'function' ? subject() : subject);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TtsError, `expected TtsError, got: ${caught}`);
  assert.equal(caught.name, 'TtsError');
  if (expected.code !== undefined) assert.equal(caught.code, expected.code);
  if (expected.status !== undefined) assert.equal(caught.status, expected.status);
  if (expected.retryable !== undefined) assert.equal(caught.retryable, expected.retryable);
  if (expected.messageIncludes) {
    assert.ok(caught.message.includes(expected.messageIncludes), `message «${caught.message}» lacks «${expected.messageIncludes}»`);
  }
  if (expected.hintIncludes) {
    assert.ok(caught.hint.includes(expected.hintIncludes), `hint «${caught.hint}» lacks «${expected.hintIncludes}»`);
  }
  if (expected.detailIncludes) {
    assert.ok(caught.detail.includes(expected.detailIncludes), `detail «${caught.detail}» lacks «${expected.detailIncludes}»`);
  }
  return caught;
}

/** @param {string} value */
function codePointCount(value) {
  return [...value].length;
}

/** @param {string} value */
function withoutWhitespace(value) {
  return value.replace(/\s+/g, '');
}

/** @param {string} value */
function assertNoLoneSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${index}`);
      index += 1;
    } else {
      assert.ok(!(unit >= 0xdc00 && unit <= 0xdfff), `lone low surrogate at ${index}`);
    }
  }
}

/**
 * Assert the core chunk guarantees: non-empty trimmed chunks, character cap and
 * the real encoded-body limit.
 *
 * @param {string[]} chunks
 * @param {object} [options]
 */
function assertChunkLimits(chunks, options = {}) {
  assert.ok(chunks.length > 0, 'expected at least one chunk');
  const maxChars = options.maxCharsPerChunk ?? 5000;
  const maxEncodedBytes = options.maxEncodedBytes ?? 12000;
  for (const chunk of chunks) {
    assert.equal(chunk, chunk.trim(), 'chunks must be trimmed');
    assert.ok(chunk.length > 0, 'chunks must not be empty');
    assert.ok(codePointCount(chunk) <= maxChars, `chunk has ${codePointCount(chunk)} chars > ${maxChars}`);
    const bytes = estimateRequestBytes(chunk, options);
    assert.ok(bytes <= maxEncodedBytes, `encoded body ${bytes} > budget ${maxEncodedBytes}`);
    assert.ok(bytes <= 15000, `encoded body ${bytes} > Yandex 15000-byte limit`);
  }
}

describe('constants', () => {
  test('DEFAULT_ENDPOINT is the TTS v1 synthesize URL', () => {
    assert.equal(DEFAULT_ENDPOINT, 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize');
  });

  test('VOICES lists exactly the v1 voices, Russian ones first', () => {
    assert.deepEqual(
      VOICES.map((voice) => voice.id),
      ['alena', 'filipp', 'ermil', 'jane', 'omazh', 'zahar', 'marina', 'madi_ru', 'amira', 'madi', 'nigora', 'john', 'lea'],
    );
    for (const voice of VOICES) {
      assert.equal(typeof voice.label, 'string');
      assert.ok(voice.label.length > 0);
      assert.match(voice.lang, /^[a-z]{2}-[A-Z]{2}$/);
      assert.ok(voice.gender === 'F' || voice.gender === 'M');
      assert.equal(voice.gender, voice.label.includes('женский') ? 'F' : 'M');
      if (voice.emotions) assert.ok(Array.isArray(voice.emotions) && voice.emotions.length > 0);
    }
    // v3-only voices must never be offered.
    for (const forbidden of ['dasha', 'julia', 'lera', 'masha', 'anton', 'sasha']) {
      assert.equal(VOICES.some((voice) => voice.id === forbidden), false, `${forbidden} is v3-only`);
    }
    assert.equal(VOICES[0].id, 'alena');
    assert.deepEqual([...VOICES.find((voice) => voice.id === 'marina').emotions], ['neutral', 'whisper', 'friendly']);
    assert.equal(VOICES.find((voice) => voice.id === 'john').lang, 'en-US');
  });

  test('FORMATS maps exactly mp3/oggopus/lpcm to mime and ext', () => {
    assert.deepEqual(Object.keys(FORMATS).sort(), ['lpcm', 'mp3', 'oggopus']);
    assert.deepEqual(FORMATS.mp3, { mime: 'audio/mpeg', ext: 'mp3' });
    assert.deepEqual(FORMATS.oggopus, { mime: 'audio/ogg', ext: 'ogg' });
    assert.deepEqual(FORMATS.lpcm, { mime: 'audio/wav', ext: 'wav' });
  });
});

describe('stripMarkdownForSpeech', () => {
  test('removes fenced code blocks together with their content', () => {
    const raw = 'До кода.\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\nПосле кода.';
    assert.equal(stripMarkdownForSpeech(raw), 'До кода. После кода.');
  });

  test('keeps inline code content but removes the backticks', () => {
    assert.equal(stripMarkdownForSpeech('Запусти `npm test` в консоли.'), 'Запусти npm test в консоли.');
    assert.equal(stripMarkdownForSpeech('Значение `x = 2 * 3` верно.').includes('`'), false);
  });

  test('keeps link labels and turns bare URLs into «ссылка»', () => {
    const raw = 'Смотри [документацию](https://example.com/a) и https://example.com/b.';
    assert.equal(stripMarkdownForSpeech(raw), 'Смотри документацию и ссылка.');
    assert.equal(stripMarkdownForSpeech('Автоссылка <https://example.com> тут.'), 'Автоссылка ссылка тут.');
    assert.equal(stripMarkdownForSpeech('Сайт www.example.com работает.'), 'Сайт ссылка работает.');
    assert.equal(stripMarkdownForSpeech('https://example.com'), 'ссылка');
  });

  test('strips headings, emphasis, quotes, lists, rules, html and tables', () => {
    const raw = [
      '# Заголовок',
      '',
      '**Жирный** текст, *курсив*, ~~зачёркнутый~~ и [ссылка](https://example.com).',
      '',
      '- пункт один',
      '- пункт два',
      '',
      '> цитата',
      '',
      '---',
      '',
      '<div>html</div>',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    assert.equal(
      stripMarkdownForSpeech(raw),
      'Заголовок Жирный текст, курсив, зачёркнутый и ссылка. пункт один пункт два цитата html A B 1 2',
    );
  });

  test('returns an empty string for empty and missing input', () => {
    assert.equal(stripMarkdownForSpeech(''), '');
    assert.equal(stripMarkdownForSpeech(null), '');
    assert.equal(stripMarkdownForSpeech(undefined), '');
    assert.equal(stripMarkdownForSpeech('   \n\t  '), '');
  });

  test('collapses whitespace into a single speakable line', () => {
    assert.equal(stripMarkdownForSpeech('Первая строка.\n\n\nВторая   строка.  '), 'Первая строка. Вторая строка.');
  });
});

describe('prepareSpeechText', () => {
  test('cleans the text and reports chars/truncated when there is no limit', () => {
    const result = prepareSpeechText('**Привет**, мир!');
    assert.deepEqual(result, { text: 'Привет, мир!', chars: 12, truncated: false });
  });

  test('truncates at a sentence boundary and flags it', () => {
    const raw = 'Привет, мир! '.repeat(30);
    const result = prepareSpeechText(raw, { maxChars: 50 });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 50, `text length ${result.text.length}`);
    assert.ok(result.text.endsWith('!'), `expected sentence end, got «${result.text}»`);
    assert.equal(result.chars, result.text.length);
  });

  test('maxChars: 0 empties the text but reports truncation', () => {
    const result = prepareSpeechText('Привет', { maxChars: 0 });
    assert.equal(result.text, '');
    assert.equal(result.chars, 0);
    assert.equal(result.truncated, true);
  });

  test('a non-finite maxChars means no truncation', () => {
    const result = prepareSpeechText('Привет', { maxChars: Number.POSITIVE_INFINITY });
    assert.equal(result.text, 'Привет');
    assert.equal(result.truncated, false);
  });
});

describe('estimateRequestBytes', () => {
  test('matches the real URLSearchParams body byte-for-byte', () => {
    const text = 'Привет, мир! 🙂 https://example.com';
    const options = { voice: 'jane', lang: 'ru-RU', format: 'mp3', speed: 1.2, emotion: 'good', folderId: 'b1g123' };
    const expected = new URLSearchParams({
      text,
      voice: 'jane',
      lang: 'ru-RU',
      format: 'mp3',
      speed: '1.2',
      emotion: 'good',
      folderId: 'b1g123',
    }).toString();
    assert.equal(estimateRequestBytes(text, options), Buffer.byteLength(expected, 'utf8'));
  });

  test('counts Cyrillic as 6 encoded chars, emoji as 12, ASCII as 1', () => {
    const overhead = estimateRequestBytes('');
    assert.equal(estimateRequestBytes('Привет') - overhead, 36); // 6 Cyrillic chars × 6
    assert.equal(estimateRequestBytes('🙂') - overhead, 12); // one emoji = 4 UTF-8 bytes × 3
    assert.equal(estimateRequestBytes('abc') - overhead, 3);
    assert.equal(estimateRequestBytes('a b') - overhead, 3); // space is '+'
    assert.equal(estimateRequestBytes('a,b') - overhead, 5); // comma is %2C
  });

  test('includes optional emotion/folderId only when non-empty', () => {
    const base = estimateRequestBytes('text');
    assert.equal(estimateRequestBytes('text', { emotion: '' }), base);
    assert.equal(estimateRequestBytes('text', { folderId: '' }), base);
    assert.ok(estimateRequestBytes('text', { emotion: 'good' }) > base);
    assert.ok(estimateRequestBytes('text', { folderId: 'abc' }) > base);
  });
});

describe('splitIntoChunks', () => {
  test('returns [] for empty and whitespace-only text', () => {
    assert.deepEqual(splitIntoChunks(''), []);
    assert.deepEqual(splitIntoChunks('   \n\t '), []);
    assert.deepEqual(splitIntoChunks(null), []);
  });

  test('returns a single chunk when the text fits', () => {
    assert.deepEqual(splitIntoChunks('Короткий текст.'), ['Короткий текст.']);
  });

  test('dense Russian text stays within the encoded 15000-byte limit', () => {
    const paragraph =
      'Съешь же ещё этих мягких французских булок, да выпей чаю. ' +
      'Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства. ' +
      'В чащах юга жил бы цитрус? Да, но фальшивый экземпляр! ';
    const text = paragraph.repeat(40);
    assert.ok(text.length > 7000, 'fixture must be long enough to need several chunks');
    const chunks = splitIntoChunks(text);
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    assertChunkLimits(chunks);
    assert.equal(chunks.map(withoutWhitespace).join(''), withoutWhitespace(text));
    for (const chunk of chunks.slice(0, -1)) {
      assert.ok(chunk.length > 200, `suspiciously short chunk of ${chunk.length} chars`);
    }
  });

  test('dense English text stays within the encoded 15000-byte limit', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(400);
    const chunks = splitIntoChunks(text);
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    assertChunkLimits(chunks);
    assert.equal(chunks.map(withoutWhitespace).join(''), withoutWhitespace(text));
    for (const chunk of chunks) assert.ok(chunk.length <= 5000);
  });

  test('emoji text is split on code-point boundaries, never inside a surrogate pair', () => {
    const text = '🙂'.repeat(3000);
    const chunks = splitIntoChunks(text);
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    assertChunkLimits(chunks);
    for (const chunk of chunks) {
      assertNoLoneSurrogates(chunk);
      assert.ok(codePointCount(chunk) <= 5000);
    }
    assert.equal(chunks.join(''), text);
  });

  test('very long unbroken Cyrillic text is hard-split without data loss', () => {
    const text = 'Съешьжеещёэтихмягкихфранцузскихбулок'.repeat(150);
    const chunks = splitIntoChunks(text);
    assert.ok(chunks.length > 1);
    assertChunkLimits(chunks);
    assert.equal(chunks.join(''), text);
  });

  test('prefers sentence boundaries', () => {
    const text = Array.from({ length: 200 }, (_, index) => `Это предложение номер ${index + 1}.`).join(' ');
    const chunks = splitIntoChunks(text);
    assert.ok(chunks.length > 1);
    assertChunkLimits(chunks);
    for (const chunk of chunks) {
      assert.match(chunk, /[.!?…]$/, `chunk does not end at a sentence boundary: «${chunk.slice(-40)}»`);
    }
  });

  test('honours maxCharsPerChunk', () => {
    const text = 'абвгд'.repeat(100);
    const chunks = splitIntoChunks(text, { maxCharsPerChunk: 7 });
    assertChunkLimits(chunks, { maxCharsPerChunk: 7 });
    for (const chunk of chunks) assert.ok(codePointCount(chunk) <= 7);
    assert.equal(chunks.join(''), text);
  });

  test('honours a custom encoded-byte budget exactly', () => {
    const text = 'abcdefghij'.repeat(10);
    const chunks = splitIntoChunks(text, { maxEncodedBytes: 60 });
    assertChunkLimits(chunks, { maxEncodedBytes: 60 });
    assert.equal(chunks.join(''), text);
    // Overhead is 47 bytes, so at most 13 text bytes fit per chunk.
    for (const chunk of chunks) assert.ok(chunk.length <= 13);
  });

  test('throws a bad-request TtsError when the budget cannot fit any text', () => {
    assert.throws(
      () => splitIntoChunks('текст', { maxEncodedBytes: 20 }),
      (error) => error instanceof TtsError && error.code === 'bad-request',
    );
    assert.throws(
      () => splitIntoChunks('текст', { maxEncodedBytes: 0 }),
      (error) => error instanceof TtsError && error.code === 'bad-request',
    );
  });

  test('chunks synthesized with the same voice options stay under 15000 bytes', () => {
    const text = 'Проверка длинного текста для синтеза речи. '.repeat(300);
    const options = { voice: 'ermil', lang: 'ru-RU', format: 'mp3', speed: 1.1, emotion: 'good' };
    const chunks = splitIntoChunks(text, options);
    assert.ok(chunks.length > 1);
    assertChunkLimits(chunks, options);
  });
});

describe('mimeForFormat / extForFormat', () => {
  test('map the supported formats', () => {
    assert.equal(mimeForFormat('mp3'), 'audio/mpeg');
    assert.equal(mimeForFormat('oggopus'), 'audio/ogg');
    assert.equal(mimeForFormat('lpcm'), 'audio/wav');
    assert.equal(extForFormat('mp3'), 'mp3');
    assert.equal(extForFormat('oggopus'), 'ogg');
    assert.equal(extForFormat('lpcm'), 'wav');
  });

  test('throw a bad-request TtsError for an unsupported format', () => {
    assert.throws(
      () => mimeForFormat('wav'),
      (error) => error instanceof TtsError && error.code === 'bad-request' && error.message.includes('wav'),
    );
    assert.throws(
      () => extForFormat('flac'),
      (error) => error instanceof TtsError && error.code === 'bad-request',
    );
  });
});

describe('synthesizeChunk — success path', () => {
  test('sends a correct API-key request and returns bytes, mime and status', () =>
    withServer(
      (request, res) => respondAudio(res),
      async (mock) => {
        const result = await synthesizeChunk({
          text: 'Привет, мир!',
          apiKey: 'test-api-key',
          endpoint: mock.endpoint,
        });

        assert.equal(result.status, 200);
        assert.equal(result.mime, 'audio/mpeg');
        assert.ok(Buffer.isBuffer(result.audio));
        assert.deepEqual(result.audio, AUDIO);
        assert.equal(result.bytes, AUDIO.length);

        assert.equal(mock.state.requests.length, 1);
        const [request] = mock.state.requests;
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/speech/v1/tts:synthesize');
        assert.equal(request.headers.authorization, 'Api-Key test-api-key');
        assert.match(String(request.headers['content-type']), /^application\/x-www-form-urlencoded/);
        assert.equal(request.params.get('text'), 'Привет, мир!');
        assert.equal(request.params.get('voice'), 'alena');
        assert.equal(request.params.get('lang'), 'ru-RU');
        assert.equal(request.params.get('format'), 'mp3');
        assert.equal(request.params.get('speed'), '1');
        assert.equal(request.params.has('emotion'), false);
        assert.equal(request.params.has('folderId'), false);
        assert.equal(request.params.has('sampleRateHertz'), false);
        // The module must measure the same body it actually sends.
        assert.equal(request.bodyBytes, estimateRequestBytes('Привет, мир!'));
      },
    ));

  test('returns the MIME type and format field for oggopus', () =>
    withServer(
      (request, res) => respondAudio(res),
      async (mock) => {
        const result = await synthesizeChunk({
          text: 'Проверка',
          format: 'oggopus',
          apiKey: 'key',
          endpoint: mock.endpoint,
        });
        assert.equal(result.mime, 'audio/ogg');
        assert.equal(mock.state.requests[0].params.get('format'), 'oggopus');
      },
    ));

  test('sends emotion only when non-empty and for a supporting voice', () =>
    withServer(
      (request, res) => respondAudio(res),
      async (mock) => {
        await synthesizeChunk({ text: 'Привет', voice: 'jane', emotion: 'good', apiKey: 'key', endpoint: mock.endpoint });
        assert.equal(mock.state.requests[0].params.get('emotion'), 'good');
      },
    ));
});

describe('synthesizeChunk — authentication modes', () => {
  test('IAM mode sends Bearer plus folderId and no Api-Key', () =>
    withServer(
      (request, res) => respondAudio(res),
      async (mock) => {
        await synthesizeChunk({
          text: 'Привет',
          iamToken: 'iam-token-value',
          folderId: 'b1g-folder-id',
          apiKey: 'ignored-key',
          endpoint: mock.endpoint,
        });
        const [request] = mock.state.requests;
        assert.equal(request.headers.authorization, 'Bearer iam-token-value');
        assert.equal(request.params.get('folderId'), 'b1g-folder-id');
      },
    ));

  test('API-key mode sends Api-Key and never folderId even when passed mistakenly', () =>
    withServer(
      (request, res) => respondAudio(res),
      async (mock) => {
        await synthesizeChunk({
          text: 'Привет',
          apiKey: 'service-account-key',
          folderId: 'should-not-be-sent',
          endpoint: mock.endpoint,
        });
        const [request] = mock.state.requests;
        assert.equal(request.headers.authorization, 'Api-Key service-account-key');
        assert.equal(request.params.has('folderId'), false);
      },
    ));

  test('rejects with not-configured when no credentials are given and never calls fetch', async () => {
    let fetchCalls = 0;
    await assertTtsError(
      () =>
        synthesizeChunk({
          text: 'Привет',
          endpoint: 'http://127.0.0.1:9/unused',
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('must not be called');
          },
        }),
      { code: 'not-configured', retryable: false, messageIncludes: 'не настроен' },
    );
    assert.equal(fetchCalls, 0);
  });
});

describe('synthesizeChunk — HTTP error mapping', () => {
  test('400 is mapped to bad-request and is not retried (error_code payload)', () =>
    withServer(
      (request, res) => respondError(res, 400, { error_code: 'BAD_REQUEST', error_message: 'Invalid voice' }),
      async (mock) => {
        await assertTtsError(
          () => synthesizeChunk({ text: 'Привет', voice: 'alena', apiKey: 'key', endpoint: mock.endpoint }),
          {
            code: 'bad-request',
            status: 400,
            retryable: false,
            messageIncludes: '400',
            hintIncludes: '5000',
            detailIncludes: 'Invalid voice',
          },
        );
        assert.equal(mock.state.requests.length, 1);
      },
    ));

  test('400 payload variant { code, message } is parsed too', () =>
    withServer(
      (request, res) => respondError(res, 400, { code: 'BAD_REQUEST', message: 'Invalid format' }),
      async (mock) => {
        const error = await assertTtsError(
          () => synthesizeChunk({ text: 'Привет', apiKey: 'key', endpoint: mock.endpoint }),
          { code: 'bad-request', status: 400 },
        );
        assert.equal(error.detail, 'Invalid format');
        assert.equal(mock.state.requests.length, 1);
      },
    ));

  test('401 is mapped to unauthorized with the TTS scope hint and is not retried', () =>
    withServer(
      (request, res) => respondError(res, 401, { code: 'UNAUTHORIZED', message: 'Permission denied' }),
      async (mock) => {
        await assertTtsError(
          () => synthesizeChunk({ text: 'Привет', apiKey: 'stt-scoped-key', endpoint: mock.endpoint }),
          {
            code: 'unauthorized',
            status: 401,
            retryable: false,
            hintIncludes: 'yc.ai.speechkitTts.execute',
            detailIncludes: 'Permission denied',
          },
        );
        assert.equal(mock.state.requests.length, 1);
      },
    ));

  test('403 is mapped to forbidden with the role hint and is not retried', () =>
    withServer(
      (request, res) => respondError(res, 403, { error_code: 'FORBIDDEN', error_message: 'Forbidden' }),
      async (mock) => {
        await assertTtsError(
          () => synthesizeChunk({ text: 'Привет', iamToken: 'iam', folderId: 'folder', endpoint: mock.endpoint }),
          {
            code: 'forbidden',
            status: 403,
            retryable: false,
            hintIncludes: 'ai.speechkit-tts.user',
          },
        );
        assert.equal(mock.state.requests.length, 1);
      },
    ));

  test('429 then 200 succeeds on retry', () =>
    withServer(
      (request, res, state) => {
        if (state.requests.length === 1) respondError(res, 429, { error_code: 'TOO_MANY_REQUESTS', error_message: 'Rate limit' });
        else respondAudio(res);
      },
      async (mock) => {
        const result = await synthesizeChunk({ text: 'Привет', apiKey: 'key', endpoint: mock.endpoint });
        assert.equal(result.status, 200);
        assert.equal(mock.state.requests.length, 2);
      },
    ));

  test('5xx retries are exhausted after maxAttempts and surface an upstream error', () =>
    withServer(
      (request, res) => respondError(res, 500, { error_code: 'INTERNAL_ERROR', error_message: 'Internal error' }),
      async (mock) => {
        await assertTtsError(
          () => synthesizeChunk({ text: 'Привет', apiKey: 'key', endpoint: mock.endpoint, maxAttempts: 3 }),
          {
            code: 'upstream',
            status: 500,
            retryable: true,
            messageIncludes: '500',
          },
        );
        assert.equal(mock.state.requests.length, 3);
      },
    ));

  test('network failures are retried and mapped to a retryable upstream error', async () => {
    let calls = 0;
    await assertTtsError(
      () =>
        synthesizeChunk({
          text: 'Привет',
          apiKey: 'key',
          endpoint: 'http://127.0.0.1:9/unreachable',
          maxAttempts: 2,
          fetchImpl: async () => {
            calls += 1;
            throw new TypeError('fetch failed');
          },
        }),
      { code: 'upstream', retryable: true, hintIncludes: 'tts.api.cloud.yandex.net' },
    );
    assert.equal(calls, 2);
  });

  test('a per-attempt timeout is mapped to a retryable timeout error', () =>
    withServer(
      () => {
        // Never respond: the client must time out and close the socket.
      },
      async (mock) => {
        const startedAt = Date.now();
        await assertTtsError(
          () =>
            synthesizeChunk({
              text: 'Привет',
              apiKey: 'key',
              endpoint: mock.endpoint,
              timeoutMs: 80,
              maxAttempts: 1,
            }),
          { code: 'timeout', retryable: true, messageIncludes: '80 мс' },
        );
        assert.ok(Date.now() - startedAt < 3000, 'timeout must fire promptly');
        assert.equal(mock.state.requests.length, 1);
      },
    ));
});

describe('synthesizeChunk — cancellation', () => {
  test('an already-aborted signal rejects without any request', async () => {
    const controller = new AbortController();
    controller.abort();
    await withServer(
      (request, res) => respondAudio(res),
      async (mock) => {
        await assertTtsError(
          () => synthesizeChunk({ text: 'Привет', apiKey: 'key', endpoint: mock.endpoint, signal: controller.signal }),
          { code: 'timeout', retryable: false, messageIncludes: 'отменён' },
        );
        assert.equal(mock.state.requests.length, 0);
      },
    );
  });

  test('an abort during a hanging request rejects immediately and is not retried', () =>
    withServer(
      () => {
        // Never respond.
      },
      async (mock) => {
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 40);
        try {
          const startedAt = Date.now();
          await assertTtsError(
            () =>
              synthesizeChunk({
                text: 'Привет',
                apiKey: 'key',
                endpoint: mock.endpoint,
                timeoutMs: 5000,
                maxAttempts: 3,
                signal: controller.signal,
              }),
            { code: 'timeout', retryable: false, messageIncludes: 'отменён' },
          );
          assert.ok(Date.now() - startedAt < 3000, 'abort must take effect promptly');
          assert.equal(mock.state.requests.length, 1);
        } finally {
          clearTimeout(abortTimer);
        }
      },
    ));
});

describe('synthesizeChunk — validation', () => {
  /** @returns {typeof fetch} */
  function failingFetch() {
    return async () => {
      throw new Error('fetch must not be called for invalid input');
    };
  }

  /** @param {object} options */
  async function expectBadRequest(options, messagePattern) {
    await assertTtsError(
      () => synthesizeChunk({ apiKey: 'key', fetchImpl: failingFetch(), ...options }),
      { code: 'bad-request', retryable: false, messageIncludes: messagePattern },
    );
  }

  test('rejects an unsupported format without calling Yandex', async () => {
    await expectBadRequest({ text: 'Привет', format: 'wav' }, 'Формат');
  });

  test('rejects an unsupported (v3-only) voice without calling Yandex', async () => {
    await expectBadRequest({ text: 'Привет', voice: 'dasha' }, 'Голос');
  });

  test('rejects an emotion unsupported by the chosen voice', async () => {
    await expectBadRequest({ text: 'Привет', voice: 'john', emotion: 'good' }, 'Эмоция');
  });

  test('rejects an invalid speed', async () => {
    await expectBadRequest({ text: 'Привет', speed: 5 }, 'скорость');
    await expectBadRequest({ text: 'Привет', speed: 0.05 }, 'скорость');
  });

  test('rejects empty text', async () => {
    await expectBadRequest({ text: '   ' }, 'Пустой');
  });

  test('rejects text longer than 5000 characters', async () => {
    await expectBadRequest({ text: 'а'.repeat(5001) }, '5000');
  });

  test('rejects a request body larger than 15000 encoded bytes', async () => {
    // 4000 Cyrillic chars fit the 5000-char limit but cost ~24000 encoded bytes.
    await expectBadRequest({ text: 'а'.repeat(4000) }, '15000');
  });
});
