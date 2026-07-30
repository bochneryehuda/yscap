'use strict';
/**
 * THE MANUAL PROGRAM HAS ITS OWN ORIGINATION FEE (owner-directed 2026-07-30).
 *
 * Owner's report: "we don't have a word to enter origination fee for the manual
 * program. We only can enter for all other programs, not for the manual program."
 *
 * The studio field alone is not the feature — a knob that displays 2.5% and
 * registers 1.25% is worse than no knob at all, because the term sheet and the
 * registration would disagree and nobody would know which one is real. This
 * pins the whole path: the studio's value reaches the engine result, a blank one
 * still falls back to Standard exactly as it did before the key existed, the
 * other three programs ignore it, and moving it off the company default sends
 * the registration to an admin like every other admin-zone knob.
 *
 * PURE — no DB, no server. Run: node scripts/test-manual-origination.js
 */
const path = require('path');
const pricing = require(path.join(__dirname, '..', 'src', 'lib', 'pricing.js'));
const overrides = require(path.join(__dirname, '..', 'src', 'lib', 'pricing-overrides.js'));

let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; console.log('PASS ' + what); }
  else { fails.push(what); console.log('FAIL ' + what); }
}
function eq(a, b, what) { ok(a === b, `${what} (got ${a}, want ${b})`); }
function near(a, b, what) { ok(Math.abs(Number(a) - Number(b)) < 0.005, `${what} (got ${a}, want ${b})`); }

if (!pricing.enginesReady()) {
  console.error('pricing engines unavailable: ' + (pricing.loadErr() || 'unknown'));
  process.exit(1);
}

/* EVERY case goes through buildInputs, NOT straight into quoteProgram.
   buildInputs is where the NUMK whitelist lives, and the whitelist is the thing
   that silently drops an unknown key on the way in from the register route — so
   a test that hands quoteProgram a hand-built input object would pass happily
   with the key missing from the whitelist and prove nothing (this test did
   exactly that until a mutation run caught it). The `overrides` argument here is
   the same shape ProductStudioPanel posts. */
const APP = {
  loan_type: 'Purchase', program: 'standard',
  property_address: { line1: '12 Oak St', city: 'Freehold', state: 'NJ', zip: '07728' },
  property_type: 'SFR', units: 1,
  purchase_price: 400000, as_is_value: 400000, arv: 600000, rehab_budget: 80000,
  term: '12 Months', fico: 740,
};
const EXPERIENCE = { flips: 5, holds: 0, ground: 0 };

function inputsFor(extra) {
  return pricing.buildInputs(APP, EXPERIENCE, Object.assign({
    strategy: 'Fix & Flip',
    // A structural basis is what makes the server record a Manual Program
    // (manual-program.resolveProgram) — the same thing the studio's Manual card
    // keys on. Present in every 'manual' case so the scenarios are the real
    // shape, not a program string typed in isolation.
    manualPricing: true, ovrLTCPct: 80,
  }, extra || {}));
}

function origOf(program, extra) {
  const q = pricing.quoteProgram(program, inputsFor(extra));
  return { pct: q.origPct, fee: q.origination, loan: (q.sizing && q.sizing.totalLoan) || q.totalLoan };
}

console.log('--- 1. the manual knob is honored on a manual product ---');
{
  const withManual = origOf('manual', { origManualPct: 2.5 });
  near(withManual.pct, 0.025, 'manual product prices at the manual origination (2.5%)');
  near(withManual.fee, withManual.loan * 0.025, 'the manual origination FEE is 2.5% of the loan');
}

console.log('\n--- 2. a BLANK manual knob still falls back to Standard (no regression) ---');
{
  // This is the case every already-registered file is in: no origManualPct key
  // at all. It must behave EXACTLY as it did before the key existed.
  const noManual = origOf('manual', {});
  const stdOnly = origOf('manual', { origStdPct: 2.0 });
  const bothSet = origOf('manual', { origStdPct: 2.0, origManualPct: 3.0 });
  near(stdOnly.pct, 0.020, 'no manual knob → the Standard override still governs a manual product');
  near(bothSet.pct, 0.030, 'manual knob set → it WINS over the Standard override');
  ok(noManual.pct > 0, 'no knobs at all → the company/engine default still applies (never 0)');
  // An explicitly BLANK value is the studio's "use the default" contract.
  const blank = origOf('manual', { origStdPct: 2.0, origManualPct: '' });
  near(blank.pct, 0.020, 'an explicitly blank manual knob falls back to Standard, never to 0');
}

