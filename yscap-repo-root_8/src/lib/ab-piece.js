'use strict';
/**
 * A-PIECE / B-PIECE SPLIT on a MANUAL-program loan (owner-directed 2026-08-18):
 * staff mark the loan as sold in two pieces and type the A-piece dollar amount;
 * the B-piece is ALWAYS DERIVED — the rest of the loan (total loan − A-piece) —
 * never stored, so it can never drift from the loan when the file re-registers.
 *
 * THE THREE RULES, all owner-stated:
 *   1. INTERNAL ONLY. Staff record and edit it; no borrower or TPO surface ever
 *      selects these columns, and the route lives on the staff router alone.
 *   2. SAVEABLE ANY TIME, WITHOUT TRIPPING THE RE-REGISTER MACHINERY. The two
 *      columns (applications.ab_piece_enabled / a_piece_amount, db/579) are
 *      deliberately absent from every db/071 / db/072 / db/486 watch list —
 *      recording how a loan is SOLD is not a pricing input, so it must never
 *      reopen Products & Pricing, un-sign a term sheet, or flag the
 *      registration stale (proven by scripts/test-ab-piece-db.js, with a
 *      CONTROL showing the trigger genuinely bites the same fixture).
 *   3. THE TOTAL is the CURRENT REGISTRATION's loan (quote.sizing.totalLoan),
 *      falling back to the file's loan_amount — one definition, read live, so
 *      the derived B-piece follows a re-register on its own.
 *
 * ENCOMPASS: the owner has said this split will sync THREE Encompass fields,
 * whose field ids the owner supplies. NOTHING here talks to Encompass — every
 * Encompass write is governed by docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md (the
 * hard read-only rule), so that sync is a separate, owner-authorized step once
 * the three field ids are named. Do not wire one from here.
 */
const db = require('../db');
const { applicationColumnProblem } = require('./number-bounds');

function shape(row) {
  const regTotal = row.reg_total != null ? Number(row.reg_total) : NaN;
  const total = Number.isFinite(regTotal) && regTotal > 0 ? regTotal
    : (row.loan_amount != null && Number.isFinite(Number(row.loan_amount)) ? Number(row.loan_amount) : null);
  const a = row.a_piece_amount != null ? Number(row.a_piece_amount) : null;
  const b = (row.ab_piece_enabled && a != null && total != null)
    ? Math.max(0, Math.round((total - a) * 100) / 100) : null;
  return {
    enabled: !!row.ab_piece_enabled,
    aPiece: a,
    bPiece: b,
    totalLoan: total,
    // A re-register can LOWER the loan under an already-recorded A-piece (the
    // save's ceiling check is read-then-write); rather than silently clamping
    // the B-piece to $0, the overage is FLAGGED so the card says so plainly
    // (audit 2026-08-18 note).
    aPieceOverTotal: !!(row.ab_piece_enabled && a != null && total != null && a > total + 0.005),
    registeredProgram: row.registered_program || null,
    // The UI keys on this: the split is a MANUAL-program structure. A file that
    // already carries a split keeps showing it whatever the program becomes.
    manual: row.registered_program === 'manual',
  };
}

async function loadAbPiece(appId, client = db) {
  const r = await client.query(
    `SELECT a.ab_piece_enabled, a.a_piece_amount, a.loan_amount,
            pr.program AS registered_program,
            (pr.quote -> 'sizing' ->> 'totalLoan') AS reg_total
       FROM applications a
       LEFT JOIN product_registrations pr
              ON pr.application_id = a.id AND pr.is_current = true
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

/**
 * Save the split. body = { enabled, aPieceAmount } — aPieceAmount may be null
 * to clear. Throws { status, message } in plain language; returns the fresh
 * shape. Every refusal happens BEFORE any write.
 */
async function saveAbPiece(appId, body = {}, client = db) {
  const cur = await loadAbPiece(appId, client);
  if (!cur) { const e = new Error('file not found'); e.status = 404; throw e; }

  const enabled = body.enabled === true;
  let amount = null;
  if (body.aPieceAmount != null && body.aPieceAmount !== '') {
    const n = Number(body.aPieceAmount);
    if (!Number.isFinite(n) || n < 0) {
      const e = new Error('type the A-piece as a plain dollar amount'); e.status = 400; throw e;
    }
    const boundProblem = applicationColumnProblem('a_piece_amount', n);
    if (boundProblem) { const e = new Error(boundProblem); e.status = 400; throw e; }
    if (cur.totalLoan != null && n > cur.totalLoan + 0.005) {
      const e = new Error(`the A-piece can't be more than the loan itself ($${Math.round(cur.totalLoan).toLocaleString('en-US')})`);
      e.status = 400; throw e;
    }
    amount = Math.round(n * 100) / 100;
  }

  await client.query(
    `UPDATE applications SET ab_piece_enabled=$2, a_piece_amount=$3 WHERE id=$1`,
    [appId, enabled, amount]);
  return loadAbPiece(appId, client);
}

module.exports = { loadAbPiece, saveAbPiece, shape };
