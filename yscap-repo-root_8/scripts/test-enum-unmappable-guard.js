'use strict';

/**
 * The "Fix & Flip → Fix & Hold bounces back and doesn't save" class
 * (owner-reported 2026-07-27).
 *
 * A two-way ClickUp dropdown value that PILOT can hold but ClickUp has no option
 * for was pushed as NOTHING (crosswalk → no label → mapper.put() drops it), and
 * the next inbound pull then wrote ClickUp's stale value back over the officer's
 * edit via `program = COALESCE($n, program)`. The edit saved and was reverted
 * seconds later, which reads as "the Save button does nothing".
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const X = require('../src/clickup/crosswalk');
const guard = require('../src/lib/inbound-enum-guard');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

/* ---------------------------------------------------------------- crosswalk */

// THE REPORTED VALUE. 'Fix & Hold' is a real PILOT program (pricing.js prices it,
// the EMCAP tape exports it). The owner added the ClickUp option on 2026-07-27
// named "Fix & Hold WITH CONSTRUCTION" and directed that our plain 'Fix & Hold'
// map to it — "it's the same" — exactly like the flip pair, where our
// 'Fix & Flip w/ Construction' maps to ClickUp's "Fix & Flip With Construction".
ok(!X.unmappableToClickUp('program', 'Fix & Hold'), 'Fix & Hold has a crosswalk label');
{
  // PIN THE EXACT LIVE LABEL. Verified against the real dropdown via the ClickUp
  // connector; if the option is ever renamed, the push silently stops landing and
  // the value starts bouncing back again — so assert the spelling, don't assume it.
  eq(X.toClickUpLabel('program', 'Fix & Hold'), 'Fix & Hold With Construction',
    'Fix & Hold maps to the REAL ClickUp option label');
  eq(X.toClickUpLabel('program', 'Fix & Flip w/ Construction'), 'Fix & Flip With Construction',
    'the flip pair it mirrors is unchanged');

  const beforeOwnerAddedIt = [{ name: 'Fix & Flip With Construction' }, { name: 'bridge Without Construction' }, { name: 'Ground-Up' }];
  ok(X.unmappableToClickUp('program', 'Fix & Hold', beforeOwnerAddedIt),
    'Fix & Hold was unmappable while the ClickUp option was missing — value protected');
  const afterOwnerAddedIt = [...beforeOwnerAddedIt, { name: 'Fix & Hold With Construction' }];
  ok(!X.unmappableToClickUp('program', 'Fix & Hold', afterOwnerAddedIt),
    'now the option exists it syncs normally');
  // The write resolves to that option's real id — this is what makes it round-trip.
  const withIds = [{ id: 'opt-fh', name: 'Fix & Hold With Construction' }];
  eq(X.resolveWriteId('program', 'Fix & Hold', withIds), 'opt-fh', 'outbound resolves the Fix & Hold option id');
  // And the INBOUND read maps the real label back to our canonical value.
  eq(X.fromClickUpLabel('program', 'Fix & Hold With Construction'), 'Fix & Hold',
    'inbound reads the real ClickUp label back as Fix & Hold');
  // Spelling tolerance on the read side (fromExtra) — a hand-set or renamed option.
  eq(X.fromClickUpLabel('program', 'Fix & Hold'), 'Fix & Hold', 'inbound tolerates the short "Fix & Hold"');
  eq(X.fromClickUpLabel('program', 'Fix and Hold'), 'Fix & Hold', 'inbound tolerates "Fix and Hold"');
  eq(X.fromClickUpLabel('program', 'Fix and Hold With Construction'), 'Fix & Hold', 'inbound tolerates the "and" long form');
  eq(X.fromClickUpLabel('program', 'BRRRR'), 'Fix & Hold', 'inbound tolerates "BRRRR"');
}
// The OTHER two inbound gaps the audit turned up, both answered by the owner
// (2026-07-27). Each is a live ClickUp option that used to read back as NOTHING,
// so a card set to it left the portal on its stale value (COALESCE keeps ours).
{
  // "Free" means RENT-free — NOT 'own free and clear', which is its own option
  // sitting right next to it in the same dropdown. Getting these two backwards
  // would silently rewrite whether a borrower OWNS their home.
  eq(X.fromClickUpLabel('housing_status', 'Free'), 'Live with family',
    'ClickUp "Free" reads back as our rent-free value');
  eq(X.fromClickUpLabel('housing_status', 'Rent Free'), 'Live with family',
    'the existing "Rent Free" option is unchanged');
  eq(X.fromClickUpLabel('housing_status', 'own free and clear'), 'Own free and clear',
    'own-free-and-clear still means OWNS it outright — never collapsed into rent-free');
  eq(X.fromClickUpLabel('housing_status', 'Mortgage'), 'Own with mortgage', 'mortgage unchanged');
  // Read-side only: we keep WRITING 'Rent Free', so this can never re-label a card.
  eq(X.toClickUpLabel('housing_status', 'Live with family'), 'Rent Free',
    'we still write "Rent Free", never the ambiguous "Free"');
  eq(X.toClickUpLabel('housing_status', 'Own free and clear'), 'own free and clear',
    'the own-free-and-clear write is untouched');

  // file_intake: ClickUp's word for this stage is "starting" (clickup/status.js
  // already maps the TASK status that way). The Borrower Portal Status dropdown
  // has no such option yet, so read both spellings.
  eq(X.fromClickUpLabel('borrower_portal_status', 'starting'), 'file_intake',
    '"starting" reads back as file_intake');
  eq(X.fromClickUpLabel('borrower_portal_status', 'Started'), 'file_intake',
    '"Started" too — the label match is case-insensitive');
  eq(X.fromClickUpLabel('borrower_portal_status', 'file_intake'), 'file_intake',
    'the machine-named option reads back');
  eq(X.fromClickUpLabel('borrower_portal_status', 'new'), 'new',
    'file_intake and new stay DISTINCT statuses — never merged');
  eq(X.toClickUpLabel('borrower_portal_status', 'file_intake'), 'file_intake',
    'we write the machine name, matching the other ten options');

  // Delayed purchase financing is its OWN loan type, spelled EXACTLY as ClickUp
  // spells it, so it round-trips with nothing lost and nothing translated.
  eq(X.fromClickUpLabel('loan_type', 'Delayed Purchase Financing'), 'Delayed Purchase Financing',
    'inbound reads the delayed-purchase option as its own loan type');
  eq(X.toClickUpLabel('loan_type', 'Delayed Purchase Financing'), 'Delayed Purchase Financing',
    'outbound writes it back with the identical spelling');
  eq(X.fromClickUpLabel('loan_type', 'Refi Cash-Out'), 'Refinance — Cash-Out',
    'it is NOT collapsed into cash-out — that stays its own value');
  eq(X.fromClickUpLabel('loan_type', 'Refi Rate & Term'), 'Refinance — Rate & Term', 'rate & term unchanged');
  eq(X.fromClickUpLabel('loan_type', 'Purchase'), 'Purchase', 'purchase unchanged');
  eq(X.toClickUpLabel('loan_type', 'Refinance — Cash-Out'), 'Refi Cash-Out', 'cash-out write unchanged');
  // The value must survive a full round trip — this is the whole point of
  // matching ClickUp's spelling exactly.
  eq(X.fromClickUpLabel('loan_type', X.toClickUpLabel('loan_type', 'Delayed Purchase Financing')),
    'Delayed Purchase Financing', 'a full push-then-pull returns the identical value');
  // NOT RTL products — a card carrying one must never overwrite an RTL loan type.
  eq(X.fromClickUpLabel('loan_type', 'HELOC'), null, 'HELOC stays unmapped (not an RTL product)');
  eq(X.fromClickUpLabel('loan_type', 'Second Closed end Mortgage'), null,
    'a second mortgage stays unmapped (not an RTL product)');

  // Every OTHER surface that enumerates or classifies a loan type must know the
  // new value, or it saves in one place and vanishes in another.
  const cr = require('../src/lib/change-requests');
  ok((cr.FIELD_OPTIONS.loan_type || []).includes('Delayed Purchase Financing'),
    'a borrower may request the new loan type (change-request validation)');
  const reg = require('../src/lib/conditions/field-registry');
  // Sized as a PURCHASE — matching the frozen engine (pricing.js loanTypeOf finds
  // no 'refi' substring) and the Blue Lake "purchase leverage" rule.
  eq(reg.normLoanPurpose('Delayed Purchase Financing'), 'purchase',
    'condition rules read it as a purchase — the leverage the loan is actually sized on');
  eq(reg.normLoanPurpose('Refinance — Cash-Out'), 'refinance_cash_out', 'cash-out normalization unchanged');
  eq(reg.normLoanPurpose('Purchase'), 'purchase', 'purchase normalization unchanged');
  // MISMO has no delayed-financing purpose; it must still export SOMETHING true.
  const mismo = require('../src/lib/mismo/enums');
  eq(mismo.toMismoLoanPurpose('Delayed Purchase Financing'), 'Refinance',
    'MISMO exports it as a refinance (the borrower already owns the property)');
  eq(mismo.toMismoRefiCashOut('Delayed Purchase Financing'), 'CashOut',
    'MISMO marks it cash-out (it returns the borrower their own purchase funds)');
  // The frozen pricing classification, asserted so a future edit to the engine's
  // substring test cannot silently re-price every delayed-purchase file.
  const lt = 'Delayed Purchase Financing'.toLowerCase();
  ok(lt.indexOf('refi') === -1 && lt.indexOf('refinance') === -1,
    'the label contains no "refi" substring, so the frozen engine sizes it as a purchase');
  ok(lt.indexOf('cash') === -1, 'and no "cash" substring, so the frozen engine does not flag cash-out');
}
// A Fix & Hold card must MATERIALIZE a loan file — otherwise it would be pulled
// for profile data only and an existing linked file would stop syncing.
{
  const ingest = require('../src/clickup/ingest');
  ok(ingest.RTL_PROGRAMS.has('Fix & Hold'), 'Fix & Hold is an RTL program (creates/keeps a loan file)');
  ok(ingest.RTL_PROGRAMS.has('Fix & Flip w/ Construction'), 'the original RTL programs are untouched');
  ok(!ingest.RTL_PROGRAMS.has('DSCR / Rental'), 'a non-RTL program is still data-only');
  // Fix & Hold must never be classified as positively NON-RTL (that would descope
  // a live file when the card is set to it).
  ok(!X.isNonRtlProgramLabel('Fix & Hold'), 'Fix & Hold is never treated as non-RTL');
}
// The canonical spellings DO map — they must never be flagged.
ok(!X.unmappableToClickUp('program', 'Fix & Flip w/ Construction'), 'canonical Fix & Flip maps');
ok(!X.unmappableToClickUp('program', 'Bridge'), 'Bridge maps');
ok(!X.unmappableToClickUp('program', 'Ground-Up Construction'), 'Ground-Up maps');
// A DELIBERATE blank ('Not sure yet' → leave the ClickUp field empty) is not a
// loss and must not be reported as unmappable.
ok(!X.unmappableToClickUp('program', 'Not sure yet'), 'a deliberate blank is not unmappable');
// Empty / unknown-key inputs never flag.
ok(!X.unmappableToClickUp('program', ''), 'blank value never flags');
ok(!X.unmappableToClickUp('program', null), 'null value never flags');
ok(!X.unmappableToClickUp('not_a_field', 'whatever'), 'unknown crosswalk key never flags');
// Tolerant match: casing/spacing differences still map (they resolve to a label).
ok(!X.unmappableToClickUp('program', 'bridge'), 'lowercase bridge still maps');

