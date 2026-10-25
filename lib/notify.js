// =============================================================================
// lib/notify.js — create in-app notifications (the bell icon in each portal)
// -----------------------------------------------------------------------------
// notifyUsers(userIds, title, body, view)
//   userIds — one ID or a list of user IDs
//   view    — the portal view that opens when the notification is clicked
//             (e.g. "confirm", "statements", "licences", "claims")
// notifyRoles(['admin', 'auditor'], ...) — notify everyone with those roles.
// notifyHolders(holderIds, ...)          — notify rights holders by holder ID.
//
// Notifications are a convenience: if creating one fails, the main action
// still succeeds (errors are logged, not thrown).
// =============================================================================

const { db, newId, nowIso } = require('../database');

async function notifyUsers(userIds, title, body, view) {
  const ids = [...new Set([].concat(userIds || []).filter(Boolean))];
  for (const userId of ids) {
    try {
      await db.prepare('INSERT INTO notifications (id, user_id, title, body, view, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId('NTF'), userId, String(title).slice(0, 160), body ? String(body).slice(0, 400) : null, view || null, 0, nowIso());
    } catch (error) {
      console.error('Notification failed:', error.message);
    }
  }
}

async function notifyRoles(roles, title, body, view) {
  const placeholders = roles.map(() => '?').join(', ');
  const users = await db.prepare(`SELECT id FROM users WHERE role IN (${placeholders})`).all(...roles);
  await notifyUsers(users.map((u) => u.id), title, body, view);
}

async function notifyHolders(holderIds, title, body, view) {
  const ids = [...new Set([].concat(holderIds || []).filter(Boolean))];
  const userIds = [];
  for (const holderId of ids) {
    const row = await db.prepare('SELECT user_id FROM rights_holders WHERE id = ?').get(holderId);
    if (row && row.user_id) userIds.push(row.user_id);
  }
  await notifyUsers(userIds, title, body, view);
}

// Short helper for money in notification text.
const rwf = (amount) => `Rwf ${Math.round(Number(amount || 0)).toLocaleString('en-US')}`;

module.exports = { notifyUsers, notifyRoles, notifyHolders, rwf };
