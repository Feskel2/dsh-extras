# Changelog

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
