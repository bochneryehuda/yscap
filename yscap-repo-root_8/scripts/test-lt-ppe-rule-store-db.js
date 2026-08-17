#!/usr/bin/env node
'use strict';
/**
 * LT PPE rule + suggestion store (Part 3 P5-store / P6 / P7) — pure + DB round-trip.
 *   - PURE (always): rowToRule shapes + dedupeKeyOf.
 *   - DB (DATABASE_URL set): the full loop — mine suggestions from LP declines → save → accept one →
 *     a rule is written and linked → rulesForProgram returns it in the engine shape → evaluateRules
 *     declines exactly the loan LP declined. Plus idempotency, dismiss, and the needs-human refusal.
 *
 *   node scripts/test-lt-ppe-rule-store-db.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-rule-store-db.js
 */
const fs = require('fs');
const path = require('path');
const rs = require('../src/longterm/ppe/rule-store');
const { analyzeDisqualifications } = require('../src/longterm/ppe/disqualify-analysis');
const { evaluateRules } = require('../src/longterm/ppe/rules');
const store = require('../src/longterm/ppe/store');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// A parseDisqualified-shaped input for Deephaven: FICO + CLTV + IO-NY (mappable) + one unmappable.
const parsedDisq = {
  ready: true, lenderCount: 1, itemCount: 1, reasonCount: 4,
  lenders: [{
    lender: 'Some Lender', investor: 'Deephaven', lenderId: 'L1',
    items: [{ program: 'DSCR 30 Yr Fixed', rate: 6.5, reasons: [
      { rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' },
      { rule: 'Max LTV exceeded / CLTV > 80.0 %', adjType: 'CapAdjustment' },
      { rule: 'Interest Only not available in NY', adjType: 'StatesRateAdjustment' },
      { rule: 'Investor overlay applies', adjType: 'MysteryAdjustment' },
    ] }],
  }],
};

(async () => {
  console.log('LT PPE rule store — pure\n');

  // rowToRule shapes.
  ok(JSON.stringify(rs.rowToRule({ code: 'a', kind: 'eligibility', source: 'overlay', predicate: { fact: 'fico', op: 'lt', value: 660 }, decline_reason: 'FICO' }).when) === JSON.stringify({ fact: 'fico', op: 'lt', value: 660 }),
    'rowToRule carries the eligibility predicate + declineReason');
  const bound = rs.rowToRule({ code: 'b', kind: 'bound', bound_target: 'ltv', bound_op: 'max', bound_value: '80000' });
  ok(bound.target === 'ltv' && bound.op === 'max' && bound.value === 80000, 'rowToRule shapes a bound (value coerced to number)');
  const pricing = rs.rowToRule({ code: 'c', kind: 'pricing', adjustment: { code: 'x', adjMilli: 500 } });
  ok(pricing.adjustment && pricing.adjustment.adjMilli === 500, 'rowToRule shapes a pricing rule');
  ok(rs.dedupeKeyOf('FicoRateAdjustment', 'FICO - below 660') === 'FicoRateAdjustment|FICO - below 660', 'dedupeKeyOf');

  if (!process.env.DATABASE_URL) {
    console.log('\n(DB round-trip skipped — set DATABASE_URL to run it.)');
    console.log(`\n${failures ? failures + ' FAILED' : 'all passed (pure)'}`);
    process.exit(failures ? 1 : 0);
  }

  console.log('\nLT PPE rule store — DB round-trip\n');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const scope = 'rs_test_' + Math.abs(process.pid || 1);
  try {
    for (const f of ['558_lt_ppe_foundation.sql', '571_lt_ppe_rule_and_suggestion_store.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    ok(true, 'db/558 + db/571 applied');
    const clean = async () => {
      await db.query('DELETE FROM lt_ppe_rule_suggestion WHERE scope = $1', [scope]);
      await db.query('DELETE FROM lt_ppe_rule WHERE scope = $1', [scope]);
      await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [scope]);
      await db.query('DELETE FROM lt_ppe_investor_alias WHERE scope = $1', [scope]);
      await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [scope]);
    };
    await clean();
    const inv = await store.createInvestor(db, scope, { code: 'DHVN', name: 'Deephaven Mortgage' });
    const prog = await store.createProgram(db, scope, { investorId: inv.id, code: 'DSCR30', name: 'DSCR 30 Yr Fixed' });

    // 1) Mine + save the suggestions.
    const analysis = analyzeDisqualifications(parsedDisq);
    const saveRes = await rs.saveSuggestions(db, scope, analysis);
    ok(saveRes.saved === 4, 'saved 4 suggestions (3 mapped + 1 unmapped)');
    const open = await rs.listSuggestions(db, scope);
    ok(open.length === 4, 'four open suggestions listed');
    const fico = open.find((s) => s.fact === 'fico');
    const unmapped = open.find((s) => s.needs_human);
    ok(fico && fico.decline_reason === 'FICO - below 660' && fico.predicate && fico.predicate.value === 660, 'the FICO suggestion carries the predicate + verbatim reason');
    ok(unmapped && unmapped.decline_reason === 'Investor overlay applies' && unmapped.predicate === null, 'the unmapped suggestion has no predicate (needs a human)');

    // 2) Accept the FICO suggestion → a rule is written + linked.
    const acc = await rs.acceptSuggestion(db, scope, fico.id, { decidedBy: 'tester', investorId: inv.id, programId: prog.id });
    ok(acc.ok && acc.ruleId, 'accepting the FICO suggestion writes a rule');
    const sugAfter = (await rs.listSuggestions(db, scope, { status: 'accepted' })).find((s) => s.id === fico.id);
    ok(sugAfter && sugAfter.status === 'accepted' && String(sugAfter.created_rule_id) === String(acc.ruleId), 'the suggestion is marked accepted + linked to the rule');

    // 3) rulesForProgram returns it in the engine shape; it declines the target loan (P7 close-the-loop).
    const engineRules = await rs.rulesForProgram(db, scope, inv.id, prog.id);
    ok(engineRules.some((r) => r.kind === 'eligibility' && r.when && r.when.value === 660), 'rulesForProgram returns the accepted rule in the rules.js shape');
    const decision = evaluateRules(engineRules, { fico: 640, ltv: 70000, io: false, state: 'TX' });
    ok(!decision.eligible && decision.declines.some((d) => d.reason === 'FICO - below 660'), 'the accepted rule declines a 640-FICO loan (our engine now matches Lender Price)');
    const clean640 = evaluateRules(engineRules, { fico: 720, ltv: 70000, io: false, state: 'TX' });
    ok(clean640.eligible, 'a 720-FICO loan still passes');

    // 4) A needs-human suggestion cannot be accepted.
    const bad = await rs.acceptSuggestion(db, scope, unmapped.id, { decidedBy: 'tester' });
    ok(!bad.ok && bad.error === 'needs_human_mapping', 'an unmapped suggestion refuses acceptance');

    // 5) Re-running saveSuggestions does NOT reopen the accepted one.
    await rs.saveSuggestions(db, scope, analysis);
    const stillAccepted = (await db.query('SELECT status FROM lt_ppe_rule_suggestion WHERE scope = $1 AND id = $2', [scope, fico.id])).rows[0];
    ok(stillAccepted.status === 'accepted', 're-running the analysis does not reopen an accepted suggestion (idempotent)');

    // 6) Dismiss another.
    const cltv = open.find((s) => s.fact === 'cltv');
    const dis = await rs.dismissSuggestion(db, scope, cltv.id, { decidedBy: 'tester', note: 'not our overlay' });
    ok(dis.ok, 'dismissing an open suggestion works');
    ok((await rs.listSuggestions(db, scope)).every((s) => s.id !== cltv.id), 'a dismissed suggestion leaves the open list');

    await clean();
  } finally {
    await db.end();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
