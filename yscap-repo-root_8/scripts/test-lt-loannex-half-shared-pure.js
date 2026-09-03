'use strict';
/**
 * LONG-TERM — THE LOANNEX HALF IS ONE DEFINITION, MOUNTED BY BOTH ENGINES.
 *
 * ── WHAT THIS PINS, AND WHY IT IS NOT THE RULE ITSELF ──────────────────────
 * The owner, 2026-09-03: *"LoanNEX was perfect, including filtering out the wrong
 * programs by term and by interest-only and by ARM… I told you to copy it from
 * here."* The COMBINED engine narrowed the LoanNEX board on all four dimensions;
 * the GENERAL engine narrowed on the amortization ALONE.
 *
 * ⛔ AND `product-filter.wantFrom` — the RULE — was correct the whole time, which
 * is the part worth remembering. What was written out twice, once per engine, was
 * the CALLER-SIDE PREAMBLE: which request to mirror, and where in it each answer
 * lives. The general engine simply never handed the rule the Lender Price criteria,
 * so the rule sat there answering correctly about a request it had never seen —
 * a right rule fed the wrong input is a dead rule, and no test of the rule can see
 * it. `test-lt-product-filter-pure.js` covers the rule; this covers the preamble,
 * the narrow-then-hold order, and that BOTH engines ask for it rather than keeping
 * a copy.
 *
 * PURE: no network, no database.
 */

const fs = require('fs');
const path = require('path');
const half = require('../src/longterm/pricing/loannex-half');
const productFilter = require('../src/longterm/pricing/product-filter');
const lpModel = require('../src/longterm/lenderprice/search-model');
const nexParse = require('../src/longterm/loannex/parse');

const ROOT = path.join(__dirname, '..');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Comments necessarily NAME what they explain, so a "must not appear" check that
   reads them fails on its own explanation — strip them first. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n── A. WHICH REQUEST IS MIRRORED ──');
{
  const wire = { criteria: { interestOnly: true }, dayLocksCriteria: [30] };
  const stat = { criteria: { interestOnly: false }, dayLocksCriteria: [45] };
  /* ⛔ THE WIRE BODY WINS. The client builds what it POSTs on the tenant's LIVE
     foundation and copies same-typed scalars from the live defaultSearch, so the two
     can genuinely disagree — and the 2026-09-02 audit caught a cut mirroring the
     STATIC one, which would have narrowed LoanNEX to amortising while Lender Price
     was asked for interest-only, on the same search, silently. */
  const a = half.requestToMirror(wire, stat);
  ok(a.lpRequest === wire && a.lpCriteria === wire.criteria,
    'A1 the WIRE body Lender Price actually received is what is mirrored');
  const b = half.requestToMirror(null, stat) || {};
  ok(b.lpRequest === stat && b.lpCriteria === stat.criteria,
    'A2 …and the static build is the fallback when Lender Price failed and there is no wire body');
  ok(half.requestToMirror(null, null).lpRequest === null
    && half.requestToMirror(null, null).lpCriteria === null,
    'A3 with neither, nothing is claimed — the dimension is left un-narrowed rather than guessed');
  /* Resolved INDEPENDENTLY of the body, so a partial answer never costs a dimension. */
  const c = half.requestToMirror({ dayLocksCriteria: [30] }, stat) || {};
  ok(!!(c.lpRequest && c.lpRequest.dayLocksCriteria) && c.lpCriteria === stat.criteria,
    'A4 a wire body with no usable criteria still falls through to the static build’s');
  for (const junk of ['a string', 7, true, [], null, undefined]) {
    const r = half.requestToMirror(junk, junk);
    ok(r.lpRequest === null || typeof r.lpRequest === 'object',
      `A5 ${JSON.stringify(junk) || String(junk)} never becomes a request`);
  }
  /* TOTAL: a mutation can turn any of these null, and reading a property off null CRASHES
     the battery where it stands rather than failing the assertion — a crashing test "fails"
     and looks like proof while reporting a pass rate that means nothing. */
  const crit = (a, b) => (half.requestToMirror(a, b) || {}).lpCriteria || null;
  ok(crit([], { criteria: { interestOnly: true } }) !== null
    && crit([], { criteria: { interestOnly: true } }).interestOnly === true,
    'A6 an ARRAY is not an object here — it falls through rather than being read as one');
}

