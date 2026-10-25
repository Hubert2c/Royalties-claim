// =============================================================================
// tools/monitor-report.js — send a real audio fingerprint to the Open API
// -----------------------------------------------------------------------------
// This is what a radio-monitoring service would run every few seconds on a
// recorded clip of a station's broadcast.
//
// Requirements:
//   * Chromaprint's command-line tool "fpcalc" (https://acoustid.org/chromaprint)
//   * an API key (create a monitor key in the Government console, or a licensee
//     key in the Licensee portal)
//
// Usage:
//   set ROYALTY_HUB_API_KEY=rh_live_...            (Windows)
//   export ROYALTY_HUB_API_KEY=rh_live_...         (macOS/Linux)
//   node tools/monitor-report.js clip.mp3 LIC-RADIO
//
// To REGISTER a song's fingerprint, run "fpcalc -raw -length 600 song.mp3" (whole song) and paste the
// numbers after FINGERPRINT= into the "Audio fingerprint" box when you register
// the work in the rights-holder portal.
// =============================================================================

const { execFile } = require('child_process');

const [, , audioFile, stationId] = process.argv;
const apiKey = process.env.ROYALTY_HUB_API_KEY;
const apiBase = process.env.ROYALTY_HUB_API || 'http://localhost:3001';

if (!audioFile) {
  console.error('Usage: node tools/monitor-report.js <audio-file> [station_id]');
  process.exit(1);
}
if (!apiKey) {
  console.error('Set the ROYALTY_HUB_API_KEY environment variable first.');
  process.exit(1);
}

// Step 1: compute the raw fingerprint with fpcalc.
execFile('fpcalc', ['-raw', audioFile], async (error, stdout) => {
  if (error) {
    console.error('Could not run fpcalc. Is Chromaprint installed and on your PATH?', error.message);
    process.exit(1);
  }
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('FINGERPRINT='));
  const durationLine = stdout.split(/\r?\n/).find((l) => l.startsWith('DURATION='));
  if (!line) {
    console.error('fpcalc did not return a fingerprint.');
    process.exit(1);
  }

  // Step 2: send it to the platform.
  const response = await fetch(`${apiBase}/api/open/v1/fingerprint-matches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({
      station_id: stationId,
      played_at: new Date().toISOString(),
      duration_sec: durationLine ? Number(durationLine.split('=')[1]) : null,
      fingerprint: line.slice('FINGERPRINT='.length)
    })
  });
  const result = await response.json();
  if (!response.ok) {
    console.error('API error:', result.message);
    process.exit(1);
  }
  console.log(result.matched
    ? `Matched "${result.title}" (confidence ${(result.confidence * 100).toFixed(1)}%). Usage ID ${result.usage_id}.`
    : `No match. Saved as unmatched usage ${result.usage_id}.`);
});
