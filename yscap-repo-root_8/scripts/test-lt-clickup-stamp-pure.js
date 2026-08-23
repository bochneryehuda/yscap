'use strict';
/**
 * THE BINDING STAMP — the one write Long-Term makes into ClickUp, and everything it
 * refuses.
 *
 * WHAT IS ACTUALLY BEING PROVEN. Not that the happy path works — that is the easy
 * half and the cheap failure. What matters is the four refusals, because each one is
 * a way to quietly corrupt the link between two systems that the office reads as the
 * truth about a deal:
 *
 *   - writing a BLANK unlinks a file, and nothing downstream can tell that apart
 *     from a file that was never linked;
 *   - writing over an EXISTING stamp re-points a card at a different loan, so two
 *     unrelated deals silently become one;
 *   - writing a field that is not the stamp turns a narrow, argued-for write into a
 *     general one nobody agreed to;
 *   - writing at all while the switch is off means the switch was decoration.
 *
 * The allowlist is checked BEFORE a request is built, so the test can prove the
 * refusal without a network in reach — which is the point of building it that way.
 */

const assert = require('assert');
const stamp = require('../src/longterm/clickup/stamp');
const { SYNC } = require('../src/clickup/fields');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };
const throws = (fn, re, w) => { assert.throws(fn, re, w); console.log('  ok  ', w); checks++; };

const TASK = '868kur80x';
const LOAN = '2e6649fd-90f4-4345-b412-f4f99c262924';
const OK_PATH = `/task/${TASK}/field/${SYNC.portalFileId}`;

// A card as ClickUp hands it back, with its stamp field holding `held`.
const card = (held) => ({
  id: TASK,
  custom_fields: [
    { id: SYNC.ysLoanNumber || 'a6da91bc-9eae-4f9d-b788-353afd4d2858', value: 'YSCAP1' },
    { id: SYNC.portalFileId, value: held },
  ],
});

