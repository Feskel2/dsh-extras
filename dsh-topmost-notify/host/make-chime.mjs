#!/usr/bin/env node
/**
 * make-chime.mjs — детерминированный генератор звуков для topmost-notify.
 *
 * Пишет в host/ два WAV (44.1 кГц, 16 бит, моно, 1.2 с, без клиппинга):
 *   chime.wav          — «задача выполнена»: две ноты-колокольчика A5 -> E6 (восходящая кварта),
 *                        длинный мягкий хвост, тёплый «динь»;
 *   chime-question.wav — «нужен ответ»: восходящая квинта E5 -> B5 с более коротким
 *                        «щелчком» и повтором-эхом (двойной вопросный сигнал), слышимо другой.
 *
 * Запуск:  node host/make-chime.mjs
 * Никаких зависимостей и сети.
 */

import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const DURATION_S = 1.2;
const ATTACK_S = 0.003; // мягкая атака, чтобы не было щелчка
const FADE_OUT_S = 0.08; // гарантированный ноль в конце файла
const PEAK = 0.62; // -4.1 dBFS: приятно, но не громко

/** [отношение частоты, амплитуда, множитель затухания] — слегка негармонично, «стекло» */
const BELL_PARTIALS = [
  [1.0, 1.0, 1.0],
  [2.01, 0.46, 0.72],
  [3.02, 0.24, 0.55],
  [4.08, 0.13, 0.44],
  [5.43, 0.07, 0.34],
];

/** Более «деревянный»/вопросный тембр: сильнее вторая гармоника, меньше высоких. */
const QUESTION_PARTIALS = [
  [1.0, 1.0, 1.0],
  [2.0, 0.62, 0.8],
  [3.01, 0.18, 0.5],
  [4.05, 0.06, 0.35],
];

const VARIANTS = [
  {
    file: "chime.wav",
    label: "completed",
    partials: BELL_PARTIALS,
    notes: [
      // t0 — начало ноты, f — основной тон, amp — вклад, tau — затухание основного тона (с)
      { t0: 0.0, f: 880.0, amp: 1.0, tau: 0.62 },
      { t0: 0.16, f: 1318.51, amp: 0.82, tau: 0.5 },
    ],
  },
  {
    file: "chime-question.wav",
    label: "question",
    partials: QUESTION_PARTIALS,
    notes: [
      // двойной восходящий сигнал E5 -> B5: сначала «вопрос», через 0.5 с — тише, как эхо
      { t0: 0.0, f: 659.25, amp: 0.95, tau: 0.34 },
      { t0: 0.2, f: 987.77, amp: 1.0, tau: 0.3 },
      { t0: 0.5, f: 659.25, amp: 0.55, tau: 0.3 },
      { t0: 0.7, f: 987.77, amp: 0.58, tau: 0.26 },
    ],
  },
];

function renderVariant(variant) {
  const n = Math.round(SR * DURATION_S);
  const buf = new Float64Array(n);

  for (const note of variant.notes) {
    const start = Math.round(note.t0 * SR);
    for (let i = start; i < n; i++) {
      const t = (i - start) / SR;
      const attack = t < ATTACK_S ? 0.5 - 0.5 * Math.cos((Math.PI * t) / ATTACK_S) : 1;
      let s = 0;
      for (const [ratio, pAmp, pDecay] of variant.partials) {
        const f = note.f * ratio;
        if (f >= SR / 2) continue; // защита от алиасинга
        const env = Math.exp(-t / (note.tau * pDecay));
        if (env < 1e-5) continue;
        const phase = ratio * 0.7; // детерминированный фазовый сдвиг — звучит «богаче»
        s += pAmp * env * Math.sin(2 * Math.PI * f * t + phase);
      }
      buf[i] += note.amp * attack * s;
    }
  }

  // Плавный общий хвост: последние FADE_OUT_S гасим к нулю (без щелчка на обрыве).
  const fadeN = Math.round(FADE_OUT_S * SR);
  for (let i = 0; i < fadeN; i++) {
    const idx = n - fadeN + i;
    const k = i / (fadeN - 1);
    buf[idx] *= 0.5 + 0.5 * Math.cos(Math.PI * k);
  }

  // Нормализация пика.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const gain = peak > 0 ? PEAK / peak : 0;

  const pcm = Buffer.alloc(n * 2);
  let rms = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, buf[i] * gain));
    rms += v * v;
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  rms = Math.sqrt(rms / n);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // размер fmt-чанка
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // бит на сэмпл
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  mkdirSync(HERE, { recursive: true });
  const out = join(HERE, variant.file);
  writeFileSync(out, Buffer.concat([header, pcm]));
  return { out, size: statSync(out).size, rmsDb: 20 * Math.log10(rms), n };
}

for (const variant of VARIANTS) {
  const r = renderVariant(variant);
  console.log(
    [
      `${variant.file} (${variant.label}): ${r.out}`,
      `  ${(r.n / SR).toFixed(3)} s, ${SR} Hz, 16-bit, mono, ${r.size} bytes`,
      `  peak ${PEAK.toFixed(2)} FS (-4.1 dBFS), rms ${r.rmsDb.toFixed(1)} dBFS`,
      `  notes: ${variant.notes.map((x) => `${x.f} Hz@${x.t0}s`).join(" -> ")}, ${variant.partials.length} partials`,
    ].join("\n"),
  );
}
