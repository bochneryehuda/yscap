'use strict';
/**
 * LONG-TERM — THE CLIENT'S VIEW OF A LOAN, BUILT *FOR* THE CLIENT.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE HARD RULE (owner-directed 2026-08-14, in his own words):
 *
 *   "You also need to make sure that you put a hard rule to block the investor
 *    name. The client should not be able to see the investor name. Never ever!
 *    Not borrowers, not TPOs, only internal staff."
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS MODULE EXISTS. `audience.js` states the rule and provides the two
 * defences the rule names — (a) DON'T SEND IT (`maySeeField`, `stripInternalOnly`)
 * and (b) SCRUB FREE TEXT (`scrubInvestorNames`). Until now only (b) was wired,
 * on one route, by hand: the first defence was defined, exported, documented as
 * "the ONE definition" by three other modules, and called by NOTHING. A guard
 * nothing calls is a comment.
 *
 * This is where the first defence lives on the client side. Every long-term
 * surface that answers a borrower or a broker builds its loan rows HERE, so
 * "what may a client see about a loan?" has ONE answer and a second surface
 * cannot quietly grow a different one.
 *
 * IT NEVER RE-IMPLEMENTS THE CHECK. Every decision below is delegated to
 * `audience.js` — `maySeeField` for a value that comes from an Encompass field,
 * `internalOnlyColumns` for a value that comes from one of our own columns,
 * `scrubInvestorNames` for free text, `stripInternalOnly` as the belt on the way
 * out. A second copy of the rule is how the two drift, and the one that drifts is
 * the one that leaks.
 *
 * THE PAYLOAD IS AN ALLOWLIST, NOT A FILTERED INTERNAL OBJECT. `CLIENT_LOAN_FIELDS`
 * is the whole list of what a client is told about a loan; a column nobody put on
 * that list is not sent because it was never assembled, not because something
 * removed it afterwards. That is the difference between building a payload for the
 * client and scrubbing one built for staff, and it is the reason each entry
 * DECLARES its source: add a field sourced from `CX.WHICHINVESTOR`, `VEND.X276`,
 * `CX.TABLEFUNDER` or any of the internal-only columns and the guard drops it for a
 * client on the spot — while internal staff still see it.
 *
 * PURE: no database, no network, no Encompass. Rows in, client payload out.
 */

const audience = require('./audience');
const productTerm = require('./product-term');
const stages = require('./stages');

/** What a client sees where the file has no number yet. */
const NOT_NUMBERED = '(not numbered yet)';

/**
 * EVERYTHING a client may be told about one long-term loan.
 *
 * Each entry declares:
 *   key      — the name on the payload.
 *   fieldId  — the ENCOMPASS field the value comes from, where it has one, so
 *              `maySeeField` can answer for it. Null where the value has no single
 *              Encompass field behind it (the milestone name, our own stage
 *              wording, the sync stamp, the derived product) — those are judged by
 *              their COLUMN instead, and by the fact that they are on this list at
 *              all.
 *   column    — the column on OUR side, so `internalOnlyColumns()` can answer for
 *              it. Null for a value we derive rather than store.
 *   text      — free text a human may have typed, so it goes through the scrub.
 *   value     — how the value is read off the row.
 *
 * FIELD IDS ARE FROM THE TENANT'S OWN DICTIONARY (encompass/dictionary/
 * field-dictionary.json, 772 loans, 2026-08-14): 364 "Trans Details Loan #",
 * 1109 "Trans Details Loan Amt", 4 "Trans Details Term (Mos)", 1401 "Trans Details
 * Loan Program". They are recorded here rather than guessed at.
 */
const CLIENT_LOAN_FIELDS = [
  {
    // THE LOAN NUMBER IS DELIBERATELY NOT SCRUBBED, and this is a recorded
    // decision rather than an oversight. It is an identifier the LOS assigns —
    // not free text a human typed — and it is how the client names their own
    // file on the phone. Scrubbing it would rewrite a real identifier the moment
    // one happened to contain a short investor code as a standalone token
    // ("AD-1234", "ARC-2024"), and withholding it would blank the one thing the
    // screen exists to identify. This is the field whose treatment was left as
    // production has always had it; the question — can a long-term loan number
    // ever carry text somebody typed? — is the owner's to answer.
    key: 'file',
    fieldId: '364',
    column: 'lt_loans.loan_number',
    text: false,
    value: ({ row }) => row.loan_number || NOT_NUMBERED,
  },
  {
    // The tenant's OWN consumer wording for the milestone, falling back to our
    // stage's label. Free text the tenant typed into Encompass, so it is scrubbed.
    key: 'status',
    fieldId: null,
    column: 'lt_encompass_milestones.consumer_status',
    text: true,
    value: ({ consumer, ourStage }) => consumer || (ourStage && ourStage.label) || null,
  },
  {
    key: 'milestone',
    fieldId: null,
    column: 'lt_loans.milestone_name',
    text: true,
    value: ({ row }) => row.milestone_name,
  },
  {
    key: 'loanAmount',
    fieldId: '1109',
    column: 'lt_loans.loan_amount',
    text: false,
    value: ({ row }) => (row.loan_amount == null ? null : Number(row.loan_amount)),
  },
  {
    key: 'termMonths',
    fieldId: '4',
    column: 'lt_loans.term_months',
    text: false,
    value: ({ verdict }) => verdict.termMonths,
  },
  {
    // A long-term program name is ordinarily descriptive ("Investor DSCR 30 YEAR
    // FRM") — and it is free text a human typed, which makes it the one field on
    // this payload an investor's name has actually ridden along in.
    key: 'programName',
    fieldId: '1401',
    column: 'lt_loans.program_name',
    text: true,
    value: ({ verdict }) => verdict.programName,
  },
  {
    // Which product this file is — long-term or short-term. Derived from the
    // program and the term by the ONE rule, and says nothing about an investor.
    key: 'product',
    fieldId: null,
    column: null,
    text: false,
    value: ({ verdict }) => verdict.product,
  },
  {
    key: 'updatedAt',
    fieldId: null,
    column: 'lt_loans.encompass_synced_at',
    text: false,
    value: ({ row }) => row.encompass_synced_at || null,
  },
];

