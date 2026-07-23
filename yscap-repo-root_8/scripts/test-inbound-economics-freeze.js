'use strict';
/**
 * Inbound ClickUp economics FREEZE guard (owner-directed follow-up to the
 * term-sheet-sent freeze). Pure test of the change-detection: which frozen
 * economics fields an inbound pull would actually change, numeric-aware, so a
 * frozen file's figures are held (and a review parked) instead of silently
 * overwritten. No DB.
 */
const assert = require('assert');
const { changedFrozenFields, sameValue, FROZEN_KEYS, summarize } = require('../src/lib/inbound-economics-freeze');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// sameValue: numeric-aware, null-incoming = no change
ok(sameValue(100000, 100000), 'sameValue: equal numbers');
ok(sameValue('100000', 100000), 'sameValue: string vs number equal');
ok(sameValue(100000.0, '100000'), 'sameValue: float vs string equal');
ok(!sameValue(100000, 110000), 'sameValue: different numbers differ');
ok(sameValue(null, 100000), 'sameValue: null incoming => no change (COALESCE keeps)');
ok(sameValue(100000, null), 'sameValue: null current => treated as no change');
ok(sameValue('Gold', 'Gold'), 'sameValue: equal text');
ok(!sameValue('Gold', 'Standard'), 'sameValue: different text differs');

// changedFrozenFields: a real loan-amount change is detected
{
  const current = { loan_amount: 100000, purchase_price: 150000, arv: 200000, program: 'gold', units: 1, is_assignment: false };
  const cols = { loan_amount: 120000, purchase_price: 150000, arv: 200000, program: 'gold', units: 1, is_assignment: false };
  const ch = changedFrozenFields(cols, current);
  ok(ch.length === 1 && ch[0].field === 'loan_amount' && ch[0].from === '100000' && ch[0].to === '120000',
    'changed: only the loan amount is flagged, with from/to');
}

// no change when everything matches (numeric-form differences don't count)
{
  const current = { loan_amount: 100000, purchase_price: 150000, program: 'gold' };
  const cols = { loan_amount: '100000', purchase_price: 150000.0, program: 'gold' };
  ok(changedFrozenFields(cols, current).length === 0, 'no-change: numeric/text equal => nothing flagged');
}

// a NULL incoming value never counts as a change (COALESCE keeps the current)
{
  const current = { loan_amount: 100000, arv: 200000 };
  const cols = { loan_amount: null, arv: null };
  ok(changedFrozenFields(cols, current).length === 0, 'no-change: null incoming (blank ClickUp) never overwrites');
}

// multiple economics change at once → all flagged; program (text) + assignment (bool) included
{
  const current = { loan_amount: 100000, program: 'standard', is_assignment: false, arv: 200000 };
  const cols = { loan_amount: 130000, program: 'gold', is_assignment: true, arv: 200000 };
  const ch = changedFrozenFields(cols, current);
  const fields = ch.map((c) => c.field).sort();
  ok(JSON.stringify(fields) === JSON.stringify(['is_assignment', 'loan_amount', 'program']),
    'changed: multiple economics (number, text, boolean) all flagged');
  ok(summarize(ch).includes('→'), 'summarize: renders a from → to line');
}

// a field ABSENT from cols is never flagged (only what the pull carries)
{
  const current = { loan_amount: 100000, purchase_price: 150000 };
  const cols = { purchase_price: 175000 };   // loan_amount not in this pull
  const ch = changedFrozenFields(cols, current);
  ok(ch.length === 1 && ch[0].field === 'purchase_price', 'changed: a field absent from cols is ignored');
}

// FILLING a genuinely-blank frozen figure is ALLOWED, not flagged: the sent
// term sheet was generated from the same blank, so a fill can't contradict it.
// Only a real figure being OVERWRITTEN by a different real figure is held. This
// also keeps null-vs-false / null-vs-0 noise out of the review queue.
{
  const current = { loan_amount: null };
  const cols = { loan_amount: 100000 };
  ok(changedFrozenFields(cols, current).length === 0, 'fill: setting a blank frozen figure is allowed (not a term-sheet contradiction)');
}

// only real economics keys are guarded (a non-economics field never appears)
ok(!FROZEN_KEYS.includes('title_company') && !FROZEN_KEYS.includes('actual_rate') && FROZEN_KEYS.includes('loan_amount'),
  'keys: guards economics only, not workflow/contact fields');

assert.strictEqual(failures, 0, `${failures} assertion(s) failed`);
console.log(failures ? `\n${failures} failed` : '\nALL inbound-economics-freeze assertions passed');
process.exit(failures ? 1 : 0);
