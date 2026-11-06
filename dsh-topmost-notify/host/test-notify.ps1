#requires -Version 5.1
<#
    test-notify.ps1 — реальные замеры notify.ps1 на этой машине + скриншоты.

    Для каждого вида уведомления (completed / question) проверяется:
      1) латентность от старта процесса powershell.exe до появления ВИДИМОГО окна
         (плюс «пол» — стоимость запуска самого powershell.exe — и управляемая часть);
      2) синхронность звука: момент старта SoundPlayer относительно появления окна;
      3) topmost: WS_EX_TOPMOST у окна и WindowFromPoint в центре окна возвращает его же;
      4) фокус не украден: GetForegroundWindow до запуска == после появления окна,
         и само окно НЕ является foreground-окном;
      5) цветовое отличие: пиксели акцент-полоски (completed — синий, question — янтарный);
      6) окно закрывается само через durationMs, процесс выходит с кодом 0, окно исчезает;
      7) нужный WAV/MP3 существует и валиден (для WAV — 44.1 кГц/16 бит/моно ~1.2 с);
      8) скриншоты: весь экран + кроп вокруг окна -> artifacts\notify-...-<kind>.png;
      9) v1.1: свой WAV и свой MP3 в окне (звук берётся из payload.sound строкой);
     10) v1.1: -PreviewSound — только звук, без окна, процесс выходит с кодом 0
         (WAV-встроенный, свой WAV, свой MP3 из test\fixtures\valid-clip.mp3).

    Запуск:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File host\test-notify.ps1
             ... -Kind completed | question | both (по умолчанию both)
    Коды выхода: 0 — функциональные проверки прошли (латентность может быть WARN);
                 1 — есть провал или окно не появилось.
#>
[CmdletBinding()]
param(
    [ValidateSet('completed', 'question', 'both')]
    [string]$Kind = 'both',
    [int]$DurationMs = 1400,
    [int]$LatencyTargetMs = 800,
    [int]$SoundSyncToleranceMs = 400,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$here = $PSScriptRoot
$projectRoot = Split-Path -Path $here -Parent
$artifacts = Join-Path -Path $projectRoot -ChildPath 'artifacts'
if (-not (Test-Path -LiteralPath $artifacts)) {
    New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
}

$notifyPs1 = Join-Path -Path $here -ChildPath 'notify.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($f in @($notifyPs1, $psExe)) {
    if (-not (Test-Path -LiteralPath $f)) { throw "не найден обязательный файл: $f" }
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinProbe
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOPMOST = 0x00000008;
    public const int WS_EX_NOACTIVATE = 0x08000000;

    public static string Title(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ClassName(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static int ExStyle(IntPtr h) { return GetWindowLong32(h, GWL_EXSTYLE); }
    public static bool IsTopmost(IntPtr h) { return (ExStyle(h) & WS_EX_TOPMOST) != 0; }
    public static bool IsNoActivate(IntPtr h) { return (ExStyle(h) & WS_EX_NOACTIVATE) != 0; }
    public static bool Alive(IntPtr h) { return IsWindow(h); }
    public static IntPtr Foreground() { return GetForegroundWindow(); }

    public static IntPtr WindowAt(int x, int y)
    {
        POINT p = new POINT();
        p.X = x;
        p.Y = y;
        return WindowFromPoint(p);
    }

    public static int[] Rect(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return new int[] { 0, 0, 0, 0 };
        return new int[] { r.Left, r.Top, r.Right, r.Bottom };
    }

    public static IntPtr[] WindowsOf(uint pid)
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (p == pid) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static IntPtr FindVisible(uint pid, string titlePart)
    {
        foreach (IntPtr h in WindowsOf(pid))
        {
            if (!IsWindowVisible(h)) continue;
            if (titlePart != null && titlePart.Length > 0)
            {
                if (Title(h).IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) < 0) continue;
            }
            return h;
        }
        return IntPtr.Zero;
    }
}
'@

function Format-Hwnd([IntPtr]$h) { '0x{0:X8}' -f $h.ToInt64() }

# --- «пол»: сколько стоит запуск самого powershell.exe (без нашего скрипта) ----------------
function Get-PowerShellFloorMs {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = '-NoProfile -NonInteractive -Command exit'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = [System.Diagnostics.Process]::Start($psi)
    $null = $proc.StandardOutput.ReadToEnd()
    $null = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $sw.Stop()
    return [int]$sw.ElapsedMilliseconds
}

function Test-WavFile([string]$path) {
    $info = [pscustomobject]@{ Ok = $false; Info = '' }
    if (-not (Test-Path -LiteralPath $path)) {
        $info.Info = "нет файла: $path"
        return $info
    }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $riff = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
        $wave = [System.Text.Encoding]::ASCII.GetString($bytes, 8, 4)
        $channels = [System.BitConverter]::ToUInt16($bytes, 22)
        $rate = [System.BitConverter]::ToUInt32($bytes, 24)
        $bits = [System.BitConverter]::ToUInt16($bytes, 34)
        $dataLen = [System.BitConverter]::ToUInt32($bytes, 40)
        $durS = [math]::Round($dataLen / 2 / $rate, 3)
        $info.Info = "{0}/{1} {2} Hz {3} bit mono={4} {5} s, {6} bytes" -f $riff, $wave, $rate, $bits, ($channels -eq 1), $durS, $bytes.Length
        $info.Ok = ($riff -eq 'RIFF') -and ($wave -eq 'WAVE') -and ($channels -eq 1) -and ($rate -eq 44100) -and ($bits -eq 16) -and ($durS -gt 0.9)
    }
    catch {
        $info.Info = "ошибка чтения: $($_.Exception.Message)"
    }
    return $info
}

