'use strict';
/**
 * THE LINK PASS, PROVEN OFFLINE — the planner's refusals, the two-sided tie, and
 * the shape of what a pass writes.
 *
 * Every failure mode here is a QUIET one on a live book. A planner that guesses
 * on a duplicated loan number links a deal to somebody else's card and the office
 * learns two deals are one. A planner that overwrites an existing link re-points
 * history. A pass that stamps ClickUp with the switch off writes to a live
 * workspace nobody authorised today. None of those crash — they just corrupt —
 * which is exactly what makes them test material.
 */
const assert = require('assert');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks += 1; };
const eq = (a, b, w) => { assert.strictEqual(a, b, `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); console.log('  ok  ', w); checks += 1; };

const link = require('../src/longterm/clickup/link');

const card = (id, ys, over) => Object.assign({ id, custom_id: 'FILLE-' + id, url: 'https://x/' + id, ys }, over || {});
const loan = (id, num, over) => Object.assign({ id, loan_number: num, clickup_task_id: null }, over || {});

(async () => {
  console.log('A. the key forgives typing noise, never digits');
  eq(link.ysKey(' yscap-2581.34237 '), 'YSCAP258134237', 'case, spaces and punctuation fold away');
  eq(link.ysKey('YSCAP258134237'), 'YSCAP258134237', 'a clean number is itself');
  eq(link.ysKey(''), null, 'blank is null, never an empty key that matches another blank');
  eq(link.ysKey(null), null, 'null too');

  console.log('\nB. the planner links exactly the certain case');
  {
    const { links, skipped } = link.planLinks(
      [loan('L1', 'YSCAP111'), loan('L2', 'YSCAP222')],
      [card('t1', 'yscap-111'), card('t2', 'YSCAP222')],
    );
    eq(links.length, 2, 'both loans link');
    eq(links[0].card.id, 't1', 'to the card carrying their number (via the key, not the raw string)');
    eq(skipped.length, 0, 'nothing refused');
  }

  console.log('\nC. every ambiguity is refused WITH its reason');
  {
    const { links, skipped } = link.planLinks(
      [loan('L1', 'YSCAP111'),                       // no card
       loan('L2', 'YSCAP222'), loan('L3', 'YSCAP222'), // duplicate Encompass records
       loan('L4', 'YSCAP333'),                       // two cards carry 333
       loan('L5', null)],                            // no number at all
      [card('t2', 'YSCAP222'), card('t3a', 'YSCAP333'), card('t3b', 'YSCAP333')],
    );
    eq(links.length, 0, 'not one guess among them');
    eq(skipped.length, 5, 'and every refusal is reported');
    ok(/no card carries/.test(skipped[0].reason), 'the gap says it is a gap');
    ok(/two Encompass records share/.test(skipped[1].reason), 'the duplicate-loan case names itself');
    ok(/two Encompass records share/.test(skipped[2].reason), 'for BOTH records, so neither silently wins');
    ok(/two or more cards carry this number \(FILLE-t3a, FILLE-t3b\)/.test(skipped[3].reason),
      'the duplicate-card case names BOTH cards for the person untangling it');
    ok(/no loan number/.test(skipped[4].reason), 'and a numberless loan is stated, not dropped');
  }

  console.log('\nD. an existing link is never touched — re-pointing is a person\'s job');
  {
    const { links, skipped } = link.planLinks(
      [loan('L1', 'YSCAP111', { clickup_task_id: 'tOLD' })],
      [card('tNEW', 'YSCAP111')],
    );
    eq(links.length, 0, 'the pass plans nothing for a linked loan');
    eq(skipped.length, 1, 'but the disagreement is VISIBLE');
    ok(/already linked to tOLD/.test(skipped[0].reason) && /tNEW/.test(skipped[0].reason),
      'naming both cards so a person can decide');
  }
  {
    const { skipped } = link.planLinks(
      [loan('L1', 'YSCAP111', { clickup_task_id: 't1' })],
      [card('t1', 'YSCAP111')],
    );
    eq(skipped.length, 0, 'a link that AGREES with the book is silence — nothing to report');
  }

  console.log('\nE. the ys field is read off the card\'s custom fields by id');
  {
    const { PIPELINE } = require('../src/clickup/fields');
    eq(link.cardYs({ custom_fields: [{ id: PIPELINE.ysLoanNumber, value: ' YSCAP9 ' }] }), 'YSCAP9', 'trimmed');
    eq(link.cardYs({ custom_fields: [{ id: 'other-field', value: 'YSCAP9' }] }), null, 'a value on the WRONG field is not a loan number');
    eq(link.cardYs({ custom_fields: [{ id: PIPELINE.ysLoanNumber, value: '' }] }), null, 'blank reads as none');
    eq(link.cardYs({}), null, 'no fields at all reads as none');
  }

  console.log('\nF. the whole pass: links write, refusals count, the stamp obeys ITS OWN switch');
  {
    const writes = []; const stamps = [];
    const deps = {
      db: { query: async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT id, loan_number/.test(sql)) {
          return { rows: [loan('L1', 'YSCAP111'), loan('L2', 'YSCAP222'), loan('L3', null)] };
        }
        return { rowCount: 1, rows: [] };
      } },
      client: { configured: () => true,
        pipelineTasksPage: async (page) => (page === 0
          ? { tasks: [ { id: 't1', custom_id: 'FILLE-1', url: 'u1', custom_fields: [{ id: require('../src/clickup/fields').PIPELINE.ysLoanNumber, value: 'YSCAP111' }] } ], last_page: true }
          : { tasks: [], last_page: true }) },
      stamp: { enabled: () => false, stampTask: async (a) => { stamps.push(a); return { ok: true, wrote: ['f1'] }; } },
    };
    const out = await link.linkPass(deps);
    eq(out.ok, true, 'the pass reports itself');
    eq(out.read, 1, 'one loan linked (the only certain one)');
    eq(out.skipped, 2, 'two refused — no card for L2, no number on L3');
    eq(stamps.length, 0, 'AND NOT ONE STAMP LEFT THE BUILDING — the stamp switch was off');
    const upd = writes.find((w) => /UPDATE lt_loans/.test(w.sql));
    ok(/clickup_task_id IS NULL/.test(upd.sql), 'the write itself re-checks "still unlinked" — a race cannot double-write');
    ok(/'confirmed'/.test(upd.sql) && /'reconciliation'/.test(upd.sql), 'written as confirmed, sourced as reconciliation');
    const log = writes.find((w) => /INSERT INTO lt_clickup_link_log/.test(w.sql));
    ok(!!log, 'and the trail row is written');
    eq(log.params[1], 't1', 'naming the card it went to');
  }

  console.log('\nG. with the stamp switch ON, each new link is stamped — the two-sided tie');
  {
    const stamps = [];
    const deps = {
      db: { query: async (sql) => (/SELECT id, loan_number/.test(sql)
        ? { rows: [loan('L1', 'YSCAP111')] } : { rowCount: 1, rows: [] }) },
      client: { configured: () => true,
        pipelineTasksPage: async () => ({ tasks: [ { id: 't1', custom_id: 'FILLE-1', url: 'u1', custom_fields: [{ id: require('../src/clickup/fields').PIPELINE.ysLoanNumber, value: 'YSCAP111' }] } ], last_page: true }) },
      stamp: { enabled: () => true, stampTask: async (a) => { stamps.push(a); return { ok: true, wrote: ['f1'] }; } },
    };
    const out = await link.linkPass(deps);
    eq(out.read, 1, 'the link lands');
    eq(stamps.length, 1, 'and exactly one stamp follows it');
    eq(stamps[0].taskId, 't1', 'onto that card');
    eq(stamps[0].ltLoanId, 'L1', 'carrying this loan\'s id — the RTL-style binding');
    eq(out.stamped, 1, 'and the pass reports it');
  }

  console.log('\nH. the pass\'s own switch and the missing-client refusal');
  {
    process.env.LT_CLICKUP_LINK_ENABLED = '0';
    const out = await link.linkPass({ db: { query: async () => { throw new Error('must not be called'); } },
      client: { configured: () => { throw new Error('must not be called'); } } });
    eq(out.ok, true, 'switched off is a clean no-op, not a failure');
    ok(/switched off/.test(out.reason), 'that says so');
    delete process.env.LT_CLICKUP_LINK_ENABLED;
    const out2 = await link.linkPass({ client: { configured: () => false } });
    eq(out2.ok, false, 'no ClickUp connection is a REAL refusal');
    ok(/not connected/.test(out2.reason), 'in words');
  }

  // ── I. THE STAMP CONVERGES: budget, retry, and the book's own record ──────
  // Four hundred stamps cannot land in one pass without tripping ClickUp's rate
  // limit, so the pass takes a bounded bite and the RETRY SWEEP finishes the rest
  // over later passes. That only works if every attempt is RECORDED — a stamp
  // that happened but was never written down gets re-sent forever, and one that
  // failed silently never gets retried at all. Both directions are proven here.
  console.log('\nI. the stamp budget, the retry sweep, and the record');
  process.env.LT_CLICKUP_STAMP_GAP_MS = '0';
  const FIELDS = require('../src/clickup/fields');
  const mkCard = (id, ys) => ({ id, custom_id: 'FILLE-' + id, url: 'u',
    custom_fields: [{ id: FIELDS.PIPELINE.ysLoanNumber, value: ys }] });
  {
    // Two linkable loans, budget of ONE: the second stamp waits for the next pass.
    process.env.LT_CLICKUP_STAMP_PER_PASS = '1';
    const stamps = []; const writes = [];
    const deps = {
      db: { query: async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT id, loan_number/.test(sql)) return { rows: [loan('L1', 'YSCAP111'), loan('L2', 'YSCAP222')] };
        if (/clickup_stamped_at IS NULL/.test(sql) && /SELECT/.test(sql)) return { rows: [] };
        return { rowCount: 1, rows: [] };
      } },
      client: { configured: () => true,
        pipelineTasksPage: async () => ({ tasks: [mkCard('t1', 'YSCAP111'), mkCard('t2', 'YSCAP222')], last_page: true }) },
      stamp: { enabled: () => true, stampTask: async (a) => { stamps.push(a); return { ok: true, wrote: ['f'] }; } },
    };
    const out = await link.linkPass(deps);
    eq(out.read, 2, 'both loans link — linking is never rationed');
    eq(stamps.length, 1, 'but only ONE stamp goes out: the budget is the rate-limit guard');
    eq(out.stamped, 1, 'and the pass says so');
    const rec = writes.filter((w) => /clickup_stamped_at = now\(\)/.test(w.sql));
    eq(rec.length, 1, 'the stamp that went out is RECORDED on the loan row');
    delete process.env.LT_CLICKUP_STAMP_PER_PASS;
  }
  {
    // The retry sweep: nothing new to link, one confirmed link still unstamped.
    const stamps = []; const writes = [];
    const deps = {
      db: { query: async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT id, loan_number/.test(sql)) return { rows: [] };
        if (/clickup_stamped_at IS NULL/.test(sql) && /SELECT/.test(sql)) {
          return { rows: [{ id: 'L9', clickup_task_id: 't9' }] };
        }
        return { rowCount: 1, rows: [] };
      } },
      client: { configured: () => true, pipelineTasksPage: async () => ({ tasks: [], last_page: true }) },
      stamp: { enabled: () => true, stampTask: async (a) => { stamps.push(a); return { ok: true, wrote: [], skipped: 'already_stamped' }; } },
    };
    const out = await link.linkPass(deps);
    eq(stamps.length, 1, 'the sweep picks up the link an earlier pass could not stamp');
    eq(stamps[0].taskId, 't9', 'and sends it to the recorded card');
    eq(out.stamped, 1, '"already stamped" IS stamped — the tie holds, however it got there');
    ok(writes.some((w) => /clickup_stamped_at = now\(\)/.test(w.sql)),
      'and is recorded, so it is never re-sent');
  }
  {
    // A failed stamp: the error is written where a person reads it, and it does
    // not count as stamped — which is exactly what keeps it in the sweep.
    const writes = [];
    const deps = {
      db: { query: async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT id, loan_number/.test(sql)) return { rows: [] };
        if (/clickup_stamped_at IS NULL/.test(sql) && /SELECT/.test(sql)) {
          return { rows: [{ id: 'L9', clickup_task_id: 't9' }] };
        }
        return { rowCount: 1, rows: [] };
      } },
      client: { configured: () => true, pipelineTasksPage: async () => ({ tasks: [], last_page: true }) },
      stamp: { enabled: () => true, stampTask: async () => ({ ok: false, wrote: [], reason: 'occupied', heldBy: 'someone-else' }) },
    };
    const out = await link.linkPass(deps);
    eq(out.stamped, 0, 'a refusal is not a stamp');
    eq(out.stampFailed, 1, 'it is a failure, counted as one');
    const err = writes.find((w) => /clickup_stamp_error = \$2/.test(w.sql));
    ok(!!err, 'the reason lands on the row');
    ok(/occupied/.test(err.params[1]) && /someone-else/.test(err.params[1]),
      'naming what refused AND who holds the card — the contradiction a person must untangle');
    ok(writes.some((w) => /stamp_failed/.test(w.sql)), 'and the trail records the attempt');
  }
  delete process.env.LT_CLICKUP_STAMP_GAP_MS;

  console.log(`\nall good — ${checks} checks`);
})().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
