<#
.SYNOPSIS
  Устанавливает плагин dsh-topmost-notify в профиль DSH как бандл.

.DESCRIPTION
  Копирует пакет в <профиль>\node_modules\dsh-topmost-notify и подключает его
  как бандл: запись в <профиль>\package.json -> dsh.profile.bundles. Строка
  topmost-notify приходит из собственного cordis.patch.yml пакета, поэтому
  в патч профиля ничего добавлять не нужно.

  Скрипт идемпотентен: повторный запуск обновляет файлы, зависимости и список
  бандлов. Настройки (в т.ч. свои звуки в <пакет>\sounds) сохраняются.

  Миграция с прежней локальной установки `turn-notify` (пакет dsh-turn-notify
  в node_modules и строки id: turn-notify в cordis.patch.yml): скрипт убирает
  прежнюю строку и пакет, чтобы после перезапуска не было двух уведомлений.

  Почему бандл, а не строка insert в патче: только у бандла в DSH есть
  карточка в «Плагинах», а значит и своя страница настроек
  (Плагины → «Уведомления о задачах» → строка topmost-notify → шеврон).

.PARAMETER Uninstall
  Убирает зависимость и бандл из профиля, папку пакета и строки настроек
  самого плагина из патча профиля (с бэкапами).

.PARAMETER Test
  После установки показать тестовое уведомление через host/notify.ps1.

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
$LegacyPackageName = 'dsh-turn-notify'
$Target = Join-Path $ProfileDir "node_modules\$PackageName"
$LegacyTargets = @(
  (Join-Path $ProfileDir "node_modules\$LegacyPackageName"),
  (Join-Path $ProfileDir 'plugins\turn-notify'),
  (Join-Path $ProfileDir 'plugins\topmost-notify')
)
$ManifestPath = Join-Path $ProfileDir 'package.json'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $ManifestPath)) { throw "Не найден манифест профиля: $ManifestPath" }

Write-Host "Профиль DSH: $ProfileDir"

function Backup-File([string]$path) {
  if (Test-Path $path) {
    Copy-Item $path "$path.bak-$Stamp"
    Write-Host "Бэкап: $path.bak-$Stamp"
  }
}

function Read-Json([string]$path) {
  [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Write-Json([string]$path, $value) {
  $text = $value | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($path, "$text`r`n", $Utf8NoBom)
}

# ── строки патча, добавленные прежними локальными установками ────────────────
# Удаляем верхнеуровневые блоки: `- insert:` с id turn-notify/topmost-notify и
# `- id: turn-notify` (оверрайд старого плагина). Верхнеуровневые оверрайды
# `- id: topmost-notify` (их пишет редактор настроек) НЕ трогаем.
function Remove-LegacyPatchRows([string]$text) {
  $lines = $text -split "\r?\n"
  $result = New-Object System.Collections.Generic.List[string]
  $index = 0
  while ($index -lt $lines.Count) {
    $line = $lines[$index]
    if ($line -match '^-\s') {
      $block = New-Object System.Collections.Generic.List[string]
      $block.Add($line)
      $index++
      while ($index -lt $lines.Count -and $lines[$index] -notmatch '^-\s') {
        $block.Add($lines[$index])
        $index++
      }
      $joined = $block -join "`n"
      $isLegacyInsert = $joined -match '(?m)^-\s*insert:' -and $joined -match '(?m)^\s*-\s*id:\s*(turn-notify|topmost-notify)\s*$' -and $joined -match '(?m)^\s*name:\s*dsh-(turn-notify|topmost-notify)\s*$'
      $isLegacyOverride = $joined -match '(?m)^-\s*id:\s*turn-notify\s*$'
      if ($isLegacyInsert -or $isLegacyOverride) {
        Write-Host 'Удалена прежняя строка turn-notify из cordis.patch.yml.'
        continue
      }
      foreach ($blockLine in $block) {
        # Маркерные комментарии прежней локальной установки больше не нужны.
        if ($blockLine -match '^#\s.*(topmost-notify|turn-notify)') { continue }
        $result.Add($blockLine)
      }
    } else {
      # Маркерные комментарии прежней установки больше не нужны.
      if ($line -match '^#\s.*(topmost-notify|turn-notify)') { $index++; continue }
      $result.Add($line)
      $index++
    }
  }
  return ($result -join "`r`n")
}

function Update-Manifest([bool]$remove) {
  $manifest = Read-Json $ManifestPath
  $bundles = New-Object System.Collections.Generic.List[string]
  if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    foreach ($bundle in $manifest.dsh.profile.bundles) { $bundles.Add([string]$bundle) }
  }
  if ($remove) {
    while ($bundles.Contains($PackageName)) { [void]$bundles.Remove($PackageName) }
  } elseif (-not $bundles.Contains($PackageName)) {
    $bundles.Add($PackageName)
  }
  if ($manifest.dependencies -eq $null) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject) }
  if ($remove) {
    if ($manifest.dependencies.PSObject.Properties.Name -contains $PackageName) {
      $manifest.dependencies.PSObject.Properties.Remove($PackageName)
    }
  } else {
    $link = "link:$($Source -replace '\\', '/')"
    if ($manifest.dependencies.PSObject.Properties.Name -contains $PackageName) {
      $manifest.dependencies.$PackageName = $link
    } else {
      $manifest.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $link
    }
  }
  if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object psobject) }
  if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) }
  if ($manifest.dsh.profile.PSObject.Properties.Name -contains 'bundles') {
    $manifest.dsh.profile.bundles = @($bundles)
  } else {
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($bundles)
  }
  Write-Json $ManifestPath $manifest
}