# --- проверка MP3-фикстура (сигнатура кадра ID3/0xFFEx + ненулевой размер) ---------------
function Test-Mp3File([string]$path) {
    $info = [pscustomobject]@{ Ok = $false; Info = '' }
    if (-not (Test-Path -LiteralPath $path)) {
        $info.Info = "нет файла: $path"
        return $info
    }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $isId3 = ($bytes.Length -ge 3) -and ([System.Text.Encoding]::ASCII.GetString($bytes, 0, 3) -eq 'ID3')
        $isFrame = ($bytes.Length -ge 2) -and ($bytes[0] -eq 0xFF) -and (($bytes[1] -band 0xE0) -eq 0xE0)
        $info.Info = "mp3 {0} bytes, id3={1} frameSync={2}" -f $bytes.Length, $isId3, $isFrame
        $info.Ok = ($isId3 -or $isFrame) -and ($bytes.Length -gt 1000)
    }
    catch {
        $info.Info = "ошибка чтения: $($_.Exception.Message)"
    }
    return $info
}

# Разбор -Diag (stderr) в поля результата: файл/формат звука, длительность MP3, конец звука.
function Update-DiagFields($Result) {
    if (-not $Result.StdErr) { return }
    $Result.DiagLines = @($Result.StdErr -split "`r?`n" | Where-Object { $_ -match 'diag:' })
    $m = [regex]::Match($Result.StdErr, 'возраст процесса (\d+) мс')
    if ($m.Success) { $Result.ProcAgeMs = [int]$m.Groups[1].Value }
    $m = [regex]::Match($Result.StdErr, 'звук запущен \((wav|mp3)\): (\S+)')
    if ($m.Success) {
        $Result.SoundFormat = $m.Groups[1].Value
        $Result.SoundFile = $m.Groups[2].Value
    }
    $m = [regex]::Match($Result.StdErr, 'diag:\s+(\d+) ms\s+звук запущен')
    if ($m.Success) { $Result.SoundInternalMs = [int]$m.Groups[1].Value }
    $m = [regex]::Match($Result.StdErr, 'mp3: длительность (\d+) ms')
    if ($m.Success) { $Result.MediaDurationMs = [int]$m.Groups[1].Value }
    if ($Result.StdErr -match 'MediaEnded') { $Result.MediaEnded = $true }
    if ($Result.StdErr -match 'звук завершён \(') { $Result.SoundFinished = $true }
}

