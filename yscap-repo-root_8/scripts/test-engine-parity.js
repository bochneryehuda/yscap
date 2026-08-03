#!/usr/bin/env node
/* =====================================================================
   test-engine-parity.js — the guideline-engine regression harness.

   WHY THIS EXISTS
   The frozen pricing engines are moving out of the browser and onto the
   server (docs/STATIC-TO-BACKEND-IMPLEMENTATION-PLAN.md). The ONLY thing
   that makes that safe is proving, over a broad scenario matrix, that
   every reported number is byte-for-byte the same before and after. This
   is that proof, and it is reusable for any future engine change.

   WHAT IT DOES
   Runs a deterministic matrix of real deal scenarios through the four
   frozen engines and records every numeric field. Then either
     - writes a BASELINE (first run, or --update), or
     - compares against the stored baseline and FAILS on any difference.

   USAGE
     node scripts/test-engine-parity.js                 compare vs baseline
     node scripts/test-engine-parity.js --update        (re)write the baseline
     node scripts/test-engine-parity.js --dir <path>    run against another
                                                        copy of the engines
                                                        (e.g. the moved ones)
     node scripts/test-engine-parity.js --quick         smaller matrix

   The baseline lives at scripts/fixtures/engine-parity-baseline.json.
   A DIFFERENCE IS A RELEASE BLOCKER unless the owner authorised the exact
   guideline change in writing (see the frozen-engine rule in CLAUDE.md).
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const QUICK = args.includes('--quick');
const dirIx = args.indexOf('--dir');
const ENGINE_DIR = dirIx >= 0 ? path.resolve(args[dirIx + 1])
                              : path.join(__dirname, '..', 'web', 'tools');
const BASELINE = path.join(__dirname, 'fixtures', 'engine-parity-baseline.json');

function load(name) {
  const p = path.join(ENGINE_DIR, name);
  if (!fs.existsSync(p)) { console.error(`missing engine: ${p}`); process.exit(2); }
  return { mod: require(p), md5: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') };
}
const YSP = load('standard-program.js');
const GSP = load('gold-standard.js');
const SVP = load('silver-program.js');
const TTL = load('title-cost.js');

/* THE TWO COPIES MUST STAY IDENTICAL, and nothing checked it until now.
   Each engine exists twice — web/tools (V1, and what src/lib/pricing.js requires)
   and web/v2/tools (V2, what the live studio loads). They are maintained BY HAND:
   every guideline change has to be pasted into both. If they drift, the server
   prices one way and the page shows another, and this harness would not notice
   because it only ever loads one folder (web/tools by default). */
if (dirIx < 0) {
  const A = path.join(__dirname, '..', 'web', 'tools');
  const B = path.join(__dirname, '..', 'web', 'v2', 'tools');
  const drifted = [];
  for (const name of ['standard-program.js', 'gold-standard.js', 'silver-program.js', 'title-cost.js']) {
    const a = path.join(A, name), b = path.join(B, name);
    if (!fs.existsSync(a) || !fs.existsSync(b)) { drifted.push(`${name} (missing a copy)`); continue; }
    const ha = crypto.createHash('md5').update(fs.readFileSync(a)).digest('hex');
    const hb = crypto.createHash('md5').update(fs.readFileSync(b)).digest('hex');
    if (ha !== hb) drifted.push(`${name} (web/tools ${ha.slice(0, 8)} vs web/v2/tools ${hb.slice(0, 8)})`);
  }
  if (drifted.length) {
    console.error('\nFAIL: the two engine copies have DRIFTED APART:');
    drifted.forEach(d => console.error('  - ' + d));
    console.error('  The server prices from web/tools; the live studio loads web/v2/tools.');
    console.error('  A guideline change must be applied to BOTH copies, byte for byte.');
    process.exit(1);
  }
}

