# Changelog

All notable changes to the DSH Extras collection are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are per package (each plugin folder has its own `CHANGELOG.md`).

## 1.1.0 — 2026-11-06

### Added

- `dsh-topmost-notify` 1.1.0 — the plugin has its own settings page on the
  Plugins page: separate display time for the "task finished" and "answer
  needed" cards, a separate sound per kind (bundled chime or any user MP3/WAV
  uploaded from the page, with Listen / Show a sample window previews), card
  contents, and live-apply saves. `notify.ps1` plays MP3 through WPF
  `MediaPlayer` and gained `-PreviewSound`; a small local HTTP API serves the
  page (status, upload, reset, preview). The installer now registers the plugin
  as a bundle and migrates the older `turn-notify` layout.
- `dsh-voice-reply` 1.1.0 — the plugin settings page now chooses the voice
  **intonation** beside the voice and speed, offers only the intonations the
  selected voice supports, and the Preview button auditions the draft voice
  with the chosen intonation (`emotion`) and speed. The choice is persisted in
  `plugin-config.json` like the other UI preferences.

## 1.0.0 — 2026-11-06

### Added

- `dsh-topmost-notify` 1.0.0 — native always-on-top window and chime when a DSH
  task finishes; Settings → General toggle; per-chat mute bell.
- `dsh-voice-reply` 1.0.0 — final answers read aloud as a short spoken
  summary (500 characters by default, adjustable from 100 to 2000), replay
  button, on-disk audio cache, auto-speak preference and a plugin settings page.
- `dsh-speech-to-text-yandex` 0.1.0 — `yandex-speechkit` speech-to-text provider
  for the built-in Voice input, long recordings split at pauses.
