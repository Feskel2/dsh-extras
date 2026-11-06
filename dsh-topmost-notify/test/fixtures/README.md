# test/fixtures — тестовые аудиофайлы

## `valid-clip.mp3`

Маленький **настоящий** MP3 (16 718 байт, 1.0 с, 44 100 Гц, моно, 128 кбит/с,
две ноты-колокольчика A5 → E6). Нужен, чтобы `host/notify.ps1` и `host/test-notify.ps1`
проверяли реальное воспроизведение через `System.Windows.Media.MediaPlayer`, а не
только проверку сигнатуры.

- заголовок: `FF FB 90 C4` (MPEG-1 Layer III, кадровый синхробайт) — тот же признак,
  по которому `index.mjs` принимает загруженный MP3;
- сгенерирован детерминированно кодировщиком `@breezystack/lamejs` (форк `lamejs`,
  работающий на Node 26; оригинальный `lamejs` падает с `MPEGMode is not defined`):

```js
// npm i --prefix <tmp> @breezystack/lamejs
const lamejs = await import('<tmp>/node_modules/@breezystack/lamejs/dist/lamejs.js')
const encoder = new lamejs.Mp3Encoder(1, 44100, 128)   // 1.0 с Int16-сэмплов -> flush()
```

Пересоздавать не требуется: файл детерминированный и лежит в репозитории;
тесты используют его только на чтение (`host/test-notify.ps1` берёт путь
`<пакет>/test/fixtures/valid-clip.mp3`, `test/host-api.test.mjs` — нет).
