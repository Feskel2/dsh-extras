/**
 * dsh-voice-reply — extractive spoken summaries.
 *
 * A full assistant answer is written to be read, not heard: it contains code,
 * tables, long enumerations and asides. Speaking 4000 characters takes minutes,
 * so the host half first turns the answer into a short **spoken summary** whose
 * length is bounded by the user-configurable `summaryMaxChars` (500 by default).
 *
 * The summary is extractive and dependency-free: the answer is split into
 * sentence-sized units (headings, list items and prose are handled separately),
 * units are ranked by term frequency, position, structural role and spoken
 * "conclusion" cues, near-duplicates are suppressed, and the best units are
 * joined in the original document order under the character budget. No model
 * call and no network access are involved, so speech starts immediately and the
 * summary is reproducible for the audio cache.
 *
 * Only `stripMarkdownForSpeech` from the TTS engine is reused; this module has
 * no I/O and no Node-only imports.
 */
import { stripMarkdownForSpeech } from './yandex-tts.js'

/** Default maximum number of characters in one spoken summary. */
export const DEFAULT_SUMMARY_MAX_CHARS = 500

/** Smallest allowed summary budget (the plugin settings enforce the same). */
export const MIN_SUMMARY_MAX_CHARS = 100

/** Largest allowed summary budget (the plugin settings enforce the same). */
export const MAX_SUMMARY_MAX_CHARS = 2000

/** Step offered by the plugin settings control. */
export const SUMMARY_STEP = 50

/**
 * Coerce a user/config value into a supported summary budget.
 *
 * @param {unknown} value - candidate (number, numeric string or anything).
 * @returns {number} integer inside `[100, 2000]`; the default for unusable input.
 */
export function clampSummaryMaxChars(value) {
  if (value === undefined || value === null) return DEFAULT_SUMMARY_MAX_CHARS
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_SUMMARY_MAX_CHARS
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return DEFAULT_SUMMARY_MAX_CHARS
  return Math.round(Math.min(MAX_SUMMARY_MAX_CHARS, Math.max(MIN_SUMMARY_MAX_CHARS, number)))
}

/** Words that carry no selection signal in Russian/English answers. */
const STOP_WORDS = new Set(
  (
    'это этот эта эти того тому тем котором которая которое которые который которых ' +
    'как так так же что чтобы для при или если есть уже ещё еще только можно нужно ' +
    'будет будут были было быть все всё весь вся всех его она они оно мы вы я ты их ' +
    'его ее её себя свой свои своя который которая которые которое этот эта эти тот ' +
    'та те там тут здесь также потом затем сейчас очень более менее надо даже через ' +
    'между после перед над под без про из от до по на во не ни а и но да ли же бы то ' +
    'than then that this these those the and or but for with from into onto over ' +
    'under about above below not you your our their its his her they them we us '
  ).split(/\s+/u),
)

/** Words that usually mark a conclusion, a decision or a result worth speaking. */
const CUE_WORDS = Object.freeze([
  'итог',
  'вывод',
  'главн',
  'важн',
  'суть',
  'кратко',
  'результат',
  'рекоменд',
  'нужно',
  'следует',
  'готово',
  'сделано',
  'добавил',
  'обновил',
  'исправил',
  'исправлен',
  'изменен',
  'изменён',
  'работает',
  'получилось',
  'проблем',
  'решени',
  'причин',
  'поэтому',
  'значит',
  'теперь',
  'осталось',
  'дальше',
  'преимуществ',
  'недостат',
  'стоимост',
  'срок',
  'риск',
  'провер',
  '总结',
  '结论',
  '重要',
  '结果',
  '完成',
  '修复',
  '更新',
  '建议',
  'summary',
  'conclusion',
  'important',
  'result',
  'recommend',
  'fixed',
  'added',
  'updated',
  'works',
  'next',
])

/** Sentence openings that are usually filler in a spoken abstract. */
const META_START = /^(?:я |сейчас|давайте|кстати|вот |ниже |дальше |для начала|разумеется|конечно|我|现在|首先|其实)/iu

