'use strict';
/**
 * THE EXPERIENCE RE-ALLOCATION CARVE-OUT + THE SUPER-ADMIN DETAILS OVERRIDE
 * (owner-directed 2026-08-13) — pure, no database.
 *
 * Three things are pinned here, and each one reproduces something that was actually
 * wrong (or would have been) before the change:
 *
 *   A. THE PREDICATE. Moving deals between fix-and-flip and fix-and-hold with the
 *      qualified total and the ground-up count unchanged is neutral; taking them out
 *      of both (to REO, or by lowering the count) is not; ground-up never moves.
 *   B. THE SCOPE TEST IS A VALUE TEST. The details form posts EVERY field on every
 *      save, so a "does the body carry only experience keys?" test would be false on
 *      every real save from the very screen this exists for — the rule would never
 *      once fire. Each non-experience key must be compared to what the file holds.
 *   C. THE FREEZE DECISIONS. The STATUS freeze always stands; the term-sheet freeze
 *      lifts for a proven re-allocation (for EVERY role) and for a super_admin who
 *      explicitly asked (never a plain admin, never without asking).
 *
 * Plus a source guard: the details door must not grow a field the shared map does
 * not know, or the carve-out silently stops working on files where that field is
 * echoed back.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const realloc = require('../src/lib/experience-realloc');
const fields = require('../src/lib/details-fields');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); checks += 1; };

const exp = (flips, holds, ground = 0, reo = 0) => ({ flips, holds, ground, reo });

// ── A. THE PREDICATE ────────────────────────────────────────────────────────────
{
  // The owner's own file: a term sheet issued on THREE fix-and-flips, verified as
  // two fix-and-flips and one fix-and-hold. Same three deals, same tier.
  ok(realloc.isNeutralReallocation(exp(3, 0), exp(2, 1)), 'A1 3 flips → 2 flips + 1 hold is neutral');
  ok(realloc.isNeutralReallocation(exp(2, 1), exp(3, 0)), 'A2 and the same swap back');
  // The owner's second example, scaled up.
  ok(realloc.isNeutralReallocation(exp(10, 0), exp(5, 5)), 'A3 10 flips → 5 flips + 5 holds is neutral');
  ok(realloc.isNeutralReallocation(exp(0, 10), exp(4, 6)), 'A4 holds → flips is neutral too');

  // "If somebody removes either fix-and-flip or fix-and-hold and he puts it through
  // REO, it does not qualify." It refuses on the TOTAL, with no rule about REO —
  // flips + holds goes 10 → 5, which is a real drop in qualified experience.
  ok(!realloc.isNeutralReallocation(exp(10, 0), exp(5, 0, 0, 5)), 'A5 10 flips → 5 flips + 5 REO REFUSED');
  ok(!realloc.isNeutralReallocation(exp(10, 0), exp(9, 0)), 'A6 a plain reduction REFUSED');
  ok(!realloc.isNeutralReallocation(exp(10, 0), exp(11, 0)), 'A7 a plain increase REFUSED');

  // "If somebody changes and he removes ground-up experience, then it does not
  // qualify." Ground-up is its own engine track and may never move — not even into
  // flips, which would keep the renovation count while zeroing the ground-up one.
  ok(!realloc.isNeutralReallocation(exp(0, 0, 3), exp(3, 0, 0)), 'A8 ground-up → flips REFUSED');
  ok(!realloc.isNeutralReallocation(exp(2, 1, 3), exp(2, 1, 2)), 'A9 ground-up lowered REFUSED');
  ok(realloc.isNeutralReallocation(exp(3, 0, 2), exp(1, 2, 2)), 'A10 a swap with ground-up held is neutral');
  /* A8 and A9 both ALSO fail the flips+holds total test, so neither of them proves
     the ground-up rule is doing any work — deleting that rule leaves both passing
     (found by mutating it out). These two isolate it: the renovation total is held
     EXACTLY and a real flip↔hold swap happens, so the ONLY thing that can refuse
     them is the ground-up comparison. Without it a ground-up would be silently
     re-tiered on a file whose term sheet has already gone out. */
  ok(!realloc.isNeutralReallocation(exp(3, 0, 2), exp(1, 2, 1)),
    'A10a a valid swap does NOT license lowering ground-up alongside it');
  ok(!realloc.isNeutralReallocation(exp(3, 0, 2), exp(1, 2, 3)),
    'A10b …nor raising it');

  // A no-op is not a re-allocation: it needs no carve-out, and reporting one would
  // put a "term sheet override" line on the file for a save that changed nothing.
  ok(!realloc.isNeutralReallocation(exp(2, 1), exp(2, 1)), 'A11 an unchanged claim is not a re-allocation');

  // REO alone moves no priced input at all — it is the residual list, not an engine
  // input and not even watched by the db/072 reopen trigger.
  ok(realloc.isPricingInert(exp(2, 1, 0, 0), exp(2, 1, 0, 4)), 'A12 a REO-only edit is pricing-inert');
  ok(!realloc.isPricingInert(exp(2, 1), exp(1, 2)), 'A13 a real swap is not "inert"');
  ok(!realloc.isNeutralReallocation(exp(2, 1, 0, 0), exp(2, 1, 0, 4)), 'A14 …and is not a re-allocation either');

  // Junk and blanks read as zero, the same way experience.requestedFromApp reads the
  // columns — so the before/after pictures are always measured on one scale.
  const from = realloc.experienceFromRow({
    requested_exp_flips: '3', requested_exp_holds: null, requested_exp_ground: undefined, requested_exp_reo: -2 });
  eq(JSON.stringify(from), JSON.stringify(exp(3, 0, 0, 0)), 'A15 row → counts, blanks and junk as 0');

  const after = realloc.experienceAfter(exp(3, 0), { requestedExpFlips: '2', requestedExpHolds: '1' });
  eq(JSON.stringify(after), JSON.stringify(exp(2, 1, 0, 0)), 'A16 a key the body omits keeps the file value');
  const partial = realloc.experienceAfter(exp(3, 2, 1, 0), { requestedExpFlips: '1' });
  eq(JSON.stringify(partial), JSON.stringify(exp(1, 2, 1, 0)), 'A17 …for every bucket the body omits');

  ok(/moves the total: 10 → 5/.test(realloc.whyNotNeutral(exp(10, 0), exp(5, 0, 0, 5))), 'A18 the refusal names the total');
  ok(/[Gg]round-up/.test(realloc.whyNotNeutral(exp(0, 0, 3), exp(3, 0, 0))), 'A19 the refusal names ground-up');
  eq(realloc.whyNotNeutral(exp(3, 0), exp(2, 1)), '', 'A20 an allowed change has nothing to explain');
  eq(realloc.describe(exp(2, 1)), '2 fix-and-flips + 1 fix-and-hold', 'A21 plain-language description');
}

