'use strict';

/**
 * Manual Program (owner-directed 2026-07-20).
 *
 * A manual override of the deal STRUCTURE — the acquisition LTV, the after-repair
 * (ARV) LTV, or the loan-to-cost (LTC) — is no longer registered under the
 * Standard or the Gold program. It becomes its own "Manual Program":
 *
 *   • priced on the STANDARD (Fidelis) guideline engine, but carrying the manual
 *     leverage the staffer entered (asset requirements + everything else follow
 *     the Standard program);
 *   • it requires the registrant to state how many months of liquidity/assets the
 *     file must show (there is no fixed reserve table for a manual product — the
 *     admin sets a default, the registrant can raise it);
 *   • it ALWAYS requires the flood certificate (db/207 rule);
 *   • and every manual product goes to the super-admin ESCALATION box for approval
 *     — the file registers immediately, but the product stays "pending super-admin
 *     approval" until decided.
 *
 * Manual PRICING — moving the markup/margin, points, or fees — is NOT a manual
 * product. Only a structural leverage/ARV override flips the program to manual.
 * This module owns the DETECTION (which override keys count), the company-level
 * settings, and the escalation queue.
 */

const db = require('../db');

// The override keys that change the deal STRUCTURE. Engaging ANY of these makes
// the registration a Manual Program. Rate (ovrRatePct), interest-reserve months
// (ovrIrMonths), markup/points/fees and the assignment effective-price exception
// (ovrEffPrice, which has its own admin-approval clamp) are PRICING, not
// structure — they never flip the program to manual.
const STRUCTURAL_OVERRIDE_KEYS = [
  'ovrAcqLTV', 'ovrAcqLTVPct',   // acquisition LTV
  'ovrARLTV', 'ovrARLTVPct',     // after-repair (ARV) LTV
  'ovrLTC', 'ovrLTCPct',         // loan-to-cost
];

// "Engaged" = a truthy flag or a real numeric value — NOT a present-but-empty /
// zero / false key (the studio sends the whole knob set on every register, most
// of them null). Mirrors staff.js `engaged`.
function engaged(v) {
  if (v === true) return true;
  if (v == null || v === '' || v === false) return false;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : String(v).trim() !== '';
}

/** The structural keys that are meaningfully engaged in this override set. */
function structuralOverridesEngaged(overrides) {
  const o = overrides || {};
  return STRUCTURAL_OVERRIDE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(o, k) && engaged(o[k]));
}

/** Is this override set a MANUAL PRODUCT (structural leverage/ARV override)? */
function isManualProduct(overrides) {
  return structuralOverridesEngaged(overrides).length > 0;
}

/**
 * Does a registration require an ADMIN approval before its terms may be
 * CONFIRMED to the borrower? (owner-directed 2026-07-21; widened 2026-07-27.)
 *
 * TRUE for:
 *   • every Manual Program (a structural LTV/LTC/ARV override — program 'manual'),
 *     which is manual by definition and has no min/max but still must be approved;
 *   • ANY Standard/Gold registration the frozen engine returns as MANUAL — i.e.
 *     below the $100,000 program minimum, over the program maximum, or any other
 *     manual-review reason the guideline engine raises; and
 *   • ANY registration that moved a knob in the studio's admin pricing zone away
 *     from the company default — a reduced rate markup, reduced origination
 *     points, a discounted/waived closing fee, an approved effective purchase
 *     price, a manual basis (owner-directed 2026-07-27: "every single time
 *     somebody is changing the defaults … this should be sent to the admin for
 *     approval, no matter if it's reducing the rate, reducing the fee, or manual
 *     programs"). The caller passes the deviations it detected with the shared
 *     pricing-overrides.pricingOverridesEngaged(); `needsApproval` is the already
 *     -resolved boolean form a stored registration row carries.
 *
 * A clean ELIGIBLE Standard/Gold registration priced on the company defaults
 * needs no approval (it confirms to the borrower immediately, as before).
 * Centralized here so both register routes, the e-sign issuance gate and any
 * future caller share ONE definition of "needs sign-off".
 */
function needsSuperAdminApproval({ program, status, pricingOverrides, needsApproval } = {}) {
  if (program === 'manual' || status === 'MANUAL') return true;
  if (needsApproval === true) return true;
  return Array.isArray(pricingOverrides) && pricingOverrides.length > 0;
}

