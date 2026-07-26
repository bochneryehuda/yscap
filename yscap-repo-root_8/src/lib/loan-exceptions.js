'use strict';

/**
 * Loan policy EXCEPTIONS — the single policy-exception REGISTER
 * (owner-directed 2026-07-22; redesigned 2026-07-24 — docs/EXCEPTION-WORKFLOW-REDESIGN.md).
 *
 * One purpose-built record per policy deviation, with its own lifecycle, so the
 * request → decision → effect trail is auditable and reportable. The register
 * hosts every exception TYPE through one engine + one review box:
 *
 *   guaranty_waiver    — waive the co-borrower's personal guaranty (subject
 *                        borrower stays a member of the entity, not a guarantor).
 *                        Approval flips applications.co_borrower_pg_waived.
 *   esign_before_ctc   — send the term-sheet package before every send
 *                        requirement is met. Approval names EXACTLY the waived
 *                        blocker codes; the e-sign gate re-checks the rest.
 *   pricing_exception  — a pricing/guideline deviation ask (finance more of an
 *                        assignment fee, leverage, loan size, experience tier…).
 *                        The RECORD is decided here; the GRANT stays the studio
 *                        action (admin override + re-register) — this module
 *                        never touches a frozen pricing-engine number.
 *   issuance_override  — an after-the-fact RECORD of a super-admin pushing an
 *                        issuance/status past a fatal hard-warning (the R6.18
 *                        backstop). Born approved; never sits open.
 *
 * Lifecycle: requested → approved | denied | withdrawn (+ cleared = archived,
 * + expired = a time-boxed approval past its validity). Governance on top:
 *   • ANY staff member with file access may REQUEST (structured reason + note);
 *     the borrower pricing ask is recorded too (requested_by_kind='borrower').
 *   • Only a SUPER-ADMIN decides (segregation of duties — the approver cannot
 *     be the requester; enforced in the route). This gate is policy: do NOT
 *     relax it without the owner's explicit written direction.
 *   • Compensating factors (structured) travel with the request; the deal
 *     economics are SNAPSHOTTED at request time so the reviewer sees the
 *     picture the requester saw even if the file moves.
 *   • An approval on an expirable type may carry expires_at; past it, the
 *     sweep flips the row to 'expired' (fails CLOSED — only status='approved'
 *     grants anything). guaranty_waiver is NEVER expirable: that flag moves
 *     only by human decision.
 *   • due_at = the review SLA target; the aging digest nudges super-admins.
 *   • A fresh request after a denial links back via re_request_of.
 *
 * At most ONE open (requested) exception of a type per file — a new request
 * supersedes any prior open one. Every state change is audited by the caller
 * (audit_log); this module owns the table writes only.
 */

const db = require('../db');

// Structured reasons a co-borrower's personal guaranty is waived. Free-text notes
// still accompany the code; the code makes the exception reportable across files.
const REASON_CODES = Object.freeze({
  passive_member:   'Co-borrower is a passive / minority / capital-only member',
  primary_strong:   'Primary guarantor is strong enough on their own',
  structural:       'Structural / legal constraint (e.g. SDIRA, institutional, foreign national, trust)',
  cannot_sign:      'Co-borrower cannot / will not sign a personal guaranty',
  relationship:     'Relationship / repeat sponsor exception',
  other:            'Other (see note)',
});
function isReasonCode(c) { return !!c && Object.prototype.hasOwnProperty.call(REASON_CODES, c); }

// Structured reasons a term-sheet package is sent BEFORE clear-to-close.
// The request may be made whenever the package can't send (owner-directed
// 2026-07-24 — floor met or not); the approving super-admin then picks exactly
// which outstanding requirements are waived (waived_codes), and everything not
// waived stays enforced.
const ESIGN_BEFORE_CTC_REASONS = Object.freeze({
  review_pending:   'Appraisal is back and re-priced — only the internal appraisal review is still pending',
  borrower_timeline:'Borrower / closing timeline needs the documents out now',
  lock_terms:       'Locking the terms with the borrower now',
  system_issue:     'A system flag is blocking the send in error (e.g. a false “re-register” warning)',
  relationship:     'Relationship / repeat sponsor exception',
  other:            'Other (see note)',
});
function isEsignReasonCode(c) { return !!c && Object.prototype.hasOwnProperty.call(ESIGN_BEFORE_CTC_REASONS, c); }

// Structured reasons for a pricing / guideline exception (the studio's
// "Request an exception" ask — previously a dead-end with no record at all).
const PRICING_EXCEPTION_REASONS = Object.freeze({
  finance_more_fee: 'Finance more of the assignment fee than the program cap',
  leverage:         'Higher leverage than the program allows (LTV / LTC / ARV)',
  loan_size:        'Loan amount outside the program minimum / maximum',
  experience_tier:  'Price off a higher experience tier than verified',
  fico_liquidity:   'FICO / liquidity outside the program guideline',
  program_fit:      'Deal shape the program doesn’t cover (city, exit, budget, term…)',
  other:            'Other (see note)',
});

