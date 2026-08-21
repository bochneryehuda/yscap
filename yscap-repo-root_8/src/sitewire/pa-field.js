'use strict';

/**
 * READING THE PURCHASE ADVICE FIELD — the two reasons PILOT could not, and the fix for each.
 *
 * Owner-directed 2026-08-21: *"Why do you say that you're going to make alerts if you can't read
 * the field? I want you to fix the bug so that you should be able to reach and read the field. The
 * field is there. The main bug is why you can't read the field, not why you're firing."*
 *
 * The owner is right, and the alert was the wrong half to build. `db/608` recorded WHAT the last
 * read did, which stopped a false chase — but it left two states permanently unreadable, and both
 * of them are ordinary:
 *
 *   `no_loan_link`   PILOT holds no Encompass loan GUID for the file, so there is nothing to ask
 *                    about. The sweep read only files that already had one CACHED, deliberately —
 *                    a pipeline search is the expensive path. But a funded file that has never
 *                    been through the per-file pull has no cached GUID and never will get one from
 *                    the sweep, so it could sit unreadable forever.
 *   `not_returned`   the read ran and the id was not in the answer. `readFields` splits its id
 *                    list on an invalid-field 400 and merges what SUCCEEDED, so an id this tenant
 *                    does not expose goes MISSING rather than raising — and PILOT then reported
 *                    "we cannot tell" about a loan whose purchase advice is sitting in Encompass
 *                    under a field id nobody told us about.
 *
 * SO THIS MODULE DOES THE TWO THINGS THAT MAKE THE FIELD READABLE:
 *
 *  1. `ensureLoanGuid` finds the loan by its loan NUMBER (one pipeline search) and caches the GUID
 *     on the file, exactly as the per-file pull does — so the next read, and every read after it,
 *     is the cheap by-number one.
 *  2. `paFieldCandidates` asks the TENANT'S OWN cached field catalogue (`encompass_field_catalog`,
 *     db/245) which fields are named for a purchase advice, and offers them AFTER the configured
 *     id. That is what "make sure it's looking at the correct field" means in practice: not
 *     restating the number we already have — which is the number that produced the wrong answer —
 *     but asking Encompass what it calls the thing and trying that.
 *
 * WHAT IT WILL NOT DO. It never GUESSES a value: a candidate only counts when Encompass RETURNS
 * that id, and the id that answered is recorded on the file (`purchase_advice_field_id`) so
 * "which field did this verdict come from?" stays answerable years later. It never writes to
 * Encompass — every call here is a read, through the frozen read-only client. And it never
 * throws: it rides a best-effort sweep.
 */

/* A field is a purchase-advice candidate when the TENANT's own name for it says so. Both spellings
   appear in the wild ("purchase advice", "PA date"), and the words must be adjacent — a field
   merely mentioning "advice" is not this one. */
const PA_NAME_RE = /purchase\s*advice|\bpa\b[\s_-]*date|advice[\s_-]*date/i;

/** How many catalogue candidates to try beyond the configured id. A tenant with a dozen
 *  purchase-advice-ish fields is a configuration problem to report, not a reason to make a
 *  dozen calls per file. */
const MAX_CANDIDATES = 3;

/**
 * The ids worth asking about, configured id FIRST.
 *
 * The configured id leads because it is the one the owner supplied, and because a tenant that
 * answers on it must never have its verdict decided by a look-alike. Everything after it is a
 * fallback used only when the configured id is not in the answer.
 *
 * Returns [] when the catalogue has never been pulled — which is NOT the same as "this tenant has
 * no such field", and the diagnosis surface says so in those words.
 */
async function paFieldCandidates(db, configuredId, { limit = MAX_CANDIDATES } = {}) {
  const out = [];
  const seen = new Set();
  const add = (id) => {
    const s = String(id == null ? '' : id).trim();
    if (!s || seen.has(s)) return;
    seen.add(s); out.push(s);
  };
  add(configuredId);
  try {
    const rows = (await db.query(
      `SELECT field_id, field_name, description FROM encompass_field_catalog
        WHERE field_id IS NOT NULL
        ORDER BY field_id
        LIMIT 5000`)).rows;
    for (const r of rows) {
      if (out.length >= 1 + limit) break;
      const hay = `${r.field_name || ''} ${r.description || ''}`;
      if (PA_NAME_RE.test(hay)) add(r.field_id);
    }
  } catch (_) { /* no catalogue pulled yet — the configured id stands alone */ }
  return out;
}

/**
 * Make sure this file HAS an Encompass loan GUID, finding it by loan number if it does not.
 *
 * Returns the guid, or null when there is nothing to find it by (no loan number) or Encompass
 * cannot be reached. FILL-ONLY: it never overwrites a guid we already hold — that link was
 * established by the per-file pull and a search result must not be allowed to move a file onto a
 * different loan.
 *
 * Never throws.
 */
async function ensureLoanGuid(db, appId, { api, loanNumber = null, existingGuid = null } = {}) {
  if (existingGuid) return existingGuid;
  if (!loanNumber || !api || typeof api.findLoanByLoanNumber !== 'function') return null;
  try {
    const rows = await api.findLoanByLoanNumber(loanNumber);
    if (!Array.isArray(rows) || !rows.length) return null;
    /* EXACTLY ONE MATCH, OR NOTHING. Two loans carrying one loan number is a real state in a
       lender's pipeline (a re-issued file, a duplicate) and picking one of them would attach this
       file's sold status to whichever happened to sort first. */
    if (rows.length > 1) return null;
    const reader = require('../encompass/reader');
    const guid = reader._rowGuid ? reader._rowGuid(rows[0]) : (rows[0] && (rows[0].loanId || rows[0].loanGuid));
    if (!guid) return null;
    await db.query(
      `UPDATE applications SET encompass_loan_guid = $2
        WHERE id = $1 AND encompass_loan_guid IS NULL`, [appId, String(guid)]);
    return String(guid);
  } catch (_) { return null; }
}

/**
 * Read the purchase advice field, trying the configured id and then the tenant's own
 * purchase-advice-named fields.
 *
 * Returns `{ values, fieldId }` where `values` is a map shaped exactly like `readFields`' answer
 * and `fieldId` is the id that ACTUALLY answered — or `{ values: null }` when the read itself
 * failed (a transient outage, which must never be mistaken for an answer about the loan).
 *
 * The candidates after the first are tried ONLY when the one before is absent from the answer.
 * A field that answers BLANK has answered: that is Encompass saying this loan has no purchase
 * advice, which is the one state the chase may fire on, and moving on to a look-alike field would
 * turn a real "not sold yet" into whatever some other field happens to hold.
 */
async function readPaField(api, guid, candidates) {
  let sawRead = false;
  for (const id of (candidates || [])) {
    let vals = null;
    try { vals = await api.readFields(guid, [String(id)]); }
    catch (_) { vals = null; }
    if (!vals || typeof vals !== 'object') continue;      // the read failed — try the next id
    sawRead = true;
    if (Object.prototype.hasOwnProperty.call(vals, String(id))) {
      return { values: vals, fieldId: String(id) };
    }
  }
  // Every id was tried. If at least one read SUCCEEDED but returned nothing we know about, that is
  // a real `not_returned` and the caller stamps it against the configured id.
  return sawRead ? { values: {}, fieldId: candidates && candidates[0] ? String(candidates[0]) : null }
    : { values: null, fieldId: null };
}

module.exports = { paFieldCandidates, ensureLoanGuid, readPaField, PA_NAME_RE, MAX_CANDIDATES };