/**
 * The program a registration should be recorded under. A structural override
 * ALWAYS resolves to 'manual', regardless of which card (Standard/Gold) the
 * studio was on — you can't register a structural override under Standard/Gold.
 * A plain markup/fee/rate override keeps the requested program.
 */
function resolveProgram(requestedProgram, overrides) {
  if (isManualProduct(overrides)) return 'manual';
  return requestedProgram === 'gold' ? 'gold' : requestedProgram === 'silver' ? 'silver' : 'standard';
}

// ---------------------------------------------------------------------------
// EXCEPTION STICKINESS (owner-directed 2026-08-05).
//
// An approved exception belongs to the ITEM it was granted for, at the VALUE it
// was granted at — not to the loan as a whole. So a RE-REGISTER that carries the
// SAME approved item(s) at the SAME value(s) must NOT open a fresh approval:
//   · a manual program approved at 90% LTC stays approved at 90% LTC, even if the
//     loan amount changes (as long as it does not go UP — see below);
//   · 1% origination approved stays approved at 1%, even though the dollar amount
//     moves when the loan amount changes;
//   · a 0.2 markup approved stays approved at 0.2, whatever else moves;
//   · re-registering the identical terms needs no new approval at all — even if
//     the ARV or as-is value changed (the frozen engine still enforces every cap;
//     an as-is that came in lower simply sizes a smaller loan, which is guideline
//     enforcement, not an exception).
// A NEW approval IS needed when an approved item's value CHANGES (1% → 0.9%
// origination, 0.2 → 0.1 markup, a different LTC cap), when a NEW exception item
// appears, when a MANUAL-review scenario gains a NEW guideline reason, or — the
// one owner-directed special case — when a MANUAL PROGRAM's loan amount goes UP
// (capital / BP-structure reasons), even at the same LTC.
//
// The comparison is by MEANING, not by key: the studio sends a percent form
// (`ovrLTCPct: 90`) while a re-register replays the fraction the engine takes
// (`ovrLTC: 0.9`), so each item is canonicalised to (its human label, a fraction/
// dollar/count value) before it is compared.
// ---------------------------------------------------------------------------
const { DEFAULTED_OVERRIDE_KEYS, ENGAGED_OVERRIDE_KEYS } = require('./pricing-overrides');
const OVERRIDE_META = Object.assign({}, DEFAULTED_OVERRIDE_KEYS, ENGAGED_OVERRIDE_KEYS);

function sameNum(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) < 0.0001;
}

/** Canonical numeric value for an override, in ONE unit per item so the two key
 *  forms (percent from the studio, fraction from a replay) compare equal. A flag
 *  is 1 when engaged. Returns null when unreadable. */
function canonValue(unit, value) {
  if (unit === 'flag') return value ? 1 : null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return unit === 'pct' ? n / 100 : n;   // frac / money / num stay as-is
}

/** Map(label → canonical value) from a pricingOverridesEngaged() change list
 *  (the CURRENT register). */
function itemsFromChanges(changes) {
  const m = new Map();
  for (const c of (Array.isArray(changes) ? changes : [])) {
    if (!c || !c.label) continue;
    const cv = canonValue(c.unit, c.value);
    if (cv == null) continue;
    if (!m.has(c.label)) m.set(c.label, cv);
  }
  return m;
}

/** Map(label → canonical value) from an escalation's stored slim `overrides` map
 *  (the APPROVED grant: { key: rawValue }). */
function itemsFromSlim(slim) {
  const m = new Map();
  const o = (slim && typeof slim === 'object') ? slim : {};
  for (const key of Object.keys(o)) {
    const meta = OVERRIDE_META[key];
    if (!meta) continue;
    const cv = canonValue(meta.unit, o[key]);
    if (cv == null) continue;
    if (!m.has(meta.label)) m.set(meta.label, cv);
  }
  return m;
}

/**
 * Is the CURRENT register already covered by an APPROVED exception grant?
 * PURE — unit-tested without a DB.
 *
 * @param current { program, status, overrideChanges, loanAmount, manualReasons }
 * @param grant   { program, overrides, loanAmount, manualReasons } | null
 * @returns { covered:boolean, reason:string, uncovered:string[] }
 */