/**
 * Known abbreviations whose dots must not end a sentence.
 * Matched dots are temporarily replaced with a private-use character.
 */
const ABBREVIATIONS =
  /\b(?:т\.\s*[дпе]\.|т\.е\.|т\.к\.|см\.|напр\.|рис\.|стр\.|гл\.|табл\.|др\.|проч\.|им\.|ул\.|кв\.|руб\.|коп\.|шт\.|мин\.|сек\.|e\.g\.|i\.e\.|etc\.|vs\.|Dr\.|Mr\.|Mrs\.)/giu

/** Character used to protect abbreviation dots during sentence splitting. */
const PROTECTED_DOT = '\u0001'

/** A sentence boundary that is followed by a plausible sentence opening. */
const SENTENCE_BOUNDARY = /(?<=[.!?…。！？])(?=\s*[«"'([]?[A-ZА-ЯЁ0-9\u3400-\u9fff])/u

/** A fenced code block (closed or unterminated) that must not be spoken. */
const FENCE_RE = /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$/gu

/**
 * Split plain text into sentences, protecting common abbreviations.
 *
 * @param {string} text - plain text of one line or paragraph.
 * @returns {string[]} trimmed sentences (may be empty).
 */
function splitSentences(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const protectedText = text.replace(ABBREVIATIONS, (match) => match.replaceAll('.', PROTECTED_DOT))
  return protectedText
    .split(SENTENCE_BOUNDARY)
    .map((part) => part.replaceAll(PROTECTED_DOT, '.').trim())
    .filter((part) => part !== '')
}

/**
 * Turn tokenizer words from one unit into a lower-case word list without
 * stop words and very short fragments.
 *
 * @param {string} text - unit text.
 * @returns {string[]} significant words.
 */
function tokenize(text) {
  // Latin/Cyrillic words of three or more characters, plus one token per CJK
  // ideograph (Chinese has no word spaces and each character carries meaning).
  const matches = String(text).toLowerCase().match(/[a-zа-яё0-9]{3,}|[\u3400-\u9fff]/gu)
  if (matches === null) return []
  const words = []
  for (const word of matches) {
    if (!STOP_WORDS.has(word)) words.push(word)
  }
  return words
}

/**
 * Split a raw Markdown answer into sentence-sized selection units while keeping
 * the document structure: headings are skipped (a heading is a label, not an
 * utterance), list items and prose each become units.
 *
 * @param {unknown} raw - assistant answer (Markdown).
 * @returns {Array<{ text: string, list: boolean, order: number, words: string[], wordSet: Set<string> }>} units.
 */
function extractUnits(raw) {
  let source = String(raw ?? '').replace(/\r\n?/g, '\n')
  source = source.replace(/<!--[\s\S]*?-->/gu, '\n')
  source = source.replace(FENCE_RE, '\n')

  /** @type {Array<{ text: string, list: boolean, order: number, words: string[], wordSet: Set<string> }>} */
  const units = []
  let order = 0
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (/^(?:[-*_][ \t]*){3,}$/u.test(line)) continue
    if (/^#{1,6}[ \t]+/u.test(line)) continue
    const list = /^(?:[-*+]|\d{1,3}[.)])[ \t]+/u.test(line)
    const clean = stripMarkdownForSpeech(line)
    if (clean === '') continue
    const sentences = splitSentences(clean)
    for (const sentence of sentences) {
      // Fragments shorter than a few characters only add noise when spoken.
      if (sentence.length < 10) continue
      const words = tokenize(sentence)
      if (words.length === 0) continue
      units.push({ text: sentence, list, order: order++, words, wordSet: new Set(words) })
    }
  }
  return units
}

/**
 * Score one unit as a candidate for the spoken summary.
 *
 * @param {ReturnType<typeof extractUnits>[number]} unit - candidate.
 * @param {number} index - position in the document.
 * @param {number} total - number of units.
 * @param {Map<string, number>} frequency - document term frequency.
 * @returns {number} score (higher is better).
 */
function scoreUnit(unit, index, total, frequency) {
  let score = 0
  for (const word of unit.wordSet) score += Math.min(6, frequency.get(word) ?? 0)
  score /= Math.sqrt(unit.words.length)

  // The opening sentence is usually the direct answer; the closing sentence is
  // often the conclusion ("Готово", "Итог"). Reward both, gently.
  if (index === 0) score += 7
  else if (index === 1) score += 2.5
  if (index === total - 1) score += 4
  else if (index === total - 2) score += 1.5

  const lower = unit.text.toLowerCase()
  let cues = 0
  for (const cue of CUE_WORDS) {
    if (lower.includes(cue)) cues += 1
  }
  score += Math.min(5, cues * 1.8)

  if (unit.list) score += 0.6

  const length = unit.text.length
  if (length >= 40 && length <= 220) score += 1.5
  else if (length > 320) score -= 2.5
  else if (length < 20) score -= 1

  if (META_START.test(unit.text)) score -= 2
  // A lead-in ending with a colon introduces a list; the list items follow.
  if (/:$/u.test(unit.text)) score -= 1.5

  return score
}

/**
 * Jaccard similarity between one unit and the already selected units.
 *
 * @param {ReturnType<typeof extractUnits>[number]} unit - candidate.
 * @param {number[]} selected - selected unit indexes.
 * @param {ReturnType<typeof extractUnits>} units - all units.
 * @returns {number} 0..1 maximum similarity.
 */
function maxSimilarity(unit, selected, units) {
  if (selected.length === 0 || unit.wordSet.size === 0) return 0
  let best = 0
  for (const index of selected) {
    const other = units[index].wordSet
    if (other.size === 0) continue
    let intersection = 0
    for (const word of unit.wordSet) {
      if (other.has(word)) intersection += 1
    }
    const union = unit.wordSet.size + other.size - intersection
    if (union > 0) best = Math.max(best, intersection / union)
  }
  return best
}

/**
 * Cut text to a hard character limit, preferring a sentence boundary and then a
 * word boundary; the result never cuts a word in half.
 *
 * @param {string} text - candidate text.
 * @param {number} limit - maximum characters.
 * @returns {string} fitted text (may be empty only when input was empty).
 */
function fitToLimit(text, limit) {
  const trimmed = String(text).trim()
  const budget = Math.max(1, Math.floor(limit))
  if (trimmed.length <= budget) return trimmed

  // Reserve one character for a final period added by ensureSentenceEnd().
  const slice = trimmed.slice(0, Math.max(1, budget - 1))
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('… '),
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
  )
  if (sentenceEnd >= Math.floor(slice.length * 0.5)) return ensureSentenceEnd(slice.slice(0, sentenceEnd + 1))

  const wordEnd = slice.lastIndexOf(' ')
  if (wordEnd >= Math.floor(slice.length * 0.5)) return ensureSentenceEnd(slice.slice(0, wordEnd))
  return ensureSentenceEnd(slice)
}

