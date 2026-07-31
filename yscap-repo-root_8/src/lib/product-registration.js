'use strict';

const PRODUCT_CONDITION_TYPE = 'product_registration';
const { syncExperienceChecklistForApplication } = require('./experience');
const { termWritebackText } = require('./term-text');
const { sqftForType } = require('./fields');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
// The EXPLICIT experience claim a register carried for one bucket, or null when
// none was carried (so the SET clause falls back to GREATEST — never zeroing a
// real claim from an absent value; #121). A real number — INCLUDING 0 — is a
// deliberate claim and is written verbatim (this is what lets a studio-typed 0
// finally stick). A negative/NaN is clamped to a non-negative integer.
function claimExpVal(claimedExp, key) {
  if (!claimedExp || claimedExp[key] == null) return null;
  const n = Number(claimedExp[key]);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}
function money(v) { return '$' + Math.round(num(v)).toLocaleString('en-US'); }
function pct(v, digits = 1) { return num(v) > 0 ? (num(v) * 100).toFixed(digits) + '%' : 'n/a'; }
function productName(quote) {
  return [quote.programLabel, quote.productLabel].filter(Boolean).join(' - ') || 'Registered product';
}

function assetDetail(quote) {
  const s = quote.sizing || {};
  const cc = quote.closingCosts || {};
  const lines = [
    `Registered product: ${productName(quote)}`,
    `Loan amount: ${money(s.totalLoan)}${quote.noteRate != null ? ` at ${(quote.noteRate * 100).toFixed(2)}%` : ''}.`,
    `Cash to close: ${money(quote.cashToClose)} (${money(s.downPayment)} down payment + ${money(cc.dueAtClosing)} estimated closing costs${s.assignmentExcessOOP > 0 ? ` + ${money(s.assignmentExcessOOP)} assignment excess` : ''}).`,
    `Assets/liquidity to verify: ${money(quote.liquidityRequired || quote.liquidity)} (${money(quote.cashToClose)} cash to close + ${money(quote.reserveRequirement)} reserve requirement).`,
  ];
  if (quote.reserveBasis) lines.push(`Reserve basis: ${quote.reserveBasis}.`);
  if (cc.appraisalPoc > 0) lines.push(`Appraisal estimate: ${money(cc.appraisalPoc)} paid outside closing.`);
  return lines.join('\n');
}

