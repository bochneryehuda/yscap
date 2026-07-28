'use strict';

/**
 * CLOSING WORKFLOW — business logic for the closer's desk (owner-directed 2026-07-26).
 *
 * Sits ON TOP of the existing workflow scaffold (src/lib/workflow.js + db/212):
 * the closer role, closer_id pointer, and closing_workflow stage machine already
 * exist. This module owns the closer's WORKING surface — the actual cash-to-close
 * money gate, the 3-system funded-date reconciliation gate, the warehouse list,
 * the closing document conditions, the checklists, and the aggregate workspace
 * payload the Closing screen renders.
 *
 * Hard rules honored: no frozen pricing number is re-derived (reserves + verified
 * liquidity are reused as computed); Encompass is READ-ONLY (funded date is pulled
 * via the read-only field map only); dates are 'YYYY-MM-DD' calendar strings.
 */

const db = require('../db');

// The warehouse lines the loan can fund off. App-level so adding one later is a
// one-line change, not a migration (owner: "later we're going to add another").
// TABLE_FUNDING is a warehouse line like any other on this list, but it carries
// meaning downstream (owner-directed 2026-07-26): a loan funded on it was SOLD
// AT CLOSING, so it must never enter the purchasing workflow — there is nothing
// left to sell. Setting it is what marks a file table funded; everything else on
// this list sends the file to purchasing at the investor-delivery sign-off.
const TABLE_FUNDING = 'Table Funding';
const WAREHOUSES = [
  'Stride Bank',
  'Bank of the Sierra',
  'Banc of California',
  'Northpointe',
  'Fidelis',
  'CorrFirst',
  TABLE_FUNDING,
];

// ---------------------------------------------------------------------------
// IS THIS CLOSING RETIRED FROM THE DESK? One definition, shared by the desk
// queue, the nav badge and (mirrored) the screen — they must never disagree.
//
// A closing leaves the desk once it is FINISHED — reconciled AND investor
// delivered — "EITHER WAY" (owner-directed 2026-07-26): handed to purchasing, or
// TABLE FUNDED. Keying on stage='in_purchasing' alone was wrong: a table-funded
// loan is sold at closing and is structurally BARRED from that stage (the route
// 422s it and the button is hidden), so it would have sat on the desk and kept
// the badge incremented forever, with no action available to clear it.
//
// The stage test is kept as well, purely for legacy rows that reached purchasing
// before the sign-off stamps were recorded.
// ---------------------------------------------------------------------------
const CLOSING_RETIRED_SQL = (a = 'cw') =>
  `(${a}.stage = 'in_purchasing'
    OR (${a}.fully_reconciled_at IS NOT NULL AND ${a}.investor_delivery_signed_off_at IS NOT NULL))`;


// The closing document conditions the closer uploads into (seeded by db/315).
const CLOSING_CONDITION_CODES = ['closing_hud_final', 'closing_pkg_signed', 'closing_tracking_label'];

// Document quick-link groups → the checklist template code(s) that own each kind.
// Human uploads carry doc_kind NULL; their identity is the linked condition's code.
const QUICKLINK_GROUPS = {
  insurance: ['rtl_cond_insurance'],
  contract: ['rtl_p1_contract'],
  assignment: ['rtl_p5_assign'],
  llc: ['rtl_p1_llc', 'rtl_llc_formation', 'rtl_llc_ein', 'rtl_llc_opagmt'],
  bank_statement: ['rtl_p3_assets'],
  title: ['rtl_cond_title'],
};

// The credit condition both borrowers' reports file onto (the co-borrower's own
// split-out condition uses the same template code, so this covers both).
const CREDIT_CONDITION_CODES = ['rtl_cond_credit'];

// THE CREDIT REPORT quick-link (owner-directed 2026-07-28). Kept OUT of
// QUICKLINK_GROUPS because it is not a plain code match:
//   • the importer files the readable report as doc_kind='credit_pdf' — that is
//     the identity, and it holds even if the condition itself is missing from
//     the file (storeImport files with checklist_item_id NULL in that case);
//   • it also files the machine-readable source as 'credit_xml' — the closer
//     cannot read XML, so the data file is never a quick-link;
//   • a report a human dropped straight onto the credit condition carries
//     doc_kind NULL, so the condition code is the fallback identity.
// Both borrowers' reports (and a merged/joint report, which is ONE stored
// document shared by both credit_reports rows) surface here.
function isCreditReportDoc(d) {
  if (!d) return false;
  if (d.doc_kind === 'credit_xml') return false;
  if (d.doc_kind === 'credit_pdf') return true;
  return CREDIT_CONDITION_CODES.includes(d.template_code);
}

