#!/usr/bin/env node
'use strict';
/**
 * #213 (launch blocker 2) — pure tests for DOMAIN-based committee routing and the
 * never-miss coverage guard. Proves:
 *   - a finding routes to the specialist whose DOMAIN covers it (code keyword,
 *     document source, field name, or the specialist's own applies_to prefix);
 *   - every committee DOMAIN has at least one specialist that covers it, and every
 *     specialist covers at least one domain (the specialist-coverage guarantee);
 *   - an UNCOVERED finding (no qualified specialist) is flagged covered:false so the
 *     adjudicator HOLDS it — a real finding is never auto-dismissed by off-lens
 *     specialists that lean refute-when-uncertain;
 *   - the adjudicator honours covered:false (high-confidence refutes → HOLD, not
 *     dismiss) while covered:true still dismisses (back-compat).
 */
const assert = require('assert');
const routing = require('../src/lib/ai/committee-routing');
const { SPECIALISTS, adjudicate } = require('../src/lib/ai/committee');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. domainsOf maps known codes / fields / sources to the right domain.
{
  assert.deepStrictEqual(routing.domainsOf({ code: 'fico_below_min' }), ['credit']);
  assert.deepStrictEqual(routing.domainsOf({ code: 'undisclosed_liens' }), ['title']);
  assert.deepStrictEqual(routing.domainsOf({ code: 'flood_zone' }), ['insurance']);
  assert.deepStrictEqual(routing.domainsOf({ code: 'ofac_confirmed_match' }), ['fraud']);
  assert.deepStrictEqual(routing.domainsOf({ code: 'entity_name_mismatch' }), ['entity']);
  assert.deepStrictEqual(routing.domainsOf({ code: 'arv_defensibility' }), ['appraisal']);
  assert.deepStrictEqual(routing.domainsOf({ code: 'borrower_name_mismatch' }), ['identity']);
  // source-only signal (generic code, but read off a title commitment)
  assert.ok(routing.domainsOf({ code: 'value_conflict', source: 'title_commitment' }).includes('title'));
  // field-only signal
  assert.ok(routing.domainsOf({ code: 'x', field: 'vesting' }).includes('title'));
  ok('domainsOf maps code / source / field signals to the correct domain');
}

// 2. Specialist-coverage guarantee: every DOMAIN has a specialist, every specialist covers a domain.
{
  const specialistKeys = Object.keys(SPECIALISTS);
  for (const dom of routing.DOMAINS) {
    assert.ok(specialistKeys.includes(dom), `domain "${dom}" must have a specialist of the same key`);
  }
  for (const key of specialistKeys) {
    // Each specialist's key is itself a domain OR it routes at least one known code.
    const covers = routing.DOMAINS.includes(key);
    assert.ok(covers, `specialist "${key}" must map to a committee domain`);
  }
  ok('every domain has a specialist and every specialist covers a domain');
}

// 3. routeFinding picks the covering specialist and marks covered:true.
{
  const r = routing.routeFinding({ code: 'undisclosed_liens', severity: 'fatal' }, SPECIALISTS);
  assert.ok(r.specialists.includes('title'), 'a lien finding routes to the title specialist');
  assert.strictEqual(r.covered, true);
  // a fraud signal always pulls in the fraud specialist as a safety lens
  const rf = routing.routeFinding({ code: 'pdf_tampering', severity: 'fatal' }, SPECIALISTS);
  assert.ok(rf.specialists.includes('fraud'), 'a tampering finding always includes the fraud lens');
  assert.strictEqual(rf.covered, true);
  ok('routeFinding selects the covering specialist(s); fraud is a cross-cutting safety lens');
}

// 4. An UNKNOWN-domain finding is covered:false and runs only a safety panel.
{
  const r = routing.routeFinding({ code: 'totally_unknown_widget_code', severity: 'fatal' }, SPECIALISTS);
  assert.strictEqual(r.covered, false, 'no qualified specialist → covered:false');
  assert.ok(r.specialists.length > 0, 'still runs a small safety panel for some independent review');
  ok('an unrouted finding is covered:false (safety panel only)');
}

// 5. THE KEY SAFETY PROPERTY — an uncovered finding with high-confidence refutes is HELD, not dismissed.
{
  const finding = { code: 'totally_unknown_widget_code', severity: 'fatal' };
  const refutes = [
    { key: 'fraud', ok: true, verdict: { verdict: 'refute', confidence: 0.95, severity_recommendation: 'dismiss', reason: 'not my lens' } },
    { key: 'identity', ok: true, verdict: { verdict: 'refute', confidence: 0.95, severity_recommendation: 'dismiss', reason: 'not my lens' } },
    { key: 'credit', ok: true, verdict: { verdict: 'refute', confidence: 0.95, severity_recommendation: 'dismiss', reason: 'not my lens' } },
  ];
  const covered = adjudicate(finding, refutes, { covered: true });
  assert.strictEqual(covered.action, 'dismiss', 'covered + 3/3 high-conf refute → dismiss (unchanged)');
  const uncovered = adjudicate(finding, refutes, { covered: false });
  assert.strictEqual(uncovered.action, 'hold', 'UNCOVERED + 3/3 high-conf refute → HOLD, never dismiss');
  assert.strictEqual(uncovered.adjudicated_severity, 'fatal', 'the original fatal severity is preserved on hold');
  assert.strictEqual(uncovered.covered, false, 'the opinion records that no qualified specialist covered it');
  ok('uncovered high-confidence refutes HOLD for a human — a real finding is never dropped off-lens');
}

// 6. covered defaults to TRUE when opts omitted (back-compat with existing callers/tests).
{
  const finding = { code: 'borrower_name_mismatch', severity: 'warning' };
  const refutes = [
    { key: 'identity', ok: true, verdict: { verdict: 'refute', confidence: 0.9, severity_recommendation: 'dismiss', reason: 'nickname' } },
    { key: 'credit', ok: true, verdict: { verdict: 'refute', confidence: 0.9, severity_recommendation: 'dismiss', reason: 'same person' } },
    { key: 'fraud', ok: true, verdict: { verdict: 'refute', confidence: 0.9, severity_recommendation: 'dismiss', reason: 'benign' } },
  ];
  const op = adjudicate(finding, refutes); // no opts → covered defaults true
  assert.strictEqual(op.action, 'dismiss', 'omitting opts keeps the prior dismiss behavior');
  ok('adjudicate covered defaults to true when opts omitted (back-compat)');
}

// 7. Hostile input never throws.
{
  for (const bad of [null, undefined, 42, 'x', [], { code: 123 }]) {
    assert.doesNotThrow(() => routing.domainsOf(bad));
    assert.doesNotThrow(() => routing.routeFinding(bad, SPECIALISTS));
    assert.doesNotThrow(() => routing.routeFinding(bad, null));
  }
  ok('domainsOf / routeFinding never throw on hostile input');
}

console.log(`\ncommittee-routing pure — ${passed} checks passed`);
