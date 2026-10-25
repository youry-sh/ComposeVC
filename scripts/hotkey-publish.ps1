<#
  hotkey-publish.ps1 — системный хоткей: собрать проект и опубликовать обновление.

  Ctrl+Shift+O (настраивается) в любой программе → git commit/push → bump версии →
  сборка установщика → GitHub Release в публичном фиде обновлений.

  Запуск:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hotkey-publish.ps1
    ... -InstallStartup     добавить в автозагрузку Windows
    ... -SelfTest           проверить регистрацию хоткея и выйти
    ... -Force              публиковать даже если в git нет изменений
    ... -Keys "Alt+Shift+O" другая комбинация

  Пока агент запущен, в трее виден значок ComposeVC Publish.
#>
param(
  [string]$Keys = "Ctrl+Shift+O",
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$InstallStartup,
  [switch]$SelfTest,
  [switch]$Force,
  [switch]$Simulate
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Core

$script:LogFile = Join-Path $env:TEMP "composevc-publish-hotkey.log"
$script:Proc = $null
$script:Busy = $false
$script:LastResult = $null

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  try { Add-Content -Path $script:LogFile -Value $line -Encoding UTF8 } catch { }
  Write-Host $line
}

function Show-Balloon([string]$Title, [string]$Text, [string]$Kind = "Info") {
  if (-not $script:Tray) { return }
  try {
    $icon = switch ($Kind) {
      "Error" { [System.Windows.Forms.ToolTipIcon]::Error }
      "Warning" { [System.Windows.Forms.ToolTipIcon]::Warning }
      default { [System.Windows.Forms.ToolTipIcon]::Info }
    }
    $script:Tray.ShowBalloonTip(5000, $Title, $Text, $icon)
  } catch { }
}

# ── translucent publish progress overlay (bottom-right of the screen) ──────
$script:OverlayForm = $null
$script:OverlayFill = $null
$script:OverlayStageLabel = $null
$script:OverlayPctLabel = $null
$script:OverlayTrack = $null
$script:OverlayPercent = 0
$script:OverlayHideAt = $null
$script:OverlayLogOffset = 0
$script:OverlayTail = ""
$script:OverlayUploadTick = 0

function Initialize-Overlay {
  if ($script:OverlayForm -and -not $script:OverlayForm.IsDisposed) { return }

  $form = New-Object ComposeVCOverlayWindow
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.Width = 330
  $form.Height = 80
  $form.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 18)
  $form.Opacity = 0

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 10
  $w = $form.Width
  $h = $form.Height
  $path.AddArc(0, 0, $r, $r, 180, 90)
  $path.AddArc($w - $r - 1, 0, $r, $r, 270, 90)
  $path.AddArc($w - $r - 1, $h - $r - 1, $r, $r, 0, 90)
  $path.AddArc(0, $h - $r - 1, $r, $r, 90, 90)
  $path.CloseFigure()
  $form.Region = New-Object System.Drawing.Region($path)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = "ПУБЛИКАЦИЯ ОБНОВЛЕНИЯ"
  $title.Font = New-Object System.Drawing.Font("Segoe UI", 7.5, [System.Drawing.FontStyle]::Bold)
  $title.ForeColor = [System.Drawing.Color]::FromArgb(140, 140, 140)
  $title.BackColor = $form.BackColor
  $title.SetBounds(16, 12, 220, 14)
  $form.Controls.Add($title)

  $stage = New-Object System.Windows.Forms.Label
  $stage.Text = "Подготовка…"
  $stage.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
  $stage.ForeColor = [System.Drawing.Color]::FromArgb(232, 232, 232)
  $stage.BackColor = $form.BackColor
  $stage.AutoEllipsis = $true
  $stage.SetBounds(16, 29, 232, 18)
  $form.Controls.Add($stage)

  $pct = New-Object System.Windows.Forms.Label
  $pct.Text = "0%"
  $pct.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
  $pct.ForeColor = [System.Drawing.Color]::FromArgb(157, 185, 203)
  $pct.BackColor = $form.BackColor
  $pct.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
  $pct.SetBounds(252, 28, 62, 18)
  $form.Controls.Add($pct)

  $track = New-Object System.Windows.Forms.Panel
  $track.SetBounds(16, 57, 298, 4)
  $track.BackColor = [System.Drawing.Color]::FromArgb(42, 42, 42)
  $form.Controls.Add($track)

  $fill = New-Object System.Windows.Forms.Panel
  $fill.SetBounds(0, 0, 0, 4)
  $fill.BackColor = [System.Drawing.Color]::FromArgb(157, 185, 203)
  $track.Controls.Add($fill)

  $form.add_Paint({
    param($sender, $e)
    try {
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(48, 255, 255, 255), 1)
      $e.Graphics.DrawRectangle($pen, 0, 0, $sender.Width - 1, $sender.Height - 1)
      $pen.Dispose()
    } catch { }
  })

  $script:OverlayForm = $form
  $script:OverlayStageLabel = $stage
  $script:OverlayPctLabel = $pct
  $script:OverlayTrack = $track
  $script:OverlayFill = $fill
}