/* RE-POINTED 2026-08-26, NOT LOOSENED. These three lines used to pin 'SFR' and
   'Multi 2-4' as UNMAPPABLE, which was true and was also the bug the owner then
   reported from the other end (YSCAP258134859): those are the spellings the
   public form and the completeness panel actually WRITE, so "unmappable" meant
   the ClickUp field was left blank in silence on real files. src/lib/enum-vocab.js
   now folds a producer's dialect onto the canonical value on the WRITE side, so
   they map — and asserting the old verdict here would be asserting the defect.

   WHAT IS STILL TRUE, and is what this block is really for: a value with NO
   ClickUp option at all is still unmappable, is still kept in PILOT, and still
   parks a review. 'PUD' is the honest example — the live dropdown has no PUD
   option (captured in scripts/fixtures/clickup-deal-dropdowns.json) and folding
   it into Townhouse or SFR would file a property type nobody chose. */
ok(!X.unmappableToClickUp('property_type', 'SFR'), "'SFR' now folds to the canonical 'SFR (1 unit)' and maps");
ok(!X.unmappableToClickUp('property_type', 'SFR (1 unit)'), 'canonical SFR maps');
ok(!X.unmappableToClickUp('property_type', 'Multi 2-4'), 'a hyphenated Multi 2-4 folds to the en-dash canonical and maps');
ok(!X.unmappableToClickUp('property_type', 'Multi 2–4'), 'en-dash Multi 2–4 maps');
ok(X.unmappableToClickUp('property_type', 'PUD'), "'PUD' has no ClickUp option at all — still unmappable, still kept in PILOT");
ok(X.unmappableToClickUp('program', 'DSCR / Rental'), "'DSCR / Rental' has no RTL ClickUp option — still unmappable");
ok(X.unmappableToClickUp('loan_type', 'Refinance'), "bare 'Refinance' has no ClickUp twin");
ok(!X.unmappableToClickUp('loan_type', 'Refinance — Cash-Out'), 'Refinance — Cash-Out maps');
// The owner's own file: the public form's spelling now reaches an option.
ok(!X.unmappableToClickUp('program', 'Fix & Hold (BRRRR)'), "the public form's 'Fix & Hold (BRRRR)' maps to the live Fix & Hold option");
// `term` carries a defaultLabel, so an odd term still writes something.
ok(!X.unmappableToClickUp('term', 'something odd'), 'a field with a defaultLabel is never unmappable');

