'use strict';
/**
 * THE INVESTOR CONFIGURATION, READ ONCE, FOR BOTH ENGINES.
 *
 * Which investors are on, what a client may call each one, which rate sheet each
 * is fetched from, and what margin is held back — four stored settings that the
 * Combined Pricing Engine has read since it was built, and that the General
 * Pricing Engine now reads too (owner-directed 2026-09-03: the side-by-side list
 * lives in the general engine's settings and governs both boards).
 *
 * ⛔ WHY THIS MODULE EXISTS RATHER THAN A SECOND COPY OF FOUR SMALL FUNCTIONS.
 * The settings are addressed by KEY STRINGS. Two engines each holding their own
 * copy of `'pricing.combinedInvestors'` is a rename away from one screen saving
 * to a key the other never reads — the officer turns an investor off, the board
 * keeps quoting it, and nothing anywhere fails. One definition, so the keys
 * cannot drift apart.
 *
 * EVERY READ IS NON-THROWING AND SAYS WHEN IT FAILED. A settings store that is
 * briefly unreachable must not cost a board: the caller gets the declared default
 * plus a `problem`, so it can price with the standing configuration and still
 * report that the saved one could not be read. Silently answering "no investors
 * are configured" would empty a board and look like a rate sheet outage.
 */

const settingsStore = require('../settings/store');
const routing = require('./investor-routing');
const investorLinks = require('./investor-links');
const rosterContext = require('./roster-context');
const sightings = require('./investor-sightings');

/** The stored keys, named once. */
const KEYS = {
  investors: 'pricing.combinedInvestors',
  marginHoldback: 'pricing.combinedMarginHoldback',
  links: investorLinks.SETTING_KEY,
  sightings: sightings.SETTING_KEY,
};

const reasonOf = (e) => String((e && e.message) || e || 'unknown').slice(0, 200);

/** Per-investor settings: on/off, white label, source, per-investor holdback. */
async function investorsRaw() {
  try {
    const stored = await settingsStore.get(KEYS.investors, 'company');
    return routing.resolveRaw({ stored });
  } catch (e) {
    return { ...routing.resolveRaw({ stored: null }), problem: reasonOf(e) };
  }
}

/** The standing margin holdback. `undefined` means "nobody has set one". */
async function holdbackRaw() {
  try {
    return await settingsStore.get(KEYS.marginHoldback, 'company');
  } catch (_) {
    return undefined;
  }
}

/** "This name and this name are the same investor" — recorded by a person. */
async function linksRaw() {
  try {
    const stored = await settingsStore.get(KEYS.links, 'company');
    return { raw: stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}, problem: null };
  } catch (e) {
    return { raw: {}, problem: reasonOf(e) };
  }
}

/** The investors somebody added by hand. */
async function customRaw() {
  return rosterContext.loadCustom();
}

/** Which rate sheet has produced which investor — the measured "available on" register. */
async function sightingsRaw() {
  try {
    const stored = await settingsStore.get(KEYS.sightings, 'company');
    return { ...sightings.read(stored), problem: null };
  } catch (e) {
    return { ...sightings.read(null), problem: reasonOf(e) };
  }
}

/**
 * RECORD WHAT A BOARD ACTUALLY RETURNED — the ONE writer of the sightings register.
 *
 * ⛔ THE ONLY WRITE IN A MODULE OF READS, AND IT IS DELIBERATE. The keys live here (see
 * the header), and a second module writing `pricing.investorSightings` would be a second
 * place that string can drift from the readers. So the write stays beside its key.
 *
 * ⛔ IT MAY NEVER COST A BOARD. A search has already happened by the time this runs; a
 * settings store that is briefly unwritable must cost the "available on" column and
 * nothing else, so every failure is swallowed and reported in the return value. It also
 * refuses a source that did not ANSWER — a vendor outage is no evidence about any
 * investor, and recording one would lock out every investor that sheet normally carries.
 *
 * ⛔ IT IS A READ-MODIFY-WRITE OF ONE SHARED KEY, SO IT TAKES A LOCK (post-merge audit
 * 2026-09-03, REPRODUCED before it was changed).
 *
 * `store.save` is a per-key `ON CONFLICT … DO UPDATE SET value = EXCLUDED.value` —
 * last-writer-wins, no compare-and-set — so two passes that read the same `stored` and
 * then both write produce ONE of the two answers and silently drop the other. While the
 * bands door was the only writer that could not happen. It can now: `LtPricer` fires the
 * immediate board AND the band board on ONE press, and both record.
 *
 * MEASURED against this function with a 15 ms read and a 15 ms write: overlapping, one
 * press recorded `acra, phh` and lost NQM's sighting entirely; sequential, the same two
 * calls recorded `acra, nqm, phh`. A lost sighting is exactly the defect this register
 * was built to fix — the settings screen goes on saying a sheet has never produced an
 * investor it produced today.
 *
 * A PER-KEY ADVISORY LOCK, not a JS mutex: it holds across the web process, the worker
 * and every Render instance, which is what a two-officer shop or a scaled-out service
 * actually needs. It FAILS OPEN — a lock that cannot be taken lets the write proceed,
 * because a missed lock costs at worst the sighting this already loses today, while
 * refusing to record would cost the column outright. It is always released in the
 * `finally`, including on a throw.
 *
 * ⛔ IT IS `pg_try_advisory_lock`, NOT `pg_advisory_lock`, AND THAT IS THE WHOLE DESIGN —
 * the blocking form was shipped in ba2c583a and the re-audit of 2026-09-03 measured what
 * it costs. `src/longterm/db.js` opens the Long-Term pool with `max: 5` and a 10-second
 * connect timeout, and `settingsStore.get`/`save` borrow from THAT SAME POOL. A blocking
 * waiter holds one of the five for as long as it waits, so five concurrent calls leave
 * the lock HOLDER unable to get a connection for its own read — it waits out the whole
 * connect timeout and its sighting is lost, with the lock held throughout. MEASURED, at
 * a faithful simulation of that pool: 5 concurrent calls, 2,128 ms elapsed, one call
 * back with `{ok:false}` and its sighting gone. The lock added to stop a lost sighting
 * was losing them, and taking the rest of Long-Term's pool with it. "Two officers
 * pricing at once" is the case it was written for.
 *
 * SO A WAITER NEVER HOLDS A CONNECTION. The client is released the instant the lock is
 * refused, and the retry takes a fresh one — the same non-blocking shape
 * `pricing/snapshot.js` and `lib/track-record/self-search.js` already chose. At most ONE
 * caller holds a lock connection at a time, whatever the concurrency, so four of the
 * five are always free for the work itself. The retry budget (${LOCK_TRIES} tries about
 * ${LOCK_WAIT_MS} ms apart) is an order of magnitude under the connect timeout on
 * purpose: it is long enough to serialise the overlapping presses this exists for, and
 * short enough that exhausting it costs a fraction of a second rather than ten.
 */