function Remove-PatchRows() {
  if (-not (Test-Path $PatchPath)) { return }
  $before = [System.IO.File]::ReadAllText($PatchPath, [System.Text.Encoding]::UTF8)
  $after = Remove-LegacyPatchRows $before
  if ($after -ne $before) {
    Backup-File $PatchPath
    [System.IO.File]::WriteAllText($PatchPath, $after, $Utf8NoBom)
  }
}

# ── удаление ────────────────────────────────────────────────────────────────
if ($Uninstall) {
  Backup-File $ManifestPath
  Update-Manifest $true
  Remove-PatchRows
  foreach ($dir in @($Target) + $LegacyTargets) {
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir; Write-Host "Удалено: $dir" }
  }
  Write-Host 'Готово. Перезапустите `dsh web`, чтобы плагин выключился.'
  return
}

# ── установка ───────────────────────────────────────────────────────────────
$files = @('package.json', 'index.mjs', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.ru.md', 'CHANGELOG.md', 'LICENSE')
foreach ($file in $files) {
  $from = Join-Path $Source $file
  if (-not (Test-Path $from)) { throw "Не найден файл пакета: $from" }
}

New-Item -ItemType Directory -Force $Target | Out-Null
foreach ($file in $files) {
  Copy-Item (Join-Path $Source $file) (Join-Path $Target $file) -Force
}
foreach ($dir in @('host', 'locale', 'assets')) {
  $from = Join-Path $Source $dir
  if (Test-Path $from) {
    New-Item -ItemType Directory -Force (Join-Path $Target $dir) | Out-Null
    Copy-Item (Join-Path $from '*') (Join-Path $Target $dir) -Recurse -Force
  }
}
# Пользовательские звуки (sounds\) намеренно не перезаписываются и не удаляются.

foreach ($legacy in $LegacyTargets) {
  if (Test-Path $legacy) { Remove-Item -Recurse -Force $legacy; Write-Host "Удалена прежняя раскладка: $legacy" }
}

Backup-File $ManifestPath
Update-Manifest $false
Remove-PatchRows

Write-Host ''
Write-Host "Установлено в: $Target"
Write-Host 'Дальше: перезапустить `dsh web` (Ctrl+C в его терминале и снова `dsh web`).'
Write-Host 'После перезапуска: Плагины → «Уведомления о задачах» → строка topmost-notify → шеврон,'
Write-Host 'а тумблер — Settings → General.'

if ($Test) {
  $script = Join-Path $Target 'host\notify.ps1'
  $payload = @{
    title = '✅ Задача выполнена'
    body = 'Проверка плагина topmost-notify — это же окно появится при завершении задачи'
    durationMs = 2000
    sound = $true
    kind = 'completed'
  } | ConvertTo-Json -Compress
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
  & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $script -PayloadBase64 $b64
  Write-Host 'Тестовое уведомление отправлено.'
}