// ── B. THE SCOPE TEST IS A VALUE TEST, NOT A KEY TEST ───────────────────────────
{
  // A row shaped the way the details form's save actually echoes it back: numbers as
  // pg numerics (strings), a date as a Date, blanks as NULL.
  const row = {
    units: 1, purchase_price: '250000.00', as_is_value: '250000.00', arv: '400000.00',
    rehab_budget: '80000.00', sqft_pre: null, sqft_post: null,
    requested_exp_flips: 3, requested_exp_holds: 0, requested_exp_ground: 0, requested_exp_reo: 0,
    requested_ir_months: 0, requested_ir_amount: null, payoff_amount: null,
    original_purchase_price: null, estimated_cash_out: null,
    underlying_contract_price: null, assignment_fee: null,
    property_type: 'SFR', loan_type: 'Purchase', program: 'standard', occupancy: 'Investment',
    rehab_type: 'Light Rehab', term: '12', lender: null, channel: null, ppp: null,
    payoff_lender: null, payoff_loan_number: null,
    acquisition_date: new Date('2024-03-05T00:00:00.000Z'),
    is_assignment: false, property_address: { line1: '1 Main St' },
  };
  // THE REAL SAVE: every field echoed back unchanged, only the two experience counts
  // moved. This is the case that a key-presence test gets wrong.
  const fullBody = {
    program: 'standard', loanType: 'Purchase', propertyType: 'SFR', occupancy: 'Investment',
    units: '1', purchasePrice: '250000', asIsValue: '250000', arv: '400000', rehabBudget: '80000',
    rehabType: 'Light Rehab', sqftPre: '', sqftPost: '',
    requestedExpFlips: '2', requestedExpHolds: '1', requestedExpGround: '0', requestedExpReo: '0',
    requestedIrMonths: '0', requestedIrAmount: '', term: '12',
    payoffAmount: '', payoffLender: '', payoffLoanNumber: '', estimatedCashOut: '',
    originalPurchasePrice: '', acquisitionDate: '2024-03-05',
    isAssignment: false, underlyingContractPrice: '', assignmentFee: '',
  };
  const s1 = realloc.changesOnlyExperience(row, fullBody, fields);
  ok(s1.onlyExperience, `B1 a full-form save that moves only experience passes (blocked by ${s1.blockedBy})`);

  // One other field genuinely moving → the ordinary freeze governs.
  const s2 = realloc.changesOnlyExperience(row, { ...fullBody, purchasePrice: '260000' }, fields);
  ok(!s2.onlyExperience, 'B2 a moved purchase price blocks the carve-out');
  eq(s2.blockedBy, 'purchasePrice', 'B3 …and is named');

  const s3 = realloc.changesOnlyExperience(row, { ...fullBody, term: '18' }, fields);
  eq(s3.blockedBy, 'term', 'B4 a moved term blocks it');

  // An address is only ever sent when it changed → fail closed.
  const s4 = realloc.changesOnlyExperience(row, { ...fullBody, propertyAddress: { line1: '2 Main St' } }, fields);
  eq(s4.blockedBy, 'propertyAddress', 'B5 an address in the body blocks it');

  // A key this module does not know must never ride through.
  const s5 = realloc.changesOnlyExperience(row, { ...fullBody, someNewField: 'x' }, fields);
  eq(s5.blockedBy, 'someNewField', 'B6 an unrecognised key fails CLOSED');

  // A body with no experience key at all is not a re-allocation request.
  ok(!realloc.changesOnlyExperience(row, { purchasePrice: '250000' }, fields).onlyExperience,
    'B7 no experience key → not a re-allocation');

  // The control keys ride along without counting as a change.
  ok(realloc.changesOnlyExperience(row, { ...fullBody, econVersion: 4 }, fields).onlyExperience,
    'B8 econVersion is a control key');

  // The loose comparisons, each one a shape the form really produces.
  ok(realloc.sameStoredValue('num', '250000', '250000.00'), 'B9 250000 === 250000.00');
  ok(realloc.sameStoredValue('num', '', null), 'B10 blank === NULL');
  ok(!realloc.sameStoredValue('num', '0', null), 'B11 a typed 0 is NOT a blank');
  ok(realloc.sameStoredValue('date', '2024-03-05', new Date('2024-03-05T00:00:00.000Z')), 'B12 date vs Date');
  ok(realloc.sameStoredValue('str', ' SFR ', 'SFR'), 'B13 strings compare trimmed');
  ok(realloc.sameStoredValue('bool', false, false), 'B14 booleans');
  ok(!realloc.sameStoredValue('bool', true, false), 'B15 …and a real boolean change');
  ok(!realloc.sameStoredValue('num', 'abc', '250000.00'), 'B16 junk is never "the same"');
}

