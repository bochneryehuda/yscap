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
 * The program a registration should be recorded under. A structural override
 * ALWAYS resolves to 'manual', regardless of which card (Standard/Gold) the
 * studio was on — you can't register a structural override under Standard/Gold.
 * A plain markup/fee/rate override keeps the requested program.
 */
function resolveProgram(requestedProgram, overrides) {
  if (isManualProduct(overrides)) return 'manual';
  return requestedProgram === 'gold' ? 'gold' : 'standard';
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
async function openEscalation(client, { appId, registrationId, assetMonths, overrides, summary, requestedBy }) {
  await client.query(
    `UPDATE manual_program_escalations
        SET status='declined', decided_at=now(), updated_at=now(),
            decision_note=COALESCE(decision_note,'Superseded by a newer manual registration')
      WHERE application_id=$1 AND status='pending'`, [appId]);
  const structural = structuralOverridesEngaged(overrides);
  const slim = {};
  for (const k of structural) slim[k] = overrides[k];
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
  const r = await client.query(
    `UPDATE manual_program_escalations
        SET status='declined', decided_at=now(), updated_at=now(),
            decision_note=COALESCE(decision_note,$2)
      WHERE application_id=$1 AND status='pending'`,
    [appId, note || 'Superseded — the file was re-registered as a non-manual product']);
  return r.rowCount || 0;
}

/** The current PENDING escalation for a file (or null). */
async function pendingForApp(appId, client = db) {
  const r = await client.query(
    `SELECT * FROM manual_program_escalations WHERE application_id=$1 AND status='pending'
      ORDER BY created_at DESC LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

/** List escalations for the super-admin box. status: 'pending'|'approved'|'declined'|'all'. */
async function listEscalations({ status = 'pending', limit = 100 } = {}, client = db) {
  const where = status && status !== 'all' ? `WHERE e.status = $1` : '';
  const params = status && status !== 'all' ? [status] : [];
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

/** Count of open (pending) escalations — for the nav badge. */
async function pendingCount(client = db) {
  try {
    const r = await client.query(`SELECT count(*)::int AS n FROM manual_program_escalations WHERE status='pending'`);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (_) { return 0; }
}

/** Approve/decline an escalation. decision: 'approved'|'declined'. Returns the row. */
async function decideEscalation(id, decision, staffId, note, client = db) {
  const status = decision === 'approved' ? 'approved' : 'declined';
  const r = await client.query(
    `UPDATE manual_program_escalations
        SET status=$2, decided_by=$3, decided_at=now(),
            decision_note=$4, updated_at=now()
      WHERE id=$1 AND status='pending'
      RETURNING *`,
    [id, status, staffId || null, note ? String(note).slice(0, 500) : null]);
  return r.rows[0] || null;
}

module.exports = {
  STRUCTURAL_OVERRIDE_KEYS, engaged, structuralOverridesEngaged, isManualProduct, resolveProgram,
  SETTINGS_DEFAULTS, loadSettings, saveSettings,
  openEscalation, closePendingForApp, pendingForApp, listEscalations, pendingCount, decideEscalation,
};
