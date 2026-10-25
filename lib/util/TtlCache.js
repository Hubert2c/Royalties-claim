// =============================================================================
// lib/util/TtlCache.js — remember an answer for a few seconds
// -----------------------------------------------------------------------------
// Added after the load test: the dashboards count every play of the month on
// each request. With 100,000+ plays and 50 people refreshing at once, the
// same counts were computed hundreds of times per second. Dashboard figures
// may be a few seconds old, so each answer is kept for `ttlMs` milliseconds.
//
// If several requests arrive while an answer is being computed, they all wait
// for that one computation instead of starting their own.
// =============================================================================

class TtlCache {
  /** @param {number} ttlMs - how long an answer stays fresh (0 = no caching) */
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map(); // key -> { expires, promise }
  }

  /**
   * Return the cached value for `key`, or compute it with `producer()`.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} producer
   * @returns {Promise<T>}
   */
  async get(key, producer) {
    if (this.ttlMs <= 0) return producer();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.promise;

    const promise = producer();
    this.entries.set(key, { expires: now + this.ttlMs, promise });
    promise.catch(() => this.entries.delete(key)); // never cache a failure
    return promise;
  }

  /** Forget everything (e.g. after a change the user must see at once). */
  clear() {
    this.entries.clear();
  }
}

/** Shared cache for dashboard figures. DASHBOARD_CACHE_MS=0 turns it off (tests do). */
const dashboardCache = new TtlCache(
  process.env.DASHBOARD_CACHE_MS !== undefined ? Number(process.env.DASHBOARD_CACHE_MS) : (process.env.NODE_ENV === 'test' ? 0 : 3000)
);

module.exports = { TtlCache, dashboardCache };
