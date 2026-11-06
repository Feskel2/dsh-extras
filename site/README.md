# DSH Extras — plugin index and release tarballs

This GitHub Pages site hosts two things for [DSH Extras](https://github.com/Feskel2/dsh-extras):

- **`index.json`** — a format-1 plugin index for the built-in DSH **Discover** tab.
  In DSH open **Plugins → Experimental plugins → Custom plugin indexes**, enable
  the feature, then **Discover → Add index source** and paste:

  `https://feskel2.github.io/dsh-extras/index.json`

- **`tarballs/`** — the same plugin packages as the GitHub release (`dsh-topmost-notify.tgz`,
  `dsh-voice-reply.tgz`, `dsh-speech-to-text-yandex.tgz`), served with stable URLs:

  ```powershell
  dsh plugin --profile web add https://feskel2.github.io/dsh-extras/tarballs/dsh-topmost-notify.tgz
  ```

  Then restart `dsh web`.

Installation guide: https://github.com/Feskel2/dsh-extras/blob/main/docs/install.md
(in Russian: `docs/install.ru.md`).

Yandex SpeechKit keys are not shipped with the plugins — see
https://github.com/Feskel2/dsh-extras/blob/main/docs/yandex-speechkit-setup.md
