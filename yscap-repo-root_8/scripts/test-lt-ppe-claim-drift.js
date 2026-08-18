'use strict';
/**
 * LT PPE — THE CLAIM-DRIFT GUARD (pure: no database, no network, no clock).
 *
 * WHAT THIS SUITE IS FOR. Every other suite here proves the CODE does what it should. This one proves
 * the SENTENCES ABOUT the code are still true. It exists because a sweep on 2026-08-17 found eight
 * statements in live LT PPE code and docs that had been true when written and were measurably false by
 * then — a comment saying the cutover ledger had no table (it has had one since db/566), a line saying
 * no route records an agreement run sitting four lines above the route that records one, a comment
 * calling `best-execution.js` "the production picker for the quote path" when nothing under `src/`
 * requires it at all, and several counts ("27 suites", "the two gated routes") that a reader would
 * have taken as current.
 *
 * A false comment is the most expensive artefact in a codebase: the next person reads it INSTEAD of
 * the code and builds on it. Correcting the wording fixes today; this file is what stops it recurring,
 * because each check below is a BICONDITIONAL — it fails when the code drifts away from the sentence
 * AND when the sentence is reverted away from the code. Where a claim is about wiring, the wiring is
 * measured from the source; where it is about behaviour, the behaviour is EXECUTED, not matched.
 *
 * IF YOU ARE HERE BECAUSE THIS SUITE WENT RED: it is telling you that a change you just made has made
 * a comment or a doc line untrue. Update the sentence in the same commit. Do not delete the check.
 *
 * LT-only. No RTL imports.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const ROUTE = 'src/longterm/routes/ppe.js';
const routeSrc = read(ROUTE);

// ---------------------------------------------------------------------------
// A. THE CUTOVER DECISION LEDGER HAS A DURABLE HOME — and the route says so.
//
// The route's header and its `GET /investors` response body both used to state that the ledger had
// "NO table behind them yet" / "the cutover ledger has no table". Both were false: db/566 creates
// `lt_ppe_cutover_ledger` and `ppe/cutover-store.js` is the append-only bridge onto it. The second one
// was SHIPPED TO A SCREEN, so a human was being told it.
// ---------------------------------------------------------------------------
{
  const store = require('../src/longterm/ppe/cutover-store');
  for (const fn of ['appendDecision', 'listHistory', 'verifyHistory', 'currentMode']) {
    ok(typeof store[fn] === 'function', `A: cutover-store exports ${fn}() — the ledger has a durable bridge`);
  }
  const mig = read('db/566_lt_ppe_cutover_ledger.sql');
  ok(/CREATE TABLE IF NOT EXISTS lt_ppe_cutover_ledger/.test(mig),
    'A: db/566 creates lt_ppe_cutover_ledger — the ledger has a durable HOME');

  // The corrected wording must still be there. If somebody reverts the header to "no table", this
  // fails and names the reason.
  ok(/lt_ppe_cutover_ledger/.test(routeSrc) && /db\/566/.test(routeSrc),
    'A: the route names db/566 / lt_ppe_cutover_ledger — it no longer claims the ledger is unpersisted');

  // AND THE THIRD REWRITE OF THE SAME BULLET. This check used to assert the OPPOSITE — that no
  // promote/rollback route existed — which was true and was the point: the header said there was
  // none, so adding one had to fail here and force the sentence to be rewritten with it. It did
  // exactly that. The owner answered who may promote ("all in the super admin", 2026-08-18), the door
  // shipped, and both halves are now asserted the other way round: the routes exist, and the header
  // no longer claims they do not.
  const cutoverRoutes = routeSrc.match(/^router\.(get|post|put|delete)\((['"])[^'"]*cutover[^'"]*\2/gmi) || [];
  eq(cutoverRoutes.length, 2,
    'A: the cutover READ and DECISION doors are both registered — the ledger is reachable at last');
  ok(!/No promote-to-live control/.test(routeSrc) && !/STILL not exposed here/.test(routeSrc),
    'A: …and the header no longer says there is no promote control — that sentence was rewritten with the door');

  // The DECISION door carries the role floor, not the ordinary admin gate. A count of routes says
  // nothing about which gate they were mounted behind, and the gate is the whole of the owner's answer.
  const decisionReg = routeSrc.match(/router\.post\(\s*'\/cutover\/decision'\s*,\s*(\w+)/);
  ok(!!decisionReg && /SuperAdmin|CutoverAuthority/.test(decisionReg[1]),
    `A: the cutover decision is super-gated, never the ordinary admin gate (found ${decisionReg ? decisionReg[1] : 'nothing'})`);

  // AND THE MODE IS READ RATHER THAN ASSERTED. `GET /investors` shipped the sentence "every investor
  // is in shadow and Lender Price is authoritative" in its RESPONSE BODY — a claim a screen repeats
  // to a human verbatim, and one the promote door can falsify in a single click.
  ok(!/every investor is in shadow/.test(routeSrc),
    'A: /investors no longer ASSERTS that every investor is shadowing — a promotion would make that a lie on a screen');
  ok(/mode:\s*modes\.has\(/.test(routeSrc),
    'A: …it reports each investor\'s ACTUAL recorded mode instead');
  ok(!/mode:\s*\(\)\s*=>\s*'shadow'/.test(routeSrc),
    'A: and the pricing path no longer hard-codes shadow either — a recorded promotion actually moves the answer');
}

// ---------------------------------------------------------------------------
// B. A ROUTE *DOES* RECORD AN AGREEMENT RUN — what is banned is recording one FROM A REQUEST BODY.
//
// `POST /rate-sheets/:id/agreement/run` prices the ≥200-scenario battery itself and stores the verdict
// through `agreementStore.recordRun`. The unqualified line "there is deliberately NO route that
// records an agreement RUN" sat four lines above that registration.
// ---------------------------------------------------------------------------
{
  ok(/router\.post\((['"])\/rate-sheets\/:id\/agreement\/run\1/.test(routeSrc),
    'B: POST /rate-sheets/:id/agreement/run is registered');
  ok(/agreementStore\.recordRun\(/.test(routeSrc),
    'B: …and it RECORDS the verdict (agreementStore.recordRun) — so "no route records a run" is false');

  // The qualifier is the whole rule, so it must appear wherever the claim does. Normalize the comment
  // prefixes away first: the claim is written across wrapped `//` lines.
  const flat = routeSrc.replace(/^\s*(\/\/|\*)\s?/gm, '').replace(/\s+/g, ' ');
  const claims = flat.match(/no route that records an agreement run[^.]*/gi) || [];
  ok(claims.length > 0, 'B: the rule is still stated (a rule nobody writes down is a rule that comes back wrong)');
  for (const c of claims) {
    ok(/from a request body/i.test(c),
      `B: every statement of the rule carries the qualifier that makes it true — got: "${c.slice(0, 90)}"`);
  }
}

