/**
 * Interest reserve months <-> dollars: THE BOX MUST STATE WHAT THE LOAN CARRIES.
 *
 * Owner-directed 2026-07-20 ("it should be all one"): the reserve is ONE value shown
 * two ways; filling either the months field or the dollar field fills the other.
 *
 * Owner-reported 2026-07-30 (the DISPLAY-TRUTH bug this file now pins): "I'm putting in
 * 12 months reserve, right next to it the box converts to $186,000 — but the Excel
 * structure gives me $210,000 interest reserve." The dollar box was an INDEPENDENT
 * ESTIMATE (months x monthly payment) while the structure carried the engine's
 * `financedIR`. Everything between the request and the structure moves that number:
 * the leverage ceilings (`reserveCapped`/`reserveCapBy`), the loan term
 * (`reserveTermCapped`), Gold's ZERO-on-renovation and LOCKED 75%-of-term ground-up
 * reserve (`irLocked` — which finances MORE than a smaller request, the owner's own
 * direction), and the frozen whole-dollar breakdown reconciliation.
 *
 * This test EXTRACTS the real helper functions from the shipped static tool
 * (web/tools + web/v2/tools termsheet.js) and runs them against a mock DOM, proving:
 *   • the DISPLAYED dollar figure IS the engine's financedIR — asserted against deals
 *     built from the REAL frozen engines (Standard, Gold reno, Gold ground-up, Silver),
 *     including a capped one, an amount-driven entry and a months-driven entry,
 *   • each of those assertions FAILS under the OLD months x payment behavior (the
 *     legacy implementation is re-run in-process as a mutation proof, so a revert
 *     cannot pass this file),
 *   • the capped / zero / locked cases EXPLAIN themselves next to the field in the
 *     engine's own words,
 *   • the gather() gate still feeds the engine ONLY the source field (a derived field
 *     reads as 0), so pricing is byte-identical to the old behavior — FROZEN CONTRACT,
 *   • the SOURCE field is never overwritten by the mirror,
 *   • clearing the source field never resurrects a stale mirror as a phantom reserve,
 *   • programmatic mirror writes can't loop,
 *   • both tool copies carry identical logic,
 *   • the reserve entry is never pre-filled on either copy (owner-directed).
 *
 * Pure (no DB / no server) — always runs in CI.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const YSP = require(path.join(ROOT, 'web', 'v2', 'tools', 'standard-program.js'));
const GSP = require(path.join(ROOT, 'web', 'v2', 'tools', 'gold-standard.js'));
const SVP = require(path.join(ROOT, 'web', 'v2', 'tools', 'silver-program.js'));

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Pull the reserve-link helpers (irIsDerived … syncIrMirror) out of the real file, so
// this test can never drift from shipped code.
function extractHelpers(file) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('function irIsDerived(');
  const end = src.indexOf('function gather()', start);
  if (start < 0 || end < 0) throw new Error(`IR-link helpers not found in ${file}`);
  return src.slice(start, end);
}

/* ------------------------------------------------------------------ *
 * THE LEGACY (pre-fix) mirror, verbatim — the behavior this fix
 * replaced. Every new assertion below is re-run against it to prove
 * the assertion would FAIL if the old estimate were restored.
 * ------------------------------------------------------------------ */
function legacySyncIrMirror(el, num, d, sized) {
  const m = el('irMonths'), a = el('irAmount');
  if (!m || !a) return;
  const pay = (d && d.fullPayment > 0) ? d.fullPayment : 0;
  const amountIsSource = (a.dataset.derived === '1') ? false
    : (m.dataset.derived === '1') ? true
      : num('irAmount') > 0;
  if (amountIsSource) {
    m.dataset.derived = '1'; delete a.dataset.derived;
    const mo = (sized && pay > 0) ? (num('irAmount') / pay) : 0;
    const mv = mo > 0 ? String(Math.round(mo * 10) / 10) : '';
    if (m.value !== mv) m.value = mv;
  } else {
    a.dataset.derived = '1'; delete m.dataset.derived;
    const amt = (sized && pay > 0 && num('irMonths') > 0) ? Math.round(num('irMonths') * pay) : 0;
    const av = amt > 0 ? String(amt) : '';
    if (a.value !== av) a.value = av;
  }
}

