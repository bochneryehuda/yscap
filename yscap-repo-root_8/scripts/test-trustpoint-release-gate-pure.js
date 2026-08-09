'use strict';
/**
 * TrustPoint mirror — release-announcement gate + one-notice-per-inspection (owner-reported
 * 2026-07-27). PURE: `../src/db` and `../src/lib/notify` are stubbed in the require cache, so
 * this runs with no Postgres and no network.
 *
 * Every fixture below is a REAL record pulled from TrustPoint's live API while diagnosing the
 * two reported files, so these cases are the actual incidents, not invented ones:
 *
 *   · 825 Bishop St draw #2 (483ed3a0…) — status IN_REVIEW, requested $50,000,
 *     approved_amount null, approved_at null, disbursed_amount 49750, disbursed_at NULL.
 *     The borrower was emailed "$49,750.00 is on its way" the minute this draw was submitted:
 *     TrustPoint pre-fills `disbursed_amount` with the PROJECTED net (requested − the $250
 *     fee), and the old gate accepted a positive amount as proof of payment.
 *   · 105-107 N 10th St draw #2 (fc514778…) — APPROVED but disbursed_at still NULL: approved
 *     is not wired, and must stay silent too.
 *   · 105-107 N 10th St draw #1 (f935fab0…) — COMPLETED, with a real wire date: the one
 *     shape that IS a real release.
 *
 * THE WIRE DATES ARE RELATIVE TO TODAY, DELIBERATELY. The amounts and ids above are the real
 * records; the DATES are not, and must not be. `mirror.js` stays silent about a wire older than
 * 14 days (a "your money is on its way, 1–2 business days" email about a weeks-old wire would
 * be nonsense), so a hard-coded `disbursed_at: '2026-07-21'` was a fixture that MEANT "a fresh
 * wire" and silently stopped meaning it 14 days later — this suite began failing on every PR in
 * the repo at midnight UTC, having passed hours earlier on the same commit. State what the case
 * MEANS (`daysAgo(1)`), never a literal that ages out of its own intent.
 */
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src');

// A wire date N days before today, as the 'YYYY-MM-DD' string the mirror is handed. Anchored on
// UTC midnight so the offset is exact whatever hour the suite happens to run at.
function daysAgo(n) {
  const now = new Date();
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnightUtc - n * 86400000).toISOString().slice(0, 10);
}

let queries = [];
let notes = [];
let nextRows = {};          // substring of SQL -> { rows, rowCount }

function stub(modPath, exports) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub(path.join(SRC, 'db'), {
  query: async (sql, params) => {
    queries.push({ sql, params });
    for (const key of Object.keys(nextRows)) if (sql.includes(key)) return nextRows[key];
    return { rows: [], rowCount: 0 };
  },
});
stub(path.join(SRC, 'lib', 'notify'), {
  notifyAppBorrowers: async (appId, o) => { notes.push({ to: 'borrower', appId, ...o }); return []; },
  notifyAppStaff: async (appId, o) => { notes.push({ to: 'staff', appId, ...o }); return []; },
  // ONE email addressed to the borrower with the draw team on a visible Cc (owner-directed
  // 2026-08-03). It is recorded as reaching the BORROWER — which is what it does, and what the
  // assertions below mean by "the borrower is told" — and NOT as a separate staff send, because
  // there is no longer a second email. That distinction is the point of the change: the staff
  // counts asserted further down must stay at zero on a borrower announcement.
  notifyAppThread: async (appId, o) => { notes.push({ to: 'borrower', looped: 'team', appId, ...o }); return { borrowers: 1, staff: [], emailedTogether: true }; },
});
// resolveFilePlatform is consulted only for the dormant markup knob — keep it inert.
stub(path.join(SRC, 'sitewire', 'routing'), { resolveFilePlatform: async () => ({ platform: 'trustpoint', rule: {} }) });

const mirror = require(path.join(SRC, 'trustpoint', 'mirror'));

const APP = '00000000-0000-0000-0000-000000000001';
const reset = () => { queries = []; notes = []; nextRows = {}; };
const cents = (dollars) => Math.round(dollars * 100);