// ---------------------------------------------------------------------------
// C. `best-execution.js` HAS NO PRODUCTION CALLER — and every sentence about it must agree.
//
// A comment in `ratesheet-agreement.js` called it "the production picker for the quote path". Measured:
// nothing under `src/` requires the module; its only consumer anywhere is its own test suite.
// This check is the biconditional — wire it up and this fails, telling you to update the wording.
// ---------------------------------------------------------------------------
{
  const REQ = /require\(\s*(['"])[^'"]*best-execution\1\s*\)/;
  const wired = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) { walk(rel); continue; }
      if (!/\.js$/.test(ent.name)) continue;
      if (rel === 'src/longterm/ppe/best-execution.js') continue;
      if (REQ.test(read(rel))) wired.push(rel);
    }
  };
  walk('src');
  eq(wired.length, 0,
    `C: nothing under src/ requires best-execution.js (found: ${wired.join(', ') || 'none'}). If you just wired it in, update its header and the note in ratesheet-agreement.js — both currently say it has no production caller.`);

  const beSrc = read('src/longterm/ppe/best-execution.js');
  ok(/NOTHING IN `src\/` REQUIRES THIS MODULE TODAY/.test(beSrc),
    'C: best-execution.js states plainly that it has no production caller');
  const raSrc = read('src/longterm/ppe/ratesheet-agreement.js');
  ok(!/best-execution\.js is the production picker/.test(raSrc),
    'C: ratesheet-agreement.js no longer calls best-execution.js "the production picker for the quote path"');
}

