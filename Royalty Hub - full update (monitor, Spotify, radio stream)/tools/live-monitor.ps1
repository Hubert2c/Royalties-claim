# =============================================================================
# tools/live-monitor.ps1 - an automatic radio monitor for Windows
# -----------------------------------------------------------------------------
# What it does, forever, until you press Ctrl+C:
#   1. records a few seconds from the microphone (built into Windows, no extra software)
#   2. skips the clip if the room is silent
#   3. turns the clip into an audio fingerprint with Chromaprint's fpcalc
#   4. sends ONLY the fingerprint (never the audio) to Royalty Hub's Open API
#   5. prints whether a registered song was recognised
#
# Back-to-back clips of the same song are merged by the server into ONE play,
# so a 3-minute song counts once, not twelve times.
#
# Requirements:
#   * Royalty Hub running (npm start)
#   * fpcalc.exe in the project folder (or anywhere on your PATH)
#   * a monitor API key (Government console -> Settings & API keys -> Monitor key)
#   * Windows microphone access for desktop apps switched on
#     (Settings -> Privacy & security -> Microphone)
#
# Usage (from the project folder):
#   $env:ROYALTY_HUB_API_KEY = "rh_live_..."
#   powershell -ExecutionPolicy Bypass -File tools\live-monitor.ps1
#   powershell -ExecutionPolicy Bypass -File tools\live-monitor.ps1 -StationId LIC-RADIO -ClipSeconds 15
#
# Monitoring an internet radio stream instead of the microphone (needs FFmpeg):
#   powershell -ExecutionPolicy Bypass -File tools\live-monitor.ps1 -StreamUrl "http://.../stream" -MatchedOnly
#   -StreamUrl    record each clip from the station's internet stream
#   -MatchedOnly  only save clips that match a registered song (a stream is mostly
#                 other music, adverts and talk; without this every clip is saved)
#   The station's own "now playing" title (if the stream sends one) is shown next
#   to each result, so you can compare what the station SAYS with what was HEARD.
# =============================================================================

param(
  [string]$StationId = "LIC-RADIO",            # the licensed station this monitor listens to
  [int]$ClipSeconds = 15,                       # length of each recording
  [string]$ApiBase = "http://localhost:3001",   # where Royalty Hub is running
  [double]$SilenceLevel = 0.01,                 # clips quieter than this are skipped (0 = never skip)
  [string]$StreamUrl = "",                      # internet radio stream to monitor instead of the microphone
  [switch]$MatchedOnly                          # only save clips that match a registered song
)

$ErrorActionPreference = "Stop"

