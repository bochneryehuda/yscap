'use strict';
/**
 * src/trinity/budget-review.js — the pre-closing FEASIBILITY / BUDGET REVIEW, Trinity form 159.
 *
 * OWNER-DIRECTED 2026-08-21: *"Add a Trinity workflow during the file. This is something else from
 * the Draw Center, which is a 159 Budget Review … should be available in the order section. You
 * should mark over there that it's only intended for real heavy rehabs and for ground-ups. On
 * ground-ups where we post the condition for feasibility review, that condition should get a button
 * where, from that button, we can order this report directly. It should send over the entire scope.
 * Right before you order, it should be gated that you need to have: the scope of work completed /
 * the contractor information completed / the research on which fields they're accepting, because
 * they're asking for the contractor information / it linked with our contractor information that we
 * have / the full budget so they can review it properly. You also need to have the appraisal back
 * before you're ordering this, and the appraisal PDF document should be sent along together with the
 * order to Trinity. It's a separate workflow other than the drawer. It's within the file only for
 * ground-ups and maybe case by case for heavy rehabs."*
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RESEARCH THE OWNER ASKED FOR — "which fields they're accepting"
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Read off Trinity's own v1.1 swagger (`docs/trinity/api/swagger-v1.1.json`, captured from the live
 * API), so this is their schema rather than anybody's memory:
 *
 *   POST /api/v1.1/forms/159/new  →  DollarLineItem…TotalBudgetedOrderModelProjectModel
 *
 * which is THE SAME SCHEMA the draw we already place uses (forms 19 / 139 / 150 / 159 / 1074 /
 * 1079 / 1081 all share it). That is why this module has no payload builder of its own: it calls
 * `mapper.buildOrderPayload`, the one that is already verified against the live sandbox, with
 * `kind: 'budget_review'`. A second builder would be a second place the contractor rules, the
 * phone rules and the line-key uniquifier could drift.
 *
 *   CONTRACTOR (`ContractorModel`) — the owner's "they're asking for the contractor information":
 *       name*          REQUIRED
 *       companyName*   REQUIRED
 *       emailAddress*  REQUIRED
 *       phone / mobilePhone — at least ONE is required in practice (verified live 2026-08-16;
 *       the swagger marks both nullable and that is not true — see mapper.js).
 *   APPRAISAL (`PropertyModel.appraisal` → `AppraisalModel`):
 *       value, datePerformed, performedBy  — the FIGURES, not the document.
 *   THE APPRAISAL PDF is a DOCUMENT, not a field: it goes to
 *       POST /api/v1.1/orders/{id}/documents/json  in group **1 = "Appraisal"**
 *       (`docs/trinity/api/documents_groups.json`; the group accepts .pdf).
 *   THE SCOPE (`order.lineItems[]` → `DollarLineItem`):
 *       description*, itemCost*, plus amountRequested / isRequested / previousPercentCompleted /
 *       remarks. **The whole budget goes, with nothing requested** — a review asks for no money,
 *       which is the one rule `buildOrderPayload` relaxes for this kind.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It is NOT a draw and it must never touch the draw stack: no `sitewire_draws`, no
 * `portal_draw_requests`, no draw findings, no money. A draw is a request for a release against
 * work already done; this is a read of the plan BEFORE the loan closes. They share Trinity and
 * nothing else — the owner's *"It's a separate workflow other than the drawer."*
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GATE — the owner's five, and why each one is refused rather than guessed
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A review ordered off a half-finished file is worse than no review: Trinity reads what we send
 * them, so an incomplete scope produces a confident answer about the wrong project, and we pay for
 * it. Every check below therefore FAILS CLOSED — anything unreadable blocks rather than passes.
 */

const db = require('../db');

/** The Trinity form. Named once; the go-live doc and the desk both read it from here. */
const BUDGET_REVIEW_FORM_ID = 159;

/** Trinity's own document group for an appraisal (their list, captured 2026-08-16). */
const APPRAISAL_DOC_GROUP_ID = 1;