// ---------------------------------------------------------------------------
// D. best-execution's INPUT-SHAPE PROVENANCE, measured by running the three normalizers.
//
// Its header used to credit `parity.normalizeOurQuote` / `lp-normalize` with producing
// `{ investor, program, rungs }`. Neither carries an investor or a program — only
// `lp-normalize-full.normalizeLpFull(...).programs[]` does. A caller trusting the old sentence would
// rank results that all tie on an undefined investor.
// ---------------------------------------------------------------------------
{
  const parity = require('../src/longterm/ppe/parity');
  const lpNorm = require('../src/longterm/ppe/lp-normalize');
  const lpFull = require('../src/longterm/ppe/lp-normalize-full');
  const BE = require('../src/longterm/ppe/best-execution');

  const ours = parity.normalizeOurQuote({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] });
  ok(Array.isArray(ours.rungs) && ours.rungs.length === 1, 'D: normalizeOurQuote produces the rung ladder');
  ok(!('investor' in ours) && !('program' in ours),
    'D: normalizeOurQuote carries NO investor and NO program — the caller must supply that identity');

  const theirs = lpNorm.normalizeLpParsed({ programs: [{ program: 'P', rungs: [{ rate: 7, price: 100 }] }] });
  ok(Array.isArray(theirs.rungs) && theirs.rungs.length === 1, 'D: normalizeLpParsed produces the rung ladder');
  ok(!('investor' in theirs) && !('program' in theirs),
    'D: normalizeLpParsed carries NO investor and NO program either');

  const full = lpFull.normalizeLpFull({
    programs: [{
      lender: 'L', investor: 'Acme', program: 'DSCR30', product: '30yr',
      options: [
        { priceBuild: { noteRate: 7.0, price: 100.0 } },
        { priceBuild: { noteRate: 7.5, price: 103.0 } },
      ],
    }],
  });
  const p0 = full.programs[0];
  ok(p0 && typeof p0.investor === 'string' && typeof p0.program === 'string' && Array.isArray(p0.rungs),
    'D: normalizeLpFull().programs[] DOES carry investor + program + rungs — the shape best-execution documents');
  const ranked = BE.bestByRate(full.programs, p0.rungs[0].rate);
  eq(ranked.best && ranked.best.investor, 'Acme',
    'D: …and it is directly rankable by bestByRate with no reshaping, which is what the header now says');
}

// ---------------------------------------------------------------------------
// E. THE DERIVED-FACT REFUSAL IS THE ONE `layer-facts.js` CREDITS.
//
// The header credited `unsupportedDerivationKinds` with refusing an unknown derivation kind at compile
// time. The refusal is real — but it comes from `derivationProblems`, which is the only thing the two
// compilers call; `unsupportedDerivationKinds` has no caller under `src/` at all. Someone grepping the
// credited name would have found a helper nothing calls and concluded the guard was decoration.
// So: EXECUTE the refusal, and pin the credit to the function that performs it.
// ---------------------------------------------------------------------------
{
  const { compileEligibility } = require('../src/longterm/ppe/layer-compile-eligibility');
  const { compilePpp } = require('../src/longterm/ppe/layer-compile-ppp');
  const dataOf = (f) => JSON.parse(read(`src/longterm/ppe/investor-data/${f}`));
  const elig = dataOf('deephaven-dscr.eligibility.v2026-08-04.json');
  const ppp = dataOf('deephaven-dscr.ppp.v2026-03.json');

  // controls — the real documents compile
  ok(compileEligibility(elig) && compilePpp(ppp), 'E: control — both real layer documents compile');

  for (const [label, doc, compile] of [['eligibility', elig, compileEligibility], ['ppp', ppp, compilePpp]]) {
    const bad = JSON.parse(JSON.stringify(doc));
    bad.derivedFacts = { ...(bad.derivedFacts || {}), drift_probe: { kind: 'regex_match', from: 'purpose' } };
    let refused = false; let msg = '';
    try { compile(bad); } catch (e) { refused = true; msg = String(e.message || ''); }
    ok(refused, `E: the ${label} compiler REFUSES an unknown derivation kind — never silently skips it`);
    ok(/unknown derivation kind/.test(msg), `E: …and says which kind it did not know (${label})`);
  }

  // the credit: the compilers call derivationProblems, and the header names it.
  for (const f of ['layer-compile-eligibility', 'layer-compile-ppp']) {
    ok(/layerFacts\.derivationProblems\(/.test(read(`src/longterm/ppe/${f}.js`)),
      `E: ${f}.js calls layerFacts.derivationProblems() — the refusal's real caller`);
  }
  const lfSrc = read('src/longterm/ppe/layer-facts.js');
  ok(/\*\*The refusal is `derivationProblems`\*\*/.test(lfSrc),
    'E: layer-facts.js credits derivationProblems (not a helper nothing calls) with the compile-time refusal');
}

// ---------------------------------------------------------------------------
// F. NO HARD-CODED SUITE COUNT. "(27 suites)" was written when there were 27 and read as current long
// after there were four times as many. The family is globbed; the count belongs in the runner's output.
// ---------------------------------------------------------------------------
{
  const files = ['src/longterm/routes/ppe.js', 'scripts/test-lt-ppe-route.js', 'src/longterm/ppe/README.md'];
  for (const f of files) {
    const hit = read(f).match(/\(\s*\d+\s+suites\b[^)]*\)/i);
    ok(!hit, `F: ${f} quotes no parenthesised suite count (found: ${hit && hit[0]})`);
  }
}