// ---------------------------------------------------------------------------
// Calendar-string date equality (null-safe). Dates flow as 'YYYY-MM-DD' strings
// end-to-end (pg OID 1082); never a JS Date mid-pipeline.
// ---------------------------------------------------------------------------
function dayStr(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function sameDay(a, b) {
  const x = dayStr(a); const y = dayStr(b);
  return x && y ? x === y : false;
}

// ---------------------------------------------------------------------------
// Attach the closing document conditions to a file (idempotent). Called when the
// file is submitted to closing so the closer's upload slots exist immediately.
// Runs on the caller's client (may be inside a transaction).
// ---------------------------------------------------------------------------
async function ensureClosingConditions(client, appId) {
  const c = client || db;
  await c.query(
    `INSERT INTO checklist_items
       (template_id, scope, application_id, label, audience, item_kind, role_scope, phase, category, hint,
        is_required, status, sort_order, origin_kind, created_by_kind)
     SELECT t.id, 'application', $1, t.label, t.audience, t.item_kind, t.role_scope, t.phase,
            t.category, t.hint, false, 'outstanding', t.sort_order, 'auto', 'staff'
       FROM checklist_templates t
      WHERE t.code = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id=$1 AND ci.template_id=t.id)`,
    [appId, CLOSING_CONDITION_CODES]);
}

// ---------------------------------------------------------------------------
// The REQUIRED-liquidity breakdown, written onto rtl_p3_assets by
// src/lib/liquidity.js. { required, cashToClose, reserveRequirement, reserveBasis,
// downPayment, closingCosts }. Reused as-is — never re-derived (frozen numbers).
// ---------------------------------------------------------------------------
async function readLiquidityBreakdown(appId, client) {
  const c = client || db;
  const r = await c.query(
    `SELECT ci.tool_payload FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_p3_assets' ORDER BY ci.created_at LIMIT 1`, [appId]);
  const tp = r.rows[0] && r.rows[0].tool_payload;
  return (tp && tp.liquidity) || null;
}

// VERIFIED liquidity — the bank-statement balances that actually count, via the
// frozen assessBankLiquidity aggregation. Returns the total + the per-account
// table (each row carries document_id → a direct link to the source statement).
async function readVerifiedLiquidity(appId, client, requiredLiquidity) {
  const c = client || db;
  const bankLiq = require('./underwriting/bank-liquidity');
  const fileView = require('./underwriting/file-view');
  const exts = await c.query(
    `SELECT * FROM document_extractions
      WHERE application_id=$1 AND doc_type='bank_statement' AND is_current=true
        AND superseded=false AND status='analyzed'`, [appId]);
  let ctx = {};
  try { ctx = (await fileView.loadContext(c, appId)) || {}; } catch (_) { ctx = {}; }
  const res = bankLiq.assessBankLiquidity(ctx, exts.rows, { requiredLiquidity: requiredLiquidity != null ? requiredLiquidity : null });
  return {
    verified: Number(res.qualifyingTotal) || 0,
    excludedTotal: Number(res.excludedTotal) || 0,
    accounts: Array.isArray(res.accounts) ? res.accounts : [],
  };
}

// ---------------------------------------------------------------------------
// THE MONEY GATE — verified liquidity must cover the ACTUAL cash-to-close (off the
// ALTA) PLUS the required reserves (frozen). Reserve is reused unchanged; only the
// cash-to-close term swaps estimate → actual. $1 tolerance + haveCountable data-gap
// guard mirror assets-autoclear.js. Never re-derives a frozen number.
// ---------------------------------------------------------------------------
// PURE decision — verified liquidity vs (actual cash-to-close + reserves). $1
// tolerance + haveCountable data-gap guard mirror assets-autoclear.js. Reserve is
// the frozen number; only the cash-to-close term is the closer's actual off the ALTA.
function decideCashToClose({ verified, reserve, actualCashToClose, haveCountable }) {
  const v = Number(verified) || 0;
  const r = Number(reserve) || 0;
  // null / undefined / '' means "no actual entered yet" — never treat it as $0
  // (Number(null) === 0), which would falsely pass the gate.
  const actual = Number(actualCashToClose);
  const haveActual = actualCashToClose != null && actualCashToClose !== '' && Number.isFinite(actual) && actual >= 0;
  const required = (haveActual ? actual : 0) + r;
  const ok = haveActual && !!haveCountable && v >= required - 1;
  const shortfall = ok ? 0 : Math.max(0, required - v);
  return { ok, required, shortfall, haveActual };
}

async function runCashToCloseCheck(appId, actualCashToClose, client) {
  const c = client || db;
  const liq = await readLiquidityBreakdown(appId, c);
  const reserve = liq && liq.reserveRequirement != null ? Number(liq.reserveRequirement) : 0;
  const required0 = liq && liq.required != null ? Number(liq.required) : null;
  const { verified, accounts, excludedTotal } = await readVerifiedLiquidity(appId, c, required0);
  const haveCountable = accounts.some((a) => a && a.tied && a.ending != null);
  const d = decideCashToClose({ verified, reserve, actualCashToClose, haveCountable });
  return {
    ok: d.ok,
    verified,
    excludedTotal,
    reserve,
    reserveBasis: liq ? liq.reserveBasis || null : null,
    estimateCashToClose: liq && liq.cashToClose != null ? Number(liq.cashToClose) : null,
    estimateRequired: required0,
    actualCashToClose: d.haveActual ? Number(actualCashToClose) : null,
    required: d.required,
    shortfall: d.shortfall,
    haveCountable,
    accounts,
  };
}

// ---------------------------------------------------------------------------
// Encompass funded date (READ-ONLY) — field 1401, pulled from the scrubbed loan in
// applications.encompass_extra via the read-only field map. Returns null when the
// file isn't linked / the field is empty (never guesses).
// ---------------------------------------------------------------------------
function readEncompassFundedDate(app) {
  try {
    const map = require('./integrations/encompass-field-map');
    const extra = app && app.encompass_extra;
    if (!extra) return null;
    const fields = map.extractFields(extra) || {};
    return fields.funded_date ? dayStr(fields.funded_date) : null;
  } catch (_) { return null; }
}

// THE RECONCILIATION GATE — the funded date must match across all three systems
// before the file can be marked "fully reconciled". PILOT + ClickUp are the hard
// requirement (both present + equal); the Encompass leg is enforced only when a
// value is present (graceful N/A when the file isn't in Encompass yet). Nothing is
// written to any system — the closer fixes the source and re-checks.
// PURE decision — the 3-system funded-date match. PILOT + ClickUp are the hard
// requirement (both present + equal); the Encompass leg is enforced only when a
// value is present (graceful N/A when the file isn't in Encompass yet).
function decideReconcile({ ours, clickup, encompass, encLinked }) {
  const o = dayStr(ours); const cu = dayStr(clickup); const enc = dayStr(encompass);
  const reasons = [];     // HARD — these block "fully reconciled"
  const advisories = [];  // shown to the closer, but never block
  if (!o) reasons.push('Set the funded date in PILOT first.');
  if (!cu) reasons.push('The actual closing / funding date is not set in ClickUp yet.');
  if (o && cu && !sameDay(o, cu)) reasons.push(`Funded dates disagree — PILOT ${o} vs ClickUp ${cu}.`);
  let encStatus;
  if (enc == null) encStatus = encLinked ? 'missing' : 'na';
  else encStatus = sameDay(o, enc) ? 'match' : 'mismatch';
  // Encompass leg: a PRESENT-but-disagreeing funded date blocks (a real conflict);
  // a linked-but-EMPTY date is ADVISORY only — Encompass field 1401 population is
  // tenant-dependent, so its absence must never permanently stall reconciliation.
  if (encStatus === 'missing') advisories.push('Encompass has no funded date yet — confirm it there once it posts.');
  if (encStatus === 'mismatch' && o) reasons.push(`Funded dates disagree — PILOT ${o} vs Encompass ${enc}.`);
  const ok = reasons.length === 0;
  return {
    ok, ours: o, clickup: cu, encompass: enc, encStatus, encLinked: !!encLinked,
    reason: ok ? null : reasons.join(' '),
    advisory: advisories.length ? advisories.join(' ') : null,
  };
}

async function reconcileClosingDates(appId, client) {
  const c = client || db;
  const a = (await c.query(
    `SELECT id, funded_date, actual_closing, encompass_loan_guid, encompass_extra
       FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!a) return { ok: false, reason: 'File not found.' };
  return decideReconcile({
    ours: a.funded_date,
    clickup: a.actual_closing,
    encompass: readEncompassFundedDate(a),
    encLinked: !!(a.encompass_loan_guid || a.encompass_extra),
  });
}

// ---------------------------------------------------------------------------
// Document quick-links — group the file's current, non-rejected documents by the
// closing-relevant condition codes so the closer can open insurance / contract /
// assignment / LLC / bank statement / title in one click.
// ---------------------------------------------------------------------------
async function readQuickLinks(appId, llcId, client) {
  const c = client || db;
  const r = await c.query(
    `SELECT d.id, d.filename, d.content_type, d.checklist_item_id, d.slot_label, d.created_at,
            d.doc_kind, t.code AS template_code, ci.label AS item_label
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE (d.application_id = $1 OR (d.application_id IS NULL AND d.llc_id = $2))
        AND d.is_current = true
        AND COALESCE(d.review_status,'') <> 'rejected'
        AND COALESCE(d.source_type,'') <> 'chat_attachment'
      ORDER BY d.created_at DESC`, [appId, llcId || null]);
  const groups = {};
  for (const key of Object.keys(QUICKLINK_GROUPS)) groups[key] = [];
  // The term sheet is keyed by doc_kind (not a condition): the SIGNED/executed
  // copy (term_sheet_signed, filed by the e-sign integration) and the draft
  // (term_sheet). The closer needs a direct link to the executed final sheet.
  groups.term_sheet = [];
  // The credit report is keyed by doc_kind / its own condition (see
  // isCreditReportDoc) — likewise not a plain QUICKLINK_GROUPS code match.
  groups.credit_report = [];
  const codeToGroup = {};
  for (const [group, codes] of Object.entries(QUICKLINK_GROUPS)) for (const code of codes) codeToGroup[code] = group;
  for (const d of r.rows) {
    const g = d.template_code && codeToGroup[d.template_code];
    if (g) groups[g].push(d);
    if (d.doc_kind === 'term_sheet_signed' || d.doc_kind === 'term_sheet') groups.term_sheet.push(d);
    if (isCreditReportDoc(d)) groups.credit_report.push(d);
  }
  // Executed copy first, then draft, newest within each (each already newest-first).
  groups.term_sheet.sort((a, b) => (a.doc_kind === 'term_sheet_signed' ? 0 : 1) - (b.doc_kind === 'term_sheet_signed' ? 0 : 1));
  // WHOSE credit report — both borrowers' reports file on the same condition and
  // the importer names them all 'credit-report.pdf', so without this a two-borrower
  // file shows two identical links. Read from credit_reports (the system of record)
  // rather than the document's own borrower_id: a MERGED/joint report is ONE stored
  // document shared by both rows, so it correctly reports BOTH names. Best-effort —
  // a failure here only costs the label, never the links.
  if (groups.credit_report.length) {
    try {
      const owners = await c.query(
        `SELECT doc_id, string_agg(name, ', ' ORDER BY name) AS names FROM (
           SELECT DISTINCT cr.pdf_document_id AS doc_id, NULLIF(b.full_name,'') AS name
             FROM credit_reports cr JOIN borrowers b ON b.id = cr.borrower_id
            WHERE cr.application_id = $1 AND cr.pdf_document_id IS NOT NULL AND NULLIF(b.full_name,'') IS NOT NULL
         ) s GROUP BY doc_id`, [appId]);
      const byDoc = new Map(owners.rows.map((o) => [String(o.doc_id), o.names]));
      for (const d of groups.credit_report) d.credit_for = byDoc.get(String(d.id)) || null;
    } catch (e) {
      console.error('[closing] credit-report owner lookup failed (links still returned):', (e && e.message) || e);
    }
  }
  return groups;
}

// The closing document conditions (HUD / closed package / tracking label) + their
// current docs, for the workspace's upload cards.
async function readClosingConditions(appId, client) {
  const c = client || db;
  const r = await c.query(
    `SELECT ci.id, ci.label, ci.status, ci.signed_off_at, t.code
       FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code = ANY($2::text[])
      ORDER BY t.sort_order`, [appId, CLOSING_CONDITION_CODES]);
  const items = r.rows;
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const docs = (await c.query(
    `SELECT id, filename, content_type, checklist_item_id, created_at
       FROM documents WHERE checklist_item_id = ANY($1::uuid[]) AND is_current=true
        AND COALESCE(review_status,'') <> 'rejected' ORDER BY created_at DESC`, [ids])).rows;
  return items.map((it) => ({ ...it, documents: docs.filter((d) => String(d.checklist_item_id) === String(it.id)) }));
}

// Closer checklists (custom + per-provider) with their items.
async function readChecklists(appId, client) {
  const c = client || db;
  const lists = (await c.query(
    `SELECT id, template_id, provider, title, created_by, created_at
       FROM closing_checklists WHERE application_id=$1 ORDER BY created_at`, [appId])).rows;
  if (!lists.length) return [];
  const ids = lists.map((l) => l.id);
  const items = (await c.query(
    `SELECT id, checklist_id, label, checked, checked_by, checked_at, sort_order
       FROM closing_checklist_items WHERE checklist_id = ANY($1::uuid[]) ORDER BY sort_order, created_at`, [ids])).rows;
  return lists.map((l) => ({ ...l, items: items.filter((i) => String(i.checklist_id) === String(l.id)) }));
}

// Check / un-check ONE closer checklist item. Lives here (not inline in the
// route) so the regression test exercises the SHIPPED statement — the `$3::uuid`
// cast is load-bearing: a bare param inside CASE WHEN…THEN resolves to text and
// the uuid column write throws (a 500 on every check-off).
async function setChecklistItemChecked(client, itemId, checked, actorId) {
  const c = client || db;
  await c.query(
    `UPDATE closing_checklist_items SET checked=$2,
        checked_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
        checked_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1`,
    [itemId, !!checked, actorId || null]);
}

async function readNotes(appId, client) {
  const c = client || db;
  const r = await c.query(
    `SELECT n.id, n.body, n.created_at, n.author_staff_id, s.full_name AS author_name
       FROM closing_notes n LEFT JOIN staff_users s ON s.id = n.author_staff_id
      WHERE n.application_id=$1 ORDER BY n.created_at DESC LIMIT 200`, [appId]);
  return r.rows;
}

// ---------------------------------------------------------------------------
// THE aggregate workspace payload the Closing screen renders. Best-effort per
// sub-part — a failure in one block never blanks the whole page.
// ---------------------------------------------------------------------------
async function getClosingWorkspace(appId, client) {
  const c = client || db;
  const app = (await c.query(
    `SELECT a.id, a.ys_loan_number, a.llc_id, a.status, a.funded_date, a.actual_closing,
            a.expected_closing, a.closer_id, s.full_name AS closer_name
       FROM applications a LEFT JOIN staff_users s ON s.id = a.closer_id
      WHERE a.id=$1 AND a.deleted_at IS NULL`, [appId])).rows[0];
  if (!app) return null;
  const closing = (await c.query(`SELECT * FROM closing_workflow WHERE application_id=$1`, [appId])).rows[0] || null;

  const safe = async (fn, fallback) => { try { return await fn(); } catch (_) { return fallback; } };
  const liq = await safe(() => readLiquidityBreakdown(appId, c), null);
  const money = await safe(() => runCashToCloseCheck(appId, closing ? closing.actual_cash_to_close : null, c), null);
  const quickLinks = await safe(() => readQuickLinks(appId, app.llc_id, c), {});
  const conditions = await safe(() => readClosingConditions(appId, c), []);
  const checklists = await safe(() => readChecklists(appId, c), []);
  const notes = await safe(() => readNotes(appId, c), []);
  const reconciliation = await safe(() => reconcileClosingDates(appId, c), null);

  return {
    application_id: appId,
    ys_loan_number: app.ys_loan_number,
    status: app.status,
    funded_date: dayStr(app.funded_date),
    actual_closing: dayStr(app.actual_closing),
    expected_closing: dayStr(app.expected_closing),
    closer: app.closer_id ? { id: app.closer_id, name: app.closer_name } : null,
    closing: closing || { stage: null },
    liquidity: liq,
    money,
    quickLinks,
    conditions,
    checklists,
    notes,
    reconciliation,
    warehouses: WAREHOUSES,
  };
}

module.exports = {
  WAREHOUSES,
  TABLE_FUNDING,
  CLOSING_RETIRED_SQL,
  CLOSING_CONDITION_CODES,
  QUICKLINK_GROUPS,
  CREDIT_CONDITION_CODES,
  isCreditReportDoc,
  dayStr,
  sameDay,
  decideCashToClose,
  decideReconcile,
  ensureClosingConditions,
  readLiquidityBreakdown,
  readVerifiedLiquidity,
  runCashToCloseCheck,
  readEncompassFundedDate,
  reconcileClosingDates,
  readQuickLinks,
  readClosingConditions,
  readChecklists,
  readNotes,
  setChecklistItemChecked,
  getClosingWorkspace,
};
