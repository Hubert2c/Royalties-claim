require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { db, initializeDatabase } = require('./database');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'royalty-claims-secret';
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:8000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '-');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg'
]);

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file) {
      return cb(null, true);
    }

    if (allowedMimeTypes.has(file.mimetype)) {
      return cb(null, true);
    }

    return cb(new Error('Unsupported file type. Allowed types: PDF, DOC, DOCX, PNG, JPG.'));
  }
});

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function validatePassword(password) {
  return String(password || '').length >= 6;
}

initializeDatabase().catch((error) => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin) || /localhost:\d+$/.test(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS policy blocked this origin.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 200 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'royalty-claims-api' });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email and password are required.' });
  }

  if (!validateEmail(email)) {
    return res.status(400).json({ message: 'Please provide a valid email address.' });
  }

  if (!validatePassword(password)) {
    return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ message: 'A user with this email already exists.' });
  }

  const newUser = {
    id: `user-${Date.now()}`,
    name: String(name).trim(),
    email: normalizedEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: ['admin', 'reviewer', 'claimant'].includes(role) ? role : 'claimant'
  };

  await db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    newUser.id,
    newUser.name,
    newUser.email,
    newUser.passwordHash,
    newUser.role,
    new Date().toISOString()
  );

  const user = {
    id: newUser.id,
    name: newUser.name,
    email: newUser.email,
    role: newUser.role
  };

  return res.status(201).json({
    token: createToken(user),
    user
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  if (!validateEmail(email)) {
    return res.status(400).json({ message: 'Please provide a valid email address.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const isValid = bcrypt.compareSync(String(password), user.password_hash);
  if (!isValid) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const safeUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };

  return res.json({
    token: createToken(safeUser),
    user: safeUser
  });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({ user });
});

app.get('/api/claims', authMiddleware, async (req, res) => {
  const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);

  let rows;
  if (user.role === 'claimant') {
    rows = await db.prepare(
      'SELECT * FROM claims WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);
  } else {
    rows = await db.prepare('SELECT * FROM claims ORDER BY created_at DESC').all();
  }

  return res.json({ claims: rows });
});

app.get('/api/claims/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const claim = await db.prepare('SELECT * FROM claims WHERE id = ?').get(id);

  if (!claim) {
    return res.status(404).json({ message: 'Claim not found.' });
  }

  const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role === 'claimant' && claim.user_id !== req.user.id) {
    return res.status(403).json({ message: 'You are not authorized to view this claim.' });
  }

  return res.json({ claim });
});

app.post('/api/claims', authMiddleware, (req, res) => {
  upload.single('file')(req, res, async (error) => {
    if (error) {
      return res.status(400).json({ message: error.message || 'File upload failed.' });
    }

    const { artist, track, amount, submittedDate, notes } = req.body;

    if (!artist || !track || !submittedDate || !amount) {
      return res.status(400).json({ message: 'Artist, track, amount and submission date are required.' });
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ message: 'Claim amount must be a number greater than zero.' });
    }

    const submissionDate = new Date(submittedDate);
    if (Number.isNaN(submissionDate.getTime())) {
      return res.status(400).json({ message: 'Please provide a valid submission date.' });
    }

    const formattedAmount = Number(parsedAmount.toFixed(2));
    const claimId = `RC-${Date.now().toString().slice(-6)}`;
    const claim = {
      id: claimId,
      user_id: req.user.id,
      artist: String(artist).trim(),
      track: String(track).trim(),
      amount: formattedAmount,
      status: 'Pending',
      submitted_date: submittedDate,
      notes: notes ? String(notes).trim() : '',
      file_name: req.file ? req.file.filename : null,
      created_at: new Date().toISOString()
    };

    await db.prepare(`
      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claim.id,
      claim.user_id,
      claim.artist,
      claim.track,
      claim.amount,
      claim.status,
      claim.submitted_date,
      claim.notes,
      claim.file_name,
      claim.created_at
    );

    return res.status(201).json({ message: 'Claim submitted successfully.', claim });
  });
});

app.patch('/api/claims/:id/status', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status selected.' });
  }

  const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!user || !['admin', 'reviewer'].includes(user.role)) {
    return res.status(403).json({ message: 'Only admins or reviewers can update claim status.' });
  }

  const updated = await db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(status, id);
  if (updated.changes === 0) {
    return res.status(404).json({ message: 'Claim not found.' });
  }

  const claim = await db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  return res.json({ message: 'Claim status updated.', claim });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File size exceeds the 5MB limit.' });
  }

  if (error) {
    return res.status(400).json({ message: error.message || 'Request validation failed.' });
  }

  return next();
});

app.use(express.static(__dirname));
app.get(/^(?!\/api).*/, (req, res) => {
  return res.sendFile(path.join(__dirname, 'index.html'));
});

const isVercelRuntime = Boolean(process.env.VERCEL);

const server = isVercelRuntime ? null : app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`Royalty claims API running on http://localhost:${PORT}`);
  }
});

const exportedApi = {
  app,
  server,
  config: {
    PORT,
    JWT_SECRET,
    isProduction
  }
};

module.exports = exportedApi;

if (!isVercelRuntime && require.main !== module) {
  server.unref();
}
