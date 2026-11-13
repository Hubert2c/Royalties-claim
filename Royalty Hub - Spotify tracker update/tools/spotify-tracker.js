// =============================================================================
// tools/spotify-tracker.js — report songs played on a connected Spotify account
// -----------------------------------------------------------------------------
// DEMONSTRATION TOOL. It shows how a streaming service's usage can reach
// Royalty Hub and be matched to registered songs by ISRC.
//
// How it works:
//   1. "login": you approve access once in the browser (Spotify's official
//      OAuth login with PKCE). Royalty Hub never sees your Spotify password.
//      The tokens are saved in .spotify-token.json (keep it private, it is in
//      .gitignore).
//   2. "track" (the default): every 2 minutes it asks Spotify for the songs this
//      account played recently, and sends each NEW play to Royalty Hub's Open
//      API as a digital-service usage report (source "ddex"). Royalty Hub
//      matches each play by its ISRC, then by title + artist.
//   3. "isrc": prints the last 10 songs you played with their ISRC, so you can
//      register a song with its real ISRC before tracking it.
//
// Limits (Spotify rules for personal "Development Mode" apps, 2026):
//   * the app owner needs Spotify Premium;
//   * at most 5 Spotify users can be connected to the app;
//   * Spotify only shows what CONNECTED users listened to — not a song's total
//     streams. In a real system, streaming services send monthly DDEX reports.
//
// Setup (see the step-by-step guide):
//   $env:SPOTIFY_CLIENT_ID   = "your app's Client ID from developer.spotify.com"
//   $env:ROYALTY_HUB_API_KEY = "rh_live_..."   (an API key of the streaming-service
//                                                licensee, made in the licensee portal)
//   node tools/spotify-tracker.js login
//   node tools/spotify-tracker.js isrc
//   node tools/spotify-tracker.js            (or: node tools/spotify-tracker.js track --every 60)
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ---- Settings (all can be changed with environment variables) ----------------
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/callback'; // must match the app settings on developer.spotify.com
const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com';     // Spotify login server
const SPOTIFY_API = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1';         // Spotify Web API
const HUB_API = process.env.ROYALTY_HUB_API || 'http://localhost:3001';                   // Royalty Hub
const HUB_KEY = process.env.ROYALTY_HUB_API_KEY;
const SCOPE = 'user-read-recently-played';                                                // the only permission we ask for
const TOKEN_FILE = path.join(__dirname, '..', '.spotify-token.json');                    // saved login (private)

const [command = 'track', ...rest] = process.argv.slice(2);
const everyIndex = rest.indexOf('--every');
const EVERY_SECONDS = everyIndex >= 0 ? Math.max(30, Number(rest[everyIndex + 1]) || 120) : 120;

// Stop with a clear message.
function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---- Saved tokens -------------------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveState(state) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(state, null, 2));
}

