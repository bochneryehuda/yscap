'use strict';
/**
 * LONG-TERM — THE PURCHASED STEP. Ours, not Encompass's.
 *
 * Owner-directed 2026-08-23: *"the purchase is a new milestone, and yes, you can
 * build this up."*
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE ONE STEP IN THE LADDER THAT IS NOT POSITIONAL.
 *
 * Every other step is marked reached because the loan is standing PAST it: the
 * stepper finds the milestone Encompass says the loan is at and everything before
 * it has necessarily been passed (`workspace.milestoneStepper`). That inference is
 * sound for a workflow step, and it is FALSE for this one. Encompass's late steps —
 * Investor Delivery, Purchasing Conditions, Final Docs — are about the WORK around
 * a sale, not the sale. A loan sitting at Final Docs has certainly passed Purchasing
 * Conditions; it has NOT certainly been bought. Marking it purchased because of
 * where it stands would be a confident wrong answer about the one fact this step
 * exists to state, on the files that matter most.
 *
 * So this step is reached from EVIDENCE: Encompass's own sell-side investor status
 * (field 2031), a READ-ONLY dropdown whose values are Unassigned / Assigned - Bulk /
 * Assigned - Flow / Shipped / Purchased / Rejected. Measured over the 772-loan
 * census (2026-08-14): filled on 100% of loans at Investor Delivery, Purchasing
 * Conditions and Final Docs, and reading "Purchased" on 187 of the 188 loans that
 * carry it at all.
 *
 * AND IT NEVER GUESSES. Three answers, not two:
 *   true  — the field says one of the purchased values.
 *   false — the field says something else. It has NOT been bought.
 *   null  — the field is not there. We do not know, and nothing may pretend we do.
 * A `null` renders as "not yet", never as "no" — the step is simply not marked, and
 * `describePurchase` says in plain words which of the three it is.
 *
 * THE DATE IS ENCOMPASS'S, NOT OURS. Field 2370, the Purchase Advice Date, carries
 * the day the investor actually bought it (filled on 175 of the 490 long-term loans
 * — the same population as the status, 176). That is why this step does NOT ride
 * `lt_milestone_events`: every row in that table is dated `observed_at`, meaning the
 * day PILOT NOTICED, and mixing a real Encompass date into it would break the
 * promise its whole header is built on. The purchase keeps its own two columns on
 * the loan and the stepper is handed the date directly.
 *
 * A STEP CLEARS WHEN ITS EVIDENCE GOES. A status corrected away from Purchased in
 * Encompass must not leave "Purchased" standing here — a `false` reading clears the
 * stamp. An ABSENT reading changes nothing, because an absent reading is not
 * evidence of anything.
 *
 * NOTHING HERE IS HARD-CODED. The name, where it sits, both field ids, the values
 * that count and the borrower's wording are all settings (`milestones.purchased*`),
 * so a buyer whose Encompass records the sale somewhere else changes it without a
 * release.
 *
 * SEPARATION: reads and writes only `lt_*`, and reads Encompass through the caller's
 * already-fetched loan payload — it opens nothing and calls nothing.
 */

/** The id this step carries wherever a catalog row needs one. Never an Encompass id. */
const PILOT_MILESTONE_ID = 'pilot:purchased';

/** The measured JSON paths for the two fields, used when a caller has no numbered read. */
const STATUS_PATH = ['rateLock', 'sellSideInvestorStatus'];
const DATE_PATH = ['rateLock', 'date'];

const text = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s || null;
};

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Is this already a resolved config, or is it the raw settings map?
 *
 * Every entry point takes either, so a caller never has to remember which — and
 * this is the ONE test that tells them apart. Guessing from a single key would let
 * a settings map that happens to carry one of these names be used as a config.
 */
const isConfig = (c) => !!(c && Array.isArray(c.purchasedValues) && c.name && c.after
  && c.statusFieldId && c.dateFieldId);

/** The tenant's own answers, with ours as the defaults. PURE. */
function configFrom(settings = {}) {
  const s = settings || {};
  const values = Array.isArray(s['milestones.purchasedStatusValues'])
    && s['milestones.purchasedStatusValues'].length
    ? s['milestones.purchasedStatusValues'].map(norm).filter(Boolean)
    : ['purchased'];
  return {
    name: text(s['milestones.purchasedName']) || 'Purchased',
    after: text(s['milestones.purchasedAfter']) || 'Purchasing Conditions',
    statusFieldId: text(s['milestones.purchasedStatusFieldId']) || '2031',
    dateFieldId: text(s['milestones.purchaseAdviceDateFieldId']) || '2370',
    purchasedValues: values,
    consumerStatus: text(s['milestones.purchasedConsumerStatus']) || 'Funded',
  };
}

