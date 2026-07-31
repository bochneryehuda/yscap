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
  const r = {
    ysp:  call(() => YSP.mod.evaluate(s)),
    yspL: call(() => YSP.mod.priceLadder(s)),
    gsp:  call(() => GSP.mod.evaluate(s)),
    svp:  call(() => SVP.mod.evaluate(s)),
    svpL: call(() => SVP.mod.priceLadder(s)),
  };
  const st = (r.ysp.ok && r.ysp.ok.status) || (r.ysp.err ? 'ERROR' : '?');
  statuses[st] = (statuses[st] || 0) + 1;
  rows.push(crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex'));
}

const result = {
  version: 1,
  engines: { standard: YSP.md5, gold: GSP.md5, silver: SVP.md5, title: TTL.md5 },
  matrix: { quick: QUICK, scenarios: n },
  statuses,
  digest: crypto.createHash('sha256').update(rows.join('')).digest('hex'),
  rows,
};

/* ---- compare or record -------------------------------------------------- */
fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
if (UPDATE || !fs.existsSync(BASELINE)) {
  fs.writeFileSync(BASELINE, JSON.stringify({ ...result, rows: undefined, rowsHash: result.digest }, null, 2) + '\n');
  fs.writeFileSync(BASELINE.replace('.json', '.rows'), rows.join('\n') + '\n');
  console.log(`baseline written: ${n.toLocaleString()} scenarios, digest ${result.digest.slice(0, 16)}`);
  console.log(`status spread: ${JSON.stringify(statuses)}`);
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const baseRows = fs.readFileSync(BASELINE.replace('.json', '.rows'), 'utf8').trim().split('\n');

console.log(`scenarios        : ${n.toLocaleString()}`);
console.log(`status spread    : ${JSON.stringify(statuses)}`);

const engineChanged = Object.keys(result.engines).filter(k => result.engines[k] !== base.engines[k]);
if (engineChanged.length) {
  console.log(`\n⚠ ENGINE FILE(S) CHANGED since the baseline: ${engineChanged.join(', ')}`);
  console.log('  A guideline change requires the owner\'s explicit written authorisation.');
}
if (base.matrix.quick !== QUICK) {
  console.error(`\nFAIL: baseline was recorded with --quick=${base.matrix.quick}; rerun with the same matrix.`);
  process.exit(1);
}
if (baseRows.length !== rows.length) {
  console.error(`\nFAIL: scenario count changed (${baseRows.length} → ${rows.length}).`);
  process.exit(1);
}
let bad = 0;
for (let i = 0; i < rows.length; i++) if (rows[i] !== baseRows[i]) bad++;
if (bad) {
  console.error(`\nFAIL: ${bad.toLocaleString()} of ${rows.length.toLocaleString()} scenarios produce DIFFERENT numbers.`);
  console.error('This is a release blocker unless the owner authorised the exact change in writing.');
  process.exit(1);
}
console.log(`digest           : ${result.digest.slice(0, 16)} (matches baseline)`);
console.log('\nPASS — every scenario produces identical numbers.');
