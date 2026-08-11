'use strict';
/**
 * PREVIOUS FILES — restore the USPS stamps the bounce bug wiped.
 *
 * Owner-reported 2026-08-02: "you can import it no matter how many times you want,
 * it bounces back and reverses the USPS address verification." db/379's trigger
 * wiped the whole stamp whenever `property_address` changed at all, and the ClickUp
 * pull rewrote that column with Google's spelling of the SAME address on every
 * reconcile of the card — so the import was undone within minutes, forever. The
 * go-forward fix is two-part (the inbound guard in clickup/ingest.js and the
 * semantic trigger in db/415); this is the repair for the files it already hit.
 *
 * WHAT THIS DOES NOT DO. It never makes the import DECISION — that is a human's,
 * by design, and the whole point of the enforced condition. It only re-asserts a
 * decision a human ALREADY made and that this bug erased, and only where all three
 * of these are provable:
 *
 *   1. THE HUMAN IMPORTED. The file carries its own `usps_verified_address_imported`
 *      audit row, written by the import route. That row also names the staffer, so
 *      the restored sign-off is attributed to the person who really made it.
 *   2. THE PROPERTY DID NOT MOVE. The USPS answer being restored must be the SAME
 *      PLACE as the address the file names today (`address.sameAddress` — the one
 *      definition, conservative: anything it cannot read on both sides is false).
 *      A file whose address genuinely changed since is left for a human.
 *   3. USPS ALREADY SAID SO. The answer comes from `usps_address_verifications`,
 *      the cache of lookups we have already paid for — `cacheOnly`, so this pass
 *      NEVER calls USPS and cannot touch the hourly quota. A cache miss simply
 *      skips the file; one more verify-and-import by hand fixes it, and now sticks.
 *
 * Bounded per boot, idempotent, and it never throws — a repair failure must not
 * stop the service booting.
 *
 * IT IS *NOT* SELF-DRAINING, AND THAT IS WHY IT PAGES FROM A DURABLE CURSOR
 * (owner-reported 2026-08-09). A restored file stops matching, but a candidate
 * this pass CANNOT restore stays a candidate forever — no cached USPS answer
 * (much the commonest), an address we cannot read, or a property that genuinely
 * changed. Selection was `ORDER BY a.id LIMIT 50` with no cursor, and `a.id` is
 * a uuid, so the same arbitrary fifty files were re-read on every single boot:
 * once fifty unrestorable files happened to sort first, every real file behind
 * them was starved PERMANENTLY and no amount of re-running could reach it. The
 * pass reported a healthy-looking `{restored: 0, skipped: {not_cached: 50}}`
 * while doing nothing, which is exactly why it went unnoticed.
 *
 * THE CLASS, worth recognising elsewhere: a bounded catch-up sweep whose
 * selection is a stable ORDER BY with no cursor and no per-row "checked" stamp
 * makes NO progress as soon as its first page is full of rows it cannot settle.
 * "Self-draining" is only true when every row a pass reads either changes or
 * leaves the set.
 *
 * A per-row `checked_at` stamp was the alternative and is the WRONG one here:
 * nearly every skip is retryable later (a cache miss becomes a cache hit the
 * moment somebody verifies that address by hand), so stamping would either
 * strand those files or need a TTL — which is a cursor with more state and more
 * ways to be wrong. Paging visits every candidate in turn and passes over the
 * unrestorable ones, which is precisely what was missing.
 */
const ADDR = require('./address');
const uspsVerify = require('./usps-verify');
const { componentsOf } = require('./address-usps-verify');

/** How many files one PAGE may examine. */
const PER_BOOT = 50;
/** How many pages one boot walks. Bounded work, real forward progress. */
const PAGES_PER_BOOT = 4;
/** Durable page cursor — the whole point of this module's paging. */
const CURSOR_KEY = 'usps_stamp_heal_cursor';

