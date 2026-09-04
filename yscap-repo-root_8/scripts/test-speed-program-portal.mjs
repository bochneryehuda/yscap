/* =====================================================================
   THE SPEED PROGRAM REACHES EVERY app-v2 SURFACE SILVER REACHES (2026-09-03).

   Speed is the fourth RTL pricing program — the composition of Standard and
   Silver (the lesser leverage, the higher rate, a 10% assignment share). It is
   NOT an engine of its own and, by owner decision, has NO markup/origination
   knob, sticky per-file markup or column. What this proves about the portal:

     A. ONE label map. `programLabel()` names all five keys (the four programs +
        Manual) in both forms, and an unknown/blank key still reads as Standard —
        the fallback every replaced ternary chain ended on. And no chain is left:
        a source walk finds no `=== 'silver' ? 'Silver…'` anywhere in app-v2/src.
     B. The registered-product panel RENDERS a Speed quote: the heading says
        "Speed Program", and the "How Speed was composed" block shows both donor
        programs' figures and who set each enforced one, from `quote.speed`.
     C. The assignment row prints the share the quote was SIZED at — "10%" when
        `assignment.maxPct` is 0.10, "15%" when 0.15 — and a quote registered
        before the field existed still says 15% (that is the only share it can
        have been sized at).
     D. The Pricing Admin Center offers a Speed ON/OFF switch and NO Speed markup
        field or markup-tier row: the switch list and the knob grid are derived
        from ONE program list and a `hasKnobs` flag, never two hand-kept lists. Speed
        carries its own knobs since the owner reversed decision D5 on 2026-09-03.
     E. The studio bridge: an active `#pcardSpeed` reads as program 'speed', the
        chosen quote `d` is the studio's own `_calcSpeed()`, the snapshot carries
        `speed` beside `silver`, and the selection label is "Speed Program".
        Speed's minimum interest follows EITHER donor's checkbox (no own box).

   B–E bundle and RUN the real components (esbuild, JSX, react-dom/server)
   rather than reading their source, because a label map that exists and a
   panel that never calls it look identical to a grep. Skips cleanly when the
   app-v2 toolchain is not installed (CI installs the repo root only).

   Run: node scripts/test-speed-program-portal.mjs
   ===================================================================== */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'app-v2');
const ESBUILD = join(APP, 'node_modules', '.bin', 'esbuild');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/* ── A2. no ternary chain survives, anywhere in the RTL front end ──────────── */
console.log('--- A. one label map, no leftover chains ---');
{
  const hits = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== 'longterm' && e !== 'node_modules') walk(p); continue; }
      if (!/\.(jsx?|mjs)$/.test(e)) continue;
      // COMMENT-STRIPPED: the label module's own header necessarily NAMES the chain
      // it replaced, and a guard that read comments would fail on its own explanation.
      const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      if (/===\s*'silver'\s*\?\s*'Silver/.test(src) || /===\s*'gold'\s*\?\s*'Gold/.test(src)) hits.push(p.slice(ROOT.length + 1));
    }
  })(join(APP, 'src'));
  assert(hits.length === 0, `no hand-written program-label ternary chain remains in app-v2/src${hits.length ? ' — ' + hits.join(', ') : ''}`);
}

if (!existsSync(ESBUILD)) {
  console.log('(skipping the rendered checks — app-v2 esbuild not installed)');
  console.log(failures ? `test-speed-program-portal FAILED (${failures})` : 'test-speed-program-portal: all checks passed');
  process.exit(failures ? 1 : 0);
}

