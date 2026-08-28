'use strict';
/**
 * LONG-TERM — the status-push DECISION (db/626, owner-directed 2026-08-24).
 *
 * The rule being pinned: a ClickUp status is written ONLY because a milestone
 * fired. It is never written to reconcile a card that merely disagrees, and a
 * card the team has moved AHEAD is left alone.
 *
 * Section D is the owner's own scenario, spelled out, because it is the one
 * that was broken in production: *"If I put CTC in ClickUp and Encompass is not
 * yet CTC … Encompass doesn't need to push back to ClickUp and say 'hey, update
 * back, it's not CTC'."*
 *
 * PURE — no database, no network, no clock of its own.
 */

const { decideStatusPush, BACKWARD_OK, _internals } = require('../src/longterm/clickup/status-push');

let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; return; }
  fails.push(what);
  console.error(`  ✗ ${what}`);
}
const eq = (got, want, what) => ok(got === want, `${what} (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`);

// The tenant's real officer-list order, earliest first.
const ORDER = [
  'starting', 'assigned to processor', 'delegate initial', 'workflow',
  'ctc (4-email)', 'scheduling closing', 'active closing',
  'closed (6-email funded)', 'in purchase review', 'pa issued-post closing.',
];
const T0 = '2026-08-20T10:00:00Z';   // the watermark
const T1 = '2026-08-24T10:00:00Z';   // a milestone that fired AFTER it
const NOW = new Date('2026-08-24T12:00:00Z');
const D = (status, reason = 'a milestone is complete') => ({ status, reason });

// ── A. The engine claiming nothing is never a write ─────────────────────────
console.log('A. the engine claims nothing');
{
  for (const d of [D(null), D(''), D('   '), null, undefined, {}]) {
    const r = decideStatusPush({ desired: d, current: 'workflow', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW });
    eq(r.act, 'none', 'no status claimed -> act none');
    eq(r.stamp, false, 'no status claimed -> the watermark does not move');
  }
  // An unread funding channel is the real shape of this: the engine refuses on
  // purpose and must not be turned into a review row either — we have no
  // opinion to put in front of anybody.
  const r = decideStatusPush({ desired: D(null, 'the funding channel could not be read'), current: 'ctc (4-email)', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW });
  eq(r.act, 'none', 'an unread channel raises no review row');
  ok(/funding channel/.test(r.reason), 'the engine\'s own reason is carried through');
}

// ── B. First sighting baselines and writes nothing ──────────────────────────
console.log('B. first sighting');
{
  const r = decideStatusPush({ desired: D('ctc (4-email)'), current: 'starting', watermark: null, latestEntered: T1, statusOrder: ORDER, now: NOW });
  eq(r.act, 'baseline', 'a loan with no watermark baselines');
  eq(r.stamp, true, 'baselining takes the watermark');
  eq(r.stampTo, NOW, 'the watermark is taken at now, not at the historical event');
  ok(r.to === undefined, 'baselining writes no status');

  // THE POINT of the baseline: the loan has years of history and none of it fires.
  const historic = decideStatusPush({ desired: D('closed (6-email funded)'), current: 'starting', watermark: null, latestEntered: '2024-01-01T00:00:00Z', statusOrder: ORDER, now: NOW });
  eq(historic.act, 'baseline', 'historical milestones on a never-seen loan do not push');

  // An unreadable watermark is treated as absent, never as epoch 0 (which would
  // make every event look new and reproduce the sweep).
  for (const bad of ['', 'not-a-date', NaN]) {
    eq(decideStatusPush({ desired: D('workflow'), current: 'starting', watermark: bad, latestEntered: T1, statusOrder: ORDER, now: NOW }).act,
      'baseline', `an unreadable watermark (${JSON.stringify(bad)}) baselines rather than pushing`);
  }
}

// ── C. No new milestone: never write ────────────────────────────────────────
console.log('C. no milestone has fired');
{
  const agree = decideStatusPush({ desired: D('workflow'), current: 'workflow', watermark: T0, latestEntered: T0, statusOrder: ORDER, now: NOW });
  eq(agree.act, 'agree', 'no event + the card already agrees -> agree');
  eq(agree.stamp, false, 'agreeing with no event does not move the watermark');

  // An event EXACTLY at the watermark is already answered — a strict > is what
  // stops one event being re-answered on every pass.
  const same = decideStatusPush({ desired: D('ctc (4-email)'), current: 'starting', watermark: T0, latestEntered: T0, statusOrder: ORDER, now: NOW });
  eq(same.act, 'review', 'an event at exactly the watermark is not new');
  eq(same.stamp, false, 'and it does not move the watermark again');

  for (const late of [null, undefined, '', 'garbage']) {
    const r = decideStatusPush({ desired: D('ctc (4-email)'), current: 'starting', watermark: T0, latestEntered: late, statusOrder: ORDER, now: NOW });
    eq(r.act, 'review', `no readable event (${JSON.stringify(late)}) -> review, never a push`);
    ok(r.to === undefined, 'and nothing is written');
  }
}

