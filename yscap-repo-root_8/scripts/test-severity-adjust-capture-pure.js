'use strict';
/**
 * #200 — pure tests for the severity-adjust capture. Proves the previously-dead
 * severity-drift learning branch is now reachable: the two new resolve actions
 * validate (finding stays OPEN, a note is required), they map to the exact
 * decisions the self-training proposer reads (severity_too_high / severity_too_low),
 * and the committee-agreement matcher recognizes them.
 */
const assert = require('assert');
const actions = require('../src/lib/underwriting/actions');
const learning = require('../src/lib/underwriting/learning');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. Both actions validate, keep the finding OPEN, and require a note.
{
  const hi = actions.validateResolution('downgrade_severity', { note: 'this is routine' });
  assert.strictEqual(hi.ok, true);
  assert.strictEqual(hi.outcome, 'open', 'a severity flag does not resolve the finding');
  const lo = actions.validateResolution('upgrade_severity', { note: 'this is serious' });
  assert.strictEqual(lo.ok, true);
  assert.strictEqual(lo.outcome, 'open');
  // note is required (a labeled reason is the training signal)
  const noNote = actions.validateResolution('downgrade_severity', {});
  assert.strictEqual(noNote.ok, false, 'a reason note is required');
  ok('both severity-adjust actions validate, stay open, and require a note');
}

// 2. They map to the decisions the drift proposer reads.
{
  assert.strictEqual(learning.DECISION_BY_ACTION.downgrade_severity, 'severity_too_high');
  assert.strictEqual(learning.DECISION_BY_ACTION.upgrade_severity, 'severity_too_low');
  ok('downgrade→severity_too_high, upgrade→severity_too_low (the proposer\'s decision values)');
}

// 3. The committee-agreement matcher recognizes a severity decision as a 'modify'.
{
  assert.strictEqual(learning.matchesDecision('modify', 'severity_too_high'), true);
  assert.strictEqual(learning.matchesDecision('modify', 'severity_too_low'), true);
  assert.strictEqual(learning.matchesDecision('confirm', 'severity_too_high'), false);
  ok('the committee matcher treats a severity adjustment as a modify');
}

// 4. Both actions appear in the finding action menu (fatal AND warning) so a
//    human can actually click them.
{
  for (const sev of ['fatal', 'warning']) {
    const menu = actions.underwriterActions({ severity: sev });
    const keys = menu.map((a) => a.key);
    assert.ok(keys.includes('downgrade_severity'), `${sev} menu offers "Severity too high"`);
    assert.ok(keys.includes('upgrade_severity'), `${sev} menu offers "Severity too low"`);
    // each carries a label + needs:'note' so the resolve modal renders + collects a reason
    const hi = menu.find((a) => a.key === 'downgrade_severity');
    assert.strictEqual(hi.needs, 'note');
    assert.ok(hi.label, 'has a button label');
  }
  ok('the severity-adjust actions are offered on both fatal and warning findings');
}

// 5. An unknown action still maps to no decision (no accidental capture).
{
  assert.strictEqual(learning.DECISION_BY_ACTION.mystery, undefined);
  ok('an unknown action maps to no decision');
}

console.log(`\nseverity-adjust capture pure — ${passed} checks passed`);