/**
 * Make spoken text end with a period (removing dangling clause punctuation).
 *
 * @param {string} text - candidate.
 * @returns {string} text ending in `.`/`!`/`?`/`…`.
 */
function ensureSentenceEnd(text) {
  const trimmed = String(text).trim().replace(/[,;:—–-]+$/u, '').trim()
  if (trimmed === '') return ''
  if (/[.!?…。！？]$/u.test(trimmed)) return trimmed
  return `${trimmed}.`
}

/**
 * Select and join summary units under the character budget.
 *
 * @param {ReturnType<typeof extractUnits>} units - document units.
 * @param {number} maxChars - character budget.
 * @returns {string} summary text (possibly empty).
 */
function buildSummary(units, maxChars) {
  if (units.length === 0) return ''
  const budget = Math.max(1, maxChars)
  const frequency = new Map()
  for (const unit of units) {
    for (const word of unit.wordSet) frequency.set(word, (frequency.get(word) ?? 0) + 1)
  }
  const scores = units.map((unit, index) => scoreUnit(unit, index, units.length, frequency))
  const selected = []
  const chosen = new Set()
  let total = 0

  /**
   * Append one unit when it still fits and is not a near-duplicate of what is
   * already selected. Repeated list items or restated sentences add no value
   * when heard aloud.
   *
   * @param {number} index - unit index.
   * @returns {boolean} whether the unit was added.
   */
  const add = (index) => {
    const addition = (selected.length === 0 ? 0 : 1) + units[index].text.length
    if (total + addition > budget) return false
    if (selected.length > 0 && maxSimilarity(units[index], selected, units) >= 0.8) return false
    selected.push(index)
    chosen.add(index)
    total += addition
    return true
  }

  // The first unit is the direct answer and must lead the summary when it fits.
  add(0)

  // A closing conclusion is valuable even when it lacks cue words in the list.
  if (units.length > 1) {
    const last = units.length - 1
    const lower = units[last].text.toLowerCase()
    if (/(?:итог|вывод|главн|готово|сделано|решени|результат|провер|работ)/iu.test(lower)) add(last)
  }

  // Greedy maximal-marginal-relevance selection: score minus overlap with what
  // is already chosen, so the summary covers different points instead of
  // repeating one topic.
  for (let step = 0; step < 48; step += 1) {
    let best = -1
    let bestAdjusted = -Infinity
    for (let index = 1; index < units.length; index += 1) {
      if (chosen.has(index)) continue
      const addition = (selected.length === 0 ? 0 : 1) + units[index].text.length
      if (total + addition > budget) continue
      const similarity = maxSimilarity(units[index], selected, units)
      if (similarity >= 0.8) continue
      const adjusted = scores[index] - 3.5 * similarity
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted
        best = index
      }
    }
    if (best === -1) break
    add(best)
  }

  if (selected.length === 0) {
    let best = 0
    for (let index = 1; index < scores.length; index += 1) {
      if (scores[index] > scores[best]) best = index
    }
    return ensureSentenceEnd(fitToLimit(units[best].text, budget))
  }

  selected.sort((left, right) => left - right)
  const parts = []
  let length = 0
  for (const index of selected) {
    const text = units[index].text
    const addition = (parts.length === 0 ? 0 : 1) + text.length
    if (length + addition > budget) continue
    parts.push(text)
    length += addition
  }
  if (parts.length === 0) return ensureSentenceEnd(fitToLimit(units[selected[0]].text, budget))
  return ensureSentenceEnd(parts.join(' '))
}

