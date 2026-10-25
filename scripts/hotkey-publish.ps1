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
  [switch]$Force
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

function Start-Publish {
  if ($script:Busy) {
    Show-Balloon "ComposeVC" "Сборка уже идёт — дождитесь завершения." "Warning"
    return
  }
  if (-not $Force -and -not (Test-DirtyTree)) {
    Show-Balloon "ComposeVC" "В проекте нет изменений — публиковать нечего." "Info"
    return
  }

  $script:Busy = $true
  $script:Tray.Text = "ComposeVC Publish — идёт сборка…"
  Show-Balloon "ComposeVC" "Сборка и публикация обновления запущены. Готово будет через несколько минут." "Info"
  Write-Log "publish started ($Keys)"
  try { Add-Content -Path $script:LogFile -Value "===== $(Get-Date -Format o) =====" -Encoding UTF8 } catch { }

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
