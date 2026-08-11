'use strict';
/**
 * AMC (AppraisalScope / NAN) party resolution — who goes in which of THEIR slots.
 *
 * THE ONE RULE THAT MATTERS (owner-directed 2026-08-07, confirmed against the live
 * NAN tenant): **their "Loan Officer" is our NOTE BUYER, not our loan officer.**
 * NAN's tenant uses that slot for capital-partner routing — their list literally
 * reads "Investor Blue Lake", "Investor Fidelis", "Investor CorrFirst". The owner:
 * "Our note buyer in our system needs to be mapped to the loan officer in their
 * system. They consider loan officers as node buyers. This is the way they are set up."
 *
 * So `applications.lender` fills their LoanOfficer slot. OUR employee loan officer is
 * kept on our own order row for the audit trail and is NEVER sent as their loan
 * officer — putting the wrong party there routes the appraisal, and its invoice, to
 * the wrong capital partner.
 *
 * REFUSE, NEVER GUESS. A note buyer with no confirmed binding returns `unmapped`
 * and the order is blocked with a plain reason. There is deliberately no fallback,
 * no nearest-match and no "first row wins": every alternative to refusing sends a
 * real appraisal to a real third party under someone else's name. EMCAP, Temple View
 * and Churchill are note buyers in PILOT with NO row on the live tenant — those files
 * are refused until a human adds the binding, and that is the correct behaviour.
 *
 * MATCHING IS EXACT, ON AN ENUMERATED ALIAS LIST — the same discipline the data-tape
 * export gate uses (`tapes/buyer-rule`). `normNoteBuyer` stays the repo's EXACT
 * normalizer (lowercase + strip non-alphanumerics); a real vendor spelling that
 * differs from ours gets a row in `amc_party_map`, never a loosened matcher. A fuzzy
 * match here would let "Blue Lake Capital Partners" route as "Blue Lake".
 *
 * IDS ARE PER ENVIRONMENT. Their ids differ between UAT and production, so every
 * lookup is scoped to the environment the service is pointed at and a row from the
 * other environment can never be returned.
 *
 * PURE where it can be: `noteBuyerKey`/`personKey`/`pickBinding` take plain data and
 * are unit-tested with no database (scripts/test-amc-party-map-pure.js).
 */

const { normNoteBuyer } = require('../lib/conditions/field-registry');

// A person's compare key: lowercase, strip everything but a-z0-9. Same shape as
// normNoteBuyer so both kinds of row in amc_party_map are keyed identically.
function personKey(raw) {
  return String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// The note buyer's compare key — delegates to the repo's ONE definition so this
// module and the conditions engine can never disagree about which buyer a file has.
function noteBuyerKey(raw) {
  return normNoteBuyer(raw) || '';
}

/**
 * Choose the binding for a key from a set of candidate rows. PURE.
 * Refuses on: no key, no rows, and — deliberately — on MORE than one active row,
 * because two bindings for one buyer means somebody's data is wrong and picking
 * either could route the order to the wrong partner.
 *
 * @param key   normalized pilot key
 * @param rows  [{ pilot_key, amc_id, amc_name, active }]
 * @returns { amcId, amcName } | { unmapped: true, reason }
 */
function pickBinding(key, rows) {
  if (!key) return { unmapped: true, reason: 'no_value' };
  const hits = (Array.isArray(rows) ? rows : []).filter((r) => r && r.active !== false && r.pilot_key === key);
  if (!hits.length) return { unmapped: true, reason: 'not_mapped' };
  // Several rows may legitimately be ALIASES of one id (that is how the vendor's
  // longer label is bound); that is not ambiguity. Two DIFFERENT ids is.
  const ids = [...new Set(hits.map((h) => String(h.amc_id)))];
  if (ids.length > 1) return { unmapped: true, reason: 'ambiguous' };
  return { amcId: ids[0], amcName: hits[0].amc_name || null };
}

// Plain-language refusal, so the desk can show it without inventing wording.
function explain(kind, value, reason) {
  const what = kind === 'note_buyer' ? 'note buyer' : 'processor';
  if (reason === 'no_value') {
    return kind === 'note_buyer'
      ? 'This file has no note buyer yet. The appraisal company routes the order by note buyer, so set it on the file first.'
      : 'This file has no processor assigned yet.';
  }
  if (reason === 'ambiguous') {
    return `The ${what} "${value}" is mapped to more than one entry at the appraisal company. An admin needs to fix the mapping before this can be ordered.`;
  }
  return `The ${what} "${value}" has no confirmed entry at the appraisal company. An admin needs to add the mapping before this can be ordered.`;
}

// ---- DB reads -------------------------------------------------------------
// Both never throw: a read failure is reported as unmapped with a distinct reason,
// so a database hiccup blocks the order (safe) instead of sending a blank slot.

async function loadRows(db, kind, environment) {
  const r = await db.query(
    `SELECT pilot_key, amc_id, amc_name, active
       FROM amc_party_map
      WHERE kind = $1 AND environment = $2 AND active`,
    [kind, environment || 'production']);
  return r.rows || [];
}

/**
 * Their LoanOfficer slot <- our note buyer.
 * @returns { amcId, amcName, pilotValue } | { unmapped:true, reason, message, pilotValue }
 */
async function resolveNoteBuyer(db, noteBuyer, environment) {
  const key = noteBuyerKey(noteBuyer);
  let rows;
  try { rows = await loadRows(db, 'note_buyer', environment); }
  catch (_) { return { unmapped: true, reason: 'lookup_failed', pilotValue: noteBuyer || null,
    message: 'Could not read the note-buyer mapping. Try again in a moment.' }; }
  const got = pickBinding(key, rows);
  if (got.unmapped) return { ...got, pilotValue: noteBuyer || null, message: explain('note_buyer', noteBuyer || '', got.reason) };
  return { ...got, pilotValue: noteBuyer || null };
}

/**
 * Their Processor slot <- our processor. Bound by staff id where the mapping
 * pins one, else by the person's name.
 */
async function resolveProcessor(db, { staffId, fullName } = {}, environment) {
  let rows;
  try {
    const r = await db.query(
      `SELECT pilot_key, amc_id, amc_name, active, staff_id
         FROM amc_party_map
        WHERE kind = 'processor' AND environment = $1 AND active`,
      [environment || 'production']);
    rows = r.rows || [];
  } catch (_) {
    return { unmapped: true, reason: 'lookup_failed', pilotValue: fullName || null,
      message: 'Could not read the processor mapping. Try again in a moment.' };
  }
  // A row pinned to this exact staff member wins over a name match — a rename on
  // either side must not silently unbind a processor somebody confirmed.
  if (staffId) {
    const pinned = rows.filter((r) => r.staff_id === staffId);
    const ids = [...new Set(pinned.map((p) => String(p.amc_id)))];
    if (ids.length === 1) return { amcId: ids[0], amcName: pinned[0].amc_name || null, pilotValue: fullName || null };
    if (ids.length > 1) return { unmapped: true, reason: 'ambiguous', pilotValue: fullName || null,
      message: explain('processor', fullName || '', 'ambiguous') };
  }
  const got = pickBinding(personKey(fullName), rows);
  if (got.unmapped) return { ...got, pilotValue: fullName || null, message: explain('processor', fullName || '', got.reason) };
  return { ...got, pilotValue: fullName || null };
}

module.exports = {
  personKey, noteBuyerKey, pickBinding, explain,
  resolveNoteBuyer, resolveProcessor,
};