function manualDetail(quote) {
  const reasons = (quote.reasons || [])
    .filter((r) => r && r.level !== 'ELIGIBLE')
    .map((r) => r.msg)
    .filter(Boolean);
  return [
    `Registered product: ${productName(quote)}`,
    `Status at registration: ${quote.status || 'MANUAL'}.`,
    reasons.length ? `Pricing/guideline items:\n${reasons.map((r) => `- ${r}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}

async function replaceProductConditions(client, { appId, registrationId, quote, registeredByStaffId }) {
  await client.query(
    `UPDATE conditions
        SET status='waived',
            waive_reason=COALESCE(waive_reason, 'Replaced by a newer product registration'),
            cleared_at=COALESCE(cleared_at, now()),
            updated_at=now()
      WHERE application_id=$1
        AND linked_entity_type=$2
        AND status IN ('open','borrower_responded')`,
    [appId, PRODUCT_CONDITION_TYPE]);

  // NOTE: the liquidity / "verify assets" requirement is NOT created here as a
  // separate underwriting condition anymore — it lives as the single dynamic
  // checklist condition rtl_p3_assets (see src/lib/liquidity.js), which shows in
  // the regular conditions-to-close, carries the full cash-to-close breakdown,
  // and reopens ONLY when the required liquidity goes up. Creating it here too
  // produced a duplicate that reopened on every re-register regardless.

  if (quote.status === 'MANUAL') {
    await client.query(
      `INSERT INTO conditions
         (application_id,title,detail,audience,severity,linked_entity_type,linked_entity_id,created_by)
       VALUES ($1,$2,$3,'staff','prior_to_docs',$4,$5,$6)`,
      [
        appId,
        'Clear manual pricing exceptions',
        manualDetail(quote),
        PRODUCT_CONDITION_TYPE,
        registrationId,
        registeredByStaffId || null,
      ]);
  }
}

// The borrower's own headline loan terms — the "real numbers" a borrower would
// notice. Two registrations with the same key mean the borrower's DEAL is
// unchanged (an internal re-register for the same stuff), so the borrower should
// NOT get another "your terms are ready" nudge (owner-directed 2026-07-20). Uses
// the stable priced OUTPUTS (loan amount, rate, cash-to-close, term, program) —
// not noisy internal fields — so a genuine change (any of these) re-notifies and
// a no-op re-register stays silent.
function borrowerTermsKey({ program, productLabel, noteRate, totalLoan, quote, inputs }) {
  const q = quote || {}; const i = inputs || {}; const s = q.sizing || {};
  return JSON.stringify([
    program || '',
    productLabel || '',
    Math.round(num(totalLoan)),
    noteRate == null ? null : Number(noteRate).toFixed(5),
    i.term == null ? null : String(i.term),
    q.cashToClose == null ? null : Math.round(num(q.cashToClose)),
    // Also the money the borrower actually RECEIVES at closing vs. holds back —
    // a split change (same total loan, different advance/holdback) is a real
    // borrower-facing number even when cash-to-close is unchanged, so it must
    // re-notify ("ANY number that really changed", owner-directed 2026-07-20).
    s.initialAdvance == null ? null : Math.round(num(s.initialAdvance)),
    s.rehabHoldback == null ? null : Math.round(num(s.rehabHoldback)),
    // Out-of-pocket rehab exception (owner-authorized 2026-07-31) — a change re-notifies.
    s.oopRehab == null ? null : Math.round(num(s.oopRehab)),
  ]);
}

/* ---- rehab type: the scope the studio priced, written back onto the file ----
 *
 * The Term Sheet Studio makes the registrant state the rehab SCOPE ("Light /
 * moderate" vs "Heavy rehab (full gut / structural)", plus "Adding square
 * footage") and prices off it — a heavy rehab carries a rate add-on, a
 * footprint expansion caps LTC at 87.5%. That choice reached the registration
 * row (inputs.heavyRehab / inputs.sqftAddition) and nothing else: the write-back
 * below never touched `applications.rehab_type`. So a file created without a
 * rehab type (staff New File, a ClickUp-originated file) still read "Rehab type
 * —" on the loan application after the officer registered it as, say, a
 * cosmetic/light rehab, and everything downstream that keys off the column — the
 * ClickUp "Rehab Type" dropdown, the Encompass map, the Sitewire construction
 * type, the ground-up checklist reconcile, the investor tapes — stayed blank
 * too (owner-reported 2026-07-27).
 */

// The five canonical labels: the loan application's own dropdown (Apply /
// StaffNewFile / EditFileDetails REHAB_TYPES) and exactly the keys the ClickUp
// "Rehab Type" crosswalk maps, so a written value always has a ClickUp twin.
const REHAB_TYPE = {
  cosmetic: 'Cosmetic',
  moderate: 'Moderate',
  heavy: 'Heavy / gut rehab',
  sqft: 'Adding square footage',
  groundUp: 'Ground-up construction',
};

// The (heavy, sq-ft) pair a rehab-type LABEL implies — the same two regexes
// pricing.js buildInputs runs on `applications.rehab_type`, so the comparison
// below is on exactly the basis the frozen engines see.
function scopeOfRehabType(label) {
  const s = String(label || '');
  return { heavy: /heavy|gut|ground/i.test(s), sqft: /square|sf|addition|ground/i.test(s) };
}

// The rehab type the REGISTERED scenario describes, or null when the scenario
// has no opinion (a bridge / stabilized deal has no rehab scope; neither does a
// renovation strategy priced with no rehab money) — null always leaves the
// file's own value alone.
function rehabTypeFromInputs(inputs) {
  const i = inputs || {};
  const strategy = String(i.strategy || '');
  if (/ground/i.test(strategy)) return REHAB_TYPE.groundUp;
  if (/bridge|stabil/i.test(strategy)) return null;
  if (i.sqftAddition) return REHAB_TYPE.sqft;
  if (i.heavyRehab) return REHAB_TYPE.heavy;
  if (!(num(i.rehabBudget) > 0)) return null;
  // The studio's option reads "Light / moderate rehab" — Moderate is its label.
  return REHAB_TYPE.moderate;
}

/**
 * PURE — the rehab type this registration should write onto the file, or null
 * for "leave it exactly as it is". Exported for the unit test.
 *
 * Deliberately conservative in one direction: the label is only rewritten when
 * the registered scope genuinely DIFFERS from what the file was already pricing
 * as. `rehab_type` → (heavy, sq-ft) is lossy — Cosmetic and Moderate both price
 * as a light rehab — so a borrower's "Cosmetic" must never be flattened to
 * "Moderate" just because the officer re-registered the same scenario. The
 * file's side of that comparison uses BOTH signals buildInputs reads (the label
 * AND an actual footprint increase), so a legacy file carrying stale sq ft isn't
 * relabelled behind the registrant's back either.
 *
 * @param current {{rehabType, sqftPre, sqftPost}} the file's values today
 * @param inputs  the frozen-engine inputs being registered
 */
function rehabTypeWriteback(current, inputs) {
  const derived = rehabTypeFromInputs(inputs);
  if (!derived) return null;
  const cur = String((current && current.rehabType) || '').trim();
  if (!cur) return derived;                       // the blank file the owner reported
  const was = scopeOfRehabType(cur);
  const fileScope = {
    heavy: was.heavy,
    sqft: was.sqft || num(current && current.sqftPost) > num(current && current.sqftPre),
  };
  const now = scopeOfRehabType(derived);
  if (fileScope.heavy === now.heavy && fileScope.sqft === now.sqft) return null;  // same scope
  return derived;
}

/* =====================================================================
   CAN THIS QUOTE ACTUALLY BE RECORDED? (post-merge audit 2026-07-31.)

   `product_registrations` holds the note rate in numeric(7,5) and the loan
   amount in numeric(14,2). Nothing checked either, and the admin pricing zone
   is open to EVERY staff role since 2026-07-27 — so a fat-fingered markup or
   origination figure produced a rate the column cannot hold, Postgres raised
   22003 mid-transaction, and the register came back a 500 "server error" with
   no hint which box caused it. (It also leaked the pooled connection on the way
   out, which is the far worse half of the same event and is fixed separately in
   the route.)

   Guarded on the QUOTE rather than on the knobs deliberately. The overflow is a
   property of the numbers the engine PRODUCED, so testing them catches every
   route in, including a combination of individually-plausible inputs — and it
   can never refuse an override that yields numbers the file can store, which a
   bounds check on the knobs eventually would. No frozen engine value is read,
   changed or clamped; this only decides whether the result is recordable.

   Returns a plain-language reason, or '' when the quote can be stored. PURE.
   Call it BEFORE opening the transaction so a refusal leaves nothing half-done.
   ===================================================================== */
function quoteStorageProblem(quote, inputs) {
  const nb = require('./number-bounds');
  const q = quote || {};
  const s = q.sizing || {};
  const i = (inputs && typeof inputs === 'object') ? inputs : {};
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };

  /* EVERY value this registration binds, with the ceiling of the column it is
     actually bound to. The first cut checked three of them and was calibrated to
     the WRONG column on its headline field, so six studio boxes still produced a
     500 (pre-merge audit 2026-07-31) — a 1,000% markup, a 25-month reserve, a
     negative reserve, an oversized reserve amount / ARV, and an absurd
     experience count. Measured, all six, through the real register door.

     Order matters only for which message is shown first; each row is
     [value, column-kind, what the person should go and look at]. */
  const rate = n(q.noteRate);
  const checks = [
    // product_registrations.note_rate numeric(7,5) — the fraction…
    [rate, 'rate', 'a note rate', 'Check the rate markup and any manual rate in the admin pricing zone.'],
    /* …and applications.rate_pct numeric(6,3), which is that SAME rate × 100 and
       therefore overflows a factor of ten sooner. This is the ceiling that
       actually binds; guarding only the first admits a 1,000% markup. */
    [rate == null ? null : rate * 100, 'pct', 'a note rate',
      'Check the rate markup and any manual rate in the admin pricing zone.'],
    [n(s.totalLoan), 'money', 'a loan amount', ''],
    // applications.ltv numeric(6,3), written as a percent.
    [n(s.acqLtvPct) == null ? null : n(s.acqLtvPct) * 100, 'pct', 'an LTV',
      'Check the manual LTV / LTC values in the admin pricing zone.'],
    [n(i.targetLTC), 'rate', 'a loan-to-cost',
      'Check the manual LTC / LTV values in the admin pricing zone.'],
    [n(i.rehabBudget), 'money', 'a rehab budget', ''],
    [n(i.arv), 'money', 'an after-repair value', ''],
    [n(i.irAmount), 'money', 'an interest reserve', 'Check the interest reserve.'],
    [n(i.sellerPrice), 'money', 'an original contract price', ''],
    [n(i.purchasePrice), 'money', 'a purchase price', ''],
    // assignment_fee is DERIVED (purchase − seller), so the parts can each be
    // storable while the result is not.
    [n(i.purchasePrice) != null && n(i.sellerPrice) != null
      ? Math.max(0, n(i.purchasePrice) - n(i.sellerPrice)) : null, 'money', 'an assignment fee', ''],
    // requested_ir_months carries a CHECK of 0..24, narrower than its type.
    [n(i.irMonths), { min: 0, max: 24, what: 'months' }, 'an interest reserve term',
      'The interest reserve must be between 0 and 24 months.'],
    [n(i.expFlips), 'int', 'an experience count', ''],
    [n(i.expHolds), 'int', 'an experience count', ''],
    [n(i.expGround), 'int', 'an experience count', ''],
    /* NO sqft rows here, deliberately. `pricing.buildInputs` never emits
       `sqftPre`/`sqftPost` (only the derived `sqftAddition` flag), and the
       register binds `sqft_pre`/`sqft_post` from the FILE's previous values via
       `sqftForType`, not from `inputs` — so a guard on them was unreachable
       code claiming coverage it did not have (re-audit 2026-07-31: it was the
       one mutation of this function that survived the suite). Those columns are
       guarded where they are actually written: the create doors and the details
       door, via `fields.applicationNumberProblem` / `numberOutOfRange`. */
  ];

  for (const [value, kind, what, hint] of checks) {
    if (value == null) continue;
    const bad = nb.columnProblem('value', value, kind);
    if (!bad) continue;
    return `Those inputs produce ${what} this file cannot record.`
      + (hint ? ` ${hint}` : ` ${bad.replace(/^value /, 'The value ')}`);
  }
  return '';
}

