'use strict';
/**
 * THE VERIFY BUTTON — read the public records for ONE property, and record what
 * they say.
 *
 * ── NOTHING AUTO-WRITES, AND THAT IS THE POINT ─────────────────────────────
 * This runs on a human's click, for one property at a time. There is no boot
 * sweep and no background pass, deliberately: the vendor's hourly allowance is
 * shared by the whole organization (a batch job that ignores it starves the
 * person on the phone), and a sweep that writes to a borrower's record
 * unattended is the shape this whole rebuild exists to avoid.
 *
 * ── IT WRITES `auto_*` AND NEVER `human_*` ─────────────────────────────────
 * db/494 keeps the machine's observation and the person's answer in two
 * separate sets of columns so they can never collapse. Re-running this NEVER
 * clears somebody's decision: the records changing is new information about the
 * records, not a reason to un-answer a question a human already answered. If the
 * two now disagree, that disagreement is exactly what the reviewer should see.
 *
 * ── AND IT NEVER VERIFIES ANYTHING ─────────────────────────────────────────
 * A run can make every pillar read `proved`; the line still is not verified and
 * still does not count. A person confirms each check and then verifies the line,
 * through the routes that already refuse without sign-off. Nothing here touches
 * `track_records.is_verified`.
 *
 * ── A FAILED LOOKUP IS RECORDED AS A FAILED LOOKUP ─────────────────────────
 * The cache stores an 'error' as `cacheable = false` (db/498, a GENERATED
 * column) precisely so a vendor outage can never be read later as "there is
 * nothing here". `address_canon_cache` learned that lesson twice; this is built
 * with it already applied.
 */

const CHECKS = require('./checks');
const lookups = require('../elementix/lookups');

const str = (v) => String(v == null ? '' : v).trim();

function addressLabel(pa) {
  if (!pa) return '';
  if (typeof pa === 'string') return pa;
  if (typeof pa !== 'object') return '';
  if (pa.oneLine) return String(pa.oneLine);
  return [pa.line1 || pa.street || pa.address, pa.city, pa.state, pa.zip].filter(Boolean).join(', ');
}

/** How long a definitive answer stays fresh before it is worth re-reading. A
 *  recorded deed does not change; a "nothing found" might, because counties
 *  publish late and new construction gets added. */
const FRESH_DAYS_FOUND = 90;
const FRESH_DAYS_EMPTY = 21;

/** The cache key. Includes the entity name and the state because the SAME
 *  address researched under a different company is a different question. */
function queryKey(trackRecordId, entityName, address) {
  return `trv1:${trackRecordId}:${str(entityName).toLowerCase()}:${str(address).toLowerCase()}`.slice(0, 400);
}

/**
 * Run it.
 *
 * @param {string} trackRecordId
 * @param {object} opts  { staffId, force }
 * @returns {{ok, cached, calls, errors, pillars, research}}
 *
 * Never throws — the route shows what came back.
 */