function makeHarness(helperSrc) {
  const dom = {
    irMonths: { value: '', dataset: {} },
    irAmount: { value: '', dataset: {} },
    // The truth line the studio HTML renders under the pair (id="irFinNote").
    irFinNote: { textContent: '', style: { display: 'none' } },
  };
  const el = (id) => dom[id];
  const num = (id) => { const e = el(id); const n = e ? parseFloat(String(e.value).replace(/,/g, '')) : 0; return isFinite(n) ? n : 0; };
  // eslint-disable-next-line no-new-func
  const factory = new Function('el', 'num', `${helperSrc}; return { irIsDerived, setIrSource, syncIrMirror, irRequestText, irFinanced, irNoteText };`);
  const fns = factory(el, num);
  const gate = (id) => fns.irIsDerived(id) ? 0 : num(id);
  const legacy = (d, sized) => legacySyncIrMirror(el, num, d, sized);
  return { dom, el, num, gate, legacy, ...fns };
}

/* ------------------------------------------------------------------ *
 * REAL deals from the FROZEN engines, shaped exactly like the studio's
 * calc()/calcGold()/calcSilver() do. The floor + reconcile below is the
 * frozen reported-figure rule (CLAUDE.md 2026-07-09): the total, the
 * initial and the holdback are floored and the financed reserve absorbs
 * the residual — the same four lines src/lib/pricing.js normalize() runs.
 * ------------------------------------------------------------------ */
function dealFrom(ENG, inp, flags) {
  const R = ENG.evaluate(inp);
  if (R.available === false) return null;
  const s = R.sizing || {};
  const totalLoan = Math.floor(s.totalLoan || 0);
  const rehabHoldback = Math.floor(s.rehabLoan || 0);
  let initialAdvance = Math.floor(s.acquisition || 0);
  let financedIR = 0;
  if ((s.financedIR || 0) > 0.5) financedIR = Math.max(0, totalLoan - initialAdvance - rehabHoldback);
  else initialAdvance = Math.max(0, totalLoan - rehabHoldback);
  return Object.assign({
    R,
    totalLoan,
    term: inp.term,
    irMonths: inp.irMonths || 0,
    financedIR,
    fullPayment: s.fullPayment != null ? Number(s.fullPayment) : 0,
    reserveCapped: !!s.reserveCapped,
    reserveCapBy: s.reserveCapBy || '',
    maxReserve: s.maxReserve || 0,
    irLocked: !!R.irLocked,
    irRequired: !!R.irRequired,
  }, flags || {});
}

const SILVER_CAPPED_INPUT = {
  loanType: 'Refinance', cashOut: false, strategy: 'Ground-up', state: 'NY', zip: '12201', city: 'Albany',
  address: '', propertyType: 'single family', fico: 700, expFlips: 0, expHolds: 0, expGround: 2,
  purchasePrice: 600000, asIsValue: 700000, arv: 1500000, rehabBudget: 500000, term: 18, irMonths: 12,
  accrual: 'Non-Dutch', sqftAddition: false, heavyRehab: false, isAssignment: false, sellerPrice: 0,
};
const STD_UNCAPPED_INPUT = Object.assign({}, SILVER_CAPPED_INPUT, {
  loanType: 'Purchase', purchasePrice: 300000, asIsValue: 320000, arv: 900000, rehabBudget: 200000, irMonths: 6,
});
const GOLD_GROUNDUP_INPUT = {
  loanType: 'Purchase', cashOut: false, strategy: 'Ground-up', state: 'PA', zip: '19103', city: 'Philadelphia',
  address: '', propertyType: 'single family', fico: 740, expFlips: 0, expHolds: 0, expGround: 3,
  purchasePrice: 400000, asIsValue: 420000, arv: 1200000, rehabBudget: 450000, term: 18, irMonths: 12,
  accrual: 'Non-Dutch', sqftAddition: false, heavyRehab: false, isAssignment: false, sellerPrice: 0,
};
const GOLD_RENO_INPUT = Object.assign({}, GOLD_GROUNDUP_INPUT, {
  strategy: 'Fix & Flip', purchasePrice: 500000, asIsValue: 520000, arv: 900000, rehabBudget: 200000,
  term: 12, irMonths: 12, expFlips: 5,
});
// Amount-driven entry that CANNOT be financed in full on Silver.
const SILVER_AMOUNT_INPUT = Object.assign({}, SILVER_CAPPED_INPUT, { irMonths: 0, irAmount: 200000 });