/**
 * WHICH FILES MAY ORDER ONE — the owner's *"only intended for real heavy rehabs and for
 * ground-ups"*, and *"within the file only for ground-ups and maybe case by case for heavy
 * rehabs."*
 *
 * Ground-up is ALLOWED and EXPECTED; heavy rehab is ALLOWED but case-by-case, which is a real
 * distinction and is surfaced rather than flattened — the desk sees "this is the product for this
 * file" on one and "only if this rehab really warrants it" on the other. Anything else is refused:
 * a light rehab or a bridge has no construction plan to review, so an order would be money spent
 * on nothing.
 *
 * It reuses `feasibility-fee.feasibilityKind` — the SAME ordered test the fee uses, off the frozen
 * engine's own strategy classifier — so the file that is CHARGED the ground-up feasibility fee and
 * the file that may ORDER the ground-up review can never be different files.
 */
const SUITABILITY = Object.freeze({
  ground_up: { allowed: true, expected: true, note: 'This is the product for a ground-up: Trinity reads the plans, the permits, the budget and the schedule before the loan closes.' },
  heavy_rehab: { allowed: true, expected: false, note: 'Allowed on a heavy rehab, case by case — order it when the scope is big enough to be worth an independent read.' },
});

function suitabilityFor(input) {
  const kind = require('../lib/feasibility-fee').feasibilityKind(input);
  if (!kind || !SUITABILITY[kind]) {
    return { kind: null, allowed: false, expected: false,
      note: 'A budget review is only for a ground-up or a real heavy rehab — there is no construction plan to read on this deal.' };
  }
  return { kind, ...SUITABILITY[kind] };
}

/**
 * IS THE SCOPE OF WORK ACTUALLY FINISHED? — the owner's *"the scope of work completed"* and
 * *"the full budget so they can review it properly"*, which are two halves of one question.
 *
 * It asks `rehab-budget.checkSowBudget`, the SAME cent-exact gate that decides whether the
 * Scope-of-Work CONDITION may be signed off. That is deliberate: "finished enough for Trinity to
 * read" and "finished enough for us to sign off" must be the same standard, or the desk would be
 * able to order a review of a scope PILOT itself considers unfinished. `seed` (the tool has never
 * been opened) reads as not finished.
 */
async function scopeReady(appId, client = db) {
  try {
    /* `checkSowBudget` takes the SAVED TOOL PAYLOAD as its second argument — it does not read one
       itself, because its other three callers are all validating a payload somebody is submitting
       right now. Passing null therefore made it compare against nothing and refuse EVERY file,
       always: a gate that can never open is not a gate, it is a wall, and it would have made this
       whole feature unreachable. (Caught in test, on a real database, on the fixture that was
       supposed to be the one that passes.) So the file's own saved Scope of Work is read here
       first, which is what the sign-off gate effectively does too. */
    const item = (await client.query(
      `SELECT tool_payload FROM checklist_items
        WHERE application_id = $1 AND tool_key = 'rehab_budget' AND tool_payload IS NOT NULL
        ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`, [appId])).rows[0];
    if (!item || !item.tool_payload) {
      return { ok: false, why: 'The Scope of Work has not been filled in yet — Trinity would have nothing to review.' };
    }
    const r = await require('../lib/rehab-budget').checkSowBudget(appId, item.tool_payload, client);
    // `seed` means the file has no required budget to compare against, which on a construction
    // deal means the budget itself is not set — not something to send for review.
    if (!r || r.seed) return { ok: false, why: 'This file has no construction budget set yet — Trinity would have nothing to review.' };
    if (!r.ok) return { ok: false, why: r.message || 'The Scope of Work does not add up to the construction budget yet.' };
    return { ok: true };
  } catch (_) {
    // FAIL CLOSED: an unreadable scope is not a finished one.
    return { ok: false, why: 'PILOT could not read the Scope of Work just now — try again in a moment.' };
  }
}

/**
 * IS THE CONTRACTOR INFORMATION COMPLETE, AND IS IT OURS? — the owner's *"the contractor
 * information completed"* and *"it linked with our contractor information that we have"*.
 *
 * "Ours" is the file's own `service_contacts` contractor record — the one place a contractor lives
 * in PILOT (db/605 added their credentials beside it, deliberately rather than growing a second
 * home). Nothing here is ever typed into the order by hand: an inspector telephones this person to
 * get onto the property, so a fabricated contact is worse than a refusal.
 *
 * The three REQUIRED fields are Trinity's own (`name`, `companyName`, `emailAddress`), plus at
 * least one phone, which their API requires in practice however the swagger marks it.
 */
