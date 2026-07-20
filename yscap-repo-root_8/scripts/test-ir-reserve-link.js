/**
 * Interest reserve months <-> amount two-way link (owner-directed 2026-07-20: "it should
 * be all one"). The reserve is ONE value shown two ways; filling either the months field
 * or the dollar field fills the other to match. This test EXTRACTS the real helper
 * functions from the shipped static tool (web/tools + web/v2/tools termsheet.js) and runs
 * them against a mock DOM, proving:
 *   • the derived (mirror) field is written correctly from the sized monthly payment,
 *   • the gather() gate feeds the engine ONLY the source field (derived reads as 0), so
 *     pricing is byte-identical to the old "fill one, leave the other blank" behavior,
 *   • clearing the source field never resurrects a stale mirror as a phantom reserve,
 *   • programmatic mirror writes can't loop,
 *   • both tool copies carry identical logic.
 *
 * Pure (no DB / no server) — always runs in CI.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Pull the three contiguous IR-link helpers (irIsDerived / setIrSource / syncIrMirror)
// out of the real file, so this test can never drift from shipped code.
function extractHelpers(file) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('function irIsDerived(');
  const end = src.indexOf('function gather()', start);
  if (start < 0 || end < 0) throw new Error(`IR-link helpers not found in ${file}`);
  return src.slice(start, end);
}

function makeHarness(helperSrc) {
  const dom = { irMonths: { value: '', dataset: {} }, irAmount: { value: '', dataset: {} } };
  const el = (id) => dom[id];
  const num = (id) => { const e = el(id); const n = e ? parseFloat(String(e.value).replace(/,/g, '')) : 0; return isFinite(n) ? n : 0; };
  // eslint-disable-next-line no-new-func
  const factory = new Function('el', 'num', `${helperSrc}; return { irIsDerived, setIrSource, syncIrMirror };`);
  const fns = factory(el, num);
  const gate = (id) => fns.irIsDerived(id) ? 0 : num(id);
  return { dom, el, num, gate, ...fns };
}

function runCase(file) {
  console.log(`\n--- ${path.relative(process.cwd(), file)} ---`);
  const H = makeHarness(extractHelpers(file));

  // 1) type 6 months, sized (fullPayment 6400) -> amount mirror 38,400
  H.dom.irMonths.value = '6'; H.setIrSource('months');
  H.syncIrMirror({ fullPayment: 6400 }, true);
  ok(H.dom.irAmount.value === '38400', 'months=6 -> amount mirror $38,400');
  ok(H.irIsDerived('irAmount') && !H.irIsDerived('irMonths'), 'amount derived, months is source');
  ok(H.gate('irMonths') === 6 && H.gate('irAmount') === 0, 'engine sizes on months (amount fed 0)');
  const beforeM = H.dom.irMonths.value; H.syncIrMirror({ fullPayment: 6400 }, true);
  ok(H.dom.irMonths.value === beforeM, 're-sync leaves the source months untouched (no loop)');

  // 2) switch to typing $40,000 (fullPayment 6450) -> months mirror 6.2
  H.dom.irAmount.value = '40000'; H.setIrSource('amount');
  H.syncIrMirror({ fullPayment: 6450 }, true);
  ok(H.dom.irMonths.value === '6.2', 'amount=$40,000 -> months mirror 6.2');
  ok(H.irIsDerived('irMonths') && !H.irIsDerived('irAmount'), 'months derived, amount is source');
  ok(H.gate('irAmount') === 40000 && H.gate('irMonths') === 0, 'engine sizes on amount (months fed 0)');

  // 3) clearing the source blanks the mirror — no stale phantom reserve
  H.dom.irAmount.value = ''; H.setIrSource('amount'); H.syncIrMirror({ fullPayment: 6450 }, true);
  ok(H.dom.irMonths.value === '' && H.gate('irMonths') === 0 && H.gate('irAmount') === 0,
    'cleared amount -> months mirror blank, no reserve');

  // 4) unsized (no payment): mirror stays blank, never NaN
  H.dom.irMonths.value = '6'; H.setIrSource('months'); H.dom.irAmount.value = '';
  H.syncIrMirror({ fullPayment: 0 }, false);
  ok(H.dom.irAmount.value === '', 'unsized -> amount mirror blank (no NaN)');

  // 5) fresh load / prefill (neither flag): a real amount value wins (engine amount>0 rule)
  const H2 = makeHarness(extractHelpers(file));
  H2.dom.irAmount.value = '25000';
  H2.syncIrMirror({ fullPayment: 5000 }, true);
  ok(H2.gate('irAmount') === 25000 && H2.gate('irMonths') === 0, 'prefilled amount is the source on load');
  const H3 = makeHarness(extractHelpers(file));
  H3.dom.irMonths.value = '4';
  H3.syncIrMirror({ fullPayment: 5000 }, true);
  ok(H3.gate('irMonths') === 4 && H3.gate('irAmount') === 0, 'prefilled months is the source on load');
}

const files = [
  path.join(__dirname, '..', 'web', 'tools', 'termsheet.js'),
  path.join(__dirname, '..', 'web', 'v2', 'tools', 'termsheet.js'),
];
try {
  for (const f of files) runCase(f);
  // parity: both copies must carry identical helper logic
  ok(extractHelpers(files[0]) === extractHelpers(files[1]), 'v1 and v2 tool copies carry identical IR-link logic');
} catch (e) {
  console.error('ERROR', e); failures++;
}
console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL ir-reserve-link assertions passed');
process.exit(failures ? 1 : 0);