// The entry lives INSIDE app-v2/node_modules so a bare `import 'react'` resolves to the
// app's own packages (a /tmp entry cannot see them); `bundle-hash` skips node_modules,
// so this never disturbs the committed-bundle stamp.
const cacheDir = join(APP, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const tmp = mkdtempSync(join(cacheDir, 'speed-portal-'));
try {
  const entry = join(tmp, 'entry.mjs');
  writeFileSync(entry, `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { programLabel, PROGRAM_LABEL, PROGRAM_SHORT, PRICING_PROGRAM_KEYS } from ${JSON.stringify(join(APP, 'src/lib/programLabel.js'))};
import { RegisteredProductDetails, termOptionsFromSnapshot } from ${JSON.stringify(join(APP, 'src/components/ProductStudioPanel.jsx'))};
import { readSnapshot, selectionFromSnapshot } from ${JSON.stringify(join(APP, 'src/components/TermSheetStudio.jsx'))};
import { ProgramSwitches, MarkupTierGrid, PROGRAMS, KNOB_PROGRAMS } from ${JSON.stringify(join(APP, 'src/screens/StaffCompanyPricing.jsx'))};
import { dealPurchase } from ${JSON.stringify(join(APP, 'src/lib/dealPrice.js'))};
globalThis.__out = { React, renderToStaticMarkup, programLabel, PROGRAM_LABEL, PROGRAM_SHORT, PRICING_PROGRAM_KEYS,
  RegisteredProductDetails, termOptionsFromSnapshot, readSnapshot, selectionFromSnapshot,
  ProgramSwitches, MarkupTierGrid, PROGRAMS, KNOB_PROGRAMS, dealPurchase };
`);
  const bundle = join(tmp, 'bundle.cjs');
  execFileSync(ESBUILD, [entry, '--bundle', '--platform=node', '--format=cjs',
    '--loader:.js=jsx', '--jsx=automatic', `--outfile=${bundle}`],
  { cwd: APP, stdio: ['ignore', 'ignore', 'pipe'] });
  const require_ = createRequire(import.meta.url);
  require_(bundle);
  const O = globalThis.__out;
  const html = (el) => O.renderToStaticMarkup(el);
  const h = O.React.createElement;

  /* ── A1. the label map ─────────────────────────────────────────────────── */
  eq(O.programLabel('speed'), 'Speed Program', 'programLabel(speed) is the Speed Program');
  eq(O.programLabel('speed', { short: true }), 'Speed', 'short form is "Speed"');
  // The existing keys, byte-for-byte what the chains printed.
  eq(O.programLabel('standard'), 'Standard Program', 'standard');
  eq(O.programLabel('gold'), 'Gold Standard Program', 'gold');
  eq(O.programLabel('silver'), 'Silver Program', 'silver');
  eq(O.programLabel('manual'), 'Manual Program', 'manual');
  eq([O.programLabel('standard', { short: true }), O.programLabel('gold', { short: true }), O.programLabel('silver', { short: true }), O.programLabel('manual', { short: true })].join('|'),
    'Standard|Gold Standard|Silver|Manual', 'the four short forms');
  eq(O.programLabel(''), 'Standard Program', 'a blank key falls back to Standard, as every chain did');
  eq(O.programLabel(null), 'Standard Program', 'a null key too');
  eq(O.programLabel('bronze'), 'Standard Program', 'an unknown key too');
  eq(O.programLabel('bronze', { short: true }), 'Standard', 'and in short form');
  eq(O.PRICING_PROGRAM_KEYS.join(','), 'standard,gold,silver,speed,manual', 'the five keys, in studio order');
  assert(Object.isFrozen(O.PROGRAM_LABEL) && Object.isFrozen(O.PROGRAM_SHORT), 'the maps are frozen — nobody patches a label at runtime');
  assert(!/EMCAP|Fidelis|Blue ?Lake/i.test(JSON.stringify(O.PROGRAM_LABEL) + JSON.stringify(O.PROGRAM_SHORT)), 'no label names a note buyer');

  /* ── B + C. the registered-product panel on a Speed quote ─────────────── */
  console.log('\n--- B. the panel renders a Speed registration with its composition ---');
  /* `ceiling` = what that parent PRICED this deal at; `ownCeiling` = its published
     guideline row, which is the column the panel shows and which never carries one of
     this program's overlays (the 2026-09-03 report). They are deliberately DIFFERENT
     here so a panel that read the wrong one is caught. */
  const speedBlock = {
    maxLoanCap: 800000, maxLtcCap: 0.90, assignmentMaxPct: 0.10, rateDonor: 'silver',
    financedReserveAllowed: false,
    overlays: [
      { key: 'max_loan', label: 'Maximum loan', value: '$800,000' },
      { key: 'max_ltc', label: 'Maximum loan-to-cost', value: '90%' },
      { key: 'no_reserve', label: 'Financed interest reserve', value: 'Not allowed' },
      { key: 'assignment', label: 'Assignment fee financeable', value: '10%' },
    ],
    capDonor: { maxLoan: 'speed', maxAcqLTV: 'silver', maxARLTV: 'silver', maxLTC: 'both' },
    standard: { status: 'ELIGIBLE', tier: 1, tierLabel: 'Tier 1', noteRate: 0.1025, totalLoan: 510000, initialAdvance: 400000,
      ceiling: { maxLoan: 2000000, maxAcqLTV: 0.90, maxARLTV: 0.75, maxLTC: 0.90 },
      ownCeiling: { maxLoan: 2500000, maxAcqLTV: 0.90, maxARLTV: 0.75, maxLTC: 0.925 } },
    silver: { status: 'ELIGIBLE', tier: 2, tierLabel: 'Tier 2', noteRate: 0.1075, totalLoan: 495000, initialAdvance: 385000,
      ceiling: { maxLoan: 1500000, maxAcqLTV: 0.85, maxARLTV: 0.70, maxLTC: 0.90 },
      ownCeiling: { maxLoan: 4500000, maxAcqLTV: 0.90, maxARLTV: 0.75, maxLTC: 0.925 } },
  };
  const baseQuote = (over) => ({
    program: 'speed', programLabel: 'Speed Program', status: 'ELIGIBLE', eligible: true, noteRate: 0.1075,
    sizing: { totalLoan: 495000, initialAdvance: 385000, rehabHoldback: 110000, downPayment: 60000, ltcPct: 0.9, acqLtvPct: 0.85, arvPct: 0.70 },
    closingCosts: { dueAtClosing: 9000, creditFee: 150, titleAndSettlement: 2500, lenderFee: 2195, appraisalPoc: 800, totalIncludingPoc: 9800 },
    cashToClose: 69000, liquidity: 90000, reserveRequirement: 21000,
    guidelines: { caps: { maxLtc: 0.9, maxArvLtv: 0.7, maxAcqLtv: 0.85 } },
    ...over,
  });
  const reg = (program, quote, inputs) => ({
    id: 1, program, status: 'ELIGIBLE', created_at: '2026-09-03T12:00:00Z', total_loan: 495000, note_rate: 0.1075,
    quote, inputs: { strategy: 'Fix & Flip', loanType: 'Purchase', purchasePrice: 400000, asIsValue: 400000, arv: 700000, rehabBudget: 110000, fico: 720, term: 12, ...inputs },
  });

  const speedHtml = html(h(O.RegisteredProductDetails, {
    reg: reg('speed', baseQuote({ speed: speedBlock, assignment: { maxPct: 0.10, overLimit: true, recognizedPrice: 440000, sellerPrice: 400000, fee: 60000 } }),
      { isAssignment: true, purchasePrice: 460000, sellerPrice: 400000 }),
    showAdmin: true,
  }));
  assert(/<strong>Speed Program<\/strong>/.test(speedHtml), 'the heading names the Speed Program');
  assert(/data-speed-composition="1"/.test(speedHtml) && /How Speed was composed/.test(speedHtml), 'the "How Speed was composed" block renders on a Speed quote');
  /* SECTION 1 shows each program's OWN row — $2,500,000 and $4,500,000, not the pinned
     ceilings and never Speed's own $800,000 (owner-reported 2026-09-03). */
  assert(/Max loan — Standard \$2,500,000 · Silver \$4,500,000/.test(speedHtml),
    'max loan: each program\'s OWN maximum in its column, never a Speed overlay');
  assert(!/Max loan — Standard \$800,000|Silver \$800,000/.test(speedHtml), 'the Speed maximum never appears as a parent\'s own figure');
  assert(/\$800,000 · A Speed overlay/.test(speedHtml), 'max loan enforced: $800,000, credited to the overlay and not to a program');
  assert(/Acquisition LTV — Standard 90\.0% · Silver 90\.0%/.test(speedHtml) && /85\.0% · Silver/.test(speedHtml),
    'acquisition LTV: both programs allow 90%, Silver priced 85% and that is what is enforced');
  assert(/Loan-to-cost — Standard 92\.5% · Silver 92\.5%/.test(speedHtml) && /90\.0% · Both \(equal\)/.test(speedHtml),
    'loan-to-cost: both allow 92.5%, and the enforced 90.0% is a percentage — never the maximum-loan overlay reused as a dollar amount');
  assert(!/Loan-to-cost[^<]*<\/span><span class="v">\$/.test(speedHtml), 'the loan-to-cost row never prints a dollar figure');
  /* SECTION 2 — the overlays, their own block. */
  assert(/Section 2/.test(speedHtml) && /data-speed-overlay="max_loan"/.test(speedHtml) && /data-speed-overlay="no_reserve"/.test(speedHtml)
    && /data-speed-overlay="max_ltc"/.test(speedHtml) && /data-speed-overlay="assignment"/.test(speedHtml),
    'the four Speed overlays render as their own section, from the engine\'s list');
  assert(/Not allowed/.test(speedHtml), 'the no-financed-reserve overlay is stated');
  assert(/Rate — Standard 10\.25% · Silver 10\.75%/.test(speedHtml) && /10\.75% · Silver/.test(speedHtml), 'both rates, and the higher (Silver) is the one charged');
  assert(/Assignment fee financeable<\/span><span class="v">10% of the seller’s contract price/.test(speedHtml), 'the 10% assignment share is stated');
  assert(/Standard \$510,000 · Silver \$495,000/.test(speedHtml), 'each donor\'s own loan is there for reference');
  assert(!/EMCAP|Fidelis|Blue ?Lake/i.test(speedHtml), 'the rendered panel never names a note buyer');

  console.log('\n--- C. the assignment row prints the share the quote was sized at ---');
  assert(/fee capped at 10%/.test(speedHtml), 'Speed: "(fee capped at 10%)" when assignment.maxPct is 0.10');
  const silverHtml = html(h(O.RegisteredProductDetails, {
    reg: reg('silver', baseQuote({ program: 'silver', programLabel: 'Silver Program', assignment: { maxPct: 0.15, overLimit: true, recognizedPrice: 460000 } }),
      { isAssignment: true, purchasePrice: 480000, sellerPrice: 400000 }),
  }));
  assert(/fee capped at 15%/.test(silverHtml), 'Silver: "(fee capped at 15%)" when assignment.maxPct is 0.15');
  assert(!/How Speed was composed/.test(silverHtml) && /<strong>Silver Program<\/strong>/.test(silverHtml), 'and a Silver registration shows no composition block');
  const legacyHtml = html(h(O.RegisteredProductDetails, {
    reg: reg('standard', baseQuote({ program: 'standard', programLabel: undefined, assignment: { overLimit: true, recognizedPrice: 460000 } }),
      { isAssignment: true, purchasePrice: 480000, sellerPrice: 400000 }),
  }));
  assert(/fee capped at 15%/.test(legacyHtml), 'a quote registered before maxPct existed still reads 15% — the only share it can have been sized at');
  assert(/<strong>Standard Program<\/strong>/.test(legacyHtml), 'and with no programLabel on the quote, the label map names it from the row');
  // No maxPct on a Speed quote can only be a server that has not landed the field yet — it must not print 10% from the program name.
  const speedNoPct = html(h(O.RegisteredProductDetails, { reg: reg('speed', baseQuote({ speed: speedBlock, assignment: { overLimit: true, recognizedPrice: 440000 } }), { isAssignment: true, purchasePrice: 460000, sellerPrice: 400000 }) }));
  assert(/fee capped at 15%/.test(speedNoPct), 'the share is READ off the quote, never inferred from the program key');
  // The closing desk reads the same share through dealPurchase.
  eq(O.dealPurchase({ is_assignment: true, underlying_contract_price: 400000, assignment_fee: 60000, registered_quote: { assignment: { recognizedPrice: 440000, excessOOP: 20000, maxPct: 0.10 } } }).capPct, '0.1',
    'dealPurchase surfaces the quote\'s capPct (0.10) for the closing desk');
  eq(O.dealPurchase({ is_assignment: true, underlying_contract_price: 400000, assignment_fee: 60000, registered_quote: { assignment: { recognizedPrice: 460000 } } }).capPct, 'null',
    'and null when the quote does not carry one');

  /* ── D. the Pricing Admin Center ────────────────────────────────────────── */
  console.log('\n--- D. Pricing Admin Center: a Speed switch, no Speed knob ---');
  eq(O.PROGRAMS.map((p) => p.key).join(','), 'standard,gold,silver,speed', 'ONE program list carries all four');
  eq(O.KNOB_PROGRAMS.map((p) => p.key).join(','), 'standard,gold,silver,speed', 'and the knob list is DERIVED from it (hasKnobs) — Speed carries its own since the owner reversed D5 on 2026-09-03');
  const avail = Object.fromEntries(O.PROGRAMS.map((p) => [p.key, { on: true, note: '' }]));
  const switchesHtml = html(h('div', null, h(O.ProgramSwitches, { avail, setProgOn: () => {}, setProgNote: () => {} })));
  assert(/data-program-switch="speed"/.test(switchesHtml) && /name="prog-speed"/.test(switchesHtml), 'a Speed ON/OFF switch renders');
  assert(/data-program-switch="silver"/.test(switchesHtml) && /data-program-switch="gold"/.test(switchesHtml) && /data-program-switch="standard"/.test(switchesHtml), 'beside the three it always had');
  assert(!/No markup or origination settings of its own/.test(switchesHtml), 'and the Speed row no longer claims it has no knobs — it has its own');
  const tiers = Object.fromEntries(O.KNOB_PROGRAMS.map((p) => [p.key, { 1: '', 2: '', 3: '' }]));
  const gridHtml = html(h(O.MarkupTierGrid, { tiers, setTier: () => {}, placeholder: 'normal' }));
  assert(/data-markup-tier-row="standard"/.test(gridHtml) && /data-markup-tier-row="gold"/.test(gridHtml) && /data-markup-tier-row="silver"/.test(gridHtml), 'the markup-tier grid has the three knob programs');
  assert(/data-markup-tier-row="speed"/.test(gridHtml) && /Speed/.test(gridHtml), 'and a Speed row, so its per-tier markup is set here like the others');
  const pricingSrc = readFileSync(join(APP, 'src/screens/StaffCompanyPricing.jsx'), 'utf8');
  assert(/markupSpeedPct/.test(pricingSrc) && /origSpeedPct/.test(pricingSrc), 'a Speed markup AND a Speed origination field exist on the screen (retail)');
  assert(/SPEED_MARKUP_HINT\s*=/.test(pricingSrc) && /caps any margin at 1\.00%/.test(pricingSrc) && /hint=\{SPEED_MARKUP_HINT\}/.test(pricingSrc),
    'and the Speed margin box carries the hint saying where a margin above 1.00% is actually earned (Silver\'s engine caps it)');
  // The screen itself iterates PROGRAMS only for the history's "Programs off" column and
  // the discontinued-note lookup — never to draw a knob input.
  assert(!/PROGRAMS\.map\([^]*?<input/.test(pricingSrc.replace(/KNOB_PROGRAMS/g, '').replace(/export function (ProgramSwitches|MarkupTierGrid)[^]*?\n}\n/g, '')), 'no PROGRAMS.map in the screen body draws an input (a knob) for every program');
  assert(/<ProgramSwitches /.test(pricingSrc) && (pricingSrc.match(/<MarkupTierGrid /g) || []).length === 2, 'the screen mounts ONE switch list and the SAME grid component for company + TPO channel');
  assert(/Markup \(Std \/ Gold \/ Silver \/ Speed\)/.test(pricingSrc) && /Orig \(Std \/ Gold \/ Silver \/ Speed\)/.test(pricingSrc), 'the history table shows all four programs\' markup / origination');

  /* ── E. the studio bridge ───────────────────────────────────────────────── */
  console.log('\n--- E. the studio bridge reads the Speed card ---');
  const fakeWin = (activeCard, calcs) => ({
    TS: calcs,
    document: {
      getElementById: (id) => {
        if (id === activeCard) return { classList: { contains: (c) => c === 'pcard-active' } };
        if (/^pcard/.test(id)) return { classList: { contains: () => false } };
        if (id === 'rMissing') return { style: { display: 'none' }, querySelectorAll: () => [] };
        return null;
      },
    },
  });
  const std = { status: 'ELIGIBLE', totalLoan: 510000, rate: 10.25 };
  const silver = { status: 'ELIGIBLE', totalLoan: 495000, rate: 10.75 };
  const speed = { status: 'ELIGIBLE', totalLoan: 495000, rate: 10.75, tierLabel: 'Speed' };
  const calcs = { _calc: () => std, _calcGold: () => { throw new Error('gold off'); }, _calcSilver: () => silver, _calcSpeed: () => speed };
  const snap = O.readSnapshot(fakeWin('pcardSpeed', calcs));
  eq(snap.program, 'speed', 'an active #pcardSpeed reads as program "speed"');
  assert(snap.d === speed, 'the chosen quote `d` is the studio\'s own _calcSpeed()');
  assert(snap.speed === speed && snap.silver === silver && snap.std === std, 'the snapshot carries speed beside std / gold / silver');
  eq(O.selectionFromSnapshot(snap).programLabel, 'Speed Program', 'the saved selection is labelled through the map');
  eq(O.selectionFromSnapshot(snap).program, 'speed', 'and registers as program "speed"');
  const silverSnap = O.readSnapshot(fakeWin('pcardSilver', calcs));
  assert(silverSnap.program === 'silver' && silverSnap.d === silver, 'Silver still reads as Silver');
  const noSpeedCalc = O.readSnapshot(fakeWin('pcardSpeed', { _calc: () => std, _calcGold: () => null, _calcSilver: () => silver }));
  assert(noSpeedCalc.program === 'speed' && noSpeedCalc.d === std && noSpeedCalc.speed == null, 'a studio without _calcSpeed yet degrades to the Standard quote, never throws');
  // Minimum interest: Speed has no checkbox — EITHER donor's checkbox carries.
  const mi = (fields) => O.termOptionsFromSnapshot({ program: 'speed', fields }).minInterestEnabled;
  assert(mi({ tsMinIntStd: true }) === true && mi({ tsMinIntSilver: true }) === true, 'Speed carries the 3-month minimum when Standard OR Silver was given it');
  assert(mi({}) === false && mi({ tsMinIntGold: true }) === false, 'and not otherwise (Gold\'s box is not a donor)');
  assert(O.termOptionsFromSnapshot({ program: 'silver', fields: { tsMinIntStd: true } }).minInterestEnabled === false, 'Silver itself is unchanged: only its own box counts');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\ntest-speed-program-portal FAILED (${failures})` : '\ntest-speed-program-portal: all checks passed');
process.exit(failures ? 1 : 0);
