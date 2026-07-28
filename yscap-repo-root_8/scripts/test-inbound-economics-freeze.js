'use strict';
/**
 * Inbound ClickUp economics FREEZE guard (owner-directed follow-up to the
 * term-sheet-sent freeze). Pure test of the change-detection: which frozen
 * economics fields an inbound pull would actually change, numeric-aware, so a
 * frozen file's figures are held (and a review parked) instead of silently
 * overwritten. No DB.
 */
const assert = require('assert');
const { changedFrozenFields, sameValue, FROZEN_KEYS, summarize, acceptInboundEconomicsChange, incomingFromStoredChanges } = require('../src/lib/inbound-economics-freeze');

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

// only real economics keys are guarded (a non-economics field never appears);
// `term` is protected because it prints on the signed Loan Application.
ok(!FROZEN_KEYS.includes('title_company') && !FROZEN_KEYS.includes('actual_rate')
  && FROZEN_KEYS.includes('loan_amount') && FROZEN_KEYS.includes('term'),
  'keys: guards economics + term (signed-doc figure), not workflow/contact fields');

// a term change on a frozen file is held (loan term drifts the signed Loan App)
{
  const current = { loan_amount: 100000, term: 12 };
  const cols = { loan_amount: 100000, term: 24 };
  const ch = changedFrozenFields(cols, current);
  ok(ch.length === 1 && ch[0].field === 'term' && ch[0].from === '12' && ch[0].to === '24', 'changed: a loan-term change is flagged');
}

// ACCEPT-override (owner-directed 2026-07-27): the mirror of keep-PILOT — pull
// ClickUp's frozen figures INTO the locked file. Exported and validates its
// inputs before any DB/ClickUp work (the no-application guard is pure).
ok(typeof acceptInboundEconomicsChange === 'function', 'export: acceptInboundEconomicsChange is available');

// incomingFromStoredChanges — the RELIABLE offline base (owner-reported 2026-07-27:
// the accept button did nothing because it hard-depended on a live ClickUp read).
// It turns a review row's raw_value.changes into an `incoming` object so the accept
// works even when ClickUp can't be reached.
{
  const changes = [
    { field: 'loan_amount', label: 'Loan amount', from: '191475', to: '172975' },
    { field: 'rehab_budget', label: 'Rehab', from: '85000', to: '65000' },
  ];
  const inc = incomingFromStoredChanges(changes);
  ok(inc && inc.loan_amount === '172975' && inc.rehab_budget === '65000',
    'stored-base: builds incoming from the freeze’s captured changes (Morgenstern figures)');
  // Applied against the current file, it produces the SAME diffs the live path would.
  const ch = changedFrozenFields(inc, { loan_amount: '191475.00', rehab_budget: '85000.00' });
  ok(ch.length === 2 && ch.find((c) => c.field === 'loan_amount' && c.to === '172975'),
    'stored-base: those figures are real changes vs the frozen file');
  ok(incomingFromStoredChanges(null) === null && incomingFromStoredChanges([]) === null,
    'stored-base: no changes => null (caller falls back to the live read / reports clearly)');
  // A bad property_type / loan_type is refused the SAME way the live path sanitizes it.
  const bad = incomingFromStoredChanges([{ field: 'property_type', to: 'FNM1025' }]);
  ok(bad === null, 'stored-base: an appraisal form code (FNM1025) is refused, never written as a property type');
  const nonFrozen = incomingFromStoredChanges([{ field: 'ppp', to: '5' }]);
  ok(nonFrozen === null, 'stored-base: a non-frozen field is ignored');
}

(async () => {
  let threw = null;
  try { await acceptInboundEconomicsChange({ appId: null }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.expose === true,
    'accept: a missing application id is refused (422, before any DB work)');

  // DB-gated: the accept applies ClickUp's figures onto a FROZEN file end-to-end.
  // A pure test CANNOT catch a wrong-column query — the first version SELECTed a
  // phantom `applications.clickup_list_id` (no such column), which threw and mapped
  // to the owner-reported 500 "server error". This exercises the real query path.
  if (process.env.DATABASE_URL) {
    const db = require('../src/db');
    const uniq = Date.now();
    const email = `econ.accept.${uniq}@example.com`;
    const task = `task_econ_${uniq}`;
    let appId = null;
    try {
      const b = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Avraham','Morgenstern',$1) RETURNING id`, [email])).rows[0];
      const a = (await db.query(
        `INSERT INTO applications (borrower_id, status, loan_amount, rehab_budget, property_address, clickup_pipeline_task_id)
         VALUES ($1,'clear_to_close',191475,85000,$2,$3) RETURNING id`,
        [b.id, JSON.stringify({ line1: '829 Duncan Bypass', city: 'Union', state: 'SC', zip: '29379' }), task])).rows[0];
      appId = a.id;
      // ClickUp is unreachable in the test env, so this proves the STORED-BASE path
      // (and that the SELECT no longer throws on a phantom column).
      const out = await acceptInboundEconomicsChange({
        appId,
        fallbackChanges: [
          { field: 'loan_amount', label: 'Loan amount', from: '191475', to: '172975' },
          { field: 'rehab_budget', label: 'Rehab', from: '85000', to: '65000' },
        ],
        taskId: task,
      });
      ok(out && out.upToDate === false && out.applied.length === 2, 'accept(db): both frozen figures are applied');
      const after = (await db.query(`SELECT loan_amount, rehab_budget FROM applications WHERE id=$1`, [appId])).rows[0];
      ok(Number(after.loan_amount) === 172975 && Number(after.rehab_budget) === 65000,
        'accept(db): the LOCKED file now holds ClickUp’s figures (override applied)');
    } catch (e) {
      ok(false, `accept(db): threw unexpectedly — ${e.message} (regression: a phantom column in the query?)`);
    } finally {
      if (appId) { try { await db.query(`DELETE FROM applications WHERE id=$1`, [appId]); } catch (_) {} }
      try { await db.query(`DELETE FROM borrowers WHERE email=$1`, [email]); } catch (_) {}
      try { await db.end(); } catch (_) {}
    }
  } else {
    console.log('  ~~ SKIP accept-db test (no DATABASE_URL)');
  }

  assert.strictEqual(failures, 0, `${failures} assertion(s) failed`);
  console.log(failures ? `\n${failures} failed` : '\nALL inbound-economics-freeze assertions passed');
  process.exit(failures ? 1 : 0);
})();