// ── C. THE FREEZE DECISIONS ─────────────────────────────────────────────────────
{
  const fileLock = require('../src/lib/file-lock');
  const sent = { status: 'underwriting', structural_unlocked_at: null, ts_sent: true };
  const notSent = { status: 'underwriting', structural_unlocked_at: null, ts_sent: false };
  const ctc = { status: 'clear_to_close', structural_unlocked_at: null, ts_sent: true };
  const funded = { status: 'funded', structural_unlocked_at: null, ts_sent: false };
  const lo = { kind: 'staff', role: 'loan_officer' };
  const admin = { kind: 'staff', role: 'admin' };
  const sa = { kind: 'staff', role: 'super_admin' };

  // The re-allocation is granted to EVERYONE — the predicate is on the DATA, exactly
  // like the budget-neutral Scope-of-Work carve-out.
  eq(fileLock.experienceReallocation(sent, true, { actor: lo }), null, 'C1 a loan officer may re-allocate');
  eq(fileLock.experienceReallocation(sent, true, {}), null, 'C2 …and so may an actor-less caller');
  ok(typeof fileLock.experienceReallocation(sent, false, { actor: sa }) === 'string',
    'C3 a NON-neutral change stays frozen even for a super-admin on this path');
  eq(fileLock.experienceReallocation(notSent, false, { actor: lo }), null, 'C4 an unfrozen file is never blocked');
  // The STATUS freeze always stands — a super-admin UNLOCK is the way through those.
  ok(typeof fileLock.experienceReallocation(ctc, true, { actor: sa }) === 'string', 'C5 clear-to-close still refuses');
  ok(typeof fileLock.experienceReallocation(funded, true, { actor: sa }) === 'string', 'C6 funded still refuses');
  eq(fileLock.experienceReallocation(null, true, { actor: lo }), null, 'C7 no row → the caller decides');

  // The super-admin override: role AND an explicit request, both required.
  eq(fileLock.detailsAdminOverride(sent, { actor: sa, overrideRequested: true }), null, 'C8 super-admin + asked → allowed');
  ok(typeof fileLock.detailsAdminOverride(sent, { actor: sa }) === 'string', 'C9 holding the role alone clears nothing');
  ok(typeof fileLock.detailsAdminOverride(sent, { actor: admin, overrideRequested: true }) === 'string',
    'C10 a plain ADMIN is refused — "Only superadmin, not regular admins"');
  ok(typeof fileLock.detailsAdminOverride(sent, { actor: lo, overrideRequested: true }) === 'string',
    'C11 a loan officer is refused');
  ok(typeof fileLock.detailsAdminOverride(ctc, { actor: sa, overrideRequested: true }) === 'string',
    'C12 the STATUS freeze stands even for the super-admin override');
  eq(fileLock.detailsAdminOverride(notSent, { actor: lo, overrideRequested: false }), null,
    'C13 an unfrozen file needs no override');

  // The pre-existing carve-outs must be untouched by all of this.
  ok(typeof fileLock.structuralLockReason === 'function', 'C14 structuralLockReason still exported');
  ok(typeof fileLock.sowLockReason === 'function', 'C15 sowLockReason still exported');
  ok(typeof fileLock.payoffContactLockReason === 'function', 'C16 payoffContactLockReason still exported');
  ok(typeof fileLock.asIsArvTermSheetOverride === 'function', 'C17 asIsArvTermSheetOverride still exported');
  ok(typeof fileLock.termsNeutralReregister === 'function', 'C18 termsNeutralReregister still exported');
}

