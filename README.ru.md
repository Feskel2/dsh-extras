# DSH Extras — русская версия

Небольшая коллекция плагинов для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH), которые мы сделали для своей ежедневной работы и теперь выкладываем
публично.

| Плагин | Что делает | Платформа | Установка |
|---|---|---|---|
| [`dsh-topmost-notify`](dsh-topmost-notify) | Нативное окно «поверх всех» + звук, когда агент завершил задачу или нужен ответ; своя длительность и свой MP3/WAV-звук для каждого вида, отдельная страница настроек; фокус не крадёт | Windows 10/11 | Tarball с GitHub — [инструкция](docs/install.ru.md) |
| [`dsh-voice-reply`](dsh-voice-reply) | Озвучивает краткое содержание каждого финального ответа через Yandex SpeechKit TTS, кнопка 🔊 и своя страница настроек | DSH Web | Tarball с GitHub — [инструкция](docs/install.ru.md) |
| [`dsh-speech-to-text-yandex`](dsh-speech-to-text-yandex) | Облачный провайдер распознавания речи (`yandex-speechkit`) для штатного Voice input | DSH Web | Tarball с GitHub — [инструкция](docs/install.ru.md) |

Каждый плагин — самостоятельный пакет, который ставится как bundle DSH из
tarball'а GitHub-релиза. После установки перезапустите `dsh web` (bundle-слои
монтируются при старте) и откройте напечатанный URL.

## Установка с GitHub (без npm)

npm-пакета нет, аккаунт npm не нужен. Ставьте плагин прямо из релиза v1.1.0 —
по одной команде на плагин:

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

Указывайте явный тег версии, а не `latest`: pnpm может упасть с
`ERR_PNPM_MISSING_TARBALL_INTEGRITY` на редиректе. Если более поздняя установка
в тот же профиль падает с этой ошибкой (проблема кэша pnpm, а не tarball'а),
используйте локальные файлы, как описано в
[инструкции](docs/install.ru.md#6-установка-нескольких-плагинов). Можно также
скачать `.tgz` и поставить его по пути:

```powershell
dsh plugin --profile web add ".\dsh-topmost-notify.tgz"
```

Пошаговая инструкция, обновление, удаление, офлайн-установка и разбор ошибок:
**[Инструкция по установке](docs/install.ru.md)** ·
**[Install guide](docs/install.md)**.

Публикация в npm в ближайшее время не планируется. Если пакеты когда-нибудь
появятся в npm, единственным изменением будет короткая команда без URL.

## Требования

- DSH `>=0.2.2-rc.1 <0.3.0-0`, профиль `web`;
- Node.js `>=24.9.0` (требование рантайма DSH);
- pnpm в `PATH` (`dsh plugin` передаёт операции с пакетами в pnpm);
- по плагину: Windows 10/11 + PowerShell 5.1 (`dsh-topmost-notify`), аккаунт
  Yandex Cloud с включённым SpeechKit (`dsh-voice-reply`,
  `dsh-speech-to-text-yandex`).

## Настройка Yandex SpeechKit

Обоим голосовым плагинам нужен доступ к Yandex Cloud SpeechKit: каталог,
сервисный аккаунт с ролью `ai.speechkit-tts.user` и/или
`ai.speechkit-stt.user` и API-ключ с соответствующей областью действия.
Пошаговый гайд: консоль, три способа доставить ключ, проверка, журналы,
разбор ошибок и ротация:

- [Настройка Yandex SpeechKit](docs/yandex-speechkit-setup.ru.md) (русский)
- [Yandex SpeechKit setup](docs/yandex-speechkit-setup.md) (английский)

## Безопасность

- В репозитории нет ключей, токенов и личных данных. Оба голосовых плагина
  берут доступы из переменных окружения (`YANDEX_TTS_API_KEY`,
  `YANDEX_STT_API_KEY`, …) или из локального `plugin-config.json`,
  который в `.gitignore`; в пакетах поставляется только
  `plugin-config.example.json` с заглушками.
- Телеметрии нет. Сеть используют только голосовые плагины и только к
  эндпоинтам Yandex SpeechKit; `dsh-topmost-notify` в сеть не ходит.

## Структура репозитория

```text
dsh-topmost-notify/         нативное уведомление о завершении задачи (Windows)
dsh-voice-reply/            озвучка ответов (Yandex SpeechKit)
dsh-speech-to-text-yandex/  провайдер распознавания речи (Yandex SpeechKit)
```

В каждой папке свои `package.json`, `README.md` (английский), `README.ru.md`
(русский), `LICENSE` и `CHANGELOG.md`.

## Лицензия

MIT — см. [LICENSE](LICENSE). Copyright (c) 2026 Feskel2.
