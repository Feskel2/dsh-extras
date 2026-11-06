<#
.SYNOPSIS
  Устанавливает плагин topmost-notify в профиль DSH.

.DESCRIPTION
  Копирует пакет в <профиль>\node_modules\dsh-topmost-notify и добавляет строку
  insert в cordis.patch.yml. Идемпотентно: повторный запуск обновляет файлы и
  не дублирует строку патча. Изменения подхватываются после перезапуска `dsh web`.

  Почему node_modules и имя-пакет, а не ./plugins/... и путь файлом:
  строка патча вида `name: dsh-topmost-notify` (пакет) позволяет config-editor
  DSH записывать настройку из UI (тумблер в Settings → General). У строки
  с путём (`./plugins/...`) резолвится абсолютный file:// URL, и запись
  настроек отклоняется как «перекрыта другим слоем». Проверено на стенде.

.PARAMETER Uninstall
  Убрать строку патча и папку плагина (с бэкапом патча).

.PARAMETER Test
  После установки показать тестовое уведомление через notify.ps1.

.NOTES
  Перезапуск `dsh web` скрипт не выполняет намеренно: он обрывает текущую
  сессию агента и печатает новый URL в своём терминале, поэтому перезапуск
  остаётся за пользователем.
#>
param(
  [switch]$Uninstall,
  [switch]$Test
)

$ErrorActionPreference = 'Stop'

$Source = $PSScriptRoot
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $DshHome 'profiles\web' }
$PackageName = 'dsh-topmost-notify'
$Target = Join-Path $ProfileDir "node_modules\$PackageName"
$LegacyTarget = Join-Path $ProfileDir 'plugins\turn-notify'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Encoder = New-Object System.Text.UTF8Encoding($true)
$LegacyMarker = './plugins/turn-notify/index.mjs'

function Backup-Patch {
  if (Test-Path $PatchPath) {
    $backup = "$PatchPath.bak-$Stamp"
    Copy-Item $PatchPath $backup
    Write-Host "Бэкап патча: $backup"
  }
}

function Read-Patch {
  [System.IO.File]::ReadAllText($PatchPath, [System.Text.Encoding]::UTF8)
}

function Write-Patch([string]$text) {
  [System.IO.File]::WriteAllText($PatchPath, $text, $Encoder)
}

if (-not (Test-Path $PatchPath)) { throw "Не найден патч профиля: $PatchPath" }

function Remove-PluginRow {
  $text = Read-Patch
  $next = $text
  if ($next.Contains($LegacyMarker)) { $next = $next.Replace($LegacyMarker, $PackageName) }
  # Удаляем сам блок insert, который добавлял этот скрипт.
  $pattern = "(?ms)\r?\n# ── topmost-notify.*?- id: topmost-notify\r?\n      name: $([regex]::Escape($PackageName))\r?\n"
  $next = [regex]::Replace($next, $pattern, "`r`n")
  return [pscustomobject]@{ text = $next; changed = ($next -ne $text) }
}

if ($Uninstall) {
  Backup-Patch
  $result = Remove-PluginRow
  if ($result.changed) { Write-Patch $result.text; Write-Host 'Строка патча удалена.' }
  else { Write-Host 'Строка патча не найдена — ничего не меняю.' }
  foreach ($dir in @($Target, $LegacyTarget)) {
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir; Write-Host "Удалено: $dir" }
  }
  Write-Host 'Готово. Перезапустите `dsh web`, чтобы изменения вступили в силу.'
  return
}

# ── install ──────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force $Target | Out-Null
New-Item -ItemType Directory -Force (Join-Path $Target 'host') | Out-Null

foreach ($file in 'package.json', 'index.mjs', 'client.js') {
  $from = Join-Path $Source $file
  if (-not (Test-Path $from)) { throw "Не найден файл пакета: $from" }
  Copy-Item $from (Join-Path $Target $file) -Force
}
foreach ($hostFile in 'notify.ps1', 'chime.wav', 'chime-question.wav', 'make-chime.mjs', 'README-host.md', 'test-notify.ps1') {
  $from = Join-Path $Source "host\$hostFile"
  if (Test-Path $from) { Copy-Item $from (Join-Path $Target 'host') -Force }
}

# Убираем старую раскладку ./plugins/turn-notify, если она осталась от прежней версии.
if (Test-Path $LegacyTarget) {
  Remove-Item -Recurse -Force $LegacyTarget
  Write-Host 'Удалена старая раскладка plugins\turn-notify.'
}

$text = Read-Patch
$hasRow = $text -match '(?m)^\s*name:\s*dsh-topmost-notify\s*$'
if ($text.Contains($LegacyMarker)) {
  Backup-Patch
  Write-Patch ($text.Replace($LegacyMarker, $PackageName))
  Write-Host 'Строка патча переведена на имя-пакет dsh-topmost-notify.'
} elseif (-not $hasRow) {
  Backup-Patch
  $block = @"

# ── topmost-notify: нативное окно + звук по завершении задачи ────────────────────
# Локальный пакет node_modules/dsh-topmost-notify (host half: index.mjs, browser half: client.js).
# Имя строки — пакет (не путь): иначе Settings не может записать тумблер.
# Тумблер — Settings → General → «Уведомление о завершении задачи».
# Требует перезапуска `dsh web` (новые insert-строки не активируются на лету).
- insert:
    - id: topmost-notify
      name: $PackageName
"@
  Add-Content -Path $PatchPath -Value $block -Encoding utf8
  Write-Host 'Строка insert добавлена в cordis.patch.yml.'
} else {
  Write-Host 'Строка insert уже есть в cordis.patch.yml — файлы обновлены.'
}

Write-Host ''
Write-Host "Установлено в: $Target"
Write-Host 'Дальше: перезапустить `dsh web` (Ctrl+C в его терминале и снова `dsh web`).'
Write-Host 'После перезапуска тумблер появится в Settings → General.'

if ($Test) {
  $script = Join-Path $Target 'host\notify.ps1'
  $payload = @{
    title = '✅ Задача выполнена'
    body = 'Проверка плагина topmost-notify — этот текст показан тем же окном, что и при завершении задачи'
    durationMs = 1500
    sound = $true
  } | ConvertTo-Json -Compress
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
  & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $script -PayloadBase64 $b64
  Write-Host 'Тестовое уведомление отправлено.'
}