// ---- Step 1: log in with Spotify (Authorization Code flow with PKCE) ----------
// PKCE: we make a random secret (the "verifier") and send only its SHA-256 hash
// (the "challenge") to Spotify. Later we prove we started the login by sending
// the verifier. This is the method Spotify recommends for apps without a server secret.
const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login() {
  if (!CLIENT_ID) fail('Set SPOTIFY_CLIENT_ID first (from your app on developer.spotify.com).');
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const stateParam = base64url(crypto.randomBytes(12)); // protects against forged callbacks

  const authUrl = `${ACCOUNTS}/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPE, state: stateParam,
  });

  // A tiny local web server receives Spotify's redirect with the login code.
  const { port, pathname } = new URL(REDIRECT_URI);
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== pathname) { res.writeHead(404).end(); return; }
      const error = url.searchParams.get('error');
      if (error || url.searchParams.get('state') !== stateParam) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h2>Spotify login was not completed.</h2>');
        server.close(); reject(new Error(error || 'State mismatch')); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>Spotify is connected to Royalty Hub. You can close this tab.</h2>');
      server.close(); resolve(url.searchParams.get('code'));
    });
    server.listen(Number(port), '127.0.0.1', () => {
      console.log('\nOpen this link to connect your Spotify account (it should open by itself):\n\n' + authUrl + '\n');
      // Try to open the browser automatically (Windows, macOS, Linux).
      const opener = process.platform === 'win32' ? `start "" "${authUrl}"` : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
      exec(opener, () => {});
    });
  });

  // Exchange the code (+ verifier) for an access token and a refresh token.
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier });
  saveState({ ...tokens, cursor: Date.now() }); // only plays from now on will be tracked
  console.log('Connected. Tokens saved in .spotify-token.json (keep this file private).');
}

// Ask Spotify's login server for tokens; returns { access_token, refresh_token, expires_at }.
async function tokenRequest(form) {
  const response = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
  });
  const data = await response.json();
  if (!response.ok) fail(`Spotify login failed: ${data.error_description || data.error || response.status}`);
  return { access_token: data.access_token, refresh_token: data.refresh_token || form.refresh_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
}

// Access tokens last one hour; refresh it when needed.
async function accessToken(state) {
  if (Date.now() < state.expires_at) return state.access_token;
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: state.refresh_token, client_id: CLIENT_ID });
  Object.assign(state, fresh); saveState(state);
  return state.access_token;
}

// ---- Step 2: read recently played songs from Spotify ---------------------------
// GET /me/player/recently-played returns up to 50 plays, newest first.
// "after" (a time in milliseconds) asks only for plays after our last check.
async function recentlyPlayed(state, after, limit = 50) {
  const url = `${SPOTIFY_API}/me/player/recently-played?` + new URLSearchParams(after ? { limit, after } : { limit });
  const response = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(state)}` } });
  if (response.status === 403) fail('Spotify refused access (403). Check that your account is added under "User Management" in the app, and that the app owner has Premium.');
  if (response.status === 429) return { items: [], retryAfter: Number(response.headers.get('retry-after')) || 60 };
  if (!response.ok) fail(`Spotify error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return { items: data.items || [] };
}

// Turn one Spotify play into a Royalty Hub usage row.
function toUsageRow(item) {
  const track = item.track || {};
  return {
    played_at: item.played_at,
    title: track.name,
    artist: (track.artists || []).map((a) => a.name).join(', '),
    isrc: track.external_ids && track.external_ids.isrc ? track.external_ids.isrc : undefined,
    duration_sec: track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined,
  };
}

// ---- "isrc": show the ISRC of the last songs played ----------------------------
async function showIsrc() {
  const state = loadState() || fail('Run "node tools/spotify-tracker.js login" first.');
  const { items } = await recentlyPlayed(state, null, 10);
  if (!items.length) { console.log('No recently played songs yet. Play a song on Spotify (at least 30 seconds), then try again.'); return; }
  console.log('\nLast songs played on this Spotify account:\n');
  for (const row of items.map(toUsageRow)) {
    console.log(`  ${row.isrc || '(no ISRC)'}   ${row.title} — ${row.artist}`);
  }
  console.log('\nRegister the song in Royalty Hub with this ISRC, then run the tracker.\n');
}

// ---- "track": send new plays to Royalty Hub, again and again -------------------
async function track() {
  if (!HUB_KEY) fail('Set ROYALTY_HUB_API_KEY first (an API key of the streaming-service licensee).');
  const state = loadState() || fail('Run "node tools/spotify-tracker.js login" first.');
  console.log(`\nRoyalty Hub Spotify tracker\n  Server : ${HUB_API}\n  Checks : every ${EVERY_SECONDS} s\n  Stop   : press Ctrl+C\n`);

  const sent = { plays: 0, matched: 0 };
  process.on('SIGINT', () => { console.log(`\nStopped. Plays sent: ${sent.plays}, matched to registered songs: ${sent.matched}`); process.exit(0); });

  for (;;) {
    const time = new Date().toLocaleTimeString();
    const { items, retryAfter } = await recentlyPlayed(state, state.cursor);
    if (retryAfter) { console.log(`[${time}] Spotify asked us to slow down; waiting ${retryAfter} s`); await sleep(retryAfter); continue; }

    // Oldest first, and only plays after the cursor (in case Spotify repeats one).
    const fresh = items.filter((i) => new Date(i.played_at).getTime() > state.cursor)
      .sort((a, b) => new Date(a.played_at) - new Date(b.played_at));

    if (!fresh.length) {
      console.log(`[${time}] no new plays`);
    } else {
      const rows = fresh.map(toUsageRow);
      const response = await fetch(`${HUB_API}/api/open/v1/usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': HUB_KEY },
        body: JSON.stringify({ source: 'ddex', events: rows }),
      }).catch((error) => ({ ok: false, json: async () => ({ message: error.message }) }));
      const result = await response.json();
      if (!response.ok) {
        console.log(`[${time}] could not reach Royalty Hub: ${result.message} - will try again`);
      } else {
        // Only move the cursor forward after Royalty Hub has saved the plays.
        state.cursor = Math.max(...fresh.map((i) => new Date(i.played_at).getTime()));
        saveState(state);
        (result.events || []).forEach((event, n) => {
          const row = rows[n];
          sent.plays += 1;
          if (event.matched) {
            sent.matched += 1;
            console.log(`[${time}] PLAY MATCHED: "${event.title}" (ISRC ${row.isrc || '—'}) - saved as ${event.id}`);
          } else {
            console.log(`[${time}] not registered: "${row.title}" — ${row.artist} (ISRC ${row.isrc || '—'}) - saved as unmatched ${event.id}`);
          }
        });
      }
    }
    await sleep(EVERY_SECONDS);
  }
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ---- Run the chosen command ----------------------------------------------------
const commands = { login, isrc: showIsrc, track };
if (!commands[command]) fail('Usage: node tools/spotify-tracker.js [login | isrc | track] [--every 120]');
commands[command]().catch((error) => fail(error.message));
