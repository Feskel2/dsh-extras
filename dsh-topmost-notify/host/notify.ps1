#requires -Version 5.1
<#
    notify.ps1 — нативное уведомление для плагина DSH topmost-notify.

    Показывает безрамочное topmost-окно WPF поверх всех окон, НЕ забирая фокус,
    проигрывает звук одновременно с появлением карточки и сам закрывается через durationMs.

    Два вида уведомления (-Kind / payload.kind):
      completed — «задача выполнена»: синий/фиолетовый акцент, chime.wav;
      question  — «нужен ответ»: янтарный акцент, chime-question.wav (вопросительный сигнал).

    Контракт (вызывает host-плагин):
      powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File notify.ps1 `
          -PayloadBase64 <base64 от UTF-8 JSON> [-PreviewSound]
      JSON: {
        "title": string, "body": string,
        "durationMs": number,          // 300..15000, сколько окно висит
        "sound": true | false | "C:\path\to\custom.wav|.mp3",   // свой звук (из настроек)
        "kind": "completed" | "question"
      }
    Поле "sound" строкой — путь к своему WAV или MP3 (абсолютный или относительно папки скрипта).
    WAV играется через System.Media.SoundPlayer, MP3 — через System.Windows.Media.MediaPlayer
    (оба не забирают фокус). Если файл не найден — предупреждение в stderr и стандартный звук вида.
    Свой файл доигрывается до конца (не дольше ~20 с); встроенные chime — прежний хвост 350 мс.

    -PreviewSound — проиграть ТОЛЬКО звук (payload.sound / -SoundFile / встроенный по -Kind),
    без окна, сразу выйти с кодом 0. Используется кнопкой «Прослушать» на странице настроек.

    Ручной запуск:
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File notify.ps1 `
          -Title "Задача выполнена" -Body "Проверка окна" -DurationMs 1500
      ... -Kind question  — вопросительный вид;
      ... -SoundFile "D:\sounds\my.wav" — свой звук (WAV или MP3);
      ... -PreviewSound — только звук, без окна;
      ... -Silent — без звука;  ... -Diag — тайминги этапов в stderr.

    Коды выхода: 0 — окно показано и закрыто штатно (или звук сыгран в -PreviewSound);
    1 — ошибка (текст в stderr).

    Файл сохранён в UTF-8 С BOM: PowerShell 5.1 иначе читает кириллицу как ANSI.
    Скорость: JSON разбирается вручную (ConvertFrom-Json тянет JavaScriptSerializer ~230 мс),
    UI строится кодом (XamlReader.Parse ~700 мс). Звук стартует в Loaded — одновременно с окном,
    с гарантированным фолбэком, если WPF-часть не дошла до показа.
