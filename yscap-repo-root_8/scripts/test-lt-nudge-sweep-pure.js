'use strict';
/**
 * LONG-TERM — a doorbell that cannot say who is at the door.
 *
 * The tenant's advanced-code rule CAN post (their working drivekosher rule does
 * exactly that), but may not be able to NAME the loan. Rather than leave that
 * outcome depending on an untested field substitution, PILOT answers an unnamed
 * ring by asking Encompass which loans just moved.
 *
 * WHAT THIS PINS, because each is a way the feature could quietly go wrong:
 *   - it NUDGES ONLY WHAT MOVED — a loan Encompass has not touched since our
 *     copy is left to the rota, or one ping re-reads the whole book;
 *   - it NEVER GUESSES on an unreadable date, in either direction;
 *   - it CREATES NOTHING for a loan we have not mirrored (discovery owns
 *     creation, with its trash and duplicate guards);
 *   - it FAILS CLOSED when Encompass or the mirror cannot be read;
 *   - its ONLY write clears encompass_synced_at, so it can never write a loan
 *     value — the whole safety story for a path an outside system triggers.
 */
const assert = require('assert');
const fs = require('fs');
const sweep = require('../src/longterm/sync/nudge-sweep');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const row = (num, guid, mod) => ({ fields: { 'Loan.LoanNumber': num, 'Loan.GUID': guid, 'Loan.LastModified': mod } });
const mkClient = (rows) => ({ pipelineSearch: async () => rows });
function mkDb(mine, sink) {
  return { query: async (sql, params) => {
    if (/UPDATE lt_loans/.test(sql)) { sink.push(...(params[0] || [])); return { rows: [] }; }
    return { rows: mine };
  } };
}

async function main() {
  // ── 1. only what actually moved ──────────────────────────────────────────
  {
    const sink = [];
    const mine = [
      { id: 'a', loan_number: 'YSCAP1', encompass_loan_guid: 'g1', encompass_last_modified: '2026-08-01T00:00:00Z' },
      { id: 'b', loan_number: 'YSCAP2', encompass_loan_guid: 'g2', encompass_last_modified: '2026-08-20T00:00:00Z' },
    ];
    const r = await sweep.sweepRecentlyChanged({
      client: mkClient([row('YSCAP1', 'g1', '2026-08-24T00:00:00Z'), row('YSCAP2', 'g2', '2026-08-10T00:00:00Z')]),
      db: mkDb(mine, sink),
    });
    eq(r.ok, true, 'a readable answer succeeds');
    eq(r.nudged.length, 1, 'THE ONE THAT MATTERS: only the loan Encompass says is newer is nudged');
    eq(r.nudged[0].loanNumber, 'YSCAP1', '...and it is the right one');
    eq(r.unchanged, 1, 'the loan that has not moved is counted, not nudged');
    eq(sink.length, 1, 'exactly one id was written');
  }

  // ── 2. never guess on an unreadable date ─────────────────────────────────
  {
    const sink = [];
    const mine = [{ id: 'a', loan_number: 'YSCAP1', encompass_loan_guid: 'g1', encompass_last_modified: null }];
    const r = await sweep.sweepRecentlyChanged({
      client: mkClient([row('YSCAP1', 'g1', 'not-a-date')]), db: mkDb(mine, sink),
    });
    eq(r.nudged.length, 0, 'an unreadable date on either side nudges nothing');
    eq(sink.length, 0, '...and writes nothing');
  }

  // ── 3. an unmirrored loan is reported, never created ─────────────────────
  {
    const sink = [];
    const r = await sweep.sweepRecentlyChanged({
      client: mkClient([row('YSCAP9', 'g9', '2026-08-24T00:00:00Z')]), db: mkDb([], sink),
    });
    eq(r.unknown.length, 1, 'a loan we do not hold is REPORTED');
    eq(r.nudged.length, 0, '...and nothing is created for it here — discovery owns creation');
    eq(sink.length, 0, '...and nothing is written');
  }

  // ── 4. fails closed ──────────────────────────────────────────────────────
  {
    const sink = [];
    const r = await sweep.sweepRecentlyChanged({
      client: { pipelineSearch: async () => { throw new Error('Encompass unreachable'); } }, db: mkDb([], sink),
    });
    eq(r.ok, false, 'an unreadable Encompass fails CLOSED');
    eq(r.nudged.length, 0, '...nudging nothing');
    eq(sink.length, 0, '...and writing nothing');
    ok(/unreachable/i.test(r.reason), '...and says why');

    const r2 = await sweep.sweepRecentlyChanged({ client: null, db: mkDb([], sink) });
    eq(r2.ok, false, 'no Encompass connection at all also fails closed');
    eq(sink.length, 0, '...still writing nothing');
  }

  // ── 5. the ONLY write clears one column — the whole safety story ─────────
  {
    const src = fs.readFileSync(require.resolve('../src/longterm/sync/nudge-sweep'), 'utf8');
    // Strip comments first: the header NAMES these tables while explaining what
    // the module may not touch, and a guard that read its own explanation would
    // fail on the very text that documents it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const writes = code.match(/\b(UPDATE|INSERT INTO|DELETE FROM)\b/gi) || [];
    eq(writes.length, 1, 'THE ONE THAT MATTERS: exactly one write statement exists in the module');
    ok(/UPDATE lt_loans\s+SET encompass_synced_at\s*=\s*NULL/.test(code),
      '...and it clears the sync stamp — which IS the nudge: the sync drain re-reads the loan on its next pass');

    // WHAT THAT ONE STATEMENT MAY TOUCH, enumerated. This used to pin the exact
    // text of the statement, which broke the moment db/629 added the three
    // `encompass_nudge*` columns beside it — bookkeeping about the SYNC, not a
    // value of the LOAN, so the safety property never moved. Pinning the text
    // could only ever answer "did anybody edit this line"; pinning the COLUMN SET
    // answers the question the section is actually about, and it is strictly
    // stricter: a loan value added here fails whether or not the old line survives.
    const setBlock = (code.match(/UPDATE lt_loans[\s\S]*?WHERE/i) || [''])[0];
    const targets = (setBlock.match(/^\s*([a-z_]+)\s*=/gim) || [])
      .map((m) => m.trim().replace(/\s*=$/, ''));
    const ALLOWED = new Set(['SET encompass_synced_at', 'encompass_synced_at',
      'encompass_nudged_at', 'encompass_nudged_via', 'encompass_nudge_count', 'updated_at']);
    const stray = targets.filter((t) => !ALLOWED.has(t) && !ALLOWED.has(t.replace(/^SET\s+/, '')));
    eq(stray.join(',') , '',
      '...and it writes ONLY the sync stamp and the nudge bookkeeping — never a value of the loan itself');
    ok(targets.length >= 2, '...(and the column set was actually parsed, so an empty match cannot pass this)');

    ok(!/lt_loan_milestones|lt_parties|lt_properties|lt_loan_investors/.test(code),
      '...and it names no loan-value table at all');
  }

  console.log(`✓ lt nudge sweep (pure): ${n} assertions passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
