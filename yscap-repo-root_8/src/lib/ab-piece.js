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
 * ENCOMPASS (field ids owner-supplied 2026-08-18): CX.BPIECESTRUCTURE ("x" =
 * the split structure exists), CX.APIECE (A-piece dollars), CX.BPIECE (B-piece
 * dollars). `encompassAbPiece` below READS those three values out of the file's
 * STORED Encompass copy (applications.encompass_extra._fieldValues — filled by
 * the existing read-only sync; the ids are registry REFERENCE rows in
 * lib/integrations/encompass-field-map.js so the fieldReader pulls them) and
 * compares them to PILOT's recorded split, ADVISORY only — it never gates,
 * never writes either side, and NOTHING here talks to Encompass live. A
 * PILOT→Encompass WRITE of the split remains forbidden: it needs its own entry
 * in docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md with the owner's written
 * authorization (the hard read-only rule). Do not wire one from here.
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

// ── The ENCOMPASS side of the split (read-only, advisory — header rule) ──────
// The three owner-supplied field ids. Read from the STORED loan copy only.
const ENC_FIELDS = Object.freeze({
  structure: 'CX.BPIECESTRUCTURE',
  aPiece: 'CX.APIECE',
  bPiece: 'CX.BPIECE',
});

// "if this field has an x, it means that the field is checked" (owner). An
// Encompass checkbox custom field stores a mark when ticked and blank when not,
// so: a recognisable mark → true, blank / a recognisable "no" → false, anything
// else → null (unreadable — shown raw, never guessed into a verdict).
function parseEncChecked(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '' || s === 'n' || s === 'no' || s === 'false' || s === '0') return false;
  if (/^x+$/.test(s) || s === 'y' || s === 'yes' || s === 'true' || s === '1' || s === 'checked') return true;
  return null;
}

// A money field as Encompass returns it ("250000", "250,000.00", "$250,000").
// Unparseable → null, never a guessed number.
function parseEncMoney(v) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Pure: turn the stored _fieldValues + PILOT's own split into the advisory
// comparison the card shows. Returns null when the stored copy carries NONE of
// the three fields (a pre-wiring snapshot, or Encompass unconfigured) — "we
// have not read it" must never render as "Encompass says no split".
function shapeEncompass(fieldValues, ours) {
  const fv = fieldValues && typeof fieldValues === 'object' ? fieldValues : null;
  if (!fv) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(fv, k);
  if (!has(ENC_FIELDS.structure) && !has(ENC_FIELDS.aPiece) && !has(ENC_FIELDS.bPiece)) return null;

  const structureRaw = has(ENC_FIELDS.structure) ? String(fv[ENC_FIELDS.structure] == null ? '' : fv[ENC_FIELDS.structure]) : null;
  const structureChecked = structureRaw == null ? null : parseEncChecked(structureRaw);
  // A ZERO AMOUNT MEANS "NOTHING RECORDED", ON EITHER SIDE (owner-directed
  // 2026-08-18: "If something is empty and something is a zero and Encompass
  // is syncing, it doesn't mean that it's not matching"). A $0 A-piece or
  // B-piece is not a piece — an Encompass copy carrying "0" against a blank
  // PILOT side (or the reverse) must never read as a MISMATCH, so zeros
  // normalize to null before the comparison. A genuine dollar amount on one
  // side against nothing on the other stays the real disagreement it is.
  const zeroNull = (n) => (n != null && Math.abs(n) < 0.005 ? null : n);
  const aPiece = zeroNull(has(ENC_FIELDS.aPiece) ? parseEncMoney(fv[ENC_FIELDS.aPiece]) : null);
  const bPiece = zeroNull(has(ENC_FIELDS.bPiece) ? parseEncMoney(fv[ENC_FIELDS.bPiece]) : null);
  const ourA = zeroNull(ours && ours.aPiece != null ? Number(ours.aPiece) : null);
  const ourB = zeroNull(ours && ours.bPiece != null ? Number(ours.bPiece) : null);

  // Per-fact agreement against PILOT's record. true/false only where BOTH
  // sides state something comparable; null where nothing can be compared.
  // "One side has a real number, the other has none" is a real DISAGREEMENT
  // (that is exactly the state a not-yet-updated Encompass copy is in);
  // "neither side has one" agrees trivially and is filtered by `relevant`.
  const near = (x, y) => Math.abs(x - y) < 0.005;
  const agrees = { structure: null, aPiece: null, bPiece: null };
  if (ours) {
    if (structureChecked !== null) agrees.structure = structureChecked === !!ours.enabled;
    if (aPiece != null || ourA != null) {
      agrees.aPiece = (aPiece != null && ourA != null) ? near(aPiece, ourA) : false;
    }
    if (bPiece != null || ourB != null) {
      agrees.bPiece = (bPiece != null && ourB != null) ? near(bPiece, ourB) : false;
    }
  }
  const stated = [agrees.structure, agrees.aPiece, agrees.bPiece].filter((x) => x !== null);
  const overall = stated.length ? stated.every(Boolean) : null;

  // The card only shows the line when SOMETHING is on either side — a manual
  // file with no split anywhere must not grow a "Encompass agrees: nothing"
  // row on every screen.
  const relevant = structureChecked === true || aPiece != null || bPiece != null
    || !!(ours && (ours.enabled || ourA != null));

  return { structureChecked, structureRaw, aPiece, bPiece, agrees, overall, relevant };
}

/**
 * Best-effort read of the Encompass copy's A/B-piece fields for the card.
 * Never throws (an unreadable copy renders no line — it must never fail the
 * split screen), never talks to Encompass live, never writes anything.
 * `ours` (a loadAbPiece shape) is optional — passed by the route to avoid a
 * second read; loaded here otherwise.
 */
async function encompassAbPiece(appId, client = db, ours = null) {
  try {
    const r = await client.query(
      `SELECT encompass_extra -> '_fieldValues' AS fv FROM applications WHERE id = $1`, [appId]);
    const fv = r.rows[0] && r.rows[0].fv;
    if (!fv) return null;
    const own = ours || await loadAbPiece(appId, client);
    return shapeEncompass(fv, own);
  } catch (_) { return null; }
}

module.exports = {
  loadAbPiece, saveAbPiece, shape, encompassAbPiece,
  _internals: { parseEncChecked, parseEncMoney, shapeEncompass, ENC_FIELDS },
};