function Move-OverlayToCorner {
  if (-not $script:OverlayForm) { return }
  try {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $script:OverlayForm.Left = $wa.Right - $script:OverlayForm.Width - 24
    $script:OverlayForm.Top = $wa.Bottom - $script:OverlayForm.Height - 24
  } catch { }
}

function Show-PublishOverlay([string]$StageText = "Подготовка…") {
  Initialize-Overlay
  Move-OverlayToCorner
  $script:OverlayPercent = 0
  $script:OverlayHideAt = $null
  $script:OverlayUploadTick = 0
  $script:OverlayTail = ""
  $script:OverlayStageLabel.Text = $StageText
  $script:OverlayPctLabel.Text = "0%"
  $script:OverlayFill.Width = 0
  $script:OverlayFill.BackColor = [System.Drawing.Color]::FromArgb(157, 185, 203)
  $script:OverlayPctLabel.ForeColor = [System.Drawing.Color]::FromArgb(157, 185, 203)
  if (-not $script:OverlayForm.Visible) { $script:OverlayForm.Show() }
  $script:OverlayForm.TopMost = $true
}

function Set-PublishProgress([double]$Percent, [string]$StageText) {
  if (-not $script:OverlayForm) { return }
  $next = [Math]::Max($script:OverlayPercent, [Math]::Min(100, $Percent))
  $script:OverlayPercent = $next
  $maxWidth = [Math]::Max(0, $script:OverlayTrack.Width)
  $script:OverlayFill.Width = [int]($maxWidth * $next / 100)
  if ($StageText) { $script:OverlayStageLabel.Text = $StageText }
  $script:OverlayPctLabel.Text = ("{0}%" -f [int][Math]::Round($next))
}

function Complete-PublishOverlay([bool]$Ok, [string]$StageText) {
  if (-not $script:OverlayForm) { return }
  if ($Ok) {
    Set-PublishProgress 100 $StageText
  } else {
    $script:OverlayStageLabel.Text = $StageText
    $script:OverlayFill.BackColor = [System.Drawing.Color]::FromArgb(229, 83, 75)
    $script:OverlayPctLabel.ForeColor = [System.Drawing.Color]::FromArgb(229, 83, 75)
    $script:OverlayFill.Width = [Math]::Max(6, $script:OverlayTrack.Width)
  }
  $script:OverlayHideAt = (Get-Date).AddSeconds($(if ($Ok) { 2.2 } else { 4.0 }))
}

function Update-OverlayFrame {
  if (-not $script:OverlayForm -or $script:OverlayForm.IsDisposed) { return }
  $form = $script:OverlayForm
  $target = 0.94
  if ($script:OverlayHideAt -and (Get-Date) -ge $script:OverlayHideAt) { $target = 0.0 }
  $delta = $target - $form.Opacity
  if ([Math]::Abs($delta) -lt 0.02) {
    $form.Opacity = $target
    if ($target -eq 0 -and $script:OverlayHideAt) {
      $form.Hide()
      $script:OverlayHideAt = $null
    }
    return
  }
  $step = if ($delta -gt 0) { [Math]::Min(0.09, $delta) } else { [Math]::Max(-0.14, $delta) }
  $form.Opacity = [Math]::Max(0.0, [Math]::Min(1.0, $form.Opacity + $step))
}