// ── D. SOURCE GUARDS ────────────────────────────────────────────────────────────
{
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');

  // The details door must read the SHARED map, not a second inline copy — a second
  // copy is how a field gets added to one and not the other, which silently disables
  // the carve-out on every file where that field is echoed back.
  ok(/const NUM = detailsFields\.NUM;/.test(routeSrc), 'D1 the door reads the shared NUM map');
  ok(/const STR = detailsFields\.STR;/.test(routeSrc), 'D2 …and STR');
  ok(/const DATE = detailsFields\.DATE;/.test(routeSrc), 'D3 …and DATE');

  // The door must ask details-freeze, and must carry the answer down to the write —
  // deciding the freeze and then not capturing/restoring would let the reopen trigger
  // undo the very thing the carve-out promises.
  ok(/detailsFreeze\.evaluate\(/.test(routeSrc), 'D4 the door consults details-freeze');
  ok(/detailsFreeze\.capture\(/.test(routeSrc), 'D5 …captures the conditions before the write');
  ok(/detailsFreeze\.restore\(/.test(routeSrc), 'D6 …and restores them after');
  ok(/detailsFreeze\.syncRegistrationExperience\(/.test(routeSrc), 'D7 …and moves the registration split on a re-allocation');

  const freezeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'details-freeze.js'), 'utf8');

  // The base rule must still be the one the door has always used.
  ok(/payoffContactLockReason/.test(freezeSrc),
    'D8 details-freeze still calls payoffContactLockReason as its base rule');

  /* THE SCOPE OF WORK MUST NEVER BE RE-ASSERTED. A changed construction budget
     genuinely invalidates the line items, so putting the SOW's sign-off back would
     claim a match that no longer exists — and db/069's guard trigger refuses that
     write anyway, so a re-assert would raise, be swallowed, and reach the same end
     state less honestly. An override lets the EDIT through and keeps the sent term
     sheet; it does not pretend the scope still matches. */
  const dfInternals = require('../src/lib/details-freeze')._internals;
  ok(!/rehab_budget/.test(dfInternals.ALL_CONDITION_SQL),
    'D9a the super-admin capture set does NOT re-assert the Scope of Work');
  ok(!/rehab_budget/.test(dfInternals.EXPERIENCE_CONDITION_SQL),
    'D9b …and neither does the re-allocation one');
  ok(/product_pricing/.test(dfInternals.EXPERIENCE_CONDITION_SQL)
    && /rtl_cond_signedts/.test(dfInternals.EXPERIENCE_CONDITION_SQL),
    'D9c …but both the conditions an experience write DOES reopen are captured');

  // The as-is/ARV override must no longer claim every adminOverride body, or a
  // super-admin editing anything else gets its 400 instead of the general override.
  ok(/isAsIsArvOnly\(b\)/.test(routeSrc), 'D10 the as-is/ARV override only claims an as-is/ARV-only body');

  // Every request key the door writes must be in the shared map. Read the door's own
  // explicit writes (the ones outside NUM/STR/DATE) and check each is known.
  for (const key of ['isAssignment', 'propertyAddress']) {
    ok(fields.kindOf(key) != null, `D10 the shared map knows "${key}"`);
  }
  // Nothing in the map may be unmapped.
  for (const [key, col] of Object.entries(fields.ALL)) {
    ok(typeof col === 'string' && col.length > 0, `D11 "${key}" maps to a column`);
    ok(fields.kindOf(key) != null, `D12 "${key}" has a kind`);
  }
}

console.log(`test-experience-realloc-pure: ${checks} checks passed`);
