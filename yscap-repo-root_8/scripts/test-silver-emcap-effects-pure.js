'use strict';
/**
 * Pure (no-DB) test for the 2026-07-29 owner-directed Silver/EMCAP effects that
 * live OUTSIDE the frozen pricing engine:
 *   · Silver program = 2 months of bank statements ("They require two months bank
 *     statement not only one month… same as blue lake") — liquidity.js
 *   · the EMCAP note buyer = 2 months, under EVERY spelling of its label — the
 *     live ClickUp/Sitewire label is "EMCAP Financial" → 'emcapfinancial'
 *   · field-registry.isEmcapNoteBuyer — the shared prefix helper (Fidelis shape)
 *   · the investor-guideline review's emcap-audience rules fire on the real label
 *   · borrower-safe scrubs "EMCAP Financial" as one unit (no dangling "Financial")
 *   · the AUS program-guidelines snapshot states 2 months for a Silver file
 * Runs in `npm test` with no database.
 */
const assert = require('assert');
const { bankStatementMonths, bankStatementLine } = require('../src/lib/liquidity');
const registry = require('../src/lib/conditions/field-registry');
const igr = require('../src/lib/underwriting/investor-guideline-review');
const borrowerSafe = require('../src/lib/borrower-safe');
const { programGuidelineSnapshot } = require('../src/lib/underwriting/program-guidelines');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); passed++; };

// ── 1. TWO MONTHS ON EVERY FILE (owner-directed 2026-08-11) ─────────────────
eq(bankStatementMonths('silver'), 2, 'Silver requires 2 months');
eq(bankStatementMonths('Silver Program'), 2, 'silver matched by wording, not exact key');
eq(bankStatementMonths('gold'), 2, 'Gold requires 2 months');
eq(bankStatementMonths('standard'), 2, 'Standard now requires 2 months too (uniform)');
eq(bankStatementMonths('manual', 3), 2, 'manual is capped at 2 — nothing can ask for three');
eq(bankStatementMonths('manual', null), 2, 'manual default 2');
eq(bankStatementMonths(null), 2, 'no program → 2 (uniform)');

// ── 2. neither the note buyer nor the manual months can change the count ─────
eq(bankStatementMonths('standard', null, 'EMCAP'), 2, 'EMCAP → still 2');
eq(bankStatementMonths('standard', null, 'EMCAP Financial'), 2, 'the real label "EMCAP Financial" → 2');
eq(bankStatementMonths('standard', null, 'Blue Lake'), 2, 'Blue Lake → 2');
eq(bankStatementMonths('standard', null, 'Fidelis'), 2, 'Fidelis → 2 (Standard is now 2 on its own)');
eq(bankStatementMonths('silver', null, 'EMCAP Financial'), 2, 'Silver + EMCAP = 2');
eq(bankStatementMonths('manual', 12, 'Blue Lake'), 2, 'a manual 12 with a note buyer is still 2');
eq(bankStatementMonths('standard', null, 'constructor'), 2, 'a prototype-named lender is harmless');

// ── 3. borrower-facing wording — two months + the printout allowance ────────
ok(/Silver Program requires two months/.test(bankStatementLine('silver')),
  'Silver line names the Silver Program and two months');
ok(/Gold Standard Program requires two months/.test(bankStatementLine('gold')),
  'Gold line names the Gold Standard Program and two months');
ok(/Standard Program requires two months/.test(bankStatementLine('standard')),
  'Standard line now names two months (was one)');
ok(/transaction printout showing the deposit/.test(bankStatementLine('gold')),
  'every ask carries the printout allowance');
// A note buyer never changes the program-named wording (nothing raises the count).
ok(/Gold Standard Program requires two months/.test(bankStatementLine('gold', null, 'Blue Lake')),
  'Gold + Blue Lake keeps the program-named wording');
const withBuyer = bankStatementLine('standard', null, 'EMCAP Financial');
ok(/two months/.test(withBuyer), 'states two months');
ok(!/emcap/i.test(withBuyer), 'wording NEVER names the note buyer');

// ── 4. the shared prefix helper ─────────────────────────────────────────────
ok(registry.isEmcapNoteBuyer('EMCAP'), 'isEmcapNoteBuyer: EMCAP');
ok(registry.isEmcapNoteBuyer('EMCAP Financial'), 'isEmcapNoteBuyer: EMCAP Financial');
ok(registry.isEmcapNoteBuyer('em-cap financial LLC'), 'isEmcapNoteBuyer: punctuation-tolerant');
ok(!registry.isEmcapNoteBuyer('Fidelis'), 'isEmcapNoteBuyer: not Fidelis');
ok(!registry.isEmcapNoteBuyer(''), 'isEmcapNoteBuyer: blank is false');
ok(!registry.isEmcapNoteBuyer(null), 'isEmcapNoteBuyer: null is false');
eq(registry.normNoteBuyer('EMCAP Financial'), 'emcapfinancial', 'normNoteBuyer itself stays EXACT (never loosened)');

// ── 5. ISG review audience matching on the real label ──────────────────────
// The three emcap-audience rows must fire identically for 'emcap' and the
// production label. Use the excluded-state rule with a Nevada file.
const bagBase = { note_buyer: 'EMCAP Financial', property_state: 'NV' };
const withLabel = igr.review(bagBase).map((f) => f.code).sort();
const withKey = igr.review({ ...bagBase, note_buyer: 'emcap' }).map((f) => f.code).sort();
ok(withLabel.length > 0, 'emcap-audience rules fire on "EMCAP Financial"');
eq(JSON.stringify(withLabel), JSON.stringify(withKey), 'the real label and the canonical key fire the SAME rules');
const withOther = igr.review({ ...bagBase, note_buyer: 'Fidelis' }).filter((f) => /^isg_emcap_/.test(f.code));
eq(withOther.length, 0, 'emcap-specific rules never fire for a different buyer');

// ── 6. borrower-safe scrub of the real label ────────────────────────────────
const scrubbed = borrowerSafe.scrubText('Your file was sold to EMCAP Financial yesterday.');
ok(!/emcap/i.test(scrubbed), 'scrub removes the EMCAP name');
ok(!/financial/i.test(scrubbed), 'scrub removes the whole "EMCAP Financial" label — no dangling "Financial"');
ok(!/emcap/i.test(borrowerSafe.scrubText('EMCAP_tape.xlsx')), 'bare EMCAP form still scrubs');
ok(borrowerSafe.hasPartnerName('EMCAP Financial'), 'hasPartnerName sees the label');

// ── 7. AUS program-guidelines snapshot ──────────────────────────────────────
const snap = programGuidelineSnapshot('silver');
eq(snap.bankStatementMonths, 2, 'AUS snapshot: Silver = 2 months');
ok(snap.notes.some((n) => /2 months of bank statements/.test(n)), 'AUS snapshot note states 2 months');
const snapStd = programGuidelineSnapshot('standard', { noteBuyer: 'EMCAP Financial' });
eq(snapStd.bankStatementMonths, 2, 'AUS snapshot: a Standard file with the EMCAP buyer reads 2 months');

console.log(`test-silver-emcap-effects-pure: OK (${passed} assertions)`);
