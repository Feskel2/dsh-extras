# DSH Extras — русская версия

Небольшая коллекция плагинов для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH), которые мы сделали для своей ежедневной работы и теперь выкладываем
публично.

| Плагин | Что делает | Платформа | Установка |
|---|---|---|---|
| [`dsh-topmost-notify`](dsh-topmost-notify) | Нативное окно «поверх всех» + звук, когда агент завершил задачу; фокус не крадёт | Windows 10/11 | `dsh plugin --profile web add dsh-topmost-notify` |
| [`dsh-voice-reply`](dsh-voice-reply) | Озвучивает краткое содержание каждого финального ответа через Yandex SpeechKit TTS, кнопка 🔊 и своя страница настроек | DSH Web | `dsh plugin --profile web add dsh-voice-reply` |
| [`dsh-speech-to-text-yandex`](dsh-speech-to-text-yandex) | Облачный провайдер распознавания речи (`yandex-speechkit`) для штатного Voice input | DSH Web | `dsh plugin --profile web add dsh-speech-to-text-yandex` |

Каждый плагин — самостоятельный npm-пакет, который ставится как bundle. После
установки перезапустите `dsh web` (bundle-слои монтируются при старте) и
откройте напечатанный URL.

### Установка из tarball релиза

Пока пакетов нет в npm, можно скачать `.tgz` из
[последнего релиза](https://github.com/Feskel2/dsh-extras/releases/latest) и
поставить его по пути:

```sh
dsh plugin --profile web add ./dsh-topmost-notify.tgz
```

## Требования

- DSH `>=0.2.2-rc.1 <0.3.0-0`, профиль `web`;
- Node.js `>=24.9.0` (требование рантайма DSH);
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
