/**
 * THE COMPANY MARKUP REACHES THE RATE — and restating it never freezes it onto a
 * file (owner-reported 2026-08-20). PURE — no DB, no network.
 *
 *   "The pricing was previously set for the silver program and for the standard
 *    program to 0.4 markup on the rate. I went to admin settings and changed it
 *    to 0.5 markup, but the actual rates that are showing for the people and for
 *    the staff are still 0.4 … When they're trying to register, every single
 *    registration goes for an exception because 0.4 and not 0.5."
 *
 * ROOT CAUSE, reproduced before anything was changed: the Term Sheet Studio
 * PAINTED the company default of the day into the admin markup box, and a value
 * in that box is an EXPLICIT PER-FILE OVERRIDE — so every registration froze that
 * day's default onto that file (`applications.file_markup_*_pct`). Afterwards the
 * file kept pricing at the frozen number, and re-opening the studio restored it,
 * so the next register read as a DISCOUNT against the new default and needed an
 * admin's approval. Both halves of the report, one cause.
 *
 * WHAT THIS FILE PROVES:
 *   A. THE TRUTH TABLE. A value that exactly restates the company default becomes
 *      the blank contract; a real deviation is untouched; nothing is normalized
 *      when there is no default to compare against.
 *   B. IT IS PRICE-NEUTRAL. Pricing the seeded payload and pricing the normalized
 *      one produce byte-identical quotes — which is what makes it safe to do at a
 *      chokepoint every register and every quote goes through.
 *   C. THE BLANK CLEARS THE FREEZE. An explicit blank drops the per-file markup,
 *      so the LIVE company default governs — including on a file already carrying
 *      a frozen one.
 *   D. NO EXCEPTION FOR RESTATING THE DEFAULT, and still one for a real discount.
 *   E. THE REPORTED SYMPTOM. The measured 10-basis-point gap, and the approval it
 *      demanded, are both gone.
 *   F. THE ROOT CAUSE CANNOT COME BACK. A source guard on the studio: the company
 *      default is shown as a placeholder and never written into the field's value.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const pricing = require('../src/lib/pricing');
const po = require('../src/lib/pricing-overrides');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP test-company-default-markup-pure: engines not loadable', pricing.loadErr && pricing.loadErr());
  process.exit(0);
}

// The company defaults, before and after the owner's change.
const CD_OLD = { markupStdPct: 0.4, markupGoldPct: 0.5, markupSilverPct: 0.4, origStdPct: 1.25, origGoldPct: 1.25, origSilverPct: 1.25, lenderFee: 2195, creditFee: 150, appraisalFee: 800, titleFee: null, extraFees: [], markupTiers: null };
const CD_NEW = { ...CD_OLD, markupStdPct: 0.5, markupSilverPct: 0.5 };

console.log('A. the truth table');
{
  const seeded = { markupStdPct: '0.5', markupSilverPct: '0.5', origStdPct: '1.25', lenderFee: '2195', creditFee: '150', appraisalFee: '800', manualPricing: false };
  const norm = po.normalizeCompanyDefaultKnobs(seeded, CD_NEW);
  assert(['markupStdPct', 'markupSilverPct', 'origStdPct', 'lenderFee', 'creditFee', 'appraisalFee'].every((k) => norm[k] === ''),
    'A1 a knob that exactly restates the company default becomes the blank contract');
  assert(norm.manualPricing === false && Object.keys(norm).length === Object.keys(seeded).length,
    'A2 nothing else in the payload is touched, and no key is dropped (a dropped key could never CLEAR a stale sticky)');

  assert(po.normalizeCompanyDefaultKnobs({ markupStdPct: '0.75' }, CD_NEW).markupStdPct === '0.75',
    'A3 a real deviation is left exactly as typed');
  assert(po.normalizeCompanyDefaultKnobs({ markupStdPct: '0.4' }, CD_NEW).markupStdPct === '0.4',
    'A4 a STALE default (0.4 against today\'s 0.5) is a real deviation and is left alone — it is not this rule\'s job to decide it');
  assert(po.normalizeCompanyDefaultKnobs({ markupStdPct: '0.5' }, null).markupStdPct === '0.5',
    'A5 with no defaults readable, nothing is normalized — fail SAFE, never silently drop a real override');
  assert(po.normalizeCompanyDefaultKnobs({ titleFee: '1200' }, CD_NEW).titleFee === '1200',
    'A6 the title fee has no numeric company default (NULL = auto-estimate), so a typed one is always a deviation');
  assert(po.normalizeCompanyDefaultKnobs({ origManualPct: '1.25' }, CD_NEW).origManualPct === '',
    'A7 the Manual origination borrows the Standard default, exactly as the approval detector does');
  assert(po.normalizeCompanyDefaultKnobs({ markupStdPct: '' }, CD_NEW).markupStdPct === ''
    && po.normalizeCompanyDefaultKnobs({ markupStdPct: 'abc' }, CD_NEW).markupStdPct === 'abc',
    'A8 an already-blank knob and an unreadable one are both left as they are');
  assert(po.normalizeCompanyDefaultKnobs({ ovrLTCPct: 95, oopRehab: 1000 }, CD_NEW).ovrLTCPct === 95,
    'A9 the knobs with NO company default (a manual basis, an out-of-pocket rehab) are never touched');
}

const APP = {
  purchase_price: 300000, as_is_value: 300000, arv: 520000, rehab_budget: 100000,
  fico: 720, term: 12, program: 'Fix and Flip', loan_type: 'Purchase',
  property_type: 'Single Family', units: 1, property_address: { state: 'TX' },
  requested_exp_flips: 3,
};
const EXP = { flips: 3, holds: 0, ground: 0 };
const q = (app, overrides, cd, program = 'standard') =>
  pricing.quoteProgram(program, pricing.buildInputs(app, EXP, overrides || {}), { settings: cd });
const money = (quote) => JSON.stringify({
  noteRate: quote.noteRate, total: quote.sizing.totalLoan, initial: quote.sizing.initialAdvance,
  holdback: quote.sizing.rehabHoldback, origination: quote.origination, cashToClose: quote.cashToClose,
  closing: quote.closingCosts, liquidity: quote.liquidityRequired,
});

console.log('\nB. normalizing a restatement is price-neutral');
{
  let drift = 0, checked = 0, first = null;
  for (const state of ['TX', 'NJ', 'FL', 'OH']) {
    for (const price of [180000, 300000, 750000]) {
      for (const rehab of [0, 80000, 220000]) {
        for (const program of ['standard', 'gold', 'silver']) {
          const app = { ...APP, property_address: { state }, purchase_price: price, as_is_value: price, arv: price * 1.8 + rehab * 1.6, rehab_budget: rehab };
          const seeded = { markupStdPct: CD_NEW.markupStdPct, markupGoldPct: CD_NEW.markupGoldPct, markupSilverPct: CD_NEW.markupSilverPct, origStdPct: CD_NEW.origStdPct, origGoldPct: CD_NEW.origGoldPct, origSilverPct: CD_NEW.origSilverPct, lenderFee: CD_NEW.lenderFee, creditFee: CD_NEW.creditFee, appraisalFee: CD_NEW.appraisalFee };
          const withSeed = money(q(app, seeded, CD_NEW, program));
          const withBlank = money(q(app, po.normalizeCompanyDefaultKnobs(seeded, CD_NEW), CD_NEW, program));
          checked++;
          if (withSeed !== withBlank) { drift++; if (!first) first = { state, price, rehab, program, withSeed, withBlank }; }
        }
      }
    }
  }
  assert(checked > 50 && drift === 0,
    `B1 across ${checked} priced deals on all three programs, normalizing every seeded knob to blank changes NOT ONE number — rate, loan, origination, every closing cost, cash to close and liquidity (drift: ${drift})`);
  if (first) console.log('    first drift:', JSON.stringify(first));
}

console.log('\nC. the blank contract clears a frozen per-file markup');
{
  const frozen = { ...APP, file_markup_std_pct: 0.4 };
  const inFrozen = pricing.buildInputs(frozen, EXP, {});
  const inCleared = pricing.buildInputs(frozen, EXP, { markupStdPct: '' });
  assert(inFrozen.markupStdPct === 0.4,
    'C1 a file carrying a frozen per-file markup re-applies it to every quote (this is the freeze the owner hit)');
  assert(!Object.prototype.hasOwnProperty.call(inCleared, 'markupStdPct'),
    'C2 an explicit blank DROPS it, so the live company default governs — which is why the normalizer answers with a blank and never by removing the key');
  assert(q(frozen, { markupStdPct: '' }, CD_NEW).noteRate === q(APP, {}, CD_NEW).noteRate,
    'C3 and the frozen file then prices exactly like a file that never carried one');
}

console.log('\nD. approvals');
{
  assert(po.needsPricingApproval(po.normalizeCompanyDefaultKnobs({ markupStdPct: '0.5', origStdPct: '1.25', lenderFee: '2195' }, CD_NEW), CD_NEW) === false,
    'D1 a registration that only restates the company defaults needs no approval');
  assert(po.needsPricingApproval(po.normalizeCompanyDefaultKnobs({ markupStdPct: '0.3' }, CD_NEW), CD_NEW) === true,
    'D2 a real discount still routes to an admin — the control the owner asked for in 2026-07-27 is untouched');
  assert(po.needsPricingApproval(po.normalizeCompanyDefaultKnobs({ markupStdPct: '0.9' }, CD_NEW), CD_NEW) === false,
    'D3 charging MORE than the default still needs none (owner-directed 2026-08-12), unchanged');
}

console.log('\nE. the reported symptom, before and after');
{
  const frozen = { ...APP, file_markup_std_pct: 0.4 };
  const stale = q(frozen, {}, CD_NEW).noteRate;
  const live = q(APP, {}, CD_NEW).noteRate;
  const bps = Math.round((live - stale) * 10000);
  assert(bps === 10,
    `E1 the freeze is exactly the gap the owner described — a file frozen at 0.4 prices ${bps} basis points under the 0.5 company default (${(stale * 100).toFixed(3)}% vs ${(live * 100).toFixed(3)}%)`);
  assert(po.needsPricingApproval({ markupStdPct: 0.4 }, CD_NEW) === true,
    'E2 and re-registering it at the frozen number reads as a discount — "every single registration goes for an exception"');
  // What the studio sends now: the box is blank, so the payload carries the blank.
  const registered = po.normalizeCompanyDefaultKnobs({ markupStdPct: '' }, CD_NEW);
  assert(q(frozen, registered, CD_NEW).noteRate === live && po.needsPricingApproval(registered, CD_NEW) === false,
    'E3 with the box blank the same file prices at the live 0.5 default AND needs no approval — both halves of the report');
}

console.log('\nF. the root cause cannot come back (source guards)');
{
  const studio = fs.readFileSync(path.join(__dirname, '..', 'web/v2/tools/termsheet.js'), 'utf8');
  const seedFn = (studio.match(/function seedAdminDefaults\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  assert(seedFn.length > 100, 'F0 seedAdminDefaults was found in the studio (the guard below is not vacuous)');
  assert(/\.placeholder\s*=/.test(seedFn),
    'F1 the studio shows the company default as a PLACEHOLDER, so the officer still reads the number the blank box prices at');
  assert(!/e\.value\s*=/.test(seedFn),
    'F2 and it never writes it into the field\'s VALUE — a value there is an explicit per-file override, which is the whole bug');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web/v2/tools/term-sheet.html'), 'utf8');
  assert(/if \(seeded != null\) return v !== '' && v !== String\(seeded\)\.trim\(\);/.test(html),
    'F3 the admin accordion\'s "In use" chip reads a BLANK seeded field as "the company default", not as an override');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