// With a LIVE option list: a label the crosswalk knows but ClickUp does not
// actually offer is unmappable too (the write vanishes the same way).
const noGroundUp = [{ name: 'Fix & Flip With Construction' }, { name: 'bridge Without Construction' }];
ok(X.unmappableToClickUp('program', 'Ground-Up Construction', noGroundUp),
  'a crosswalk label missing from the live ClickUp dropdown is unmappable');
ok(!X.unmappableToClickUp('program', 'Bridge', noGroundUp), 'a label present in the live list maps');
// An empty/absent option list must never produce a false positive.
ok(!X.unmappableToClickUp('program', 'Ground-Up Construction', []), 'empty option list never flags');
ok(!X.unmappableToClickUp('program', 'Ground-Up Construction', null), 'no option list never flags');

/* -------------------------------------------------------------- the guard */

const PROTECTED = guard.protectedColumns().map((c) => c.col);
ok(PROTECTED.includes('program'), 'program is protected');
ok(PROTECTED.includes('loan_type'), 'loan_type is protected');
ok(PROTECTED.includes('property_type'), 'property_type is protected');
// occupancy is pull-only in FIELD_MAP — it is not a two-way field, so the guard
// (derived from FIELD_MAP, never hand-listed) must not claim it.
ok(!PROTECTED.includes('occupancy'), 'pull-only occupancy is not protected');