// An issuance override is recorded, not requested — one catch-all code.
const ISSUANCE_OVERRIDE_REASONS = Object.freeze({
  other: 'Super-admin override past a fatal hard-warning (see note)',
});

/**
 * Structured COMPENSATING FACTORS — what offsets the risk the exception takes
 * on. Travel with the request as jsonb [{code, note}]; reportable across files
 * (the classic examiner question: "what did we accept in exchange?").
 */
const COMPENSATING_FACTORS = Object.freeze({
  fico_strong:        'Strong credit (FICO well above the program minimum)',
  liquidity_reserves: 'Verified liquidity well above the requirement',
  low_leverage:       'Lower leverage elsewhere in the deal (LTV / LTC / ARV headroom)',
  experience_depth:   'Deep verified track record for this deal type',
  guarantor_strength: 'Strong personal guarantor / net worth behind the deal',
  rate_premium:       'Priced for the risk (rate / fee premium accepted)',
  principal_paydown:  'Extra cash in the deal (larger down payment / paydown)',
  repeat_sponsor:     'Repeat sponsor with clean payment history with us',
  other:              'Other (see note)',
});

/**
 * THE TYPE REGISTRY — one entry per exception type. Everything type-specific
 * hangs off this table (reason codes, subject shape, expirability, review SLA)
 * so adding a type is one entry here + one migration widening the DB CHECK +
 * one TYPE_META entry in the UI card. Never scatter per-type ternaries again.
 *
 *   subject     'co_borrower' (names a subject borrower) | 'file'
 *   expirable   whether an approval may carry expires_at. guaranty_waiver is
 *               deliberately NOT expirable — the term-sheet flag only ever
 *               moves by a human decision, never by a clock.
 *   recordOnly  born approved (documents an in-the-moment authority action);
 *               never open, never decided from the box.
 *   slaHours    review SLA — due_at = requested_at + slaHours (null = none).
 */
const EXCEPTION_TYPES = Object.freeze({
  guaranty_waiver: Object.freeze({
    label: 'Guaranty waiver',
    reasonCodes: REASON_CODES,
    subject: 'co_borrower',
    expirable: false,
    recordOnly: false,
    slaHours: 48,
  }),
  esign_before_ctc: Object.freeze({
    label: 'Send before clear-to-close',
    reasonCodes: ESIGN_BEFORE_CTC_REASONS,
    subject: 'file',
    expirable: true,
    recordOnly: false,
    slaHours: 24,
  }),
  pricing_exception: Object.freeze({
    label: 'Pricing / guideline exception',
    reasonCodes: PRICING_EXCEPTION_REASONS,
    subject: 'file',
    expirable: true,
    recordOnly: false,
    slaHours: 48,
  }),
  issuance_override: Object.freeze({
    label: 'Issuance override (recorded)',
    reasonCodes: ISSUANCE_OVERRIDE_REASONS,
    subject: 'file',
    expirable: false,
    recordOnly: true,
    slaHours: null,
  }),
});
function isExceptionType(t) { return !!t && Object.prototype.hasOwnProperty.call(EXCEPTION_TYPES, t); }
function typeConfig(t) { return EXCEPTION_TYPES[t] || null; }

// The reason-code map for a given exception type + the label for one code. Used so
// the review box / requester queue can render a friendly reason regardless of type.
function reasonCodesFor(type) {
  const cfg = typeConfig(type);
  return (cfg && cfg.reasonCodes) || REASON_CODES;
}
function reasonLabelFor(type, code) { const m = reasonCodesFor(type); return (code && m[code]) || null; }
function isReasonCodeFor(type, code) {
  return !!code && Object.prototype.hasOwnProperty.call(reasonCodesFor(type), code);
}

/** Normalize a client compensating-factors payload to clean [{code, note}] (or null). */
function sanitizeCompensatingFactors(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const f of input.slice(0, 12)) {
    if (!f) continue;
    const code = Object.prototype.hasOwnProperty.call(COMPENSATING_FACTORS, f.code) ? f.code : null;
    const note = f.note ? String(f.note).slice(0, 400) : null;
    if (!code && !note) continue;
    out.push({ code: code || 'other', note });
  }
  return out.length ? out : null;
}

const OPEN = 'requested';

/**
 * The deal economics at a moment in time — snapshotted onto the exception at
 * REQUEST so the reviewer sees the picture the requester saw even if the file
 * is edited before the decision. Staff-only surface (the register never renders
 * to a borrower), but still: no note-buyer name is included, so nothing here
 * can leak one if a value is ever quoted in a borrower-safe email.
 */