// ---------------------------------------------------------------------------
// 1. The release gate — a borrower hears about money only when money moved.
// ---------------------------------------------------------------------------
async function releaseGate() {
  // (a) THE REPORTED BUG. Submitted-only draw carrying TrustPoint's projected net.
  reset();
  let r = await mirror.mirrorDisbursement(APP, {
    tp_draw_id: '483ed3a0', number: 2, status: 'IN_REVIEW',
    requested_cents: cents(50000), approved_cents: null, disbursed_cents: cents(49750),
    disbursed_at: null, to_disburse_cents: null, fees: [{ name: 'Per Draw Fee', amount: 250 }],
  });
  assert.strictEqual(r.skipped, 'not_disbursed', 'an IN_REVIEW draw must never announce a release');
  assert.strictEqual(notes.length, 0, 'no notification may leave an un-wired draw');
  assert.strictEqual(queries.length, 0, 'the gate must short-circuit before touching the ledger');

  // (b) Approved is not wired. disbursed_at is still null → still silent.
  reset();
  r = await mirror.mirrorDisbursement(APP, {
    tp_draw_id: 'fc514778', number: 2, status: 'APPROVED',
    requested_cents: cents(29000), approved_cents: cents(18887.5), disbursed_cents: cents(18637.5),
    disbursed_at: null, to_disburse_cents: null, fees: [{ name: 'Per Draw Fee', amount: 250 }],
  });
  assert.strictEqual(r.skipped, 'not_disbursed', 'approved-but-unwired must not announce');
  assert.strictEqual(notes.length, 0);

  // (c) A wire date on a draw that was never decided is not a release either.
  reset();
  r = await mirror.mirrorDisbursement(APP, {
    tp_draw_id: 'draft-1', number: 1, status: 'DRAFT',
    approved_cents: cents(10000), disbursed_cents: cents(9750), disbursed_at: daysAgo(1),
    to_disburse_cents: null, fees: null,
  });
  assert.strictEqual(r.skipped, 'not_disbursed', 'a DRAFT draw must never announce a release');

  // (d) THE REAL THING: completed + an actual wire date → announced, at the stated net.
  reset();
  nextRows['INSERT INTO draw_disbursements'] = { rows: [{ id: 7 }], rowCount: 1 };
  r = await mirror.mirrorDisbursement(APP, {
    tp_draw_id: 'f935fab0', number: 1, status: 'COMPLETED',
    requested_cents: cents(17000), approved_cents: cents(10687.5), disbursed_cents: cents(10437.5),
    disbursed_at: daysAgo(1), to_disburse_cents: null, fees: [{ name: 'Per Draw Fee', amount: 250 }],
  }, { addr: '105-107 N 10th St' });
  assert.strictEqual(r.ok, true, 'a genuinely wired draw must still be announced');
  assert.strictEqual(r.net, cents(10437.5), 'the net is the amount the administrator says went out');
  const borrower = notes.find((n) => n.to === 'borrower');
  assert.ok(borrower, 'the borrower is told about a real release');
  assert.ok(/\$10,437\.50/.test(borrower.body), 'the borrower sees the stated net, not approved−fees');
  // OWNER-DIRECTED 2026-08-09: the draw number LEADS the subject line, and it does so as its own
  // `drawTag` opt rather than being spelled inside the title — `template.render` prints it first
  // ("Draw 1 · Your construction draw has been released · …"). This stub captures the notify OPTS,
  // so the tag is what to assert; asserting on the title would now be asserting on the old shape.
  assert.strictEqual(borrower.drawTag, 'Draw 1',
    `the subject leads with which draw it is — got drawTag ${JSON.stringify(borrower.drawTag)}`);
  assert.ok(!/#\s*1\b/.test(borrower.title),
    `and the number is no longer spelled inside the title too — got "${borrower.title}"`);
  // The draw desk + officer loop-in MOVED from a per-call-site `bccExtra` to a VISIBLE Cc applied
  // centrally for every 'draws' notification (owner-directed 2026-08-03: one email, everybody on
  // it, so a reply reaches them all). This suite stubs `notify` wholesale, so it can no longer see
  // that list — it is added inside the module this stub replaces. What it CAN still prove, and
  // what actually guarantees the loop-in now, is that the release goes out through the THREAD
  // helper rather than a bare borrower fan-out. The recipients themselves are asserted live, on
  // the real wire payload, by test-draw-email-db.js (B3/B4/B5) and test-draw-loop-in-db.js.
  assert.strictEqual(borrower.looped, 'team',
    'the release is announced through notifyAppThread, which is what loops the draw desk + officer in');

  // (e) A stale wire (older than the go-forward window) records but stays silent.
  reset();
  nextRows['INSERT INTO draw_disbursements'] = { rows: [{ id: 8 }], rowCount: 1 };
  r = await mirror.mirrorDisbursement(APP, {
    tp_draw_id: 'old-1', number: 1, status: 'COMPLETED',
    approved_cents: cents(20000), disbursed_cents: cents(19750),
    disbursed_at: daysAgo(120), to_disburse_cents: null, fees: null,
  });
  assert.strictEqual(r.silent, true, 'a months-old wire is history, not news');
  assert.strictEqual(notes.length, 0);

  // (f) THE WINDOW ITSELF, pinned on both sides. Every case above depends on where the
  // go-forward cutoff sits, and NOTHING asserted it — which is exactly how a fixture could
  // drift across the boundary and take the whole suite down without anyone having touched
  // the rule. Just inside must announce; just outside must not.
  for (const [days, wantSilent] of [[13, false], [15, true]]) {
    reset();
    nextRows['INSERT INTO draw_disbursements'] = { rows: [{ id: 9 }], rowCount: 1 };
    const w = await mirror.mirrorDisbursement(APP, {
      tp_draw_id: `edge-${days}`, number: 1, status: 'COMPLETED',
      approved_cents: cents(20000), disbursed_cents: cents(19750),
      disbursed_at: daysAgo(days), to_disburse_cents: null, fees: null,
    });
    if (wantSilent) {
      assert.strictEqual(w.silent, true, `a wire ${days} days old is past the window — stay silent`);
      assert.strictEqual(notes.length, 0, `nothing may be sent for a ${days}-day-old wire`);
    } else {
      assert.strictEqual(w.ok, true, `a wire ${days} days old is inside the window — announce it`);
      assert.ok(notes.some((n) => n.to === 'borrower'), `the borrower hears about a ${days}-day-old wire`);
    }
    // Either way the ledger records it — the window governs the ANNOUNCEMENT, never the record.
    assert.ok(queries.some((q) => q.sql.includes('INSERT INTO draw_disbursements')),
      `a ${days}-day-old wire is still written to the ledger`);
  }
  console.log('  ✓ release gate: only a decided draw with a real wire date announces money');
}

