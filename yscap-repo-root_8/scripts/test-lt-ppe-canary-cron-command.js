#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the SCHEDULED daily check, as the scheduler actually runs it.
 *
 * WHY THIS FILE EXISTS. Every piece of the daily check had its own suite — the clock, the driver, the
 * tick — and the composition had none. Three suites mention `canary-cron-command.js` and all three only
 * READ ITS SOURCE. That gap is not incidental: every defect this workstream has found in the daily
 * check has lived in the JOIN between two correct halves, never inside one of them.
 *
 *   §2.64 — a gate that read a switch, and a cron service that declared its environment. Both correct.
 *           Nothing compared them, so the owner's schedule never ran.
 *   here  — `tickOnce` returns `{ attempted, outcome, reason, result, drivenBy }`. The command logged
 *           `ran: !!(out && out.ran)`. There is no `ran` key, so the one sentence an operator reads
 *           about a run that had just priced a FULL BATTERY said `ran:false` — measured, not guessed.
 *   here  — and it returned 0 for every outcome, including `error` (the tick failed) and `refused` (a
 *           schedule that can never run as configured). A daily check broken for weeks showed the
 *           hosting provider a green job every single hour.
 *
 * WHAT IS PROVEN, and it is deliberately about the PROCESS rather than the modules: the exit code the
 * scheduler is handed, and the line an operator reads — for a run that priced, a quiet hour, a failure,
 * and a schedule that cannot run at all. The command is SPAWNED, exactly as `scripts/lt-ppe-canary-cron.js`
 * spawns it, so what is measured is the thing that really happens at 7am.
 *
 * NO LIVE VENDOR CALL AND NO DATABASE. The child is given a stub `canary-driver` through
 * NODE_OPTIONS, so `tickOnce` answers whatever the case under test needs and nothing reaches Postgres
 * or Lender Price.
 *
 *   node scripts/test-lt-ppe-canary-cron-command.js
 *
 * LT-only. No RTL imports.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const CMD = path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-cron-command.js');
const cmd = require(CMD); // safe: the command only runs itself when it IS the main module.

// ---------------------------------------------------------------------------
// A. THE DECISION, pure. Which outcomes are a working schedule and which need a human.
// ---------------------------------------------------------------------------
console.log('\nA. what the scheduler is told\n');

// EVERY outcome `tickOnce` can produce is judged here — a list that quietly stopped covering one is
// how the next `error` gets reported as success. These are its own documented set.
const ALL_OUTCOMES = ['disabled', 'lease_held', 'lease_unreadable', 'ran', 'nothing_due', 'refused', 'error'];
const EXPECT_OK = { ran: true, nothing_due: true, lease_held: true };
for (const outcome of ALL_OUTCOMES) {
  const v = cmd.exitFor({ outcome });
  const want = !!EXPECT_OK[outcome];
  ok(v.ok === want && v.code === (want ? 0 : 1),
    `${outcome} → ${want ? 'success' : 'FAILURE'} (code ${v.code})`);
}
ok(cmd.exitFor({ outcome: 'ran' }).ran === true && cmd.exitFor({ outcome: 'nothing_due' }).ran === false,
  '`ran` answers "did it price?" — separately from `ok`, which answers "is anything wrong?"');
ok(cmd.exitFor(null).ok === false && cmd.exitFor({}).ok === false,
  'an answer that is not an outcome at all is a FAILURE, never a quiet success');
ok(cmd.exitFor({ outcome: 'something_new' }).ok === false,
  'and so is an outcome nobody has taught this about — a new state must never default to healthy');

// ---------------------------------------------------------------------------
// B. THE PROCESS. Spawned the way the scheduler spawns it.
// ---------------------------------------------------------------------------
console.log('\nB. the command, run\n');