/** Case-insensitive membership in the internal-only column list. ONE source. */
function isInternalColumn(column) {
  if (!column) return false;
  const c = String(column).toLowerCase();
  return audience.internalOnlyColumns().some((k) => String(k).toLowerCase() === c);
}

/**
 * May this audience be told this field at all?
 *
 * BOTH questions are asked, because a value can arrive from either side: an
 * Encompass field id (`maySeeField`) and one of our own columns
 * (`internalOnlyColumns`). Both answers come from `audience.js`.
 */
function mayInclude(field, aud) {
  if (field.fieldId && !audience.maySeeField(aud, field.fieldId)) return false;
  if (audience.isClient(aud) && isInternalColumn(field.column)) return false;
  return true;
}

/**
 * Which fields this audience is NOT told, and why — for a test, and for an
 * internal diagnostic. It is deliberately NOT sent to the client: telling a
 * borrower "we withheld the investor's loan number" tells them there is one.
 */
function withheldFields(aud, fields = CLIENT_LOAN_FIELDS) {
  return fields
    .filter((f) => !mayInclude(f, aud))
    .map((f) => ({ key: f.key, fieldId: f.fieldId || null, column: f.column || null }));
}

/** Free text on its way to this audience. Never throws; null stays null. */
function scrubText(v, aud) {
  return v == null ? null : audience.scrubInvestorNames(String(v), aud);
}

/**
 * Build ONE loan the way this audience is allowed to see it.
 *
 * The order is the order the rule names:
 *   (a) DON'T SEND IT — a field this audience may not be told is never assembled.
 *   (b) SCRUB FREE TEXT — what is assembled goes through the redactor.
 *   then the BELT — `stripInternalOnly` over the finished object, so a key that
 *   is internal by NAME cannot ride out even if somebody adds it to the list
 *   above without declaring a source.
 *
 * An INTERNAL audience is handed everything, untouched — that is the same rule.
 * A guard that hides the investor from our own desk is a different bug.
 *
 * @param {object} row — one joined lt_loans row.
 * @param {{stageCfg?: object}} ctx — our stage list, for the fallback wording.
 * @param {string} aud — an audience from `audience.AUDIENCES`. Anything else is a
 *                       client, because `audience.js` fails closed.
 * @param {Array} fields — the field list; overridable so a test can prove the
 *                       guard bites on a field sourced from an investor field.
 */
function buildLoanView(row, ctx = {}, aud = audience.AUDIENCES.BORROWER, fields = CLIENT_LOAN_FIELDS) {
  const r = row || {};
  const verdict = productTerm.classifyProduct({
    programName: r.program_name, termMonths: r.term_months,
  });
  const consumer = stages.consumerStatusOf({ consumer_status: r.consumer_status });
  const ourStage = (((ctx && ctx.stageCfg) || {}).stages || []).find((s) => s.key === r.stage_key);
  const bag = { row: r, verdict, consumer, ourStage };

  const out = {};
  for (const f of fields) {
    if (!mayInclude(f, aud)) continue;
    const raw = f.value(bag);
    out[f.key] = f.text ? scrubText(raw, aud) : raw;
  }
  return audience.stripInternalOnly(out, aud);
}

/**
 * Refuse, at load time, a query that reads an internal-only column on a client
 * surface.
 *
 * The first defence is "don't select the column". This is what makes that a
 * PROPERTY of the code rather than a habit: the SQL is a constant, so this either
 * always throws or never does — a join that brings `lt_loan_investors` onto a
 * client route cannot reach a running server, and cannot reach a green test run.
 *
 * It is deliberately loud. A leak guard that logs and continues is a leak.
 */
function assertNoInternalColumns(sql, where = 'a client query') {
  const text = String(sql || '');
  const lower = text.toLowerCase();
  const hits = [];
  for (const qualified of audience.internalOnlyColumns()) {
    const [table, column] = String(qualified).split('.');
    if (column && new RegExp(`(^|[^a-z0-9_])${column.toLowerCase()}([^a-z0-9_]|$)`).test(lower)) {
      hits.push(qualified);
    } else if (table && new RegExp(`(^|[^a-z0-9_])${table.toLowerCase()}([^a-z0-9_]|$)`).test(lower)) {
      hits.push(qualified);
    }
  }
  if (hits.length) {
    throw new Error(
      `${where} reads an internal-only column a client may never be told: ${[...new Set(hits)].join(', ')}. `
      + 'The investor never reaches a borrower or a TPO (audience.js) — build the client payload without it.',
    );
  }
  return true;
}

module.exports = {
  CLIENT_LOAN_FIELDS,
  NOT_NUMBERED,
  buildLoanView,
  withheldFields,
  assertNoInternalColumns,
  _internals: { mayInclude, isInternalColumn, scrubText },
};
