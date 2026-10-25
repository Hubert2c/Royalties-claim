// =============================================================================
// server.js — Royalty Hub API + web portals
// -----------------------------------------------------------------------------
// Royalty Hub is the prototype of the "National Music Royalty Tracking
// Platform" proposed in the capstone document: a government-administered
// system that tracks music use (radio, TV, concerts, adverts, venues, digital),
// collects licence fees and pays royalties transparently to rights holders.
//
// This one Express server provides:
//   /api/auth/*          register, login, me                    (routes/auth.js)
//   /api/rightsholder/*  artists / songwriters / publishers     (routes/rightsholder.js)
//   /api/licensee/*      radio, TV, venues, organisers...       (routes/licensee.js)
//   /api/disputes        disputes raised by users               (routes/disputes.js)
//   /api/admin/*         government console (admin + auditor)   (routes/admin/)
//   /api/public/*        public transparency data, no login     (routes/public.js)
//   /api/open/v1/*       open API for machines (API keys)       (routes/open.js)
//
// And the web pages:
//   /            Government administration console
//   /artist      Rights-holder portal
//   /licensee    Licensee portal
//   /public      Public transparency dashboard
//   /docs        Open API documentation
// =============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initializeDatabase } = require('./database');
const { errorHandler } = require('./lib/errors');

// On Vercel only /tmp is writable, so keep uploaded evidence there by default.
if (process.env.VERCEL && !process.env.UPLOAD_DIR) process.env.UPLOAD_DIR = '/tmp/royalty-hub-uploads';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3001;
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:8000,http://localhost:3002')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

fs.mkdirSync(uploadDir, { recursive: true });

// The database is created (and demo data loaded) once at start-up.
// Routes wait for this promise so no request runs against an empty database.
const ready = initializeDatabase().catch((error) => {
  console.error('Database initialisation failed:', error);
  process.exit(1);
});
app.use(async (req, res, next) => { await ready; next(); });

// --- Security middleware ------------------------------------------------------
app.disable('x-powered-by');
app.use(helmet({
  // The portals load the Inter font from Google Fonts; everything else is local.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", ...allowedOrigins],
      imgSrc: ["'self'", 'data:']
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS: which other websites may call this API from a browser.
// Fixed after compatibility testing: a page always may call its OWN server,
// whatever address it was opened with (localhost, 127.0.0.1, a LAN IP from a
// phone on the same Wi-Fi, or the production domain). Before, only the
// addresses in ALLOWED_ORIGINS worked, so logging in from a phone failed.
const corsOptions = { methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'] };
app.use(cors((req, callback) => {
  const origin = req.headers.origin;
  const sameOrigin = Boolean(origin) && origin.replace(/^https?:\/\//, '') === req.headers.host;
  const allowed = !origin // curl, server-to-server, same-origin GETs
    || sameOrigin
    || allowedOrigins.includes(origin)
    || (!isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)); // the other local portals in development
  if (!allowed) return callback(new Error('CORS policy blocked this origin.'));
  return callback(null, { ...corsOptions, origin: true });
}));

// Limit how many requests one IP can make (protects logins against guessing).
// RATE_LIMIT_MAX overrides the default (e.g. for load tests or a busy monitor).
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || (isProduction ? 300 : 5000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' }
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// --- API routes ------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'royalty-hub-api' }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/rightsholder', require('./routes/rightsholder'));
app.use('/api/licensee', require('./routes/licensee'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin/index'));
app.use('/api/public', require('./routes/public'));
app.use('/api/open/v1', require('./routes/open'));

// Unknown API paths get a JSON 404 (not the HTML page).
app.use('/api', (req, res) => res.status(404).json({ message: 'API endpoint not found.' }));

// --- Web pages ---------------------------------------------------------------------
// Only these folders/files are public. (The project folder itself is NOT served,
// so .env, the database file and source code can never be downloaded.)
const send = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.use('/artist', express.static(path.join(__dirname, 'artist')));
app.use('/licensee', express.static(path.join(__dirname, 'licensee')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));
app.get('/styles.css', send('styles.css'));
app.get('/app.js', send('app.js'));
app.get('/', send('index.html'));

// --- Errors ------------------------------------------------------------------------
// Express 5 passes errors from async route handlers here automatically.
// AppError subclasses (ValidationError, ConflictError...) carry their own status.
app.use(errorHandler);

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'index.html')));

// --- Start -------------------------------------------------------------------------
const isVercelRuntime = Boolean(process.env.VERCEL);
const server = isVercelRuntime ? null : app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`Royalty Hub running on http://localhost:${PORT}`);
    console.log(`  Government console  http://localhost:${PORT}/`);
    console.log(`  Rights-holder portal http://localhost:${PORT}/artist`);
    console.log(`  Licensee portal      http://localhost:${PORT}/licensee`);
    console.log(`  Public dashboard     http://localhost:${PORT}/public`);
    console.log(`  Open API docs        http://localhost:${PORT}/docs`);
  }
});

module.exports = { app, server, ready, config: { PORT, isProduction } };

// When required by tests or start-all.js, don't keep the process alive on our own.
if (server && require.main !== module) server.unref();