// ── D. THE OWNER'S SCENARIO ─────────────────────────────────────────────────
// "If I put CTC in ClickUp and Encompass is not yet CTC, Encompass doesn't need
//  to push back to ClickUp and say 'hey, update back, it's not CTC'."
console.log("D. the owner's scenario — the team moved the card ahead");
{
  const r = decideStatusPush({
    desired: D('workflow', '"Cond. Approval" is the latest completed milestone'),
    current: 'ctc (4-email)',          // the team set this by hand
    watermark: T0, latestEntered: T0,  // Encompass has fired nothing since
    statusOrder: ORDER, now: NOW,
  });
  eq(r.act, 'review', "the team's CTC is left alone");
  ok(r.to === undefined, 'PILOT writes nothing');
  eq(r.stamp, false, 'and consumes no event');
  eq(r.current, 'ctc (4-email)', 'the review row shows what ClickUp holds');
  eq(r.proposed, 'workflow', "and what Encompass's milestones imply");
  ok(/no milestone has fired/.test(r.reason), 'the reason says why PILOT stood down');

  // And the other half of the owner's sentence: when Encompass DOES reach CTC,
  // it pushes.
  const fired = decideStatusPush({
    desired: D('ctc (4-email)', '"Clear to Close" is the latest completed milestone'),
    current: 'workflow', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW,
  });
  eq(fired.act, 'push', 'Encompass reaching CTC does push CTC');
  eq(fired.to, 'ctc (4-email)', 'and pushes the right one');
}

// ── E. A milestone fired ────────────────────────────────────────────────────
console.log('E. a milestone fired');
{
  const fwd = decideStatusPush({ desired: D('active closing'), current: 'scheduling closing', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW });
  eq(fwd.act, 'push', 'a forward move is pushed');
  eq(fwd.to, 'active closing', 'to the status the ladder implies');
  eq(fwd.from, 'scheduling closing', 'recording what it moved from');
  eq(fwd.stamp, true, 'and the event is consumed');
  eq(fwd.stampTo, T1, 'the watermark advances to the event, not to now');
  ok(/not to reconcile/.test(fwd.reason), 'the reason states the push was event-driven');

  const agreed = decideStatusPush({ desired: D('workflow'), current: 'Workflow', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW });
  eq(agreed.act, 'agree', 'a fired milestone the card already matches (case-blind) writes nothing');
  eq(agreed.stamp, true, 'but still consumes the event, so it cannot re-fire forever');

  // Backwards is refused by default and SURFACED instead.
  const back = decideStatusPush({ desired: D('workflow'), current: 'active closing', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW });
  eq(back.act, 'review', 'a backwards move is not written by default');
  eq(back.stamp, true, 'the event is still answered, so it does not re-ask every pass');
  ok(/BEHIND/.test(back.reason), 'and the reason says it would have moved the card back');

}

// ── E2. THE OWNER'S EXCLUSION — reassigning the processor ───────────────────
// "Assigned to Processor, it should allow pushing it back because that's if we
//  want to reassign the processor. But everything else, you should not be able
//  to push back statuses backwards, only forward."
console.log('E2. the one status that may move a card backwards');
{
  const back = decideStatusPush({
    desired: D('assigned to processor', '"LO Prep" is the latest completed milestone'),
    current: 'active closing', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW,
  });
  eq(back.act, 'push', 'assigned to processor IS written backwards');
  eq(back.to, 'assigned to processor', 'to the reassignment status');
  ok(/on purpose/.test(back.reason), 'and the reason says it was deliberate, not a regression');

  // It is exempt from the direction test entirely, so an unreadable order
  // cannot block a reassignment either.
  eq(decideStatusPush({ desired: D('assigned to processor'), current: 'active closing', watermark: T0, latestEntered: T1, statusOrder: null, now: NOW }).act,
    'push', 'and an unreadable status order does not block it');

  // The exemption is keyed on the status being WRITTEN, not the one held.
  eq(decideStatusPush({ desired: D('workflow'), current: 'assigned to processor', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW }).act,
    'push', 'moving FORWARD off assigned-to-processor is an ordinary push');
  eq(decideStatusPush({ desired: D('starting'), current: 'assigned to processor', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW }).act,
    'review', 'but the card HOLDING it grants no licence to move it back to starting');

  // It is still EVENT-driven — the exclusion widens direction, never the trigger.
  eq(decideStatusPush({ desired: D('assigned to processor'), current: 'active closing', watermark: T0, latestEntered: T0, statusOrder: ORDER, now: NOW }).act,
    'review', 'with no milestone fired, even the exempt status is not written');

  eq(BACKWARD_OK.size, 1, 'exactly one status is exempt today');
  ok(BACKWARD_OK.has('assigned to processor'), 'and it is the one the owner named');
}