// The ClickUp *Program dropdown as it stood BEFORE the owner added the option
// (read from the real workspace 2026-07-27). Every inbound path supplies this map
// — `clickup-sync` calls optionMap() and passes it into ingestTask — so the guard
// always has it in production. Keyed by CUSTOM-FIELD ID, like the real one.
const PROGRAM_FIELD_ID = '50eb857a-d8b1-4c48-9ffe-20b15cdf1338';
const LIVE_OPTIONS_TODAY = {
  [PROGRAM_FIELD_ID]: [
    { name: 'Fix & Flip With Construction' }, { name: 'Ground-Up' },
    { name: 'Non-QM - DSCR Ratio' }, { name: 'bridge Without Construction' },
    { name: 'Private hard money' },
    // NOTE: no Fix & Hold — this is the state that caused the reported bug.
  ],
};
const LIVE_OPTIONS_AFTER = {
  [PROGRAM_FIELD_ID]: [...LIVE_OPTIONS_TODAY[PROGRAM_FIELD_ID], { name: 'Fix & Hold With Construction' }],
};

// THE REGRESSION, as it was BEFORE the owner added the option: PILOT holds
// Fix & Hold, ClickUp still says Fix & Flip, and the dropdown has no Fix & Hold
// option — so the value must be protected rather than reverted.
{
  const cols = { program: 'Fix & Flip w/ Construction', purchase_price: 500000 };
  const held = guard.unmappableOverwrites(cols, { program: 'Fix & Hold' }, LIVE_OPTIONS_TODAY);
  eq(held.length, 1, 'the unmappable program overwrite is caught');
  eq(held[0].field, 'program', 'it names the program column');
  eq(held[0].kept, 'Fix & Hold', "it keeps PILOT's value");
  eq(held[0].incoming, 'Fix & Flip w/ Construction', 'it records what ClickUp tried to write');
  ok(guard.summarize(held).includes('Fix & Hold'), 'the summary names the kept value');

  // ONCE THE OWNER ADDS THE OPTION: nothing is held, because the push can now
  // actually write it — the two systems agree on their own and the parked review
  // self-closes. This is the whole point of the ClickUp-side change.
  const cols2 = { program: 'Fix & Flip w/ Construction' };
  eq(guard.unmappableOverwrites(cols2, { program: 'Fix & Hold' }, LIVE_OPTIONS_AFTER).length, 0,
    'once the ClickUp option exists, Fix & Hold syncs normally and nothing is held');
}

