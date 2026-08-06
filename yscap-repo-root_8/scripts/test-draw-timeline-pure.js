'use strict';
/**
 * THE PER-DRAW STAGE TIMELINE — a timestamp on every step, presented like a loan file's stages
 * (owner-directed). Pure — no database, no network. Covers: the done/current/upcoming state of each
 * stage, the timestamp mapped to each stage (and the honest blank where a stage has no recorded
 * time), the dispute detour, and the borrower-safe rule (the capital-partner step is never shown to
 * a borrower, and the reader still sees where the draw is).
 */

const assert = require('assert');
const { stageTimeline } = require('../src/sitewire/draw-timeline');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };
const byStage = (tl) => Object.fromEntries(tl.map((s) => [s.stage, s]));

const TIMES = {
  submitted_at: '2026-08-01T14:00:00.000Z',
  delivered_at: '2026-08-03T09:30:00.000Z',
  accepted_at: '2026-08-04T11:00:00.000Z',
  investor_delivered_at: '2026-08-05T08:00:00.000Z',
  approved_at: '2026-08-06T10:00:00.000Z',
  released_at: '2026-08-07',
};

console.log('\nA · STATE — each stage is done / current / upcoming relative to where the draw is');
{
  const tl = stageTimeline(TIMES, 'with_investor', { borrower: false });
  const m = byStage(tl);
  ok(m.inspecting.state === 'done', 'a passed stage is done: inspecting');
  ok(m.borrower_accepted.state === 'done', 'a passed stage is done: borrower_accepted');
  ok(m.with_investor.state === 'current', 'the draw\'s own stage is current: with_investor');
  ok(m.final_approved.state === 'upcoming', 'a later stage is upcoming: final_approved');
  ok(m.released.state === 'upcoming', 'and the last stage is upcoming: released');
}

console.log('\nB · TIMESTAMPS — the recorded date rides each reached stage; upcoming carries none');
{
  const tl = stageTimeline(TIMES, 'released', { borrower: false });
  const m = byStage(tl);
  ok(m.inspecting.at === TIMES.submitted_at, 'inspecting shows the submitted time');
  ok(m.borrower_review.at === TIMES.delivered_at, 'borrower_review shows the findings-delivered time');
  ok(m.borrower_accepted.at === TIMES.accepted_at, 'borrower_accepted shows the accepted time');
  ok(m.with_investor.at === TIMES.investor_delivered_at, 'with_investor shows the investor-delivery time');
  ok(m.final_approved.at === TIMES.approved_at, 'final_approved shows the lender-approval time');
  ok(m.released.at === TIMES.released_at, 'released shows the wire date');
}

console.log('\nC · HONEST BLANKS — a stage with no recorded time shows no date, never a guess');
{
  const tl = stageTimeline(TIMES, 'released', { borrower: false });
  const m = byStage(tl);
  ok(m.inspector_approved.at == null, 'inspector_approved has no separate stamp → no date');
  // upcoming stages never carry a date even if the raw object somehow held one
  const early = byStage(stageTimeline(TIMES, 'inspecting', { borrower: false }));
  ok(early.released.at == null, 'an upcoming stage carries no date');
  ok(early.final_approved.at == null, 'another upcoming stage carries no date');
}

console.log('\nD · BORROWER-SAFE — the capital-partner step is never shown to a borrower');
{
  const tl = stageTimeline(TIMES, 'with_investor', { borrower: true });
  ok(!tl.some((s) => s.stage === 'with_investor'), 'the borrower timeline omits with_investor entirely');
  ok(tl.some((s) => s.stage === 'final_approved'), 'but still shows the later approved/released steps');
  // With the draw sitting at the (hidden) investor step, the borrower still sees where it is:
  // the furthest visible step is marked current rather than leaving nothing highlighted.
  const cur = tl.find((s) => s.state === 'current');
  ok(cur && cur.stage === 'borrower_accepted', 'the furthest visible step is current: borrower_accepted');
  // borrower wording, not the staff wording
  const m = byStage(tl);
  ok(/under review/i.test(m.borrower_accepted.label), 'borrower wording is used: ' + m.borrower_accepted.label);
}

console.log('\nE · STAFF sees the capital-partner step, in its own words');
{
  const m = byStage(stageTimeline(TIMES, 'with_investor', { borrower: false }));
  ok(/capital partner/i.test(m.with_investor.label), 'staff wording names the capital partner: ' + m.with_investor.label);
}

console.log('\nF · THE DISPUTE DETOUR — shown only when the borrower actually pushed back');
{
  const noDispute = stageTimeline(TIMES, 'borrower_accepted', { borrower: false });
  ok(!noDispute.some((s) => s.stage === 'borrower_disputed'), 'no dispute → no dispute step');

  const disputed = { ...TIMES, disputed_at: '2026-08-03T18:00:00.000Z', accepted_at: null, resolved_at: null };
  const tl = stageTimeline(disputed, 'borrower_disputed', { borrower: false });
  const m = byStage(tl);
  ok(m.borrower_disputed, 'a dispute inserts the dispute step');
  ok(m.borrower_disputed.state === 'current', 'and it is the current step while unresolved');
  ok(m.borrower_disputed.at === disputed.disputed_at, 'carrying the disputed time');
  // The dispute detour appears BEFORE the accept step in order.
  ok(tl.findIndex((s) => s.stage === 'borrower_disputed') < tl.findIndex((s) => s.stage === 'borrower_accepted'),
    'the dispute step comes before the accept step');
}

console.log('\nG · borrower_accepted falls back to the resolved time after a dispute was worked out');
{
  const resolved = { ...TIMES, accepted_at: null, resolved_at: '2026-08-04T20:00:00.000Z', disputed_at: '2026-08-03T18:00:00.000Z' };
  const m = byStage(stageTimeline(resolved, 'borrower_accepted', { borrower: false }));
  ok(m.borrower_accepted.at === resolved.resolved_at, 'borrower_accepted uses resolved_at when there is no accepted_at');
}

console.log('\nH · TERMINAL + degenerate inputs never throw');
{
  const released = byStage(stageTimeline(TIMES, 'released', { borrower: false }));
  ok(released.released.state === 'current', 'a released draw marks released as current');

  let threw = false;
  try {
    const empty = stageTimeline(null, '', { borrower: false });
    ok(Array.isArray(empty) && empty.every((s) => s.state === 'upcoming'), 'no times + unknown stage → all upcoming, no crash');
    ok(stageTimeline(undefined, undefined).length > 0, 'undefined inputs still return the staff flow');
    // an explicit null opts must not throw on the destructure (robustness)
    ok(stageTimeline(TIMES, 'released', null).length > 0, 'a null opts argument is handled, not thrown on');
  } catch (_) { threw = true; }
  ok(!threw, 'degenerate inputs never throw');
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'draw-timeline pure tests failed');