# --- 1. Check the API key ----------------------------------------------------
# Use the key from this window, or the one saved permanently for this Windows user.
$apiKey = $env:ROYALTY_HUB_API_KEY
if (-not $apiKey) { $apiKey = [Environment]::GetEnvironmentVariable("ROYALTY_HUB_API_KEY", "User") }
if (-not $apiKey) {
  Write-Host "Set the API key first:  `$env:ROYALTY_HUB_API_KEY = `"rh_live_...`"" -ForegroundColor Red
  exit 1
}

# --- 2. Find fpcalc.exe ------------------------------------------------------
# First look in the project folder (one level above this script), then on the PATH.
$projectFolder = Split-Path $PSScriptRoot -Parent
$fpcalc = Join-Path $projectFolder "fpcalc.exe"
if (-not (Test-Path $fpcalc)) {
  $onPath = Get-Command fpcalc -ErrorAction SilentlyContinue
  if (-not $onPath) {
    Write-Host "fpcalc.exe not found. Put it in $projectFolder" -ForegroundColor Red
    exit 1
  }
  $fpcalc = $onPath.Source
}

# --- 2b. Find ffmpeg.exe (only needed for -StreamUrl) -------------------------
$ffmpeg = $null
if ($StreamUrl) {
  $ffmpeg = Join-Path $projectFolder "ffmpeg.exe"
  if (-not (Test-Path $ffmpeg)) {
    $onPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $onPath) {
      Write-Host "ffmpeg not found. Install it with:  winget install Gyan.FFmpeg  (then open a new PowerShell window)" -ForegroundColor Red
      exit 1
    }
    $ffmpeg = $onPath.Source
  }
}

# --- 3. Microphone recording through Windows' built-in MCI sound recorder ------
# winmm.dll is part of every Windows installation, so nothing has to be installed.
Add-Type -Namespace RoyaltyHub -Name Mci -MemberDefinition @'
[DllImport("winmm.dll", CharSet = CharSet.Unicode)]
public static extern int mciSendString(string command, System.Text.StringBuilder result, int resultLength, System.IntPtr callback);
[DllImport("winmm.dll", CharSet = CharSet.Unicode)]
public static extern bool mciGetErrorString(int errorCode, System.Text.StringBuilder text, int textLength);
'@

# Send one command to the recorder; stop with a clear message if Windows refuses it.
function Send-Mci([string]$command) {
  $code = [RoyaltyHub.Mci]::mciSendString($command, $null, 0, [IntPtr]::Zero)
  if ($code -ne 0) {
    $text = New-Object System.Text.StringBuilder 256
    [void][RoyaltyHub.Mci]::mciGetErrorString($code, $text, 256)
    throw "Microphone error ($command): $($text.ToString())"
  }
}

# Record $seconds of audio from the default microphone into a WAV file.
function Record-Clip([string]$path, [int]$seconds) {
  Send-Mci "open new type waveaudio alias rhclip"
  try {
    # 16-bit, 22,050 Hz, mono: plenty for fingerprinting and keeps files small.
    Send-Mci "set rhclip bitspersample 16 samplespersec 22050 channels 1 bytespersec 44100 alignment 2"
    Send-Mci "record rhclip"
    Start-Sleep -Seconds $seconds
    Send-Mci "stop rhclip"
    Send-Mci "save rhclip `"$path`""
  } finally {
    [void][RoyaltyHub.Mci]::mciSendString("close rhclip", $null, 0, [IntPtr]::Zero)
  }
}

# Record $seconds of an internet radio stream into a WAV file with FFmpeg.
function Record-StreamClip([string]$path, [int]$seconds) {
  # -t = how long to record; mono 22,050 Hz like the microphone clips.
  & $ffmpeg -nostdin -loglevel error -y -t $seconds -i $StreamUrl -ac 1 -ar 22050 -c:a pcm_s16le $path 2>$null
  if (-not (Test-Path $path)) { throw "Could not record from the stream (is the address correct and online?)" }
}

# Ask the stream for the station's own "now playing" text (ICY metadata).
# Internet radio servers send it every "icy-metaint" bytes when asked with the
# header Icy-MetaData: 1. Returns "Artist - Title", or $null if not available.
function Get-StreamTitle([string]$url) {
  try {
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Headers.Add("Icy-MetaData", "1")
    $request.Timeout = 8000
    $response = $request.GetResponse()
    $metaInt = [int]$response.Headers["icy-metaint"]
    if (-not $metaInt) { $response.Close(); return $null }
    $stream = $response.GetResponseStream()
    $buffer = New-Object byte[] 8192
    $left = $metaInt
    while ($left -gt 0) {                      # skip the audio bytes before the metadata block
      $n = $stream.Read($buffer, 0, [Math]::Min($buffer.Length, $left))
      if ($n -le 0) { break }
      $left -= $n
    }
    $length = $stream.ReadByte() * 16          # metadata length is sent in units of 16 bytes
    if ($length -le 0) { $response.Close(); return $null }
    $meta = New-Object byte[] $length
    $read = 0
    while ($read -lt $length) {
      $n = $stream.Read($meta, $read, $length - $read)
      if ($n -le 0) { break }
      $read += $n
    }
    $response.Close()
    $text = [System.Text.Encoding]::UTF8.GetString($meta, 0, $read)
    if ($text -match "StreamTitle='(.*?)';") { return $Matches[1] }
  } catch { }
  return $null
}