async function runVerify(trackRecordId, opts = {}, client) {
  const db = client || require('../../db');
  const t = (await db.query(
    `SELECT t.id, t.borrower_id, t.property_address, t.deal_type, t.purchase_date,
            t.sale_date, t.rent_date, t.refi_date, t.entity_name, t.llc_id,
            NULLIF(TRIM(COALESCE(b.full_name,'')),'') AS borrower_name,
            l.llc_name
       FROM track_records t
       JOIN borrowers b ON b.id = t.borrower_id
       LEFT JOIN llcs l ON l.id = t.llc_id
      WHERE t.id=$1`, [trackRecordId])).rows[0];
  if (!t) { const e = new Error('not found'); e.status = 404; throw e; }

  const address = addressLabel(t.property_address);
  const entityName = str(t.entity_name) || str(t.llc_name);
  /* THE STATE MAY LIVE INSIDE A STRING. An IMPORTED line's `property_address`
     is a jsonb STRING scalar (the vendor's one-line address), so `.state` read
     undefined and the search went out with NO state filter — `match_entity`
     then returned several rows, the one-or-nothing rule refused to pick, and
     every pillar answered `no_data`. The Verify button was silently weaker on
     exactly the lines the importer created (audit 2026-08-09). Fall back to
     the two-letter state in the one-line form ("…, NJ 08701"). */
  const state = (t.property_address && typeof t.property_address === 'object' && t.property_address.state)
    || ((address.match(/,\s*([A-Za-z]{2})\s*\d{5}(?:-\d{4})?\s*$/) || [])[1] || '');
  const key = queryKey(trackRecordId, entityName, address);

  /* Every name this borrower's entity might be recorded under, plus every name
     the person might be recorded under. Collected here rather than inside the
     checks module so the checks stay pure. */
  const entityNames = [];
  if (entityName) entityNames.push(entityName);
  try {
    const more = await db.query(
      `SELECT llc_name FROM llcs WHERE borrower_id=$1 AND llc_name IS NOT NULL`, [t.borrower_id]);
    for (const r of more.rows) if (str(r.llc_name) && !entityNames.includes(r.llc_name)) entityNames.push(r.llc_name);
  } catch (_) { /* the line's own name is enough to run */ }
  const borrowerNames = t.borrower_name ? [t.borrower_name] : [];

  // A fresh, DEFINITIVE cache entry answers without spending anything.
  let research = null; let cached = false;
  if (!opts.force) {
    try {
      const c = (await db.query(
        `SELECT payload, fetched_at, stale_after FROM elementix_lookup_cache
          WHERE query_key=$1 AND cacheable
            AND (stale_after IS NULL OR stale_after > now())`, [key])).rows[0];
      if (c && c.payload) { research = c.payload; cached = true; }
    } catch (_) { /* a cache miss is just a lookup */ }
  }

  if (!research) {
    research = await lookups.researchProperty({
      entityName, state, address, borrowerNames, staffId: opts.staffId || null, db,
    });
    await cacheResult(db, key, research).catch(() => {});
  }

  // The pure engine decides; this module only feeds and files it.
  const today = new Date().toISOString().slice(0, 10);
  const entityContext = {
    entityNames,
    borrowerNames,
    llcId: t.llc_id || null,
    controlVerdict: await controlVerdictFor(db, t.llc_id, t.borrower_id),
  };
  const results = CHECKS.computeChecks(t, research, entityContext, today);

  const written = [];
  for (const r of results) {
    /* auto_* ONLY. The `human_*` columns are not in this statement and must
       never be — re-reading the county is not a reason to un-answer a question
       a person already answered. */
    const u = await db.query(
      `UPDATE track_record_pillars
          SET auto_verdict=$2, auto_source=$3, auto_confidence=$4, auto_grade=$5,
              auto_evidence=$6::jsonb, auto_checked_at=now(), updated_at=now()
        WHERE track_record_id=$1 AND pillar=$7
        RETURNING id, human_verdict`,
      [trackRecordId, r.auto_verdict, r.auto_source, r.auto_confidence, r.auto_grade,
        JSON.stringify(r.auto_evidence || {}), r.pillar]);
    if (u.rows[0]) {
      written.push({
        pillar: r.pillar, autoVerdict: r.auto_verdict, grade: r.auto_grade,
        // Worth surfacing: the records now say something a person already
        // decided against. That is not an error, it is the thing to look at.
        disagreesWithHuman: !!u.rows[0].human_verdict
          && ((u.rows[0].human_verdict === 'confirmed' && r.auto_verdict === 'contradicted')
            || (u.rows[0].human_verdict === 'rejected' && r.auto_verdict === 'proved')),
      });
    }
  }

  return {
    ok: true,
    cached,
    calls: research.calls || 0,
    errors: research.errors || [],
    searched: research.searched === true,
    ambiguousEntity: research.ambiguousEntity === true,
    tooCommon: research.tooCommon === true,
    pillars: written,
    // What the ladder would make of it, so the screen can show a band without a
    // second round trip. Advisory — nothing is decided by it.
    signals: CHECKS.signalsFor(results, research, entityContext),
  };
}

/**
 * Check A, as a human recorded it: does this borrower control that company?
 * Returns 'confirmed' ONLY when a human verified it; otherwise `null` — which the
 * checks module reads as "no data on the borrower's side", never as a pass and
 * never as a contradiction.
 *
 * IT NEVER RETURNS 'rejected'. `llc_borrowers.ownership_verified` is boolean NOT NULL
 * DEFAULT false (db/495) and its only writer TOGGLES it — verify → true, revoke →
 * false — so a `false` means "not verified" (a link nobody has reviewed yet OR one a
 * reviewer un-confirmed), NOT an active statement that the borrower does not control
 * the company. Reading `false` as 'rejected' made a NEVER-REVIEWED link mark the
 * borrower's property CONTRADICTED (checks.js), which is the exact false-rejection
 * this fixes and which the authoritative track-record-ownership.js already avoids
 * (it treats `!verified` as cleared/neutral, never a contradiction). This boolean
 * cannot express a genuine rejection, so it must never produce one.
 */
async function controlVerdictFor(db, llcId, borrowerId) {
  if (!llcId || !borrowerId) return null;
  try {
    const r = (await db.query(
      `SELECT ownership_verified FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2`,
      [llcId, borrowerId])).rows[0];
    return r && r.ownership_verified === true ? 'confirmed' : null;
  } catch (_) { return null; }
}

/**
 * File the result. An UNSUCCESSFUL run is stored as `status='error'`, which
 * db/498's GENERATED `cacheable` column turns into "not knowledge" — so the next
 * run tries again instead of reading an outage as an answer.
 */
async function cacheResult(db, key, research) {
  const failedOutright = !research.searched && (research.errors || []).length > 0;
  const status = failedOutright ? 'error'
    : (research.ambiguousEntity ? 'ambiguous'
      : (research.deeds.length || research.mortgages.length ? 'found' : 'no_match'));
  const days = status === 'found' ? FRESH_DAYS_FOUND : FRESH_DAYS_EMPTY;
  await db.query(
    `INSERT INTO elementix_lookup_cache (query_key, status, payload, stale_after, api_calls)
     VALUES ($1,$2,$3::jsonb, now() + ($4 || ' days')::interval, $5)
     ON CONFLICT (query_key) DO UPDATE
        SET status=EXCLUDED.status, payload=EXCLUDED.payload,
            stale_after=EXCLUDED.stale_after, api_calls=EXCLUDED.api_calls,
            fetched_at=now()`,
    [key, status, JSON.stringify(research), String(days), research.calls || 0]);
}

module.exports = { runVerify, queryKey, addressLabel, FRESH_DAYS_FOUND, FRESH_DAYS_EMPTY, _internals: { cacheResult, controlVerdictFor } };
