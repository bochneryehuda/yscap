#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the ≥200-scenario Lender Price AGREEMENT gate (db/576), and the publish that now honours it.
 *
 * THE DEFECT THIS CLOSES. The owner's HARD RULE is that a rate sheet agrees with Lender Price — every
 * LLPA, every eligibility and ineligibility, the max and min price, to the penny, over ~200 scenarios —
 * BEFORE it is trusted. `ratesheet-agreement.js` measures exactly that and returns `summary.gateMet`.
 * Nothing ever kept the answer, and `publishRateSheetVersion` — the moment a sheet becomes the one
 * every quote prices from — never asked. The rule was written down in three places and enforced in
 * none: any sheet could be published, and priced from, with not one scenario ever compared.
 *
 * WHAT THESE GUARD, in the order they matter:
 *   • publishing refuses an unproven sheet, and the refusal names WHICH of the four states it is;
 *   • the four states are never collapsed — "nobody measured it", "it disagrees", "it agreed on nine
 *     scenarios" and "we could not read the record" send a reader to four different places;
 *   • it FAILS CLOSED: an unreadable ledger is not a pass;
 *   • the override exists so the gate is never a dead end, requires a real reason and an author, is
 *     RECORDED, and — the part that is easy to get wrong — does not publish when the recording fails,
 *     because the record IS the authorization;
 *   • an override is never counted as proof of agreement afterwards.
 *
 * Pure + a recording stub db. No network, no Postgres.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const A = require('../src/longterm/ppe/agreement-store');
const store = require('../src/longterm/ppe/store');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

function stubDb(onQuery) {
  const calls = [];
  const api = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (onQuery) return onQuery(sql, params);
      return { rows: [] };
    },
  };
  // publishRateSheetVersionUnchecked opens a transaction; a stub client records the same way.
  api.getClient = async () => ({
    query: api.query,
    release() {},
  });
  return api;
}

const DAY = 24 * 60 * 60 * 1000;
const runRow = (over) => Object.assign({
  id: 'a1', rate_sheet_version_id: 'v1', kind: 'run', gate_met: true,
  scenarios: '240', comparable: '240', agreed: '240', disagreed: '0', errors: '0',
  summary: { gateMet: true }, reason: null, recorded_by: 'someone@ys', recorded_at: String(1_700_000_000_000),
}, over);

