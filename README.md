# DSH Extras

A small collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) that we built for our own daily work and now share publicly.

| Plugin | What it does | Platform | Install |
|---|---|---|---|
| [`dsh-topmost-notify`](dsh-topmost-notify) | Native always-on-top window + chime when the agent finishes a task; never steals focus | Windows 10/11 | `dsh plugin --profile web add dsh-topmost-notify` |
| [`dsh-voice-reply`](dsh-voice-reply) | Reads a short spoken summary of every finished answer with Yandex SpeechKit TTS; replay button and its own settings page | DSH Web | `dsh plugin --profile web add dsh-voice-reply` |
| [`dsh-speech-to-text-yandex`](dsh-speech-to-text-yandex) | Cloud speech-to-text provider (`yandex-speechkit`) for the built-in Voice input | DSH Web | `dsh plugin --profile web add dsh-speech-to-text-yandex` |

Each plugin is an independent npm package that installs as a DSH bundle. After
installing, restart `dsh web` (bundles are mounted at boot) and open the URL it
prints.

### Install from a release tarball

Until the packages are on npm, grab a `.tgz` from the
[latest release](https://github.com/Feskel2/dsh-extras/releases/latest) and
install it by path:

```sh
dsh plugin --profile web add ./dsh-topmost-notify.tgz
```

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0-0`, profile `web`;
- Node.js `>=24.9.0` (the DSH runtime requirement);
- per plugin: Windows 10/11 + PowerShell 5.1 (`dsh-topmost-notify`), a Yandex
  Cloud account with SpeechKit enabled (`dsh-voice-reply`,
  `dsh-speech-to-text-yandex`).

## Security

- No API keys, tokens or personal data are stored in this repository. Both
  voice plugins read credentials from environment variables
  (`YANDEX_TTS_API_KEY`, `YANDEX_SPEECHKIT_API_KEY`, …) or from a local
  `plugin-config.json` that is git-ignored; only
  `plugin-config.example.json` with placeholders ships in the packages.
- None of the plugins sends telemetry. Network access is limited to Yandex
  SpeechKit endpoints in the two voice plugins; `dsh-topmost-notify` makes no
  network calls at all.

## Repository layout

```text
dsh-topmost-notify/         native completion notification (Windows)
dsh-voice-reply/            text-to-speech replies (Yandex SpeechKit)
dsh-speech-to-text-yandex/  speech-to-text provider (Yandex SpeechKit)
```

Each folder has its own `package.json`, `README.md` (English) and
`README.ru.md` (Russian), `LICENSE` and `CHANGELOG.md`.

## Development

```sh
cd dsh-voice-reply
node test/yandex-tts.test.mjs
npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Feskel2.