# Reads only the bytes appended since the publish started, so milestones from
# older runs can never push the bar to 100%.
function Read-NewPublishLog {
  try {
    if (-not (Test-Path $script:LogFile)) { return "" }
    $fs = [System.IO.File]::Open($script:LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $len = $fs.Length
      if ($script:OverlayLogOffset -gt $len) { $script:OverlayLogOffset = 0 }
      $fs.Position = $script:OverlayLogOffset
      $count = [int]($len - $script:OverlayLogOffset)
      if ($count -le 0) { return "" }
      if ($count -gt 262144) { $count = 262144 }
      $buffer = New-Object byte[] $count
      $read = $fs.Read($buffer, 0, $count)
      $script:OverlayLogOffset += $read
      return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    } finally {
      $fs.Close()
    }
  } catch {
    return ""
  }
}

function Update-PublishProgress {
  if (-not $script:OverlayForm) { return }
  $chunk = Read-NewPublishLog
  if ($chunk) {
    $script:OverlayTail += $chunk
    if ($script:OverlayTail.Length -gt 12000) {
      $script:OverlayTail = $script:OverlayTail.Substring($script:OverlayTail.Length - 12000)
    }
  }
  $text = $script:OverlayTail
  if (-not $text) { return }

  $pct = 0
  $stage = ""

  if ($text -match "\[package-dist\] building anti") { $pct = 4; $stage = "Сборка anti.exe" }
  if ($text -match "\[package-dist\] staging anti") { $pct = 9; $stage = "Подготовка ресурсов" }
  if ($text -match "\[package-dist\] building renderer") { $pct = 15; $stage = "Сборка интерфейса" }

  $m = [regex]::Match($text, "\[harden\][^\r\n]*?(\d+)/(\d+)")
  if ($m.Success) {
    $done = [int]$m.Groups[1].Value
    $total = [int]$m.Groups[2].Value
    if ($total -gt 0) {
      $pct = 18 + [int](24 * $done / $total)
      $stage = "Обфускация кода ($done/$total)"
    }
  }

  if ($text -match "electron-builder NSIS Setup EXE") { $pct = 46; $stage = "Упаковка приложения" }
  if ($text -match "packaging\s+platform=") { $pct = 52; $stage = "Упаковка приложения" }
  if ($text -match "building\s+target=nsis") { $pct = 62; $stage = "Сборка установщика" }
  if ($text -match "\[package-dist\] done\.") { $pct = 76; $stage = "Проверка артефактов" }
  if ($text -match "\[publish\] installer ready") { $pct = 82; $stage = "Установщик готов" }
  if ($text -match "creating GitHub release") { $pct = 86; $stage = "Загрузка на GitHub" }
  if ($text -match "\[publish\] Done\.") { $pct = 100; $stage = "Готово" }

  # gh prints no upload progress — creep slowly while the 224 MB asset uploads.
  if ($pct -ge 86 -and $pct -lt 100) {
    $script:OverlayUploadTick++
    $pct = [Math]::Min(96, 86 + [int]($script:OverlayUploadTick / 2))
    $stage = "Загрузка на GitHub"
  }

  if ($pct -gt 0) { Set-PublishProgress $pct $stage }
}

if ($Simulate) {
  Show-PublishOverlay "Проверка интерфейса"
  $stages = @("Сборка anti.exe", "Сборка интерфейса", "Обфускация кода", "Сборка установщика", "Загрузка на GitHub", "Готово")
  for ($i = 0; $i -le 100; $i += 2) {
    $idx = [Math]::Min($stages.Count - 1, [int]($i / (100 / $stages.Count)))
    Set-PublishProgress $i $stages[$idx]
    Update-OverlayFrame
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 45
  }
  Complete-PublishOverlay $true "Опубликовано"
  for ($t = 0; $t -lt 100; $t++) {
    Update-OverlayFrame
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 45
    if (-not $script:OverlayForm.Visible -and -not $script:OverlayHideAt) { break }
  }
  Write-Host "[overlay] simulate OK"
  exit 0
}

function Resolve-Hotkey([string]$Spec) {
  $mods = 0; $vk = 0
  foreach ($raw in ($Spec -split "\+")) {
    $part = $raw.Trim()
    switch -Regex ($part) {
      "^(ctrl|control)$" { $mods = $mods -bor 0x0002; continue }
      "^(shift)$" { $mods = $mods -bor 0x0004; continue }
      "^(alt)$" { $mods = $mods -bor 0x0001; continue }
      "^(win|windows|super)$" { $mods = $mods -bor 0x0008; continue }
      "^(?i)f([1-9]|1[0-2])$" { $vk = 0x70 + ([int]$Matches[1] - 1); continue }
      "^[0-9]$" { $vk = 0x30 + [int]$part; continue }
      "^[A-Za-z]$" { $vk = [int][char]$part.ToUpperInvariant(); continue }
      default { throw "неизвестная клавиша в хоткее: $part" }
    }
  }
  if ($vk -eq 0) { throw "хоткей должен содержать клавишу, например Ctrl+Shift+O" }
  return [pscustomobject]@{ Modifiers = $mods; VirtualKey = $vk }
}