async function contractorReady(appId, client = db) {
  try {
    const c = (await client.query(
      `SELECT sc.id, sc.company_name, sc.contact_name, sc.email, sc.phone, sc.phones
         FROM application_service_contacts asc2
         JOIN service_contacts sc ON sc.id = asc2.service_contact_id
        WHERE asc2.application_id = $1 AND sc.contact_type = 'contractor'
        ORDER BY asc2.created_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0];
    if (!c) {
      return { ok: false, why: 'No contractor is on this file yet. Add the general contractor in the file contacts — Trinity requires their name, company and email.' };
    }
    const missing = [];
    if (!String(c.contact_name || '').trim()) missing.push('name');
    if (!String(c.company_name || '').trim()) missing.push('company name');
    if (!String(c.email || '').trim()) missing.push('email address');
    // At least one phone, in any of the fields we hold them in.
    const phones = [c.phone, ...(Array.isArray(c.phones) ? c.phones.map((p) => (p && (p.number || p.value || p)) || '') : [])];
    if (!phones.some((p) => String(p || '').replace(/\D/g, '').length >= 10)) missing.push('phone number');
    if (missing.length) {
      return { ok: false, why: `The contractor's ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing — Trinity needs ${missing.length === 1 ? 'it' : 'them'} so the reviewer can reach them.` };
    }
    return { ok: true, contractorId: c.id };
  } catch (_) {
    return { ok: false, why: 'PILOT could not read the contractor record just now — try again in a moment.' };
  }
}

/**
 * IS THE APPRAISAL BACK, AND IS THERE A PDF TO SEND? — the owner's *"You also need to have the
 * appraisal back before you're ordering this, and the appraisal PDF document should be sent along
 * together with the order."*
 *
 * TWO SEPARATE THINGS, and both are required because the owner named both: the appraisal must be
 * IMPORTED (so the figures can ride on `PropertyModel.appraisal`) and a PDF must exist to attach.
 * A file whose appraisal arrived as data with no report is a real state — so it is refused with a
 * sentence that says which half is missing, rather than a generic "appraisal required".
 */
async function appraisalReady(appId, client = db) {
  try {
    const a = (await client.query(
      `SELECT id, as_is_value, appraised_value, effective_date, appraiser_company
         FROM appraisals
        WHERE application_id = $1 AND superseded = false
        ORDER BY imported_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0];
    if (!a) return { ok: false, why: 'The appraisal is not back yet. Trinity reviews the budget against the appraised value, so it has to be in first.' };
    // The report itself. `doc_kind='appraisal_pdf'` is what the appraisal import files; a human
    // upload onto the appraisal condition is accepted too, which is why the kind is not the only
    // test. Current, not rejected — the same standard every outbound package applies.
    const doc = (await client.query(
      `SELECT d.id, d.filename
         FROM documents d
        WHERE d.application_id = $1
          AND COALESCE(d.is_current, true) = true
          AND COALESCE(d.review_status,'') <> 'rejected'
          AND (COALESCE(d.doc_kind,'') = 'appraisal_pdf'
               OR (COALESCE(d.doc_kind,'') = '' AND d.filename ILIKE '%.pdf' AND d.filename ILIKE '%appraisal%'))
        ORDER BY d.created_at DESC LIMIT 1`, [appId])).rows[0];
    if (!doc) {
      return { ok: false, why: 'The appraisal is in, but PILOT holds no appraisal PDF to send with the order. Upload the report first.' };
    }
    return { ok: true, appraisalId: a.id, documentId: doc.id, filename: doc.filename };
  } catch (_) {
    return { ok: false, why: 'PILOT could not read the appraisal just now — try again in a moment.' };
  }
}

/**
 * THE WHOLE GATE, in the owner's own order. Returns every blocker rather than the first — somebody
 * about to place a paid order should be told everything that is missing in one go, not sent round
 * the loop four times.
 *
 * `ready` is true only when nothing is blocking AND the file is a kind that may order one.
 */
async function reviewGate(appId, { input = null, client = db } = {}) {
  const out = { ready: false, blockers: [], suitability: null, appraisal: null, contractor: null };
  if (!appId) { out.blockers.push('No file.'); return out; }

  // The deal kind first: on a light rehab or a bridge nothing else matters, and listing four other
  // blockers would imply the order becomes possible once they are cleared.
  const inp = input || await inputForFile(appId, client);
  out.suitability = suitabilityFor(inp);
  if (!out.suitability.allowed) { out.blockers.push(out.suitability.note); return out; }

  const scope = await scopeReady(appId, client);
  if (!scope.ok) out.blockers.push(scope.why);

  const contractor = await contractorReady(appId, client);
  out.contractor = contractor;
  if (!contractor.ok) out.blockers.push(contractor.why);

  const appraisal = await appraisalReady(appId, client);
  out.appraisal = appraisal;
  if (!appraisal.ok) out.blockers.push(appraisal.why);

  /* AND EVERYTHING TRINITY'S OWN SCHEMA WILL REFUSE. Without this the desk is told the file is
     ready, presses the button, and gets a DIFFERENT refusal — "the borrower's phone number is
     missing" — from the payload builder a moment later. The owner asked for a gate "right before
     you order", and a gate that promises a readiness the next step does not honour is worse than
     none. So the payload is BUILT here, in the dry, and its problems join the list.

     It is best-effort: this is the expensive half of the check (it reads the file and explodes the
     scope), so a failure to build it leaves the other four blockers standing rather than inventing
     a fifth — the order path re-checks it for real anyway, which is where it must be right. */
  if (!out.blockers.length) {
    try {
      const dry = await dryPayload(appId, out.suitability, client);
      for (const p of (dry.problems || [])) out.blockers.push(`Trinity also needs: ${p}.`);
    } catch (_) { /* the order path re-checks for real */ }
  }

  out.ready = out.blockers.length === 0;
  return out;
}

/**
 * Build the payload WITHOUT sending it, so the gate can report what Trinity would refuse. Shares
 * the order path's own readers and the one builder — a second shape here would be a gate that
 * describes a payload nobody sends.
 */
async function dryPayload(appId, suitability, client = db) {
  const order = require('./order');
  const mapper = require('./mapper');
  const ctx = await order.fileContext(appId);
  const sowRow = (await client.query(
    `SELECT tool_payload FROM checklist_items
      WHERE application_id = $1 AND tool_key = 'rehab_budget' AND tool_payload IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`, [appId])).rows[0];
  const exploded = require('../sitewire/mapper').explodeSow((sowRow && sowRow.tool_payload && sowRow.tool_payload.state) || {}, {});
  const lines = (exploded.items || [])
    .filter((i) => !i.is_media_item && Number(i.budgeted_cents || 0) > 0)
    .map((i) => ({ sow_line_key: i.sow_line_key, name: i.name, budgeted_cents: Number(i.budgeted_cents || 0), requested_cents: 0, previous_drawn_cents: 0 }));
  return mapper.buildOrderPayload({
    companyId: 0, projectNumber: ctx.app.ys_loan_number,
    projectCustomerKey: `app-${appId}`, orderCustomerKey: `tbr-${appId}`,
    address: ctx.address, appraisal: ctx.appraisal, units: ctx.app.units,
    propertyType: /commercial|mixed/i.test(String(ctx.app.property_type || '')) ? 'Commercial' : 'Residential',
    projectType: (suitability && suitability.kind) === 'ground_up' ? 'NewConstruction' : 'Remodel',
    totalProjectCostCents: ctx.app.loan_amount != null ? Math.round(Number(ctx.app.loan_amount) * 100) : null,
    borrower: ctx.borrower, contractor: ctx.contractor,
    analyst: { name: 'Loan Team', email: 'sales@yscapgroup.com' },
    lines, kind: 'budget_review',
  });
}

/** The two fields `suitabilityFor` judges on, read off the file. Never throws. */
async function inputForFile(appId, client = db) {
  try {
    const a = (await client.query(
      `SELECT program, loan_type, rehab_type FROM applications WHERE id = $1`, [appId])).rows[0];
    if (!a) return {};
    return {
      /* THROUGH `pricing.engineStrategy`, AND THIS LINE IS THE WHOLE POINT OF THE HELPER.
         `applications.program` holds the PORTAL's label, and one of those labels is
         "Fix & Flip w/ Construction" — which contains the word "construction" and therefore reads
         as a GROUND-UP to the frozen engine's classifier, and so to `feasibilityKind`. Reading the
         column raw made an ordinary fix & flip look like a ground-up here while `buildInputs`
         (which has always normalized) correctly priced it as a flip — so the review and the FEE
         would have disagreed about the same file, which is exactly what section A6 of the test
         exists to prevent. Caught in test, on a real database, because a trigger had stored that
         very label. */
      strategy: require('../lib/pricing').engineStrategy(String(a.program || '').trim() || String(a.loan_type || '').trim()),
      // The SAME derivation `pricing.buildInputs` uses, so "is this a heavy rehab" has one meaning.
      heavyRehab: /heavy|gut|ground/i.test(String(a.rehab_type || '')),
    };
  } catch (_) { return {}; }
}

module.exports = {
  BUDGET_REVIEW_FORM_ID, APPRAISAL_DOC_GROUP_ID, SUITABILITY,
  suitabilityFor, scopeReady, contractorReady, appraisalReady, reviewGate, inputForFile,
};

// ---------------------------------------------------------------------------
// ORDERING ONE — same safety as the draw, none of the draw
// ---------------------------------------------------------------------------

/**
 * Create (or find) the file's budget-review record. One live review per file, which is what the
 * product is: a read of the plan, not a repeating event like a draw. The uniqueness is the
 * DATABASE's (db/610's partial unique index), so two clicks a second apart cannot make two.
 */
async function requestReview(appId, { staffId = null, note = null, client: dbc = db } = {}) {
  const gate = await reviewGate(appId, { client: dbc });
  if (!gate.ready) return { ok: false, blocked: true, blockers: gate.blockers, gate };
  try {
    const row = (await dbc.query(
      `INSERT INTO trinity_budget_reviews (application_id, customer_key, requested_by, note)
       VALUES ($1, $2, $3::uuid, $4)
       ON CONFLICT (customer_key) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [appId, `tbr-${appId}`, staffId, note ? String(note).slice(0, 1000) : null])).rows[0];
    return { ok: true, review: row, gate };
  } catch (e) {
    // The partial unique index fires when a live review already exists under a DIFFERENT
    // customer key (a re-request after a cancel). Answer with the live one rather than an error.
    const live = (await dbc.query(
      `SELECT * FROM trinity_budget_reviews WHERE application_id=$1 AND status <> 'cancelled'
        ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    if (live) return { ok: true, review: live, already: true };
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/**
 * PLACE IT with Trinity — form 159, the whole scope, the appraisal figures, and the appraisal PDF.
 *
 * The safety is the DRAW path's, deliberately and line for line, because the failure modes are
 * identical and they were learned the hard way there: the switches and the dry run; a LEASE so two
 * clicks cannot post twice and a crashed run frees in ten minutes; the exactly-once `customerKey`
 * with a 409 ADOPTED rather than re-posted (a lost response must never create a second paid order);
 * and the order id RECORDED the instant it exists, so from then on every retry is a resume.
 *
 * What it does NOT share is the draw: no requested amounts, no draw folding, no findings. The gate
 * is re-checked HERE, at the moment of sending, never trusted from whenever the desk last looked —
 * a scope can change between opening the screen and pressing the button.
 */
async function placeReviewOrder(appId, reviewId, { staffId = null } = {}) {
  const tclient = require('./client');
  const order = require('./order');
  const mapper = require('./mapper');

  const r = (await db.query(
    `SELECT * FROM trinity_budget_reviews WHERE id=$1 AND application_id=$2`, [reviewId, appId])).rows[0];
  if (!r) return { skipped: 'not_found' };
  if (r.status === 'cancelled') return { skipped: 'cancelled' };
  if (r.trinity_order_id) return { ok: true, already: true, trinityOrderId: Number(r.trinity_order_id) };
  if (!tclient.available()) return { skipped: 'not_configured', message: 'Trinity credentials are not set up yet.' };
  if (!tclient.enabled()) return { skipped: 'off', message: 'The Trinity connection is switched off.' };
  if (!tclient.outboundEnabled() && !tclient.dryrun()) {
    return { skipped: 'outbound_off', message: 'Placing Trinity orders is switched off.' };
  }

  // RE-CHECK THE GATE AT THE MOMENT OF SENDING. The desk may have opened this screen an hour ago.
  const gate = await reviewGate(appId);
  if (!gate.ready) {
    const reason = `Not ready to order: ${gate.blockers.join(' ')}`;
    await db.query(
      `UPDATE trinity_budget_reviews SET blocked_reason=$2, updated_at=now() WHERE id=$1`,
      [reviewId, reason.slice(0, 500)]);
    return { blocked: true, message: reason, blockers: gate.blockers };
  }

  const claimed = (await db.query(
    `UPDATE trinity_budget_reviews SET order_claimed_at = now(), updated_at = now()
      WHERE id = $1 AND trinity_order_id IS NULL
        AND (order_claimed_at IS NULL OR order_claimed_at < now() - interval '10 minutes')
      RETURNING id`, [reviewId])).rows[0];
  if (!claimed) return { skipped: 'in_flight' };
  const release = () => db.query(
    `UPDATE trinity_budget_reviews SET order_claimed_at = NULL WHERE id = $1`, [reviewId]).catch(() => {});

  try {
    const ctx = await order.fileContext(appId);
    /* THE SCOPE ITSELF IS THE SOURCE — the owner's *"It should send over the entire scope"* — and
       this is the one place a budget review CANNOT reuse the draw path.

       `order.budgetLines` reads `sitewire_job_item_links`: the crosswalk built when a file's draw
       project is pushed to Sitewire, AFTER funding. A budget review happens BEFORE the loan
       closes, so on every file that can order one that table is EMPTY — the draw reader returned
       nothing and the payload was refused with "the construction budget has no line items" on the
       very fixture that was supposed to be the one that works. (Caught in test, not in production.)

       So the lines come from the Scope of Work, through `sitewire/mapper.explodeSow` — the SAME
       explosion that later BUILDS those job items, per unit, with the contingency and the GC fee
       as their own lines. That is deliberate: what Trinity reviews now is line-for-line what the
       draws will later be measured against, rather than a second reading of the same scope. The
       media anchors are dropped — they are photo/video inspection gates, not money. */
    const sowRow = (await db.query(
      `SELECT tool_payload FROM checklist_items
        WHERE application_id = $1 AND tool_key = 'rehab_budget' AND tool_payload IS NOT NULL
        ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`, [appId])).rows[0];
    const state = sowRow && sowRow.tool_payload && sowRow.tool_payload.state;
    const exploded = require('../sitewire/mapper').explodeSow(state || {}, {});
    const lines = (exploded.items || [])
      .filter((i) => !i.is_media_item && Number(i.budgeted_cents || 0) > 0)
      .map((i) => ({
        sow_line_key: i.sow_line_key,
        name: i.name,
        budgeted_cents: Number(i.budgeted_cents || 0),
        requested_cents: 0,          // a review asks for no money — that is what makes it a review
        previous_drawn_cents: 0,     // nothing has been drawn: the loan has not closed
      }));

    const customerKey = r.customer_key || `tbr-${appId}`;
    const companyId = await tclient.companyId();
    const { payload, problems } = mapper.buildOrderPayload({
      companyId,
      projectNumber: ctx.app.ys_loan_number,
      projectCustomerKey: `app-${appId}`,
      orderCustomerKey: customerKey,
      address: ctx.address,
      appraisal: ctx.appraisal,
      units: ctx.app.units,
      propertyType: /commercial|mixed/i.test(String(ctx.app.property_type || '')) ? 'Commercial' : 'Residential',
      // A budget review is ordered BEFORE the build, so the project type follows the deal kind
      // rather than the loan type: a ground-up is new construction, a heavy rehab a remodel.
      projectType: gate.suitability.kind === 'ground_up' ? 'NewConstruction' : 'Remodel',
      totalProjectCostCents: ctx.app.loan_amount != null ? Math.round(Number(ctx.app.loan_amount) * 100) : null,
      borrower: ctx.borrower,
      contractor: ctx.contractor,
      analyst: { name: 'Loan Team', email: 'sales@yscapgroup.com' },
      lines,
      kind: 'budget_review',
    });

    if (problems.length) {
      const reason = `Trinity needs a few things first: ${problems.join('; ')}.`;
      await db.query(
        `UPDATE trinity_budget_reviews SET blocked_reason=$2, order_claimed_at=NULL, updated_at=now() WHERE id=$1`,
        [reviewId, reason.slice(0, 500)]);
      return { blocked: true, message: reason, problems };
    }

    let created = null, trinityOrderId = null, trinityProjectId = null;
    try {
      // THE FORM IS NAMED EXPLICITLY. A wrong form here orders and pays for a different product,
      // so it is never left to the configuration that governs the draw.
      created = await tclient.createOrder(payload, { form: BUDGET_REVIEW_FORM_ID });
      if (created && created.__dryrun) {
        await release();
        return { ok: true, dryrun: true, wouldSend: { form: BUDGET_REVIEW_FORM_ID, lines: payload.order.lineItems.length } };
      }
      trinityOrderId = created && created.order && created.order.id;
      trinityProjectId = created && created.id;
    } catch (e) {
      if (e && e.conflict) {
        // The exactly-once key says this order already exists. ADOPT it — never post a second.
        const found = await tclient.findOrderByCustomerKey(customerKey).catch(() => null);
        if (found && found.id) { trinityOrderId = found.id; trinityProjectId = found.projectId || null; }
        else {
          const reason = `Trinity refused the order: ${String((e.body && e.body.detail) || e.message).slice(0, 200)}`;
          await db.query(
            `UPDATE trinity_budget_reviews SET blocked_reason=$2, order_claimed_at=NULL, updated_at=now() WHERE id=$1`,
            [reviewId, reason.slice(0, 500)]);
          return { blocked: true, message: reason };
        }
      } else {
        await release();
        return { error: true, retryable: !!(e && e.retryable), message: String(e && e.message).slice(0, 300) };
      }
    }
    if (!trinityOrderId) { await release(); return { error: true, message: 'Trinity returned no order id' }; }

    // RECORDED THE INSTANT IT EXISTS — from here every retry is a resume, never a re-create.
    await db.query(
      `UPDATE trinity_budget_reviews
          SET trinity_order_id=$2, trinity_project_id=$3, customer_key=$4,
              status = CASE WHEN status='requested' THEN 'ordered' ELSE status END,
              ordered_at = COALESCE(ordered_at, now()), ordered_by = COALESCE(ordered_by, $5::uuid),
              appraisal_id = $6, appraisal_document_id = $7,
              blocked_reason = NULL, order_claimed_at = NULL, updated_at = now()
        WHERE id=$1`,
      [reviewId, trinityOrderId, trinityProjectId, customerKey, staffId,
        gate.appraisal && gate.appraisal.appraisalId, gate.appraisal && gate.appraisal.documentId]);

    // THE DOCUMENTS, and the appraisal PDF is the one the owner named. Best-effort by design: the
    // order is already placed, and a document that will not upload must never undo it — what it
    // does instead is come back NAMED, so the desk can send it by hand.
    let docs = null;
    try {
      docs = await order.sendDocuments(appId, `bv${reviewId}`, trinityOrderId, { lines, requestedTotal: 0 });
    } catch (e) {
      docs = { failed: [String((e && e.message) || e).slice(0, 120)] };
    }
    return { ok: true, trinityOrderId, trinityProjectId, documents: docs };
  } catch (e) {
    await release();
    return { error: true, message: String((e && e.message) || e).slice(0, 300) };
  }
}

module.exports.requestReview = requestReview;
module.exports.dryPayload = dryPayload;
module.exports.placeReviewOrder = placeReviewOrder;