async function dealSnapshotFor(appId, client = db) {
  try {
    // registered program comes from the CURRENT product_registrations row —
    // applications has no registered_program column (the #248 phantom-column
    // class; verified against the real schema by the DB test).
    const r = await client.query(
      `SELECT a.loan_amount, a.purchase_price, a.as_is_value, a.arv, a.rehab_budget,
              a.program, a.loan_type, a.property_type, a.units, a.status,
              a.is_assignment, a.assignment_fee, a.underlying_contract_price,
              a.requested_exp_flips, a.requested_exp_holds, a.requested_exp_ground,
              (SELECT pr.program FROM product_registrations pr
                WHERE pr.application_id = a.id AND pr.is_current
                ORDER BY pr.created_at DESC LIMIT 1) AS registered_program
         FROM applications a WHERE a.id=$1`, [appId]);
    const a = r.rows[0];
    if (!a) return null;
    const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    return {
      at: new Date().toISOString(),
      loan_amount: num(a.loan_amount),
      purchase_price: num(a.purchase_price),
      as_is_value: num(a.as_is_value),
      arv: num(a.arv),
      rehab_budget: num(a.rehab_budget),
      program: a.registered_program || a.program || null,
      loan_type: a.loan_type || null,
      property_type: a.property_type || null,
      units: num(a.units),
      file_status: a.status || null,
      is_assignment: a.is_assignment === true,
      assignment_fee: num(a.assignment_fee),
      underlying_contract_price: num(a.underlying_contract_price),
      claimed_experience: (num(a.requested_exp_flips) || 0) + (num(a.requested_exp_holds) || 0) + (num(a.requested_exp_ground) || 0),
    };
  } catch (_) { return null; }
}

/** due_at for a fresh request of this type (null when the type has no SLA). */
function dueAtFor(type, from = new Date()) {
  const cfg = typeConfig(type);
  if (!cfg || !cfg.slaHours) return null;
  return new Date(from.getTime() + cfg.slaHours * 3600 * 1000);
}

/**
 * DEAL DRIFT — did the economics move since this exception's request snapshot?
 * Pure compare of deal_snapshot vs the live values joined onto the row
 * (live_purchase_price / live_rehab_budget / live_arv + loan_amount). Returns a
 * list of {field, was, now} for the reviewer ("the deal changed under this
 * request/approval — re-check before relying on it"). ADVISORY ONLY: drift
 * never auto-voids anything — a granted waiver only ever moves by a human
 * decision (the e-sign gate separately pins waivers to their blocker state and
 * fails closed on its own).
 */
/**
 * READ-TIME EXPIRY PRESENTATION — an approved row whose expires_at has passed
 * is PRESENTED as 'expired' on every read surface, even before the scheduled
 * sweep flips the DB row (the sweep remains the writer + notifier). Fail-closed
 * display: a lapsed approval never *looks* in force anywhere. Pure — never
 * mutates the input.
 */
function presentExpiry(row) {
  if (row && row.status === 'approved' && row.expires_at
      && new Date(row.expires_at).getTime() < Date.now()) {
    return { ...row, status: 'expired', expired_at: row.expired_at || row.expires_at };
  }
  return row;
}

function dealDrift(row) {
  const snap = row && row.deal_snapshot;
  if (!snap || typeof snap !== 'object') return [];
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const pairs = [
    ['loan_amount', num(snap.loan_amount), num(row.loan_amount)],
    ['purchase_price', num(snap.purchase_price), num(row.live_purchase_price)],
    ['rehab_budget', num(snap.rehab_budget), num(row.live_rehab_budget)],
    ['arv', num(snap.arv), num(row.live_arv)],
  ];
  const out = [];
  for (const [field, was, now] of pairs) {
    if (was == null || now == null) continue; // never flag on missing data
    if (was !== now) out.push({ field, was, now });
  }
  return out;
}

/**
 * GENERIC request — the one write path every type goes through. Supersedes any
 * prior OPEN (requested) row of the same type on the file (→ withdrawn, stamped
 * withdrawn_at) so the one-open-per-file invariant holds, then inserts a fresh
 * 'requested' row carrying the governance fields. Runs on the caller's client
 * (inside a transaction when the caller supplies one). Returns the new row.
 *
 *  { type, appId, subjectBorrowerId, reasonCode, reasonNote, requestedBy,
 *    requestedByKind ('staff'|'borrower'), requestedByBorrowerId,
 *    gateSnapshot, dealSnapshot, compensatingFactors, reRequestOf, severity }
 */