console.log('\n── B. THE ANSWER IS THE RULE’S, AND A FORCE CAN ONLY NARROW ──');
{
  const sc = { termYears: 30 };
  const wire = { criteria: { interestOnly: true }, dayLocksCriteria: [30] };
  const direct = productFilter.wantFrom(sc, lpModel._internals, { lpCriteria: wire.criteria, lpRequest: wire });
  const via = half.wantFor(sc, lpModel._internals, { wireRequest: wire });
  ok(JSON.stringify(via) === JSON.stringify(direct),
    'B1 with no force, the answer is byte-identical to the rule’s own — this module decides nothing');
  /* ⛔ THE FORCE IS PROVEN ON A DIMENSION THE RULE ANSWERS DIFFERENTLY, and the first cut
     was not. It used `{ amortization: 'fixed' }` — the general engine's own force — and that
     door's rule ALREADY answers `fixed` (amortization is not a supported field there, so
     `wantFrom` falls back to it), so `forced.amortization === 'fixed'` was true whether the
     force was applied before the rule, after it, or not at all. MEASURED: a mutation applying
     the force BEFORE the rule — which makes it a no-op on every dimension — passed. An
     assertion that cannot fail for the reason it names proves nothing.
     `io` is the honest dimension: the rule answers `null` here, so only a real override can
     make it `true`, and only an override applied AFTER the rule survives. */
  const ruleIo = half.wantFor({}, lpModel._internals, {});
  ok(ruleIo.io === null, 'B2a CONTROL: with nothing stated the rule leaves interest-only un-narrowed');
  const forced = half.wantFor({}, lpModel._internals, { force: { io: true } });
  ok(forced.io === true, 'B2 …so a force that overrides it is a force the rule did not already give');
  ok(JSON.stringify(forced.termMonths) === JSON.stringify(ruleIo.termMonths)
    && JSON.stringify(forced.locks) === JSON.stringify(ruleIo.locks)
    && forced.amortization === ruleIo.amortization,
    'B3 …and it touches NOTHING else — every other dimension is still the rule’s answer');
  /* The general engine's OWN force, stated for what it is. Owner-directed: "in the general
     engine, don't enable the ARM feature." It is a NO-OP today, by design — the code says so
     ("belt-and-braces against the day that field is accepted") — so this records that fact
     rather than dressing it up as a guard. */
  const already = half.wantFor({}, lpModel._internals, { force: { amortization: 'fixed' } });
  ok(already.amortization === ruleIo.amortization,
    'B4 the general engine’s own force is a no-op today: the rule already reads that door as fixed');
  ok(JSON.stringify(half.wantFor(sc, lpModel._internals, { wireRequest: wire, force: null })) === JSON.stringify(direct),
    'B5 a null force is not a force');
}

console.log('\n── C. NARROW, THEN HOLD BACK — IN THAT ORDER ──');
{
  const REAL = nexParse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);
  const board = REAL.board || REAL;
  const before = (board.programs || []).length;
  ok(before > 0, `C0 CONTROL: the recorded board carries ${before} programmes to narrow`);

  const want = { amortization: 'fixed', io: false, termMonths: [360], locks: [30] };
  const out = half.narrowAndHold(board, want, { saved: 0.25, extraFor: () => 0 });
  ok(out.board && out.meta, 'C1 a board and its meta come back');
  ok(out.meta.kept <= before, `C2 the narrowing can only ever remove (${before} → ${out.meta.kept})`);
  ok(out.meta.want === want, 'C3 …and the meta carries what the search was read as asking for, not only what fell out');
  /* THE HOLDBACK GOES ON THE NARROWED BOARD, never the raw one — every count, the
     merge, the routing and the option shape then describe the same board. */
  ok(out.board.marginHoldback !== undefined,
    'C4 the holdback is stamped on the board that came OUT of the narrowing');
  const narrowedOnly = productFilter.narrowBoard(board, want);
  ok((out.board.programs || []).length === (narrowedOnly.board.programs || []).length,
    'C5 …and the holdback added or removed no programme of its own');

  /* Every dropped count is reported rather than silent — "209 became 41" with no
     reason is the same silence this filter replaces. */
  for (const k of ['droppedArm', 'droppedIo', 'droppedTerm', 'droppedLock', 'droppedLockRungs', 'unclassified', 'kept']) {
    ok(typeof out.meta[k] === 'number', `C6 ${k} is reported as a number, never left undefined`);
  }
  ok(Array.isArray(out.meta.duplicates) && Array.isArray(out.meta.diverged),
    'C7 …and what the sheet published twice is carried out, so every programme is accounted for');

  /* Caught, because a THROW here would take the battery down where it stands and report a
     pass rate that means nothing — a crashing test "fails" and looks like proof. */
  let none = null; let threw = false;
  try { none = half.narrowAndHold(null, want, {}); } catch (_) { threw = true; }
  ok(!threw && none && none.board === null && none.meta === null && none.detail === null,
    'C8 a vendor that did not answer is a STATE, never a throw');

  /* ⛔ A MEASURED FACT, NOT A GUARD — recorded because the module used to CLAIM the
     narrow-then-hold order was load-bearing and it is not. Run both ways over the real
     recorded board, the output is BYTE-IDENTICAL: `applyToBoard` stamps per option and
     computes nothing aggregate, so nothing it produces depends on which programmes are
     present. The order is kept because the reported counts and the board then describe the
     same set, and because an aggregate added later (a board-level summary, a cheapest-row
     election) must not be computed over programmes that are about to be dropped. If that day
     comes, this assertion is what will start failing — which is the point of recording it. */
  const holdFirst = productFilter.narrowBoard(
    require('../src/longterm/pricing/vendor-margin').applyToBoard(board, 'loannex', { saved: 0.25, extraFor: () => 0 }),
    want,
  ).board;
  ok(JSON.stringify(out.board) === JSON.stringify(holdFirst),
    'C9 MEASURED: with today’s holdback the two orders give the same board — the order is clarity, not correctness');
}

