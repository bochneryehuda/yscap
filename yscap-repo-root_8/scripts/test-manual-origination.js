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
  ];
  for (const [file, re, what] of wired) ok(re.test(read(file)), `${what} (${file})`);

  /* The BORROWER's apply flow is the one place that must NOT carry it, and this
     row used to assert the opposite (2026-08-03 post-merge audit).

     `Apply.jsx` built an `origManualPct` (plus markup, fees and the manual
     LTV/rate basis) into its register payload behind `if (adminKey)`. Two
     independent reasons that was never real wiring: nothing ever called
     `unlockAdminPricing()`, so `adminKey` could not be set — and even if it
     could, `borrower.js borrowerPricingOverrides()` whitelists only targetLTC /
     irMonths / irAmount / term / fico / exp*, so the server has DISCARDED every
     staff-grade knob a borrower sends since audit S1-04 (2026-07-12).

     The knob is also no longer displayed there: the borrower's studio strips the
     admin zone from the DOM entirely. So the "displays one number, registers
     another" risk this section guards against cannot arise on that screen — and
     re-adding the payload to satisfy the old assertion would put staff pricing
     controls back on a borrower surface. Asserted in the negative instead. */
  ok(!/origManualPct/.test(read('app-v2/src/screens/Apply.jsx')),
    'the BORROWER apply flow does NOT carry a staff-grade origination override (S1-04)');
  ok(/adminCapable=\{false\}/.test(read('app-v2/src/screens/Apply.jsx')),
    '…and its studio has no admin zone to type one into');
  // The capture and the restore are two different directions — a snapshot that
  // saves but never reloads looks fine until someone reopens the file.
  const studio = read('app-v2/src/components/TermSheetStudio.jsx');
  ok(/tsOrigManual:\s*val\('tsOrigManual'\)/.test(studio), 'the snapshot CAPTURES the typed value');
  ok(/put\('tsOrigManual',\s*inp\.origManualPct\)/.test(studio), 'the snapshot RESTORES it on reopen');
}

/* =====================================================================
   6. "BLANK MANUAL = FOLLOW STANDARD" MUST SURVIVE THE STUDIO, NOT JUST
      THE ENGINE  (audit 2026-07-30)

   Section 2 proves the SERVER falls back to origStdPct when the manual key
   is absent. That guarantee is worthless if the studio never sends an absent
   key. The studio used to SEED tsOrigManual with the Standard COMPANY default
   at page load, so every register payload carried a real number and the
   fallback could never fire: a staffer who typed a Standard origination of
   2.0% and set a manual basis registered the Manual Program at 1.25%, while
   the approval card told the admin "Origination points — Standard: 1.25% →
   2%" — a percentage that did not govern. Blank has to stay blank.
   ===================================================================== */
console.log('\n--- 6. the studio leaves the manual knob BLANK, and blank follows the STANDARD FIELD ---');
{
  const fs = require('fs');
  const ts = fs.readFileSync(path.join(__dirname, '..', 'web/v2/tools/termsheet.js'), 'utf8');
  ok(!/\bs\("tsOrigManual"/.test(ts),
    'seedAdminDefaults does NOT seed tsOrigManual (its default is "same as Standard", not a fixed number)');
  ok(/setVal\("tsOrigManual",\s*""\)/.test(ts),
    'lockDown CLEARS tsOrigManual (blank), it does not write the Standard company default into it');
  // adminOrigPct('manual') must read the field RAW (blank => fall through to the
  // Standard knob as resolved), never adminNum(..., CO.origStd) which pins it to
  // the company default and ignores a typed Standard override.
  ok(/if \(prog === "manual"\) \{\s*var m = adminNumRaw\("tsOrigManual"\);/.test(ts),
    'adminOrigPct("manual") falls through to the Standard knob when the field is blank');
  ok(!/adminNum\("tsOrigManual"/.test(ts),
    'adminOrigPct("manual") never pins a blank field to the bare company default');
  // The panel's own off-default warning has to borrow the same default the
  // server borrows, or it warns about a value that IS the default.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/components/ProductStudioPanel.jsx'), 'utf8');
  ok(/DEFAULT_SOURCE\s*=\s*\{\s*origManualPct:\s*'origStdPct'/.test(panel),
    "the panel's approval warning compares the Manual knob against the STANDARD default (mirrors pricing-overrides `defaultKey`)");
}

/* =====================================================================
   7. A SUPER-ADMIN'S COUNTERED ORIGINATION MUST GOVERN  (audit 2026-07-30)

   accept-counter replays the escalation's stored override blob and overlays
   the counter terms. That blob carries the LOAN OFFICER's off-default knobs —
   including origManualPct. A countered registration resolves to program
   'manual' (it has a structural override), and pricing.js prefers
   origManualPct there, so writing only origStdPct/origGoldPct let the loan
   officer's requested origination outrank the super-admin's counter and the
   borrower was emailed those terms as CONFIRMED.
   ===================================================================== */
console.log('\n--- 7. the countered origination governs the re-registration ---');
{
  const fs = require('fs');
  const manualProgram = require(path.join(__dirname, '..', 'src', 'lib', 'manual-program.js'));

  // Replay exactly what the accept-counter route builds.
  function acceptCounter(escOverrides, counterTerms, { writeAllOrigKeys }) {
    const ov = { ...escOverrides };
    const ct = counterTerms;
    if (ct.origPct != null) {
      const pctVal = Number(ct.origPct) * 100;
      ov.origStdPct = pctVal;
      ov.origGoldPct = pctVal;
      if (writeAllOrigKeys) { ov.origSilverPct = pctVal; ov.origManualPct = pctVal; }
    }
    ov.forcePrice = true;
    const program = manualProgram.resolveProgram('standard', ov);
    const q = pricing.quoteProgram(program, pricing.buildInputs(APP, EXPERIENCE, { strategy: 'Fix & Flip', ...ov }));
    return { program, pct: q.origPct * 100 };
  }

  // The loan officer asked for 2.5%; the super-admin counters at 0.5%.
  const escBlob = { ovrLTCPct: 80, manualPricing: true, origManualPct: 2.5 };
  const fixed = acceptCounter(escBlob, { origPct: 0.005 }, { writeAllOrigKeys: true });
  eq(fixed.program, 'manual', 'a countered structural override still registers as a Manual Program');
  near(fixed.pct, 0.5, "the SUPER-ADMIN's countered origination governs, not the loan officer's request");
  // Negative control — this is the exact shape of the bug, so the assertion
  // above cannot pass for the wrong reason.
  const broken = acceptCounter(escBlob, { origPct: 0.005 }, { writeAllOrigKeys: false });
  near(broken.pct, 2.5, 'control: writing only origStdPct/origGoldPct DOES leave the counter shadowed');

  // …and the route really does write every origination key.
  const staffRoutes = fs.readFileSync(path.join(__dirname, '..', 'src/routes/staff.js'), 'utf8');
  const block = /if \(ct\.origPct\s*!= null\) \{[\s\S]{0,900}?\n    \}/.exec(staffRoutes);
  ok(!!block, 'the accept-counter origination block is present in src/routes/staff.js');
  for (const k of ['origStdPct', 'origGoldPct', 'origSilverPct', 'origManualPct']) {
    ok(!!block && new RegExp('overrides\\.' + k + '\\s*=\\s*pctVal').test(block[0]),
      `accept-counter writes the countered origination onto ${k}`);
  }
}

console.log(`\n${fails.length ? 'FAILED' : 'ALL PASS'} — ${pass} assertions, ${fails.length} failure(s)`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