/* ---- the scenario matrix (deterministic; never randomised) ------------- */
const STATES     = QUICK ? ['NJ','NY','IN'] : ['NJ','NY','FL','TX','PA','CA','GA','OH','CT','IN'];
const STRATEGIES = ['Fix & Flip','Fix & Hold','Ground Up','Bridge'];
const LOANTYPES  = ['Purchase','Refinance'];
const PROPTYPES  = QUICK ? ['Single Family','Multi 2-4'] : ['Single Family','Multi 2-4','Condo','Townhouse','Mixed-Use'];
const FICOS      = QUICK ? [620,740] : [580,620,660,700,740,800];
const TERMS      = QUICK ? [12] : [12,18,24];
const EXPS       = [{f:0,h:0,g:0},{f:2,h:1,g:0},{f:6,h:2,g:1},{f:15,h:5,g:3}];
const PRICES     = [
  { purchasePrice: 150000, asIsValue: 160000, arv: 235000, rehabBudget:  45000 },
  { purchasePrice: 500000, asIsValue: 525000, arv: 750000, rehabBudget: 125000 },
  { purchasePrice: 950000, asIsValue: 900000, arv:1400000, rehabBudget: 300000 },
  { purchasePrice:2200000, asIsValue:2300000, arv:3100000, rehabBudget: 650000 },
];

function* scenarios() {
  let i = 0;
  for (const state of STATES)
  for (const strategy of STRATEGIES)
  for (const loanType of LOANTYPES)
  for (const propertyType of PROPTYPES)
  for (const fico of FICOS)
  for (const term of TERMS)
  for (const e of EXPS)
  for (const p of PRICES) {
    i++;
    yield {
      loanType, strategy, state, city: 'Springfield', propertyType,
      fico, expFlips: e.f, expHolds: e.h, expGround: e.g,
      term, irMonths: (i % 4), units: propertyType === 'Multi 2-4' ? 3 : 1,
      cashOut: loanType === 'Refinance' && (i % 3 === 0),
      accrual: 'Non-Dutch',
      isAssignment: (i % 7 === 0),
      sellerPrice: (i % 7 === 0) ? Math.round(p.purchasePrice * 0.9) : undefined,
      ...p,
    };
  }
}

/* ---- stable digest of an engine result -------------------------------- */
function stable(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(stable);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
  return out;
}
const call = fn => { try { return { ok: stable(fn()) }; } catch (e) { return { err: String((e && e.message) || e) }; } };

