# Changelog

## 1.1.0 — 2026-11-06

- The plugin now has its own settings page in **Plugins → Notifications →
  `topmost-notify` → chevron** (a `plugins.row.config` page), with live-apply
  config writes and no `dsh web` restart for settings.
- Display time is configured separately for the two card kinds:
  `durationMs` ("task finished", default 1000 ms) and `questionDurationMs`
  ("answer needed", default 1500 ms), 0.3–10 s with sliders and number inputs.
- Sound is configured per kind: `completedSoundEnabled` /
  `questionSoundEnabled`, and either the bundled chime or any user **MP3/WAV**
  file (`completedSoundFile` / `questionSoundFile`). The page uploads the file,
  shows its name and can preview it or show a sample window before saving.
- `host/notify.ps1` plays MP3 through WPF `MediaPlayer` (WAV keeps
  `SoundPlayer`), gains `-PreviewSound`, and plays a custom sound to its end
  (capped at ~20 s) while the bundled chime keeps the short 350 ms tail.
- New local HTTP API under `/dsh-topmost-notify`: `status`, `sounds` upload,
  `reset-sound`, `preview`, `preview-sound`. Uploads are limited to 12 MiB,
  checked by extension and file signature, stored in `sounds/` next to the
  installed host module, and preview paths are restricted to `sounds/` and
  `host/`.
- Added bundle display metadata for English, Russian and Chinese
  (`locale/*.json` → `meta.title` / `meta.description`).
- `install.ps1` now installs the package as a **bundle**
  (`dsh.profile.bundles` + dependency link) instead of a patch `insert` row,
  migrates the older local `turn-notify` layout, and keeps custom sounds.
- Tests: `test/host-api.test.mjs` (local HTTP API), expanded host smoke test
  for the per-kind fields, expanded client smoke test for the settings page.

## 1.0.0 — 2026-11-06

- First public release as `dsh-topmost-notify` (the plugin was developed as the
  local `turn-notify` package; the npm name `dsh-turn-notify` was already taken).
- Native always-on-top Windows notification on a completed turn: session title,
  one-line answer excerpt and a bundled WAV chime, auto-closing after ~1 s
  without stealing focus.
- Separate "answer needed" card when the agent calls `ask_user_question`,
  deduplicated per tool call.
- Settings → General toggle, per-chat mute bell in the chat header, and
  `durationMs` / `sound` / excerpt options in `cordis.patch.yml`.
- Bundle manifest (`dsh.bundle.patch` → `cordis.patch.yml`) so
  `dsh plugin --profile web add dsh-topmost-notify` activates the plugin.
- Bounded diagnostic log `host/notify-debug.log` next to the installed script.