/** Bounded, and deliberately far below `connectionTimeoutMillis` — see the note above. */
const LOCK_TRIES = 6;
const LOCK_WAIT_MS = 25;
/* ⛔ A REF'D TIMER, DELIBERATELY. The unref'd habit is for a background tick that must
   never hold a process open (the keep-warm lesson); this one is a step INSIDE a request
   that is being awaited, so unref'ing it lets the process exit mid-operation and leaves
   the await hanging — which is exactly what happened the first time this was written. It
   is bounded at a few tens of milliseconds, so it can hold nothing open meaningfully. */
const napFor = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Take the register's write lock, or answer null having released everything.
 *
 * ⛔ NEVER RETURNS WHILE HOLDING A CLIENT IT DID NOT GET THE LOCK ON. That single
 * property is what makes the pool starvation above impossible, so it is asserted
 * directly rather than left to reading.
 */
async function takeLock(key, deps = {}) {
  const getClient = deps.getClient || (() => require('../db').getClient());
  const nap = deps.nap || napFor;
  for (let i = 0; i < LOCK_TRIES; i += 1) {
    let conn = null;
    try {
      conn = await getClient();
      const got = await conn.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [key]);
      if (got && got.rows && got.rows[0] && got.rows[0].ok === true) return conn;
      try { conn.release(); } catch (_) { /* releasing is best-effort */ }
    } catch (_) {
      if (conn) { try { conn.release(); } catch (_e) { /* releasing is best-effort */ } }
      return null;                         // a pool or database hiccup — fail open at once
    }
    if (i < LOCK_TRIES - 1) await nap(LOCK_WAIT_MS);
  }
  return null;                             // busy for the whole budget — fail open
}
async function recordSightings(observed, opts = {}) {
  const at = opts.at || new Date().toISOString();
  const lockKey = 'lt-sightings:company';
  const lockConn = await takeLock(lockKey, opts._lockDeps);
  try {
    const stored = await settingsStore.get(KEYS.sightings, 'company');
    let next = stored;
    for (const source of sightings.SOURCES) {
      const o = observed && observed[source];
      if (!o || o.answered === false) continue;
      /* `counts` decides whether this board COUNTS AS A SEARCH — see the note on
         `sightings.record`. A door that knows another is following on the same press
         records what it saw without counting the press twice. */
      next = sightings.record(next, {
        source, keys: o.keys || [], at, answered: true, counts: opts.counts !== false,
      });
    }
    if (next === stored) return { ok: true, wrote: false };
    await settingsStore.save({ [KEYS.sightings]: next }, {
      scope: 'company', staffId: opts.staffId || null,
    });
    return { ok: true, wrote: true };
  } catch (e) {
    return { ok: false, wrote: false, problem: reasonOf(e) };
  } finally {
    if (lockConn) {
      try { await lockConn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } catch (_) { /* the lock dies with the session anyway */ }
      try { lockConn.release(); } catch (_) { /* releasing is best-effort */ }
    }
  }
}

module.exports = {
  KEYS, investorsRaw, holdbackRaw, linksRaw, customRaw, sightingsRaw, recordSightings,
  _internals: { reasonOf, takeLock, LOCK_TRIES, LOCK_WAIT_MS },
};