// The stub the child loads INSTEAD of the real driver. It reports the outcome the case wants and
// records nothing anywhere — no lease, no database, no vendor.
function runWith({ outcome, args = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-cron-'));
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, `
    const path = require('path');
    const Module = require('module');
    const target = ${JSON.stringify(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-driver.js'))};
    const orig = Module._load;
    Module._load = function (request, parent, isMain) {
      const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch (_) { return null; } })();
      if (resolved === target) {
        return {
          SOURCE_TIMER: 'timer', SOURCE_CRON: 'cron', SOURCE_MANUAL: 'manual',
          tickOnce: async () => ({ attempted: true, outcome: ${JSON.stringify(outcome)}, reason: 'stubbed', result: null, drivenBy: 'cron' }),
        };
      }
      return orig.apply(this, arguments);
    };
  `);
  const run = spawnSync(process.execPath, ['--require', stub, CMD, '--force', ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });
  let line = null;
  for (const l of String(run.stdout || '').trim().split('\n')) {
    try { const o = JSON.parse(l); if (o && o.at) line = o; } catch (_) { /* not our line */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: run.status, line, stdout: run.stdout, stderr: run.stderr };
}

// THE ONE THAT MATTERS FIRST: a run that priced must SAY it priced.
{
  const r = runWith({ outcome: 'ran' });
  ok(r.code === 0, `a battery that priced exits 0 (${r.code})`);
  ok(r.line && r.line.ran === true,
    `THE ONE THAT MATTERS: …and the log says ran:true (${r.line && r.line.ran}) — it said false on every successful run`);
  ok(r.line && r.line.ok === true && r.line.outcome === 'ran', '…with the outcome named beside it');
}

// A QUIET HOUR IS NOT A FAILURE, and must not read as one.
{
  const r = runWith({ outcome: 'nothing_due' });
  ok(r.code === 0 && r.line.ok === true && r.line.ran === false,
    'nothing due: exits 0, ran:false, ok:true — a quiet hour, said plainly');
}

// STANDING DOWN FOR ANOTHER INSTANCE IS THE LEASE WORKING.
{
  const r = runWith({ outcome: 'lease_held' });
  ok(r.code === 0 && r.line.ok === true, 'another instance holds the lease: exits 0 — standing down is correct');
}

// AND THE FAILURES, WHICH USED TO BE GREEN.
for (const [outcome, why] of [
  ['error', 'the tick failed'],
  ['refused', 'a schedule that can never run as configured'],
  ['lease_unreadable', 'the ledger could not be read'],
  ['disabled', 'the gate has been re-broken'],
]) {
  const r = runWith({ outcome });
  ok(r.code === 1, `${outcome} exits NON-ZERO — ${why} is not a green job (${r.code})`);
  ok(r.line && r.line.ok === false && r.line.ran === false, `…and the log says ok:false, not a quiet hour`);
}

// A DRY RUN TOUCHES NOTHING AND SAYS SO.
{
  const r = runWith({ outcome: 'error', args: ['--dry-run'] });
  ok(r.code === 0 && r.line && r.line.reason === 'dry_run' && r.line.ok === true,
    '--dry-run reports what it WOULD do and never reaches the tick, whatever the tick would have said');
}

// ---------------------------------------------------------------------------
// C. THE SHAPE THE COMMAND READS IS THE SHAPE THE DRIVER RETURNS.
//
// The defect above was a field that has never existed. A stub agrees with whatever it is written to
// agree with, so the field names are checked against the REAL driver rather than against the stub.
// ---------------------------------------------------------------------------
console.log('\nC. the command and the driver agree about the words\n');
{
  const src = fs.readFileSync(CMD, 'utf8');
  const driverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-driver.js'), 'utf8');

  ok(!/out\s*&&\s*out\.ran/.test(src),
    'the command no longer reads a `ran` field off the driver — there has never been one');
  ok(/outcome:\s*verdict\.outcome|outcome: \(out && out\.outcome\)/.test(src),
    '…it reads the OUTCOME, which the driver does return');
  // Every key the command takes off the tick result must be one the driver actually produces.
  const returned = new Set([...driverSrc.matchAll(/stamp\(\{([^}]*)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/(\w+):/g)].map((k) => k[1])));
  const read = [...new Set([...src.matchAll(/out\s*&&\s*out\.(\w+)/g)].map((m) => m[1]))];
  const phantom = read.filter((k) => !returned.has(k));
  ok(read.length > 0 && phantom.length === 0,
    `every field the command reads off the tick is one the driver returns${phantom.length ? ` — phantom: ${phantom.join(', ')}` : ` (${read.join(', ')})`}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nok - lt ppe canary cron command (all passed)');
process.exit(failures ? 1 : 0);