# How loud is the clip? Returns the average loudness (RMS) between 0 (silent) and 1 (maximum).
function Get-Loudness([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $sum = 0.0; $count = 0
  # Skip the 44-byte WAV header; check every 20th 16-bit sample (fast, and accurate enough).
  for ($i = 44; $i -lt $bytes.Length - 1; $i += 40) {
    $sample = [BitConverter]::ToInt16($bytes, $i) / 32768.0
    $sum += $sample * $sample; $count++
  }
  if ($count -eq 0) { return 0 }
  return [Math]::Sqrt($sum / $count)
}

# --- 4. The monitoring loop ----------------------------------------------------
$clipPath = Join-Path $env:TEMP "royalty-hub-clip.wav"
$stats = @{ clips = 0; plays = 0; matched = 0; skipped = 0 }

Write-Host ""
Write-Host "Royalty Hub live monitor" -ForegroundColor Cyan
Write-Host "  Station : $StationId (used with a government monitor key; a stations own key always reports for that station)"
Write-Host "  Server  : $ApiBase"
if ($StreamUrl) { Write-Host "  Source  : $StreamUrl" } else { Write-Host "  Source  : microphone" }
Write-Host "  Clips   : $ClipSeconds seconds$(if ($MatchedOnly) { ', only matched songs are saved' })"
Write-Host "  Stop    : press Ctrl+C"
Write-Host ""

try {
  while ($true) {
    # a) Record. The clip's START time is what the server stores as "played at".
    $clipStart = (Get-Date).ToUniversalTime().ToString("o")
    try {
      if ($StreamUrl) { Record-StreamClip $clipPath $ClipSeconds } else { Record-Clip $clipPath $ClipSeconds }
    } catch {
      Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $($_.Exception.Message) - will try again" -ForegroundColor Red
      Start-Sleep -Seconds 5
      continue
    }
    $stationSays = if ($StreamUrl) { Get-StreamTitle $StreamUrl } else { $null }
    $says = if ($stationSays) { "  | station says: $stationSays" } else { "" }
    $stats.clips++
    $time = Get-Date -Format "HH:mm:ss"

    # b) Skip silence, so an empty room does not create plays.
    $level = Get-Loudness $clipPath
    if ($level -lt $SilenceLevel) {
      $stats.skipped++
      Write-Host "[$time] silence (level $([Math]::Round($level, 3))) - nothing sent" -ForegroundColor DarkGray
      continue
    }

    # c) Fingerprint the clip with fpcalc.
    $output = & $fpcalc -raw $clipPath 2>$null
    $fingerprintLine = $output | Where-Object { $_ -like "FINGERPRINT=*" } | Select-Object -First 1
    if (-not $fingerprintLine) {
      Write-Host "[$time] fpcalc could not fingerprint this clip - skipped" -ForegroundColor Yellow
      continue
    }

    # d) Send only the fingerprint (a list of numbers) to the Open API.
    $body = @{
      station_id   = $StationId
      played_at    = $clipStart
      duration_sec = $ClipSeconds
      fingerprint  = $fingerprintLine.Substring("FINGERPRINT=".Length)
      record_unmatched = -not $MatchedOnly
    } | ConvertTo-Json
    try {
      $result = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/open/v1/fingerprint-matches" `
        -Headers @{ "X-API-Key" = $apiKey } -ContentType "application/json" -Body $body
    } catch {
      Write-Host "[$time] could not reach Royalty Hub: $($_.Exception.Message) - will try again" -ForegroundColor Red
      continue
    }

    # e) Show the result.
    if ($result.saved -eq $false) {
      Write-Host "[$time] no registered song recognised - not saved$says" -ForegroundColor DarkYellow
      continue
    }
    if (-not $result.merged) { $stats.plays++ }
    if ($result.matched) {
      $percent = [Math]::Round($result.confidence * 100, 1)
      if ($result.merged) {
        Write-Host "[$time] still playing: `"$($result.title)`" ($percent%) - play $($result.usage_id) now $($result.duration_sec) s$says" -ForegroundColor Green
      } else {
        $stats.matched++
        Write-Host "[$time] NEW PLAY: `"$($result.title)`" ($percent%) - saved as $($result.usage_id)$says" -ForegroundColor Green
      }
    } else {
      Write-Host "[$time] no registered song recognised - saved as unmatched play $($result.usage_id)$says" -ForegroundColor Yellow
    }
  }
} finally {
  # Runs when you press Ctrl+C: tidy up and print a summary.
  [void][RoyaltyHub.Mci]::mciSendString("close rhclip", $null, 0, [IntPtr]::Zero)
  Remove-Item $clipPath -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "Stopped. Clips: $($stats.clips), silent: $($stats.skipped), plays saved: $($stats.plays), songs recognised: $($stats.matched)" -ForegroundColor Cyan
}