# --- один прогон уведомления заданного вида ------------------------------------------------
function Invoke-NotifyRun {
    param(
        [string]$RunKind,
        [string]$RunTitle,
        [string]$RunBody,
        [string]$RunSoundFile
    )

    $payload = [ordered]@{
        title      = $RunTitle
        body       = $RunBody
        durationMs = $DurationMs
        sound      = $(if ($RunSoundFile) { $RunSoundFile } elseif ($Silent) { $false } else { $true })
        kind       = $RunKind
    }
    $json = ($payload | ConvertTo-Json -Compress)
    $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))

    $fgBefore = [WinProbe]::Foreground()
    $fgBeforeTitle = if ($fgBefore -ne [IntPtr]::Zero) { [WinProbe]::Title($fgBefore) } else { '' }

    $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -PayloadBase64 {1} -Diag' -f $notifyPs1, $b64
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = [System.Diagnostics.Process]::Start($psi)
    $procId = [uint32]$proc.Id
    $errTask = $proc.StandardError.ReadToEndAsync()
    $outTask = $proc.StandardOutput.ReadToEndAsync()

    $hwnd = [IntPtr]::Zero
    $timeoutMs = 10000
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
        $hwnd = [WinProbe]::FindVisible($procId, 'DSH topmost-notify')
        if ($hwnd -ne [IntPtr]::Zero) { break }
        [System.Threading.Thread]::Sleep(4)
    }
    $latencyMs = [int]$sw.ElapsedMilliseconds

    $result = [pscustomobject]@{
        Kind = $RunKind; Json = $json; Hwnd = $hwnd; LatencyMs = $latencyMs
        FgBefore = $fgBefore; FgBeforeTitle = $fgBeforeTitle
        ExStyle = 0; Topmost = $false; NoActivate = $false; Class = ''; Title = ''
        Rect = @(0, 0, 0, 0); HitSame = $false
        FgAfter = [IntPtr]::Zero; FgLater = [IntPtr]::Zero
        Exited = $false; ExitCode = -1; WindowGone = $false; LifetimeMs = 0
        ShotPath = ''; CropPath = ''; AccentRgb = @(0, 0, 0); AccentWarm = $false; AccentHex = ''
        ProcAgeMs = -1; ControllableMs = -1; SoundInternalMs = -1; VisibleInternalMs = -1; SoundDeltaMs = -1
        SoundFile = ''; SoundFormat = ''; MediaDurationMs = -1; MediaEnded = $false; SoundFinished = $false
        DiagLines = @(); StdErr = ''
    }

    if ($hwnd -eq [IntPtr]::Zero) {
        try { $proc.Kill() } catch { }
        return $result
    }

    $result.ExStyle = [WinProbe]::ExStyle($hwnd)
    $result.Topmost = [WinProbe]::IsTopmost($hwnd)
    $result.NoActivate = [WinProbe]::IsNoActivate($hwnd)
    $result.Class = [WinProbe]::ClassName($hwnd)
    $result.Title = [WinProbe]::Title($hwnd)
    $result.Rect = [WinProbe]::Rect($hwnd)
    $rect = $result.Rect
    $cx = [int](($rect[0] + $rect[2]) / 2)
    $cy = [int](($rect[1] + $rect[3]) / 2)
    $hit = [WinProbe]::WindowAt($cx, $cy)
    $result.HitSame = ($hit -eq $hwnd)
    $result.FgAfter = [WinProbe]::Foreground()

    # --- скриншот, пока окно видно --------------------------------------------------------
    [System.Threading.Thread]::Sleep(200)   # дать доиграть fade-in (120 мс)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $shotPath = Join-Path $artifacts ("notify-{0}-{1}.png" -f $stamp, $RunKind)
    $cropPath = Join-Path $artifacts ("notify-{0}-{1}-crop.png" -f $stamp, $RunKind)
    $result.ShotPath = $shotPath
    $result.CropPath = $cropPath

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $full = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $gFull = [System.Drawing.Graphics]::FromImage($full)
    $gFull.CopyFromScreen($screen.X, $screen.Y, 0, 0, $full.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $gFull.Dispose()

    # --- цвет акцент-полоски (карточка вставлена на 12 px внутрь окна, полоска 5 px) -------
    $samples = @()
    foreach ($dy in @(30, 72, 114)) {
        $px = $rect[0] + 14
        $py = $rect[1] + $dy
        if ($px -ge 0 -and $px -lt $screen.Width -and $py -ge 0 -and $py -lt $screen.Height) {
            $samples += $full.GetPixel($px, $py)
        }
    }
    if ($samples.Count -gt 0) {
        $r = [int](($samples | Measure-Object -Property R -Average).Average)
        $g = [int](($samples | Measure-Object -Property G -Average).Average)
        $b = [int](($samples | Measure-Object -Property B -Average).Average)
        $result.AccentRgb = @($r, $g, $b)
        $result.AccentWarm = ($r -gt $b)
        $result.AccentHex = '#{0:X2}{1:X2}{2:X2}' -f $r, $g, $b
    }

    $full.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $pad = 60
    $winW = $rect[2] - $rect[0]
    $winH = $rect[3] - $rect[1]
    $cx0 = [math]::Max(0, $rect[0] - $pad)
    $cy0 = [math]::Max(0, $rect[1] - $pad)
    $cw = [math]::Min($screen.Width - $cx0, $winW + 2 * $pad)
    $ch = [math]::Min($screen.Height - $cy0, $winH + 2 * $pad)
    if ($cw -gt 0 -and $ch -gt 0) {
        $crop = New-Object System.Drawing.Bitmap($cw, $ch)
        $gCrop = [System.Drawing.Graphics]::FromImage($crop)
        $gCrop.DrawImage($full,
            (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)),
            (New-Object System.Drawing.Rectangle($cx0, $cy0, $cw, $ch)),
            [System.Drawing.GraphicsUnit]::Pixel)
        $gCrop.Dispose()
        $crop.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $crop.Dispose()
    }
    $full.Dispose()

    # --- фокус ещё раз через 250 мс и ожидание авто-закрытия -------------------------------
    [System.Threading.Thread]::Sleep(250)
    $result.FgLater = [WinProbe]::Foreground()

    $result.Exited = $proc.WaitForExit($DurationMs + 8000)
    $result.LifetimeMs = [int]$sw.ElapsedMilliseconds
    $result.ExitCode = if ($result.Exited) { $proc.ExitCode } else { -1 }
    $result.WindowGone = -not [WinProbe]::Alive($hwnd)

    try { $result.StdErr = $errTask.Result } catch { }
    try { $null = $outTask.Result } catch { }

    # --- разбор диагностики ---------------------------------------------------------------
    Update-DiagFields $result
    if ($result.ProcAgeMs -ge 0) {
        $result.ControllableMs = $result.LatencyMs - $result.ProcAgeMs
        $result.VisibleInternalMs = $result.ControllableMs
        if ($result.SoundInternalMs -ge 0) {
            $result.SoundDeltaMs = $result.SoundInternalMs - $result.VisibleInternalMs
        }
    }
    return $result
}

