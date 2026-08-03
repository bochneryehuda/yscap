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
 * Bounded per boot, self-draining (a restored file stops matching), idempotent, and
 * it never throws — a repair failure must not stop the service booting.
 */
const ADDR = require('./address');
const uspsVerify = require('./usps-verify');
const { componentsOf } = require('./address-usps-verify');

/** How many files one pass may repair. Small on purpose: it is pure catch-up work
    and the set drains a little on every deploy. */
const PER_BOOT = 50;

/** Only a USPS answer good enough to have been importable in the first place. */
const IMPORTABLE = new Set(['verified', 'corrected']);

/**
 * One bounded pass. Returns { candidates, restored, skipped:{...} } — never throws.
 */
async function restoreBouncedUspsStampsOnce({ limit } = {}) {
  const out = { candidates: 0, restored: 0, skipped: { unreadable: 0, not_cached: 0, not_importable: 0, different_place: 0, write_failed: 0 } };
  const db = require('../db');
  const cap = Math.max(1, Number(limit || PER_BOOT));

  let rows;
  try {
    // The audit row is what proves a human imported. `DISTINCT ON` keeps the most
    // recent import per file, so the actor credited is the one who last decided.
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
        ORDER BY a.id, al.created_at DESC
        LIMIT $1`, [cap])).rows;
  } catch (_) { return out; }   // a fresh DB mid-migration is not an error

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

/** Boot entry point. Runs once, a minute after start (let the migrations settle). */
function startUspsStampHeal() {
  setTimeout(async () => {
    try {
      const r = await restoreBouncedUspsStampsOnce();
      if (r.restored) console.log('[usps] restored %d address stamp(s) cleared by the re-spelling bug', r.restored);
    } catch (_) { /* never blocks boot */ }
  }, 60 * 1000).unref?.();
}

module.exports = { restoreBouncedUspsStampsOnce, startUspsStampHeal, PER_BOOT };
