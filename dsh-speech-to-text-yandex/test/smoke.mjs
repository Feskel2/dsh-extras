/**
 * Автотесты плагина speech-to-text-yandex: WAV-разбор, нарезка, склейка,
 * HTTP-контракт SpeechKit и обработка ошибок — на локальном мок-сервере.
 *
 * Запуск: node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProvider, testables } from '../index.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parsePcmWav, splitPcm, resolveConfig, recognizeChunk, SpeechInputError, SpeechKitError } = testables;
const RATE = 16000;

/** Собрать канонический WAV (PCM16 LE). */
function makeWav(pcm, { sampleRate = RATE, channels = 1, bits = 16 } = {}) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** PCM-тон заданной длительности (амплитуда 0…1, 0 — тишина). */
function tone(seconds, { frequency = 220, amplitude = 0.4 } = {}) {
  const samples = Math.round(seconds * RATE);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * index) / RATE));
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

function concat(...parts) {
  return Buffer.concat(parts);
}

/** Поднять мок SpeechKit: обработчик получает (req, body) и отдаёт {status, body, delayMs}. */
async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      const request = { method: req.method, url, headers: req.headers, body };
      requests.push(request);
      const reply = await handler(request, requests.length);
      const send = () => {
        if (res.destroyed) return;
        const payload = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(payload);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/speech/v1/stt:recognize`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function tempPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stt-yandex-'));
}

function makeProvider(pluginDir, overrides = {}) {
  return createProvider({
    pluginDir,
    patchConfig: {
      apiKey: 'test-key',
      endpoint: overrides.endpoint,
      requestTimeoutMs: 2_000,
      maxAttempts: 3,
      retryBaseMs: 5,
      logFile: 'events.log',
      chunkSeconds: 25,
      ...overrides,
    },
  });
}

describe('parsePcmWav', () => {
  it('принимает канонический WAV 16 kHz mono PCM16', () => {
    const wav = makeWav(tone(1));
    const { pcm, seconds } = parsePcmWav(wav);
    assert.equal(pcm.length, 32000);
    assert.equal(seconds, 1);
  });

  it('находит data-чанк после посторонних RIFF-чанков', () => {
    const pcm = tone(0.5);
    const wav = makeWav(pcm);
    const junk = Buffer.alloc(12);
    junk.write('LIST', 0, 'ascii');
    junk.writeUInt32LE(4, 4);
    junk.write('INFO', 8, 'ascii');
    // вставляем LIST между "WAVE" и fmt
    const patched = Buffer.concat([wav.subarray(0, 12), junk, wav.subarray(12)]);
    patched.writeUInt32LE(patched.length - 8, 4);
    const parsed = parsePcmWav(patched);
    assert.equal(parsed.pcm.length, pcm.length);
  });

  it('отклоняет не-WAV', () => {
    assert.throws(() => parsePcmWav(Buffer.from('не аудио')), SpeechInputError);
  });

  it('отклоняет стерео и чужую частоту', () => {
    assert.throws(() => parsePcmWav(makeWav(tone(1), { channels: 2 })), /PCM16 mono/);
    assert.throws(() => parsePcmWav(makeWav(tone(1), { sampleRate: 8000 })), /16000/);
  });

  it('отклоняет запись сверх предохранителя', () => {
    assert.throws(() => parsePcmWav(makeWav(tone(2)), 1), /длиннее/);
  });
});

describe('splitPcm', () => {
  it('режет длинное аудио на куски в лимитах API', () => {
    const pcm = tone(60);
    const parts = splitPcm(pcm, { chunkSeconds: 25, searchBackSeconds: 3, minChunkSeconds: 1 });
    assert.equal(parts.length, 3);
    let total = 0;
    for (const part of parts) {
      assert.ok(part.seconds <= 28, `кусок ${part.seconds}s > 28s`);
      assert.ok(part.pcm.length <= 900 * 1024);
      total += part.pcm.length;
    }
    assert.equal(total, pcm.length, 'куски покрывают всё аудио без потерь');
  });

  it('короткое аудио остаётся одним куском', () => {
    const pcm = tone(10);
    const parts = splitPcm(pcm, { chunkSeconds: 25, searchBackSeconds: 3, minChunkSeconds: 1 });
    assert.equal(parts.length, 1);
    assert.equal(parts[0].pcm.length, pcm.length);
  });

  it('режет по тишине у границы, а не посреди слова', () => {
    const speech = tone(24);
    const silence = Buffer.alloc(2 * RATE); // 1 с тишины
    const tail = tone(10);
    const pcm = concat(speech, silence, tail);
    const parts = splitPcm(pcm, { chunkSeconds: 25, searchBackSeconds: 3, minChunkSeconds: 1 });
    assert.equal(parts.length, 2);
    const firstSamples = parts[0].pcm.length / 2;
    assert.ok(firstSamples >= 24 * RATE, 'рез не раньше начала тишины');
    assert.ok(firstSamples <= 25 * RATE, 'рез внутри окна поиска');
  });

  it('соблюдает минимум и максимум куска', () => {
    const pcm = tone(56);
    const parts = splitPcm(pcm, { chunkSeconds: 28, searchBackSeconds: 0, minChunkSeconds: 2 });
    assert.equal(parts.length, 2);
    assert.ok(parts[0].seconds <= 28);
    assert.ok(parts[0].seconds >= 2, 'минимум куска соблюдается');
  });

  it('не ломается на противоречивых chunkSeconds/minChunkSeconds', () => {
    const pluginDir = tempPluginDir();
    const config = resolveConfig(pluginDir, { chunkSeconds: 5, minChunkSeconds: 10 });
    assert.equal(config.chunkSeconds, 5);
    assert.equal(config.minChunkSeconds, 2.5, 'минимум куска ограничен половиной целевого размера');
    const pcm = tone(60);
    const parts = splitPcm(pcm, config);
    assert.ok(parts.length >= 4);
    for (const [index, part] of parts.entries()) {
      assert.ok(part.seconds <= 28, `кусок ${part.seconds}s больше предела API`);
      if (index < parts.length - 1) {
        assert.ok(part.seconds >= 2.4, `кусок ${part.seconds}s короче минимума`);
        assert.ok(part.seconds <= 5, `кусок ${part.seconds}s больше целевого размера`);
      }
    }
    assert.equal(parts.reduce((sum, part) => sum + part.pcm.length, 0), pcm.length);
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });
});

describe('resolveConfig', () => {
  it('читает plugin-config.json и отдаёт приоритет patch-конфигу', () => {
    const dir = tempPluginDir();
    fs.writeFileSync(
      path.join(dir, 'plugin-config.json'),
      JSON.stringify({ apiKey: 'file-key', folderId: 'file-folder', topic: 'general:rc', chunkSeconds: 20 }),
    );
    const fromFile = resolveConfig(dir, {});
    assert.equal(fromFile.secret, 'file-key');
    assert.equal(fromFile.folderId, 'file-folder');
    assert.equal(fromFile.topic, 'general:rc');
    assert.equal(fromFile.chunkSeconds, 20);
    const patched = resolveConfig(dir, { apiKey: 'patch-key', topic: 'general' });
    assert.equal(patched.secret, 'patch-key');
    assert.equal(patched.topic, 'general');
    assert.equal(patched.authMode, 'api-key');
  });

  it('переключается на IAM-токен', () => {
    const dir = tempPluginDir();
    const config = resolveConfig(dir, { iamToken: 'Bearer t1.abc', folderId: 'folder-1' });
    assert.equal(config.authMode, 'iam');
    assert.equal(config.secret, 't1.abc');
  });

  it('падает на битом JSON', () => {
    const dir = tempPluginDir();
    fs.writeFileSync(path.join(dir, 'plugin-config.json'), '{oops');
    assert.throws(() => resolveConfig(dir, {}), /некорректный JSON/);
  });
});

describe('SpeechKit HTTP-контракт (мок)', () => {
  let server;
  let pluginDir;

  before(async () => {
    pluginDir = tempPluginDir();
    server = await startServer((request, index) => {
      const texts = ['раз', 'два', 'три'];
      return { status: 200, body: { result: texts[(index - 1) % texts.length] } };
    });
  });

  after(async () => {
    await server.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it('отправляет сырой PCM без WAV-заголовка и склеивает куски по порядку', async () => {
    server.requests.length = 0;
    const provider = makeProvider(pluginDir, { endpoint: server.url, chunkSeconds: 25 });
    const wav = makeWav(tone(60));
    const result = await provider.transcribe({ audio: wav, language: 'ru' }, new AbortController().signal);

    assert.equal(result.text, 'раз два три');
    assert.equal(Math.round(result.audioSeconds), 60);
    assert.equal(server.requests.length, 3);
    for (const request of server.requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Api-Key test-key');
      assert.equal(request.url.searchParams.get('format'), 'lpcm');
      assert.equal(request.url.searchParams.get('sampleRateHertz'), '16000');
      assert.equal(request.url.searchParams.get('lang'), 'ru-RU');
      assert.equal(request.url.searchParams.get('topic'), 'general');
      assert.equal(request.url.searchParams.get('folderId'), null, 'folderId не нужен при API-ключе');
      assert.notEqual(request.body.subarray(0, 4).toString('ascii'), 'RIFF', 'WAV-заголовок вырезан');
      assert.ok(request.body.length % 2 === 0);
    }
    assert.ok(server.requests.every((request) => request.body.length <= 900 * 1024));
  });

  it('переводит короткие коды языков в коды SpeechKit', async () => {
    server.requests.length = 0;
    const provider = makeProvider(pluginDir, { endpoint: server.url, chunkSeconds: 25 });
    await provider.transcribe({ audio: makeWav(tone(1)), language: 'en' }, new AbortController().signal);
    assert.equal(server.requests[0].url.searchParams.get('lang'), 'en-US');
  });

  it('auto уходит как настоящее автоопределение SpeechKit', async () => {
    server.requests.length = 0;
    const provider = makeProvider(pluginDir, { endpoint: server.url, chunkSeconds: 25 });
    await provider.transcribe({ audio: makeWav(tone(1)), language: 'auto' }, new AbortController().signal);
    assert.equal(server.requests[0].url.searchParams.get('lang'), 'auto');
  });

  it('неизвестный язык — явная ошибка до сети', async () => {
    server.requests.length = 0;
    const provider = makeProvider(pluginDir, { endpoint: server.url, chunkSeconds: 25 });
    await assert.rejects(
      provider.transcribe({ audio: makeWav(tone(1)), language: 'xx' }, new AbortController().signal),
      /не поддерживается/,
    );
    assert.equal(server.requests.length, 0);
  });

  it('для IAM-токена передаёт Bearer и folderId', async () => {
    server.requests.length = 0;
    const provider = makeProvider(pluginDir, {
      endpoint: server.url,
      iamToken: 't1.iam',
      folderId: 'folder-1',
      apiKey: undefined,
    });
    await provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, new AbortController().signal);
    assert.equal(server.requests[0].headers.authorization, 'Bearer t1.iam');
    assert.equal(server.requests[0].url.searchParams.get('folderId'), 'folder-1');
  });

  it('пишет журнал без ключа и без текста распознавания', async () => {
    const log = fs.readFileSync(path.join(pluginDir, 'events.log'), 'utf8');
    assert.match(log, /transcribe\.ok/);
    assert.doesNotMatch(log, /test-key/);
    assert.doesNotMatch(log, /раз два три/);
  });
});

describe('ошибки SpeechKit', () => {
  it('не повторяет 401 и объясняет причину', async () => {
    const pluginDir = tempPluginDir();
    const server = await startServer(() => ({
      status: 401,
      body: { error_code: 'UNAUTHENTICATED', error_message: 'invalid api key' },
    }));
    try {
      const provider = makeProvider(pluginDir, { endpoint: server.url });
      await assert.rejects(
        provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, new AbortController().signal),
        /API-ключ/,
      );
      assert.equal(server.requests.length, 1, '401 не ретраится');
    } finally {
      await server.close();
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('повторяет 429 и завершается успехом', async () => {
    const pluginDir = tempPluginDir();
    const server = await startServer((_request, index) =>
      index <= 2 ? { status: 429, body: { error_code: 'RESOURCE_EXHAUSTED' } } : { status: 200, body: { result: 'готово' } },
    );
    try {
      const provider = makeProvider(pluginDir, { endpoint: server.url, maxAttempts: 3 });
      const result = await provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, new AbortController().signal);
      assert.equal(result.text, 'готово');
      assert.equal(server.requests.length, 3);
    } finally {
      await server.close();
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('сдаётся после maxAttempts при 503', async () => {
    const pluginDir = tempPluginDir();
    const server = await startServer(() => ({ status: 503, body: { error_code: 'UNAVAILABLE' } }));
    try {
      const provider = makeProvider(pluginDir, { endpoint: server.url, maxAttempts: 2 });
      await assert.rejects(
        provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, new AbortController().signal),
        /временно недоступен/,
      );
      assert.equal(server.requests.length, 2);
    } finally {
      await server.close();
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('сообщает о таймауте', async () => {
    const pluginDir = tempPluginDir();
    const server = await startServer(() => ({ status: 200, body: { result: 'поздно' }, delayMs: 700 }));
    try {
      const provider = makeProvider(pluginDir, { endpoint: server.url, requestTimeoutMs: 250, maxAttempts: 1 });
      await assert.rejects(
        provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, new AbortController().signal),
        /не ответил за 250 мс/,
      );
    } finally {
      await server.close();
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('прерывает запрос по отмене и не ретраит', async () => {
    const pluginDir = tempPluginDir();
    const server = await startServer(() => ({ status: 200, body: { result: 'поздно' }, delayMs: 700 }));
    try {
      const provider = makeProvider(pluginDir, { endpoint: server.url });
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('user cancelled')), 60);
      await assert.rejects(
        provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, controller.signal),
        /user cancelled/,
      );
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('пустой result — не ошибка (тишина)', async () => {
    const pluginDir = tempPluginDir();
    const server = await startServer(() => ({ status: 200, body: { result: '' } }));
    try {
      const provider = makeProvider(pluginDir, { endpoint: server.url });
      const result = await provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, new AbortController().signal);
      assert.equal(result.text, '');
    } finally {
      await server.close();
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('без ключа не ходит в сеть', async () => {
    const pluginDir = tempPluginDir();
    const provider = createProvider({ pluginDir, patchConfig: { endpoint: 'http://127.0.0.1:9/never' } });
    await assert.rejects(
      provider.transcribe({ audio: makeWav(tone(1)), language: 'ru' }, new AbortController().signal),
      /не настроен/,
    );
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });
});

describe('интерфейс провайдера', () => {
  it('объявляет облачный провайдер с набором языков', () => {
    const provider = createProvider({ pluginDir: PLUGIN_DIR, patchConfig: {} });
    assert.equal(provider.info.id, 'yandex-speechkit');
    assert.equal(provider.info.location, 'cloud');
    assert.ok(provider.info.languages.includes('ru'));
    assert.ok(provider.info.languages.includes('auto'));
    assert.equal(provider.info.setupEstimate, undefined);
    assert.equal(typeof provider.transcribe, 'function');
    assert.equal(provider.preparation, undefined);
  });

  it('заявленные языки имеют отображение в коды SpeechKit', () => {
    for (const language of testables.LANGUAGES) {
      assert.ok(testables.LANGUAGE_MAP[language], `нет маппинга для ${language}`);
      assert.match(testables.LANGUAGE_MAP[language], /^(auto|[a-z]{2}-[A-Z]{2})$/);
    }
    assert.equal(testables.LANGUAGE_MAP.auto, 'auto', 'auto — настоящее автоопределение, а не ru-RU');
    assert.ok(Object.isFrozen(createProvider({ pluginDir: PLUGIN_DIR, patchConfig: {} }).info.languages));
  });
});
