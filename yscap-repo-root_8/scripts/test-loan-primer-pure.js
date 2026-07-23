'use strict';

/**
 * Pure test for src/lib/underwriting/loan-primer.js — no DB, no AI.
 * Proves the static grounding block carries the load-bearing distinctions, the
 * per-file summary respects missing-vs-zero and scrubs the note buyer for a
 * borrower-facing surface, and every entry point is null-safe (never throws).
 */

const assert = require('assert');
const p = require('../src/lib/underwriting/loan-primer');

let n = 0;
async function check(name, fn) { await fn(); n++; console.log('  ok -', name); }

async function main() {
  console.log('loan-primer pure tests');

  // 1 — PRIMER_TEXT teaches the money distinctions the model must never cross.
  await check('PRIMER_TEXT carries the confusable money distinctions', () => {
    const t = p.PRIMER_TEXT;
    assert(typeof t === 'string' && t.length > 2000, 'primer text present');
    assert(t.includes('purchase_price = the CONTRACT price'), 'purchase price defined');
    assert(t.includes('as_is_value = the property'), 'as-is defined');
    assert(t.includes('arv = AFTER-REPAIR VALUE'), 'arv defined');
    assert(t.includes('loan_amount = the TOTAL financed loan'), 'loan amount defined');
    assert(t.includes('underlying_contract_price'), 'assignment basis defined');
    assert(t.includes('15% of'), 'assignment 15% cap taught');
    assert(/NEVER expose a note buyer/i.test(t), 'note-buyer secrecy taught');
    assert(t.includes('registered_program'), 'program-vs-registered_program taught');
  });

  // 2 — money() distinguishes a real 0 from a missing value (the primer's own rule).
  await check('money(): 0 is $0, null/blank/non-finite is (missing)', () => {
    assert.strictEqual(p._internals.money(0), '$0');
    assert.strictEqual(p._internals.money(120000), '$120,000');
    assert.strictEqual(p._internals.money(null), '(missing)');
    assert.strictEqual(p._internals.money(undefined), '(missing)');
    assert.strictEqual(p._internals.money(''), '(missing)');
    assert.strictEqual(p._internals.money(NaN), '(missing)');
  });

  // 3 — fileSummaryText is null-safe with a completely empty primer.
  await check('fileSummaryText survives a null-fields primer', () => {
    const s = p.fileSummaryText({ applicationId: 'abc', fields: null, structure: null, facts: [] });
    assert(s.includes('application abc'), 'app id rendered');
    assert(s.includes('(missing)'), 'missing values marked, not zeroed');
    assert(!s.includes('$0'), 'no phantom zero dollars from null fields');
  });

  // 4 — staff summary surfaces the note buyer, discrepancies and missing-required.
  await check('staff summary shows note buyer + discrepancies + missing', () => {
    // Real source-priority discrepancy shape: { field, governing:{source,value}, conflicts:[{source,value}] }.
    const s = p.fileSummaryText({
      applicationId: 'x',
      fields: { registered_program: 'gold', note_buyer: 'bluelake', loan_amount: 500000 },
      structure: {
        discrepancies: [{
          field: 'arv',
          governing: { source: 'appraisal', value: 380000 },
          conflicts: [{ source: 'application', value: 400000 }],
        }],
        ready: false,
      },
      facts: [{ status: 'human_confirmed' }],
      missing: ['loan_amount'],
    });
    assert(/Note buyer \(STAFF-ONLY\): bluelake/.test(s), 'note buyer shown to staff');
    assert(/DISCREPANCIES/.test(s), 'discrepancies section present');
    assert(/arv: governing=380000 \(appraisal\) vs 400000 \(application\)/.test(s), 'discrepancy rendered from the real shape');
    assert(/MISSING REQUIRED/.test(s), 'missing-required surfaced');
    assert(/human_confirmed fact outranks/.test(s), 'verified-fact note present');
  });

  // 5 — borrower-facing summary drops the note-buyer line and scrubs partner names.
  await check('borrower-facing summary hides the note buyer', () => {
    const fields = { registered_program: 'gold', note_buyer: 'bluelake', ys_loan_number: 'YSCAP1' };
    const bf = p.fileSummaryText({ applicationId: 'x', fields, structure: null, facts: [] }, { borrowerFacing: true });
    assert(!/Note buyer/.test(bf), 'note-buyer line removed for borrower');
    assert(!/bluelake/i.test(bf), 'no partner key leaks into borrower text');
    assert(!/YSCAP1/.test(bf), 'internal loan number line removed for borrower');
  });

  // 6 — assembleLoanPrimer with a falsy appId returns a safe shape, never throws.
  await check('assembleLoanPrimer(null) returns a safe empty shape', async () => {
    const r = await p.assembleLoanPrimer(null, null);
    assert.strictEqual(r.applicationId, null);
    assert.strictEqual(r.fields, null);
    assert.strictEqual(r.ready, false);
    assert(Array.isArray(r.facts), 'facts is an array');
    assert(Array.isArray(r.missing), 'missing is an array');
  });

  // 7 — assignment line only appears when is_assignment is set.
  await check('assignment line is conditional on is_assignment', () => {
    const noAsg = p.fileSummaryText({ applicationId: 'a', fields: { is_assignment: false }, structure: null, facts: [] });
    assert(!/ASSIGNMENT:/.test(noAsg), 'no assignment line when not an assignment');
    const asg = p.fileSummaryText({ applicationId: 'a', fields: { is_assignment: true, underlying_contract_price: 100000, assignment_fee: 20000 }, structure: null, facts: [] });
    assert(/ASSIGNMENT: seller contract \$100,000 \+ fee \$20,000/.test(asg), 'assignment line rendered with both parts');
  });

  console.log(`\nloan-primer: ${n} checks passed`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
