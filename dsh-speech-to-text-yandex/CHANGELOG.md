# Changelog

## 0.1.0 — 2026-11-06

- First public package of the DSH speech-to-text provider for Yandex SpeechKit REST v1.
- Registers the `yandex-speechkit` cloud provider for the built-in Voice input and makes it the default via `cordis.patch.yml`.
- Splits recordings longer than 28 seconds at quiet boundaries, stitches the recognized text, and keeps each request within the SpeechKit limits (28 s / 900 KiB).
- Adds the `YANDEX_STT_API_KEY`, `YANDEX_STT_FOLDER_ID` and `YANDEX_STT_IAM_TOKEN` environment variables (env over the local `plugin-config.json`).
- Ships `plugin-config.example.json` with empty credentials, a package license, an icon and English/Russian READMEs.