console.log('\n--- 3. the other three programs IGNORE the manual knob ---');
{
  for (const prog of ['standard', 'gold', 'silver']) {
    let withM, without;
    try {
      withM = pricing.quoteProgram(prog, inputsFor({ origManualPct: 9.0, manualPricing: false, ovrLTCPct: null }));
      without = pricing.quoteProgram(prog, inputsFor({ manualPricing: false, ovrLTCPct: null }));
    } catch (e) { ok(false, `${prog} quoted without throwing (${e.message})`); continue; }
    eq(withM.origPct, without.origPct, `${prog} origination is untouched by a manual knob`);
  }
}

console.log('\n--- 4. moving it off the default needs an admin approval ---');
{
  const defaults = { origStdPct: 1.25, origGoldPct: 1.25, origSilverPct: 1.25 };
  const named = (raw) => overrides.pricingOverridesEngaged(raw, defaults).map((c) => c.key);

  ok(named({ origManualPct: 2.5 }).includes('origManualPct'),
    'a changed manual origination is reported as needing approval');
  ok(!named({ origManualPct: 1.25 }).includes('origManualPct'),
    'typing the STANDARD company default back into the manual knob is NOT a change');
  ok(!named({ origManualPct: '' }).includes('origManualPct'),
    'an explicitly blanked manual knob is NOT a change');
  ok(!named({}).includes('origManualPct'),
    'an absent manual knob is NOT a change');
  // The borrowed default must not leak onto the siblings.
  ok(named({ origSilverPct: 2.0 }).includes('origSilverPct'),
    'the sibling knobs still compare against their OWN default');
  const line = overrides.describeOverrides(overrides.pricingOverridesEngaged({ origManualPct: 2.5 }, defaults))[0];
  ok(/Manual/.test(line) && /2\.5%/.test(line),
    `the approval line names the Manual knob in plain language (got: ${line})`);
}

console.log('\n--- 5. the whole chain is wired, not just the engine ---');
{
  const fs = require('fs');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // Each of these is a place the value would be silently dropped, turning the
  // studio into a knob that displays one number and registers another.
  const wired = [
    ['web/v2/tools/term-sheet.html', /id="tsOrigManual"/, 'the studio has the input'],
    ['web/v2/tools/termsheet.js', /tsOrigManual/, 'the studio calc reads it'],
    ['src/lib/pricing.js', /'origManualPct'/, 'the server whitelist keeps it'],
    ['src/lib/pricing-overrides.js', /origManualPct/, 'the approval detector knows it'],
    ['app-v2/src/components/TermSheetStudio.jsx', /tsOrigManual/, 'the snapshot captures + restores it'],
    ['app-v2/src/components/ProductStudioPanel.jsx', /origManualPct/, 'the register payload carries it'],
    ['app-v2/src/screens/Apply.jsx', /origManualPct/, 'the apply flow carries it'],
  ];
  for (const [file, re, what] of wired) ok(re.test(read(file)), `${what} (${file})`);
  // The capture and the restore are two different directions — a snapshot that
  // saves but never reloads looks fine until someone reopens the file.
  const studio = read('app-v2/src/components/TermSheetStudio.jsx');
  ok(/tsOrigManual:\s*val\('tsOrigManual'\)/.test(studio), 'the snapshot CAPTURES the typed value');
  ok(/put\('tsOrigManual',\s*inp\.origManualPct\)/.test(studio), 'the snapshot RESTORES it on reopen');
}

console.log(`\n${fails.length ? 'FAILED' : 'ALL PASS'} — ${pass} assertions, ${fails.length} failure(s)`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
