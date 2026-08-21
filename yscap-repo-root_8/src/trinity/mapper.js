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
  // "Change Date to Inspect" (67) is Trinity asking US for a new date. It deliberately
  // carries NO state (it says nothing about progress — see readStatus below), but it is
  // still somebody waiting on us, which is exactly what the attention flag is for: with
  // it absent the desk showed an order sitting in "ordered" with nothing to explain why
  // it was not moving. Confirmed against the LIVE production status list on 2026-08-16,
  // where it is one of only two of the nineteen statuses we had no opinion about (the
  // other, "Recurring" (113), is a scheduling concept and correctly stays silent).
  STATUS.CHANGE_DATE,
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

/**
 * The first of several candidate numbers that Trinity will actually accept.
 *
 * Trinity requires at least ONE phone per party but does not care which field it
 * arrives in, so a file that holds only a mobile number is perfectly orderable — we
 * just have to look past the empty `phone` column to find it. Returns undefined when
 * none of them can be cleaned, which is what makes the order refuse rather than send a
 * payload we already know will be rejected.
 */
function firstUsablePhone(candidates, max = 20) {
  for (const c of candidates || []) {
    const p = cleanPhone(c, max);
    if (p) return p;
  }
  return undefined;
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
 * The number of decimal places Trinity actually PRESERVES on a percentage.
 *
 * MEASURED, not assumed (sandbox, 2026-08-16, order 735315). The same true value —
 * 33.333333% of a $1,000,000 line, i.e. exactly $333,333.33 drawn — was sent at 2, 4, 6,
 * 8, 10 and 12 decimal places and read straight back:
 *
 *     dp | returned      | what the inspector is shown as drawn | drift
 *     ---+---------------+--------------------------------------+---------
 *      2 | 33.33         | $333,300.00                          | -$33.33
 *      4 | 33.3333       | $333,333.00                          |  -$0.33
 *      6 | 33.333333     | $333,333.33                          |   $0.00
 *      8 | 33.333333     | $333,333.33                          |   $0.00
 *     10 | 33.333333     | $333,333.33                          |   $0.00
 *     12 | 33.333333     | $333,333.33                          |   $0.00
 *
 * Six is where it stops: anything finer is silently rounded to six, and anything
 * coarser loses real money off the historical-draw figure. The first build used FOUR,
 * on the stated belief that it "keeps even a $1,000,000 line accurate to well under a
 * cent". That belief was wrong — the error scales with the size of the line
 * (itemCost × 5e-7, so ±$0.50 on a $1,000,000 line), and it was showing the inspector
 * $333,333.00 drawn where the borrower had actually been paid $333,333.33.
 *
 * At six the residual is itemCost × 5e-9 — half a cent on a $1,000,000 line, and under
 * a cent on anything up to $2,000,000. A line item larger than that is not a line item.
 */
const PCT_DECIMALS = 6;

/**
 * The percentage that carries the historical draws.
 *
 * Rounded to PCT_DECIMALS (see above — measured against the live API) and CLAMPED to
 * 0..100, because an over-drawn line (possible after an approved over-limit request)
 * would otherwise send more than 100 and be refused outright. A zero/absent budget
 * yields 0 rather than a division by zero.
 */
function previousPct(previousDrawnCents, budgetedCents) {
  const b = Math.round(Number(budgetedCents || 0));
  const d = Math.round(Number(previousDrawnCents || 0));
  if (b <= 0 || d <= 0) return 0;
  const pct = (d / b) * 100;
  const f = 10 ** PCT_DECIMALS;
  return Math.min(100, Math.max(0, Math.round(pct * f) / f));
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
  // Trinity REFUSES an order whose line keys collide (400, verified) — so this runs on
  // the way out, always, rather than being left to the caller to remember.
  return uniquifyKeys(out);
}

/**
 * The durable per-line crosswalk key. Our job-item id when we have one (it is the
 * identity the rest of the draw stack uses), else the SOW line key. This is what makes
 * "what did the inspector approve on OUR line" answerable — Trinity's budget read-back
 * returns `number: 0` (verified on every line of every order), so identity can NEVER
 * come from the ordinal, and their `description` is not identity either (a real budget
 * carries two lines called "Kitchen" — verified: both survive, told apart only by this
 * key).
 */
function customerKeyForLine(l) {
  if (l.sitewire_job_item_id != null && l.sitewire_job_item_id !== '') return `ji-${l.sitewire_job_item_id}`;
  if (l.sow_line_key) return `sow-${l.sow_line_key}`;
  return `line-${trim(l.name || 'x', 40).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Make a set of keys unique, keeping the first occurrence untouched.
 *
 * TRINITY ENFORCES THIS AND REFUSES THE WHOLE ORDER OTHERWISE — verified 2026-08-16:
 * two line items sharing a customerKey answers
 *   400 `2 line items have CustomerKey "ji-3001", line item keys must be unique within
 *        an order.`
 * That is good news (their side polices the crosswalk too), but it means a collision is
 * not a degraded line — it is a REFUSED INSPECTION. Our own keys are derived, and the
 * last-resort form is a slug of the line's NAME, so two unnamed-but-identically-named
 * lines on one budget would collide and take the whole order down. Suffixing the
 * DUPLICATE (never the first) keeps every key stable across re-orders for every line
 * that was already unique.
 */
function uniquifyKeys(items) {
  const seen = new Map();
  for (const it of items) {
    const base = it.customerKey;
    if (!seen.has(base)) { seen.set(base, 1); continue; }
    const n = seen.get(base) + 1;
    seen.set(base, n);
    it.customerKey = trim(`${base}-${n}`, 255);
  }
  return items;
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
  /* WHAT KIND OF ORDER THIS IS — 'draw' (the default, and byte-identical to before) or
     'budget_review', the pre-closing feasibility / budget review on form 159
     (owner-directed 2026-08-21). They share this builder because they share Trinity's
     schema exactly (`DollarLineItem…ProjectModel` — forms 19/139/150/159/1074/1079/1081
     all use it), and a second builder would be a second place the contractor rules, the
     phone rules and the line-key uniquifier could drift.

     It changes exactly ONE rule, below: a DRAW must have a line asking for money, and a
     REVIEW asks for none by definition — it sends the whole budget for somebody to read.
     Everything else about the payload is identical. */
  kind = 'draw',
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

  // ---- PHONES: required, and the swagger says the opposite ----------------
  // Every phone field on BorrowerModel and ContractorModel is documented `nullable:
  // true`. It is not true. Verified live (sandbox, 2026-08-16) — an order with no phone
  // on either party is refused 400 with:
  //
  //   "Borrower.['Phone','OtherPhone','HomePhone,'MobilePhone']":
  //       ["At least one is required ['Phone','OtherPhone','HomePhone,'MobilePhone']."]
  //   "Contractor.['Phone','MobilePhone']":
  //       ["At least one is required ['Phone','MobilePhone']."]
  //
  // (their message contains a typo — a missing quote before 'MobilePhone' — which is
  // quoted here verbatim so a future reader can grep for what Trinity actually sends.)
  //
  // This matters because `cleanPhone` deliberately OMITS a phone it cannot parse rather
  // than sending junk — the right call on its own, but it meant a file holding a
  // malformed or missing phone produced a payload Trinity rejects, and the desk saw a
  // raw validation error instead of "add the borrower's phone number first". An
  // inspector has to be able to telephone somebody to get onto the property, so this is
  // a genuine requirement rather than a schema quirk, and it is checked HERE, before
  // anything is sent.
  const bPhone = firstUsablePhone([
    borrower && borrower.phone, borrower && borrower.mobilePhone,
    borrower && borrower.homePhone, borrower && borrower.otherPhone,
  ], 20);
  if (!bPhone) {
    problems.push(String(borrower && (borrower.phone || borrower.mobilePhone || borrower.homePhone || borrower.otherPhone) || '').trim()
      ? "the borrower's phone number is not a number Trinity can accept"
      : "the borrower's phone number is missing (Trinity requires one so the inspector can reach them)");
  }
  const cPhone = firstUsablePhone([contractor && contractor.phone, contractor && contractor.mobilePhone], 40);
  if (!cPhone) {
    problems.push(String(contractor && (contractor.phone || contractor.mobilePhone) || '').trim()
      ? "the contractor's phone number is not a number Trinity can accept"
      : "the contractor's phone number is missing (Trinity requires one so the inspector can arrange access)");
  }

  const lineItems = toLineItems(lines);
  if (!lineItems.length) problems.push('the construction budget has no line items');
  // A DRAW must be asking for money on at least one line; a BUDGET REVIEW asks for none —
  // it sends the whole budget so Trinity can read it, which is the point of the product.
  if (kind !== 'budget_review' && !lineItems.some((l) => l.isRequested)) {
    problems.push('no line on this draw has an amount requested');
  }

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
      // Whichever number we could actually use, sent in the field Trinity checks first.
      phone: bPhone,
      mobilePhone: cleanPhone(borrower && borrower.mobilePhone, 20),
    },
    contractor: {
      name: cName, companyName: cCompany, emailAddress: cEmail,
      phone: cPhone,
      mobilePhone: cleanPhone(contractor && contractor.mobilePhone, 30),
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
// PROOF: did their system actually take the budget we sent?
// ---------------------------------------------------------------------------
/**
 * Reconcile Trinity's stored budget against the line items we sent, line by line.
 *
 * Owner-directed 2026-08-16: *"make sure their system really understands our
 * construction budget … really understands how much was drawn already from each and
 * every item … how we force them to be linked together."* Sending a budget and having
 * the order accepted is NOT the same as knowing it arrived intact, and nothing checked.
 * This is the check, and it runs on every order.
 *
 * It compares the four things an inspector actually works from, per line:
 *   · `itemCost`                  — the construction budget for that item
 *   · `previousPercentCompleted`  — reconstituted back to CENTS and compared to the
 *                                   money already drawn (this is the one the owner
 *                                   cares most about, and the one a rounding change
 *                                   would silently break)
 *   · `amountRequested`           — what this draw is asking for
 *   · `customerKey`               — OUR key on THEIR line: the crosswalk itself
 *
 * PURE. `sent` is what `toLineItems` produced (dollars, as sent); `remote` is the budget
 * read straight back. Returns `{ok, problems[], summary}` — `problems` is plain language
 * for the desk, never a stack trace, and is capped so one badly-broken order cannot
 * write a novel into a text column.
 *
 * THE CENTS TOLERANCE IS ONE CENT PER LINE, AND THAT IS NOT SLOP. The drawn figure makes
 * a round trip through a percentage (cents → % at 6 dp → cents), which is exact for
 * every realistic line but is still a conversion; a single cent of dust must not raise
 * an alarm on an order that is in fact correct. Anything larger is a real disagreement.
 */
const CENT_TOLERANCE = 1;
const MAX_PROBLEMS = 12;

function verifyRemoteBudget(sent, remote) {
  const problems = [];
  const items = (remote && Array.isArray(remote.lineItems)) ? remote.lineItems : null;
  if (!items) {
    return { ok: false, problems: ['Trinity returned no budget to check.'], summary: null, checked: 0 };
  }

  const byKey = new Map();
  for (const it of items) if (it && it.customerKey != null) byKey.set(String(it.customerKey), it);

  let checked = 0;
  for (const s of sent || []) {
    const t = byKey.get(String(s.customerKey));
    if (!t) {
      // The crosswalk is broken for this line: whatever the inspector approves on it,
      // we would not know which of our budget lines it belongs to.
      problems.push(`"${trim(s.description, 40)}" is not on Trinity's budget under our reference.`);
      continue;
    }
    checked++;
    const ourCost = Math.round(Number(s.itemCost || 0) * 100);
    const theirCost = Math.round(Number(t.itemCost || 0) * 100);
    if (Math.abs(theirCost - ourCost) > CENT_TOLERANCE) {
      problems.push(`"${trim(s.description, 40)}": budget ${usdish(ourCost)} on our side, ${usdish(theirCost)} on Trinity's.`);
    }
    const ourReq = Math.round(Number(s.amountRequested || 0) * 100);
    const theirReq = Math.round(Number(t.amountRequested || 0) * 100);
    if (Math.abs(theirReq - ourReq) > CENT_TOLERANCE) {
      problems.push(`"${trim(s.description, 40)}": this draw asks for ${usdish(ourReq)}, Trinity recorded ${usdish(theirReq)}.`);
    }
    // The historical draw, converted back the way Trinity's own screen does it.
    const ourDrawn = Math.round(ourCost * (Number(s.previousPercentCompleted || 0) / 100));
    const theirDrawn = Math.round(theirCost * (Number(t.previousPercentCompleted || 0) / 100));
    if (Math.abs(theirDrawn - ourDrawn) > CENT_TOLERANCE) {
      problems.push(`"${trim(s.description, 40)}": already drawn ${usdish(ourDrawn)} on our side, Trinity shows ${usdish(theirDrawn)}.`);
    }
  }

  // A line on THEIR budget that is not on ours is not an error — Trinity's team may add
  // one (a trip fee) — but the desk should know it is there, because it will turn up in
  // the results with no line of ours to belong to.
  const extra = items.filter((it) => !(sent || []).some((s) => String(s.customerKey) === String(it.customerKey)));

  const t = (remote && remote.total) || {};
  const summary = {
    lines: items.length,
    checked,
    extraLines: extra.length,
    extraNames: extra.slice(0, 5).map((e) => trim(e.description, 40)),
    remoteBudgetCents: Math.round(Number(t.totalCost || 0) * 100),
    remoteDrawnCents: Math.round(Number(t.previousCostCompleted || 0) * 100),
  };

  const capped = problems.slice(0, MAX_PROBLEMS);
  if (problems.length > MAX_PROBLEMS) capped.push(`…and ${problems.length - MAX_PROBLEMS} more.`);
  return { ok: problems.length === 0, problems: capped, summary, checked };
}

/** Plain dollars for a desk message. Not money math — display only. */
function usdish(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  STATUS, COMPLETED_IDS, ATTENTION_IDS, ORDER_OF_STATE, PCT_DECIMALS,
  readStatus, nextState,
  previousPct, toLineItems, customerKeyForLine, uniquifyKeys, buildOrderPayload,
  readResults, toApprovalEntries, verifyRemoteBudget,
  _internals: { cleanPhone, firstUsablePhone, cleanZip, cleanEmail, splitName, trim, centsToDollars, usdish },
};