// ---------------------------------------------------------------------------
// 2. One notice per completed inspection, and none for history.
// ---------------------------------------------------------------------------
async function inspectionNotice() {
  const so = {
    id: '12f6a681', project_id: '492adcc0', draw_request_id: 'fc514778',
    service_type: 'INSPECTION', status: 'COMPLETED', inspector_allowance_rate: 23.66,
  };

  // (a) First completion wins the claim → exactly one staff notice.
  reset();
  nextRows["SET status_synced='COMPLETED'"] = { rows: [{ tp_service_order_id: so.id }], rowCount: 1 };
  await mirror.upsertServiceOrder(APP, so);
  const fired = notes.filter((n) => n.to === 'staff');
  assert.strictEqual(fired.length, 1, 'a completed inspection is announced once');
  assert.ok(/23.66%/.test(fired[0].body), 'the notice carries the progress figure');

  // (b) THE REPORTED BUG: the inspection was completed, revised, and completed again
  //     (TrustPoint filed two "Inspection Result Document" PDFs on this draw, 2026-07-26
  //     21:51Z and 2026-07-27 15:43Z). The claim is already held → no second notice.
  reset();
  nextRows["SET status_synced='COMPLETED'"] = { rows: [], rowCount: 0 };
  await mirror.upsertServiceOrder(APP, so);
  assert.strictEqual(notes.filter((n) => n.to === 'staff').length, 0,
    're-completing an inspection must not announce it a second time');

  // (c) THE OTHER REPORTED BUG: a just-linked project's finished inspection is HISTORY.
  //     (The 8.55% inspection finished 2026-07-20; linking on 2026-07-26 announced it.)
  reset();
  nextRows["SET status_synced='COMPLETED'"] = { rows: [{ tp_service_order_id: 'x' }], rowCount: 1 };
  await mirror.upsertServiceOrder(APP, { ...so, id: '4f2f4eee', inspector_allowance_rate: 8.55 }, { baseline: true });
  assert.strictEqual(notes.filter((n) => n.to === 'staff').length, 0,
    'a baseline hydrate claims history silently');
  // …and it still CLAIMED, so it can never be announced later as if it were new.
  assert.ok(queries.some((q) => q.sql.includes("SET status_synced='COMPLETED'")),
    'baseline still takes the claim so the notice can never fire late');

  // (d) An inspection that is not complete says nothing.
  reset();
  await mirror.upsertServiceOrder(APP, { ...so, status: 'ORDERED' });
  assert.strictEqual(notes.length, 0, 'an ordered/scheduled inspection is not an event');
  console.log('  ✓ inspections: one notice each, none replayed, none for history');
}

(async () => {
  console.log('trustpoint release gate + inspection notices (pure)');
  await releaseGate();
  await inspectionNotice();
  console.log('All TrustPoint release-gate tests passed.');
})().catch((e) => { console.error('FAILED:', e && e.message); process.exit(1); });
