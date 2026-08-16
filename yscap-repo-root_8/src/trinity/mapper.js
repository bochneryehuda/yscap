'use strict';
/**
 * Trinity mapper — PURE. No database, no network, no requires, so every rule below is
 * unit-testable on its own and can be reasoned about without a running system.
 *
 * It answers the two questions the whole integration turns on:
 *
 *   OUT — how does OUR construction budget, with the money already drawn on it, become
 *         Trinity's form-19 line items so the inspector sees the budget, the historical
 *         draws, and how much is still available on every single line?
 *   BACK — what did the inspector actually approve, per line, in CENTS?
 *
 * The conversion is between two different shapes and that is the whole difficulty:
 * we keep DOLLARS DRAWN per line, Trinity keeps PERCENT COMPLETE per line. Going out
 * the conversion is exact enough to be safe (see previousPct). Coming back it can leave
 * sub-cent dust, so readResults RECONCILES to the cent and REFUSES rather than guesses
 * when the numbers do not add up — the same never-guess doctrine as the rest of the
 * draw stack. Money is never floated: it is cents in, cents out.
 */

// ---------------------------------------------------------------------------
// Trinity order statuses -> our five-state ladder (verified: GET /orders/statuses)
// ---------------------------------------------------------------------------
const STATUS = {
  SETUP_ONLY: 5, NEW: 6, SEARCHING: 7, ACCEPTED_BY_INSPECTOR: 8, IN_REVIEW: 9,
  ON_HOLD: 13, CANCELED: 14, REPORT_COMPLETED: 12, IN_REVIEW_PENDING: 53,
  REPORT_PENDING_REVISION: 55, CHANGE_DATE: 67, REPORT_NO_CHANGE: 71,
  REPORT_REVISED: 72, REPORT_BUDGET_CHANGED: 83, WAITING_DOCS: 101,
  WAITING_PAYMENT: 112, REPORT_REVISION_REQUESTED: 223, WAITING_DOCS_RELEASE: 224,
  ASSIGNED: 44,
};

// Every "Report Completed" flavour means the report exists and can be read.
const COMPLETED_IDS = new Set([
  STATUS.REPORT_COMPLETED, STATUS.REPORT_NO_CHANGE, STATUS.REPORT_REVISED,
  STATUS.REPORT_BUDGET_CHANGED, STATUS.REPORT_PENDING_REVISION, STATUS.REPORT_REVISION_REQUESTED,
]);
// Trinity is waiting on somebody — surfaced to the desk as an attention flag, not a
// state of its own (the work has still been inspected/ordered).
const ATTENTION_IDS = new Set([
  STATUS.ON_HOLD, STATUS.WAITING_DOCS, STATUS.WAITING_DOCS_RELEASE, STATUS.WAITING_PAYMENT,
]);

const STATE_BY_STATUS = new Map([
  [STATUS.SETUP_ONLY, 'ordered'], [STATUS.NEW, 'ordered'], [STATUS.SEARCHING, 'ordered'],
  [STATUS.ACCEPTED_BY_INSPECTOR, 'scheduled'], [STATUS.ASSIGNED, 'scheduled'],
  [STATUS.IN_REVIEW, 'inspected'], [STATUS.IN_REVIEW_PENDING, 'inspected'],
  [STATUS.ON_HOLD, 'inspected'], [STATUS.WAITING_DOCS, 'inspected'],
  [STATUS.WAITING_DOCS_RELEASE, 'inspected'], [STATUS.WAITING_PAYMENT, 'inspected'],
  [STATUS.CANCELED, 'cancelled'],
]);
for (const id of COMPLETED_IDS) STATE_BY_STATUS.set(id, 'report_received');

// Our ladder, in order, so a status that arrives out of order can never move a file
// BACKWARDS (Trinity re-opening an order for a revision must not un-inspect it).
const ORDER_OF_STATE = ['requested', 'ordered', 'scheduled', 'inspected', 'report_received', 'entered'];