async function main() {
  // =========================================================================
  // A. THE DECISION — pure, and the one definition
  // =========================================================================
  {
    const d = A.gateDecision([]);
    eq(d.proven, false, 'A1 a sheet nobody has measured is NOT proven');
    eq(d.reason, 'never_measured', 'A2 …and says so in its own words');
    ok(/never been measured/.test(d.message), 'A3 …which is what sends somebody to RUN the battery');
  }
  {
    const proven = A.gateDecision([A.rowToCell ? null : null].slice(0, 0).concat([A.rowToRecord(runRow({}))]));
    eq(proven.proven, true, 'A4 a passing run over enough scenarios is proven');
    ok(/all 240/.test(proven.message), 'A5 …and the message says what was actually compared');
  }
  {
    // A PASSING run is not automatically enough. `gateMet` is `errors === 0 && disagreed === 0 &&
    // comparable > 0`, so THREE scenarios satisfy it — true, and not the owner's rule. The scale test
    // belongs to trusting a sheet, not to measuring one.
    const thin = A.gateDecision([A.rowToRecord(runRow({ scenarios: '9', comparable: '9', agreed: '9' }))]);
    eq(thin.proven, false, 'A6 a clean run over nine scenarios does NOT prove a sheet');
    eq(thin.reason, 'too_few_scenarios', 'A7 …and that is its own reason, not "it disagrees"');
    ok(new RegExp(String(A.MIN_COMPARABLE_SCENARIOS)).test(thin.message), 'A8 …naming the number the gate asks for');
  }
  {
    const bad = A.gateDecision([A.rowToRecord(runRow({ gate_met: false, disagreed: '7', errors: '2' }))]);
    eq(bad.proven, false, 'A9 a failing run is not proven');
    eq(bad.reason, 'disagrees', 'A10 …and "it disagrees" is a different answer from "nobody measured it"');
    ok(/7 disagreement/.test(bad.message) && /2 error/.test(bad.message), 'A11 …carrying what was found');
  }
  {
    // THE LATEST WORD WINS. Taking "has it ever passed?" would make every regression after a reprice
    // invisible for the life of the version.
    const records = [
      A.rowToRecord(runRow({ id: 'old', recorded_at: String(1_700_000_000_000) })),
      A.rowToRecord(runRow({ id: 'new', gate_met: false, disagreed: '3', recorded_at: String(1_700_000_000_000 + DAY) })),
    ];
    const d = A.gateDecision(records);
    eq(d.proven, false, 'A12 a sheet that passed and then failed is not proven');
    eq(d.run.id, 'new', 'A13 …the LATEST run is the one that answers');
    // …and the order it is handed in must not matter.
    eq(A.gateDecision(records.slice().reverse()).run.id, 'new', 'A14 …whichever order the rows arrive in');
  }
  {
    const over = A.gateDecision([A.rowToRecord(runRow({ kind: 'override', gate_met: null, reason: 'live LP credentials are not in yet' }))]);
    eq(over.proven, false, 'A15 an OVERRIDE never becomes proof of agreement');
    eq(over.reason, 'overridden', 'A16 …it is reported as what it is');
    ok(/credentials/.test(over.message), 'A17 …carrying the reason somebody typed');
  }

  // =========================================================================
  // B. FAILS CLOSED — an unreadable record is not a pass
  // =========================================================================
  {
    const db = stubDb(() => { throw new Error('relation does not exist'); });
    const g = await A.gateStatus('company', 'v1', { db });
    eq(g.proven, false, 'B1 an unreadable agreement record is NOT proven');
    eq(g.reason, 'unreadable', 'B2 …and is its OWN reason — "we could not check" is not "nobody checked"');
  }
  {
    const g = await A.gateStatus('company', null, { db: stubDb() });
    eq(g.proven, false, 'B3 no version named → not proven');
    eq(g.reason, 'no_version', 'B4 …with the reason');
  }

  // =========================================================================
  // C. THE WRITES
  // =========================================================================
  {
    const db = stubDb(() => ({ rows: [runRow({})] }));
    const out = await A.recordRun('company', {
      db, versionId: 'v1', recordedBy: 'me@ys', nowMs: 1,
      summary: { gateMet: true, scenarios: 240, comparable: 240, agreed: 240, disagreed: 0, errors: 0, byDimension: { fico: 0 } },
    });
    eq(out.ok, true, 'C1 a run records');
    ok(/INSERT INTO lt_ppe_ratesheet_agreement/.test(db.calls[0].sql), 'C2 …into the agreement ledger');
    ok(db.calls[0].params.includes('run'), 'C3 …as a run');
    // The whole summary is stored so a verdict is re-readable in detail without re-running a battery
    // against a vendor that has since repriced.
    const summaryParam = db.calls[0].params.find((p) => typeof p === 'string' && /byDimension/.test(p));
    ok(!!summaryParam, 'C4 …with the harness summary stored verbatim');
    ok(!/UPDATE lt_ppe_ratesheet_agreement/.test(db.calls[0].sql), 'C5 the ledger is append-only — evidence is not edited');
  }
  {
    const db = stubDb(() => ({ rows: [runRow({ kind: 'override', gate_met: null })] }));
    let out = await A.recordOverride('company', { db, versionId: 'v1', recordedBy: 'me@ys', reason: 'no', nowMs: 1 });
    eq(out.ok, false, 'C6 "no" is not a reason');
    eq(out.reason, 'no_reason', 'C7 …refused as such');
    out = await A.recordOverride('company', { db, versionId: 'v1', reason: 'credentials are not in yet', nowMs: 1 });
    eq(out.ok, false, 'C8 an anonymous override is refused — the one question later is WHO decided');
    out = await A.recordOverride('company', { db, versionId: 'v1', recordedBy: 'me@ys', reason: 'credentials are not in yet', nowMs: 1 });
    eq(out.ok, true, 'C9 a named override with a real reason records');
    const params = db.calls[db.calls.length - 1].params;
    ok(params.includes('override') && params.includes('me@ys'), 'C10 …carrying who and what kind');
    // gate_met stays NULL: an override is not a measurement, and `false` would claim the sheet was
    // measured and failed — a different, more damning statement than "nobody has measured it".
    ok(/gate_met/.test(db.calls[db.calls.length - 1].sql) && /NULL/.test(db.calls[db.calls.length - 1].sql),
      'C11 …and records NO verdict, because an override measured nothing');
  }

  // =========================================================================
  // D. PUBLISHING NOW HONOURS IT — the enforcement point
  // =========================================================================
  {
    // Nothing recorded → refused, and NOTHING is written.
    const db = stubDb((sql) => (/FROM lt_ppe_ratesheet_agreement/.test(sql) ? { rows: [] } : { rows: [] }));
    const out = await store.publishRateSheetVersion(db, 'company', 'v1');
    ok(out && out.refused, 'D1 an unmeasured sheet is REFUSED at publish');
    eq(out.refused.reason, 'never_measured', 'D2 …naming which of the four states it is');
    ok(!db.calls.some((c) => /UPDATE lt_ppe_rate_sheet_version/.test(c.sql)),
      'D3 …and no version row is touched — a refused publish publishes nothing');
    ok(!db.calls.some((c) => /BEGIN/.test(c.sql)), 'D4 …with no transaction left hanging');
  }
  {
    // A PROVEN sheet publishes exactly as before.
    const db = stubDb((sql) => {
      if (/FROM lt_ppe_ratesheet_agreement/.test(sql)) return { rows: [runRow({})] };
      if (/SELECT program_id, channel/.test(sql)) return { rows: [{ program_id: 'p1', channel: 'correspondent' }] };
      if (/UPDATE lt_ppe_rate_sheet_version/.test(sql)) return { rows: [{ id: 'v1', status: 'published' }] };
      return { rows: [] };
    });
    const out = await store.publishRateSheetVersion(db, 'company', 'v1');
    ok(out && !out.refused && out.id === 'v1', 'D5 a PROVEN sheet publishes');
    ok(db.calls.some((c) => /BEGIN/.test(c.sql)) && db.calls.some((c) => /COMMIT/.test(c.sql)),
      'D6 …in one transaction, exactly as before');
  }
  {
    // THE OVERRIDE PATH: it publishes, and it records first.
    const db = stubDb((sql) => {
      if (/FROM lt_ppe_ratesheet_agreement/.test(sql)) return { rows: [] };
      if (/INSERT INTO lt_ppe_ratesheet_agreement/.test(sql)) return { rows: [runRow({ kind: 'override', gate_met: null })] };
      if (/SELECT program_id, channel/.test(sql)) return { rows: [{ program_id: 'p1', channel: 'correspondent' }] };
      if (/UPDATE lt_ppe_rate_sheet_version/.test(sql)) return { rows: [{ id: 'v1', status: 'published' }] };
      return { rows: [] };
    });
    const out = await store.publishRateSheetVersion(db, 'company', 'v1', {
      override: true, overrideBy: 'admin@ys', overrideReason: 'Lender Price credentials are not live yet', nowMs: 1,
    });
    ok(out && !out.refused && out.id === 'v1', 'D7 a deliberate override publishes — the gate is never a dead end');
    const insertAt = db.calls.findIndex((c) => /INSERT INTO lt_ppe_ratesheet_agreement/.test(c.sql));
    const beginAt = db.calls.findIndex((c) => /BEGIN/.test(c.sql));
    ok(insertAt >= 0, 'D8 …and it is RECORDED');
    ok(insertAt < beginAt, 'D9 …before the publish, so an unrecordable override cannot half-publish');
  }
  {
    // An override with no reason is refused and publishes NOTHING — the reason is not paperwork, it is
    // the authorization.
    const db = stubDb((sql) => (/FROM lt_ppe_ratesheet_agreement/.test(sql) ? { rows: [] } : { rows: [] }));
    const out = await store.publishRateSheetVersion(db, 'company', 'v1', { override: true, overrideBy: 'admin@ys' });
    ok(out && out.refused && out.refused.reason === 'no_reason', 'D10 an override with no reason is refused');
    ok(!db.calls.some((c) => /UPDATE lt_ppe_rate_sheet_version/.test(c.sql)), 'D11 …and nothing is published');
  }
  {
    // AN OVERRIDE THAT COULD NOT BE RECORDED DOES NOT PUBLISH. The record IS the authorization, so a
    // publish here would be the exact silent unmeasured promotion the gate exists to prevent, with
    // nothing anywhere saying it happened.
    const db = stubDb((sql) => {
      if (/INSERT INTO lt_ppe_ratesheet_agreement/.test(sql)) throw new Error('ledger write failed');
      return { rows: [] };
    });
    let threw = null;
    let out = null;
    try {
      out = await store.publishRateSheetVersion(db, 'company', 'v1', {
        override: true, overrideBy: 'admin@ys', overrideReason: 'credentials are not live yet', nowMs: 1,
      });
    } catch (e) { threw = e; }
    ok(threw || (out && out.refused), 'D12 an unrecordable override does not quietly publish');
    ok(!db.calls.some((c) => /UPDATE lt_ppe_rate_sheet_version/.test(c.sql)), 'D13 …and no version row is touched');
  }
  {
    // A sheet that DISAGREES is refused with its own reason, so nobody is sent to run a battery that
    // has already been run and failed.
    const db = stubDb((sql) => (/FROM lt_ppe_ratesheet_agreement/.test(sql)
      ? { rows: [runRow({ gate_met: false, disagreed: '4' })] } : { rows: [] }));
    const out = await store.publishRateSheetVersion(db, 'company', 'v1');
    eq(out.refused.reason, 'disagrees', 'D14 a measured, disagreeing sheet is refused as disagreeing');
  }

  // =========================================================================
  // E. THE COLUMNS ARE REAL, AND THE GATE IS WIRED
  // =========================================================================
  {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'db', '576_lt_ppe_ratesheet_agreement_gate.sql'), 'utf8')
      .replace(/^\s*--.*$/gm, '');
    for (const col of ['scope', 'rate_sheet_version_id', 'kind', 'gate_met', 'scenarios', 'comparable',
      'agreed', 'disagreed', 'errors', 'summary', 'reason', 'recorded_by', 'recorded_at']) {
      ok(new RegExp(`\\b${col}\\b`).test(mig), `E1 the migration declares ${col}`);
    }
    ok(/CREATE TABLE IF NOT EXISTS lt_ppe_ratesheet_agreement/.test(mig), 'E2 idempotent create');
    ok(/kind IN \('run','override'\)/.test(mig), 'E3 …with the two kinds constrained');
    ok(/REFERENCES lt_ppe_rate_sheet_version\(id\) ON DELETE CASCADE/.test(mig),
      'E4 …tied to the version it is evidence about');
    ok(!/UPDATE lt_ppe_ratesheet_agreement/.test(mig),
      'E5 there is NO backfill — marking existing sheets proven would invent the evidence this table exists to require');

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'store.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // AWAITED and READ, not merely mentioned: a gate whose result is discarded is not a gate, and the
    // function's name would still appear in the file.
    ok(/const gate = await agreementStore\.gateStatus\(/.test(src), 'E6 publish ASKS the gate');
    ok(/if \(!gate\.proven\)/.test(src), 'E7 …and acts on the answer');
    ok(/await agreementStore\.recordOverride\(/.test(src), 'E8 …recording an override when one is used');
    ok(/if \(!rec\.ok\) return \{ refused/.test(src), 'E9 …and refusing when that record could not be written');
  }

  console.log(`ok - lt ppe ratesheet agreement gate (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
