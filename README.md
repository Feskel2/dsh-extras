# Свой plugin index для вкладки Discover

`index.json` в этой папке — **черновик** индекса формата 1 для встроенной
вкладки Discover в DSH. Он написан по официальной документации
[`docs/user/guide/plugin-market.md`](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/plugin-market.md)
и валидируется теми же правилами, что применяет сам DSH.

## Что это даёт

Пользователь DSH:

1. **Plugins → Experimental plugins → «Custom plugin indexes»** — включить.
2. Появится вкладка **Discover** → **«Add index source»** → вставить URL
   нашего `index.json`.
3. В поиске появятся наши плагины; **Install** показывает источник
   (npm-пакет и версия) и ставит его обычным путём.

Официального каталога у DeepSeek нет («DSH ships no index source») — свой
индекс это единственный канал без модератора.

## Что нужно заменить перед публикацией

В файле стоят заглушки:

| Поле | Что подставить |
|---|---|
| `author` | ваше имя/ник |
| `homepage`, `repository.url` | реальный GitHub-репозиторий |
| `repository.directory` | путь пакета в монорепо (если один пакет на репозиторий — убрать) |
| `versions[].version` | реально опубликованная в npm версия |
| `versions[].publishTimestamp` | реальное время публикации в Unix-секундах (`date +%s`, либо из `npm view <name> time.<version>`) |
| `icon` | реальные файлы в `icons/` (SVG/PNG/JPEG/WebP, ≤32 KiB для inline; относительный путь резолвится от URL индекса) |

## Публикация (GitHub Pages)

```sh
# 1) разложить: site/index.json + site/icons/*.svg
# 2) опубликовать (ветка gh-pages)
git checkout --orphan gh-pages
git rm -rf .
cp -r ../site/* .
git add . && git commit -m "publish plugin index" && git push origin gh-pages
# 3) GitHub → Settings → Pages → Source: Deploy from a branch → gh-pages / (root)
# 4) URL: https://<user>.github.io/<repo>/index.json
```

Требования к хостингу: UTF-8 JSON, **2xx без редиректов**, `https`, ≤128 MiB,
ответ укладывается в **15 секунд** (иначе продублировать на jsDelivr, как это
делает awesome-список: `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`).

## Альтернатива: официальный генератор

В репозитории DSH есть генератор, который собирает индекс из списка
npm-имён/репозиториев и сам проставляет версии/время:

```sh
# plugins.txt — по одному npm-имени или https-git-URL на строку
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output site/index.json --title "DSH Extras"
```

Он листит только пакеты, объявляющие `dsh.bundle.patch` и не `private`; код
пакетов не исполняет.

## Правила формата (коротко)

- `format: 1`; `title` (у объекта обязателен `en`); `plugins[]` — уникальные
  npm-имена.
- `versions[]`: точный SemVer, `publishTimestamp` (Unix-секунды), `source`
  (`{ "type": "npm" }` или `{ "type": "git", "url", "commit", "path"? }`),
  опционально `engines.dsh`.
- Ошибка в любом поле → индекс отвергается целиком (DSH покажет JSON-путь в
  «Manage index sources…»).
- `engines.dsh` в индексе должен совпадать с `engines.dsh` пакета — DSH
  перепроверяет при установке.

## Обновление

После каждого релиза в npm: поднять `version` + `publishTimestamp` в индексе
(или перегенерировать генератором), закоммитить, задеплоить Pages. Пользователь
увидит «Update available» в Discover (обновление = удалить + поставить).

## Безопасность

Индекс — сторонний контент: DSH проверяет формат, но **не** заявления
(название, описание, источник). Поэтому в описании индекса и в README
репозитория явно указываем: «официальные пакеты `@deepseek-ai/*` мы не
подменяем; все ссылки ведут на наши публичные репозитории».