// ---------------------------------------------------------------------------
// G. EVERY WRITE CARRIES A GATE EXCEPT THE TWO PRICING DOORS — stated as a RULE, never a count.
//
// The header said the gate was on "the two deliberate operator actions … and those are the two gated
// routes". True when there were two; there are now twenty-three. A count in prose is a hand-kept list.
//
// ⛔ THERE ARE TWO GATES NOW, AND THE STRICTER ONE MUST NOT READ AS "UNGATED". The publish door takes
// `requirePpeSuperAdmin` INSTEAD OF the admin gate (§2.57 — an admin is refused there), so a test that
// only ever looked for `requirePpeAdmin` reported the single most dangerous route on this router as an
// open write. It is named EXPLICITLY rather than admitted by a loose "any gate will do" pattern: a
// write that arrives carrying some other middleware still has to be argued for here.
// ---------------------------------------------------------------------------
{
  const UNGATED_WRITES = new Set(['/quote', '/breakdown']);
  // path → the gate it must carry, when that is not the ordinary admin gate.
  // TWO doors take a role-floor gate rather than the admin one — the two acts the owner reserved to
  // the super admin in a single sentence (2026-08-18). They carry DIFFERENT gate functions on purpose:
  // each refusal names its own act, because a person told "only a super admin can publish a pricing
  // rule" while trying to take an investor live goes hunting a rule they never touched.
  const SUPER_GATED = new Map([
    ['/rule-drafts/:id/publish', 'requirePpeSuperAdmin'],
    ['/cutover/decision', 'requirePpeCutoverAuthority'],
  ]);
  const regs = routeSrc.match(/^router\.(post|put|delete)\([^\n]*$/gm) || [];
  ok(regs.length > 10, 'G: control — the router registers a real number of write routes');
  const leaks = [];
  for (const line of regs) {
    const p = (line.match(/^router\.(?:post|put|delete)\((['"])([^'"]+)\1/) || [])[2];
    if (UNGATED_WRITES.has(p)) continue;
    const want = SUPER_GATED.get(p) || 'requirePpeAdmin';
    if (!new RegExp(`\\b${want}\\b`).test(line)) leaks.push(`${p} (wants ${want})`);
  }
  eq(leaks.length, 0,
    `G: every write except ${[...UNGATED_WRITES].join(' / ')} carries its gate (wrong or missing: ${leaks.join(', ') || 'none'})`);

  // And the publish door must NOT also carry the admin gate: stacking them would make an ordinary
  // admin's refusal come from the wrong sentence, and would hide a later removal of the super gate.
  for (const [p, gate] of SUPER_GATED) {
    const line = regs.find((l) => l.includes(`'${p}'`)) || '';
    ok(line && new RegExp(`\\b${gate}\\b`).test(line) && !/requirePpeAdmin/.test(line),
      `G: ${p} carries ${gate} and NOT the admin gate — publishing is not an administrator's act`);
  }

  const flat = routeSrc.replace(/^\s*(\/\/|\*)\s?/gm, '').replace(/\s+/g, ' ');
  ok(!/those are the two gated routes/i.test(flat),
    'G: the header no longer claims there are exactly two gated routes');
}

// ---------------------------------------------------------------------------
// H. THERE *IS* A RATE-SHEET WRITE PATH. The header's "WHAT IS DELIBERATELY NOT HERE" list carried a
// bullet saying there was none, while the router registers six writers plus the publish.
// ---------------------------------------------------------------------------
{
  const writes = (routeSrc.match(/^router\.(post|put)\((['"])\/(programs\/:id\/rate-sheets|rate-sheets\/[^'"]+)\2/gm) || []);
  ok(writes.length >= 3, `H: the router registers rate-sheet write routes (${writes.length} found)`);
  ok(!/No rate-sheet write path/i.test(routeSrc),
    'H: …so the header no longer lists "No rate-sheet write path" as deliberately absent');
}

console.log(`ok - lt ppe claim-drift guard (${n} assertions)`);