// A value ClickUp CAN hold syncs exactly as before — this guard must be a no-op
// on every ordinary file.
{
  const cols = { program: 'Bridge' };
  eq(guard.unmappableOverwrites(cols, { program: 'Fix & Flip w/ Construction' }).length, 0,
    'a mappable portal value is left to sync normally');
}
// Same value in a different casing is not a change.
eq(guard.unmappableOverwrites({ program: 'fix & hold' }, { program: 'Fix & Hold' }).length, 0,
  'an echo of the same value is not an overwrite');
// A null incoming value is already a no-op via COALESCE.
eq(guard.unmappableOverwrites({ program: null }, { program: 'Fix & Hold' }).length, 0,
  'a null incoming value is never held');
// FILLING a blank is not a revert — nothing is being lost.
eq(guard.unmappableOverwrites({ program: 'Bridge' }, { program: null }).length, 0,
  'filling a blank program is never held');
// A column the pull is not touching is never considered.
eq(guard.unmappableOverwrites({ purchase_price: 1 }, { program: 'Fix & Hold' }).length, 0,
  'an untouched column is never held');
// Null-safety.
eq(guard.unmappableOverwrites(null, { program: 'Fix & Hold' }).length, 0, 'null cols is safe');
eq(guard.unmappableOverwrites({ program: 'Bridge' }, null).length, 0, 'null current row is safe');

// The guard MUTATES cols so the COALESCE keeps ours — proven on the shape the
// inbound pull actually builds.
{
  const cols = { program: 'Fix & Flip w/ Construction', loan_type: 'Purchase' };
  for (const h of guard.unmappableOverwrites(cols, { program: 'Fix & Hold', loan_type: 'Purchase' }, LIVE_OPTIONS_TODAY)) cols[h.field] = null;
  eq(cols.program, null, 'program is nulled so COALESCE keeps the portal value');
  eq(cols.loan_type, 'Purchase', 'an unrelated mappable column is untouched');
}

console.log(`test-enum-unmappable-guard: ${n} assertions passed`);
