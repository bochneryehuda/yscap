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
 *   · 105-107 N 10th St draw #1 (f935fab0…) — COMPLETED, disbursed_at '2026-07-21': the one
 *     shape that IS a real release.
 */
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src');
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
    approved_cents: cents(10000), disbursed_cents: cents(9750), disbursed_at: '2026-07-21',
    to_disburse_cents: null, fees: null,
  });
  assert.strictEqual(r.skipped, 'not_disbursed', 'a DRAFT draw must never announce a release');

  // (d) THE REAL THING: completed + an actual wire date → announced, at the stated net.
  reset();
  nextRows['INSERT INTO draw_disbursements'] = { rows: [{ id: 7 }], rowCount: 1 };
  r = await mirror.mirrorDisbursement(APP, {
    tp_draw_id: 'f935fab0', number: 1, status: 'COMPLETED',
    requested_cents: cents(17000), approved_cents: cents(10687.5), disbursed_cents: cents(10437.5),
    disbursed_at: '2026-07-21', to_disburse_cents: null, fees: [{ name: 'Per Draw Fee', amount: 250 }],
  }, { addr: '105-107 N 10th St' });
  assert.strictEqual(r.ok, true, 'a genuinely wired draw must still be announced');
  assert.strictEqual(r.net, cents(10437.5), 'the net is the amount the administrator says went out');
  const borrower = notes.find((n) => n.to === 'borrower');
  assert.ok(borrower, 'the borrower is told about a real release');
  assert.ok(/\$10,437\.50/.test(borrower.body), 'the borrower sees the stated net, not approved−fees');
  // owner-directed: the draw number rides the SUBJECT (the template builds `title · file tag`)
  assert.ok(/#1/.test(borrower.title), `the subject names which draw it is — got "${borrower.title}"`);
  assert.ok(Array.isArray(borrower.bccExtra) && borrower.bccExtra.includes('draws@yscapgroup.com'),
    'the draw desk is looped in on the borrower release email');

  // (e) A stale wire (older than the go-forward window) records but stays silent.
  reset();
  nextRows['INSERT INTO draw_disbursements'] = { rows: [{ id: 8 }], rowCount: 1 };
  r = await mirror.mirrorDisbursement(APP, {
    tp_draw_id: 'old-1', number: 1, status: 'COMPLETED',
    approved_cents: cents(20000), disbursed_cents: cents(19750),
    disbursed_at: '2026-01-05', to_disburse_cents: null, fees: null,
  });
  assert.strictEqual(r.silent, true, 'a months-old wire is history, not news');
  assert.strictEqual(notes.length, 0);
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
