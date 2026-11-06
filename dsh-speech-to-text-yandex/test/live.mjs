/**
 * Живой тест: прогоняет WAV-файл через настоящий Yandex SpeechKit с ключом из
 * plugin-config.json (сеть + авторизация + нарезка + склейка).
 *
 * Запуск: node test/live.mjs <файл.wav> [язык]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from '../index.mjs';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
const language = process.argv[3] ?? 'ru';

if (!file) {
  console.error('usage: node test/live.mjs <file.wav> [language]');
  process.exit(2);
}

const wav = fs.readFileSync(file);
const provider = createProvider({ pluginDir, patchConfig: {} });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('живой тест: общий таймаут 120 с')), 120_000);

try {
  const result = await provider.transcribe({ audio: wav, language }, controller.signal);
  console.log(
    JSON.stringify(
      {
        ok: true,
        file,
        language,
        bytes: wav.length,
        audioSeconds: Number(result.audioSeconds.toFixed(2)),
        inferenceSeconds: Number(result.inferenceSeconds.toFixed(2)),
        text: result.text,
      },
      null,
      2,
    ),
  );
  if (result.text.trim() === '') {
    console.error('ВНИМАНИЕ: SpeechKit вернул пустой текст (тишина или не та модель языка)');
    process.exitCode = 3;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, name: error?.name, message: error?.message }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
