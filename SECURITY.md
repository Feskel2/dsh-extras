# Security

## Reporting a vulnerability

Open a private security advisory on GitHub
(`Security` → `Report a vulnerability`) or contact the maintainer through the
repository. Please do not open a public issue for an unfixed vulnerability.

## How credentials are handled

The two Yandex SpeechKit plugins (`dsh-voice-reply`,
`dsh-speech-to-text-yandex`) need a Yandex Cloud API key or IAM token. The
policy is the same for both:

1. **Environment variables are the primary source** (they win over files):
   - `dsh-voice-reply` — `YANDEX_TTS_API_KEY`, `YANDEX_TTS_FOLDER_ID`,
     `YANDEX_TTS_IAM_TOKEN`;
   - `dsh-speech-to-text-yandex` — `YANDEX_STT_API_KEY`,
     `YANDEX_STT_FOLDER_ID`, `YANDEX_STT_IAM_TOKEN` (the legacy names
     `YANDEX_SPEECHKIT_*` and `YC_*` are still recognized).
2. **A local `plugin-config.json`** next to the installed plugin is supported
   for convenience, but it is git-ignored and never shipped: the packages
   contain only `plugin-config.example.json` with empty values.
3. Credentials are never written to diagnostics logs; the plugins log request
   outcomes, not headers or keys.

## Network access

- `dsh-topmost-notify` makes no network requests at all; it spawns a local
  `powershell.exe` with a script bundled in the package.
- `dsh-voice-reply` talks only to `tts.api.cloud.yandex.net`.
- `dsh-speech-to-text-yandex` talks only to `stt.api.cloud.yandex.net`.

Audio and text are sent to Yandex only when you explicitly trigger speech
synthesis or recognition. No telemetry, no analytics, no other endpoints.

## What runs on your machine

- `dsh-topmost-notify` launches `powershell.exe -File host/notify.ps1` (a WPF
  window plus `SoundPlayer`); the script is part of the package and is not
  downloaded at runtime.
- The voice plugins run inside the DSH host process and make HTTPS requests.
