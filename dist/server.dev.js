"use strict";

require('dotenv').config();

var express = require('express');

var cors = require('cors');

var fs = require('fs');

var path = require('path');

var bcrypt = require('bcryptjs');

var jwt = require('jsonwebtoken');

var multer = require('multer');

var helmet = require('helmet');

var rateLimit = require('express-rate-limit');

var _require = require('./database'),
    db = _require.db,
    initializeDatabase = _require.initializeDatabase;

var app = express();
var isProduction = process.env.NODE_ENV === 'production';
var PORT = Number(process.env.PORT) || 3001;
var JWT_SECRET = process.env.JWT_SECRET || 'royalty-claims-secret';
var uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
var MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;
var allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:8000').split(',').map(function (origin) {
  return origin.trim();
}).filter(Boolean);
fs.mkdirSync(uploadDir, {
  recursive: true
});
var storage = multer.diskStorage({
  destination: function destination(req, file, cb) {
    return cb(null, uploadDir);
  },
  filename: function filename(req, file, cb) {
    var safeName = file.originalname.replace(/\s+/g, '-');
    cb(null, "".concat(Date.now(), "-").concat(safeName));
  }
});
var allowedMimeTypes = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg']);
var upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: function fileFilter(req, file, cb) {
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

initializeDatabase()["catch"](function (error) {
  console.error('Database initialization failed:', error);
  process.exit(1);
});
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: {
    policy: 'cross-origin'
  }
}));
app.use(cors({
  origin: function origin(_origin, callback) {
    if (!_origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(_origin) || /localhost:\d+$/.test(_origin)) {
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
  message: {
    message: 'Too many requests, please try again later.'
  }
}));
app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));
app.use('/uploads', express["static"](uploadDir));

function createToken(user) {
  return jwt.sign({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role
  }, JWT_SECRET, {
    expiresIn: '8h'
  });
}

function authMiddleware(req, res, next) {
  var authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      message: 'Authentication required.'
    });
  }

  var token = authHeader.split(' ')[1];

  try {
    var payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid or expired token.'
    });
  }
}

