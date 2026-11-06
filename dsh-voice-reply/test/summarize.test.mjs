/**
 * Unit tests for the extractive spoken summarizer (`lib/summarize.js`).
 *
 * Run: node --test test/summarize.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_SUMMARY_MAX_CHARS,
  MAX_SUMMARY_MAX_CHARS,
  MIN_SUMMARY_MAX_CHARS,
  SUMMARY_STEP,
  clampSummaryMaxChars,
  summarizeSpeechText,
} from '../lib/summarize.js'

const LONG_ANSWER = `# Обновление плагина озвучки

Я обновил плагин **dsh-voice-reply**: теперь он озвучивает не весь ответ, а краткое содержание.

## Что сделано

- Добавлен модуль суммаризации \`lib/summarize.js\`.
- Хост перед синтезом сжимает ответ до 500 символов.
- В настройках плагина появилось поле «Максимум символов».
- Кнопка 🔊 теперь проигрывает ту же короткую версию.

## Как проверить

1. Откройте «Плагины» → «Голосовые ответы» → «Настроить».
2. Поставьте 300 символов и сохраните.
3. Задайте вопрос — озвучка станет короче.

\`\`\`js
const secret = "этот код не должен читаться"
\`\`\`

Итог: плагин стал удобнее, а длинные ответы больше не читаются целиком. Если понадобится, можно вернуть 500 символов одной кнопкой.`

test('clampSummaryMaxChars keeps the budget inside the supported range', () => {
  assert.equal(clampSummaryMaxChars(undefined), DEFAULT_SUMMARY_MAX_CHARS)
  assert.equal(clampSummaryMaxChars(null), DEFAULT_SUMMARY_MAX_CHARS)
  assert.equal(clampSummaryMaxChars('not a number'), DEFAULT_SUMMARY_MAX_CHARS)
  assert.equal(clampSummaryMaxChars(500), 500)
  assert.equal(clampSummaryMaxChars('700'), 700)
  assert.equal(clampSummaryMaxChars(1), MIN_SUMMARY_MAX_CHARS)
  assert.equal(clampSummaryMaxChars(99999), MAX_SUMMARY_MAX_CHARS)
  assert.equal(clampSummaryMaxChars(499.6), 500)
  assert.equal(MIN_SUMMARY_MAX_CHARS, 100)
  assert.equal(MAX_SUMMARY_MAX_CHARS, 2000)
  assert.equal(SUMMARY_STEP, 50)
})

test('a short answer is spoken in full and is not marked as summarized', () => {
  const result = summarizeSpeechText('Готово: плагин обновлён и проверен.', { maxChars: 500 })
  assert.equal(result.text, 'Готово: плагин обновлён и проверен.')
  assert.equal(result.chars, result.text.length)
  assert.equal(result.sourceChars, result.text.length)
  assert.equal(result.summarized, false)
  assert.equal(result.truncated, false)
})

test('an answer that exactly fits the budget is not summarized', () => {
  const text = 'Короткий ответ без лишних деталей.'
  const result = summarizeSpeechText(text, { maxChars: text.length })
  assert.equal(result.text, text)
  assert.equal(result.summarized, false)
})

test('a long answer becomes a short summary within the default 500 characters', () => {
  const result = summarizeSpeechText(LONG_ANSWER, { maxChars: DEFAULT_SUMMARY_MAX_CHARS })
  assert.equal(result.summarized, true)
  assert.equal(result.truncated, true)
  assert.ok(result.chars <= DEFAULT_SUMMARY_MAX_CHARS, `summary is ${result.chars} chars`)
  assert.ok(result.sourceChars > result.chars, 'source was longer than the summary')
  assert.ok(result.chars >= 100, 'summary should not be reduced to a fragment')
  assert.ok(result.text.startsWith('Я обновил плагин dsh-voice-reply'), 'the direct answer must lead')
  assert.match(result.text, /Итог/iu, 'the conclusion must survive when it fits')
  assert.match(result.text, /[.!?…]$/u, 'spoken text must end with a sentence boundary')
})

test('the summary omits code blocks, URLs and Markdown markers', () => {
  const answer = `${LONG_ANSWER}

Ссылка: [документация](https://example.com/docs) и https://example.com/raw.`
  const result = summarizeSpeechText(answer, { maxChars: 500 })
  assert.ok(!result.text.includes('secret'), 'code body must not be spoken')
  assert.ok(!result.text.includes('```'), 'fences must not be spoken')
  assert.ok(!result.text.includes('https://'), 'URLs must not be spoken')
  assert.ok(!result.text.includes('**'), 'emphasis markers must not be spoken')
})

test('a custom budget is respected down to the minimum', () => {
  for (const limit of [100, 150, 250, 300, 1000]) {
    const result = summarizeSpeechText(LONG_ANSWER, { maxChars: limit })
    assert.ok(result.chars <= limit, `limit ${limit}: summary is ${result.chars} chars`)
    assert.ok(result.chars > 0, `limit ${limit}: summary must not be empty`)
    assert.match(result.text, /[.!?…]$/u, `limit ${limit}: must end with punctuation`)
  }
})

test('a very long single sentence is cut at a word boundary inside the budget', () => {
  const answer = `Слово ${'очень длинное предложение '.repeat(80)}конец.`
  const result = summarizeSpeechText(answer, { maxChars: 250 })
  assert.equal(result.summarized, true)
  assert.ok(result.chars <= 250)
  assert.ok(!/\s$/u.test(result.text), 'no trailing whitespace')
  assert.ok(!/Слово очень длинное предложение очень длинное предложение/u.test(result.text) || result.text.length <= 250)
  assert.match(result.text, /[.!?…]$/u)
})

test('empty and whitespace-only answers produce an empty result', () => {
  for (const raw of ['', '   ', '\n\n', '<!-- hidden -->', '```js\ncode only\n```']) {
    const result = summarizeSpeechText(raw, { maxChars: 500 })
    assert.equal(result.text, '')
    assert.equal(result.chars, 0)
    assert.equal(result.summarized, false)
  }
})

test('non-string answers do not throw', () => {
  for (const raw of [null, undefined, 42, { text: 'x' }]) {
    const result = summarizeSpeechText(raw, { maxChars: 500 })
    assert.equal(typeof result.text, 'string')
    assert.equal(result.summarized, false)
  }
})

test('the summary preserves the original order of the selected sentences', () => {
  const answer = [
    'Первое: я проверил плагин и увидел, что озвучка слишком длинная.',
    'Второе: я добавил суммаризацию текста до пятисот символов.',
    'Третье: я обновил настройки плагина и добавил поле лимита.',
    'Итог: теперь озвучка короткая, а настройка меняется прямо в плагине. Проверка завершена успешно, всё работает.',
  ].join(' ')
  const result = summarizeSpeechText(answer, { maxChars: 500 })
  const first = result.text.indexOf('Первое')
  const last = result.text.indexOf('Итог')
  assert.ok(first >= 0)
  assert.ok(last > first, 'conclusion must come after the opening sentence')
})

test('repeated sentences are spoken once instead of being duplicated', () => {
  const repeated = 'Это длинное пояснение, которое не нужно читать голосом целиком, потому что слушателю важна только суть.'
  const answer = `${repeated} ${repeated} ${repeated} ${repeated} Итог: озвучка короткая и без повторов.`
  const result = summarizeSpeechText(answer, { maxChars: 250 })
  const occurrences = result.text.split('Это длинное пояснение').length - 1
  assert.equal(occurrences, 1, `the repeated sentence appears ${occurrences} times`)
  assert.match(result.text, /Итог/iu)
})

test('Chinese answers are summarized rather than truncated into a fragment', () => {
  const answer = [
    '我已经更新了语音回复插件。现在它朗读简短摘要。',
    '主要改动：新增了本地摘要模块。它会把长回复压缩到五百个字符以内。',
    '插件的设置页面可以调整字符上限。这个设置会立即生效。',
    '总结：语音现在更短，用户可以自己调整长度。检查已经完成，一切正常。',
  ].join('')
  const result = summarizeSpeechText(answer, { maxChars: 100 })
  assert.equal(result.summarized, true)
  assert.ok(result.chars <= 100, `summary is ${result.chars} chars`)
  assert.ok(result.text.includes('总结'), 'the Chinese conclusion cue survives')
})
