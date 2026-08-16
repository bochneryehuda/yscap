'use strict';

// =============================================================================
// LT test — the Encompass milestone / status catalog (db/547 + src/longterm).
//
// This is a Long-Term test (scripts/test-lt-*.js), so it may import LT code. It is
// DB-gated: it skips cleanly when no DATABASE_URL is set. It is self-contained — it
// applies db/547 idempotently, so it does not depend on migrate-boot having run.
// =============================================================================

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-encompass-milestones (no DATABASE_URL)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../src/longterm/db');
const catalog = require('../src/longterm/lib/encompass-milestones');
const lt = require('../src/longterm');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function applyMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '547_lt_encompass_milestones.sql'), 'utf8');
  // Run twice to prove the migration is idempotent (re-run safe on every boot).
  await db.query(sql);
  await db.query(sql);
}

(async () => {
  console.log('LT — Encompass milestone catalog');

  await applyMigration();

  // ---- the table + seed ----------------------------------------------------
  const count = await catalog.countMilestones();
  check('catalog has exactly 19 milestones', count === 19, `got ${count}`);

  const all = await catalog.listMilestones();
  check('list returns 19 rows', all.length === 19, `got ${all.length}`);
  check('rows are ordered by sequence',
    all.every((m, i) => m.sequence === i + 1), JSON.stringify(all.map((m) => m.sequence)));

  // ---- spot-check the boundaries + every column shape ----------------------
  const started = all[0];
  check('first is "Started" (id 1, no role, sequence 1)',
    started.milestoneId === '1' && started.milestoneName === 'Started' &&
    started.role === null && started.roleId === null && started.sequence === 1,
    JSON.stringify(started));
  check('Started TPO + consumer status = "Collecting Information"',
    started.tpoStatus === 'Collecting Information' && started.consumerStatus === 'Collecting Information');

  const ctc = all.find((m) => m.milestoneName === 'Clear To Close');
  check('Clear To Close: id 4, seq 9, TPO "Clear To Close", consumer "Final Approval", assignment required',
    ctc && ctc.milestoneId === '4' && ctc.sequence === 9 &&
    ctc.tpoStatus === 'Clear To Close' && ctc.consumerStatus === 'Final Approval' &&
    ctc.assignmentRequired === true, JSON.stringify(ctc));

  const funding = all.find((m) => m.milestoneName === 'Funding');
  check('Funding: id 6, role Funder (8), TPO + consumer "Funded"',
    funding && funding.milestoneId === '6' && funding.role === 'Funder' && funding.roleId === '8' &&
    funding.tpoStatus === 'Funded' && funding.consumerStatus === 'Funded', JSON.stringify(funding));

  const completion = all[18];
  check('last is "Completion" (seq 19, 30 expected days, id 7)',
    completion.milestoneName === 'Completion' && completion.sequence === 19 &&
    completion.expectedDays === 30 && completion.milestoneId === '7', JSON.stringify(completion));

  // A UUID-keyed milestone round-trips (the "old IDs" are kept verbatim).
  const condApproval = all.find((m) => m.milestoneName === 'Cond. Approval');
  check('Cond. Approval keeps its UUID id verbatim',
    condApproval && condApproval.milestoneId === '3c34f220-44ec-412c-80a8-5f4dcf4b18d5',
    condApproval && condApproval.milestoneId);

  // Every row carries every detail the owner asked to save.
  const shapeOk = all.every((m) =>
    typeof m.milestoneId === 'string' && typeof m.sequence === 'number' &&
    typeof m.milestoneName === 'string' && (m.role === null || typeof m.role === 'string') &&
    (m.roleId === null || typeof m.roleId === 'string') && typeof m.assignmentRequired === 'boolean' &&
    typeof m.expectedDays === 'number' && typeof m.tpoStatus === 'string' &&
    typeof m.consumerStatus === 'string' && typeof m.isArchived === 'boolean');
  check('every row carries every catalog field (id, sequence, name, role, roleId, assignment, days, tpo, consumer, archived)', shapeOk);

  // ---- getMilestone --------------------------------------------------------
  const one = await catalog.getMilestone('4');
  check('getMilestone("4") returns Clear To Close', one && one.milestoneName === 'Clear To Close');
  const none = await catalog.getMilestone('nope');
  check('getMilestone(unknown) returns null', none === null);

  // ---- idempotency: re-applying the seed changes nothing -------------------
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', '547_lt_encompass_milestones.sql'), 'utf8'));
  const countAgain = await catalog.countMilestones();
  check('still 19 after re-applying the migration a third time', countAgain === 19, `got ${countAgain}`);

  // ---- the HTTP surface (mounted WITHOUT auth here; auth is at the server seam)
  const app = express();
  app.use('/api/lt', lt.router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/lt/health`)).json();
    check('GET /api/lt/health → {ok:true, product:"long-term"}',
      health.ok === true && health.product === 'long-term', JSON.stringify(health));

    const listResp = await fetch(`${base}/api/lt/encompass/milestones`);
    const list = await listResp.json();
    check('GET /api/lt/encompass/milestones → 200 with 19 milestones',
      listResp.status === 200 && list.count === 19 && list.milestones.length === 19,
      `status ${listResp.status}, count ${list.count}`);

    const oneResp = await fetch(`${base}/api/lt/encompass/milestones/6`);
    const oneJson = await oneResp.json();
    check('GET /api/lt/encompass/milestones/6 → Funding',
      oneResp.status === 200 && oneJson.milestoneName === 'Funding', JSON.stringify(oneJson));

    const missResp = await fetch(`${base}/api/lt/encompass/milestones/does-not-exist`);
    check('GET unknown milestone → 404', missResp.status === 404, `status ${missResp.status}`);
  } finally {
    server.close();
  }

  await db.pool.end();

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll LT Encompass-milestone checks passed.');
})().catch((e) => {
  console.error('test-lt-encompass-milestones crashed:', e);
  process.exit(1);
});