function exceptionCoveredByGrant(current, grant) {
  const cur = current || {};
  if (!grant) return { covered: false, reason: 'no_approved_grant', uncovered: [] };
  const curItems = itemsFromChanges(cur.overrideChanges);
  const grantItems = itemsFromSlim(grant.overrides);
  // Every CURRENT exception item must appear in the grant at the SAME value. Fewer
  // items than the grant is fine (asking for LESS than was approved is never a new
  // exception); a changed value or a brand-new item is not.
  const uncovered = [];
  for (const [label, cval] of curItems) {
    if (!sameNum(grantItems.get(label), cval)) uncovered.push(label);
  }
  if (uncovered.length) return { covered: false, reason: 'item_changed_or_added', uncovered };

  // Owner-directed special case: a MANUAL PROGRAM whose loan amount GOES UP needs a
  // fresh approval even at the same caps (we must confirm the capital for it).
  if (cur.program === 'manual') {
    if (grant.program !== 'manual') return { covered: false, reason: 'grant_not_a_manual_program', uncovered: [] };
    const gLoan = Number(grant.loanAmount);
    const cLoan = Number(cur.loanAmount);
    // A dollar of headroom absorbs floor-rounding; a real increase re-escalates.
    if (Number.isFinite(gLoan) && Number.isFinite(cLoan) && cLoan > gLoan + 1) {
      return { covered: false, reason: 'manual_loan_amount_increased', uncovered: [] };
    }
  }

  // A MANUAL-review scenario is only covered while NO NEW guideline reason has
  // appeared — a fresh manual reason (a cap newly hit as the as-is/ARV moved) is a
  // new exception, and the frozen engine's own INELIGIBLE block still applies above.
  if (cur.status === 'MANUAL') {
    const granted = new Set((grant.manualReasons || []).map((r) => String(r)));
    if ((cur.manualReasons || []).some((r) => !granted.has(String(r)))) {
      return { covered: false, reason: 'new_manual_reason', uncovered: [] };
    }
  }
  return { covered: true, reason: 'covered_by_approved_grant', uncovered: [] };
}

/**
 * The most recent APPROVED escalation for a file, normalised for
 * exceptionCoveredByGrant. Null when the file has never had one approved. An
 * approved grant survives a re-register (openEscalation only supersedes OPEN rows),
 * so it is here to cover a matching re-register.
 */
async function latestApprovedGrant(appId, client = db) {
  const r = await client.query(
    `SELECT overrides, summary FROM manual_program_escalations
      WHERE application_id=$1 AND status='approved'
      ORDER BY decided_at DESC NULLS LAST, created_at DESC LIMIT 1`, [appId]);
  const row = r.rows[0];
  if (!row) return null;
  const overrides = row.overrides || {};
  const summary = row.summary || {};
  return {
    overrides,
    program: summary.program || (isManualProduct(overrides) ? 'manual' : null),
    loanAmount: summary.totalLoan != null ? Number(summary.totalLoan) : null,
    manualReasons: Array.isArray(summary.manualReasons) ? summary.manualReasons : [],
  };
}

// ---------------------------------------------------------------------------
// Company-level Manual Program settings (manual_program_settings, db/207).
// Singleton current row: default liquidity months (REQUIRED) + advisory leverage
// ceilings. Append-only history mirroring company_pricing_settings.
// ---------------------------------------------------------------------------
const SETTINGS_DEFAULTS = Object.freeze({
  maxAcqLtv: null, maxArvLtv: null, maxLtc: null,
  assetMonths: 2, isActive: true,
});

function shapeSettings(row) {
  if (!row) return { ...SETTINGS_DEFAULTS };
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const months = Number(row.asset_months);
  return {
    maxAcqLtv: n(row.max_acq_ltv),
    maxArvLtv: n(row.max_arv_ltv),
    maxLtc: n(row.max_ltc),
    assetMonths: Number.isFinite(months) && months > 0 ? Math.round(months) : SETTINGS_DEFAULTS.assetMonths,
    isActive: row.is_active !== false,
  };
}

async function loadSettings(client = db) {
  try {
    const r = await client.query(
      `SELECT max_acq_ltv, max_arv_ltv, max_ltc, asset_months, is_active
         FROM manual_program_settings WHERE is_current LIMIT 1`);
    return shapeSettings(r.rows[0]);
  } catch (_) { return { ...SETTINGS_DEFAULTS }; }
}

