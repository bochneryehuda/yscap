#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the cutover DECISION LEDGER's durable bridge (`ppe/cutover-store.js`, db/566).
 *
 * Pure: an in-memory `lt_ppe_cutover_ledger` stands in for Postgres, so the append/read round-trip,
 * the append-only guarantee and the concurrency guard are all exercised with no DATABASE_URL. The
 * stub enforces the table's UNIQUE (scope, investor, seq) for real, because that constraint is not
 * decoration — it is the entire mechanism that makes a simultaneous second decision safe, and a stub
 * that ignored it would prove the opposite of what this file claims.
 *
 * What is guarded here, each of which is a way the governance story could be broken from above:
 *
 *   • THE LEDGER DECIDES NOTHING. Legality is cutover.transition's, reached through
 *     cutover-ledger.applyDecision. A rule re-implemented in SQL or in this bridge would drift, and
 *     the copy that drifts is the one that eventually says "yes, go live" when the rule says no.
 *   • PROMOTION IS GATED ON MEASURED ELIGIBILITY, and a refusal writes NOTHING. An investor may not
 *     reach `live` because somebody asked twice.
 *   • APPEND-ONLY. One INSERT, no UPDATE, no DELETE, no upsert — asserted against the source as well
 *     as against behaviour, since "we never wrote an UPDATE" is a property of the file.
 *   • THE RACE IS REFUSED, NOT ABSORBED. Two decisions computing the same seq must not both land and
 *     must not silently overwrite each other; the loser is told to re-read.
 *   • A TAMPERED HISTORY IS DETECTED. validateHistory replays from DRAFT rather than trusting the
 *     rows, so a hand-edited or partially-restored ledger is caught instead of believed.
 *   • THE MODE SURVIVES A RESTART, which is the whole point of the table.
 *
 * LT-only. No RTL imports.
 */

const store = require('../src/longterm/ppe/cutover-store');
const cutover = require('../src/longterm/ppe/cutover');
const cutoverLedger = require('../src/longterm/ppe/cutover-ledger');

let failures = 0;
function ok(c, l) { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; }

// ---------------------------------------------------------------------------
// an in-memory lt_ppe_cutover_ledger that HONOURS the unique key
// ---------------------------------------------------------------------------
function mkDb() {
  const rows = [];
  const db = { rows, writes: [], statements: [] };
  db.query = async (text, params) => {
    db.statements.push(text);
    if (/^\s*INSERT INTO lt_ppe_cutover_ledger/.test(text)) {
      const [scope, investor, seq, action, fromMode, toMode, by, atMs, reason, eligible, scoreboard] = params;
      // the real constraint: UNIQUE (scope, investor, seq)
      if (rows.some((r) => r.scope === scope && r.investor === investor && Number(r.seq) === Number(seq))) {
        const e = new Error('duplicate key value violates unique constraint "lt_ppe_cutover_ledger_seq_uk"');
        e.code = '23505';
        throw e;
      }
      const row = {
        scope, investor, seq, action, from_mode: fromMode, to_mode: toMode,
        decided_by: by, decided_at: String(atMs), reason, eligible,
        scoreboard: scoreboard == null ? null : JSON.parse(scoreboard),
      };
      rows.push(row);
      db.writes.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM lt_ppe_cutover_ledger/.test(text)) {
      const [scope, investor] = params;
      return {
        rows: rows.filter((r) => r.scope === scope && r.investor === investor)
          .slice().sort((a, b) => Number(a.seq) - Number(b.seq)),
      };
    }
    return { rows: [], rowCount: 0 };
  };
  return db;
}

const SCOPE = 'company';
const OPTS = (db, extra) => ({ db, investor: 'ACME', ...(extra || {}) });
const DAY = cutover.DAY_MS;
const T0 = 1755300000000;