async function requestException(client, opts) {
  const type = isExceptionType(opts.type) ? opts.type : 'guaranty_waiver';
  const cfg = typeConfig(type);
  await client.query(
    `UPDATE loan_exceptions
        SET status='withdrawn', withdrawn_at=now(),
            decision_note=COALESCE(decision_note,'Superseded by a newer request')
      WHERE application_id=$1 AND exception_type=$2 AND status=$3`,
    [opts.appId, type, OPEN]);
  const kind = opts.requestedByKind === 'borrower' ? 'borrower'
    : opts.requestedByKind === 'system' ? 'system' : 'staff';
  const severity = ['advisory', 'standard', 'material'].includes(opts.severity) ? opts.severity : 'standard';
  const ins = await client.query(
    `INSERT INTO loan_exceptions
       (application_id, exception_type, subject_borrower_id, status, reason_code, reason_note,
        requested_by, requested_by_kind, requested_by_borrower_id,
        gate_snapshot, deal_snapshot, compensating_factors, re_request_of, severity, due_at)
     VALUES ($1,$2,$3,'requested',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [opts.appId, type,
     cfg.subject === 'co_borrower' ? (opts.subjectBorrowerId || null) : null,
     isReasonCodeFor(type, opts.reasonCode) ? opts.reasonCode : 'other',
     opts.reasonNote ? String(opts.reasonNote).slice(0, 2000) : null,
     opts.requestedBy || null, kind, opts.requestedByBorrowerId || null,
     opts.gateSnapshot ? JSON.stringify(opts.gateSnapshot) : null,
     opts.dealSnapshot ? JSON.stringify(opts.dealSnapshot) : null,
     opts.compensatingFactors ? JSON.stringify(opts.compensatingFactors) : null,
     opts.reRequestOf || null, severity, dueAtFor(type)]);
  return ins.rows[0];
}

/**
 * Request a co-borrower guaranty waiver (thin wrapper over requestException —
 * kept so every existing caller/test keeps working unchanged).
 */
async function requestGuarantyWaiver(client, { appId, subjectBorrowerId, reasonCode, reasonNote, requestedBy, compensatingFactors, reRequestOf }) {
  // Snapshot on the POOL, never the caller's tx client: a failed read inside a
  // transaction aborts the whole transaction (25P02) even when caught, which
  // would kill the INSERT that follows. Read-only, so no atomicity is lost.
  return requestException(client, {
    type: 'guaranty_waiver', appId, subjectBorrowerId, reasonCode, reasonNote, requestedBy,
    compensatingFactors, reRequestOf,
    dealSnapshot: await dealSnapshotFor(appId),
  });
}

/**
 * Request a "send the term-sheet package before clear-to-close" exception
 * (owner-directed 2026-07-23; request-anytime + per-requirement waivers
 * 2026-07-24). `gateSnapshot` is the full requirements picture at request time
 * ({ at, checks, outstanding }) so the reviewing super-admin sees exactly what
 * state prompted the request.
 */
async function requestEsignBeforeCtc(client, { appId, reasonCode, reasonNote, requestedBy, gateSnapshot, compensatingFactors, reRequestOf }) {
  return requestException(client, {
    type: 'esign_before_ctc', appId, reasonCode, reasonNote, requestedBy, gateSnapshot,
    compensatingFactors, reRequestOf,
    dealSnapshot: await dealSnapshotFor(appId), // pool, never the tx client (25P02)
  });
}

/**
 * Record a PRICING / GUIDELINE exception request (the studio's "Request an
 * exception" — previously a dead-end that left no record). The row is the
 * register entry; the caller keeps firing the existing escalation + admin
 * notification on top (both surfaces survive). Borrower-initiated asks are
 * recorded with requested_by_kind='borrower'.
 */
async function requestPricingException(client, { appId, reasonCode, reasonNote, requestedBy, requestedByKind, requestedByBorrowerId, compensatingFactors, reRequestOf }) {
  return requestException(client, {
    type: 'pricing_exception', appId, reasonCode, reasonNote, requestedBy,
    requestedByKind, requestedByBorrowerId, compensatingFactors, reRequestOf,
    dealSnapshot: await dealSnapshotFor(appId), // pool, never the tx client (25P02)
  });
}

/**
 * Record an ISSUANCE OVERRIDE — a super-admin pushed a status/issuance past a
 * fatal hard-warning (the R6.18 backstop). Born APPROVED: it documents an
 * in-the-moment authority action, so it never sits open and never routes to
 * the review box for a decision. Best-effort by design: callers sit on hot
 * status paths, so this NEVER throws — a failed record write must never block
 * or reverse the status change it documents (the audit_log row still exists).
 */
async function recordIssuanceOverride({ appId, staffId, note, snapshot }, client = db) {
  try {
    // gate_snapshot = the override context (action/tier/at — "the state that
    // prompted it"); deal_snapshot = the REAL deal economics, same as every
    // other type, so the register/drift read overrides consistently.
    const deal = await dealSnapshotFor(appId);
    const ins = await client.query(
      `INSERT INTO loan_exceptions
         (application_id, exception_type, status, reason_code, reason_note,
          requested_by, requested_by_kind, decided_by, decided_at, decision_note,
          gate_snapshot, deal_snapshot, severity)
       VALUES ($1,'issuance_override','approved','other',$2,$3,'staff',$3,now(),$4,$5,$6,'material')
       RETURNING *`,
      [appId,
       note ? String(note).slice(0, 2000) : 'Super-admin override past a fatal hard-warning',
       staffId || null,
       note ? String(note).slice(0, 1000) : null,
       snapshot ? JSON.stringify(snapshot) : null,
       deal ? JSON.stringify(deal) : null]);
    return ins.rows[0] || null;
  } catch (e) {
    try { console.warn('[loan-exceptions] issuance-override record skipped:', e.message); } catch (_) {}
    return null;
  }
}

/**
 * The most-recent 'esign_before_ctc' exception for a file (any status), or null —
 * the e-sign send-gate reads this: an APPROVED one lets a not-yet-ready file send
 * the term-sheet package early (the floor is still re-checked). Fails soft (null)
 * so an unreadable exception never GRANTS an early send.
 *
 * Expiry fails CLOSED at READ time: an approved row whose expires_at has passed
 * is presented as 'expired' even before the scheduled sweep flips the DB row —
 * so a lapsed approval can never grant a send in the window between lapsing and
 * the next sweep. The sweep remains the writer (and the notifier).
 */
async function latestEsignBeforeCtc(appId, client = db) {
  try {
    return presentExpiry(await latestForApp(appId, 'esign_before_ctc', client));
  } catch (_) { return null; }
}

/**
 * Decide (approve|deny) an OPEN exception. Guarded so a row can be decided once.
 * Returns the updated row, or null if it was already decided / no longer open.
 * The caller flips applications.co_borrower_pg_waived and audits.
 *
 * `extras`:
 *   waivedCodes — esign approvals only: the EXACT blocker codes this approval
 *                 waives (jsonb array). Absent/null keeps the legacy meaning
 *                 (ctc tier only).
 *   decidedGate — { at, outstanding:[{code,label,reason,tier}] }, the LIVE gate
 *                 picture at decision time; pins each waiver to the state the
 *                 super-admin actually saw (gate-disposition re-checks it).
 *   expiresAt   — approval validity (Date/ISO). Accepted ONLY on expirable
 *                 types; must be in the future and within 366 days. Past it the
 *                 sweep flips the row to 'expired' (which grants nothing).
 * A denial never stores waivers or expiry.
 */
async function decideException(id, decision, staffId, note, client = db, extras = {}) {
  const status = decision === 'approved' ? 'approved' : 'denied';
  const waived = status === 'approved' && Array.isArray(extras.waivedCodes)
    ? JSON.stringify(extras.waivedCodes.map(String)) : null;
  const decidedGate = status === 'approved' && extras.decidedGate
    ? JSON.stringify(extras.decidedGate) : null;
  let expiresAt = null;
  if (status === 'approved' && extras.expiresAt) {
    const row = await client.query(`SELECT exception_type FROM loan_exceptions WHERE id=$1`, [id]);
    const cfg = row.rows[0] ? typeConfig(row.rows[0].exception_type) : null;
    if (cfg && cfg.expirable) {
      const d = new Date(extras.expiresAt);
      const ms = d.getTime() - Date.now();
      if (isFinite(d.getTime()) && ms > 0 && ms <= 366 * 24 * 3600 * 1000) expiresAt = d;
    }
  }
  const r = await client.query(
    `UPDATE loan_exceptions
        SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4,
            waived_codes=$6, decided_gate=$7, expires_at=$8
      WHERE id=$1 AND status=$5
      RETURNING *`,
    [id, status, staffId || null, note ? String(note).slice(0, 1000) : null, OPEN, waived, decidedGate, expiresAt]);
  return r.rows[0] || null;
}

/**
 * The requester (or an admin) withdraws an OPEN exception. Recorded in the
 * withdrawer's OWN columns (withdrawn_by/withdrawn_at) — decided_by is no
 * longer overloaded (legacy withdrawn rows keep their decided_* stamps; readers
 * COALESCE across both). Returns the row or null.
 */
async function withdrawException(id, staffId, client = db) {
  const r = await client.query(
    `UPDATE loan_exceptions
        SET status='withdrawn', withdrawn_by=$2, withdrawn_at=now()
      WHERE id=$1 AND status=$3
      RETURNING *`,
    [id, staffId || null, OPEN]);
  return r.rows[0] || null;
}

/**
 * Clear (archive / close out) a HANDLED exception — housekeeping only. Moves a
 * decided/withdrawn/expired row to 'cleared'; does NOT change
 * co_borrower_pg_waived (an approved waiver stays in effect). An OPEN request
 * can NOT be cleared — it must be withdrawn or decided first (clearing an open
 * ask used to bury it without a decision trail). Returns the row or null.
 */
async function clearException(id, staffId, note, client = db) {
  const r = await client.query(
    `UPDATE loan_exceptions
        SET status='cleared', cleared_by=$2, cleared_at=now(), clear_note=$3
      WHERE id=$1 AND status NOT IN ('cleared', $4)
      RETURNING *`,
    [id, staffId || null, note ? String(note).slice(0, 1000) : null, OPEN]);
  return r.rows[0] || null;
}

/**
 * EXPIRY SWEEP — flip approved, time-boxed exceptions past their expires_at to
 * 'expired' (which grants nothing — the e-sign gate and every consumer honor
 * only status='approved'). Only expirable types are swept; guaranty_waiver can
 * never be flipped by a clock (belt on top of the decide-side restriction).
 * Returns the flipped rows (with file identity) so the caller can notify.
 */
async function expireDueApprovals(client = db) {
  const expirableTypes = Object.keys(EXCEPTION_TYPES).filter((t) => EXCEPTION_TYPES[t].expirable);
  if (!expirableTypes.length) return [];
  const r = await client.query(
    `UPDATE loan_exceptions e
        SET status='expired', expired_at=now()
      WHERE e.status='approved' AND e.expires_at IS NOT NULL AND e.expires_at < now()
        AND e.exception_type = ANY($1)
      RETURNING e.*`, [expirableTypes]);
  return r.rows;
}

/** Open (requested) rows past their due_at — the review-SLA aging feed. */
async function agingOpen(client = db) {
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.ys_loan_number, a.property_address,
            EXTRACT(EPOCH FROM (now() - e.requested_at))/3600.0 AS open_hours
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
      WHERE e.status='requested' AND e.due_at IS NOT NULL AND e.due_at < now()
      ORDER BY e.requested_at ASC
      LIMIT 50`);
  return r.rows;
}