async function persistProductRegistration(client, { appId, program, inputs, quote, registeredByStaffId, isManual, assetMonths, termOptions, needsApproval, overrideChanges, claimedExp }) {
  const s = quote.sizing || {};
  const total = num(s.totalLoan);
  // Term-sheet options (owner-directed 2026-07-22) — DISPLAY / record only,
  // resolved by the caller (min-interest default by program, accrual, deferred
  // fee, and the key dates derived from the estimated closing date). Never
  // affects any sized number. Absent => leave the file's existing values as-is.
  const to = termOptions && typeof termOptions === 'object' ? termOptions : null;
  // Snapshot the PREVIOUS current registration BEFORE we supersede it, so we can
  // tell the borrower email whether their deal actually changed.
  const prev = (await client.query(
    `SELECT program, product_label, note_rate, total_loan, quote, inputs
       FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0] || null;
  // Capture the loan amount BEFORE this registration overwrites it — the caller
  // auto-clears a signed Heter Iska when the loan amount actually moves (the ISKA
  // is tied to the loan amount). owner-directed 2026-07-22. Also capture the
  // file's current TERM text so the write-back below can preserve its spelling.
  const prevLoanRow = (await client.query(
    `SELECT loan_amount, term, rehab_type, sqft_pre, sqft_post FROM applications WHERE id=$1`, [appId])).rows[0];
  const prevLoanAmount = prevLoanRow ? Number(prevLoanRow.loan_amount) : null;
  const newKey = borrowerTermsKey({ program, productLabel: quote.productLabel, noteRate: quote.noteRate, totalLoan: total, quote, inputs });
  const prevKey = prev ? borrowerTermsKey({ program: prev.program, productLabel: prev.product_label, noteRate: prev.note_rate, totalLoan: prev.total_loan, quote: prev.quote, inputs: prev.inputs }) : null;
  // First registration (no prev) always notifies; a re-register notifies only
  // when a headline number actually moved.
  const economicsChanged = prevKey == null || prevKey !== newKey;
  await client.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1 AND is_current`, [appId]);
  const ins = await client.query(
    `INSERT INTO product_registrations
       (application_id, program, product_label, status, note_rate, total_loan, target_ltc, inputs, quote, is_current, registered_by, is_manual, asset_months, term_options, needs_approval, override_changes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      appId,
      program,
      quote.productLabel || null,
      quote.status,
      quote.noteRate,
      total,
      inputs.targetLTC || null,
      JSON.stringify(inputs),
      JSON.stringify(quote),
      registeredByStaffId || null,
      !!isManual || program === 'manual',
      (assetMonths != null && isFinite(Number(assetMonths))) ? Math.round(Number(assetMonths)) : null,
      to ? JSON.stringify(to) : null,
      // db/343 — these terms may not be confirmed to the borrower (and no
      // DocuSign term sheet may issue) until an admin approves the escalation.
      // A caller that doesn't compute it falls back to the pre-343 meaning.
      needsApproval != null ? !!needsApproval : (!!isManual || program === 'manual' || quote.status === 'MANUAL'),
      (Array.isArray(overrideChanges) && overrideChanges.length) ? JSON.stringify(overrideChanges) : null,
    ]);
  const registrationId = ins.rows[0].id;
  // Registration COMMITS the priced scenario onto the file. Beyond loan amount /
  // rate / experience, write back the economic structure the studio priced —
  // rehab budget, term, interest-reserve months, ARV, and the assignment split —
  // so the Application details (and therefore ClickUp, which mirrors these
  // columns outbound) reflect exactly what was registered. `inputs` mirrors the
  // file (buildInputs) plus the studio's overrides, so unchanged fields are
  // written back identically (idempotent) and only what the studio actually
  // changed moves. The register routes trigger the ClickUp push.
  //
  // Deliberately NOT written back: purchase_price and as_is_value. Those are
  // owner-entered application fields, but buildInputs derives them for pricing
  // (purchasePrice = underlying+fee on an assignment; asIsValue defaults to the
  // purchase price when the file leaves it blank so it auto-tracks). Writing the
  // derived values back would clobber the entered purchase price on an assignment
  // and freeze the "as-is = purchase" auto-tracking — so they stay owned by the
  // application form. The assignment split still flows via underlying/fee below.
  const ratePct = quote.noteRate != null ? (quote.noteRate * 100) : null;
  const isAssign = !!inputs.isAssignment;
  // The rehab SCOPE the studio priced, onto the file (see rehabTypeWriteback).
  // null = the registration has no opinion, or the file already says the same
  // thing in its own words — write the existing values back unchanged so the
  // IS DISTINCT FROM change triggers (db/096/145/190) stay quiet. When the scope
  // DID move, sqft_pre/sqft_post ride through the same sqftForType coupling
  // every other write path uses, so a type that isn't an addition can't leave
  // stale square footage behind to flip sqftAddition back on in the next quote.
  const wasRehab = {
    rehabType: (prevLoanRow && prevLoanRow.rehab_type) || null,
    sqftPre: (prevLoanRow && prevLoanRow.sqft_pre) != null ? prevLoanRow.sqft_pre : null,
    sqftPost: (prevLoanRow && prevLoanRow.sqft_post) != null ? prevLoanRow.sqft_post : null,
  };
  const newRehabType = rehabTypeWriteback(wasRehab, inputs);
  const rehabType = newRehabType || wasRehab.rehabType;
  const sqf = newRehabType
    ? sqftForType(rehabType, wasRehab.sqftPre, wasRehab.sqftPost)
    : { sqftPre: wasRehab.sqftPre, sqftPost: wasRehab.sqftPost };
  // The FINANCED portion of the rehab (owner-directed 2026-07-31) — what the loan
  // actually advances through draws = the holdback AFTER the OOP-rehab exception moved
  // money to the initial advance. rehab_budget stays the FULL construction budget (the
  // Sitewire budget must equal it — G-RECON); financed_rehab_budget is the part financed,
  // so the loan file "understands it's more initial and less construction". With no
  // exception the holdback equals the full budget, so financed_rehab_budget tracks
  // rehab_budget and the derived out-of-pocket floor (rehab_budget − financed) is 0.
  const financedRehab = s.rehabHoldback == null ? num(inputs.rehabBudget) : Math.round(num(s.rehabHoldback));
  await client.query(
    `UPDATE applications
        SET loan_amount=$2,
            rate_pct=$3,
            ltv=$4,
            -- requested_exp_* is the borrower's CLAIMED experience (what the
            -- experience condition requires). Sizing prices off the CLAIMED count
            -- (loadFileForPricing.exp = requested_exp ?? verified, #85).
            --
            -- Owner-directed 2026-07-28 ("no matter how many times I remove the 5
            -- and put 0 it comes back"): a staffer who EXPLICITLY types an
            -- experience count in the Term Sheet Studio may set it to ANY value —
            -- including LOWERING it — and it must stick. The studio always sends
            -- the field's current value (it prefills it), so claimedExp carries a
            -- per-field number ONLY when the register explicitly provided one
            -- ($20/$21/$22); that value wins verbatim (COALESCE picks it even when
            -- it is 0). When it is NULL — no experience was carried on this
            -- register path — the old, conservative GREATEST($5/$6/$7) is kept, so
            -- a path that never touches experience can never zero a real claim and
            -- revert the condition to "No experience required" (#121). Clearing the
            -- studio field to BLANK sends nothing → NULL → GREATEST (a blank is not
            -- a deliberate zero). The claim is otherwise owned by the application
            -- form / details edit, which has always been able to lower it directly.
            requested_exp_flips=COALESCE($20::int, GREATEST(COALESCE(requested_exp_flips,0), $5)),
            requested_exp_holds=COALESCE($21::int, GREATEST(COALESCE(requested_exp_holds,0), $6)),
            requested_exp_ground=COALESCE($22::int, GREATEST(COALESCE(requested_exp_ground,0), $7)),
            rehab_budget=$8,
            term=$9,
            requested_ir_months=$10,
            arv=$11,
            is_assignment=$12,
            underlying_contract_price = CASE WHEN $12 THEN $13 ELSE underlying_contract_price END,
            assignment_fee            = CASE WHEN $12 THEN $14 ELSE assignment_fee END,
            desired_rate=$15,
            requested_ir_amount=$16,
            rehab_type=$17,
            sqft_pre=$18,
            sqft_post=$19,
            financed_rehab_budget=$23,
            updated_at=now()
      WHERE id=$1`,
    [
      appId,
      total,
      ratePct,
      s.acqLtvPct > 0 ? (s.acqLtvPct * 100) : null,
      num(inputs.expFlips),
      num(inputs.expHolds),
      num(inputs.expGround),
      num(inputs.rehabBudget),
      // Preserve the file's existing term SPELLING when it already means the
      // registered month count ("12 Months" stays "12 Months", never rewritten to
      // the bare "12") — the cosmetic rewrite is what kept re-tripping the
      // pricing-change detectors on every ClickUp echo (owner-reported
      // 2026-07-24, "Term: 12 → 12 Months"). A REAL term change still writes
      // the new value, in the ClickUp-friendly "<n> Months" form.
      termWritebackText(prevLoanRow && prevLoanRow.term, inputs.term),
      num(inputs.irMonths),
      num(inputs.arv) || null,
      isAssign,
      isAssign ? (num(inputs.sellerPrice) || null) : null,
      isAssign ? Math.max(0, num(inputs.purchasePrice) - num(inputs.sellerPrice)) : null,
      ratePct != null ? ratePct.toFixed(3) : null,   // desired_rate is TEXT; mirror the registered rate
      num(inputs.irAmount) || null,                   // $16 — exact interest-reserve amount (null = months path)
      rehabType || null,                              // $17 — registered rehab scope (unchanged unless it moved)
      sqf.sqftPre, sqf.sqftPost,                      // $18/$19 — kept in step with $17
      // $20/$21/$22 — the EXPLICIT experience claim from the studio (a real
      // number, incl. 0, wins verbatim so it can be lowered); NULL keeps the
      // conservative GREATEST above. See the SET clause note.
      claimExpVal(claimedExp, 'flips'),
      claimExpVal(claimedExp, 'holds'),
      claimExpVal(claimedExp, 'ground'),
      financedRehab,                                  // $23 — financed rehab (holdback); full budget when no OOP exception
    ]);
  // Term-sheet options onto the file (owner-directed 2026-07-22) — only when the
  // caller supplied them, so a path that doesn't touch them leaves the file's
  // existing values alone. min_interest_enabled stores the RESOLVED boolean (the
  // route already applied the program default). The key dates are DERIVED from
  // the estimated closing date + term; an empty closing date clears all three.
  if (to) {
    await client.query(
      `UPDATE applications
          SET accrual_type = COALESCE($2, accrual_type),
              min_interest_enabled = $3,
              deferred_orig_pct = COALESCE($4, deferred_orig_pct),
              est_closing_date = $5,
              -- Keep the canonical closing date (expected_closing, ClickUp-synced +
              -- staff-editable) in lock-step with the term-sheet closing date: fill
              -- it when the studio supplies one, never clobber an existing value.
              expected_closing = COALESCE($5, expected_closing),
              first_payment_date = $6,
              maturity_date = $7,
              updated_at = now()
        WHERE id=$1`,
      [
        appId,
        to.accrualType || null,
        (to.minInterestEnabled === true || to.minInterestEnabled === false) ? to.minInterestEnabled : null,
        (to.deferredOrigPct != null && to.deferredOrigPct !== '') ? Number(to.deferredOrigPct) : null,
        to.estClosing || null,
        to.firstPayment || null,
        to.maturity || null,
      ]);
  }
  await replaceProductConditions(client, { appId, registrationId, quote, registeredByStaffId });
  await syncExperienceChecklistForApplication(appId, client);
  // The applications write-back above trips the db/096 economics trigger, which
  // flags the CURRENT registration stale ("fatal") — but the row it flags is the
  // one we are registering right now. Registration IS the re-verification that flag
  // asks for, so clear it on the fresh row (do it LAST, after the experience sync,
  // so nothing re-flags it). Leaving it set silently disabled the experience-drop
  // fatality guard, which filters `is_current AND NOT stale` (audit #4/#9/#13).
  await client.query(
    `UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE id=$1`, [registrationId]);
  // Did the loan amount actually move? Compare on the EXACT stored value vs the
  // value we just wrote — the same basis as the db/280 trigger's IS DISTINCT
  // FROM — so the app-layer auto-clear can never lag the trigger's condition
  // reopen. In practice both are whole dollars (the engine floors the loan).
  const loanAmountChanged = Number(prevLoanAmount || 0) !== Number(total);
  return { id: registrationId, economicsChanged, loanAmountChanged };
}

/**
 * Build the BORROWER-facing "your loan terms are ready" notification for a
 * product registration — the same rich, borrower-safe layout on BOTH register
 * paths (staff registers, or the borrower self-registers), so the borrower is
 * no longer left with a thin note while the loan team gets the full picture
 * (owner-directed 2026-07-20). Returns notify opts (the caller adds
 * `applicationId`). NEVER exposes a note-buyer / capital-partner name — it uses
 * only the borrower program label + the borrower's own deal numbers, and the
 * notify chokepoint scrubs again as defense-in-depth.
 *
 * @param {object} p
 * @param {object} p.ctx        notify.fileContext(appId) result (for property/loan# identity) — optional
 * @param {object} p.quote      the pricing quote
 * @param {number} p.total      the sized total loan (whole dollars)
 * @param {number} [p.termMonths] loan term in months (from inputs.term)
 * @param {object} [p.officer]  { name, title, email, phone, nmls } assigned LO — for From/branding
 */
function borrowerTermsEmail({ ctx, quote, total, termMonths, officer, termOptions } = {}) {
  quote = quote || {};
  const s = quote.sizing || {};
  const cc = quote.closingCosts || {};
  const rate = quote.noteRate != null ? (quote.noteRate * 100).toFixed(2) + '%' : null;
  const programLabel = quote.programLabel || 'your program';
  // Term-sheet options (owner-directed 2026-07-22): only surface what applies.
  const to = termOptions && typeof termOptions === 'object' ? termOptions : {};
  const minInterestOn = to.minInterestEnabled === true;
  const accrualNice = to.accrualType === 'dutch' ? 'Dutch / Full-Boat' : 'Non-Dutch / As-Drawn';
  const prettyDate = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };
  const officerLine = officer && officer.name
    ? `${officer.name}${officer.title ? ' · ' + officer.title : ''}${officer.nmls ? ' · NMLS #' + officer.nmls : ''}`
      + (officer.phone || officer.email ? ' · ' + [officer.phone, officer.email].filter(Boolean).join(' · ') : '')
    : null;
  const hasHoldback = num(s.rehabHoldback) > 0;
  const meta = [
    ctx ? { label: 'Property', value: ctx.addr } : null,
    ctx && ctx.hasLoanNo ? { label: 'Loan #', value: ctx.loanNo } : null,
    { label: 'Program', value: programLabel },
    { label: 'Loan amount', value: money(total != null ? total : s.totalLoan) },
    rate ? { label: 'Note rate', value: rate } : null,
    termMonths ? { label: 'Term', value: `${termMonths} months` } : null,
    num(s.monthlyPayment) > 0 ? { label: 'Monthly payment (interest only)', value: money(s.monthlyPayment) } : null,
    hasHoldback ? { label: 'Initial advance at closing', value: money(s.initialAdvance) } : null,
    hasHoldback ? { label: 'Rehab holdback (drawn as work completes)', value: money(s.rehabHoldback) } : null,
    // Out-of-pocket rehab exception (owner-authorized 2026-07-31): the rehab the
    // borrower funds themselves over construction (0 unless an approved exception).
    num(s.oopRehab) > 0 ? { label: 'Rehab paid out of pocket (funded as the work is done)', value: money(s.oopRehab) } : null,
    num(s.financedReserve) > 0 ? { label: 'Financed interest reserve', value: money(s.financedReserve) } : null,
    quote.cashToClose != null ? { label: 'Estimated cash to close', value: money(quote.cashToClose) } : null,
    (quote.liquidityRequired ?? quote.liquidity) != null ? { label: 'Reserves to verify', value: money(quote.liquidityRequired ?? quote.liquidity) } : null,
    { label: 'Guaranty', value: to.coBorrowerPgWaived === true
        ? 'Full recourse — co-borrower’s personal guarantee waived (approved exception)'
        : 'Full recourse — personal guarantee required' },
    { label: 'Interest accrual', value: accrualNice },
    to.firstPayment && prettyDate(to.firstPayment) ? { label: 'First payment date (estimated)', value: prettyDate(to.firstPayment) } : null,
    to.maturity && prettyDate(to.maturity) ? { label: 'Maturity date (estimated)', value: prettyDate(to.maturity) } : null,
    Number(to.deferredOrigPct) > 0 ? { label: 'Deferred origination fee (paid at payoff)', value: Number(to.deferredOrigPct) + '%' } : null,
    officerLine ? { label: 'Your loan officer', value: officerLine } : null,
  ].filter(Boolean);
  const lines = [
    'This reflects the structure your loan team registered. Open your portal to review the full term sheet, including all estimated closing costs.',
  ];
  if (minInterestOn) lines.push('Minimum earned interest: 3 months. If the loan pays off before three full months, the remainder of the three-month minimum interest is still due — this is a minimum earned-interest provision, not a prepayment penalty.');
  if (to.firstPayment && to.maturity && prettyDate(to.firstPayment)) lines.push('The first payment and maturity dates shown are estimates based on the estimated closing date and will be confirmed on your loan documents.');
  if (officer && officer.name) lines.push(`Questions? Reach out to ${officer.name} directly — you can also just reply to this email.`);
  return {
    type: 'term_sheet',
    title: 'Your loan terms are ready',
    // Hero: the loan amount is the one number the borrower is looking for — lead
    // with it, big, with the rate as the sub-line.
    hero: { label: 'Your loan amount', value: money(total != null ? total : s.totalLoan), sub: rate ? `at ${rate}${termMonths ? ` · ${termMonths}-month term` : ''}` : (termMonths ? `${termMonths}-month term` : ''), tone: 'gold' },
    badge: { text: 'Terms ready', tone: 'gold' },
    body: `Your ${programLabel} is registered. Here are your current terms — the full term sheet, with every estimated closing cost, is in your portal.`,
    lines,
    meta,
    ctaLabel: 'Review your full term sheet',
  };
}

module.exports = {
  persistProductRegistration, quoteStorageProblem, borrowerTermsEmail, borrowerTermsKey, money, productName,
  rehabTypeWriteback, rehabTypeFromInputs, REHAB_TYPE,
};
