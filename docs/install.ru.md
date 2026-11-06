# Установка плагинов DSH Extras без npm

DSH Extras — небольшая коллекция плагинов для
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Плагины распространяются как `.tgz`-файлы, прикреплённые к релизу на GitHub:
**npm-пакета нет, аккаунт npm не нужен**. Команда `dsh plugin` распаковывает
tarball в профиль DSH через pnpm — это единственный пакетный менеджер в цепочке.

Актуальный релиз —
[v1.1.0](https://github.com/Feskel2/dsh-extras/releases/tag/v1.1.0). В нём три
файла:

| Плагин | Tarball | Что добавляет |
|---|---|---|
| `dsh-topmost-notify` | `dsh-topmost-notify.tgz` | Окно поверх всех окон в Windows, когда задача завершена или агент задал вопрос |
| `dsh-voice-reply` | `dsh-voice-reply.tgz` | Озвучивает краткое содержание готовых ответов через Yandex SpeechKit TTS |
| `dsh-speech-to-text-yandex` | `dsh-speech-to-text-yandex.tgz` | Распознавание речи Yandex SpeechKit для штатного Voice input |

**Короткий путь** — выполните в PowerShell по одной команде, затем
перезапустите `dsh web`:

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

Дальше — подробно: что проверить до установки, как убедиться, что плагин
появился, как обновлять и удалять, что делать при ошибках. Если вторая команда
падает с `ERR_PNPM_MISSING_TARBALL_INTEGRITY`, сразу переходите к
[разделу 6](#6-установка-нескольких-плагинов): надёжное решение — локальные
файлы.

## Содержание

1. [Что понадобится](#1-что-понадобится)
2. [Откройте PowerShell](#2-откройте-powershell)
3. [Выберите профиль `web`](#3-выберите-профиль-web)
4. [Установите плагины](#4-установите-плагины)
5. [Перезапустите и проверьте](#5-перезапустите-и-проверьте)
6. [Установка нескольких плагинов](#6-установка-нескольких-плагинов)
7. [Обновление плагина](#7-обновление-плагина)
8. [Удаление плагина](#8-удаление-плагина)
9. [Установка офлайн](#9-установка-офлайн)
10. [После установки: ключ Yandex SpeechKit](#10-после-установки-ключ-yandex-speechkit)
11. [Если не работает](#11-если-не-работает)
12. [Краткая шпаргалка](#12-краткая-шпаргалка)

## 1. Что понадобится

| Требование | Зачем нужно | Как проверить |
|---|---|---|
| **Windows 10/11** | `dsh-topmost-notify` — нативное WPF-окно, работает только в Windows. Два голосовых плагина — плагины DSH Web, проверены на Windows 11. | — |
| **DSH `>=0.2.2-rc.1 <0.3.0-0`** | Плагины объявляют такую совместимость. Сборка 0.3 может их отклонить. | `dsh --version` |
| **Node.js `>=24.9.0`** | Требование рантайма DSH. | `node --version` |
| **pnpm в `PATH`** | `dsh plugin` передаёт `add`/`remove` в pnpm. Это не npm-зависимость плагинов и не требует аккаунта npm. | `pnpm --version` |
| **PowerShell 5.1 или новее** | Windows PowerShell 5.1 входит в Windows 10/11; команды ниже работают и в PowerShell 7. | `$PSVersionTable.PSVersion` |
| **Доступ к GitHub** | Установка одной командой скачивает tarball с релиза. Для машины без сети есть [офлайн-вариант](#9-установка-офлайн). | Откройте страницу релиза в браузере. |
| **Аккаунт Yandex Cloud** | Только для `dsh-voice-reply` и `dsh-speech-to-text-yandex`. Ключа внутри пакетов **нет**. | См. [«Настройка Yandex SpeechKit»](yandex-speechkit-setup.ru.md). |

Вам **не** понадобятся:

- аккаунт npm, токен npm или `npm publish`;
- клонирование этого репозитория;
- права администратора (плагины ставятся в профиль пользователя);
- компилятор и инструменты сборки — внутри tarball'ов готовый JavaScript.

> Публикация в npm в ближайшее время не планируется. Если пакеты когда-нибудь
> появятся в npm, единственным упрощением будет короткая команда вида
> `dsh plugin --profile web add dsh-topmost-notify`. До тех пор используйте
> `.tgz`-URL или скачанный `.tgz`-файл.

## 2. Откройте PowerShell

1. Нажмите **Win + X** и выберите **Терминал** или **Windows PowerShell**. Можно
   также нажать **Win**, набрать `PowerShell` и открыть **Windows PowerShell**.
2. Проверьте три команды, которые нужны DSH:

   ```powershell
   dsh --version
   node --version
   pnpm --version
   ```

   Вы должны увидеть версию DSH из линии `0.2.x`, Node.js `24.9.0` или новее и
   версию pnpm. Если какая-то команда не распознана, загляните в
   [раздел «Если не работает»](#11-если-не-работает), прежде чем продолжать.

3. Перейдите в удобную папку. В ней будут выполняться команды и могут лежать
   скачанные `.tgz`-файлы:

   ```powershell
   cd $env:USERPROFILE\Downloads
   ```

4. Вставляйте команды правой кнопкой мыши (или **Ctrl + V**). PowerShell
   выполняет строку после нажатия **Enter**. Кавычки вокруг URL можно не
   ставить, но с ними команда однозначнее.

`dsh web` может уже работать в другом терминале. Для установки это не мешает;
перезапустите его в [разделе 5](#5-перезапустите-и-проверьте). Не закрывайте
терминал с `dsh web` раньше времени: он печатает URL веб-интерфейса.

Если PowerShell отказывается запускать `dsh.ps1` из-за политики выполнения,
используйте `dsh.cmd` вместо `dsh` (оба лаунчера установлены рядом) или
посмотрите соответствующую строку в [разделе «Если не работает»](#11-если-не-работает).

## 3. Выберите профиль `web`

DSH хранит профили в `~/.dsh/profiles`. Эти плагины ставятся в профиль
**`web`** — тот, который запускает браузерный интерфейс `dsh web`. Поэтому во
всех командах есть:

```text
--profile web
```

Каталог профиля:

```text
%USERPROFILE%\.dsh\profiles\web
```

или, если задан `DSH_HOME`:

```text
%DSH_HOME%\profiles\web
```

Точный путь в PowerShell:

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
$profileDir
```

Заметки:

- Первая команда `dsh plugin --profile web add ...` сама создаст каталог
  профиля, если его ещё нет.
- Не используйте профиль `desktop`: приложение Desktop управляет своим
  профилем, а эти плагины описаны для `dsh web`.
- Править `package.json`, `cordis.patch.yml` и `pnpm-workspace.yaml` вручную не
  нужно. `dsh plugin` сам добавит зависимость и строку бандла.

## 4. Установите плагины

Все URL релиза устроены одинаково:

```text
https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/<плагин>.tgz
```

В URL указывайте **явную версию** `v1.1.0`. Не заменяйте её на `latest`:
GitHub перенаправляет `latest/download/...` на подписанный URL, и pnpm может
упасть с `ERR_PNPM_MISSING_TARBALL_INTEGRITY`. Явный тег стабилен и
воспроизводим. Когда выйдет новый релиз, замените `v1.1.0` на новый тег со
[страницы релизов](https://github.com/Feskel2/dsh-extras/releases).

Выполняйте команды **по одной** и ждите, пока pnpm напечатает `Done`. Если
очередная команда упала, разберитесь с ней до следующей. Если более поздняя
установка по URL падает с `ERR_PNPM_MISSING_TARBALL_INTEGRITY`, используйте
локальные файлы из [раздела 6](#6-установка-нескольких-плагинов).

### 4.1 `dsh-topmost-notify` — уведомления в Windows

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
```

Что появится после перезапуска:

- карточка поверх всех окон в правом верхнем углу, когда задача завершена;
- янтарная карточка, когда агент задаёт вопрос;
- колокольчик 🔔/🔕 в шапке чата и главный тумблер в
  **Settings → General**;
- своя страница настроек: **Плагины → «Уведомления о задачах» → строка
  `topmost-notify` → шеврон**. Там меняются длительность показа, свой MP3/WAV,
  есть кнопки «Прослушать» и «Показать окно».

Аккаунт и API-ключ не нужны. Нужна Windows 10/11.

### 4.2 `dsh-voice-reply` — озвучка ответов

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
```

Что появится после перезапуска:

- короткое звуковое резюме каждого готового ответа (Yandex SpeechKit TTS);
- кнопка 🔊 у каждого ответа (повтор берётся из локального кэша);
- страница настроек **Плагины → «Голосовые ответы» → «Настроить»**: длина
  озвучки, голос, интонация, скорость и автозапуск;
- выключатель **Settings → General → «Озвучивать ответы голосом»**.

Плагину нужен ключ Yandex SpeechKit. Без него он установится, но покажет
«Озвучивание не настроено». См.
[раздел 10](#10-после-установки-ключ-yandex-speechkit).

### 4.3 `dsh-speech-to-text-yandex` — распознавание речи Яндекса

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

Что появится после перезапуска:

- провайдер `yandex-speechkit` в **Плагины → «Голосовой ввод» → «Служба
  распознавания»**;
- распознавание записи в облаке, без подготовки локальной модели SenseVoice;
- автоматическая нарезка записей длиннее 28 секунд по тихим участкам.

Штатный bundle **Voice input** должен быть включён: плагин регистрирует только
службу распознавания, микрофонный интерфейс — часть DSH. Ключ Yandex SpeechKit
тоже нужен; см. [раздел 10](#10-после-установки-ключ-yandex-speechkit).

### 4.4 Необязательно: зеркало на GitHub Pages

Те же tarball'ы лежат на GitHub Pages:

```powershell
dsh plugin --profile web add "https://feskel2.github.io/dsh-extras/tarballs/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://feskel2.github.io/dsh-extras/tarballs/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://feskel2.github.io/dsh-extras/tarballs/dsh-speech-to-text-yandex.tgz"
```

Эти URL короче и обычно отвечают без редиректа. Зеркало Pages обновляется с
релиза; если совсем новый релиз ещё не попал на зеркало (404), используйте URL
релиза выше. Оба варианта отдают одни и те же tarball'ы. На момент проверки все
три URL Pages отвечали **200**.

Установка нескольких плагинов подряд с любого URL может упереться в проблему
целостности pnpm из [раздела 6](#6-установка-нескольких-плагинов). Надёжный
путь в этом случае — локальные файлы ниже.

### 4.5 Необязательно: установка скачанного `.tgz`

Если tarball уже скачан (например, из раздела **Assets** на странице релиза),
поставьте его по пути. Из папки с файлом:

```powershell
dsh plugin --profile web add ".\dsh-topmost-notify.tgz"
```

Абсолютный путь тоже подходит:

```powershell
dsh plugin --profile web add "$env:USERPROFILE\Downloads\dsh-topmost-notify.tgz"
```

Это самый надёжный вариант, особенно если плагинов несколько: pnpm записывает
хеш целостности для каждого локального файла, а URL-версия может потерять его
при переиспользовании кэша. Это же и офлайн-путь, и самый надёжный обход ошибки
`ERR_PNPM_MISSING_TARBALL_INTEGRITY` (см.
[раздел «Если не работает»](#11-если-не-работает)).

Держите `.tgz`-файлы в той же папке, пока не удалите или не обновите плагин: в
`package.json` записываются их пути, и pnpm может снова обратиться к ним при
изменении профиля. Если файла нет, `remove`/`add` может упасть с `ENOENT` ещё
до работы с пакетом.

### 4.6 После всех установок

Строки бандлов записываются сразу, но код плагинов загружается только при
старте `dsh web`. **Перезапустите `dsh web` один раз** после последней
установки — см. следующий раздел.

## 5. Перезапустите и проверьте

Бандлы монтируются при старте. Перезагрузки страницы недостаточно; настройки
внутри плагина перезапуска не требуют — только новый код плагина.

1. Найдите терминал, где работает `dsh web`, и нажмите **Ctrl + C**.
2. Запустите снова:

   ```powershell
   dsh web
   ```

3. Откройте напечатанный URL. Обычно это `http://127.0.0.1:3080`, но порт может
   отличаться; берите точный адрес из терминала.
4. Откройте **Плагины** и проверьте карточки/строки:

| Плагин | Где смотреть | Что доказывает, что всё работает |
|---|---|---|
| `dsh-topmost-notify` | **Плагины → «Уведомления о задачах»**, строка `topmost-notify` → шеврон | Страница настроек открывается; «Показать окно» рисует образец карточки; «Прослушать» играет сигнал; в **Settings → General** есть главный тумблер |
| `dsh-voice-reply` | **Плагины → «Голосовые ответы» → «Настроить»** | Страница настроек открывается; «Прослушать» играет пример после настройки ключа Яндекса; в **Settings → General** есть «Озвучивать ответы голосом» |
| `dsh-speech-to-text-yandex` | **Плагины → «Голосовой ввод»** | В списке служб распознавания есть **Yandex SpeechKit**; провайдер готов; после настройки ключа микрофон распознаёт речь |

Ещё можно спросить pnpm, что установлено в профиле:

```powershell
dsh plugin --profile web list --depth 0
```

Вы должны увидеть имена и версии (`dsh-topmost-notify@1.1.0`,
`dsh-voice-reply@1.1.0`, `dsh-speech-to-text-yandex@0.1.0`). Если список пуст,
команда ушла в другой профиль — проверьте `--profile web`.

Чтобы проверить уведомление целиком, отправьте короткое сообщение в чат и
дождитесь завершения хода. Карточка появляется примерно через две секунды после
завершения, а не мгновенно.

## 6. Установка нескольких плагинов

Все три плагина могут жить в одном профиле `web`. Ставьте их **по одному**, в
любом порядке, и перезапустите `dsh web` один раз в конце.

На чистом профиле установка тремя URL-командами обычно работает:

```powershell
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

Не запускайте две команды `dsh plugin` параллельно в разных терминалах: они
меняют один и тот же манифест профиля и lockfile.

### Если вторая установка по URL падает

На pnpm 10.34.9 мы воспроизвели `ERR_PNPM_MISSING_TARBALL_INTEGRITY` уже на
второй команде, хотя URL был с явной версией `v1.1.0`. Причина — кэш pnpm: когда
он переиспользует уже скачанный tarball, то может перезаписать запись lockfile
для ранее установленного плагина без хеша целостности. Сам tarball в порядке —
это проблема кэша/lockfile pnpm, а не релиза. В другой версии pnpm поведение
может отличаться; путь с локальными файлами работает в любом случае.

Надёжный путь для нескольких плагинов — один раз скачать все три `.tgz` и
поставить **локальные файлы** по очереди:

```powershell
$dir = Join-Path $env:USERPROFILE 'Downloads\dsh-extras'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl.exe -L -o "$dir\dsh-topmost-notify.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
curl.exe -L -o "$dir\dsh-voice-reply.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
curl.exe -L -o "$dir\dsh-speech-to-text-yandex.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"

dsh plugin --profile web add "$dir\dsh-topmost-notify.tgz"
dsh plugin --profile web add "$dir\dsh-voice-reply.tgz"
dsh plugin --profile web add "$dir\dsh-speech-to-text-yandex.tgz"
```

Локальный файл всегда получает хеш целостности, поэтому такая
последовательность не упирается в эту ошибку. Это же и офлайн-путь.

Если ошибка уже случилась и один плагин установлен с битой записью lockfile,
восстанавливайтесь в таком порядке:

1. Удалите lockfile.
2. Удалите пакет, **названный в ошибке** (обычно это плагин, который уже был
   установлен).
3. Скачайте все три `.tgz` и поставьте их локальными файлами, как выше.
4. Перезапустите `dsh web`.

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
Remove-Item (Join-Path $profileDir 'pnpm-lock.yaml') -Force
dsh plugin --profile web remove dsh-topmost-notify   # имя из текста ошибки
```

Если `remove` сам упирается в ту же ошибку на другом пакете, снова удалите
lockfile и удалите этот пакет — пока не исчезнут битые записи.

### Другие ошибки

- **`ERR_PNPM_OUTDATED_LOCKFILE` / ошибка lockfile** — удалите только
  `pnpm-lock.yaml` в каталоге профиля и повторите. Профиль сгенерирует lockfile
  заново; `package.json` и `pnpm-workspace.yaml` трогать нельзя.

  ```powershell
  Remove-Item (Join-Path $profileDir 'pnpm-lock.yaml') -Force
  ```

- **`ERR_PNPM_MISSING_TARBALL_INTEGRITY`** — используйте последовательность с
  локальными файлами выше. Чаще всего это случается при переустановке той же
  версии или после предыдущей неудачной попытки.

- **Предупреждение про peer-зависимость `@deepseek-ai/schemastery`** —
  ожидаемо для `dsh-topmost-notify`; DSH предоставляет этот пакет в рантайме.
  Предупреждение не означает, что установка не удалась. Подробнее — в
  [разделе «Если не работает»](#11-если-не-работает).

Порядок не важен: голосовые плагины независимы, а
`dsh-speech-to-text-yandex` лишь добавляет провайдер к штатному Voice input.

## 7. Обновление плагина

Команды `dsh plugin update`, которая сама понимает «следующий релиз на GitHub»,
нет. Обновление — это **удалить старый пакет, поставить новый tarball,
перезапустить**. Так же делается переустановка той же версии.

### 7.1 Что сохранится, а что удалится

pnpm заменяет каталог пакета в `node_modules\<плагин>`. Всё, что лежит внутри
этого каталога, удаляется:

| Плагин | Что удалится при обновлении | Где это лежит |
|---|---|---|
| `dsh-voice-reply` | Ключ Яндекса **и** настройки из интерфейса (голос, интонация, скорость, длина озвучки, автозапуск) | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-voice-reply\plugin-config.json` |
| `dsh-speech-to-text-yandex` | Ключ Яндекса и настройки плагина (topic, размер куска, debug, …) | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-speech-to-text-yandex\plugin-config.json` |
| `dsh-topmost-notify` | Свои звуки, загруженные через страницу настроек | `...\node_modules\dsh-topmost-notify\sounds\` |

У `dsh-topmost-notify` длительности, переключатели звука и главный тумблер
хранятся в **конфигурации профиля** (`cordis.patch.yml`), а не в каталоге
пакета, поэтому эти настройки переживут обновление. А вот файл своего звука —
нет: настройка останется указывать на старый путь `sounds\...`, файла не будет,
и плагин вернётся к встроенному сигналу, пока вы не загрузите звук снова.

### 7.2 Сначала сохраните локальные файлы

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
$backup = Join-Path $env:USERPROFILE 'Desktop\dsh-extras-backup'
New-Item -ItemType Directory -Force -Path $backup | Out-Null

Copy-Item "$profileDir\node_modules\dsh-voice-reply\plugin-config.json" `
  "$backup\dsh-voice-reply.plugin-config.json" -ErrorAction SilentlyContinue
Copy-Item "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.json" `
  "$backup\dsh-speech-to-text-yandex.plugin-config.json" -ErrorAction SilentlyContinue
Copy-Item "$profileDir\node_modules\dsh-topmost-notify\sounds" `
  "$backup\topmost-sounds" -Recurse -ErrorAction SilentlyContinue
```

Если файла нет, `-ErrorAction SilentlyContinue` просто пропустит его. Можно
скопировать эти файлы и вручную через Проводник.

### 7.3 Порядок обновления

1. Найдите новый тег на [странице релизов](https://github.com/Feskel2/dsh-extras/releases)
   и скачайте новый asset, например `dsh-voice-reply.tgz`, в локальную папку
   вроде `%USERPROFILE%\Downloads\dsh-extras\`.
2. Остановите `dsh web` (**Ctrl + C**). На Windows это не обязательно в каждом
   случае, но так вы избежите ошибок «файл занят» и сделаете обновление
   предсказуемым.
3. Удалите старый пакет.
4. Поставьте новый tarball из скачанного файла.
5. Верните сохранённые файлы.
6. Запустите `dsh web` снова.

```powershell
dsh plugin --profile web remove dsh-voice-reply
dsh plugin --profile web add "$env:USERPROFILE\Downloads\dsh-extras\dsh-voice-reply.tgz"

Copy-Item "$backup\dsh-voice-reply.plugin-config.json" `
  "$profileDir\node_modules\dsh-voice-reply\plugin-config.json" -ErrorAction SilentlyContinue
```

Если старый плагин ставился из локального `.tgz`, держите этот файл на месте:
`remove` разрешает все локальные `file:`-зависимости профиля, и пропавший
старый файл даёт ошибку `ENOENT`.

Если в профиле только этот плагин, подойдёт и URL:
`dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.1/dsh-voice-reply.tgz"`.
В профиле с несколькими плагинами предпочитайте скачанный файл: установка по
URL может упереться в проблему целостности из
[раздела 6](#6-установка-нескольких-плагинов) на другом плагине.

Для `dsh-topmost-notify` верните звуки после установки:

```powershell
New-Item -ItemType Directory -Force -Path "$profileDir\node_modules\dsh-topmost-notify\sounds" | Out-Null
Copy-Item "$backup\topmost-sounds\*" `
  "$profileDir\node_modules\dsh-topmost-notify\sounds\" -Recurse -ErrorAction SilentlyContinue
```

Затем перезапустите `dsh web`. Скачанный файл всегда записывает хеш
целостности, поэтому в профиле с несколькими плагинами это предпочтительный
способ обновления. Если вы переустанавливаете **ту же** версию и URL всё равно
даёт `ERR_PNPM_MISSING_TARBALL_INTEGRITY`, используйте локальный файл:

```powershell
dsh plugin --profile web add ".\dsh-voice-reply.tgz"
```

## 8. Удаление плагина

Удаляйте по одному пакету, затем перезапустите `dsh web`:

```powershell
dsh plugin --profile web remove dsh-topmost-notify
dsh plugin --profile web remove dsh-voice-reply
dsh plugin --profile web remove dsh-speech-to-text-yandex
```

Нужна только строка того плагина, который вы удаляете. `remove` удаляет и
строку бандла из профиля, поэтому после перезапуска плагин исчезнет из
**«Плагинов»**.

Что остаётся:

- `dsh-topmost-notify`: каталог пакета (включая `sounds\` и
  `host\notify-debug.log`) удаляется. Если хотите сохранить свои звуки,
  скопируйте `sounds\` заранее. Если вы когда-то вручную добавляли блок
  `- id: topmost-notify` в `cordis.patch.yml` профиля, удалите и его.
- `dsh-voice-reply`: каталог пакета удаляется. Кэш аудио в
  `%TEMP%\dsh-voice-reply-cache` может остаться; удалите его вручную, если
  нужна полная очистка.
- `dsh-speech-to-text-yandex`: каталог пакета удаляется вместе с
  `plugin-config.json` и `.state\events.log`. Штатный провайдер SenseVoice
  остаётся доступен в Voice input.

## 9. Установка офлайн

Tarball'ы самодостаточны: у плагинов нет собственных рантайм-зависимостей
(peer `schemastery` для `dsh-topmost-notify` предоставляет сам DSH), поэтому
машина, на которую можно принести `.tgz`-файл, установит плагин без npm.

На машине с интернетом:

1. Откройте [страницу релиза v1.1.0](https://github.com/Feskel2/dsh-extras/releases/tag/v1.1.0).
2. В разделе **Assets** скачайте три `.tgz` (или только нужный).
3. Скопируйте их на офлайн-машину, например в
   `C:\Users\<вы>\Downloads\dsh-extras\`.

Либо скачайте через PowerShell:

```powershell
$dir = Join-Path $env:USERPROFILE 'Downloads\dsh-extras'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl.exe -L -o "$dir\dsh-topmost-notify.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
curl.exe -L -o "$dir\dsh-voice-reply.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
curl.exe -L -o "$dir\dsh-speech-to-text-yandex.tgz" "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"
```

На офлайн-машине в PowerShell:

```powershell
cd "$env:USERPROFILE\Downloads\dsh-extras"
dsh plugin --profile web add ".\dsh-topmost-notify.tgz"
dsh plugin --profile web add ".\dsh-voice-reply.tgz"
dsh plugin --profile web add ".\dsh-speech-to-text-yandex.tgz"
```

Затем перезапустите `dsh web`. Установленная копия остаётся в профиле, но в
`package.json` записывается локальный путь; сохраните `.tgz`-файлы, если хотите
иметь возможность переустановить или починить профиль позже.

Оговорка: если профиль совсем новый и pnpm для разрешения других зависимостей
профиля захочет обратиться к реестру, первая установка может потребовать сеть.
На машине, где `dsh web` уже работает, профиль инициализирован, и локальных
tarball'ов достаточно. Контрольные суммы к релизу не публикуются; скачивайте
файлы со страницы официального релиза и не используйте зеркала, которым не
доверяете.

## 10. После установки: ключ Yandex SpeechKit

Два голосовых плагина ставятся без доступов. Ключа **нет** ни в одном `.tgz`:
он создаётся в Yandex Cloud и хранится локально. Полный разбор — биллинг,
каталог, сервисный аккаунт, роли, области действия ключа, проверка, журналы и
ротация — в гайде:

- [«Настройка Yandex SpeechKit»](yandex-speechkit-setup.ru.md) (русский)
- [Yandex SpeechKit setup](yandex-speechkit-setup.md) (английский)

Коротко:

| Плагин | Роль на каталог | Область действия API-ключа | Переменная окружения | Локальный файл |
|---|---|---|---|---|
| `dsh-voice-reply` | `ai.speechkit-tts.user` | `yc.ai.speechkitTts.execute` | `YANDEX_TTS_API_KEY` | `...\node_modules\dsh-voice-reply\plugin-config.json` |
| `dsh-speech-to-text-yandex` | `ai.speechkit-stt.user` | `yc.ai.speechkitStt.execute` | `YANDEX_STT_API_KEY` | `...\node_modules\dsh-speech-to-text-yandex\plugin-config.json` |

Ключ для TTS и ключ для STT — разные ключи. Ключ, выданный только для
распознавания, синтез отклоняет с `401 UNAUTHORIZED`, и наоборот.

Самый простой локальный путь — `plugin-config.json`:

```powershell
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}

# озвучка ответов (TTS)
Copy-Item "$profileDir\node_modules\dsh-voice-reply\plugin-config.example.json" `
  "$profileDir\node_modules\dsh-voice-reply\plugin-config.json"
notepad "$profileDir\node_modules\dsh-voice-reply\plugin-config.json"

# распознавание речи (STT)
Copy-Item "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.example.json" `
  "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.json"
notepad "$profileDir\node_modules\dsh-speech-to-text-yandex\plugin-config.json"
```

Заполните `apiKey` (либо `iamToken` + `folderId`) и сохраните файл в
**UTF-8 без BOM**. `plugin-config.json` перечитывается на каждый запрос,
поэтому замена ключа не требует перезапуска. Переменные окружения читаются при
старте `dsh web`, поэтому для них перезапуск нужен.

Проверка:

- `dsh-voice-reply`: **Плагины → «Голосовые ответы» → «Настроить» →
  «Прослушать»**, затем задайте короткий вопрос в чате. Первое автоматическое
  воспроизведение может потребовать одного клика по странице из-за политики
  autoplay браузера.
- `dsh-speech-to-text-yandex`: **Плагины → «Голосовой ввод»**, выберите
  **Yandex SpeechKit**, если он ещё не выбран, разрешите доступ к микрофону и
  запишите короткую фразу.

SpeechKit — платный сервис: каждый незакэшированный синтез и каждый запрос
распознавания тарифицируется Yandex Cloud. Повторы из кэша `dsh-voice-reply`
бесплатны. Никогда не кладите ключ в этот репозиторий, в сообщение чата, на
скриншот или в `cordis.patch.yml` профиля.

## 11. Если не работает

| Симптом | Вероятная причина | Что делать |
|---|---|---|
| `dsh : The term 'dsh' is not recognized…` | Глобальный каталог bin DSH не в `PATH` или терминал открыт до установки DSH | Закройте и снова откройте PowerShell; выполните `Get-Command dsh` и `where.exe dsh`. Если пусто, добавьте в `PATH` глобальный префикс npm (`npm config get prefix`) или вызывайте лаунчер по полному пути (`& "$env:APPDATA\npm\dsh.cmd"`). |
| `dsh.ps1 cannot be loaded because running scripts is disabled` | Политика выполнения PowerShell блокирует `.ps1` | Используйте `dsh.cmd` вместо `dsh` (он лежит рядом) либо выполните `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` и подтвердите. |
| `dsh: pnpm was not found; install pnpm…` / код выхода `127` | `dsh plugin` передаёт работу pnpm, а pnpm нет в `PATH` | Установите pnpm (например, через Corepack: `corepack enable pnpm`), откройте терминал заново, проверьте `pnpm --version`. |
| `ERR_PNPM_MISSING_TARBALL_INTEGRITY` | URL редиректит (`latest/download`) или pnpm переиспользует закэшированный tarball без хеша — особенно на втором плагине | Укажите явную версию (`.../download/v1.1.0/...`), удалите `pnpm-lock.yaml` и повторите. Если не помогает — восстановление из [раздела 6](#6-установка-нескольких-плагинов): удалить lockfile, удалить пакет, названный в ошибке, и поставить все три плагина локальными `.tgz`-файлами. Локальный файл всегда записывает хеш. |
| `ERR_PNPM_OUTDATED_LOCKFILE` или другая ошибка lockfile | Lockfile профиля устарел после прерванной или параллельной установки | Удалите **только** `pnpm-lock.yaml` в каталоге профиля (`$profileDir\pnpm-lock.yaml`) и повторите. Не удаляйте `package.json` и `pnpm-workspace.yaml`; lockfile сгенерируется заново. |
| `WARN Issues with peer dependencies found … missing peer @deepseek-ai/schemastery@^3.19.0` | `dsh-topmost-notify` объявляет schemastery из DSH как peer; pnpm не ставит peer'ы в профиль DSH | Это безвредно. DSH предоставляет пакет в рантайме, установка всё равно успешна. Не запускайте `npm install` внутри профиля, чтобы «починить» это. |
| URL Pages отвечает `404` | Публикация Pages недоступна или ещё собирается | Используйте явный URL релиза из [раздела 4](#4-установите-плагины) или локальный `.tgz`. Внутри те же файлы. |
| URL GitHub отвечает `404` | Неверный тег, имя файла или опечатка в URL | Откройте [страницу релизов](https://github.com/Feskel2/dsh-extras/releases), скопируйте точную ссылку на asset. Нужен `v1.1.0`, а не `1.1.0`; имя файла должно совпадать точно. |
| Скачивание падает: TLS, прокси, таймаут | Корпоративный прокси, VPN или GitHub недоступен | Проверьте `curl.exe -I https://github.com`; задайте `HTTPS_PROXY` для процесса DSH; попробуйте другую сеть; либо используйте офлайн-путь с `.tgz`. |
| `EPERM: operation not permitted` / «файл занят» при обновлении или удалении | `dsh web` или редактор держит файл в каталоге пакета | Остановите `dsh web` (**Ctrl + C**), закройте редакторы и антивирусные проверки этой папки, повторите команду. |
| `ENOENT: no such file or directory … .tgz` | Профиль ставился из локального `.tgz`, а файл переместили или удалили; pnpm разрешает все локальные `file:`-зависимости при следующем изменении | Верните `.tgz` по записанному пути (или скачайте заново туда) и повторите. Держите локальные tarball'ы на месте, пока не удалите или не обновите плагин. |
| Установка печатает `Done`, но после перезапуска плагина нет | Установка ушла в другой профиль или `dsh web` не перезапускали | Проверьте, что в команде есть `--profile web`; выполните `dsh plugin --profile web list --depth 0`; перезапустите `dsh web` ещё раз и откройте **«Плагины»**. |
| `dsh: installation rejected: … engines.dsh` или предупреждение о версии | DSH вне диапазона `>=0.2.2-rc.1 <0.3.0-0` | Обновите DSH до сборки `0.2.x` из этого диапазона (`dsh --version`). Не правьте `package.json` плагина. |
| `Cannot find module '@deepseek-ai/schemastery'` при старте | Установка DSH неполная или плагин загружен вне DSH | Переустановите/обновите DSH; peer предоставляет сам DSH. Предупреждение `WARN` при установке — не эта ошибка. |
| Карточка уведомления не появляется | Главный тумблер выключен, чат замьючен колокольчиком, эксклюзивный fullscreen или ход ещё идёт | Проверьте **Settings → General** и 🔔 в шапке чата; подождите ~2–3 секунды после завершения хода; проверьте кнопкой **«Плагины → Уведомления о задачах → Показать окно»**. Эксклюзивный DirectX fullscreen может перекрывать topmost-окно. |
| Карточка появляется, но звука нет | Звук выключен для этого вида, громкость системы или свой файл удалён обновлением | Проверьте страницу настроек плагина; загрузите MP3/WAV заново; встроенный сигнал — запасной вариант. |
| `dsh-voice-reply` пишет «Озвучивание не настроено» | Нет ключа в окружении или `plugin-config.json` | См. [раздел 10](#10-после-установки-ключ-yandex-speechkit); проверьте, что ключ лежит в файле рядом с `index.js`. |
| Озвучка возвращает `401 UNAUTHORIZED` / `Permission denied` | Ключ только для STT, у сервисного аккаунта нет `ai.speechkit-tts.user` или роль ещё не разошлась | Создайте ключ со скоупом `yc.ai.speechkitTts.execute` и выдайте роль TTS; после смены роли подождите несколько минут. |
| Первый ответ озвучивается не автоматически | Политика autoplay браузера заблокировала автозапуск | Кликните по странице один раз и нажмите 🔊; следующие ответы смогут запускаться сами. Плагин также откладывает озвучку, пока вкладка скрыта или не в фокусе. |
| Озвучка возвращает `429` или обрывается | Квота/лимит Яндекса или длинный текст синтезируется кусками | Подождите и повторите; уменьшите длину озвучки на странице настроек; проверьте квоты в Yandex Cloud. |
| `dsh-speech-to-text-yandex` нет в списке служб распознавания | Штатный bundle **Voice input** выключен или `dsh web` не перезапускали | Включите **«Плагины → Голосовой ввод»**, перезапустите `dsh web`, откройте настройки заново. Провайдер называется **Yandex SpeechKit**. |
| STT возвращает `401` / `403` | Неверный тип ключа (TTS-ключ для STT), нет `ai.speechkit-stt.user` или IAM-токен без id каталога | Используйте ключ со скоупом `yc.ai.speechkitStt.execute` либо IAM-токен + `folderId`; проверьте роль на каталоге. |
| Микрофон пишет, но текст не вставляется | Нет разрешения на микрофон, выбрана не та служба распознавания или нет сети до `stt.api.cloud.yandex.net` | Разрешите микрофон для адреса DSH; выберите **Yandex SpeechKit**; посмотрите консоль браузера и `.state\events.log` плагина. |
| Плагин пишет «Invalid JSON» про `plugin-config.json` | В файле комментарии, висячая запятая или BOM | Уберите комментарии и запятые, сохраните в UTF-8 без BOM; проверьте командой `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "путь\plugin-config.json"`. |
| Всё установлено, но `dsh web` показывает старый интерфейс | Процесс не перезапущен или порт занят другим экземпляром `dsh web` | Остановите старый процесс (**Ctrl + C**) и запустите `dsh web` заново; откройте URL, который напечатал новый процесс. |

## 12. Краткая шпаргалка

```powershell
# Проверка окружения
dsh --version
node --version
pnpm --version

# Путь профиля
$profileDir = if ($env:DSH_HOME) {
  Join-Path $env:DSH_HOME 'profiles\web'
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
$profileDir

# Установка (релиз v1.1.0) — по одной команде
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-topmost-notify.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-voice-reply.tgz"
dsh plugin --profile web add "https://github.com/Feskel2/dsh-extras/releases/download/v1.1.0/dsh-speech-to-text-yandex.tgz"

# Что установлено
dsh plugin --profile web list --depth 0

# Удаление
dsh plugin --profile web remove dsh-topmost-notify
dsh plugin --profile web remove dsh-voice-reply
dsh plugin --profile web remove dsh-speech-to-text-yandex

# Перезапуск после установки/обновления/удаления
dsh web
```

- Страница релиза: <https://github.com/Feskel2/dsh-extras/releases/tag/v1.1.0>
- Настройка Yandex SpeechKit:
  [русский](yandex-speechkit-setup.ru.md) ·
  [английский](yandex-speechkit-setup.md)
- Исходники плагинов:
  [`dsh-topmost-notify`](../dsh-topmost-notify/README.ru.md) ·
  [`dsh-voice-reply`](../dsh-voice-reply/README.ru.md) ·
  [`dsh-speech-to-text-yandex`](../dsh-speech-to-text-yandex/README.ru.md)