/**
 * A staffer's OWN exceptions (the loan-officer's personal queue, outside any one
 * file). status: 'open' (requested) | 'all-active' (not cleared) | any specific status.
 */
async function listForRequester(staffId, { status = 'open', limit = 100 } = {}, client = db) {
  let where = 'WHERE e.requested_by = $1';
  const params = [staffId];
  if (status === 'open') where += ` AND e.status = 'requested'`;
  else if (status === 'all-active') where += ` AND e.status <> 'cleared'`;
  else if (status && status !== 'all') { where += ` AND e.status = $2`; params.push(status); }
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
            a.co_borrower_id, a.co_borrower_pg_waived,
            b.first_name, b.last_name,
            sb.first_name AS subject_first, sb.last_name AS subject_last,
            dc.full_name AS decided_by_name, wd.full_name AS withdrawn_by_name
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers sb ON sb.id = e.subject_borrower_id
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
       LEFT JOIN staff_users wd ON wd.id = e.withdrawn_by
       ${where}
      ORDER BY e.created_at DESC
      LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`, params);
  return r.rows.map((row) => presentExpiry({ ...row, reason_label: reasonLabelFor(row.exception_type, row.reason_code) }));
}

/* ---------------- comments (staff-only thread on an exception) ---------------- */

/** Post a comment on an exception. Returns the row (with author name), or throws. */
async function addComment(exceptionId, staffId, body, client = db) {
  const text = String(body || '').trim();
  if (!text) { const e = new Error('empty comment'); e.status = 400; throw e; }
  const ins = await client.query(
    `INSERT INTO loan_exception_comments (loan_exception_id, author_staff_id, body)
     VALUES ($1,$2,$3) RETURNING *`,
    [exceptionId, staffId || null, text.slice(0, 4000)]);
  const row = ins.rows[0];
  const name = staffId ? (await client.query(`SELECT full_name FROM staff_users WHERE id=$1`, [staffId])).rows[0] : null;
  row.author_name = name ? name.full_name : null;
  return row;
}

/** All comments on an exception, oldest first, with author names. */
async function listComments(exceptionId, client = db) {
  const r = await client.query(
    `SELECT c.*, su.full_name AS author_name
       FROM loan_exception_comments c
       LEFT JOIN staff_users su ON su.id = c.author_staff_id
      WHERE c.loan_exception_id = $1
      ORDER BY c.created_at ASC`, [exceptionId]);
  return r.rows;
}

/** The distinct staff who should hear about activity on an exception — the
 *  requester, the decider, the withdrawer, and everyone who has commented. Used
 *  to notify the OTHER participants when a new comment lands. */
async function commentParticipants(exceptionId, client = db) {
  const r = await client.query(
    `SELECT DISTINCT sid FROM (
       SELECT requested_by AS sid FROM loan_exceptions WHERE id=$1
       UNION SELECT decided_by FROM loan_exceptions WHERE id=$1
       UNION SELECT withdrawn_by FROM loan_exceptions WHERE id=$1
       UNION SELECT author_staff_id FROM loan_exception_comments WHERE loan_exception_id=$1
     ) s WHERE sid IS NOT NULL`, [exceptionId]);
  return r.rows.map((x) => x.sid);
}

/** Count of a staffer's OWN still-open (requested) exceptions — for the nav badge. */
async function requesterOpenCount(staffId, client = db) {
  try {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM loan_exceptions WHERE requested_by=$1 AND status='requested'`, [staffId]);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (_) { return 0; }
}