/* ------------------------------------------------------------------ *
 * The battery: engine deal + how it is entered + what must be shown.
 * ------------------------------------------------------------------ */
function battery() {
  const silverCapped = dealFrom(SVP, SILVER_CAPPED_INPUT, { silver: true });
  const silverAmount = dealFrom(SVP, SILVER_AMOUNT_INPUT, { silver: true });
  const stdFits = dealFrom(YSP, STD_UNCAPPED_INPUT, {});
  // The studio zeroes the requested months on a Gold RENOVATION before pricing
  // (frozen: Gold finances no reserve on a renovation) — mirror that here.
  const goldReno = dealFrom(GSP, Object.assign({}, GOLD_RENO_INPUT, { irMonths: 0 }), { gold: true });
  const goldGround = dealFrom(GSP, GOLD_GROUNDUP_INPUT, { gold: true });
  return [
    {
      name: 'Silver ground-up NY — 12 months requested, reserve CAPPED by the ARV ceiling',
      d: silverCapped, prog: 'Silver Program', source: 'months', months: '12',
      wantNote: /12 months requested; \$60,000 financed on the Silver Program — capped by the 70% after-repair-value ceiling\./,
    },
    {
      name: 'Standard ground-up — 6 months, the reserve FITS (no note needed)',
      d: stdFits, prog: 'Standard Program', source: 'months', months: '6', wantNote: null,
    },
    {
      name: 'Gold RENOVATION — reserve is always ZERO (frozen)',
      d: goldReno, prog: 'Gold Standard Program', source: 'months', months: '12',
      wantNote: /12 months requested; \$0 financed on the Gold Standard Program — this program finances no interest reserve on a renovation loan\./,
    },
    {
      name: 'Gold GROUND-UP — reserve LOCKED at 75% of term (finances MORE than asked)',
      d: goldGround, prog: 'Gold Standard Program', source: 'months', months: '12',
      wantNote: /12 months requested; \$80,471 financed on the Gold Standard Program — this program sets the construction reserve at 13\.5 months \(75% of the 18-month term\)/,
    },
    {
      name: 'Silver — AMOUNT-driven $200,000 entry, capped',
      d: silverAmount, prog: 'Silver Program', source: 'amount', amount: '200000',
      wantNote: /\$200,000 requested; \$112,500 financed on the Silver Program — capped by the 70% after-repair-value ceiling\./,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * THE CORE ASSERTION — the displayed figure equals the engine's
 * financedIR, and would NOT under the old estimate.
 * ------------------------------------------------------------------ */
function runBattery(file, label) {
  battery().forEach((c) => {
    if (!c.d) { ok(false, `${label}: engine produced no deal for "${c.name}"`); return; }
    const H = makeHarness(extractHelpers(file));
    if (c.source === 'amount') { H.dom.irAmount.value = c.amount; H.setIrSource('amount'); }
    else { H.dom.irMonths.value = c.months; H.setIrSource('months'); }
    H.syncIrMirror(c.d, true, c.prog);

    if (c.source === 'months') {
      // THE BOX IS THE FINANCED RESERVE.
      ok(H.dom.irAmount.value === String(c.d.financedIR),
        `${label}: ${c.name} → dollar box is the financed reserve $${c.d.financedIR} (got "${H.dom.irAmount.value}")`);
      ok(H.dom.irMonths.value === c.months, `${label}: ${c.name} → the SOURCE months field is untouched`);
      ok(H.gate('irMonths') === Number(c.months) && H.gate('irAmount') === 0,
        `${label}: ${c.name} → engine still sizes on months only (FROZEN input contract)`);
      // MUTATION PROOF: the old months x payment estimate on the SAME deal.
      const L = makeHarness(extractHelpers(file));
      L.dom.irMonths.value = c.months; L.setIrSource('months');
      L.legacy(c.d, true);
      const legacyVal = L.dom.irAmount.value;
      const legacyWouldPass = legacyVal === String(c.d.financedIR);
      if (c.name.indexOf('FITS') > -1) {
        ok(legacyWouldPass, `${label}: ${c.name} → an UNCAPPED deal is the one case both agree on (control)`);
      } else {
        ok(!legacyWouldPass,
          `${label}: ${c.name} → the OLD estimate ("${legacyVal}") FAILS this assertion — revert-proof`);
      }
    } else {
      // Amount is the source: the months mirror must describe the FINANCED reserve.
      const wantMo = String(Math.round((c.d.financedIR / c.d.fullPayment) * 10) / 10);
      ok(H.dom.irMonths.value === wantMo,
        `${label}: ${c.name} → months mirror is the financed reserve's months ${wantMo} (got "${H.dom.irMonths.value}")`);
      ok(H.dom.irAmount.value === c.amount, `${label}: ${c.name} → the SOURCE dollar field is untouched`);
      ok(H.gate('irAmount') === Number(c.amount) && H.gate('irMonths') === 0,
        `${label}: ${c.name} → engine still sizes on the amount only (FROZEN input contract)`);
      const L = makeHarness(extractHelpers(file));
      L.dom.irAmount.value = c.amount; L.setIrSource('amount');
      L.legacy(c.d, true);
      ok(L.dom.irMonths.value !== wantMo,
        `${label}: ${c.name} → the OLD estimate ("${L.dom.irMonths.value}") FAILS this assertion — revert-proof`);
    }

    // The capped / zero / locked case EXPLAINS itself, in the engine's own words.
    const note = H.dom.irFinNote.textContent;
    if (c.wantNote) {
      ok(c.wantNote.test(note), `${label}: ${c.name} → the field says why: "${note}"`);
      ok(H.dom.irFinNote.style.display === '', `${label}: ${c.name} → the explanation is visible`);
    } else {
      ok(note === '' && H.dom.irFinNote.style.display === 'none',
        `${label}: ${c.name} → nothing to explain, so no note (got "${note}")`);
    }
  });
}

function runCase(file) {
  console.log(`\n--- ${path.relative(process.cwd(), file)} ---`);
  const H = makeHarness(extractHelpers(file));

  // 1) type 6 months on a sized deal financing $38,000 -> the box shows $38,000,
  //    NOT 6 x the payment.
  H.dom.irMonths.value = '6'; H.setIrSource('months');
  H.syncIrMirror({ fullPayment: 6400, financedIR: 38000 }, true);
  ok(H.dom.irAmount.value === '38000', 'months=6 -> the box shows the FINANCED $38,000 (not 6 x 6,400 = 38,400)');
  ok(H.irIsDerived('irAmount') && !H.irIsDerived('irMonths'), 'amount derived, months is source');
  ok(H.gate('irMonths') === 6 && H.gate('irAmount') === 0, 'engine sizes on months (amount fed 0)');
  const beforeM = H.dom.irMonths.value; H.syncIrMirror({ fullPayment: 6400, financedIR: 38000 }, true);
  ok(H.dom.irMonths.value === beforeM, 're-sync leaves the source months untouched (no loop)');

  // 2) switch to typing $40,000; only $32,250 fits -> the months mirror describes
  //    what is FINANCED (32,250 / 6,450 = 5), not what was asked for.
  H.dom.irAmount.value = '40000'; H.setIrSource('amount');
  H.syncIrMirror({ fullPayment: 6450, financedIR: 32250 }, true);
  ok(H.dom.irMonths.value === '5', 'amount=$40,000 with $32,250 financed -> months mirror 5');
  ok(H.dom.irAmount.value === '40000', 'the source dollar entry is never overwritten');
  ok(H.irIsDerived('irMonths') && !H.irIsDerived('irAmount'), 'months derived, amount is source');
  ok(H.gate('irAmount') === 40000 && H.gate('irMonths') === 0, 'engine sizes on amount (months fed 0)');

  // 3) clearing the source blanks the mirror — no stale phantom reserve
  H.dom.irAmount.value = ''; H.setIrSource('amount'); H.syncIrMirror({ fullPayment: 6450, financedIR: 32250 }, true);
  ok(H.dom.irMonths.value === '' && H.gate('irMonths') === 0 && H.gate('irAmount') === 0,
    'cleared amount -> months mirror blank, no reserve');

  // 4) unsized (no payment): mirror stays blank, never NaN
  H.dom.irMonths.value = '6'; H.setIrSource('months'); H.dom.irAmount.value = '';
  H.syncIrMirror({ fullPayment: 0, financedIR: 0 }, false);
  ok(H.dom.irAmount.value === '', 'unsized -> amount mirror blank (no NaN)');
  ok(H.dom.irFinNote.textContent === '', 'unsized -> no note (nothing is known yet)');

  // 5) fresh load / prefill (neither flag): a real amount value wins (engine amount>0 rule)
  const H2 = makeHarness(extractHelpers(file));
  H2.dom.irAmount.value = '25000';
  H2.syncIrMirror({ fullPayment: 5000, financedIR: 25000 }, true);
  ok(H2.gate('irAmount') === 25000 && H2.gate('irMonths') === 0, 'prefilled amount is the source on load');
  const H3 = makeHarness(extractHelpers(file));
  H3.dom.irMonths.value = '4';
  H3.syncIrMirror({ fullPayment: 5000, financedIR: 20000 }, true);
  ok(H3.gate('irMonths') === 4 && H3.gate('irAmount') === 0, 'prefilled months is the source on load');

  // 6) irRequestText() is the ONE way a surface prints "what was asked for" — it reads
  //    the SOURCE only, so the financed figure sitting in the mirror can never be
  //    printed under a "requested" label (the Excel / PDF / manual-review class).
  const H4 = makeHarness(extractHelpers(file));
  H4.dom.irMonths.value = '12'; H4.setIrSource('months');
  H4.syncIrMirror({ fullPayment: 8859.37, financedIR: 60000 }, true);
  ok(H4.dom.irAmount.value === '60000', 'capped deal: the box carries the financed $60,000');
  ok(H4.irRequestText() === '12 months', 'irRequestText() reports the REQUEST (12 months), not the mirror');
  H4.dom.irAmount.value = '75000'; H4.setIrSource('amount');
  ok(H4.irRequestText() === '$75,000', 'irRequestText() reports an amount-driven request as dollars');
  const H5 = makeHarness(extractHelpers(file));
  ok(H5.irRequestText() === '', 'irRequestText() is empty when no reserve was requested');
}

const files = [
  path.join(__dirname, '..', 'web', 'tools', 'termsheet.js'),
  path.join(__dirname, '..', 'web', 'v2', 'tools', 'termsheet.js'),
];
/**
 * THE INTEREST-RESERVE ENTRY IS NEVER PRE-FILLED, ON EITHER TOOL COPY
 * (owner-directed 2026-07-30, reported live: selecting ground-up construction
 * silently filled the reserve with the whole 18-month term). "You can default
 * the term but you don't default the interest reserve … it needs to be updated
 * on tech in all the programs." Both copies are served (V2 at /, V1 at /v1), so
 * a fix on one is not a fix.
 *
 * This reads the SHIPPED deal-type-change block out of each file and asserts the
 * shape directly: the block still defaults the TERM to 18 for ground-up, and it
 * contains NO assignment to irMonths / irAmount. Deliberately a source-shape
 * assertion rather than a DOM replay — the block is wired into updateConditionals
 * (dozens of unrelated DOM dependencies), and what must never come back is
 * precisely the *presence* of a reserve write on that path.
 */
function assertNoReservePrefill(file) {
  const src = fs.readFileSync(file, 'utf8');
  const label = path.basename(path.dirname(path.dirname(file))) === 'v2' ? 'v2' : 'v1';
  const start = src.indexOf('var dt = dealType();');
  ok(start > 0, `${label}: the deal-type-change block is present`);
  // The block runs from `var dt = dealType();` to the end of its `lastDeal = dt;` guard.
  const end = src.indexOf('lastDeal = dt;', start);
  ok(end > start, `${label}: the deal-type-change block is intact`);
  const block = src.slice(start, end);
  ok(/nowGround/.test(block) && /tsTerm/.test(block) && /18/.test(block),
    `${label}: ground-up still defaults the TERM to 18 months`);
  // The regression itself: ANY write to the reserve entry on this path. Deliberately
  // broad — an audit mutation-tested the first version and it missed four realistic
  // re-introductions (a two-line write via an intermediate variable, a non-numeric
  // right-hand side, a forEach over the ids, and setAttribute). So instead of
  // pattern-matching the write, assert the block never MENTIONS the reserve fields at
  // all: this path has no legitimate reason to name them, which makes the check
  // whole-class rather than a race against wording. (The bridge-clearing branch that
  // legitimately blanks them lives ABOVE this block and is outside the slice.)
  const mentionsReserve = /\b(irMonths|irAmount)\b/.test(block);
  ok(!mentionsReserve,
    `${label}: the ground-up path never touches the interest-reserve entry (no write of any form)`);
  // …and the stale comment promising a pre-filled reserve must be gone too.
  ok(!/pre-fill a full-term financed reserve/.test(src),
    `${label}: the stale "pre-fill a full-term financed reserve" comment is gone`);
}

/**
 * NO SURFACE MAY PRINT A months x payment RESERVE ESTIMATE (whole-class guard).
 * The bug was one wrong expression copied into a display; the fix is that the
 * ONLY reserve figure any surface prints is `financedIR` / `financedReserve`, and
 * the only "requested" text comes from irRequestText(). A raw read of the dollar
 * BOX is now a lie by construction — it holds the financed figure — so the two
 * raw-read shapes are banned outright in the shipped tools.
 */
function assertNoEstimateSurfaces(file) {
  const src = fs.readFileSync(file, 'utf8');
  const label = path.basename(path.dirname(path.dirname(file))) === 'v2' ? 'v2' : 'v1';
  ok(!/irMonths"\)\s*\*\s*pay/.test(src) && !/num\("irMonths"\)\s*\*/.test(src),
    `${label}: no months x payment reserve estimate anywhere in the tool`);
  // A raw `num("irAmount")` may appear ONLY inside the reserve-link helpers (which
  // own the source/derived gate) and in gather()'s own gate line.
  const helpers = extractHelpers(file);
  const outside = src.split(helpers).join('');
  const rawReads = (outside.match(/num\("irAmount"\)/g) || []).length;
  ok(rawReads === 1,
    `${label}: the dollar box is read raw in exactly ONE place outside the helpers (gather()'s gate) — found ${rawReads}`);
}

try {
  for (const f of files) runCase(f);
  console.log('\n--- engine-driven battery (real Standard / Gold / Silver deals) ---');
  runBattery(files[1], 'v2');
  runBattery(files[0], 'v1');
  // parity: both copies must carry identical helper logic
  ok(extractHelpers(files[0]) === extractHelpers(files[1]), 'v1 and v2 tool copies carry identical IR-link logic');
  for (const f of files) assertNoReservePrefill(f);
  for (const f of files) assertNoEstimateSurfaces(f);
} catch (e) {
  console.error('ERROR', e); failures++;
}
console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL ir-reserve-link assertions passed');
process.exit(failures ? 1 : 0);