/**
 * Replace the current Manual Program settings (append-only). `by` = staff id.
 * asset_months is REQUIRED and must be a positive integer.
 */
async function saveSettings(patch, by, client = db) {
  const months = Math.round(Number(patch && patch.assetMonths));
  if (!Number.isFinite(months) || months < 1 || months > 24) {
    const err = new Error('Enter how many months of assets/liquidity the Manual Program requires (1–24).');
    err.status = 400; throw err;
  }
  const pctOrNull = (v, label) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) { const e = new Error(`${label} must be between 0 and 100.`); e.status = 400; throw e; }
    return n;
  };
  const cols = {
    max_acq_ltv: pctOrNull(patch.maxAcqLtv, 'Max acquisition LTV'),
    max_arv_ltv: pctOrNull(patch.maxArvLtv, 'Max after-repair LTV'),
    max_ltc: pctOrNull(patch.maxLtc, 'Max loan-to-cost'),
    asset_months: months,
    is_active: patch.isActive !== false,
    note: patch.note ? String(patch.note).slice(0, 300) : null,
  };
  const useClient = client === db ? await db.getClient() : client;
  const ownTx = client === db;
  try {
    if (ownTx) await useClient.query('BEGIN');
    await useClient.query(`UPDATE manual_program_settings SET is_current=false WHERE is_current`);
    const names = Object.keys(cols);
    const vals = Object.values(cols);
    await useClient.query(
      `INSERT INTO manual_program_settings (${names.join(',')}, is_current, updated_by)
       VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')}, true, $${names.length + 1})`,
      [...vals, by || null]);
    if (ownTx) await useClient.query('COMMIT');
  } catch (e) {
    if (ownTx) await useClient.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { if (ownTx) useClient.release(); }
  return loadSettings();
}

// ---------------------------------------------------------------------------
// Escalation queue (manual_program_escalations, db/207). One OPEN (pending) row
// per file — a re-register supersedes the prior pending row so the box never
// shows stale duplicates.
// ---------------------------------------------------------------------------

/**
 * Open a super-admin escalation for a freshly-registered manual product. Any
 * prior PENDING escalation for the same file is declined-as-superseded first so
 * the partial-unique index (one pending per app) holds. Runs inside the caller's
 * transaction client. Returns the new escalation id.
 */
async function openEscalation(client, { appId, registrationId, assetMonths, overrides, pricingOverrides, summary, requestedBy }) {
  // Supersede any OPEN escalation on the file — a plain pending row OR a
  // countered row awaiting the loan officer's action. The re-register replaces
  // both; the queue never shows a stale prior counter.
  await client.query(
    `UPDATE manual_program_escalations
        SET status='declined', decided_at=now(), updated_at=now(),
            decision_note=COALESCE(decision_note,'Superseded by a newer manual registration')
      WHERE application_id=$1 AND status IN ('pending','countered')`, [appId]);
  // Record the numbers the approver is being asked to bless: the structural
  // leverage keys (a Manual Program) AND every admin-zone knob moved off the
  // company default (owner-directed 2026-07-27) — a reduced rate, a discounted
  // fee, an approved effective price. The accept-counter path replays this blob
  // as its override base, so it must stay a plain key→value map.
  const structural = structuralOverridesEngaged(overrides);
  const slim = {};
  for (const k of structural) slim[k] = overrides[k];
  for (const c of (Array.isArray(pricingOverrides) ? pricingOverrides : [])) {
    if (c && c.key && !(c.key in slim) && overrides && c.key in overrides) slim[c.key] = overrides[c.key];
  }
  const ins = await client.query(
    `INSERT INTO manual_program_escalations
       (application_id, registration_id, status, asset_months, overrides, summary, requested_by)
     VALUES ($1,$2,'pending',$3,$4,$5,$6) RETURNING id`,
    [appId, registrationId || null, assetMonths != null ? Math.round(Number(assetMonths)) : null,
     JSON.stringify(slim), summary ? JSON.stringify(summary) : null, requestedBy || null]);
  return ins.rows[0].id;
}

/**
 * Close (decline-as-superseded) any PENDING escalation for a file — used when a
 * file is re-registered as a NON-manual product, so the super-admin box never
 * keeps showing a pending manual approval for a file that is no longer manual.
 * Runs on the caller's client (inside the register transaction). Returns the
 * number of rows closed.
 */
