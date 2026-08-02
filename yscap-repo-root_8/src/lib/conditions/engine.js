'use strict';

/**
 * The Condition Center engine.
 *
 * Watches the file's data and keeps rule-driven condition templates in sync:
 *
 *   evaluateApplication(appId)  — the core pass. Loads the file's rule context
 *     (applications + borrower + entity + registered product + verified
 *     experience), then for every active template with auto_apply in
 *     ('always','rules'):
 *       • matches and not on the file yet  → instantiate a checklist item
 *       • no longer matches                → retract, but ONLY if the engine
 *         created it and nobody has touched it (still outstanding, no docs,
 *         no notes, no sign-off/review, no tool payload). Anything a human or
 *         borrower has interacted with is never auto-removed — an underwriter
 *         can waive or un-require it manually.
 *
 * Duplicate suppression is per (application, template): any existing item for
 * the template — whatever its status — blocks re-issuance, so satisfied
 * conditions don't reappear when data wobbles in and out of range.
 *
 * Issued items are snapshots: they copy the template's wording at issuance
 * (plus template version + rule summary in origin_detail), so editing a
 * definition never rewrites conditions already on files.
 */

const db = require('../../db');
const registry = require('./field-registry');
const rules = require('./rules');
const { countBorrowersExperience, fileBorrowerIds } = require('../experience');

const OPEN_STATUSES = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close'];