const withEnv = async (env, fn) => {
  const before = {};
  for (const k of Object.keys(env)) { before[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
  }
};

const ON = { LT_CLICKUP_STAMP_ENABLED: '1', LT_CLICKUP_STAMP_DRYRUN: '' };

(async () => {
  // ── A. the allowlist refuses before a request exists ─────────────────────
  console.log('\nA. the allowlist — checked before a request is built');
  ok(stamp.assertStampablePath('POST', OK_PATH) === true, 'the stamp field on a task is allowed');
  ok(stamp.assertStampablePath('POST', `/task/${TASK}/field/${SYNC.portalFileLink}`) === true,
    'so is the portal link field');
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'put']) {
    throws(() => stamp.assertStampablePath(m, OK_PATH), /refuses/i, `${m} is refused`);
  }
  throws(() => stamp.assertStampablePath('POST', `/task/${TASK}`),
    /only \/task/i, 'a plain task update is refused — this is not a general write path');
  throws(() => stamp.assertStampablePath('POST', `/list/123/task`),
    /only \/task/i, 'creating a task is refused');
  throws(() => stamp.assertStampablePath('POST', `/task/${TASK}/field/${SYNC.syncStatus}`),
    /may only write the portal file id/i, 'ANOTHER field on the same task is refused');
  throws(() => stamp.assertStampablePath('POST', `/task/${TASK}/field/a6da91bc-9eae-4f9d-b788-353afd4d2858`),
    /may only write the portal file id/i, 'and so is the YS loan number — we read that, we do not write it');
  eq(stamp.STAMPABLE_IDS.length, 2, 'exactly two fields are stampable, ever');

  // ── B. off until somebody turns it on ────────────────────────────────────
  console.log('\nB. blank means off — a write that has never run does not default itself on');
  await withEnv({ LT_CLICKUP_STAMP_ENABLED: '' }, async () => {
    eq(stamp.enabled(), false, 'blank is off');
    let sent = 0;
    const r = await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN, deps: { getTask: async () => card(null), send: async () => { sent++; } } });
    eq(r.ok, false, 'and a stamp attempt answers "no"');
    eq(sent, 0, 'having sent nothing');
    ok(/switched off/i.test(r.reason), 'saying so in words a person can act on');
  });
  for (const v of ['0', 'no', 'off', 'false', 'maybe']) {
    await withEnv({ LT_CLICKUP_STAMP_ENABLED: v }, () => { eq(stamp.enabled(), false, `"${v}" is off`); });
  }
  for (const v of ['1', 'true', 'yes', 'ON']) {
    await withEnv({ LT_CLICKUP_STAMP_ENABLED: v }, () => { eq(stamp.enabled(), true, `"${v}" is on`); });
  }

  // ── C. it never clears ───────────────────────────────────────────────────
  console.log('\nC. it never writes a blank — a cleared stamp reads as "never linked"');
  await withEnv(ON, async () => {
    for (const v of ['', '   ', null, undefined]) {
      let sent = 0;
      const r = await stamp.stampTask({ taskId: TASK, ltLoanId: v, deps: { getTask: async () => card(null), send: async () => { sent++; } } });
      eq(r.ok, false, `a value of ${JSON.stringify(v)} is refused`);
      eq(sent, 0, '  and nothing was sent');
    }
    const r = await stamp.stampTask({ taskId: '', ltLoanId: LOAN, deps: { getTask: async () => card(null), send: async () => {} } });
    eq(r.reason, 'no_task', 'and no task id is refused too');
  });

  // ── D. a stamp that already says this is not re-written ──────────────────
  console.log('\nD. an identical stamp is left alone — the budget is shared with the live RTL sync');
  await withEnv(ON, async () => {
    let sent = 0;
    const r = await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN, deps: { getTask: async () => card(LOAN), send: async () => { sent++; } } });
    eq(r.ok, true, 'it reports success');
    eq(r.skipped, 'already_stamped', 'as a skip, not a write');
    eq(sent, 0, 'and sent nothing');
    const upper = await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN.toUpperCase(), deps: { getTask: async () => card(LOAN), send: async () => { sent++; } } });
    eq(upper.skipped, 'already_stamped', 'the same id in a different casing is still the same id');
    eq(sent, 0, 'so still nothing sent');
  });

  // ── E. a card claimed by another loan is a contradiction, not a race ─────
  console.log('\nE. it never overwrites somebody else\'s stamp');
  await withEnv(ON, async () => {
    let sent = 0;
    const other = '11111111-2222-3333-4444-555555555555';
    const r = await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN, deps: { getTask: async () => card(other), send: async () => { sent++; } } });
    eq(r.ok, false, 'it refuses');
    eq(r.reason, 'occupied', 'naming the reason');
    eq(r.heldBy, other, 'and saying which file already claims the card');
    eq(sent, 0, 'nothing was sent');
  });

  // ── F. the happy path, and exactly what goes on the wire ─────────────────
  console.log('\nF. an unclaimed card is stamped — and only in the two allowed fields');
  await withEnv(ON, async () => {
    const calls = [];
    const r = await stamp.stampTask({
      taskId: TASK, ltLoanId: LOAN, fileUrl: 'https://pilot.example/portal/#/lt/' + LOAN,
      deps: { getTask: async () => card(null), send: async (p, b) => { calls.push([p, b]); } },
    });
    eq(r.ok, true, 'it succeeds');
    eq(calls.length, 2, 'two writes: the id and the link');
    eq(calls[0][0], OK_PATH, 'the first is the portal file id field');
    eq(calls[0][1].value, LOAN, 'carrying the loan id');
    eq(calls[1][0], `/task/${TASK}/field/${SYNC.portalFileLink}`, 'the second is the link field');
    for (const [p] of calls) { ok(stamp.assertStampablePath('POST', p) === true, `and ${p} passes the allowlist`); }
    // Without a url, the link field is not touched at all.
    const one = [];
    await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN, deps: { getTask: async () => card(null), send: async (p) => { one.push(p); } } });
    eq(one.length, 1, 'with no url given, only the id field is written');
  });

  // ── G. a dry run sends nothing ───────────────────────────────────────────
  console.log('\nG. a dry run builds the request and sends nothing');
  await withEnv({ LT_CLICKUP_STAMP_ENABLED: '1', LT_CLICKUP_STAMP_DRYRUN: '1' }, async () => {
    let sent = 0;
    const r = await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN, deps: { getTask: async () => card(null), send: async () => { sent++; } } });
    eq(r.ok, true, 'it reports what it would have done');
    eq(r.dryRun, true, 'marked as a dry run');
    eq(sent, 0, 'and sent nothing');
  });

  // ── H. it answers, it does not throw ─────────────────────────────────────
  console.log('\nH. a vendor having a moment is an answer, not an exception');
  await withEnv(ON, async () => {
    const r = await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN, deps: { getTask: async () => { throw new Error('ClickUp 503'); }, send: async () => {} } });
    eq(r.ok, false, 'a failed read answers false');
    ok(/could not read the card first/i.test(r.reason), 'and says the read was what failed');
    const w = await stamp.stampTask({ taskId: TASK, ltLoanId: LOAN, deps: { getTask: async () => card(null), send: async () => { throw new Error('ClickUp POST failed (HTTP 500)'); } } });
    eq(w.ok, false, 'a failed write answers false');
    eq(w.wrote.length, 0, 'reporting that nothing landed');
  });

  // ── I. no general write, no secret in the source ─────────────────────────
  console.log('\nI. the shape stays narrow');
  const src = require('fs').readFileSync(require.resolve('../src/longterm/clickup/stamp'), 'utf8');
  ok(/LT_CLICKUP_API_TOKEN/.test(src), 'it names the token env var');
  ok(!/pk_[0-9]/.test(src), 'and carries no token value');
  ok(!Object.keys(stamp).some((k) => /^(createTask|updateTask|deleteTask|setField|write)/.test(k)),
    'nothing exported is a general write');
  const client = require('../src/longterm/clickup/client');
  throws(() => client._internals.assertReadOnly('POST'),
    /read-only/i, 'and the READ client is still read-only — the write did not leak into it');

  console.log(`\nall good — ${checks} checks`);
})().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
