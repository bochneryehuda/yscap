'use strict';
/**
 * Unit tests for the PILOT verdict headline (verdict.js). Pure — composes already-computed
 * roll-ups into one plain-English status + reasons.
 */
const assert = require('assert');
const { computeVerdict } = require('../src/lib/underwriting/verdict');

// ---- Nothing analyzed → pending (never a false "clear") ----
{
  const v = computeVerdict({ extractionsCount: 0, summary: { fatal: 0, warning: 0, blocksCtc: false } });
  assert.strictEqual(v.status, 'pending');
  assert.match(v.headline, /no documents/i);
}

// ---- An open fatal that blocks CTC → blocked ----
{
  const v = computeVerdict({ extractionsCount: 3, summary: { fatal: 2, warning: 1, blocksCtc: true } });
  assert.strictEqual(v.status, 'blocked');
  assert.match(v.headline, /not clear to close/i);
  assert.ok(v.reasons.some((r) => /2 fatal/.test(r)));
}

// ---- No fatals but warnings / incompleteness / risk → review ----
{
  const v = computeVerdict({
    extractionsCount: 4, summary: { fatal: 0, warning: 3, blocksCtc: false },
    risk: { band: 'elevated', score: 27 },
    completeness: { completenessPct: 70, ctcBlockers: [{ docType: 'title' }] },
    entityChain: { status: 'incomplete' },
  });
  assert.strictEqual(v.status, 'review');
  assert.ok(v.reasons.some((r) => /required document/.test(r)));
  assert.ok(v.reasons.some((r) => /elevated/.test(r)));
}

// ---- A broken entity chain surfaces as a reason ----
{
  const v = computeVerdict({ extractionsCount: 5, summary: { fatal: 0, warning: 0, blocksCtc: false },
    entityChain: { status: 'broken' }, completeness: { completenessPct: 100, ctcBlockers: [] } });
  assert.strictEqual(v.status, 'review');
  assert.ok(v.reasons.some((r) => /chain is broken/.test(r)));
}

// ---- Everything clean → clear ----
{
  const v = computeVerdict({ extractionsCount: 6, summary: { fatal: 0, warning: 0, blocksCtc: false },
    risk: { band: 'low', score: 0 }, completeness: { completenessPct: 100, ctcBlockers: [] },
    entityChain: { status: 'intact' } });
  assert.strictEqual(v.status, 'clear');
  assert.strictEqual(v.reasons.length, 0);
  assert.match(v.headline, /ties out/i);
}

// ---- A high-risk file with no fatals still routes to review with the risk called out ----
{
  const v = computeVerdict({ extractionsCount: 2, summary: { fatal: 0, warning: 0, blocksCtc: false },
    risk: { band: 'high', score: 60 }, completeness: { completenessPct: 100, ctcBlockers: [] } });
  assert.strictEqual(v.status, 'review');
  assert.ok(v.reasons.some((r) => /high fraud/.test(r)));
}

// ---- A note-buyer dealbreaker is NEVER a silent "clear" (re-audit 2026-07-27) ----
// Guideline items are counted apart from `fatal`/`warning` because they are a different buyer's
// rulebook, not clear-to-close work. That split is right, but it briefly meant a file whose ONLY
// open item was a guideline dealbreaker fell through to `clear` and announced "nothing is
// outstanding" — directly above a red fatal card. Announcing nothing about a real problem is the
// one failure direction this system does not get to have.
{
  const v = computeVerdict({ extractionsCount: 4,
    summary: { fatal: 0, warning: 0, blocksCtc: false, guideline: { fatal: 1, warning: 0 } },
    risk: { band: 'low', score: 0 }, completeness: { completenessPct: 100, ctcBlockers: [] },
    entityChain: { status: 'intact' } });
  assert.notStrictEqual(v.status, 'clear');
  assert.ok(v.reasons.some((r) => /dealbreaker/i.test(r)), `expected a note-buyer reason, got ${JSON.stringify(v.reasons)}`);
  assert.doesNotMatch(v.headline, /nothing is outstanding/i);
}
// ...a guideline WARNING is surfaced too, in softer words.
{
  const v = computeVerdict({ extractionsCount: 4,
    summary: { fatal: 0, warning: 0, blocksCtc: false, guideline: { fatal: 0, warning: 2 } },
    risk: { band: 'low', score: 0 }, completeness: { completenessPct: 100, ctcBlockers: [] } });
  assert.strictEqual(v.status, 'review');
  assert.ok(v.reasons.some((r) => /guideline note/i.test(r)));
}
// ...and a file with no guideline block at all is byte-identical to before (back-compat).
{
  const v = computeVerdict({ extractionsCount: 6, summary: { fatal: 0, warning: 0, blocksCtc: false },
    risk: { band: 'low', score: 0 }, completeness: { completenessPct: 100, ctcBlockers: [] },
    entityChain: { status: 'intact' } });
  assert.strictEqual(v.status, 'clear');
  assert.strictEqual(v.reasons.length, 0);
}
// A guideline dealbreaker must NOT flip the clear-to-close gate — it is advisory.
{
  const v = computeVerdict({ extractionsCount: 4,
    summary: { fatal: 0, warning: 0, blocksCtc: false, guideline: { fatal: 3, warning: 0 } },
    risk: { band: 'low', score: 0 }, completeness: { completenessPct: 100, ctcBlockers: [] } });
  assert.notStrictEqual(v.status, 'blocked');
}

console.log('test-underwriting-verdict: plain-English headline composition pass');