async function closePendingForApp(client, appId, note) {
  // Close any OPEN escalation (plain pending OR a countered one waiting on the
  // loan officer) — the file was re-registered as a non-manual product, so
  // neither state is relevant anymore.
  const r = await client.query(
    `UPDATE manual_program_escalations
        SET status='declined', decided_at=now(), updated_at=now(),
            decision_note=COALESCE(decision_note,$2)
      WHERE application_id=$1 AND status IN ('pending','countered')`,
    [appId, note || 'Superseded — the file was re-registered as a non-manual product']);
  return r.rowCount || 0;
}

/** The current OPEN escalation for a file (pending or countered), or null. */
async function pendingForApp(appId, client = db) {
  const r = await client.query(
    `SELECT * FROM manual_program_escalations WHERE application_id=$1 AND status IN ('pending','countered')
      ORDER BY created_at DESC LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

/**
 * List escalations for the super-admin box. status filters:
 *   'open'      — pending + countered (the default queue view: everything still needing action)
 *   'pending'   — just plain pending (no counter proposed)
 *   'countered' — just countered (waiting on the loan officer to act on a counter)
 *   'approved' | 'declined' — terminal states
 *   'all'       — everything
 */
async function listEscalations({ status = 'open', limit = 100 } = {}, client = db) {
  let where = '';
  let params = [];
  if (status === 'open') { where = `WHERE e.status IN ('pending','countered')`; }
  else if (status && status !== 'all') { where = `WHERE e.status = $1`; params = [status]; }
  const r = await client.query(
    `SELECT e.*,
            a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
            b.first_name, b.last_name,
            rq.full_name AS requested_by_name, dc.full_name AS decided_by_name
       FROM manual_program_escalations e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
       ${where}
      ORDER BY e.created_at DESC
      LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`, params);
  return r.rows;
}

/** Count of OPEN escalations (pending + countered) — for the nav badge. A
 *  countered escalation is still open work: the loan officer still has to act on
 *  the counter (accept the countered terms or re-request with different numbers).
 */
async function pendingCount(client = db) {
  try {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM manual_program_escalations WHERE status IN ('pending','countered')`);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (_) { return 0; }
}

/** Approve/decline an escalation. decision: 'approved'|'declined'. A countered
 *  escalation may also be approved/declined outright by the super-admin (they
 *  can decide without waiting for the loan officer to act on the counter).
 *  Returns the row, or null if it was already decided / no longer exists.
 */
/* AN APPROVAL RELEASES THE HOLD ON THE REGISTRATION IT WAS GRANTED FOR
   (owner-reported 2026-08-07: "if the appraisal comes in and you re-register, and
   then the admin approves, you should not need another re-register").

   ROOT CAUSE. `product_registrations.needs_approval` (db/343) is written ONCE, at
   INSERT, and from then on only READ — `esign/gate.js` blocks the term sheet on it.
   Approving the escalation marked the REQUEST approved and never touched that
   stamp, so the gate went on saying "waiting for approval" after the approval had
   been granted. The only way to obtain a registration without the stamp was to make
   a NEW one — and on that one the grant IS recognised (exceptionCoveredByGrant), so
   it sails through. That is the pointless extra re-register the owner hit, forced
   entirely by a flag with no writer.

   THE RELEASE IS NOT UNCONDITIONAL — it asks the SAME question a re-register asks.
   `exceptionCoveredByGrant` is the one definition of "this grant covers these
   terms", so approving cannot clear a hold on terms the approval does not actually
   cover (an officer who re-registered at 0.9% while 1.0% sat pending must still be
   approved for 0.9%). Because it is the same predicate the register door uses,
   approve-then-re-register and re-register-then-approve now settle identically —
   which is the owner's whole point about order not mattering.

   FAILS CLOSED, AND NEVER REVERSES THE DECISION. Anything unreadable leaves the
   stamp in place, which is exactly today's behaviour (the officer re-registers);
   and the whole release is best-effort, because an approval a super-admin has
   granted must never be rolled back by a bookkeeping write. */