$source = @"
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class ComposeVCHotkeyWindow : Form
{
    public const int WM_HOTKEY = 0x0312;
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public event Action<int> HotkeyPressed;

    public ComposeVCHotkeyWindow()
    {
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Location = new System.Drawing.Point(-4000, -4000);
        Size = new System.Drawing.Size(1, 1);
        ShowIcon = false;
    }

    public bool Register(int id, uint modifiers, uint key)
    {
        return RegisterHotKey(Handle, id, modifiers, key);
    }

    public void Unregister(int id)
    {
        try { UnregisterHotKey(Handle, id); } catch { }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY)
        {
            var handler = HotkeyPressed;
            if (handler != null) handler(m.WParam.ToInt32());
        }
        base.WndProc(ref m);
    }
}

// Borderless always-on-top overlay that never steals keyboard focus from the
// app the user is working in (WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW).
public class ComposeVCOverlayWindow : Form
{
    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            return cp;
        }
    }
}
"@

if (-not ("ComposeVCHotkeyWindow" -as [type])) {
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $source -Language CSharp
}

$hotkey = Resolve-Hotkey $Keys
$hotkeyId = 0x4C31

$form = New-Object ComposeVCHotkeyWindow
$null = $form.Handle
$registered = $form.Register($hotkeyId, [uint32]$hotkey.Modifiers, [uint32]$hotkey.VirtualKey)

if ($SelfTest) {
  if ($registered) {
    $form.Unregister($hotkeyId)
    Write-Host "[hotkey] OK — комбинация $Keys зарегистрирована и освобождена"
    exit 0
  }
  Write-Host "[hotkey] FAIL — комбинация $Keys уже занята другой программой"
  exit 1
}

if (-not $registered) {
  Write-Error "[hotkey] не удалось зарегистрировать $Keys (занято другой программой). Укажите -Keys `"Ctrl+Shift+Alt+O`"."
  exit 1
}

if ($InstallStartup) {
  $startup = [Environment]::GetFolderPath("Startup")
  $ws = New-Object -ComObject WScript.Shell
  $lnkPath = Join-Path $startup "ComposeVC Publish Hotkey.lnk"
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = "powershell.exe"
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $lnk.WorkingDirectory = $ProjectRoot
  $lnk.WindowStyle = 7
  $lnk.Description = "ComposeVC: $Keys — собрать и опубликовать обновление"
  $lnk.Save()
  Write-Host "[hotkey] автозагрузка включена: $lnkPath"
  Write-Host "[hotkey] агент запустится при следующем входе в Windows."
  Write-Host "[hotkey] запустить сейчас: scripts\hotkey-publish.cmd"
  $form.Unregister($hotkeyId)
  exit 0
}

function Test-DirtyTree {
  try {
    $out = & git -C $ProjectRoot status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { return $true }
    $lines = @($out | Where-Object { $_ -and $_.Trim() })
    return ($lines.Count -gt 0)
  } catch {
    return $true
  }
}

# Content fingerprint of the committed project. The IDE auto-commits edits every
# few seconds, so "git status is clean" does NOT mean "nothing changed" — we
# compare the current tree with the tree of the last published release instead.
function Get-TreeHash {
  try {
    $out = & git -C $ProjectRoot rev-parse "HEAD^{tree}" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return "" }
    return ([string]($out | Select-Object -First 1)).Trim()
  } catch {
    return ""
  }
}

function Get-PublishStatePath {
  $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:TEMP }
  $dir = Join-Path $base "ComposeVC"
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  return (Join-Path $dir "publish-state.json")
}

function Read-PublishState {
  try {
    $path = Get-PublishStatePath
    if (-not (Test-Path $path)) { return $null }
    return (Get-Content $path -Raw -ErrorAction Stop | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Save-PublishState([string]$Tree) {
  try {
    $version = ""
    $pkg = Join-Path $ProjectRoot "package.json"
    if (Test-Path $pkg) {
      $version = (Get-Content $pkg -Raw | ConvertFrom-Json).version
    }
    $payload = [pscustomobject]@{
      tree        = $Tree
      version     = $version
      publishedAt = (Get-Date).ToString("o")
    }
    $json = $payload | ConvertTo-Json
    [System.IO.File]::WriteAllText((Get-PublishStatePath), $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Start-Publish {
  if ($script:Busy) {
    Show-Balloon "ComposeVC" "Сборка уже идёт — дождитесь завершения." "Warning"
    return
  }
  if (-not $Force) {
    $treeNow = Get-TreeHash
    $state = Read-PublishState
    $dirty = Test-DirtyTree
    if (-not $dirty -and $treeNow -and $state -and $state.tree -and $state.tree -eq $treeNow) {
      $verLabel = if ($state.version) { " (v$($state.version))" } else { "" }
      Show-Balloon "ComposeVC" "Изменений с последнего релиза$verLabel нет — публиковать нечего." "Info"
      return
    }
  }

  $script:Busy = $true
  $script:Tray.Text = "ComposeVC Publish — идёт сборка…"
  Show-Balloon "ComposeVC" "Сборка и публикация обновления запущены. Готово будет через несколько минут." "Info"
  Write-Log "publish started ($Keys)"
  try { Add-Content -Path $script:LogFile -Value "===== $(Get-Date -Format o) =====" -Encoding UTF8 } catch { }

  # Bottom-right progress overlay (bottom-right of the screen, translucent).
  Show-PublishOverlay "Запуск сборки…"
  $script:OverlayLogOffset = 0
  try { $script:OverlayLogOffset = (Get-Item $script:LogFile).Length } catch { }

  $cmdLine = "/c node scripts\publish-update.mjs --bump patch >> `"$($script:LogFile)`" 2>&1"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = $cmdLine
  $psi.WorkingDirectory = $ProjectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = "Hidden"

  try {
    $script:Proc = [System.Diagnostics.Process]::Start($psi)
  } catch {
    $script:Busy = $false
    $script:Tray.Text = "ComposeVC Publish ($Keys)"
    Write-Log "start failed: $($_.Exception.Message)"
    Show-Balloon "ComposeVC" "Не удалось запустить сборку: $($_.Exception.Message)" "Error"
  }
}