/** Walk a path on a payload without throwing on a missing branch. */
function at(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * A value read BY NUMBER always wins over a path.
 *
 * The same field number sits at a DIFFERENT JSON path from loan to loan — the
 * lesson the RTL side paid for twice — so when a caller has already read the
 * numbered value we take it and never look at the path. Nothing asks the
 * fieldReader for these two ids on our account: the long-term client does not split
 * a failed batch, so one unpermitted id would blank the whole team and lock read for
 * every loan (`sync/loans.js` says the same about the term and the program). The
 * paths below are the ones the 772-loan census actually recorded these fields at.
 */
function byNumber(fieldValues, id) {
  if (!fieldValues || id == null) return undefined;
  const k = String(id);
  return fieldValues[k] != null ? fieldValues[k] : fieldValues[Number(k)];
}

/**
 * A date-only string, or null. Never a guess: a value Postgres could not read as a
 * date is dropped rather than stored, because a wrong purchase date is worse on
 * every screen than an absent one.
 */
function dayOf(v) {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * What this loan payload says about the sale. PURE — no database, no clock, no call.
 *
 * Returns `{ purchased, status, at }` where `purchased` is true / false / null and
 * `status` is Encompass's own word, verbatim, so a screen can show what it actually
 * said rather than our reading of it.
 */
function readPurchase(loan, cfg) {
  const c = isConfig(cfg) ? cfg : configFrom(cfg || {});
  const fv = (loan && loan._fieldValues) || null;

  const rawStatus = byNumber(fv, c.statusFieldId) !== undefined
    ? byNumber(fv, c.statusFieldId)
    : at(loan, STATUS_PATH);
  const status = text(rawStatus);

  const rawDate = byNumber(fv, c.dateFieldId) !== undefined
    ? byNumber(fv, c.dateFieldId)
    : at(loan, DATE_PATH);

  if (status === null) {
    // Not read. NOT "no" — and deliberately no date either: a date with no status
    // behind it would be a purchase we cannot show the evidence for.
    return { purchased: null, status: null, at: null };
  }
  const purchased = c.purchasedValues.includes(norm(status));
  return { purchased, status, at: purchased ? dayOf(rawDate) : null };
}

/**
 * The stored state of the sale on a loan row, in plain words.
 *
 * The row carries the STATUS Encompass gave and the DATE; whether that counts as
 * purchased is decided HERE, from the same settings the reader used, so the fact is
 * never denormalised into a boolean that can drift from the word beside it.
 */
function describePurchase(loan, cfg) {
  const c = isConfig(cfg) ? cfg : configFrom(cfg || {});
  const l = loan || {};
  const status = text(l.purchased_status);
  const at = l.purchased_at ? String(l.purchased_at).slice(0, 10) : null;

  if (status === null) {
    return {
      purchased: null,
      status: null,
      at: null,
      note: 'Encompass has not said what the investor has done with this loan yet.',
    };
  }
  const purchased = c.purchasedValues.includes(norm(status));
  return {
    purchased,
    status,
    at: purchased ? at : null,
    note: purchased
      ? (at
        ? `The investor bought this loan on ${at}.`
        : 'The investor has bought this loan. Encompass records no purchase advice date, so the day is not known.')
      // Encompass's own word, quoted, because "not purchased" covers four different
      // states (unassigned, assigned, shipped, rejected) and they are not the same news.
      : `Not bought yet — Encompass has this loan as "${status}".`,
  };
}

/**
 * Splice our step into the tenant's ladder. PURE.
 *
 * `catalog` is the shape the stepper takes — `{ name, sort_order, expected_days }`
 * rows in order. Ours is added straight after the milestone the settings name.
 *
 * A TENANT THAT HAS NO SUCH MILESTONE STILL GETS THE STEP, at the END. Dropping it
 * would mean a buyer who renames one Encompass milestone silently loses the ability
 * to see that their loans were sold — a whole fact vanishing off a screen because a
 * word did not match. Appending is visibly odd and recoverable; disappearing is not.
 *
 * The step carries `pilot: true`, which is what tells the stepper never to mark it
 * from a position, and `expected_days: null`, because there is no expectation to be
 * over: a loan waits on its buyer, not on us.
 */
function insertInto(catalog, cfg) {
  const c = isConfig(cfg) ? cfg : configFrom(cfg || {});
  const rows = (catalog || []).slice();
  const step = {
    name: c.name,
    pilot: true,
    milestoneId: PILOT_MILESTONE_ID,
    consumerStatus: c.consumerStatus,
    expected_days: null,
    sort_order: null,
  };
  // Already there (a caller that merged twice) — never a second copy.
  if (rows.some((r) => r && (r.milestoneId === PILOT_MILESTONE_ID || norm(r.name) === norm(c.name)))) {
    return rows;
  }
  const i = rows.findIndex((r) => r && norm(r.name) === norm(c.after));
  if (i < 0) rows.push(step);
  else rows.splice(i + 1, 0, step);
  // Re-seat every row so `sort_order` still describes the list a reader sees. The
  // catalog's own numbering is Encompass's and is left alone in the database; this
  // is the ORDER OF THIS LIST, computed each time it is built, so the two can never
  // disagree about where our step sits.
  return rows.map((r, n) => ({ ...r, sort_order: n + 1 }));
}

module.exports = {
  PILOT_MILESTONE_ID,
  configFrom,
  readPurchase,
  describePurchase,
  insertInto,
  _internals: { dayOf, byNumber, at, norm, isConfig, STATUS_PATH, DATE_PATH },
};