/**
 * What a Trinity status means for us.
 * @returns {{state:string|null, completed:boolean, attention:boolean, cancelled:boolean}}
 *   state === null means "no opinion" — e.g. "Change Date to Inspect" (67), which says
 *   something about the schedule and nothing about progress, so it must not move us.
 */
function readStatus(statusId) {
  const id = Number(statusId);
  if (!Number.isFinite(id)) return { state: null, completed: false, attention: false, cancelled: false };
  return {
    state: STATE_BY_STATUS.has(id) ? STATE_BY_STATUS.get(id) : null,
    completed: COMPLETED_IDS.has(id),
    attention: ATTENTION_IDS.has(id),
    cancelled: id === STATUS.CANCELED,
  };
}

/**
 * Advance our state without ever going backwards — EXCEPT to 'cancelled', which is
 * terminal and may arrive from anywhere. 'entered' is ours (a human recorded the
 * decision) and Trinity can never move a file off it.
 */
function nextState(current, incoming) {
  if (!incoming) return current;
  if (incoming === 'cancelled') return 'cancelled';
  if (current === 'cancelled' || current === 'entered') return current;
  const a = ORDER_OF_STATE.indexOf(current);
  const b = ORDER_OF_STATE.indexOf(incoming);
  if (b < 0) return current;
  return b > a ? incoming : current;
}

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------
const centsToDollars = (c) => Math.round(Number(c || 0)) / 100;
const trim = (s, n) => {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) : v;
};
const nullIfBlank = (s) => (s && String(s).trim() ? String(s).trim() : null);