/**
 * Prepare a short spoken version of one raw assistant answer.
 *
 * Answers that already fit the budget are returned cleaned but otherwise
 * untouched; longer answers become an extractive summary bounded by `maxChars`.
 *
 * @param {unknown} raw - raw assistant answer (Markdown).
 * @param {{ maxChars?: number }} [options] - summary budget.
 * @param {number} [options.maxChars] - maximum speech characters (default 500,
 *   clamped to 100..2000).
 * @returns {{ text: string, chars: number, sourceChars: number, summarized: boolean, truncated: boolean }} result.
 *   `sourceChars` is the cleaned answer length; `summarized`/`truncated` are true
 *   when the source was longer than the budget.
 */
export function summarizeSpeechText(raw, { maxChars } = {}) {
  const limit = clampSummaryMaxChars(maxChars)
  const cleaned = stripMarkdownForSpeech(raw)
  if (cleaned === '') {
    return { text: '', chars: 0, sourceChars: 0, summarized: false, truncated: false }
  }
  if (cleaned.length <= limit) {
    return {
      text: cleaned,
      chars: cleaned.length,
      sourceChars: cleaned.length,
      summarized: false,
      truncated: false,
    }
  }

  const units = extractUnits(raw)
  const summary = buildSummary(units, limit)
  const text = summary === '' ? ensureSentenceEnd(fitToLimit(cleaned, limit)) : summary
  return {
    text,
    chars: text.length,
    sourceChars: cleaned.length,
    summarized: true,
    truncated: true,
  }
}