function num(v) {
  // NULL/absent must stay null (not 0) — "is empty" tests and comparisons
  // against missing data both depend on it.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function str(v) {
  // Same discipline as num(): absent/blank stays NULL so an "is empty" test reads
  // true and a comparison against missing data never matches an empty string.
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Load every registry field's current value for one application. */
async function loadRuleContext(appId) {
  const r = await db.query(
    `SELECT a.*,
            b.fico AS b_fico, b.citizenship AS b_citizenship, b.tier AS b_tier,
            b.current_address AS b_address, b.id AS b_id,
            l.is_verified AS llc_is_verified, l.formation_state AS llc_formation_state,
            pr.program AS pr_program, pr.quote AS pr_quote
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current = true
      WHERE a.id = $1`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  // Verified experience for the FILE = primary borrower + co-borrower, summed
  // (#80) — the same rule the pricing/experience condition uses.
  let verified = { flips: 0, holds: 0, ground: 0, total: 0 };
  try { verified = await countBorrowersExperience(fileBorrowerIds(a), db, { verifiedOnly: true }); } catch (_) {}

  const addr = a.property_address || {};
  const bAddr = a.b_address || {};
  const quote = a.pr_quote || null;
  const loanAmount = num(a.loan_amount);
  const arv = num(a.arv);
  const cost = (num(a.purchase_price) || 0) + (num(a.rehab_budget) || 0);

  // Known flood zone (SFHA) from the current appraisal — the FEMA SFHA flag, the
  // FEMA-mapped zone, or the appraiser's stated zone (an A*/V* zone is an SFHA).
  // Drives the flood-certificate condition: always required when a flood zone is
  // known, regardless of program. Best-effort — absent appraisal ⇒ not flagged.
  let inFloodZone = false;
  const isA = (z) => /^(A|V)/.test(String(z || '').trim().toUpperCase());
  try {
    const fz = await db.query(
      `SELECT fema_flood_sfha, fema_flood_zone, flood_zone
         FROM appraisals WHERE application_id=$1 AND superseded=false
        ORDER BY imported_at DESC NULLS LAST, id DESC LIMIT 1`, [appId]);
    const row = fz.rows[0];
    if (row) {
      inFloodZone = row.fema_flood_sfha === true || isA(row.fema_flood_zone) || isA(row.flood_zone);
    }
  } catch (_) { /* appraisals table mid-migration or none — treat as not flagged */ }
  // A completed Encompass flood-determination ORDER is an independent, authoritative
  // source of the flood zone (the SFHA flag / FEMA zone the flood vendor returned).
  // A proven flood zone from EITHER source drives the flood-insurance condition.
  if (!inFloodZone) {
    try {
      const fo = await db.query(
        `SELECT sfha, flood_zone FROM encompass_flood_orders
          WHERE application_id=$1 AND status='completed'
          ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1`, [appId]);
      const o = fo.rows[0];
      if (o) inFloodZone = o.sfha === true || isA(o.flood_zone);
    } catch (_) { /* table mid-migration or none — treat as not flagged */ }
  }

  // Admin-defined custom fields: per-application answers live in
  // application_field_values and join the context like any built-in field.
  const customValues = {};
  try {
    const cv = await db.query(`SELECT field_key, value FROM application_field_values WHERE application_id=$1`, [appId]);
    for (const row of cv.rows) customValues[row.field_key] = row.value;
  } catch (_) { /* table mid-migration — no custom values */ }

  const ctx = {
    ...customValues,
    registered_program: a.pr_program || 'none',
    program_strategy: registry.normStrategy([a.program, a.loan_type, a.rehab_type].filter(Boolean).join(' ')),
    loan_purpose: registry.normLoanPurpose(a.loan_type),
    loan_amount: loanAmount,
    ltv: num(a.ltv),
    loan_to_arv: loanAmount != null && arv ? Math.round((loanAmount / arv) * 1000) / 10 : null,
    loan_to_cost: loanAmount != null && cost > 0 ? Math.round((loanAmount / cost) * 1000) / 10 : null,
    rate_pct: num(a.rate_pct),
    requested_ir_months: num(a.requested_ir_months),
    requested_ir_amount: num(a.requested_ir_amount),
    is_assignment: !!a.is_assignment,
    // Note buyer / capital partner (applications.lender), normalized to a stable
    // key so a rule matches "CorrFirst" / "Corr First" / "corrfirst" the same.
    note_buyer: registry.normNoteBuyer(a.lender),
    // Is the note buyer FIDELIS (any spelling — "Fidelis" / "Fidelis Investors" /
    // "Fidelis Investors LLC")? Always concrete (never null), so an `is_false` rule
    // row is correct on a file with no note buyer yet. Keeps the internal
    // flood-certificate condition off a Fidelis file (db/335) UNLESS `in_flood_zone`
    // proves a flood zone — that branch stands on its own and forces the cert on.
    note_buyer_is_fidelis: registry.isFidelisNoteBuyer(a.lender),
    // Same boolean companion for EMCAP (the Silver program's note buyer) — its real
    // ClickUp/Sitewire label "EMCAP Financial" normalizes to 'emcapfinancial', so an
    // enum `note_buyer eq emcap` rule would never fire on a correctly-labeled file.
    note_buyer_is_emcap: registry.isEmcapNoteBuyer(a.lender),
    // Loan number — blank/absent drives the "loan number missing" internal
    // condition (rules is_empty). Kept as the raw string (null when blank) so
    // is_empty/not_empty fire correctly.
    ys_loan_number: (a.ys_loan_number && String(a.ys_loan_number).trim()) || null,
    status: a.status,

    property_state: registry.normState(addr.state),
    property_city: addr.city || null,
    property_zip: addr.zip || addr.postalCode || null,
    property_type: registry.normPropertyType(a.property_type),
    units: num(a.units),
    occupancy: registry.normOccupancy(a.occupancy),
    in_flood_zone: inFloodZone,

    purchase_price: num(a.purchase_price),
    as_is_value: num(a.as_is_value),
    arv,
    rehab_budget: num(a.rehab_budget),
    rehab_type: registry.normRehabType(a.rehab_type),
    payoff_amount: num(a.payoff_amount),
    // WHO is being paid off and WHICH loan (db/386) — both are writable rule
    // fields, so they must be readable ones too or a rule keyed on them would
    // silently evaluate as blank.
    payoff_lender: str(a.payoff_lender),
    payoff_loan_number: str(a.payoff_loan_number),
    original_purchase_price: num(a.original_purchase_price),
    acquisition_date: dateStr(a.acquisition_date),
    /* HOW LONG THE BORROWER HAS OWNED IT, in whole months — DERIVED, read-only
       (owner-directed 2026-08-02: "you can add some extra fields later on what
       was the original purchase price of the property and when exactly it was
       purchased so we can count seasoning and stuff like that"). Computed from
       `acquisition_date` by the one shared helper, so a seasoning rule, the
       underwriting context and the file screens can never disagree about how
       many months a property has been held. NULL when there is no date, it
       cannot be read, or it is in the future — never a guessed zero, so a rule
       keyed on it stays silent rather than firing on an unknown. */
    ownership_seasoning_months: require('../deal-basis').seasoningMonths(a.acquisition_date),
    underlying_contract_price: num(a.underlying_contract_price),
    assignment_fee: num(a.assignment_fee),
    sqft_pre: num(a.sqft_pre),
    sqft_post: num(a.sqft_post),
    liquidity_required: quote ? num(quote.liquidityRequired || quote.liquidity) : null,

    fico: num(a.b_fico),
    citizenship: registry.normCitizenship(a.b_citizenship),
    borrower_state: registry.normState(bAddr.state),
    tier: num(a.b_tier) || 0,
    verified_flips: verified.flips,
    verified_holds: verified.holds,
    verified_ground: verified.ground,
    requested_exp_flips: num(a.requested_exp_flips) || 0,
    requested_exp_holds: num(a.requested_exp_holds) || 0,
    requested_exp_ground: num(a.requested_exp_ground) || 0,
    has_co_borrower: !!a.co_borrower_id,

    has_llc: !!a.llc_id,
    llc_verified: !!a.llc_is_verified,
    llc_state: registry.normState(a.llc_formation_state),
  };
  return { ctx, app: a };
}

/**
 * Insert a checklist item from a template row (same column carry-over as the
 * legacy insertFromTemplate, plus Condition Center columns). `extra` sets the
 * origin bookkeeping. Returns the new item id.
 */
async function instantiateTemplate(tpl, owner, extra = {}) {
  const cols = ['template_id', 'scope', 'label', 'borrower_label', 'audience', 'item_kind',
                'role_scope', 'phase', 'hint', 'borrower_hint', 'is_gate', 'is_milestone',
                'sort_order', 'tool_key', 'clickup_field_id', 'tpr_exclude', 'created_by_kind', 'created_by_id', 'is_required',
                'field_key', 'category', 'esign_doc', 'origin_kind', 'origin_detail'];
  const vals = [tpl.id, tpl.scope, tpl.label, tpl.borrower_label || null, tpl.audience, tpl.item_kind,
                tpl.role_scope || 'any', tpl.phase || null, tpl.hint || null, tpl.borrower_hint || null,
                tpl.is_gate || false, tpl.is_milestone || false,
                tpl.sort_order || 100, tpl.tool_key || null, tpl.clickup_field_id || null, tpl.tpr_exclude || false,
                extra.createdByKind || 'system', extra.createdById || null, tpl.is_required !== false,
                tpl.field_key || null, tpl.category || null, tpl.esign_doc || null,
                extra.originKind || null, extra.originDetail ? JSON.stringify(extra.originDetail) : null];
  for (const [k, v] of Object.entries(owner)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.query(`INSERT INTO checklist_items (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals);
  return r.rows[0].id;
}

async function auditEngine(action, appId, detail, actor) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,$3,'application',$4,$5)`,
      [actor && actor.id ? 'staff' : 'system', (actor && actor.id) || null, action, appId, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort */ }
}

/**
 * The core pass. opts: { actor: {id}, reason: 'details_edited' | … , notify: true }
 * Returns { added: [{id,label,audience}], removed: [{label}] } (empty on skip).
 */
async function evaluateApplication(appId, opts = {}) {
  const out = { added: [], removed: [] };
  const loaded = await loadRuleContext(appId);
  if (!loaded) return out;
  const { ctx, app } = loaded;
  // Terminal / deleted files are frozen — no new automatic conditions.
  if (app.deleted_at || !OPEN_STATUSES.includes(app.status)) return out;

  const tpls = await db.query(
    `SELECT * FROM checklist_templates
      WHERE is_active = true AND scope = 'application' AND auto_apply IN ('always','rules')
      ORDER BY sort_order, label`);
  if (!tpls.rows.length) return out;
  const fields = await registry.fieldMap(db);

  const existing = await db.query(
    `SELECT ci.id, ci.template_id, ci.status, ci.origin_kind, ci.label, ci.notes,
            ci.signed_off_at, ci.reviewed_at, (ci.tool_payload IS NOT NULL) AS has_payload,
            EXISTS(SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id) AS has_docs
       FROM checklist_items ci
      WHERE ci.application_id = $1 AND ci.template_id IS NOT NULL`, [appId]);
  const byTemplate = new Map();
  for (const row of existing.rows) if (!byTemplate.has(row.template_id)) byTemplate.set(row.template_id, row);
  // A template may have several instances (shouldn't, but be safe): retracting
  // considers each; presence of ANY instance suppresses re-issuance.
  const allByTemplate = new Map();
  for (const row of existing.rows) {
    if (!allByTemplate.has(row.template_id)) allByTemplate.set(row.template_id, []);
    allByTemplate.get(row.template_id).push(row);
  }

  for (const tpl of tpls.rows) {
    let matches = false;
    if (tpl.auto_apply === 'always') matches = true;
    else if (tpl.auto_apply === 'rules' && tpl.rule_logic) {
      try { matches = rules.evaluateRule(tpl.rule_logic, ctx, fields); } catch (_) { matches = false; }
    }

    const instances = allByTemplate.get(tpl.id) || [];
    if (matches && !instances.length) {
      const summary = tpl.auto_apply === 'rules' ? rules.summarizeRule(tpl.rule_logic, { fields }) : 'applies to every file';
      // #78 guard: a borrower-visible template with NO borrower wording would show
      // the borrower a meaningless "An item your loan team needs" — a phantom the
      // team never knowingly added. Never do that: such a template is applied
      // STAFF-ONLY (the condition still exists for staff, and the internal label
      // is never leaked to the borrower). Tool / e-sign items render their own
      // borrower copy, so they're exempt. An admin who wants it borrower-facing
      // adds a borrower label in the Condition Studio and it applies normally.
      const borrowerVisible = tpl.audience === 'borrower' || tpl.audience === 'both';
      const hasBorrowerWording = !!(tpl.borrower_label && String(tpl.borrower_label).trim());
      const rendersOwnLabel = !!tpl.tool_key || !!tpl.esign_doc;
      const effTpl = (borrowerVisible && !hasBorrowerWording && !rendersOwnLabel)
        ? Object.assign({}, tpl, { audience: 'staff' }) : tpl;
      if (effTpl !== tpl) {
        try { console.warn('[conditions] template', tpl.code || tpl.id, '(', tpl.label, ') is borrower-visible but has no borrower_label — applied staff-only to avoid a phantom borrower condition (#78).'); } catch (_) {}
      }
      const id = await instantiateTemplate(effTpl, { application_id: appId }, {
        originKind: 'auto',
        originDetail: { templateVersion: tpl.version, rule: summary, reason: opts.reason || null },
      });
      // borrowerLabel must NEVER fall back to the internal tpl.label (note-buyer
      // context) — it is interpolated into the borrower notification below.
      // `code` rides along (additive) so a caller can tell WHICH rule attached this —
      // the note-buyer slot uses it to separate "this happened because you changed the
      // note buyer" from "the file was re-checked and also picked these up".
      out.added.push({ id, code: tpl.code || null, label: effTpl.label, borrowerLabel: effTpl.borrower_label || null, audience: effTpl.audience });
    } else if (!matches && tpl.auto_apply === 'rules' && instances.length) {
      for (const inst of instances) {
        const untouched = inst.origin_kind === 'auto' && inst.status === 'outstanding'
          && !inst.signed_off_at && !inst.reviewed_at && !inst.has_payload && !inst.has_docs && !inst.notes;
        if (!untouched) continue;
        await db.query(`DELETE FROM checklist_items WHERE id = $1`, [inst.id]);
        out.removed.push({ code: tpl.code || null, label: inst.label });
      }
    }
  }

  if (out.added.length || out.removed.length) {
    await auditEngine('conditions_auto_evaluated', appId, {
      reason: opts.reason || null,
      added: out.added.map((x) => x.label),
      removed: out.removed.map((x) => x.label),
    }, opts.actor);
  }

  // One borrower notification per pass, only for borrower-visible additions.
  const visible = out.added.filter((x) => x.audience === 'borrower' || x.audience === 'both');
  if (visible.length && opts.notify !== false) {
    try {
      const notify = require('../notify');
      const names = visible.map((x) => x.borrowerLabel ? `"${x.borrowerLabel}"` : 'a new item').join(', ');
      await notify.notifyAppBorrowers(appId, {
        type: 'condition_added',
        title: visible.length === 1 ? 'A new item was added to your file' : `${visible.length} new items were added to your file`,
        body: `${names} ${visible.length === 1 ? 'was' : 'were'} added to your conditions. Sign in to take care of ${visible.length === 1 ? 'it' : 'them'}.`,
        applicationId: appId, link: `/app/${appId}`, ctaLabel: 'Open your conditions',
      });
    } catch (_) { /* best-effort */ }
  }
  return out;
}

/** Re-run the engine on every open application (optionally only reporting one template). */
async function evaluateAllOpen(opts = {}) {
  const apps = await db.query(
    `SELECT id FROM applications
      WHERE deleted_at IS NULL AND status = ANY($1::text[])
      ORDER BY created_at DESC LIMIT 2000`, [OPEN_STATUSES]);
  const totals = { files: apps.rows.length, filesTouched: 0, added: 0, removed: 0 };
  for (const row of apps.rows) {
    try {
      const r = await evaluateApplication(row.id, { ...opts, reason: opts.reason || 'bulk_evaluation' });
      if (r.added.length || r.removed.length) totals.filesTouched++;
      totals.added += r.added.length;
      totals.removed += r.removed.length;
    } catch (_) { /* one bad file never stops the sweep */ }
  }
  return totals;
}

/** Re-run the engine on every open application belonging to a borrower (profile fields changed). */
async function evaluateBorrowerApplications(borrowerId, opts = {}) {
  const apps = await db.query(
    `SELECT id FROM applications
      WHERE (borrower_id = $1 OR co_borrower_id = $1) AND deleted_at IS NULL AND status = ANY($2::text[])`,
    [borrowerId, OPEN_STATUSES]);
  for (const row of apps.rows) {
    try { await evaluateApplication(row.id, opts); } catch (_) {}
  }
}

/* The details door speaks camelCase and the field registry speaks snake_case,
   and `file-lock.payoffContactLockReason` is keyed on the DETAILS door's names
   (that is where its carve-out is defined). Only the payoff contact pair needs
   translating — every other key falls through unchanged and is therefore never
   mistaken for a contact-only edit, which is the safe direction. */
const WRITE_BODY_KEY = Object.freeze({
  payoff_lender: 'payoffLender',
  payoff_loan_number: 'payoffLoanNumber',
});

/**
 * Persist a borrower's answer to an info-field condition — built-in fields
 * write the real application/borrower column; admin-defined custom fields
 * upsert into application_field_values. Returns { value } (normalized) or
 * throws { status, message }.
 */
async function writeFieldValue(appId, borrowerId, fieldKey, rawValue, by = {}) {
  const fields = await registry.fieldMap(db);
  const f = fields[fieldKey];
  const target = registry.WRITE_TARGETS[fieldKey];
  if (!f || !f.writable || (!target && !f.custom)) {
    const err = new Error('this field cannot be updated from a condition'); err.status = 400; throw err;
  }
  let value = rawValue;
  if (['money', 'number', 'percent'].includes(f.type)) {
    value = Number(String(rawValue).replace(/[$,\s]/g, ''));
    if (!isFinite(value)) { const err = new Error(`${f.label} must be a number`); err.status = 400; throw err; }
    if (f.type !== 'percent' && value < 0) { const err = new Error(`${f.label} cannot be negative`); err.status = 400; throw err; }
    if (fieldKey === 'fico' && (value < 300 || value > 850)) { const err = new Error('credit score must be between 300 and 850'); err.status = 400; throw err; }
    if (fieldKey === 'requested_ir_months' && (value < 0 || value > 24)) { const err = new Error('interest reserve must be 0–24 months'); err.status = 400; throw err; }
    if (/^(requested_exp|units|sqft)/.test(fieldKey)) value = Math.round(value);
  } else if (f.type === 'date') {
    // sanitizeDateOnly enforces a REAL calendar date with a 4-digit year in
    // [1900, 2100] — a shape-only regex accepted '0026-07-17' here, which is the
    // exact 2026-07-15 incident class on a borrower-facing typed-date surface.
    value = require('../fields').normalizeTypedDate(rawValue);   // typed '26' resolves to 2026 system-wide
    if (value == null) { const err = new Error(`${f.label} must be a valid YYYY-MM-DD date with a 4-digit year (1900–2100)`); err.status = 400; throw err; }
  } else if (f.type === 'enum') {
    if (!(f.options || []).some((o) => o.v === rawValue)) { const err = new Error(`${f.label}: pick one of the listed options`); err.status = 400; throw err; }
    value = rawValue;
  } else if (f.type === 'boolean') {
    value = !!rawValue;
  } else {
    /* Free text — trimmed, NUL-stripped, and capped by the COLUMN rather than by
       this door (post-merge audit 2026-07-31). The flat 500 here was the third
       of three different caps on the same two payoff columns, and like the other
       two it did not trim, so a box of spaces stored spaces and read as answered.
       A CUSTOM field has no column of its own; it keeps the shared default.
       An answer that trims to nothing is refused rather than stored as null: the
       caller has already required a non-empty value, and silently recording
       "not stated" while marking the condition received is how a blank passes
       for an answer. */
    value = require('../fields').textColumn(rawValue, target && target.column, 500);
    if (value == null) { const err = new Error(`${f.label} cannot be blank`); err.status = 400; throw err; }
  }

  /* A CLOSED FILE'S ECONOMICS ARE NOT REWRITABLE FROM A CONDITION
     (post-merge audit 2026-07-31; SCOPE NARROWED after the pre-merge audit —
     read the second half before widening this again).

     THE HOLE. This door had no freeze of any kind. Of the fields that target
     `applications`, only the five in the change-request whitelist that have a
     write target were ever protected, and by a DIFFERENT rule (a REGISTERED
     file routes those to an approval sandbox, so they never reach here). The
     rest — `loan_amount`, `requested_ir_amount`, `underlying_contract_price`,
     `assignment_fee`, `original_purchase_price`, `acquisition_date`, the sqft
     pair, the three experience counts and the payoff trio — wrote LIVE whatever
     the file's status. Several are pricing inputs the db/071 trigger watches,
     so answering an info condition on a FUNDED loan moved the economics AND
     reopened Products & Pricing on a closed file.

     THE RULE IS PARITY WITH THE DOOR THAT OWNS THE FIELD. Not a field list of
     this door's own — three rounds of audit each rejected a different one, and
     the reason is the same every time: any list here is a PROXY for a policy
     that is already written down somewhere else, and a proxy drifts.

       · round 1 froze the whole request via `payoffContactLockReason`;
       · round 2 dropped the term-sheet half entirely — so a borrower answered
         an info condition on `loan_amount` and moved a SIGNED term sheet's
         loan from $440,000 to $1, with no change request and no approval;
       · round 3 scoped it to the reopen trigger's watch list — which is a
         PRICING proxy, not a PRINTING one, so `payoff_amount` stayed writable
         even though it prints on the sheet twice (the payoff row, and the
         "estimated cash to you" row derived from it). Measured: staff 409,
         borrower 200, printed cash-out $85,000 → $384,999.

     Each of those was this door deciding for itself what the freeze means. It
     does not have to: every field here is ALSO editable somewhere else, and
     that other door already implements the owner's policy for it. So the rule
     is simply that answering a condition may never be MORE permissive than
     editing the same field directly:

       · `applications` fields → the staff details door owns them, and its rule
         is `payoffContactLockReason` — the status freeze, the term-sheet-sent
         freeze, and the ONE owner-directed carve-out (the payoff's
         who-and-which stays editable through closing prep, because that is
         when the payoff letter is ordered). Used verbatim here.
       · `borrowers` fields → the borrower profile door owns them, and its rule
         is the change-request sandbox on a registered file. Applied at the
         route (borrower.js), which can return a pending request rather than
         throw. Those fields are deliberately NOT frozen here.

     A field that is frozen for staff is now frozen here too, with the same
     message and the same escapes (clear the package; a super-admin unlock past
     Clear to Close). That is not a workflow regression — it is the same
     refusal staff already get on the same field, and the alternative, twice
     demonstrated, is a borrower-only bypass of a signed term sheet.

     A `borrowers`-table field is NOT frozen here — but it is not ungoverned
     either, and three rounds of this comment wrongly said it was "untouched …
     it has its own governance in change-requests.js" while nothing on the way
     in enforced that. It does now, at the ROUTE (borrower.js), which can open a
     change request rather than throw: `fico` — the one personal field that is
     actually reachable as a condition — is locked per PERSON, because that row
     is shared and db/126 re-prices every file the borrower is on.

     Fails OPEN on an unreadable file, matching `structuralLockReason`: this is
     a human's edit, not an unattended writer. */
  if (!f.custom && target && target.table === 'applications') {
    /* NO actor is passed, deliberately: a super-admin's unlock is theirs to
       spend on their own edit, not a standing permission for whatever the
       borrower (or a staffer answering on their behalf) types into a condition
       afterwards. `payoffContactLockReason` is keyed on the DETAILS door's
       camelCase names, which is where its carve-out is defined — only the
       payoff contact pair needs translating; every other key falls through
       unchanged and is therefore never mistaken for a contact-only edit. */
    const frozen = await require('../file-lock')
      .payoffContactLockReason(appId, { [WRITE_BODY_KEY[fieldKey] || fieldKey]: value }, db);
    if (frozen) { const err = new Error(frozen); err.status = 409; throw err; }
    /* SAME PARITY RULE, APPLIED TO THE LOAN PURPOSE (owner-directed 2026-08-02).
       The details door will not store a purchase price on a refinance — the loan
       is sized on the as-is value, and what the borrower paid when they bought
       the property is `original_purchase_price`. Answering a condition must not
       be more permissive than editing the field directly, so it is refused here
       too, with a message that names the field to answer instead. Reads the
       file's own purpose, not the caller's word for it. */
    if (fieldKey === 'purchase_price') {
      const row = (await db.query(`SELECT loan_type FROM applications WHERE id=$1`, [appId])).rows[0] || {};
      if (require('../deal-basis').sizesOnAsIsValue(row.loan_type)) {
        const err = new Error('This is a refinance, so there is no purchase price — it is sized on the as-is value. '
          + 'If this is what was paid when the property was bought, answer with the original purchase price instead.');
        err.status = 400; throw err;
      }
    }
  }

  if (f.custom) {
    await db.query(
      `INSERT INTO application_field_values (application_id, field_key, value, updated_by_kind, updated_by_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (application_id, field_key)
       DO UPDATE SET value=EXCLUDED.value, updated_by_kind=EXCLUDED.updated_by_kind,
                     updated_by_id=EXCLUDED.updated_by_id, updated_at=now()`,
      [appId, fieldKey, JSON.stringify(value), by.kind || 'borrower', by.id || null]);
  } else if (target.table === 'applications') {
    // #FNM1025: applications.property_type stores the portal LABEL ("Multi 2–4")
    // — that is what the forms write and what the ClickUp dropdown crosswalk is
    // keyed on. This enum path validates against the rule KEYS ("multi_2_4"), so
    // writing the key straight through left the file in a spelling no other door
    // uses: it wouldn't map to the ClickUp option, and it re-tripped every raw
    // text comparison. Canonicalize to the label on the way out.
    if (target.column === 'property_type') {
      const label = require('../property-type').canonicalPropertyTypeLabel(value);
      if (label) value = label;
    }
    await db.query(`UPDATE applications SET ${target.column}=$2, updated_at=now() WHERE id=$1`, [appId, value]);
  } else {
    await db.query(`UPDATE borrowers SET ${target.column}=$2, updated_at=now() WHERE id=$1`, [borrowerId, value]);
  }
  return { value };
}

module.exports = {
  OPEN_STATUSES,
  loadRuleContext,
  instantiateTemplate,
  evaluateApplication,
  evaluateAllOpen,
  evaluateBorrowerApplications,
  writeFieldValue,
};
