'use strict';
/**
 * src/lib/purchase-advice-diagnosis.js — "which field are you actually looking at?"
 *
 * WHY THIS EXISTS. Owner-reported 2026-08-21, after a file with a purchase advice date received
 * the "No purchase advice 64 days after funding" email: *"Please do research to see if you're
 * looking at the correct field … Please give me the field that you have."*
 *
 * THE ANSWER MUST COME FROM THE TENANT'S OWN DATA, NOT FROM OUR OWN NOTES. Restating the number
 * somebody typed into the configuration back at them proves nothing — it is the same number that
 * produced the wrong answer. `encompass_field_catalog` (db/245) caches the tenant's OWN Encompass
 * field metadata (their custom fields and their standard fields, key + label + the raw object), so
 * this asks THAT: what does your Encompass call the field we are reading, and does your Encompass
 * have any OTHER field whose name mentions a purchase advice?
 *
 * It also reports what the last read of that field actually DID across the funded book
 * (db/608 `purchase_advice_read_state`), because "the id is right" and "the reads are working" are
 * two different questions and only the second one explains a false chase.
 *
 * READ-ONLY, in every sense: it reads two PILOT tables and never calls Encompass at all. Never
 * throws — a diagnosis that breaks the screen it is diagnosing is worse than no diagnosis.
 */

// The pool is required LAZILY, exactly like every other module here that carries a pure half: the
// wording rules below must be loadable — and unit-testable — with no database in reach, and a
// top-level require would print a FATAL and open a pool just to ask what a sentence should say.
const _db = () => require('../db');

/** Words that mean "this field is about a purchase advice", in the tenant's own labels. */
const PA_WORDS = [
  'purchase advice',
  'purchaseadvice',
  'purchase_advice',
  'pa date',
  'padate',
];

/** Does this catalogue row's own text mention a purchase advice? Pure. */
function mentionsPurchaseAdvice(row) {
  if (!row) return false;
  // The RAW object is searched too, deliberately: Encompass returns a field's description on
  // several different keys depending on which settings resource it came from, and a label we
  // happened not to map would otherwise hide the very field we are hunting for.
  let raw = '';
  try { raw = JSON.stringify(row.raw || {}); } catch (_) { raw = ''; }
  const hay = `${row.key || ''} ${row.label || ''} ${raw}`.toLowerCase();
  return PA_WORDS.some((w) => hay.includes(w));
}

/**
 * What field is PILOT reading, what does the tenant call it, and what else looks like it?
 *
 * Returns { fieldId, configuredBy, known, knownLabel, candidates[], catalogFresh, catalogPulledAt }.
 * `known:false` with a populated catalogue is the interesting state — it says the id we ask for is
 * not one the tenant's own field list carries, which is exactly how `client.readFields` ends up
 * dropping it (it splits its batch on an invalid-field 400 and merges what SUCCEEDED, so an id the
 * tenant does not permit goes MISSING from the answer rather than raising).
 */
async function fieldDiagnosis(dbc = null) {
  dbc = dbc || _db();
  const out = {
    fieldId: null, configuredBy: null, known: null, knownLabel: null,
    candidates: [], catalogRows: 0, catalogPulledAt: null,
  };
  try {
    const FM = require('./integrations/encompass-field-map');
    out.fieldId = FM.PA_DATE_FIELD_ID ? String(FM.PA_DATE_FIELD_ID) : null;
    out.configuredBy = Object.prototype.hasOwnProperty.call(process.env, 'ENCOMPASS_PA_DATE_FIELD_ID')
      ? 'ENCOMPASS_PA_DATE_FIELD_ID' : 'built-in default';
  } catch (_) { /* leave null */ }

  try {
    const rows = (await dbc.query(
      `SELECT kind, key, label, raw, pulled_at
         FROM encompass_field_catalog
        WHERE kind IN ('customField','standardField')`)).rows;
    out.catalogRows = rows.length;
    for (const r of rows) {
      if (r.pulled_at && (!out.catalogPulledAt || new Date(r.pulled_at) > new Date(out.catalogPulledAt))) {
        out.catalogPulledAt = r.pulled_at;
      }
    }
    if (out.fieldId) {
      const mine = rows.find((r) => String(r.key || '').toLowerCase() === out.fieldId.toLowerCase());
      // NULL, not false, when the catalogue is empty: "your field list has never been pulled" is a
      // different answer from "your field list does not contain this id", and reporting the second
      // when we mean the first would send somebody hunting for a field that is perfectly fine.
      out.known = out.catalogRows ? !!mine : null;
      out.knownLabel = mine ? (mine.label || null) : null;
    }
    out.candidates = rows
      .filter(mentionsPurchaseAdvice)
      .map((r) => ({ kind: r.kind, key: r.key, label: r.label || null }))
      .sort((a, b) => String(a.key).localeCompare(String(b.key)))
      .slice(0, 25);
  } catch (_) { /* the catalogue may not exist yet — leave the shape */ }
  return out;
}