console.log('\n── D. BOTH ENGINES ASK IT — NEITHER KEEPS A COPY ──');
{
  const gb = strip(read('src/longterm/pricing/general-board.js'));
  const cp = strip(read('src/longterm/routes/combined-pricer.js'));
  for (const [name, src] of [['the general board', gb], ['the combined engine', cp]]) {
    ok(/loannexHalf\.wantFor\(/.test(src), `D1 ${name} asks the shared rule which product the search stands for`);
    ok(/loannexHalf\.narrowAndHold\(/.test(src), `D2 ${name} narrows and holds back through the shared door`);
    /* ⛔ THE THREE THINGS THAT MUST NOT COME BACK. Each is one line to re-inline, and
       re-inlining any of them is exactly how the two engines came to narrow differently:
       the preamble that feeds the rule, the narrowing itself, and the LoanNEX holdback. */
    ok(!/wantFrom\(/.test(src), `D3 ${name} keeps no copy of the preamble that feeds the rule`);
    ok(!/narrowBoard\(/.test(src), `D4 ${name} keeps no copy of the narrowing`);
  }
  /* ⛔ THE HOLDBACK IS COUNTED, NOT FORBIDDEN, AND THE COUNT IS PER FILE — because
     `vendor-margin`'s own header depends on being called ONCE PER BOARD PER VENDOR (the
     ladder's points carry no anchor and WOULD drift on a second pass), and because the
     combined router legitimately keeps ONE other LoanNEX call: `POST /loannex/price`, the
     what-if diagnostics door, which prices a board this module never sees. A blanket "must
     not appear" would have to be loosened to admit it, and a loosened guard admits the
     re-inlined one too. */
  const nexCalls = (src) => (src.match(/applyToBoard\([^;]*?'loannex'/g) || []).length;
  ok(nexCalls(gb) === 0,
    'D5 the general board applies the LoanNEX holdback nowhere of its own — the shared door does it');
  ok(nexCalls(cp) === 1,
    `D5b the combined engine keeps exactly ONE, and it is the what-if diagnostics door, not the board (${nexCalls(cp)})`);
  ok(/router\.post\('\/loannex\/price'[\s\S]{0,900}?applyToBoard\([^;]*?'loannex'/.test(cp),
    'D5c …proven to be that door by where it sits, so a re-inlined board call could not pass as it');
  ok((read('src/longterm/pricing/loannex-half.js').match(/applyToBoard\([^;]*?'loannex'/g) || []).length === 1,
    'D5d …and the shared module itself holds back exactly once');
  /* The general engine's ARM force. It changes no answer today (B4), so there is no
     behaviour to assert — this pins that the engine still PASSES it, which is the only
     thing that would matter the day `amortization` becomes a supported field on that door. */
  ok(/force: \{ amortization: 'fixed' \}/.test(gb),
    'D7 the general board still passes its ARM force, which is what would bite if that field were ever accepted');
  /* The Lender Price holdback stays where it is, on purpose: its half of the board is
     genuinely built differently by the two engines (one parses with options for the
     details panel, the other reports a failure rather than throwing), and pretending
     otherwise would be a lift that hides a real difference. */
  ok(/applyToBoard\(\s*\{ source: 'lenderprice'/.test(gb) || /applyToBoard\(withPrograms, 'lenderprice'/.test(gb)
    || /'lenderprice'/.test(gb),
    'D6 CONTROL: the LENDER PRICE holdback is still applied by each engine — this lift is the LoanNEX half only');
}

console.log('\n── E. IT CANNOT REACH A NETWORK OR A DATABASE ──');
{
  const src = read('src/longterm/pricing/loannex-half.js');
  ok(!/require\(['"](?!\.\/product-filter|\.\/vendor-margin)/.test(src),
    'E1 it requires only the two rule modules — no client, no db, no route');
  ok(!/\bfetch\b|\bdb\b\.|pool/.test(strip(src)), 'E2 …and reaches nothing at run time');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