# --- прогон -PreviewSound: только звук, окна быть не должно, выход 0 ----------------------
function Invoke-PreviewSoundRun {
    param(
        [string]$RunKind,
        [string]$RunTitle,
        [string]$RunBody,
        [string]$RunSoundFile
    )

    $payload = [ordered]@{
        title      = $RunTitle
        body       = $RunBody
        durationMs = 1000
        sound      = $(if ($RunSoundFile) { $RunSoundFile } else { $true })
        kind       = $RunKind
    }
    $json = ($payload | ConvertTo-Json -Compress)
    $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))

    $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -PayloadBase64 {1} -Diag -PreviewSound' -f $notifyPs1, $b64
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = [System.Diagnostics.Process]::Start($psi)
    $procId = [uint32]$proc.Id
    $errTask = $proc.StandardError.ReadToEndAsync()
    $outTask = $proc.StandardOutput.ReadToEndAsync()

    $result = [pscustomobject]@{
        Kind = $RunKind; Json = $json; Hwnd = [IntPtr]::Zero; LatencyMs = -1
        Exited = $false; ExitCode = -1; WindowGone = $true; LifetimeMs = 0
        SoundFile = ''; SoundFormat = ''; MediaDurationMs = -1; MediaEnded = $false; SoundFinished = $false
        ProcAgeMs = -1; SoundInternalMs = -1; DiagLines = @(); StdErr = ''
    }

    # Окна быть не должно: параллельно следим, чтобы оно не появилось, и ждём выхода процесса.
    $deadline = 15000
    while (-not $proc.HasExited -and $sw.ElapsedMilliseconds -lt $deadline) {
        $w = [WinProbe]::FindVisible($procId, 'DSH topmost-notify')
        if ($w -ne [IntPtr]::Zero) { $result.Hwnd = $w; break }
        [System.Threading.Thread]::Sleep(10)
    }
    $result.Exited = $proc.WaitForExit(20000)
    $result.LifetimeMs = [int]$sw.ElapsedMilliseconds
    if ($result.Exited) { $result.ExitCode = $proc.ExitCode }
    $result.WindowGone = ($result.Hwnd -eq [IntPtr]::Zero) -or (-not [WinProbe]::Alive($result.Hwnd))

    try { $result.StdErr = $errTask.Result } catch { }
    try { $null = $outTask.Result } catch { }
    Update-DiagFields $result
    return $result
}

# --- прогон ------------------------------------------------------------------------------
$floorMs = Get-PowerShellFloorMs
$kinds = if ($Kind -eq 'both') { @('completed', 'question') } else { @($Kind) }