/**
 * What did the last read of that field actually DO, across the funded book? (db/608.)
 *
 * `never_asked` is counted separately from every stated verdict because it is the state the owner's
 * false chase came out of: the file had not been asked, and the chase read the empty column as an
 * answer. Every count is over LIVE funded files only — the population the chase itself runs on.
 */
async function readStateCounts(dbc = null) {
  dbc = dbc || _db();
  const out = { funded: 0, value: 0, blank: 0, not_returned: 0, no_field_id: 0, no_loan_link: 0, never_asked: 0, oldestUnasked: null };
  try {
    const r = (await dbc.query(
      `SELECT COUNT(*)::int AS funded,
              COUNT(*) FILTER (WHERE purchase_advice_read_state = 'value')::int        AS value,
              COUNT(*) FILTER (WHERE purchase_advice_read_state = 'blank')::int        AS blank,
              COUNT(*) FILTER (WHERE purchase_advice_read_state = 'not_returned')::int AS not_returned,
              COUNT(*) FILTER (WHERE purchase_advice_read_state = 'no_field_id')::int  AS no_field_id,
              COUNT(*) FILTER (WHERE purchase_advice_read_state = 'no_loan_link')::int AS no_loan_link,
              COUNT(*) FILTER (WHERE purchase_advice_read_at IS NULL)::int             AS never_asked,
              MIN(funded_date) FILTER (WHERE purchase_advice_read_at IS NULL)          AS oldest_unasked
         FROM applications
        WHERE deleted_at IS NULL AND status = 'funded'`)).rows[0] || {};
    out.funded = Number(r.funded || 0);
    out.value = Number(r.value || 0);
    out.blank = Number(r.blank || 0);
    out.not_returned = Number(r.not_returned || 0);
    out.no_field_id = Number(r.no_field_id || 0);
    out.no_loan_link = Number(r.no_loan_link || 0);
    out.never_asked = Number(r.never_asked || 0);
    out.oldestUnasked = r.oldest_unasked || null;
  } catch (_) { /* the columns may not exist yet — leave the zeroes */ }
  return out;
}

/** Both halves plus the plain-language summary the screen and the alert both print. */
async function diagnose(dbc = null) {
  dbc = dbc || _db();
  const field = await fieldDiagnosis(dbc);
  const reads = await readStateCounts(dbc);
  return { field, reads, summary: summarize(field, reads) };
}

/**
 * The plain-language answer to "what is the system doing wrong?" — PURE, so every branch is
 * unit-testable and the screen, the email and a future surface all say the same sentence.
 *
 * The order is the order somebody would want to be told: the field is off entirely, then the id
 * looks wrong, then the reads are failing, then the book has not been asked yet, then all clear.
 */
function summarize(field, reads) {
  const f = field || {};
  const r = reads || {};
  if (!f.fieldId) {
    return 'PILOT is not reading a purchase advice field at all on this deployment, so no file can ever show one. Set the field id to switch it back on.';
  }
  const id = `field ${f.fieldId}`;
  if (f.known === false) {
    const alt = (f.candidates || []).map((c) => c.key).slice(0, 3).join(', ');
    return `PILOT asks Encompass for ${id}, and your Encompass field list does not contain it — so Encompass drops it from the answer and PILOT never learns the date.${alt ? ` Your Encompass does have: ${alt}.` : ''}`;
  }
  if (r.not_returned > 0) {
    return `PILOT asks Encompass for ${id}, and on ${r.not_returned} funded ${r.not_returned === 1 ? 'file' : 'files'} Encompass answered without it — usually a permission on that field. Those files cannot be judged either way.`;
  }
  if (r.never_asked > 0) {
    return `PILOT asks Encompass for ${id}. ${r.never_asked} funded ${r.never_asked === 1 ? 'file has' : 'files have'} not been asked yet, so nothing is known about ${r.never_asked === 1 ? 'it' : 'them'} either way — they are being worked through now.`;
  }
  if (r.no_loan_link > 0 && r.value === 0 && r.blank === 0) {
    return `PILOT asks Encompass for ${id}, but it holds no Encompass loan for any funded file, so it has nothing to ask about.`;
  }
  return `PILOT asks Encompass for ${id}${f.knownLabel ? ` ("${f.knownLabel}")` : ''} and is reading it on every funded file: ${r.value} with a date, ${r.blank} empty.`;
}

module.exports = { diagnose, fieldDiagnosis, readStateCounts, summarize, mentionsPurchaseAdvice, PA_WORDS };