// Trinity's phone pattern. A malformed phone fails the whole order, and a phone is
// never worth that — an unparseable one is simply omitted.
const PHONE_RE = /^(\+[0-9]{1,3}[\s]?)?[(]?[0-9]{3}[)]?[-\s.]?[0-9]{3}[-\s.]?[0-9]{4,6}(\s?(x|ext\.?)\s?\d+)?$/;
function cleanPhone(v, max = 20) {
  const raw = String(v || '').trim();
  if (!raw) return undefined;
  if (raw.length <= max && PHONE_RE.test(raw)) return raw;
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length !== 10) return undefined;          // never guess at a partial number
  const formatted = `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  return formatted.length <= max ? formatted : undefined;
}

const ZIP_RE = /^\d{5}(?:[-\s]\d{4})?$/;
function cleanZip(v) {
  const raw = String(v || '').trim();
  if (ZIP_RE.test(raw)) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length >= 5) return d.slice(0, 5);
  return null;                                       // caller refuses — never a fake zip
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanEmail(v, max = 250) {
  const raw = String(v || '').trim();
  if (!raw || raw.length > max || !EMAIL_RE.test(raw)) return undefined;
  return raw;
}

/** Split a stored one-line name into the first/last Trinity insists on. */
function splitName(full, fallbackFirst = 'Borrower', fallbackLast = 'Borrower') {
  const parts = String(full || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!parts.length) return { firstName: fallbackFirst, lastName: fallbackLast };
  if (parts.length === 1) return { firstName: trim(parts[0], 50), lastName: trim(parts[0], 50) };
  return { firstName: trim(parts[0], 50), lastName: trim(parts.slice(1).join(' '), 50) };
}

// ---------------------------------------------------------------------------
// OUT: our budget + historical draws -> Trinity form-19 line items
// ---------------------------------------------------------------------------
/**
 * The percentage that carries the historical draws.
 *
 * Rounded to 4 decimals — their doubles hold it comfortably and it keeps even a
 * $1,000,000 line accurate to well under a cent — and CLAMPED to 0..100, because an
 * over-drawn line (possible after an approved over-limit request) would otherwise send
 * more than 100 and be refused outright. A zero/absent budget yields 0 rather than a
 * division by zero.
 */
function previousPct(previousDrawnCents, budgetedCents) {
  const b = Math.round(Number(budgetedCents || 0));
  const d = Math.round(Number(previousDrawnCents || 0));
  if (b <= 0 || d <= 0) return 0;
  const pct = (d / b) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10000) / 10000));
}

/**
 * Our lines -> Trinity's lineItems.
 *
 * @param lines [{ sitewire_job_item_id, sow_line_key, name, budgeted_cents,
 *                 previous_drawn_cents, requested_cents }]
 * Every line on the file is sent, not only the requested ones: the inspector must see
 * the WHOLE budget (that is what "how much is still available for each and every line
 * item" means), with `isRequested` marking the ones this draw is asking about.
 */
function toLineItems(lines) {
  const out = [];
  for (const l of lines || []) {
    const budgeted = Math.round(Number(l.budgeted_cents || 0));
    if (budgeted <= 0) continue;                       // a $0 line tells an inspector nothing
    const requested = Math.max(0, Math.round(Number(l.requested_cents || 0)));
    const drawn = Math.max(0, Math.round(Number(l.previous_drawn_cents || 0)));
    out.push({
      customerKey: trim(customerKeyForLine(l), 255),
      description: trim(l.name || 'Budget line', 255) || 'Budget line',
      itemCost: centsToDollars(budgeted),
      amountRequested: centsToDollars(requested),
      previousPercentCompleted: previousPct(drawn, budgeted),
      isRequested: requested > 0,
    });
  }
  return out;
}

/**
 * The durable per-line crosswalk key. Our job-item id when we have one (it is the
 * identity the rest of the draw stack uses), else the SOW line key. This is what makes
 * "what did the inspector approve on OUR line" answerable — Trinity's budget read-back
 * returns `number: 0` (verified), so identity can NEVER come from the ordinal.
 */
function customerKeyForLine(l) {
  if (l.sitewire_job_item_id != null && l.sitewire_job_item_id !== '') return `ji-${l.sitewire_job_item_id}`;
  if (l.sow_line_key) return `sow-${l.sow_line_key}`;
  return `line-${trim(l.name || 'x', 40).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * The full create-order payload (project + order in one call).
 *
 * Returns { payload, problems } — `problems` names, in plain language, everything that
 * makes the order unsendable. We refuse rather than invent: Trinity requires a
 * contractor email, and inventing one would send a real inspector to chase a fake
 * address.
 */
function buildOrderPayload({
  companyId, projectNumber, projectCustomerKey, orderCustomerKey,
  address, appraisal, units, propertyType, projectType, totalProjectCostCents,
  borrower, contractor, analyst, lines, dateToPerformInspection, rush = false,
}) {
  const problems = [];

  const street = trim(address && address.street, 100);
  const city = trim(address && address.city, 50);
  const state = trim(address && address.state, 2).toUpperCase();
  const zip = cleanZip(address && address.zip);
  if (!street) problems.push('the property street address is missing');
  if (!city) problems.push('the property city is missing');
  if (!state || state.length !== 2) problems.push('the property state is missing');
  if (!zip) problems.push('the property ZIP code is missing');
  if (!projectNumber) problems.push('the loan number is missing');

  const bName = splitName(borrower && borrower.name, 'Borrower', 'Borrower');
  if (!(borrower && String(borrower.name || '').trim())) problems.push("the borrower's name is missing");

  const cEmail = cleanEmail(contractor && contractor.email, 150);
  const cName = trim((contractor && contractor.name) || '', 50);
  const cCompany = trim((contractor && contractor.companyName) || cName, 75);
  // Trinity's schema REQUIRES all three. Never fabricate a contact an inspector will call.
  if (!cName) problems.push("the contractor's name is missing");
  if (!cCompany) problems.push("the contractor's company name is missing");
  if (!cEmail) problems.push("the contractor's email address is missing");

  const lineItems = toLineItems(lines);
  if (!lineItems.length) problems.push('the construction budget has no line items');
  if (!lineItems.some((l) => l.isRequested)) problems.push('no line on this draw has an amount requested');

  const aName = splitName((analyst && analyst.name) || 'Draw Coordinator', 'Draw', 'Coordinator');

  const payload = {
    companyId,
    projectNumber: trim(projectNumber, 50),
    customerKey: trim(projectCustomerKey, 255) || undefined,
    totalProjectCost: totalProjectCostCents != null ? centsToDollars(totalProjectCostCents) : undefined,
    type: projectType === 'NewConstruction' ? 'NewConstruction' : 'Remodel',
    property: {
      address: { street, city, state, zipCode: zip, county: nullIfBlank(address && address.county) || undefined },
      appraisal: appraisal && appraisal.valueCents
        ? {
          value: centsToDollars(appraisal.valueCents),
          datePerformed: appraisal.datePerformed || undefined,
          performedBy: trim(appraisal.performedBy, 100) || undefined,
        }
        : undefined,
      numberOfUnits: Number.isFinite(Number(units)) && Number(units) > 0 ? Math.round(Number(units)) : undefined,
      type: propertyType === 'Commercial' ? 'Commercial' : 'Residential',
    },
    borrower: {
      firstName: bName.firstName || 'Borrower',
      lastName: bName.lastName || 'Borrower',
      emailAddress: cleanEmail(borrower && borrower.email, 150),
      phone: cleanPhone(borrower && borrower.phone, 20),
    },
    contractor: {
      name: cName, companyName: cCompany, emailAddress: cEmail,
      phone: cleanPhone(contractor && contractor.phone, 40),
    },
    order: {
      companyId,
      customerKey: trim(orderCustomerKey, 255),
      rush: !!rush,
      analyst: {
        firstName: aName.firstName, lastName: aName.lastName,
        emailAddress: cleanEmail(analyst && analyst.email, 250),
      },
      dateToPerformInspection: dateToPerformInspection || undefined,
      lineItems,
    },
  };

  return { payload, problems };
}

// ---------------------------------------------------------------------------
// BACK: Trinity's completed budget -> what the inspector approved, in CENTS
// ---------------------------------------------------------------------------
/**
 * Convert the completed budget into per-line approved cents.
 *
 *   approved(line) = (percentCompleted − previousPercentCompleted)/100 × itemCost
 *   total          = total.costCompleted − total.previousCostCompleted
 *
 * Two things make this trustworthy rather than merely plausible:
 *
 *  1. RECONCILIATION. Percentages carry sub-cent dust, so the per-line cents are
 *     rounded and any residual against Trinity's own total is absorbed by the LARGEST
 *     approved line. Σ lines === total, to the cent, always.
 *  2. REFUSAL. If a line moved BACKWARDS (a negative approval), or the residual is too
 *     large to be rounding (more than a cent per line plus a cent), nothing is
 *     believed — `ok:false` with a reason, and a human looks. A wrong number here would
 *     silently change what a borrower is paid.
 *
 * `sentLines` is our record of what we sent, keyed by customerKey, so the result comes
 * back tied to OUR job-item ids rather than to Trinity's ordinals.
 */
function readResults(budget, sentLines) {
  const items = (budget && Array.isArray(budget.lineItems)) ? budget.lineItems : [];
  if (!items.length) return { ok: false, reason: 'Trinity returned no budget lines to read.', lines: [], approvedCents: 0 };

  const byKey = new Map();
  for (const s of sentLines || []) if (s && s.customer_key) byKey.set(String(s.customer_key), s);

  const lines = [];
  let sum = 0;
  for (const it of items) {
    const budgetedCents = Math.round(Number(it.itemCost || 0) * 100);
    const prevPct = Number(it.previousPercentCompleted || 0);
    const nowPct = Number(it.percentCompleted || 0);
    const deltaPct = nowPct - prevPct;
    if (deltaPct < -0.0001) {
      return {
        ok: false, lines: [], approvedCents: 0,
        reason: `Trinity reports "${trim(it.description, 60)}" going backwards (${prevPct}% → ${nowPct}%). A human needs to look at this report.`,
      };
    }
    const approved = Math.max(0, Math.round((deltaPct / 100) * budgetedCents));
    const key = it.customerKey != null ? String(it.customerKey) : null;
    const sent = key ? byKey.get(key) : null;
    lines.push({
      customer_key: key,
      trinity_line_id: it.id != null ? Number(it.id) : null,
      sitewire_job_item_id: sent ? sent.sitewire_job_item_id : null,
      sow_line_key: sent ? sent.sow_line_key : null,
      name: trim(it.description, 255),
      budgeted_cents: budgetedCents,
      requested_cents: Math.round(Number(it.amountRequested || 0) * 100),
      previous_pct: prevPct,
      completed_pct: nowPct,
      approved_cents: approved,
      inspector_remarks: nullIfBlank(it.remarks),
    });
    sum += approved;
  }

  // Trinity's own total is the authority; ours must reconcile to it.
  const t = budget.total || {};
  const totalCents = Math.round((Number(t.costCompleted || 0) - Number(t.previousCostCompleted || 0)) * 100);
  const target = Number.isFinite(totalCents) && totalCents >= 0 ? totalCents : sum;

  const residual = target - sum;
  const tolerance = lines.length + 1;                 // a cent of dust per line, plus one
  if (Math.abs(residual) > tolerance) {
    return {
      ok: false, lines: [], approvedCents: 0,
      reason: `Trinity's line items add up to ${(sum / 100).toFixed(2)} but its own total says ${(target / 100).toFixed(2)}. A human needs to check this report before anything is released.`,
    };
  }
  if (residual !== 0 && lines.length) {
    // Absorb the dust on the largest approved line — the one where a cent is least
    // likely to be noticed and can never make another line wrong.
    let bi = 0;
    for (let i = 1; i < lines.length; i++) if (lines[i].approved_cents > lines[bi].approved_cents) bi = i;
    lines[bi].approved_cents = Math.max(0, lines[bi].approved_cents + residual);
    sum = lines.reduce((s, l) => s + l.approved_cents, 0);
  }

  return {
    ok: true, lines, approvedCents: sum,
    totalBudgetCents: Math.round(Number(t.totalCost || 0) * 100),
    completedCents: Math.round(Number(t.costCompleted || 0) * 100),
    percentComplete: Number(t.percentCompleted || 0),
  };
}

/**
 * The per-line decision in the shape `portal-draws.approveTrinityRequest` expects
 * (which caps every line at what was requested — over-approving is a deliberate human
 * act in Sitewire, never something an adapter does on its own).
 */
function toApprovalEntries(resultLines, requestLines) {
  const wanted = new Map();
  for (const r of requestLines || []) if (r && r.sitewire_job_item_id != null) wanted.set(Number(r.sitewire_job_item_id), Number(r.requested_cents || 0));
  const out = [];
  for (const l of resultLines || []) {
    if (l.sitewire_job_item_id == null) continue;      // a line that is not on this draw
    const jid = Number(l.sitewire_job_item_id);
    if (!wanted.has(jid)) continue;
    out.push({ sitewire_job_item_id: jid, approved_cents: Math.min(Number(l.approved_cents || 0), wanted.get(jid)) });
  }
  return out;
}

module.exports = {
  STATUS, COMPLETED_IDS, ATTENTION_IDS, ORDER_OF_STATE,
  readStatus, nextState,
  previousPct, toLineItems, customerKeyForLine, buildOrderPayload,
  readResults, toApprovalEntries,
  _internals: { cleanPhone, cleanZip, cleanEmail, splitName, trim, centsToDollars },
};
