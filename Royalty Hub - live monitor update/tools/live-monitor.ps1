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
# =============================================================================

param(
  [string]$StationId = "LIC-RADIO",            # the licensed station this monitor listens to
  [int]$ClipSeconds = 15,                       # length of each recording
  [string]$ApiBase = "http://localhost:3001",   # where Royalty Hub is running
  [double]$SilenceLevel = 0.01                  # clips quieter than this are skipped (0 = never skip)
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
Write-Host "  Station : $StationId"
Write-Host "  Server  : $ApiBase"
Write-Host "  Clips   : $ClipSeconds seconds from the microphone"
Write-Host "  Stop    : press Ctrl+C"
Write-Host ""

try {
  while ($true) {
    # a) Record. The clip's START time is what the server stores as "played at".
    $clipStart = (Get-Date).ToUniversalTime().ToString("o")
    if (Test-Path -LiteralPath $clipPath) {
      Remove-Item -LiteralPath $clipPath -ErrorAction Stop
    }
    Record-Clip $clipPath $ClipSeconds
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
    } | ConvertTo-Json
    try {
      $result = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/open/v1/fingerprint-matches" `
        -Headers @{ "X-API-Key" = $apiKey } -ContentType "application/json" -Body $body
    } catch {
      Write-Host "[$time] could not reach Royalty Hub: $($_.Exception.Message) - will try again" -ForegroundColor Red
      continue
    }

    # e) Show the result.
    if (-not $result.merged) { $stats.plays++ }
    if ($result.matched) {
      $percent = [Math]::Round($result.confidence * 100, 1)
      if ($result.merged) {
        Write-Host "[$time] still playing: `"$($result.title)`" ($percent%) - play $($result.usage_id) now $($result.duration_sec) s" -ForegroundColor Green
      } else {
        $stats.matched++
        Write-Host "[$time] NEW PLAY: `"$($result.title)`" ($percent%) - saved as $($result.usage_id)" -ForegroundColor Green
      }
    } else {
      $note = if ($result.merged) { "still unidentified, play $($result.usage_id)" } else { "saved as unmatched play $($result.usage_id)" }
      Write-Host "[$time] no registered song recognised - $note" -ForegroundColor Yellow
    }
  }
} finally {
  # Runs when you press Ctrl+C: tidy up and print a summary.
  [void][RoyaltyHub.Mci]::mciSendString("close rhclip", $null, 0, [IntPtr]::Zero)
  Remove-Item $clipPath -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "Stopped. Clips: $($stats.clips), silent: $($stats.skipped), plays saved: $($stats.plays), songs recognised: $($stats.matched)" -ForegroundColor Cyan
}
