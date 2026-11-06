# DSH Extras

A small collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) that we built for our own daily work and now share publicly.

| Plugin | What it does | Platform | Install |
|---|---|---|---|
| [`dsh-topmost-notify`](dsh-topmost-notify) | Native always-on-top window + chime when the agent finishes a task or needs an answer; per-kind display time and MP3/WAV sound, its own settings page, never steals focus | Windows 10/11 | GitHub tarball — [install guide](docs/install.md) |
| [`dsh-voice-reply`](dsh-voice-reply) | Reads a short spoken summary of every finished answer with Yandex SpeechKit TTS; replay button and its own settings page | DSH Web | GitHub tarball — [install guide](docs/install.md) |
| [`dsh-speech-to-text-yandex`](dsh-speech-to-text-yandex) | Cloud speech-to-text provider (`yandex-speechkit`) for the built-in Voice input | DSH Web | GitHub tarball — [install guide](docs/install.md) |

Each plugin is an independent package that installs as a DSH bundle from a
GitHub release tarball. After installing, restart `dsh web` (bundles are mounted
at boot) and open the URL it prints.

## Install (GitHub, no npm)

There is no npm package and no npm account is needed. Install any plugin
straight from the v1.1.0 release — one command per plugin:

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

Use the explicit version tag, not `latest`: pnpm can fail with
`ERR_PNPM_MISSING_TARBALL_INTEGRITY` on the redirect. If a later install in the
same profile fails with that error (a pnpm cache issue, not a bad tarball), use
the downloaded-file route in the
[Install guide](docs/install.md#6-install-several-plugins). You can also
download a `.tgz` and install it by path:

```powershell
dsh plugin --profile web add ".\dsh-topmost-notify.tgz"
```

Step-by-step instructions, updates, removal, offline install and
troubleshooting: **[Install guide](docs/install.md)** ·
**[Инструкция по установке](docs/install.ru.md)**.

npm publication is not planned for the near future. If the packages ever
appear on npm, the only change will be a shorter command without the URL.

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0-0`, profile `web`;
- Node.js `>=24.9.0` (the DSH runtime requirement);
- pnpm on `PATH` (`dsh plugin` forwards package operations to pnpm);
- per plugin: Windows 10/11 + PowerShell 5.1 (`dsh-topmost-notify`), a Yandex
  Cloud account with SpeechKit enabled (`dsh-voice-reply`,
  `dsh-speech-to-text-yandex`).

## Yandex SpeechKit setup

Both voice plugins need a Yandex Cloud SpeechKit credential: a folder, a
service account with `ai.speechkit-tts.user` and/or `ai.speechkit-stt.user`,
and an API key with the matching scope. The step-by-step guide covers the
console walkthrough, the three ways to deliver the key, verification, logs,
troubleshooting and rotation:

- [Yandex SpeechKit setup](docs/yandex-speechkit-setup.md) (English)
- [Настройка Yandex SpeechKit](docs/yandex-speechkit-setup.ru.md) (Russian)

## Security

- No API keys, tokens or personal data are stored in this repository. Both
  voice plugins read credentials from environment variables
  (`YANDEX_TTS_API_KEY`, `YANDEX_STT_API_KEY`, …) or from a local
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
