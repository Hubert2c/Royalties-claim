// =============================================================================
// routes/notifications.js — the notification bell (all logged-in users)
// =============================================================================

const express = require('express');
const { db } = require('../database');
const { authRequired } = require('../lib/auth');

const router = express.Router();
router.use(authRequired);

// GET /api/notifications — my latest 30 notifications + unread count
router.get('/', async (req, res) => {
  const notifications = await db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  const unread = Number((await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id)).n);
  res.json({ notifications, unread });
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ message: 'All notifications marked as read.' });
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ message: 'Marked as read.' });
});

module.exports = router;
