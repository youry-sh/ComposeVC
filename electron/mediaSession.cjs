const { spawn } = require("child_process");

let running = null;

const script = String.raw`
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  function Await-WinRt($operation) {
    if (-not $operation) { throw "WinRT operation unavailable" }
    $interface = $operation.GetType().GetInterfaces() | Where-Object { $_.FullName -like "Windows.Foundation.IAsyncOperation*" } | Select-Object -First 1
    if (-not $interface) { throw "WinRT operation type unavailable" }
    $resultType = $interface.GetGenericArguments()[0]
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
    if (-not $method) { throw "WinRT AsTask unavailable" }
    $task = $method.MakeGenericMethod($resultType).Invoke($null, [object[]]@($operation))
    return $task.GetAwaiter().GetResult()
  }
  $type = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $managerOperation = $type::RequestAsync()
  if (-not $managerOperation) { @{ active = $false; error = "Media manager unavailable" } | ConvertTo-Json -Compress; exit 0 }
  $manager = Await-WinRt $managerOperation
  if (-not $manager) { @{ active = $false; error = "Media manager returned no data" } | ConvertTo-Json -Compress; exit 0 }
  $session = $manager.GetCurrentSession()
  if (-not $session) { @{ active = $false } | ConvertTo-Json -Compress; exit 0 }
  $properties = Await-WinRt ($session.TryGetMediaPropertiesAsync())
  if (-not $properties) { @{ active = $false; error = "Media properties unavailable" } | ConvertTo-Json -Compress; exit 0 }
  $playbackInfo = $session.GetPlaybackInfo()
  if (-not $playbackInfo) { @{ active = $false; error = "Playback info unavailable" } | ConvertTo-Json -Compress; exit 0 }
  $playback = $playbackInfo.PlaybackStatus.ToString()
  $thumbnail = $null
  if ($properties.Thumbnail) {
    try {
      $stream = Await-WinRt ($properties.Thumbnail.OpenReadAsync())
      $reader = [Windows.Storage.Streams.DataReader]::new($stream)
      Await-WinRt ($reader.LoadAsync([uint32]$stream.Size)) | Out-Null
      $bytes = [byte[]]::new([int]$stream.Size)
      $reader.ReadBytes($bytes)
      $thumbnail = [Convert]::ToBase64String($bytes)
      $reader.Dispose()
      $stream.Dispose()
    } catch {}
  }
  @{ active = ($playback -eq "Playing"); title = [string]$properties.Title; artist = [string]$properties.Artist; album = [string]$properties.AlbumTitle; source = [string]$session.SourceAppUserModelId; thumbnail = $thumbnail; playback = $playback } | ConvertTo-Json -Compress
} catch {
  @{ active = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

function readMediaSession() {
  if (running) return running;
  running = new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    child.on("close", () => {
      try {
        const parsed = JSON.parse(output.trim() || "{}");
        if (!parsed.active && errorOutput.trim()) parsed.error = errorOutput.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
        resolve(parsed);
      } catch { resolve({ active: false, error: errorOutput.trim() || "Media session response was invalid" }); }
      running = null;
    });
    child.on("error", () => { resolve({ active: false }); running = null; });
  });
  return running;
}

module.exports = { readMediaSession };
