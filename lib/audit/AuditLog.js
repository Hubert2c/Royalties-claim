// =============================================================================
// lib/audit/AuditLog.js — append-only, tamper-evident audit log (FR-11)
// -----------------------------------------------------------------------------
// Every create, approval and payment is written to the audit_log table.
//
// ALGORITHM — a hash chain (like a very small blockchain without a network):
// each entry stores SHA-256(previous entry's hash + this entry's data). If
// anyone edits or deletes an old row directly in the database, the hashes after
// it no longer line up, and verify() reports exactly where the chain breaks.
// Verification is one pass over the log: O(n).
// =============================================================================

const crypto = require('crypto');

class AuditLog {
  static GENESIS_HASH = 'GENESIS';

  /** @param {object} db - the database wrapper from database.js */
  constructor(db) {
    this.db = db;
    // Appends take turns (a promise queue). Found by the load test: with 100
    // users at once, two requests could read the same "last entry" and both
    // try to write the next number. Queuing makes the chain strictly ordered.
    this.queue = Promise.resolve();
  }

  /** The text that is hashed. The order of the fields must never change. */
  static hashEntry(entry) {
    const text = [
      entry.prev_hash,
      entry.seq,
      entry.actor_id || '',
      entry.actor_role || '',
      entry.action,
      entry.entity,
      entry.entity_id || '',
      entry.details || '',
      entry.created_at
    ].join('|');
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Add one entry at the end of the chain.
   * @param {{id: string, role: string}|null} actor - usually req.user
   * @param {string} action - e.g. "approve_licence"
   * @param {string} entity - e.g. "licence"
   * @param {string|null} entityId
   * @param {object|null} details - stored as JSON
   */
  append(actor, action, entity, entityId, details) {
    const next = this.queue.then(() => this.appendNow(actor, action, entity, entityId, details));
    this.queue = next.catch(() => {}); // one failure must not block later appends
    return next;
  }

  /** Write one entry (called only through the queue in append()). */
  async appendNow(actor, action, entity, entityId, details) {
    // A second server process could still race us; retry a few times.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get();
      const entry = {
        seq: last ? Number(last.seq) + 1 : 1,
        actor_id: actor ? actor.id : null,
        actor_role: actor ? actor.role : null,
        action,
        entity,
        entity_id: entityId || null,
        details: details ? JSON.stringify(details) : null,
        created_at: new Date().toISOString(),
        prev_hash: last ? last.hash : AuditLog.GENESIS_HASH
      };
      entry.hash = AuditLog.hashEntry(entry);

      try {
        await this.db.prepare(`INSERT INTO audit_log (seq, actor_id, actor_role, action, entity, entity_id, details, created_at, prev_hash, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(entry.seq, entry.actor_id, entry.actor_role, entry.action, entry.entity, entry.entity_id,
            entry.details, entry.created_at, entry.prev_hash, entry.hash);
        return entry;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    return null;
  }

  /**
   * Re-compute every hash from the start.
   * @returns {Promise<{valid: boolean, count: number, brokenAt: number|null, reason: string|null}>}
   */
  async verify() {
    const rows = await this.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
    let expectedPrev = AuditLog.GENESIS_HASH;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const expectedSeq = i + 1;
      if (Number(row.seq) !== expectedSeq) {
        return { valid: false, count: rows.length, brokenAt: expectedSeq, reason: 'An entry is missing (sequence gap).' };
      }
      if (row.prev_hash !== expectedPrev) {
        return { valid: false, count: rows.length, brokenAt: Number(row.seq), reason: 'Link to the previous entry does not match.' };
      }
      if (AuditLog.hashEntry({ ...row, seq: Number(row.seq) }) !== row.hash) {
        return { valid: false, count: rows.length, brokenAt: Number(row.seq), reason: 'Entry content was changed after it was written.' };
      }
      expectedPrev = row.hash;
    }
    return { valid: true, count: rows.length, brokenAt: null, reason: null };
  }
}

module.exports = { AuditLog };
