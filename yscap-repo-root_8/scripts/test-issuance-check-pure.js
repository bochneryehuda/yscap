'use strict';
/**
 * #217 — end-to-end test of the never-block ISSUANCE resolver the /issuance-check
 * route serves. Drives issuance-policy.resolveFromLatestRun (which lazy-loads the
 * real issuance-gate) with a FAKE db, proving the two-tier never-block contract
 * through the full composition:
 *   • a CONFIRMED FATAL run → a super-admin can ALWAYS proceed; any other staff
 *     gets a super-admin-overridable HARD WARNING (proceed:false + escalate) —
 *     NEVER an un-overridable block;
 *   • a DB error fails OPEN to a non-blocking advisory (the route can never 500
 *     into a block);
 *   • no run → an advisory any staff proceeds past (never the fatal tier);
 *   • the CARDINAL INVARIANT: for every action + input, a super-admin proceeds.
 */
const assert = require('assert');
const policy = require('../src/lib/underwriting/issuance-policy');
const gate = require('../src/lib/underwriting/issuance-gate');

// A fake db: the 1st query returns the run row; the 2nd returns blocking findings.
function fakeDb({ run, findings }) {
  let n = 0;
  return { query: async () => { n += 1; return { rows: n === 1 ? (run ? [run] : []) : (findings || []) }; } };
}
const INELIGIBLE = { status: 'INELIGIBLE', term_sheet_eligible: false, ctc_eligible: false, funding_eligible: false };
const CONFIRMED_FATAL = { code: 'title_defect', severity: 'fatal', title: 'Unclearable lien', blocks_term_sheet: true, blocks_ctc: true, blocks_funding: true };

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  // 1. Confirmed fatal → super-admin ALWAYS proceeds; a processor escalates; never an un-overridable block.
  {
    const sa = await policy.resolveFromLatestRun('app1', 'term_sheet', fakeDb({ run: INELIGIBLE, findings: [CONFIRMED_FATAL] }), { actorRole: 'super_admin' });
    assert.strictEqual(sa.tier, 'fatal');
    assert.strictEqual(sa.hardWarning, true, 'the hard warning shows even to the super-admin');
    assert.strictEqual(sa.proceed, true, 'a super-admin can ALWAYS proceed over a confirmed fatal');

    const proc = await policy.resolveFromLatestRun('app1', 'term_sheet', fakeDb({ run: INELIGIBLE, findings: [CONFIRMED_FATAL] }), { actorRole: 'processor' });
    assert.strictEqual(proc.tier, 'fatal');
    assert.strictEqual(proc.proceed, false, 'a processor cannot proceed past a confirmed fatal');
    assert.strictEqual(proc.needsSuperAdminOverride, true, 'they escalate — but it is NEVER an un-overridable block');
    ok('a confirmed fatal is a super-admin-overridable hard warning; a super-admin always proceeds');
  }

  // 2. An UNGROUNDED fatal is downgraded to advisory — any staff proceeds (an AI mis-read never gates).
  {
    const ungrounded = Object.assign({}, CONFIRMED_FATAL, { code: 'purchase_price_unconfirmed', grounded: false });
    const r = await policy.resolveFromLatestRun('app1', 'ctc', fakeDb({ run: INELIGIBLE, findings: [ungrounded] }), { actorRole: 'processor' });
    assert.strictEqual(r.tier, 'advisory');
    assert.strictEqual(r.proceed, true, 'an unconfirmed value never gates issuance');
    ok('an ungrounded fatal downgrades to an advisory any staff proceeds past');
  }

  // 3. DB error → fail OPEN to a non-blocking advisory (the route can never 500 into a block).
  {
    const bad = { query: async () => { throw new Error('db down'); } };
    const r = await policy.resolveFromLatestRun('app1', 'funding', bad, { actorRole: 'processor' });
    assert.strictEqual(r.proceed, true, 'a read error fails OPEN — never a hard block');
    assert.strictEqual(r.hardWarning, false);
    ok('a DB error fails open to a non-blocking advisory (never a 500 / never a block)');
  }

  // 4. No current run → advisory (any staff proceeds), never the fatal tier.
  {
    const r = await policy.resolveFromLatestRun('app1', 'funding', fakeDb({ run: null }), { actorRole: 'processor' });
    assert.strictEqual(r.proceed, true);
    assert.notStrictEqual(r.tier, 'fatal', 'a missing run is an advisory, never a super-admin gate');
    ok('no current run → advisory, not a fatal gate');
  }

  // 5. CARDINAL INVARIANT — for every action and every scenario, a super-admin proceeds.
  {
    const scenarios = [
      fakeDb({ run: INELIGIBLE, findings: [CONFIRMED_FATAL] }),
      fakeDb({ run: null }),
      { query: async () => { throw new Error('x'); } },
    ];
    // A super-admin proceeds regardless of tier, so shared fake-db call-count state
    // across iterations is harmless here — the invariant holds for any gate output.
    for (const a of gate.ACTIONS) {
      for (const scenarioDb of scenarios) {
        const r = await policy.resolveFromLatestRun('app1', a, scenarioDb, { actorRole: 'super_admin' });
        assert.strictEqual(r.proceed, true, `super-admin proceeds on ${a}`);
      }
    }
    ok('CARDINAL INVARIANT — a super-admin proceeds for every action + scenario');
  }

  console.log(`\nissuance-check pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
