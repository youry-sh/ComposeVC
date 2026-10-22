# Супервизор для Windows: держит сервер (и именованный туннель, если настроен) поднятыми.
# Запуск: правый клик -> "Запуск с помощью PowerShell" или:  powershell -ExecutionPolicy Bypass -File watch.ps1
# Автозапуск: см. README раздел "Автозапуск (Windows)".

$ErrorActionPreference = "SilentlyContinue"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir
$Log = Join-Path $ProjectDir "watchdog.log"
function Log($msg) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" | Out-File -Append -FilePath $Log -Encoding utf8
}

# --- .env ---
$PublicUrl = $env:PUBLIC_URL
$TunnelName = if ($env:TUNNEL_NAME) { $env:TUNNEL_NAME } else { "mcp-pc" }
$WatchNamed = $env:CF_NAMED
if (Test-Path ".env") {
  Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim()
    if (($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2) -or
        ($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2)) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    if ($k -ne "" -and -not (Test-Path "env:$k")) { Set-Item "env:$k" $v }
  }
  if (-not $PublicUrl) { $PublicUrl = $env:PUBLIC_URL }
  if ($env:TUNNEL_NAME) { $TunnelName = $env:TUNNEL_NAME }
  if ($env:CF_NAMED) { $WatchNamed = $env:CF_NAMED }
}

function Test-Health($url) {
  try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Ensure-Server {
  if (Test-Health "http://127.0.0.1:8000/health") { return }
  Log "server DOWN -> restart"
  # Гасим только процессы ЭТОГО проекта (путь папки, а не имя папки).
  $ServerPattern = "*$ProjectDir*server.py*"
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like $ServerPattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep 2
  if (-not (Test-Path ".venv")) {
    try { & py -3 -m venv .venv } catch { & python -m venv .venv }
  }
  & .\.venv\Scripts\pip install -q -r requirements.txt 2>&1 | Out-File -Append -FilePath $Log -Encoding utf8
  $py = Join-Path $ProjectDir ".venv\Scripts\python.exe"
  # stdout и stderr — в РАЗНЫЕ файлы: Start-Process не умеет писать оба в один.
  Start-Process -FilePath $py -ArgumentList "server.py" -WorkingDirectory $ProjectDir `
    -RedirectStandardOutput "server.log" -RedirectStandardError "server.err.log" -WindowStyle Hidden
  Start-Sleep 5
  if (Test-Health "http://127.0.0.1:8000/health") { Log "server UP" }
  else { Log "server FAILED to start, see server.log" }
}

function Ensure-Tunnel {
  # Следим только за именованным (постоянным) туннелем.
  if (-not $WatchNamed) { return }
  if (-not $PublicUrl) { Log "CF_NAMED set but PUBLIC_URL empty in .env — tunnel check skipped"; return }
  if (Test-Health "$PublicUrl/health") { return }
  Log "tunnel DOWN (or 5xx) -> restart"
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 3
  Start-Process -FilePath "cloudflared" -ArgumentList "tunnel", "run", $TunnelName `
    -WorkingDirectory $ProjectDir -WindowStyle Hidden
  Start-Sleep 12
  if (Test-Health "$PublicUrl/health") { Log "tunnel check -> $PublicUrl = 200" }
  else { Log "tunnel check -> $PublicUrl FAILED, see cloudflared logs" }
}

Log "watchdog started"
while ($true) {
  Ensure-Server
  Ensure-Tunnel
  Start-Sleep 60
}