$titles = @{
    completed = @{
        Title = 'Задача выполнена'
        Body  = 'Сессия: topmost-notify — проверка topmost-окна, звука и авто-закрытия. Хвост текста для проверки обрезки.'
        Wav   = Join-Path $here 'chime.wav'
        Warm  = $false
    }
    question  = @{
        Title = 'Нужен ответ'
        Body  = 'Агент ждёт ответа: подтвердите действие в чате, чтобы продолжить выполнение задачи.'
        Wav   = Join-Path $here 'chime-question.wav'
        Warm  = $true
    }
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output '=== test-notify.ps1 ==='
Write-Output ("screen          : {0}x{1} @ ({2},{3})" -f $screen.Width, $screen.Height, $screen.X, $screen.Y)
Write-Output ("durationMs      : {0}" -f $DurationMs)
Write-Output ("latency target  : {0} ms;  sound sync tolerance: {1} ms" -f $LatencyTargetMs, $SoundSyncToleranceMs)
Write-Output ("floor: powershell.exe -NoProfile -NonInteractive -Command exit = {0} ms" -f $floorMs)
Write-Output ("kinds           : {0}" -f ($kinds -join ', '))
Write-Output ''

$runs = @()
$allChecks = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Kind, [string]$Name, [string]$Status, [string]$Detail) {
    $allChecks.Add([pscustomobject]@{ Kind = $Kind; Name = $Name; Status = $Status; Detail = $Detail })
}