app.get('/api/health', function (req, res) {
  res.json({
    status: 'ok',
    service: 'royalty-claims-api'
  });
});
app.post('/api/auth/register', function _callee(req, res) {
  var _req$body, name, email, password, role, normalizedEmail, existing, newUser, user;

  return regeneratorRuntime.async(function _callee$(_context) {
    while (1) {
      switch (_context.prev = _context.next) {
        case 0:
          _req$body = req.body, name = _req$body.name, email = _req$body.email, password = _req$body.password, role = _req$body.role;

          if (!(!name || !email || !password)) {
            _context.next = 3;
            break;
          }

          return _context.abrupt("return", res.status(400).json({
            message: 'Name, email and password are required.'
          }));

        case 3:
          if (validateEmail(email)) {
            _context.next = 5;
            break;
          }

          return _context.abrupt("return", res.status(400).json({
            message: 'Please provide a valid email address.'
          }));

        case 5:
          if (validatePassword(password)) {
            _context.next = 7;
            break;
          }

          return _context.abrupt("return", res.status(400).json({
            message: 'Password must be at least 6 characters long.'
          }));

        case 7:
          normalizedEmail = String(email).trim().toLowerCase();
          _context.next = 10;
          return regeneratorRuntime.awrap(db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail));

        case 10:
          existing = _context.sent;

          if (!existing) {
            _context.next = 13;
            break;
          }

          return _context.abrupt("return", res.status(409).json({
            message: 'A user with this email already exists.'
          }));

        case 13:
          newUser = {
            id: "user-".concat(Date.now()),
            name: String(name).trim(),
            email: normalizedEmail,
            passwordHash: bcrypt.hashSync(String(password), 10),
            role: ['admin', 'reviewer', 'claimant'].includes(role) ? role : 'claimant'
          };
          _context.next = 16;
          return regeneratorRuntime.awrap(db.prepare("\n    INSERT INTO users (id, name, email, password_hash, role, created_at)\n    VALUES (?, ?, ?, ?, ?, ?)\n  ").run(newUser.id, newUser.name, newUser.email, newUser.passwordHash, newUser.role, new Date().toISOString()));

        case 16:
          user = {
            id: newUser.id,
            name: newUser.name,
            email: newUser.email,
            role: newUser.role
          };
          return _context.abrupt("return", res.status(201).json({
            token: createToken(user),
            user: user
          }));

        case 18:
        case "end":
          return _context.stop();
      }
    }
  });
});
app.post('/api/auth/login', function _callee2(req, res) {
  var _req$body2, email, password, user, isValid, safeUser;

  return regeneratorRuntime.async(function _callee2$(_context2) {
    while (1) {
      switch (_context2.prev = _context2.next) {
        case 0:
          _req$body2 = req.body, email = _req$body2.email, password = _req$body2.password;

          if (!(!email || !password)) {
            _context2.next = 3;
            break;
          }

          return _context2.abrupt("return", res.status(400).json({
            message: 'Email and password are required.'
          }));

        case 3:
          if (validateEmail(email)) {
            _context2.next = 5;
            break;
          }

          return _context2.abrupt("return", res.status(400).json({
            message: 'Please provide a valid email address.'
          }));

        case 5:
          _context2.next = 7;
          return regeneratorRuntime.awrap(db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()));

        case 7:
          user = _context2.sent;

          if (user) {
            _context2.next = 10;
            break;
          }

          return _context2.abrupt("return", res.status(401).json({
            message: 'Invalid email or password.'
          }));

        case 10:
          isValid = bcrypt.compareSync(String(password), user.password_hash);

          if (isValid) {
            _context2.next = 13;
            break;
          }

          return _context2.abrupt("return", res.status(401).json({
            message: 'Invalid email or password.'
          }));

        case 13:
          safeUser = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role
          };
          return _context2.abrupt("return", res.json({
            token: createToken(safeUser),
            user: safeUser
          }));

        case 15:
        case "end":
          return _context2.stop();
      }
    }
  });
});
app.get('/api/me', authMiddleware, function _callee3(req, res) {
  var user;
  return regeneratorRuntime.async(function _callee3$(_context3) {
    while (1) {
      switch (_context3.prev = _context3.next) {
        case 0:
          _context3.next = 2;
          return regeneratorRuntime.awrap(db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id));

        case 2:
          user = _context3.sent;

          if (user) {
            _context3.next = 5;
            break;
          }

          return _context3.abrupt("return", res.status(404).json({
            message: 'User not found.'
          }));

        case 5:
          return _context3.abrupt("return", res.json({
            user: user
          }));

        case 6:
        case "end":
          return _context3.stop();
      }
    }
  });
});
app.get('/api/claims', authMiddleware, function _callee4(req, res) {
  var user, rows;
  return regeneratorRuntime.async(function _callee4$(_context4) {
    while (1) {
      switch (_context4.prev = _context4.next) {
        case 0:
          _context4.next = 2;
          return regeneratorRuntime.awrap(db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id));

        case 2:
          user = _context4.sent;

          if (!(user.role === 'claimant')) {
            _context4.next = 9;
            break;
          }

          _context4.next = 6;
          return regeneratorRuntime.awrap(db.prepare('SELECT * FROM claims WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id));

        case 6:
          rows = _context4.sent;
          _context4.next = 12;
          break;

        case 9:
          _context4.next = 11;
          return regeneratorRuntime.awrap(db.prepare('SELECT * FROM claims ORDER BY created_at DESC').all());

        case 11:
          rows = _context4.sent;

        case 12:
          return _context4.abrupt("return", res.json({
            claims: rows
          }));

        case 13:
        case "end":
          return _context4.stop();
      }
    }
  });
});
app.get('/api/claims/:id', authMiddleware, function _callee5(req, res) {
  var id, claim, user;
  return regeneratorRuntime.async(function _callee5$(_context5) {
    while (1) {
      switch (_context5.prev = _context5.next) {
        case 0:
          id = req.params.id;
          _context5.next = 3;
          return regeneratorRuntime.awrap(db.prepare('SELECT * FROM claims WHERE id = ?').get(id));

        case 3:
          claim = _context5.sent;

          if (claim) {
            _context5.next = 6;
            break;
          }

          return _context5.abrupt("return", res.status(404).json({
            message: 'Claim not found.'
          }));

        case 6:
          _context5.next = 8;
          return regeneratorRuntime.awrap(db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id));

        case 8:
          user = _context5.sent;

          if (!(user.role === 'claimant' && claim.user_id !== req.user.id)) {
            _context5.next = 11;
            break;
          }

          return _context5.abrupt("return", res.status(403).json({
            message: 'You are not authorized to view this claim.'
          }));

        case 11:
          return _context5.abrupt("return", res.json({
            claim: claim
          }));

        case 12:
        case "end":
          return _context5.stop();
      }
    }
  });
});
app.post('/api/claims', authMiddleware, function (req, res) {
  upload.single('file')(req, res, function _callee6(error) {
    var _req$body3, artist, track, amount, submittedDate, notes, parsedAmount, submissionDate, formattedAmount, claimId, claim;

    return regeneratorRuntime.async(function _callee6$(_context6) {
      while (1) {
        switch (_context6.prev = _context6.next) {
          case 0:
            if (!error) {
              _context6.next = 2;
              break;
            }

            return _context6.abrupt("return", res.status(400).json({
              message: error.message || 'File upload failed.'
            }));

          case 2:
            _req$body3 = req.body, artist = _req$body3.artist, track = _req$body3.track, amount = _req$body3.amount, submittedDate = _req$body3.submittedDate, notes = _req$body3.notes;

            if (!(!artist || !track || !submittedDate || !amount)) {
              _context6.next = 5;
              break;
            }

            return _context6.abrupt("return", res.status(400).json({
              message: 'Artist, track, amount and submission date are required.'
            }));

          case 5:
            parsedAmount = Number(amount);

            if (!(!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
              _context6.next = 8;
              break;
            }

            return _context6.abrupt("return", res.status(400).json({
              message: 'Claim amount must be a number greater than zero.'
            }));

          case 8:
            submissionDate = new Date(submittedDate);

            if (!Number.isNaN(submissionDate.getTime())) {
              _context6.next = 11;
              break;
            }

            return _context6.abrupt("return", res.status(400).json({
              message: 'Please provide a valid submission date.'
            }));

          case 11:
            formattedAmount = Number(parsedAmount.toFixed(2));
            claimId = "RC-".concat(Date.now().toString().slice(-6));
            claim = {
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
            _context6.next = 16;
            return regeneratorRuntime.awrap(db.prepare("\n      INSERT INTO claims (id, user_id, artist, track, amount, status, submitted_date, notes, file_name, created_at)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n    ").run(claim.id, claim.user_id, claim.artist, claim.track, claim.amount, claim.status, claim.submitted_date, claim.notes, claim.file_name, claim.created_at));

          case 16:
            return _context6.abrupt("return", res.status(201).json({
              message: 'Claim submitted successfully.',
              claim: claim
            }));

          case 17:
          case "end":
            return _context6.stop();
        }
      }
    });
  });
});
app.patch('/api/claims/:id/status', authMiddleware, function _callee7(req, res) {
  var id, status, user, updated, claim;
  return regeneratorRuntime.async(function _callee7$(_context7) {
    while (1) {
      switch (_context7.prev = _context7.next) {
        case 0:
          id = req.params.id;
          status = req.body.status;

          if (['Pending', 'Approved', 'Rejected'].includes(status)) {
            _context7.next = 4;
            break;
          }

          return _context7.abrupt("return", res.status(400).json({
            message: 'Invalid status selected.'
          }));

        case 4:
          _context7.next = 6;
          return regeneratorRuntime.awrap(db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id));

        case 6:
          user = _context7.sent;

          if (!(!user || !['admin', 'reviewer'].includes(user.role))) {
            _context7.next = 9;
            break;
          }

          return _context7.abrupt("return", res.status(403).json({
            message: 'Only admins or reviewers can update claim status.'
          }));

        case 9:
          _context7.next = 11;
          return regeneratorRuntime.awrap(db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(status, id));

        case 11:
          updated = _context7.sent;

          if (!(updated.changes === 0)) {
            _context7.next = 14;
            break;
          }

          return _context7.abrupt("return", res.status(404).json({
            message: 'Claim not found.'
          }));

        case 14:
          _context7.next = 16;
          return regeneratorRuntime.awrap(db.prepare('SELECT * FROM claims WHERE id = ?').get(id));

        case 16:
          claim = _context7.sent;
          return _context7.abrupt("return", res.json({
            message: 'Claim status updated.',
            claim: claim
          }));

        case 18:
        case "end":
          return _context7.stop();
      }
    }
  });
});
app.use(function (error, req, res, next) {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      message: 'File size exceeds the 5MB limit.'
    });
  }

  if (error) {
    return res.status(400).json({
      message: error.message || 'Request validation failed.'
    });
  }

  return next();
});
app.use(express["static"](__dirname));
app.get(/^(?!\/api).*/, function (req, res) {
  return res.sendFile(path.join(__dirname, 'index.html'));
});
var isVercelRuntime = Boolean(process.env.VERCEL);
var server = isVercelRuntime ? null : app.listen(PORT, function () {
  if (process.env.NODE_ENV !== 'test') {
    console.log("Royalty claims API running on http://localhost:".concat(PORT));
  }
});
var exportedApi = {
  app: app,
  server: server,
  config: {
    PORT: PORT,
    JWT_SECRET: JWT_SECRET,
    isProduction: isProduction
  }
};
module.exports = exportedApi;

if (!isVercelRuntime && require.main !== module) {
  server.unref();
}
//# sourceMappingURL=server.dev.js.map