/** The current OPEN (requested) exception for a file+type, or null. */
async function openForApp(appId, type = 'guaranty_waiver', client = db) {
  const r = await client.query(
    `SELECT * FROM loan_exceptions
      WHERE application_id=$1 AND exception_type=$2 AND status='requested'
      ORDER BY created_at DESC LIMIT 1`, [appId, type]);
  return r.rows[0] || null;
}

/** The most-recent exception (any status) for a file+type — for showing state on the file. */
async function latestForApp(appId, type = 'guaranty_waiver', client = db) {
  const r = await client.query(
    `SELECT * FROM loan_exceptions
      WHERE application_id=$1 AND exception_type=$2
      ORDER BY created_at DESC LIMIT 1`, [appId, type]);
  return r.rows[0] || null;
}

/**
 * The full exception REGISTER for one file — every exception of every type,
 * newest first, with the identity joins the file panel needs. This is the
 * "what deviations does this loan carry" answer for diligence / loan-sale
 * conversations, so it never filters by status.
 */
async function registerForApp(appId, client = db) {
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.loan_amount,
            a.purchase_price AS live_purchase_price, a.rehab_budget AS live_rehab_budget, a.arv AS live_arv,
            sb.first_name AS subject_first, sb.last_name AS subject_last,
            rq.full_name AS requested_by_name, dc.full_name AS decided_by_name,
            wd.full_name AS withdrawn_by_name,
            rb.first_name AS requested_borrower_first, rb.last_name AS requested_borrower_last
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       LEFT JOIN borrowers sb ON sb.id = e.subject_borrower_id
       LEFT JOIN borrowers rb ON rb.id = e.requested_by_borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
       LEFT JOIN staff_users wd ON wd.id = e.withdrawn_by
      WHERE e.application_id = $1
      ORDER BY e.created_at DESC
      LIMIT 200`, [appId]);
  return r.rows.map((row) => presentExpiry({
    ...row,
    reason_label: reasonLabelFor(row.exception_type, row.reason_code),
    deal_drift: dealDrift(row),
  }));
}

/** A single exception row with file/requester/decider identity, or null. */
async function getById(id, client = db) {
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
            a.co_borrower_id, a.co_borrower_pg_waived,
            a.purchase_price AS live_purchase_price, a.rehab_budget AS live_rehab_budget, a.arv AS live_arv,
            b.first_name, b.last_name,
            sb.first_name AS subject_first, sb.last_name AS subject_last,
            rq.full_name AS requested_by_name, dc.full_name AS decided_by_name,
            wd.full_name AS withdrawn_by_name
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers sb ON sb.id = e.subject_borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
       LEFT JOIN staff_users wd ON wd.id = e.withdrawn_by
      WHERE e.id=$1`, [id]);
  const row = r.rows[0] || null;
  if (row) {
    row.reason_label = reasonLabelFor(row.exception_type, row.reason_code);
    row.deal_drift = dealDrift(row);
    return presentExpiry(row);
  }
  return row;
}

