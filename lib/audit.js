// =============================================================================
// lib/audit.js — append-only, tamper-evident audit log
// -----------------------------------------------------------------------------
// Requirement FR-11 and the NFR "audit logs must be append-only": every create,
// update, approval and payment is written to the audit_log table.
//
// To make the log tamper-evident, each entry stores a SHA-256 hash of
// (previous entry's hash + this entry's data). This forms a chain, like a very
// simple blockchain without the network: if anyone edits or deletes an old row
// directly in the database, the hashes after it no longer line up and
// verifyAuditChain() reports exactly where the chain breaks.
// =============================================================================

const crypto = require('crypto');

const GENESIS_HASH = 'GENESIS';

// Build the text that gets hashed. The order of fields must never change.
function hashEntry(entry) {
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

// Add one entry to the log.
// actor: { id, role } — usually req.user
async function appendAudit(db, actor, action, entity, entityId, details) {
  // Retry a few times in case two requests try to take the same sequence number.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const last = await db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get();
    const entry = {
      seq: last ? Number(last.seq) + 1 : 1,
      actor_id: actor ? actor.id : null,
      actor_role: actor ? actor.role : null,
      action,
      entity,
      entity_id: entityId || null,
      details: details ? JSON.stringify(details) : null,
      created_at: new Date().toISOString(),
      prev_hash: last ? last.hash : GENESIS_HASH
    };
    entry.hash = hashEntry(entry);

    try {
      await db.prepare(`INSERT INTO audit_log (seq, actor_id, actor_role, action, entity, entity_id, details, created_at, prev_hash, hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.seq, entry.actor_id, entry.actor_role, entry.action, entry.entity, entry.entity_id,
          entry.details, entry.created_at, entry.prev_hash, entry.hash);
      return entry;
    } catch (error) {
      if (attempt === 4) throw error; // give up after 5 tries
    }
  }
  return null;
}

// Re-compute every hash from the start and check the chain is unbroken.
async function verifyAuditChain(db) {
  const rows = await db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const expectedSeq = i + 1;
    if (Number(row.seq) !== expectedSeq) {
      return { valid: false, count: rows.length, brokenAt: expectedSeq, reason: 'An entry is missing (sequence gap).' };
    }
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, count: rows.length, brokenAt: Number(row.seq), reason: 'Link to the previous entry does not match.' };
    }
    if (hashEntry({ ...row, seq: Number(row.seq) }) !== row.hash) {
      return { valid: false, count: rows.length, brokenAt: Number(row.seq), reason: 'Entry content was changed after it was written.' };
    }
    expectedPrev = row.hash;
  }
  return { valid: true, count: rows.length, brokenAt: null, reason: null };
}

module.exports = { appendAudit, verifyAuditChain, hashEntry, GENESIS_HASH };