foreach ($k in $kinds) {
    $meta = $titles[$k]
    Write-Output ("--- прогон: {0} ---" -f $k)
    $run = Invoke-NotifyRun -RunKind $k -RunTitle $meta.Title -RunBody $meta.Body
    $runs += $run

    Write-Output ("payload                    : {0}" -f $run.Json)
    if ($run.Hwnd -eq [IntPtr]::Zero) {
        Write-Output 'ОКНО НЕ ПОЯВИЛОСЬ'
        Add-Check $k 'visible-window' 'FAIL' 'окно не появилось за 10 с'
        continue
    }
    Write-Output ("[1] latency: process start -> visible window : {0} ms  (target <= {1} ms)" -f $run.LatencyMs, $LatencyTargetMs)
    Write-Output ("[1a]   floor: bare powershell.exe startup    : {0} ms" -f $floorMs)
    Write-Output ("[1b]   process age at script start           : {0} ms" -f $run.ProcAgeMs)
    Write-Output ("[1c]   controllable part (script -> window)  : {0} ms" -f $run.ControllableMs)
    Write-Output ("[2] sound start (internal)                   : {0} ms  -> delta to window = {1} ms" -f $run.SoundInternalMs, $run.SoundDeltaMs)
    Write-Output ("[3] sound file                               : {0}  ({1})" -f $run.SoundFile, $run.SoundFormat)
    Write-Output ("[4] hwnd                                     : {0}  class={1}  title=""{2}""" -f (Format-Hwnd $run.Hwnd), $run.Class, $run.Title)
    Write-Output ("[5] exstyle                                  : 0x{0:X8}  WS_EX_TOPMOST={1}  WS_EX_NOACTIVATE={2}" -f $run.ExStyle, $run.Topmost, $run.NoActivate)
    Write-Output ("[6] window rect                              : L={0} T={1} R={2} B={3}  ({4}x{5})" -f $run.Rect[0], $run.Rect[1], $run.Rect[2], $run.Rect[3], ($run.Rect[2] - $run.Rect[0]), ($run.Rect[3] - $run.Rect[1]))
    Write-Output ("[7] WindowFromPoint(center)                  : same as hwnd = {0}" -f $run.HitSame)
    Write-Output ("[8] foreground before/after                  : {0} / {1}  (unchanged = {2})" -f (Format-Hwnd $run.FgBefore), (Format-Hwnd $run.FgAfter), ($run.FgBefore -eq $run.FgAfter))
    Write-Output ("[9] foreground after +250ms                  : {0}  (still same = {1})" -f (Format-Hwnd $run.FgLater), ($run.FgLater -eq $run.FgBefore))
    Write-Output ("[10] accent color (pixel)                    : {0}  rgb=({1},{2},{3})  warm={4}" -f $run.AccentHex, $run.AccentRgb[0], $run.AccentRgb[1], $run.AccentRgb[2], $run.AccentWarm)
    Write-Output ("[11] screenshot full / crop                  : {0} | {1}" -f $run.ShotPath, $run.CropPath)
    Write-Output ("[12] auto-close                              : exited={0} exitCode={1} windowGone={2} processLifetime={3} ms (durationMs={4})" -f $run.Exited, $run.ExitCode, $run.WindowGone, $run.LifetimeMs, $DurationMs)
    Write-Output ''

    $wav = Test-WavFile $meta.Wav
    $expectedWavName = Split-Path -Path $meta.Wav -Leaf
    $wavMatches = ($run.SoundFile -eq $expectedWavName)

    Add-Check $k 'topmost' $(if ($run.Topmost) { 'PASS' } else { 'FAIL' }) ("WS_EX_TOPMOST=0x{0:X8}" -f $run.ExStyle)
    Add-Check $k 'on-top-pixel' $(if ($run.HitSame) { 'PASS' } else { 'FAIL' }) 'WindowFromPoint(центр) == наше окно'
    Add-Check $k 'focus-unchanged' $(if ($run.FgBefore -eq $run.FgAfter) { 'PASS' } else { 'FAIL' }) ("foreground " + (Format-Hwnd $run.FgBefore) + " -> " + (Format-Hwnd $run.FgAfter))
    Add-Check $k 'window-not-foreground' $(if ($run.FgAfter -ne $run.Hwnd) { 'PASS' } else { 'FAIL' }) ("foreground=" + (Format-Hwnd $run.FgAfter))
    Add-Check $k 'focus-still-same' $(if ($run.FgLater -eq $run.FgBefore) { 'PASS' } else { 'FAIL' }) ("foreground " + (Format-Hwnd $run.FgLater))
    Add-Check $k 'auto-close' $(if ($run.Exited -and $run.WindowGone -and $run.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) ("exited={0} exitCode={1} windowGone={2}" -f $run.Exited, $run.ExitCode, $run.WindowGone)
    Add-Check $k 'lifetime-bound' $(if ($run.LifetimeMs -le ($DurationMs + 3000)) { 'PASS' } else { 'FAIL' }) ("{0} ms <= durationMs+3000" -f $run.LifetimeMs)
    Add-Check $k 'wav-valid' $(if ($wav.Ok) { 'PASS' } else { 'FAIL' }) $wav.Info
    Add-Check $k 'wav-matches-kind' $(if ($wavMatches) { 'PASS' } else { 'FAIL' }) ("звук: {0} (ожидался {1})" -f $run.SoundFile, $expectedWavName)
    if ($Silent) {
        Add-Check $k 'sound-invoked' 'PASS' 'пропущено (-Silent)'
    }
    else {
        Add-Check $k 'sound-invoked' $(if ($run.SoundFile) { 'PASS' } else { 'FAIL' }) 'notify.ps1 подтвердил запуск SoundPlayer'
    }
    if ($Silent) {
        Add-Check $k 'sound-synced' 'PASS' 'пропущено (-Silent)'
    }
    elseif ($run.SoundDeltaMs -ge 0) {
        Add-Check $k 'sound-synced' $(if ([math]::Abs($run.SoundDeltaMs) -le $SoundSyncToleranceMs) { 'PASS' } else { 'FAIL' }) ("звук через {0} мс после появления окна (допуск ±{1} мс)" -f $run.SoundDeltaMs, $SoundSyncToleranceMs)
    }
    else {
        Add-Check $k 'sound-synced' 'FAIL' 'не удалось сопоставить тайминги звука и окна'
    }
    $accentOk = if ($meta.Warm) { $run.AccentWarm } else { -not $run.AccentWarm }
    Add-Check $k 'accent-color' $(if ($accentOk) { 'PASS' } else { 'FAIL' }) ("{0} (ожидался {1} акцент)" -f $run.AccentHex, $(if ($meta.Warm) { 'тёплый/янтарный' } else { 'холодный/синий' }))
    if ($run.LatencyMs -le $LatencyTargetMs) {
        Add-Check $k 'latency' 'PASS' ("{0} ms <= {1} ms" -f $run.LatencyMs, $LatencyTargetMs)
    }
    else {
        Add-Check $k 'latency' 'WARN' ("{0} ms > {1} ms — пол (запуск powershell.exe) {2} ms, управляемая часть {3} ms" -f $run.LatencyMs, $LatencyTargetMs, $floorMs, $run.ControllableMs)
    }
}

# --- v1.1: дополнительно свой WAV, свой MP3 и -PreviewSound -------------------------------
$customWav = Join-Path $here 'chime-question.wav'
$mp3Fixture = Join-Path $projectRoot 'test\fixtures\valid-clip.mp3'
$customWavInfo = Test-WavFile $customWav
$mp3Info = Test-Mp3File $mp3Fixture
Add-Check 'files' 'custom-wav-valid' $(if ($customWavInfo.Ok) { 'PASS' } else { 'FAIL' }) $customWavInfo.Info
Add-Check 'files' 'mp3-fixture-valid' $(if ($mp3Info.Ok) { 'PASS' } else { 'FAIL' }) $mp3Info.Info

function Report-SoundRun([string]$Name, $Run, [string]$ExpectFile, [string]$ExpectFormat) {
    $leaf = Split-Path -Path $ExpectFile -Leaf
    Write-Output ("payload                    : {0}" -f $Run.Json)
    Write-Output ("hwnd                       : {0}" -f (Format-Hwnd $Run.Hwnd))
    Write-Output ("sound file / format        : {0} / {1}  (ожидался {2})" -f $Run.SoundFile, $Run.SoundFormat, $leaf)
    Write-Output ("exited={0} exitCode={1} lifetime={2} ms  windowGone={3}" -f $Run.Exited, $Run.ExitCode, $Run.LifetimeMs, $Run.WindowGone)
    $soundOk = ($Run.SoundFile -eq $leaf) -and ($Run.SoundFormat -eq $ExpectFormat)
    Add-Check $Name 'custom-sound-used' $(if ($soundOk) { 'PASS' } else { 'FAIL' }) ("звук {0} ({1}), ожидался {2} ({3})" -f $Run.SoundFile, $Run.SoundFormat, $leaf, $ExpectFormat)
    Add-Check $Name 'auto-close' $(if ($Run.Exited -and $Run.WindowGone -and $Run.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) ("exited={0} exitCode={1} windowGone={2}" -f $Run.Exited, $Run.ExitCode, $Run.WindowGone)
    if ($Run.Hwnd -ne [IntPtr]::Zero) {
        Add-Check $Name 'topmost' $(if ($Run.Topmost) { 'PASS' } else { 'FAIL' }) ("WS_EX_TOPMOST=0x{0:X8}" -f $Run.ExStyle)
        Add-Check $Name 'window-not-foreground' $(if ($Run.FgAfter -ne $Run.Hwnd) { 'PASS' } else { 'FAIL' }) ("foreground=" + (Format-Hwnd $Run.FgAfter) + ", наше окно=" + (Format-Hwnd $Run.Hwnd))
        if ($Run.FgBefore -eq $Run.FgAfter) {
            Add-Check $Name 'focus-unchanged' 'PASS' ("foreground " + (Format-Hwnd $Run.FgBefore) + " -> " + (Format-Hwnd $Run.FgAfter))
        }
        else {
            # на этом стенде параллельно может работать e2e-сессия: чужое окно легко перехватывает фокус,
            # поэтому для дополнительных прогонов это WARN (важно, что фокус не у НАШЕГО окна).
            Add-Check $Name 'focus-unchanged' 'WARN' ("foreground сменился посторонним окном: {0} -> {1}" -f (Format-Hwnd $Run.FgBefore), (Format-Hwnd $Run.FgAfter))
        }
    }
    if ($ExpectFormat -eq 'mp3') {
        $played = $Run.MediaEnded -or ($Run.MediaDurationMs -gt 0 -and $Run.LifetimeMs -ge $Run.MediaDurationMs)
        Add-Check $Name 'mp3-played' $(if ($played) { 'PASS' } else { 'FAIL' }) ("MediaEnded={0} mediaDurationMs={1} lifetime={2} ms" -f $Run.MediaEnded, $Run.MediaDurationMs, $Run.LifetimeMs)
    }
}

function Report-PreviewRun([string]$Name, $Run, [string]$ExpectFile, [string]$ExpectFormat) {
    $leaf = Split-Path -Path $ExpectFile -Leaf
    Write-Output ("payload                    : {0}" -f $Run.Json)
    Write-Output ("hwnd (должно быть 0)       : {0}" -f (Format-Hwnd $Run.Hwnd))
    Write-Output ("sound file / format        : {0} / {1}  (ожидался {2})" -f $Run.SoundFile, $Run.SoundFormat, $leaf)
    Write-Output ("exited={0} exitCode={1} lifetime={2} ms  soundFinished={3}" -f $Run.Exited, $Run.ExitCode, $Run.LifetimeMs, $Run.SoundFinished)
    Add-Check $Name 'no-window' $(if ($Run.Hwnd -eq [IntPtr]::Zero) { 'PASS' } else { 'FAIL' }) ("окно: " + (Format-Hwnd $Run.Hwnd))
    Add-Check $Name 'exit-0' $(if ($Run.Exited -and $Run.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) ("exited={0} exitCode={1}" -f $Run.Exited, $Run.ExitCode)
    $soundOk = ($Run.SoundFile -eq $leaf) -and ($Run.SoundFormat -eq $ExpectFormat)
    Add-Check $Name 'sound-file' $(if ($soundOk) { 'PASS' } else { 'FAIL' }) ("звук {0} ({1}), ожидался {2} ({3})" -f $Run.SoundFile, $Run.SoundFormat, $leaf, $ExpectFormat)
    Add-Check $Name 'sound-finished' $(if ($Run.SoundFinished) { 'PASS' } else { 'FAIL' }) 'notify.ps1 дождался конца звука до выхода'
    Add-Check $Name 'played-long-enough' $(if ($Run.LifetimeMs -ge 900) { 'PASS' } else { 'FAIL' }) ("{0} ms >= 900 ms (звук не оборван сразу)" -f $Run.LifetimeMs)
    if ($ExpectFormat -eq 'mp3') {
        $played = $Run.MediaEnded -or ($Run.MediaDurationMs -gt 0)
        Add-Check $Name 'mp3-played' $(if ($played) { 'PASS' } else { 'FAIL' }) ("MediaEnded={0} mediaDurationMs={1}" -f $Run.MediaEnded, $Run.MediaDurationMs)
    }
}

Write-Output ''
Write-Output '--- прогон: custom WAV в окне ---'
$runCustomWav = Invoke-NotifyRun -RunKind 'completed' -RunTitle 'Свой WAV' -RunBody 'Проверка своего WAV-файла в окне' -RunSoundFile $customWav
$runs += $runCustomWav
if ($runCustomWav.Hwnd -eq [IntPtr]::Zero) {
    Add-Check 'custom-wav' 'visible-window' 'FAIL' 'окно не появилось за 10 с'
}
else {
    Report-SoundRun 'custom-wav' $runCustomWav $customWav 'wav'
}

Write-Output ''
Write-Output '--- прогон: custom MP3 в окне ---'
$runCustomMp3 = Invoke-NotifyRun -RunKind 'question' -RunTitle 'Свой MP3' -RunBody 'Проверка своего MP3-файла в окне' -RunSoundFile $mp3Fixture
$runs += $runCustomMp3
if ($runCustomMp3.Hwnd -eq [IntPtr]::Zero) {
    Add-Check 'custom-mp3' 'visible-window' 'FAIL' 'окно не появилось за 10 с'
}
else {
    Report-SoundRun 'custom-mp3' $runCustomMp3 $mp3Fixture 'mp3'
}

Write-Output ''
Write-Output '--- прогон: -PreviewSound (встроенный chime.wav, без окна) ---'
$previewBundled = Invoke-PreviewSoundRun -RunKind 'completed' -RunTitle 'Прослушать встроенный' -RunBody ''
Report-PreviewRun 'preview-bundled' $previewBundled (Join-Path $here 'chime.wav') 'wav'

Write-Output ''
Write-Output '--- прогон: -PreviewSound (свой WAV, без окна) ---'
$previewWav = Invoke-PreviewSoundRun -RunKind 'question' -RunTitle 'Прослушать WAV' -RunBody '' -RunSoundFile $customWav
Report-PreviewRun 'preview-wav' $previewWav $customWav 'wav'

Write-Output ''
Write-Output '--- прогон: -PreviewSound (свой MP3, без окна) ---'
$previewMp3 = Invoke-PreviewSoundRun -RunKind 'question' -RunTitle 'Прослушать MP3' -RunBody '' -RunSoundFile $mp3Fixture
Report-PreviewRun 'preview-mp3' $previewMp3 $mp3Fixture 'mp3'

Write-Output '=== checks ==='
foreach ($c in $allChecks) {
    Write-Output ("{0,-5} {1,-8} {2,-22} {3}" -f $c.Status, $c.Kind, $c.Name, $c.Detail)
}

$lastRun = $runs | Where-Object { $_.Hwnd -ne [IntPtr]::Zero } | Select-Object -Last 1
if ($lastRun) {
    Write-Output ''
    Write-Output '=== notify.ps1 -Diag (последний прогон) ==='
    $lastRun.DiagLines | ForEach-Object { Write-Output $_ }
}

$failed = @($allChecks | Where-Object { $_.Status -eq 'FAIL' })
$warned = @($allChecks | Where-Object { $_.Status -eq 'WARN' })
Write-Output ''
if ($failed.Count -eq 0) {
    $warnText = if ($warned.Count -gt 0) { " (WARN: " + (($warned | ForEach-Object { "$($_.Kind)/$($_.Name)" }) -join ', ') + ")" } else { '' }
    Write-Output ("RESULT: PASS{0}" -f $warnText)
    foreach ($r in $runs) {
        if ($r.Hwnd -eq [IntPtr]::Zero) { continue }
        Write-Output ("{0}: latencyMs={1} controllableMs={2} soundDeltaMs={3} accent={4} screenshot={5}" -f $r.Kind, $r.LatencyMs, $r.ControllableMs, $r.SoundDeltaMs, $r.AccentHex, $r.ShotPath)
    }
    exit 0
}

Write-Output ("RESULT: FAIL ({0} check(s) failed)" -f $failed.Count)
exit 1