#>
[CmdletBinding()]
param(
    [string]$PayloadBase64,
    [string]$Title,
    [string]$Body,
    [int]$DurationMs = 1000,
    [ValidateSet('completed', 'question')]
    [string]$Kind = 'completed',
    [string]$SoundFile,
    [switch]$Silent,
    [switch]$PreviewSound,
    [switch]$Diag
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# --- диагностика таймингов (-Diag) --------------------------------------------------------
$diagSw = [System.Diagnostics.Stopwatch]::StartNew()
$script:DiagEnabled = [bool]$Diag
function Diag([string]$message) {
    if ($script:DiagEnabled) {
        $line = 'diag: {0,6} ms  {1}' -f $diagSw.ElapsedMilliseconds, $message
        [Console]::Error.WriteLine($line)
    }
}
$procAge = -1
try { $procAge = [int](((Get-Date) - [System.Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds) } catch { }
Diag "script start (возраст процесса $procAge мс)"

function Fail([string]$message) {
    [Console]::Error.WriteLine("notify.ps1: $message")
    exit 1
}

# --- 1. Минимальный разбор плоского JSON (без ConvertFrom-Json — он медленный) ------------
function Unescape-JsonString([string]$s) {
    if ($s.IndexOf([char]'\') -lt 0) { return $s }
    $sb = New-Object System.Text.StringBuilder ($s.Length)
    for ($i = 0; $i -lt $s.Length; $i++) {
        $c = $s[$i]
        if ($c -ne [char]'\') { [void]$sb.Append($c); continue }
        $i++
        if ($i -ge $s.Length) { break }
        $e = $s[$i]
        if ($e -eq [char]'n') { [void]$sb.Append([char]10) }
        elseif ($e -eq [char]'r') { [void]$sb.Append([char]13) }
        elseif ($e -eq [char]'t') { [void]$sb.Append([char]9) }
        elseif ($e -eq [char]'b') { [void]$sb.Append([char]8) }
        elseif ($e -eq [char]'f') { [void]$sb.Append([char]12) }
        elseif ($e -eq [char]'u') {
            if ($i + 4 -lt $s.Length) {
                [void]$sb.Append([char][Convert]::ToInt32($s.Substring($i + 1, 4), 16))
                $i += 4
            }
        }
        else { [void]$sb.Append($e) }
    }
    return $sb.ToString()
}

function ConvertFrom-FlatJson([string]$json) {
    $values = @{}
    $stringPattern = '"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)"'
    foreach ($m in [regex]::Matches($json, $stringPattern)) {
        $values[$m.Groups[1].Value] = Unescape-JsonString $m.Groups[2].Value
    }
    # значения-строки вырезаем, чтобы числа/булевы внутри текста не сбивали разбор
    $rest = [regex]::Replace($json, $stringPattern, '"$1":""')
    foreach ($m in [regex]::Matches($rest, '"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(-?\d+(?:\.\d+)?)')) {
        $values[$m.Groups[1].Value] = [double]$m.Groups[2].Value
    }
    foreach ($m in [regex]::Matches($rest, '"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(true|false)')) {
        $values[$m.Groups[1].Value] = ($m.Groups[2].Value -eq 'true')
    }
    return $values
}

$titleText = 'Задача выполнена'
$bodyText = ''
$duration = $DurationMs
$kindValue = $Kind
$soundSpec = $true          # bool или строка-путь
$soundSpecFromPayload = $false

if ($PayloadBase64) {
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
        $values = ConvertFrom-FlatJson $json
    }
    catch {
        Fail "не удалось разобрать payload: $($_.Exception.Message)"
    }
    if ($values.ContainsKey('title') -and -not [string]::IsNullOrEmpty([string]$values['title'])) { $titleText = [string]$values['title'] }
    if ($values.ContainsKey('body')) { $bodyText = [string]$values['body'] }
    if ($values.ContainsKey('durationMs') -and -not $PSBoundParameters.ContainsKey('DurationMs')) {
        $duration = [int]$values['durationMs']
    }
    if ($values.ContainsKey('kind') -and -not $PSBoundParameters.ContainsKey('Kind')) {
        $k = ([string]$values['kind']).Trim().ToLowerInvariant()
        if ($k -eq 'question' -or $k -eq 'waiting' -or $k -eq 'ask') { $kindValue = 'question' }
        elseif ($k -eq 'completed' -or $k -eq 'done') { $kindValue = 'completed' }
    }
    if ($values.ContainsKey('sound') -and -not $Silent -and -not $PSBoundParameters.ContainsKey('SoundFile')) {
        $soundSpec = $values['sound']
        $soundSpecFromPayload = $true
    }
}
Diag 'payload разобран'

# Явные параметры командной строки важнее payload (ручной запуск).
if ($PSBoundParameters.ContainsKey('Title')) { $titleText = $Title }
if ($PSBoundParameters.ContainsKey('Body')) { $bodyText = $Body }
if ($kindValue -eq 'question' -and -not $PSBoundParameters.ContainsKey('Title') -and -not ($PayloadBase64 -and $values -and $values.ContainsKey('title'))) {
    $titleText = 'Нужен ответ'
}

if ($duration -lt 300) { $duration = 300 }
if ($duration -gt 15000) { $duration = 15000 }
if ([string]::IsNullOrWhiteSpace($titleText)) { $titleText = 'Задача выполнена' }

# --- 2. Какой звук играть (решаем заранее, играем позже — вместе с окном) -----------------
$playSound = $false
$customSound = $null
if (-not $Silent) {
    if ($soundSpec -is [bool]) {
        $playSound = [bool]$soundSpec
    }
    elseif ($soundSpec -is [string] -and -not [string]::IsNullOrWhiteSpace($soundSpec)) {
        $playSound = $true
        $customSound = ([string]$soundSpec).Trim()
    }
    else {
        $playSound = $true
    }
}
if ($PSBoundParameters.ContainsKey('SoundFile') -and -not [string]::IsNullOrWhiteSpace($SoundFile)) {
    $playSound = $true
    $customSound = $SoundFile.Trim()
}

function Resolve-ChimePath([string]$kind, [string]$custom) {
    if (-not [string]::IsNullOrWhiteSpace($custom)) {
        $p = $custom
        if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path $PSScriptRoot $p }
        if (Test-Path -LiteralPath $p) { return (Resolve-Path -LiteralPath $p).Path }
        [Console]::Error.WriteLine("notify.ps1: свой звук не найден: $p — использую стандартный")
    }
    $default = if ($kind -eq 'question') { 'chime-question.wav' } else { 'chime.wav' }
    return (Join-Path $PSScriptRoot $default)
}

# Длительность WAV из заголовка (byte rate + размер data-чанка); 0 — не удалось.
function Get-WavDurationMs([string]$path) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        if ($bytes.Length -lt 44) { return 0 }
        if ([System.Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF') { return 0 }
        if ([System.Text.Encoding]::ASCII.GetString($bytes, 8, 4) -ne 'WAVE') { return 0 }
        $byteRate = [System.BitConverter]::ToUInt32($bytes, 28)
        $offset = 12
        while ($offset + 8 -le $bytes.Length) {
            $id = [System.Text.Encoding]::ASCII.GetString($bytes, $offset, 4)
            $len = [System.BitConverter]::ToUInt32($bytes, $offset + 4)
            if ($id -eq 'data') {
                if ($byteRate -gt 0 -and $len -gt 0) { return [int][math]::Round($len / $byteRate * 1000) }
                return 0
            }
            $offset += 8 + $len + ($len % 2)
        }
        return 0
    }
    catch { return 0 }
}

# Прокачать очередь Dispatcher на $ms миллисекунд: доставляет события MediaPlayer
# (MediaOpened/MediaEnded/MediaFailed) без запущенного цикла WPF-приложения.
function Pump-Dispatcher([int]$ms = 40) {
    try {
        $frame = New-Object System.Windows.Threading.DispatcherFrame
        $timer = New-Object System.Windows.Threading.DispatcherTimer
        $timer.Interval = [TimeSpan]::FromMilliseconds([math]::Max(10, $ms))
        $timer.Add_Tick({ $timer.Stop(); $frame.Continue = $false })
        $timer.Start()
        [System.Windows.Threading.Dispatcher]::PushFrame($frame)
    }
    catch { }
}

$script:soundStarted = $false
$script:soundStart = $null
$script:soundPlayer = $null
$script:mediaPlayer = $null
$script:audioKind = ''
$script:wavMs = 0
$script:audioMs = 0
$script:audioDone = $false
$script:audioIsCustom = (-not [string]::IsNullOrWhiteSpace($customSound))

# MP3 — через MediaPlayer (WPF), WAV — через SoundPlayer. Оба асинхронные, возвращаются сразу.
function Start-Audio([string]$audioPath) {
    if ([string]::IsNullOrWhiteSpace($audioPath)) { return }
    if (-not (Test-Path -LiteralPath $audioPath)) {
        [Console]::Error.WriteLine("notify.ps1: звук не найден: $audioPath")
        return
    }
    $script:audioKind = if ([System.IO.Path]::GetExtension($audioPath).ToLowerInvariant() -eq '.mp3') { 'mp3' } else { 'wav' }
    try {
        if ($script:audioKind -eq 'mp3') { Start-AudioMp3 $audioPath }
        else { Start-AudioWav $audioPath }
    }
    catch {
        [Console]::Error.WriteLine("notify.ps1: звук не проигран: $($_.Exception.Message)")
    }
}

function Start-AudioWav([string]$audioPath) {
    $script:wavMs = Get-WavDurationMs $audioPath
    if ($script:wavMs -le 0) {
        $script:wavMs = [int][math]::Round((([System.IO.FileInfo]$audioPath).Length - 44) / 2 / 44.1)
        if ($script:wavMs -lt 0) { $script:wavMs = 0 }
    }
    $script:audioMs = $script:wavMs
    $script:soundPlayer = New-Object System.Media.SoundPlayer $audioPath
    $script:soundStart = Get-Date
    $script:soundPlayer.Play()   # асинхронно, возвращается сразу
    $script:soundStarted = $true
    Diag ("звук запущен (wav): " + (Split-Path -Path $audioPath -Leaf) + " ~" + $script:wavMs + " ms")
}

function Start-AudioMp3([string]$audioPath) {
    Add-Type -AssemblyName PresentationCore -ErrorAction Stop
    $script:mediaPlayer = New-Object System.Windows.Media.MediaPlayer
    $script:mediaPlayer.Volume = 1.0
    $script:mediaPlayer.Add_MediaEnded({
            $script:audioDone = $true
            Diag 'звук завершён (mp3): MediaEnded'
        })
    $script:mediaPlayer.Open((New-Object System.Uri $audioPath))
    $script:mediaPlayer.Play()   # запустится, как только откроется поток
    $script:soundStart = Get-Date
    $script:soundStarted = $true
    $script:audioMs = 0
    Diag ("звук запущен (mp3): " + (Split-Path -Path $audioPath -Leaf))
}

# Обновить оценку длительности MP3 из NaturalDuration (после MediaOpened).
function Update-MediaDuration {
    if ($null -eq $script:mediaPlayer) { return }
    try {
        $natural = $script:mediaPlayer.NaturalDuration
        if ($natural.HasTimeSpan) {
            $ms = [int][math]::Round($natural.TimeSpan.TotalMilliseconds)
            if ($ms -gt 0 -and $ms -ne $script:audioMs) {
                $script:audioMs = $ms
                Diag ("mp3: длительность " + $ms + " ms")
            }
        }
    }
    catch { }
}

# Дождаться конца своего файла: оценка длительности + MediaEnded, не дольше $MaxMs.
function Wait-AudioEnd([int]$MaxMs) {
    if (-not $script:soundStarted) { return }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $limit = $MaxMs
    while (-not $script:audioDone) {
        if ($script:audioKind -eq 'mp3') {
            Update-MediaDuration
            if ($script:audioMs -gt 0) { $limit = [math]::Min($limit, $script:audioMs + 400) }
        }
        if ($script:audioMs -gt 0 -and $sw.ElapsedMilliseconds -ge ($script:audioMs + 400)) { break }
        # неизвестная длительность (битый/неоткрывшийся поток) — не ждём все 20 с
        if ($script:audioKind -eq 'mp3' -and $script:audioMs -le 0 -and $sw.ElapsedMilliseconds -ge 3000) { break }
        if ($sw.ElapsedMilliseconds -ge $limit) { break }
        if ($script:audioKind -eq 'mp3') { Pump-Dispatcher 30 }
        else { Start-Sleep -Milliseconds 30 }
    }
    if ($script:audioKind -eq 'mp3' -and $null -ne $script:mediaPlayer) {
        try { $script:mediaPlayer.Stop() } catch { }
        try { $script:mediaPlayer.Close() } catch { }
    }
    Diag ("звук завершён (" + $script:audioKind + "): ждали " + $sw.ElapsedMilliseconds + " ms")
}

$chimePath = $null
if ($playSound) {
    $chimePath = Resolve-ChimePath $kindValue $customSound
    Diag ("вид=$kindValue, звук=" + (Split-Path -Path $chimePath -Leaf) + ", свой=" + $script:audioIsCustom)
}

# --- 2a. -PreviewSound: только звук, без окна (кнопка «Прослушать» в настройках) ----------
if ($PreviewSound) {
    if (-not $playSound) {
        Diag 'preview-sound: звук выключен, играть нечего'
        exit 0
    }
    Diag 'preview-sound: окно не показываем'
    Start-Audio $chimePath
    if (-not $script:soundStarted) { Fail "не удалось запустить звук: $chimePath" }
    Wait-AudioEnd -MaxMs 20000
    exit 0
}

# --- 3. WPF: безрамочное topmost-окно, не забирающее фокус --------------------------------
$exitCode = 0
try {
    Add-Type -AssemblyName PresentationFramework   # UI-контролы, Window, SystemParameters
    Add-Type -AssemblyName PresentationCore        # кисти, эффекты, анимации
    Add-Type -AssemblyName WindowsBase             # System.Windows.Media.Color и пр.
    Diag 'WPF-сборки загружены'

    if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
        Fail 'нужен STA-поток: запускайте через powershell.exe (5.1) или с -STA'
    }

    # Палитра по виду уведомления.
    if ($kindValue -eq 'question') {
        $accentFrom = [System.Windows.Media.Color]::FromRgb(0xFF, 0xB4, 0x54)   # янтарь
        $accentTo = [System.Windows.Media.Color]::FromRgb(0xFF, 0x7A, 0x45)     # оранжевый
        $borderColor = [System.Windows.Media.Color]::FromRgb(0x4A, 0x40, 0x34)
    }
    else {
        $accentFrom = [System.Windows.Media.Color]::FromRgb(0x5B, 0x9D, 0xFF)   # синий
        $accentTo = [System.Windows.Media.Color]::FromRgb(0x9B, 0x6B, 0xFF)     # фиолетовый
        $borderColor = [System.Windows.Media.Color]::FromRgb(0x3A, 0x3F, 0x4B)
    }

    # --- окно ------------------------------------------------------------------------------
    $window = New-Object System.Windows.Window
    $window.Title = 'DSH topmost-notify'
    $window.Width = 444
    $window.Height = 144
    $window.WindowStyle = [System.Windows.WindowStyle]::None
    $window.AllowsTransparency = $true
    $window.Background = [System.Windows.Media.Brushes]::Transparent
    $window.ShowActivated = $false          # не активироваться при показе -> фокус остаётся у пользователя
    $window.ShowInTaskbar = $false
    $window.ResizeMode = [System.Windows.ResizeMode]::NoResize
    $window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
    $window.Topmost = $true
    $window.Opacity = 0
    $window.FontFamily = New-Object System.Windows.Media.FontFamily 'Segoe UI'
    $window.UseLayoutRounding = $true
    $window.SnapsToDevicePixels = $true

    # --- карточка --------------------------------------------------------------------------
    $card = New-Object System.Windows.Controls.Border
    $card.Margin = [System.Windows.Thickness]::new(12)
    $card.CornerRadius = [System.Windows.CornerRadius]::new(14)
    $card.BorderThickness = [System.Windows.Thickness]::new(1)
    $card.BorderBrush = New-Object System.Windows.Media.SolidColorBrush $borderColor
    $cardBg = New-Object System.Windows.Media.LinearGradientBrush
    $cardBg.StartPoint = [System.Windows.Point]::new(0, 0)
    $cardBg.EndPoint = [System.Windows.Point]::new(1, 1)
    $cardBg.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromRgb(0x22, 0x25, 0x2E)), 0.0))
    $cardBg.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromRgb(0x1A, 0x1C, 0x23)), 1.0))
    $card.Background = $cardBg

    $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
    $shadow.BlurRadius = 20
    $shadow.ShadowDepth = 3
    $shadow.Direction = 270
    $shadow.Opacity = 0.5
    $shadow.Color = [System.Windows.Media.Colors]::Black
    $card.Effect = $shadow

    $grid = New-Object System.Windows.Controls.Grid
    $colAccent = New-Object System.Windows.Controls.ColumnDefinition
    $colAccent.Width = [System.Windows.GridLength]::Auto
    $colText = New-Object System.Windows.Controls.ColumnDefinition
    $colText.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $grid.ColumnDefinitions.Add($colAccent)
    $grid.ColumnDefinitions.Add($colText)

    # цветная акцент-полоска слева: цвет зависит от вида (completed / question)
    $accent = New-Object System.Windows.Controls.Border
    $accent.Width = 5
    $accent.CornerRadius = [System.Windows.CornerRadius]::new(14, 0, 0, 14)
    $accentBg = New-Object System.Windows.Media.LinearGradientBrush
    $accentBg.StartPoint = [System.Windows.Point]::new(0, 0)
    $accentBg.EndPoint = [System.Windows.Point]::new(0, 1)
    $accentBg.GradientStops.Add((New-Object System.Windows.Media.GradientStop $accentFrom, 0.0))
    $accentBg.GradientStops.Add((New-Object System.Windows.Media.GradientStop $accentTo, 1.0))
    $accent.Background = $accentBg
    [System.Windows.Controls.Grid]::SetColumn($accent, 0)
    [void]$grid.Children.Add($accent)

    $stack = New-Object System.Windows.Controls.StackPanel
    $stack.Margin = [System.Windows.Thickness]::new(16, 0, 18, 0)
    $stack.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    [System.Windows.Controls.Grid]::SetColumn($stack, 1)

    $titleBlock = New-Object System.Windows.Controls.TextBlock
    $titleBlock.FontSize = 15
    $titleBlock.FontWeight = [System.Windows.FontWeights]::SemiBold
    $titleBlock.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0xF3, 0xF6, 0xFB))
    $titleBlock.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
    $titleBlock.TextWrapping = [System.Windows.TextWrapping]::NoWrap
    $titleBlock.Text = $titleText
    [void]$stack.Children.Add($titleBlock)

    $bodyBlock = New-Object System.Windows.Controls.TextBlock
    $bodyBlock.FontSize = 12.5
    $bodyBlock.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0xA6, 0xAE, 0xBD))
    $bodyBlock.Margin = [System.Windows.Thickness]::new(0, 5, 0, 0)
    $bodyBlock.TextWrapping = [System.Windows.TextWrapping]::Wrap
    $bodyBlock.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
    $bodyBlock.MaxHeight = 34
    $bodyBlock.LineHeight = 16
    $bodyBlock.LineStackingStrategy = [System.Windows.LineStackingStrategy]::BlockLineHeight
    if ([string]::IsNullOrWhiteSpace($bodyText)) {
        $bodyBlock.Visibility = [System.Windows.Visibility]::Collapsed
    }
    else {
        $bodyBlock.Text = $bodyText.Trim()
    }
    [void]$stack.Children.Add($bodyBlock)

    [void]$grid.Children.Add($stack)
    $card.Child = $grid
    $window.Content = $card
    Diag 'UI построен'

    # Стабильная позиция: верхний правый угол рабочей области (учитывает панель задач), отступ 24 px.
    $workArea = [System.Windows.SystemParameters]::WorkArea
    $edge = 24
    $window.Left = [math]::Round($workArea.Right - $window.Width - $edge)
    $window.Top = [math]::Round($workArea.Top + $edge)

    # Появление (120 мс) + авто-закрытие через durationMs (последние 150 мс — исчезание).
    $fadeOutMs = 150
    $window.Add_Loaded({
            Diag 'Loaded'
            # Звук — ровно в момент появления карточки (раньше он «отрывался» от окна на ~1.9 с).
            if ($playSound -and -not $script:soundStarted) { Start-Audio $chimePath }

            $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation
            $fadeIn.From = 0.0
            $fadeIn.To = 1.0
            $fadeIn.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(120))
            $fadeIn.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::HoldEnd
            $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeIn)

            # отсчёт durationMs начинается с момента, когда окно реально показано
            $script:closeTimer = New-Object System.Windows.Threading.DispatcherTimer
            $script:closeTimer.Interval = [TimeSpan]::FromMilliseconds([math]::Max(150, $duration - $fadeOutMs))
            $script:closeTimer.Add_Tick({
                    $script:closeTimer.Stop()
                    $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation
                    $fadeOut.From = 1.0
                    $fadeOut.To = 0.0
                    $fadeOut.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds($fadeOutMs))
                    $fadeOut.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::HoldEnd
                    $fadeOut.Add_Completed({ $window.Close() })
                    $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeOut)
                })
            $script:closeTimer.Start()
        })

    # Страховка от «зависшего» окна: принудительно закрыть через durationMs + 3 с.
    $watchdog = New-Object System.Windows.Threading.DispatcherTimer
    $watchdog.Interval = [TimeSpan]::FromMilliseconds($duration + 3000)
    $watchdog.Add_Tick({
            $watchdog.Stop()
            try { $window.Close() } catch { }
            [System.Environment]::Exit(0)
        })

    $window.Add_Closed({ [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })

    $watchdog.Start()
    $window.Show()                                  # Show, а не ShowDialog: без активации окна
    Diag 'Show() вернулся'
    [System.Windows.Threading.Dispatcher]::Run()    # цикл сообщений, выходит по Closed
    Diag 'окно закрыто'
}
catch {
    [Console]::Error.WriteLine("notify.ps1: $($_.Exception.Message)")
    $exitCode = 1
}

# --- 4. Фолбэк: если WPF-часть не дошла до показа окна, звук всё равно должен быть ---------
if ($playSound -and -not $script:soundStarted -and $chimePath) {
    Start-Audio $chimePath
}

# --- 5. Дождаться звука: свой файл — до конца (не дольше ~20 с), встроенный chime — 350 мс --
if ($script:soundStarted) {
    if ($script:audioIsCustom) {
        Wait-AudioEnd -MaxMs 20000
    }
    elseif ($script:audioKind -eq 'mp3') {
        # встроенных mp3 нет, но на случай подмены файла в host/ — короткий хвост
        Wait-AudioEnd -MaxMs 350
    }
    elseif ($null -ne $script:soundStart) {
        $elapsedMs = ((Get-Date) - $script:soundStart).TotalMilliseconds
        $remain = [math]::Min($script:wavMs - $elapsedMs, 350)
        if ($remain -gt 0) { Start-Sleep -Milliseconds ([int]$remain) }
    }
}

exit $exitCode