/* ---- run --------------------------------------------------------------- */
const rows = [];
let n = 0;
const statuses = {};
for (const s of scenarios()) {
  n++;
  const ysp = call(() => YSP.mod.evaluate(s));
  /* title-cost.js and YSP.caps used to be LOADED (for their md5) but never CALLED,
     so a guideline change inside either produced zero numeric difference and this
     harness printed "every scenario produces identical numbers" — which was false.
     Proven 2026-08-02 by editing a title rate: the run went green, exit 0.
     Both are now exercised on every scenario, driven by the Standard result so the
     loan amount and the tier are the real ones for that deal. */
  const ok = ysp.ok || {};
  const loanForTitle = (ok.sizing && ok.sizing.totalLoan) || 0;
  const r = {
    ysp,
    yspL: call(() => YSP.mod.priceLadder(s)),
    gsp:  call(() => GSP.mod.evaluate(s)),
    svp:  call(() => SVP.mod.evaluate(s)),
    svpL: call(() => SVP.mod.priceLadder(s)),
    ttl:  call(() => TTL.mod.estimate(s.state, loanForTitle, s.loanType)),
    caps: call(() => YSP.mod.caps(ok.regime, ok.loanType, ok.strategyCode, ok.tier)),
  };
  const st = (r.ysp.ok && r.ysp.ok.status) || (r.ysp.err ? 'ERROR' : '?');
  statuses[st] = (statuses[st] || 0) + 1;
  rows.push(crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex'));
}

/* Chunked digests: one hash per CHUNK of scenarios rather than per scenario.
   115,200 individual hashes is a 7 MB file that would be rewritten on every
   baseline update and bloat the repo forever. Chunking keeps the baseline at
   ~75 KB while still localising a failure to a small block of scenarios,
   which is all you need to start debugging. */
const CHUNK = 100;
const chunks = [];
for (let i = 0; i < rows.length; i += CHUNK) {
  chunks.push(crypto.createHash('sha256').update(rows.slice(i, i + CHUNK).join('')).digest('hex').slice(0, 32));
}

const result = {
  version: 2,
  engines: { standard: YSP.md5, gold: GSP.md5, silver: SVP.md5, title: TTL.md5 },
  matrix: { quick: QUICK, scenarios: n, chunk: CHUNK },
  statuses,
  digest: crypto.createHash('sha256').update(rows.join('')).digest('hex'),
  chunks,
};

/* ---- compare or record -------------------------------------------------- */
fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
if (UPDATE || !fs.existsSync(BASELINE)) {
  fs.writeFileSync(BASELINE, JSON.stringify(result, null, 2) + '\n');
  console.log(`baseline written: ${n.toLocaleString()} scenarios, digest ${result.digest.slice(0, 16)}`);
  console.log(`status spread: ${JSON.stringify(statuses)}`);
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

console.log(`scenarios        : ${n.toLocaleString()}`);
console.log(`status spread    : ${JSON.stringify(statuses)}`);

/* A CHANGED ENGINE FILE IS FATAL, not a warning.
   This used to `console.log` and carry on, so `npm test` went GREEN on an edited
   guideline file — and printed "every scenario produces identical numbers" while
   doing it. The frozen-engine rule in CLAUDE.md says a guideline change needs the
   owner's explicit written authorisation; a test that merely mentions it in
   passing does not enforce anything. If the change IS authorised, re-record with
   --update, which is the deliberate, reviewable act that records it. */
const engineChanged = Object.keys(result.engines).filter(k => result.engines[k] !== base.engines[k]);
if (engineChanged.length) {
  console.error(`\nFAIL: engine file(s) changed since the baseline: ${engineChanged.join(', ')}`);
  console.error('  The frozen pricing engines may not change without the owner\'s EXPLICIT WRITTEN');
  console.error('  authorisation. If this change was authorised, re-record the baseline with:');
  console.error('      node scripts/test-engine-parity.js --update');
  console.error('  and say in the commit which guideline the owner authorised.');
  process.exit(1);
}
if (base.version !== result.version || base.matrix.quick !== QUICK || base.matrix.chunk !== CHUNK) {
  console.error(`\nFAIL: baseline shape differs (version/--quick/chunk); re-record with the same settings.`);
  process.exit(1);
}
if ((base.chunks || []).length !== chunks.length) {
  console.error(`\nFAIL: scenario count changed (${(base.chunks || []).length * CHUNK} → ${n}).`);
  process.exit(1);
}
const badChunks = [];
for (let i = 0; i < chunks.length; i++) if (chunks[i] !== base.chunks[i]) badChunks.push(i);
if (badChunks.length) {
  console.error(`\nFAIL: ${badChunks.length} of ${chunks.length} scenario blocks produce DIFFERENT numbers`
    + ` (up to ${(badChunks.length * CHUNK).toLocaleString()} scenarios).`);
  console.error(`  first differing block: scenarios ${badChunks[0] * CHUNK + 1}–${(badChunks[0] + 1) * CHUNK}`);
  console.error('This is a release blocker unless the owner authorised the exact change in writing.');
  process.exit(1);
}
/* The overall digest is compared for REAL, not asserted. It is a second,
   independent check on top of the per-chunk loop: the chunks are hashes OF the
   rows, the digest is a hash of the rows themselves, so a baseline whose two
   halves had drifted apart (a hand-edit, a bad merge, a partial write) is
   caught here rather than silently reported as a pass. Printing an unearned
   "(matches baseline)" is exactly the kind of reassurance that hides a broken
   safety net — never print an outcome that was not tested. */
if (base.digest !== result.digest) {
  console.error(`\nFAIL: every scenario block matched, but the overall digest does NOT.`);
  console.error(`  baseline: ${base.digest}`);
  console.error(`  current : ${result.digest}`);
  console.error('  The baseline file is internally inconsistent — re-record it with --update.');
  process.exit(1);
}
console.log(`digest           : ${result.digest.slice(0, 16)} (verified against baseline)`);
console.log('\nPASS — every scenario produces identical numbers.');