// ── F. Direction it cannot prove is treated as backwards ────────────────────
console.log('F. an unprovable direction fails safe');
{
  for (const order of [null, undefined, [], ['workflow']]) {   // last: card's status absent from the order
    const r = decideStatusPush({ desired: D('workflow'), current: 'active closing', watermark: T0, latestEntered: T1, statusOrder: order, now: NOW });
    eq(r.act, 'review', `an unusable status order (${JSON.stringify(order)}) refuses the write`);
    eq(r.stamp, true, 'and still answers the event');
  }
  // "Not on the list" is a CONFIGURATION problem and is reported as its own
  // thing — a reviewer told "PILOT could not read the direction" would go
  // hunting the wrong fault.
  const unknownWanted = decideStatusPush({ desired: D('some new status'), current: 'workflow', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW });
  eq(unknownWanted.act, 'review', 'a wanted status the list does not carry is never written blind');
  eq(unknownWanted.notOnList, true, '…and it is flagged as a list problem, not a direction one');
  ok(/not on the card's ClickUp list/.test(unknownWanted.reason), '…in those words');

  // With NO readable order at all we cannot claim the list lacks it — we simply
  // could not look. Saying "not on the list" there would be a confident guess.
  const noOrder = decideStatusPush({ desired: D('some new status'), current: 'workflow', watermark: T0, latestEntered: T1, statusOrder: null, now: NOW });
  eq(noOrder.act, 'review', 'an unreadable order still refuses');
  eq(noOrder.notOnList, false, '…but never claims the status is missing from a list it could not read');

  // A blank card status with a known target is still unprovable, so it is
  // surfaced rather than written.
  const blank = decideStatusPush({ desired: D('workflow'), current: '', watermark: T0, latestEntered: T1, statusOrder: ORDER, now: NOW });
  eq(blank.act, 'review', 'a card with no readable status is not written blind');
  ok(/\(none\)/.test(blank.reason), 'and the reason says the card had none');
}

// ── G. The helpers ──────────────────────────────────────────────────────────
console.log('G. helpers');
{
  eq(_internals.ms(null), null, 'ms(null) is null');
  eq(_internals.ms('nonsense'), null, 'ms of garbage is null, never NaN');
  eq(_internals.ms(new Date(5)), 5, 'ms of a Date is its epoch ms');
  eq(_internals.rankOf(ORDER, 'WORKFLOW'), 3, 'rankOf is case-blind');
  eq(_internals.rankOf(ORDER, 'nope'), null, 'rankOf of an unlisted status is null');
  eq(_internals.rankOf(null, 'workflow'), null, 'rankOf with no order is null');
}

// ── H. Nothing here can write a status without an event ─────────────────────
// The invariant, swept over the whole matrix rather than asserted case by case.
console.log('H. the invariant, over the whole matrix');
{
  let pushes = 0, checked = 0, backwardPushes = 0;
  for (const watermark of [null, T0]) {
    for (const latestEntered of [null, T0, T1, 'garbage']) {
      for (const current of ['starting', 'workflow', 'active closing', '']) {
        for (const want of ['workflow', 'active closing', 'assigned to processor', null]) {
          for (const statusOrder of [ORDER, null]) {
            checked++;
            const r = decideStatusPush({ desired: D(want), current, watermark, latestEntered, statusOrder, now: NOW });
            if (r.act !== 'push') continue;
            pushes++;
            ok(watermark != null, 'a push never happens without a watermark');
            ok(_internals.ms(latestEntered) != null && _internals.ms(latestEntered) > _internals.ms(watermark),
              'a push never happens without a NEWER milestone event');
            ok(_internals.norm(r.to) !== _internals.norm(current), 'a push never writes the status already there');
            // The direction law: forward, or one of the owner's named exclusions.
            const hr = _internals.rankOf(statusOrder, current);
            const wr = _internals.rankOf(statusOrder, r.to);
            const forward = (hr != null && wr != null) ? wr > hr : null;
            ok(forward === true || BACKWARD_OK.has(_internals.norm(r.to)),
              `a push is forward, or an exempt status (${r.to} over ${current || '(none)'})`);
            if (forward !== true) backwardPushes++;
          }
        }
      }
    }
  }
  ok(checked === 256, `the matrix ran (${checked} combinations)`);
  ok(pushes > 0, `and it did produce pushes (${pushes}) — otherwise the invariant is vacuous`);
  ok(backwardPushes > 0, `including exempt backwards pushes (${backwardPushes}) — so that arm is exercised too`);
}

console.log(`\ntest-lt-status-push-pure: ${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