/**
 * List exceptions for the super-admin review box.
 *   status: 'open' (requested) | 'approved' | 'denied' | 'withdrawn' | 'cleared'
 *           | 'expired' | 'all'
 *   type:   an exception_type to filter to (optional)
 */
async function listExceptions({ status = 'open', type = null, limit = 100, offset = 0 } = {}, client = db) {
  const conds = [];
  const params = [];
  if (status === 'open') conds.push(`e.status = 'requested'`);
  else if (status && status !== 'all') { params.push(status); conds.push(`e.status = $${params.length}`); }
  if (type && isExceptionType(type)) { params.push(type); conds.push(`e.exception_type = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  const limSql = `LIMIT $${params.length}`;
  params.push(Math.max(0, Number(offset) || 0));
  const offSql = `OFFSET $${params.length}`;
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
            a.co_borrower_id, a.co_borrower_pg_waived,
            a.purchase_price AS live_purchase_price, a.rehab_budget AS live_rehab_budget, a.arv AS live_arv,
            b.first_name, b.last_name,
            sb.first_name AS subject_first, sb.last_name AS subject_last,
            rq.full_name AS requested_by_name, dc.full_name AS decided_by_name,
            wd.full_name AS withdrawn_by_name
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers sb ON sb.id = e.subject_borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
       LEFT JOIN staff_users wd ON wd.id = e.withdrawn_by
       ${where}
      ORDER BY e.created_at DESC
      ${limSql} ${offSql}`, params);
  return r.rows.map((row) => presentExpiry({
    ...row,
    reason_label: reasonLabelFor(row.exception_type, row.reason_code),
    deal_drift: dealDrift(row),
  }));
}

/**
 * The conditions (most often DOCUMENT REQUESTS) tagged to an exception, each with
 * the documents uploaded against it (owner-directed 2026-07-22). The conditions
 * still live on the file's checklist; this just gathers the ones tagged to THIS
 * exception so the exception detail can show the paperwork it depends on. Returns
 * [] when nothing is attached (or the column isn't present yet — fails soft).
 */
async function listConditions(exceptionId, client = db) {
  try {
    const items = await client.query(
      `SELECT id, label, borrower_label, status, item_kind, audience, is_required, signed_off_at, due_date, created_at
         FROM checklist_items
        WHERE loan_exception_id = $1
        ORDER BY created_at`, [exceptionId]);
    if (!items.rows.length) return [];
    const ids = items.rows.map((r) => r.id);
    const docs = await client.query(
      `SELECT id, checklist_item_id, filename, content_type, created_at
         FROM documents
        WHERE checklist_item_id = ANY($1) AND COALESCE(is_current, true)
        ORDER BY created_at DESC`, [ids]);
    const byItem = {};
    for (const d of docs.rows) { (byItem[d.checklist_item_id] = byItem[d.checklist_item_id] || []).push(d); }
    return items.rows.map((r) => ({ ...r, documents: byItem[r.id] || [] }));
  } catch (e) { console.warn('[loan-exceptions] listConditions skipped:', e.message); return []; }
}

/** Count of OPEN (requested) exceptions — for the nav badge. Fails soft. */
async function pendingCount(client = db) {
  try {
    const r = await client.query(`SELECT count(*)::int AS n FROM loan_exceptions WHERE status='requested'`);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (_) { return 0; }
}

/**
 * REGISTER METRICS — the reporting the register exists for: how many, how
 * decided, how fast, and what's aging. All aggregates, no row data; fails soft
 * to null so a metrics hiccup never breaks the box.
 */
async function metrics(client = db) {
  try {
    const [byTypeStatus, timing, aging, byRequester] = await Promise.all([
      client.query(
        `SELECT exception_type, status, count(*)::int AS n
           FROM loan_exceptions
          GROUP BY exception_type, status`),
      // Approval-rate accounting: an 'expired' row WAS approved (it lapsed, it
      // wasn't refused). A 'cleared' row no longer says which way it went, so it
      // counts toward timing (decided_at is real) but not the rate.
      client.query(
        `SELECT exception_type,
                count(*)::int AS decided,
                count(*) FILTER (WHERE status IN ('approved','expired'))::int AS approved,
                count(*) FILTER (WHERE status='denied')::int AS denied,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (decided_at - requested_at))/3600.0) AS median_hours,
                avg(EXTRACT(EPOCH FROM (decided_at - requested_at))/3600.0) AS avg_hours
           FROM loan_exceptions
          WHERE status IN ('approved','denied','expired','cleared') AND decided_at IS NOT NULL
          GROUP BY exception_type`),
      client.query(
        `SELECT count(*)::int AS open,
                count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now())::int AS overdue,
                EXTRACT(EPOCH FROM (now() - min(requested_at)))/3600.0 AS oldest_hours
           FROM loan_exceptions WHERE status='requested'`),
      client.query(
        `SELECT COALESCE(su.full_name, CASE WHEN e.requested_by_kind='borrower' THEN 'Borrower requests' ELSE 'Unknown' END) AS requester,
                count(*)::int AS n,
                count(*) FILTER (WHERE e.status IN ('approved','expired'))::int AS approved,
                count(*) FILTER (WHERE e.status='denied')::int AS denied
           FROM loan_exceptions e
           LEFT JOIN staff_users su ON su.id = e.requested_by
          WHERE e.exception_type <> 'issuance_override'
          GROUP BY 1 ORDER BY n DESC LIMIT 12`),
    ]);
    return {
      byTypeStatus: byTypeStatus.rows,
      timing: timing.rows.map((t) => ({
        exception_type: t.exception_type,
        decided: t.decided,
        approved: t.approved,
        denied: t.denied,
        // Rate over rows whose decision is still legible (approved/expired vs
        // denied); cleared rows keep feeding the timing but not the rate.
        approvalRate: (t.approved + t.denied) ? Math.round((t.approved / (t.approved + t.denied)) * 100) : null,
        medianHours: t.median_hours == null ? null : Math.round(Number(t.median_hours) * 10) / 10,
        avgHours: t.avg_hours == null ? null : Math.round(Number(t.avg_hours) * 10) / 10,
      })),
      openAging: aging.rows[0] ? {
        open: aging.rows[0].open,
        overdue: aging.rows[0].overdue,
        oldestHours: aging.rows[0].oldest_hours == null ? null : Math.round(Number(aging.rows[0].oldest_hours) * 10) / 10,
      } : { open: 0, overdue: 0, oldestHours: null },
      byRequester: byRequester.rows,
    };
  } catch (e) { console.warn('[loan-exceptions] metrics skipped:', e.message); return null; }
}

module.exports = {
  REASON_CODES, isReasonCode,
  ESIGN_BEFORE_CTC_REASONS, isEsignReasonCode,
  PRICING_EXCEPTION_REASONS, ISSUANCE_OVERRIDE_REASONS,
  COMPENSATING_FACTORS, sanitizeCompensatingFactors,
  EXCEPTION_TYPES, isExceptionType, typeConfig,
  reasonCodesFor, reasonLabelFor, isReasonCodeFor,
  dealSnapshotFor, dueAtFor, dealDrift, presentExpiry,
  requestException, requestGuarantyWaiver, requestEsignBeforeCtc, requestPricingException,
  recordIssuanceOverride, latestEsignBeforeCtc,
  decideException, withdrawException, clearException,
  expireDueApprovals, agingOpen,
  openForApp, latestForApp, registerForApp, getById, listExceptions, pendingCount, metrics,
  listForRequester, requesterOpenCount,
  addComment, listComments, commentParticipants,
  listConditions,
};
