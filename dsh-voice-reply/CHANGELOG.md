# Changelog

## 1.1.0 — 2026-11-06

- Adds a **voice intonation** selector to the plugin settings page next to the
  voice dropdown: each voice offers only the Yandex `emotion` values it
  supports (`neutral`, `good`, `evil`, `whisper`, `friendly`); voices without
  intonations say so and disable the control.
- The Preview button now auditions the draft voice **with the chosen intonation**
  and speed, and `/preview` accepts `emotion`; the sample is cached per
  voice|emotion|speed, so repeated auditioning is free.
- `GET /status` returns the accepted `emotion` and `emotionOptions`; `POST
  /preferences` accepts and validates `emotion` (an unsupported value is
  rejected with the voice's actual list), and switching to a voice without
  intonations never sends a stale value to Yandex.
- The intonation is written to `plugin-config.json` like the other UI-owned
  preferences and applies without a `dsh web` restart.

## 1.0.0 — 2026-11-06

- Speaks a short, locally extracted summary of the assistant's finalized answer
  with Yandex SpeechKit TTS v1 (default voice `marina`, MP3, 500-character
  budget adjustable from 100 to 2000).
- Adds a speaker button to every finalized answer for replay, plus an ambient
  "reading the answer aloud…" chip with a stop button while audio plays.
- Adds the `autoSpeak` switch in **Settings → General** and the plugin's own
  settings page (summary budget, voice, speed and `autoSpeak`, with a short
  voice/speed preview before saving); replays come from the on-disk audio cache
  and do not call Yandex again.
- Reads credentials from `YANDEX_TTS_API_KEY`, `YANDEX_TTS_IAM_TOKEN` and
  `YANDEX_TTS_FOLDER_ID` (environment wins) or from a git-ignored local
  `plugin-config.json` that is re-read on every request, so a new key needs no
  `dsh web` restart.
- Ships as a DSH bundle (`cordis.patch.yml` + `dsh.bundle.patch`) with English,
  Russian and Chinese display metadata, under the MIT license.
