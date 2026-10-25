// =============================================================================
// lib/notifications/NotificationService.js — the bell icon in each portal
// -----------------------------------------------------------------------------
//   notifyUsers(userIds, title, body, view)   one user or a list of users
//   notifyRoles(['admin', 'auditor'], ...)    everyone with those roles
//   notifyHolders(holderIds, ...)             rights holders, by holder ID
// `view` is the portal page that opens when the notification is clicked.
//
// Notifications are a convenience: if one fails, the main action still
// succeeds (the error is logged, not thrown).
// =============================================================================

class NotificationService {
  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {Function} deps.newId
   * @param {Function} deps.nowIso
   */
  constructor({ db, newId, nowIso }) {
    this.db = db;
    this.newId = newId;
    this.nowIso = nowIso;
  }

  async notifyUsers(userIds, title, body, view) {
    const ids = [...new Set([].concat(userIds || []).filter(Boolean))];
    for (const userId of ids) {
      try {
        await this.db.prepare('INSERT INTO notifications (id, user_id, title, body, view, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(this.newId('NTF'), userId, String(title).slice(0, 160), body ? String(body).slice(0, 400) : null, view || null, 0, this.nowIso());
      } catch (error) {
        console.error('Notification failed:', error.message);
      }
    }
  }

  async notifyRoles(roles, title, body, view) {
    const placeholders = roles.map(() => '?').join(', ');
    const users = await this.db.prepare(`SELECT id FROM users WHERE role IN (${placeholders})`).all(...roles);
    await this.notifyUsers(users.map((user) => user.id), title, body, view);
  }

  async notifyHolders(holderIds, title, body, view) {
    const ids = [...new Set([].concat(holderIds || []).filter(Boolean))];
    const userIds = [];
    for (const holderId of ids) {
      const row = await this.db.prepare('SELECT user_id FROM rights_holders WHERE id = ?').get(holderId);
      if (row && row.user_id) userIds.push(row.user_id);
    }
    await this.notifyUsers(userIds, title, body, view);
  }
}

module.exports = { NotificationService };