/** Only a USPS answer good enough to have been importable in the first place. */
const IMPORTABLE = new Set(['verified', 'corrected']);

/** Read the durable page cursor. A missing/unreadable cursor starts at the top. */
async function readCursor(db) {
  try {
    const r = (await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [CURSOR_KEY])).rows[0];
    const c = r && r.value && r.value.cursor;
    return c ? String(c) : null;
  } catch (_) { return null; }
}

/** Best-effort cursor write — a failed write only costs a repeated page. */
async function writeCursor(db, cursor) {
  try {
    await db.query(
      `INSERT INTO sync_runtime_state (key, value) VALUES ($1,$2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CURSOR_KEY, JSON.stringify({ cursor, at: new Date().toISOString() })]);
  } catch (_) { /* best effort */ }
}

/**
 * ONE bounded PAGE, resuming from the durable cursor.
 *
 * Returns { candidates, restored, skipped:{...}, wrapped, cursor } — never throws.
 * `wrapped` is true when this page reached the end of the candidate list and the
 * cursor was reset to the top, so a caller that wants a guaranteed FULL sweep can
 * loop until it sees one (that is the only way to be sure every candidate was
 * examined, since a page starts wherever the last one stopped).
 *
 * `fromStart` forces this page to begin at the top, ignoring the stored cursor.
 */
async function restoreBouncedUspsStampsOnce({ limit, fromStart = false } = {}) {
  const out = { candidates: 0, restored: 0, skipped: { unreadable: 0, not_cached: 0, not_importable: 0, different_place: 0, write_failed: 0 }, wrapped: false, cursor: null };
  const db = require('../db');
  const cap = Math.max(1, Number(limit || PER_BOOT));

  const cursor = fromStart ? null : await readCursor(db);

  let rows;
  try {
    // The audit row is what proves a human imported. `DISTINCT ON` keeps the most
    // recent import per file, so the actor credited is the one who last decided.
    //
    // The cursor predicate is APPENDED rather than written as
    // `($2::uuid IS NULL OR a.id > $2)` — that shape is a planner trap once the
    // plan goes generic (the same rule the research search engine follows).
    const params = [cap];
    let cursorSql = '';
    if (cursor) { params.push(cursor); cursorSql = `AND a.id > $${params.length}::uuid`; }
    rows = (await db.query(
      `SELECT DISTINCT ON (a.id) a.id, a.property_address, al.actor_id
         FROM applications a
         JOIN audit_log al
           ON al.entity_type='application' AND al.entity_id=a.id
          AND al.action='usps_verified_address_imported'
        WHERE a.deleted_at IS NULL
          AND a.usps_imported_at IS NULL
          AND a.property_address IS NOT NULL
          AND a.status NOT IN ('withdrawn','cancelled','declined')
          ${cursorSql}
        ORDER BY a.id, al.created_at DESC
        LIMIT $1`, params)).rows;
  } catch (_) { return out; }   // a fresh DB mid-migration is not an error

  // A short page means the end of the list: reset to the top so the next boot
  // starts over and re-examines the ones it could not settle (a cache miss today
  // is a cache hit the moment somebody verifies that address by hand).
  if (rows.length < cap) { out.wrapped = true; await writeCursor(db, null); }
  else { out.cursor = String(rows[rows.length - 1].id); await writeCursor(db, out.cursor); }

  for (const r of rows) {
    out.candidates++;
    const comp = componentsOf(r.property_address);
    if (!comp || !comp.line1 || !comp.state) { out.skipped.unreadable++; continue; }

    let res;
    try { res = await uspsVerify.standardize(comp, { db, cacheOnly: true }); }
    catch (_) { res = null; }
    if (!res || res.status === 'not_cached') { out.skipped.not_cached++; continue; }
    if (!IMPORTABLE.has(res.status) || !res.address) { out.skipped.not_importable++; continue; }

    // The cached answer must be about the property the file names TODAY.
    if (!ADDR.sameAddress(res.address, r.property_address)) { out.skipped.different_place++; continue; }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Re-read under the row lock: another process (or a human doing it by hand)
      // may have restored this file since the candidate list was built.
      const cur = (await client.query(
        `SELECT usps_imported_at FROM applications WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [r.id])).rows[0];
      if (!cur || cur.usps_imported_at) { await client.query('ROLLBACK'); continue; }
      // property_address moves to the USPS spelling in the SAME statement that sets
      // usps_imported_at — db/379's own escape hatch for the deliberate import, so
      // the trigger reads this as the adoption it is and not as an edit.
      await client.query(
        `UPDATE applications
            SET usps_address=$2::jsonb, usps_match=$3, usps_dpv=$4::jsonb,
                usps_verified_at=now(), usps_imported_at=now(),
                property_address=$2::jsonb, updated_at=now()
          WHERE id=$1`,
        [r.id, JSON.stringify(res.address), res.status, res.dpv ? JSON.stringify(res.dpv) : null]);
      // The condition was signed off by a human before the wipe; restore it to the
      // person who actually did it (the audit row's actor), never to "system".
      await client.query(
        `UPDATE checklist_items ci
            SET status='satisfied', signed_off_by=$2, signed_off_at=now(),
                reviewed_by=$2, reviewed_at=now(), waived_by=NULL, waived_at=NULL,
                updated_at=now()
           FROM checklist_templates t
          WHERE ci.application_id=$1 AND ci.template_id=t.id
            AND t.code='usps_address_verification'
            AND ci.status <> 'satisfied'`, [r.id, r.actor_id || null]);
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('system', NULL, 'usps_stamp_restored', 'application', $1, $2)`,
        [r.id, JSON.stringify({
          reason: 'the imported USPS address was cleared by a re-spelling of the same address (db/415)',
          status: res.status, address: res.address.oneLine || null, importedBy: r.actor_id || null,
        })]);
      await client.query('COMMIT');
      out.restored++;
    } catch (_) {
      try { await client.query('ROLLBACK'); } catch (_e) {}
      out.skipped.write_failed++;
    } finally { client.release(); }
  }
  return out;
}

/**
 * Walk up to `pages` pages from wherever the cursor stands, stopping early when a
 * page wraps (the list has been fully walked). Bounded, never throws.
 */
async function restoreBouncedUspsStampsPass({ limit, pages = PAGES_PER_BOOT, fromStart = false } = {}) {
  const tot = { candidates: 0, restored: 0, skipped: { unreadable: 0, not_cached: 0, not_importable: 0, different_place: 0, write_failed: 0 }, pages: 0, wrapped: false };
  const max = Math.max(1, Number(pages) || 1);
  for (let i = 0; i < max; i++) {
    const p = await restoreBouncedUspsStampsOnce({ limit, fromStart: fromStart && i === 0 });
    tot.pages++;
    tot.candidates += p.candidates;
    tot.restored += p.restored;
    for (const k of Object.keys(tot.skipped)) tot.skipped[k] += (p.skipped && p.skipped[k]) || 0;
    if (p.wrapped) { tot.wrapped = true; break; }
  }
  return tot;
}

/** Boot entry point. Runs once, a minute after start (let the migrations settle). */
function startUspsStampHeal() {
  if (String(process.env.USPS_STAMP_HEAL_DISABLED || '') === '1') return;
  setTimeout(async () => {
    try {
      const r = await restoreBouncedUspsStampsPass();
      if (r.restored) console.log('[usps] restored %d address stamp(s) cleared by the re-spelling bug', r.restored);
    } catch (_) { /* never blocks boot */ }
  }, 60 * 1000).unref?.();
}

module.exports = {
  restoreBouncedUspsStampsOnce, restoreBouncedUspsStampsPass, startUspsStampHeal,
  PER_BOOT, PAGES_PER_BOOT, CURSOR_KEY,
};