async function releaseApprovalHold(escalation, client = db) {
  const appId = escalation && escalation.application_id;
  if (!appId) return { released: false, reason: 'no_application' };
  const cur = (await client.query(
    `SELECT id, program, status, total_loan, override_changes, is_manual
       FROM product_registrations
      WHERE application_id=$1 AND is_current AND COALESCE(needs_approval,false)
      LIMIT 1`, [appId])).rows[0];
  if (!cur) return { released: false, reason: 'nothing_on_hold' };
  const grant = await latestApprovedGrant(appId, client);
  if (!grant) return { released: false, reason: 'no_grant' };
  const cov = exceptionCoveredByGrant({
    program: cur.program,
    status: cur.status,
    overrideChanges: Array.isArray(cur.override_changes) ? cur.override_changes : [],
    loanAmount: cur.total_loan != null ? Number(cur.total_loan) : null,
    // The registration does not store the guideline reasons that made it MANUAL, so
    // they come from the grant itself: this escalation was opened FOR these terms,
    // and a re-register that gained a NEW reason would have opened its own row and
    // superseded this one. Passing the grant's own reasons therefore asks "are the
    // reasons still the approved ones?" — never "assume there are none".
    manualReasons: grant.manualReasons,
  }, grant);
  if (!cov.covered) return { released: false, reason: cov.reason || 'not_covered' };
  await client.query(
    `UPDATE product_registrations SET needs_approval=false
      WHERE id=$1 AND COALESCE(needs_approval,false)`, [cur.id]);
  return { released: true, registrationId: cur.id, reason: cov.reason || 'covered' };
}

async function decideEscalation(id, decision, staffId, note, client = db) {
  const status = decision === 'approved' ? 'approved' : 'declined';
  const r = await client.query(
    `UPDATE manual_program_escalations
        SET status=$2, decided_by=$3, decided_at=now(),
            decision_note=$4, updated_at=now()
      WHERE id=$1 AND status IN ('pending','countered')
      RETURNING *`,
    [id, status, staffId || null, note ? String(note).slice(0, 500) : null]);
  const row = r.rows[0] || null;
  // Only an APPROVAL releases a hold. A decline must leave it exactly where it is.
  if (row && status === 'approved') {
    try { row.holdRelease = await releaseApprovalHold(row, client); }
    catch (e) { row.holdRelease = { released: false, reason: 'error' };
      console.warn('[manual-program] approval hold release failed:', db.describeError ? db.describeError(e) : e.message); }
  }
  return row;
}

/** Counter-offer an escalation (owner-directed 2026-07-21). Instead of a plain
 *  approve/decline, the super-admin proposes the terms they WOULD accept. The
 *  escalation stays open (status='countered'), the loan team is notified with
 *  the counter, and the file waits for the loan officer to re-register with
 *  the countered terms — which supersedes this row via openEscalation() —
 *  or to re-request the exception with different numbers.
 *
 *  counterTerms — small JSON blob of the modified overrides the super-admin
 *                 would approve (e.g. { maxLtc:0.92, noteRatePts:0.5 }).
 *  counterNote  — plain-language explanation the loan officer + borrower read.
 *
 *  Returns the updated row, or null if it was already decided / no longer OPEN.
 */
async function counterEscalation(id, staffId, { counterTerms, counterNote }, client = db) {
  const terms = counterTerms && typeof counterTerms === 'object' ? counterTerms : {};
  const r = await client.query(
    `UPDATE manual_program_escalations
        SET status='countered',
            counter_terms=$2::jsonb,
            counter_note=$3,
            countered_by=$4,
            countered_at=now(),
            updated_at=now()
      WHERE id=$1 AND status IN ('pending','countered')
      RETURNING *`,
    [id, JSON.stringify(terms), counterNote ? String(counterNote).slice(0, 1000) : null, staffId || null]);
  return r.rows[0] || null;
}

module.exports = {
  STRUCTURAL_OVERRIDE_KEYS, engaged, structuralOverridesEngaged, isManualProduct, needsSuperAdminApproval, resolveProgram,
  exceptionCoveredByGrant, latestApprovedGrant,
  SETTINGS_DEFAULTS, loadSettings, saveSettings,
  openEscalation, closePendingForApp, pendingForApp, listEscalations, pendingCount, decideEscalation, counterEscalation,
  releaseApprovalHold,
  // exported for tests
  _internals: { itemsFromChanges, itemsFromSlim, canonValue },
};