$form.add_HotkeyPressed({ Start-Publish })

# Tray icon: статус + выход
$script:Tray = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $ProjectRoot "build-assets\app-icon.ico"
if (Test-Path $iconPath) {
  $script:Tray.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
  $script:Tray.Icon = [System.Drawing.SystemIcons]::Application
}
$script:Tray.Text = "ComposeVC Publish ($Keys)"
$script:Tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemPublish = $menu.Items.Add("Собрать и опубликовать")
$itemPublish.add_Click({ $script:Force = $false; Start-Publish })
$itemForce = $menu.Items.Add("Опубликовать принудительно")
$itemForce.add_Click({ $script:Force = $true; Start-Publish })
$null = $menu.Items.Add("-")
$itemLog = $menu.Items.Add("Открыть лог")
$itemLog.add_Click({ try { Start-Process notepad.exe -ArgumentList $script:LogFile } catch { } })
$null = $menu.Items.Add("-")
$itemExit = $menu.Items.Add("Выход")
$itemExit.add_Click({ $script:Quit = $true; [System.Windows.Forms.Application]::ExitThread() })
$script:Tray.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.add_Tick({
  if ($script:Proc -and $script:Proc.HasExited) {
    $code = $script:Proc.ExitCode
    $script:Proc = $null
    $script:Busy = $false
    $script:Tray.Text = "ComposeVC Publish ($Keys)"
    if ($code -eq 0) {
      $treeAfter = Get-TreeHash
      if ($treeAfter) { Save-PublishState -Tree $treeAfter }
      Write-Log "publish finished OK"
      Show-Balloon "ComposeVC" "Обновление опубликовано — пользователи получат его автоматически." "Info"
    } else {
      Write-Log "publish failed with exit $code"
      Show-Balloon "ComposeVC" "Публикация не удалась (код $code). Подробности в логе." "Error"
    }
  }
})
$timer.Start()

Write-Log "hotkey agent ready: $Keys → $ProjectRoot (log: $($script:LogFile))"

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $form.Unregister($hotkeyId)
  $form.Dispose()
  if ($script:Tray) {
    $script:Tray.Visible = $false
    $script:Tray.Dispose()
  }
  Write-Log "hotkey agent stopped"
}