(async () => {
  console.log('LT PPE — the cutover decision ledger, durably');

  // -------------------------------------------------------------------------
  // 1) a brand-new investor is DRAFT, from an empty table
  // -------------------------------------------------------------------------
  {
    const db = mkDb();
    ok(await store.currentMode(SCOPE, OPTS(db)) === cutover.MODES.DRAFT,
      'LED-1 an investor with no recorded decisions is DRAFT (the birth state, not an error)');
    ok((await store.listHistory(SCOPE, OPTS(db))).length === 0, 'LED-2 …with an empty history');
    const v = await store.verifyHistory(SCOPE, OPTS(db));
    ok(v.ok === true && v.mode === cutover.MODES.DRAFT, 'LED-3 …which replays as valid, not as broken');
  }

  // -------------------------------------------------------------------------
  // 2) the lifecycle, persisted — and the mode SURVIVES A RESTART
  // -------------------------------------------------------------------------
  {
    const db = mkDb();
    let r = await store.appendDecision(SCOPE, {
      action: 'activate', by: 'yehuda', atMs: T0, reason: 'begin shadowing this investor',
    }, OPTS(db));
    ok(r.ok === true && r.entry.seq === 1 && r.entry.from === 'draft' && r.entry.to === 'shadow',
      'LED-4 activate is recorded as step 1, draft → shadow');
    ok(await store.currentMode(SCOPE, OPTS(db)) === cutover.MODES.SHADOW,
      'LED-5 …and the investor is now in shadow ACCORDING TO THE TABLE (this is what a restart reads)');

    // PROMOTION IS GATED. Asking without measured eligibility must write nothing at all.
    const before = db.rows.length;
    r = await store.appendDecision(SCOPE, {
      action: 'promote', by: 'yehuda', atMs: T0 + DAY, reason: 'looks good to me',
    }, OPTS(db));
    ok(r.ok === false && /not eligible/.test(r.error || ''),
      'LED-6 promote without a passing scoreboard gate is REFUSED, in the rule\'s own words');
    ok(db.rows.length === before,
      'LED-7 …and NOTHING is written — an investor can never reach live by being asked twice');
    ok(await store.currentMode(SCOPE, OPTS(db)) === cutover.MODES.SHADOW,
      'LED-8 …the mode is unmoved');

    // with the gate genuinely passed
    r = await store.appendDecision(SCOPE, {
      action: 'promote', by: 'yehuda', atMs: T0 + (14 * DAY), reason: '14 clean days, 100% agreement',
      eligible: true, scoreboard: { canaryAgreementRate: 1, openFindings: 0 },
    }, OPTS(db));
    ok(r.ok === true && r.entry.to === 'live', 'LED-9 promote with the gate passed goes live');
    ok(db.rows[1].eligible === true, 'LED-10 …and the ledger records that the gate HAD passed');
    ok(db.rows[1].scoreboard && db.rows[1].scoreboard.canaryAgreementRate === 1,
      'LED-11 …with the scoreboard it was decided on, verbatim — those numbers will not still be true tomorrow');

    // rollback is always allowed — it is the safety move
    r = await store.appendDecision(SCOPE, {
      action: 'rollback', by: 'yehuda', atMs: T0 + (15 * DAY), reason: 'a price disagreement turned up on a real quote',
    }, OPTS(db));
    ok(r.ok === true && r.entry.to === 'shadow' && r.entry.seq === 3,
      'LED-12 rollback needs no eligibility — pulling back to safety is never gated');

    const h = await store.listHistory(SCOPE, OPTS(db));
    ok(h.length === 3 && h[0].seq === 1 && h[2].seq === 3, 'LED-13 the history reads back oldest-first');
    ok(h[0].by === 'yehuda' && h[0].reason === 'begin shadowing this investor' && h[0].atMs === T0,
      'LED-14 …carrying WHO decided, WHY and WHEN — the three questions this table exists to answer');
    const v = await store.verifyHistory(SCOPE, OPTS(db));
    ok(v.ok === true && v.mode === cutover.MODES.SHADOW, 'LED-15 …and it replays cleanly from DRAFT');
  }

  // -------------------------------------------------------------------------
  // 3) THE RACE. Two admins deciding at the same instant — the loser is TOLD,
  //    never silently dropped and never allowed to overwrite the winner.
  // -------------------------------------------------------------------------
  {
    const db = mkDb();
    await store.appendDecision(SCOPE, { action: 'activate', by: 'a', atMs: T0, reason: 'start shadowing' }, OPTS(db));

    // both read the same history, so both compute seq 2
    const [x, y] = await Promise.all([
      store.appendDecision(SCOPE, { action: 'retire', by: 'a', atMs: T0 + 1, reason: 'this investor is done with us' }, OPTS(db)),
      store.appendDecision(SCOPE, { action: 'retire', by: 'b', atMs: T0 + 1, reason: 'duplicate decision at the same moment' }, OPTS(db)),
    ]);
    const winners = [x, y].filter((r) => r.ok);
    const losers = [x, y].filter((r) => !r.ok);
    ok(winners.length === 1 && losers.length === 1,
      'LED-16 exactly ONE of two simultaneous decisions lands');
    ok(losers[0].conflict === true && /re-read/i.test(losers[0].error || ''),
      'LED-17 …and the loser is told to re-read and try again — never a silent drop');
    ok(db.rows.filter((r) => Number(r.seq) === 2).length === 1,
      'LED-18 …so the ledger holds exactly one step 2 (two contradictory decisions can never both claim it)');
    const v = await store.verifyHistory(SCOPE, OPTS(db));
    ok(v.ok === true, 'LED-19 …and the surviving history is still internally consistent');
  }

  // -------------------------------------------------------------------------
  // 4) APPEND-ONLY, asserted as a property of the file, not only of a run
  // -------------------------------------------------------------------------
  {
    const src = require('fs').readFileSync(require.resolve('../src/longterm/ppe/cutover-store.js'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(!/UPDATE\s+lt_ppe_cutover_ledger/i.test(src), 'LED-20 the bridge contains no UPDATE of the ledger');
    ok(!/DELETE\s+FROM\s+lt_ppe_cutover_ledger/i.test(src), 'LED-21 …no DELETE');
    ok(!/ON\s+CONFLICT/i.test(src), 'LED-22 …and no upsert — a correction is a NEW decision, never a rewrite');
    ok((src.match(/INSERT INTO lt_ppe_cutover_ledger/g) || []).length === 1,
      'LED-23 …exactly one write path exists');

    // and the migration must not have quietly dropped the guard that makes the race safe
    const sql = require('fs').readFileSync(require.resolve('../db/566_lt_ppe_cutover_ledger.sql'), 'utf8');
    ok(/UNIQUE \(scope, investor, seq\)/.test(sql),
      'LED-24 the table still carries UNIQUE (scope, investor, seq) — that constraint IS the concurrency guard');
    ok(/investor\s+TEXT NOT NULL DEFAULT ''/.test(sql),
      'LED-25 …and investor is NOT NULL DEFAULT \'\' — a NULL in a unique key would let two lifecycles interleave undetected');
  }

  // -------------------------------------------------------------------------
  // 5) A TAMPERED LEDGER IS DETECTED, not trusted
  // -------------------------------------------------------------------------
  {
    const db = mkDb();
    await store.appendDecision(SCOPE, { action: 'activate', by: 'a', atMs: T0, reason: 'start shadowing' }, OPTS(db));
    // somebody edits the row to claim the investor went live, skipping the gate entirely
    db.rows[0].to_mode = 'live';
    const v = await store.verifyHistory(SCOPE, OPTS(db));
    ok(v.ok === false && v.brokenAt === 1,
      'LED-26 a row edited to claim an ungated jump to live FAILS the replay, naming the step');
    ok(/leads to/.test(v.error || ''), 'LED-27 …and says what the rule would actually have produced');

    // a missing middle step is caught too — the from/to chain no longer joins up
    const db2 = mkDb();
    await store.appendDecision(SCOPE, { action: 'activate', by: 'a', atMs: T0, reason: 'start shadowing' }, OPTS(db2));
    await store.appendDecision(SCOPE, {
      action: 'promote', by: 'a', atMs: T0 + DAY, reason: 'gate passed cleanly', eligible: true,
    }, OPTS(db2));
    db2.rows.splice(0, 1); // the activate is lost in a partial restore
    const v2 = await store.verifyHistory(SCOPE, OPTS(db2));
    ok(v2.ok === false,
      'LED-28 a partially-restored ledger whose first step is missing is DETECTED, not believed');
  }

  // -------------------------------------------------------------------------
  // 6) the summary a screen reads — and it never re-derives what the module owns
  // -------------------------------------------------------------------------
  {
    const db = mkDb();
    await store.appendDecision(SCOPE, { action: 'activate', by: 'a', atMs: T0, reason: 'start shadowing' }, OPTS(db));
    await store.appendDecision(SCOPE, {
      action: 'promote', by: 'a', atMs: T0 + DAY, reason: 'gate passed cleanly', eligible: true,
    }, OPTS(db));

    const nowMs = T0 + (4 * DAY);
    const s = await store.loadSummary(SCOPE, OPTS(db, { nowMs }));
    ok(s.mode === 'live' && s.decisions === 2, 'LED-29 the summary reports the mode and how many decisions produced it');
    ok(s.liveSince === T0 + DAY, 'LED-30 …when it went live');
    ok(s.daysInMode === 3, 'LED-31 …and how long it has been there (clock injected, so this is testable at all)');
    ok(s.valid === true, 'LED-32 …plus whether the history it read replays cleanly');
    ok(Array.isArray(s.history) && s.history.length === 2, 'LED-33 …and hands back the history it was computed from');

    // the bridge must not have grown its own copy of the summary
    const direct = cutoverLedger.summarize(await store.listHistory(SCOPE, OPTS(db)), { nowMs });
    ok(direct.mode === s.mode && direct.liveSince === s.liveSince && direct.daysInMode === s.daysInMode,
      'LED-34 …identical to calling cutover-ledger.summarize directly — the bridge adds no second definition');
  }

  // -------------------------------------------------------------------------
  // 7) SCOPING. One investor's lifecycle is not another's, and a company-wide
  //    lifecycle is a real, separate one rather than a NULL hole.
  // -------------------------------------------------------------------------
  {
    const db = mkDb();
    await store.appendDecision(SCOPE, { action: 'activate', by: 'a', atMs: T0, reason: 'start shadowing acme' }, { db, investor: 'ACME' });
    ok(await store.currentMode(SCOPE, { db, investor: 'OTHER' }) === cutover.MODES.DRAFT,
      'LED-35 a different investor is untouched by the first one\'s decisions');
    ok(await store.currentMode(SCOPE, { db, investor: null }) === cutover.MODES.DRAFT,
      'LED-36 …and so is the company-wide lifecycle');

    await store.appendDecision(SCOPE, { action: 'activate', by: 'a', atMs: T0, reason: 'company-wide shadow' }, { db, investor: null });
    ok(db.rows.some((r) => r.investor === ''),
      'LED-37 a null investor is stored as \'\', not NULL — which is what keeps its unique key working');
    ok(await store.currentMode(SCOPE, { db, investor: null }) === cutover.MODES.SHADOW
      && await store.currentMode(SCOPE, { db, investor: 'ACME' }) === cutover.MODES.SHADOW,
      'LED-38 …and the two lifecycles advance independently');
    ok(await store.currentMode('other-tenant', { db, investor: 'ACME' }) === cutover.MODES.DRAFT,
      'LED-39 another TENANT sees none of it (multi-tenant scoping holds)');
  }

  // -------------------------------------------------------------------------
  // 8) refusals that are the ledger's own — recorded here so the bridge can
  //    never start answering them itself
  // -------------------------------------------------------------------------
  {
    const db = mkDb();
    for (const [d, why] of [
      [{ action: 'activate', atMs: T0, reason: 'no decider named' }, 'who made it'],
      [{ action: 'activate', by: 'a', atMs: T0 }, 'a reason'],
      [{ action: 'activate', by: 'a', reason: 'no clock supplied' }, 'a time'],
      [{ by: 'a', atMs: T0, reason: 'no action given' }, 'an action'],
      [{ action: 'banana', by: 'a', atMs: T0, reason: 'not a real action' }, 'unknown action'],
      [{ action: 'promote', by: 'a', atMs: T0, reason: 'cannot promote a draft', eligible: true }, 'cannot promote'],
    ]) {
      const r = await store.appendDecision(SCOPE, d, OPTS(db));
      ok(r.ok === false && new RegExp(why, 'i').test(r.error || ''),
        `LED-40 refused (${why}): ${r.error}`);
    }
    ok(db.rows.length === 0, 'LED-41 …and not one of those refusals wrote a row');
  }

  console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
