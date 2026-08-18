#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM (LT) PPE — THE REQUIREMENTS LEDGER IS COMPARED TO THE CODE, IN BOTH DIRECTIONS.
 *
 * `docs/longterm/ppe-research/REQUIREMENTS-LEDGER.md` is a hand-kept list of what is built and what is
 * not, and on 2026-08-18 ELEVEN of its rows were measurably wrong — K1 through K9, P8, P9 and P10 all
 * read TODO while the code had closed every one of them. Nothing was broken by that; what was broken is
 * that the one document a person opens to ask "what is left?" answered with a list of work already done,
 * so the genuinely open items were buried among eleven false ones.
 *
 * ⛔ THIS IS THE SAME DEFECT CLASS AS §2.64 AND §2.65, AND THE SAME GUARD SHAPE ANSWERS IT. Every defect
 * found in this workstream has lived in the JOIN between two individually-correct halves: a gate and a
 * deployment file, a command and the shape its dependency returns, and here a ledger and the code it
 * describes. Each half was fine on its own. So this guard does what those did — it COMPARES THE TWO
 * ARTIFACTS, and it is BICONDITIONAL:
 *
 *   a row that claims DONE must have its evidence present in the code, and
 *   a row that claims TODO must genuinely NOT have it.
 *
 * The second half is the half that is easy to leave out and is worth more than the first. Checking only
 * the DONE claims lets the exact defect this closes recur: finish the work, forget the row, and the
 * ledger quietly under-reports forever with every test still green. Checking only the TODO claims lets
 * somebody mark a row DONE it never was. Both directions, or this is decoration.
 *
 * ⛔ AND IT IS COVERAGE-CHECKED. Every K row must carry a probe here, so a K row added later cannot slip
 * in unguarded; and every probe must match a row that still exists, so deleting a row turns this red
 * rather than silently retiring its guard. A guard whose subject can disappear without a word is the
 * "built, tested, and asked by nothing" class this repo keeps finding.
 *
 * WHAT A PROBE MAY BE. A probe names the SPECIFIC evidence that the requirement is met — the line that
 * forces the field, the registry entry, the route registration, the module that exists. It is deliberately
 * not "some file mentions the word": that passes on a comment discussing the problem and would have
 * called K2 done for months while the code still omitted the option.
 *
 * Offline: reads source files, runs no server and touches no database.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0;
const failures = [];
function ok(cond, what) {
  if (cond) { pass += 1; return; }
  failures.push(what);
}

const LEDGER = 'docs/longterm/ppe-research/REQUIREMENTS-LEDGER.md';
const SEARCH_MODEL = 'src/longterm/lenderprice/search-model.js';
const PPE_ROUTES = 'src/longterm/routes/ppe.js';

// ---------------------------------------------------------------------------
// The two artifacts.
// ---------------------------------------------------------------------------

// The ledger, as { id -> {status, line} }. Both tables in this file are pipe rows whose FIRST cell is
// the requirement id and whose THIRD is the status, so one parse covers the P table and the K table.
function readLedger(src) {
  const rows = new Map();
  src.split('\n').forEach((line, i) => {
    if (!line.startsWith('|')) return;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) return;
    const id = cells[0];
    if (!/^(K\d+|P\d+|P-DQ)$/.test(id)) return;
    rows.set(id, { status: cells[2], line: i + 1 });
  });
  return rows;
}

// A status is a DONE claim when it STARTS with DONE — the ledger writes "DONE", "DONE (analysis)" and
// "DONE (via P-DQ)", all of which assert the work exists. PARTIAL deliberately does NOT count as done:
// it claims some of the work is missing, and a probe that passed on PARTIAL would let a half-built row
// look fully guarded.
const claimsDone = (status) => /^DONE\b/.test(String(status || ''));

const SRC = { searchModel: read(SEARCH_MODEL), ppeRoutes: read(PPE_ROUTES) };

// ---------------------------------------------------------------------------
// The probes — the code half of the comparison.
// ---------------------------------------------------------------------------
const PROBES = {
  K0: { what: 'search-model defaults an omitted DSCR to 1.5 rather than sending null',
        probe: () => /effDscr\s*=\s*dscrVal\s*!=\s*null\s*\?\s*dscrVal\s*:\s*1\.5/.test(SRC.searchModel) },

  K1: { what: "buildSearch FORCES criteria.pmiType = 'BPMI'",
        probe: () => /\bc\.pmiType\s*=\s*'BPMI'/.test(SRC.searchModel) },

  // §37.10: we stopped inventing a fourth special-mortgage-option and instead carry the FOUNDATION's own
  // through — which on the captured base is exactly Prepay Buyout. The evidence is that pass-through, not
  // the words "Prepay Buyout", which appear in the comment that explains the problem.
  K2: { what: "the foundation's own special-mortgage-options ride through (§37.10 `preserved`), which is how Prepay Buyout is sent",
        probe: () => /const\s+preserved\s*=\s*baseSmo\.filter/.test(SRC.searchModel)
                  && /for\s*\(const o of preserved\)\s*smo\.push/.test(SRC.searchModel) },

  K3: { what: 'brokerCriteria.ausList is forced to the full captured AUS list',
        probe: () => /bc\.ausList\s*=\s*callerAus\s*\|\|\s*AUS_ALL/.test(SRC.searchModel) },

  K4: { what: 'showUnmatchCompPlan is forced true',
        probe: () => /\bm\.showUnmatchCompPlan\s*=\s*true/.test(SRC.searchModel) },

  K5: { what: 'the default closing-cost flags are forced on',
        probe: () => /cc\.useClosingCost\s*=\s*true/.test(SRC.searchModel)
                  && /cc\.useCompanyDefaultClosingCost\s*=\s*true/.test(SRC.searchModel) },

  // The round lives in wireDiscipline (the "one place, last" chokepoint) so it survives BOTH a live
  // foundation's value and a scenario-supplied one.
  K6: { what: 'monthlyIncome is rounded at the wire chokepoint',
        probe: () => /c\.monthlyIncome\s*=\s*Math\.round\(/.test(SRC.searchModel) },

  K7: { what: 'a 15-year selection keeps criteria.loanYear 30 and carries the term on termsCriteria only',
        probe: () => /c\.loanYear\s*=\s*30;\s*m\.termsCriteria\s*=\s*\[effTermYears\]/.test(SRC.searchModel) },

  // K8 is "prefer omission over null on blank fields". Its evidence is the RULE that replaced the
  // spot-patches: one registry deciding every blank form, plus the suite that derives the expected form
  // from the captured anchors so the rule cannot drift away from its evidence.
  K8: { what: 'blank forms are decided by the SCENARIO_OWNED registry and derived from the anchors by test-lt-lp-blank-parity',
        probe: () => /SCENARIO_OWNED/.test(SRC.searchModel) && exists('scripts/test-lt-lp-blank-parity.js') },

  // §2.1a reversed §2.1 here: all seven captures send these as "", so we send "" too. An empty string
  // overwrites a stale foundation street exactly as deletion did, so the leak stays closed either way.
  K9: { what: "street / streetCont / zipExt carry the captures' own empty strings",
        probe: () => ['street', 'streetCont', 'zipExt'].every((f) =>
          new RegExp(`path:\\s*'property\\.address\\.${f}',\\s*neutral:\\s*''`).test(SRC.searchModel)) },

  // P2's auto-wiring (2.67): the run must merge the scenarios and mine ONCE. Probing the merge as
  // well as the call is deliberate - a per-scenario mine would also "call the miner" while leaving
  // `occurrences` meaningless, so calling it is not evidence that the wiring is right.
  P2: { what: 'the agreement run merges the run\'s refusals and mines them once (disqualifier-mining)',
        probe: () => /disqualifierMining\.add\(mineAcc, lpDisq\)/.test(SRC.ppeRoutes)
                  && /suggestionMiner\.mineFromParsed\(db, found\.scope, parsedForMining\)/.test(SRC.ppeRoutes)
                  && exists('src/longterm/ppe/disqualifier-mining.js') },

  P8: { what: 'the manual-review and suggested-rules screens exist',
        probe: () => exists('app-v2/src/longterm/RuleBoard.jsx')
                  && exists('app-v2/src/longterm/DisqualifierReview.jsx') },

  P9: { what: 'the per-investor parity matrix and its persisted per-cell trend exist',
        probe: () => exists('src/longterm/ppe/parity-matrix.js')
                  && exists('src/longterm/ppe/parity-cell-store.js') },

  P10: { what: 'the promote/rollback HTTP door is registered (§2.63)',
         probe: () => /router\.get\('\/cutover'/.test(SRC.ppeRoutes)
                   && /router\.post\('\/cutover\/decision'/.test(SRC.ppeRoutes) },
};

// ---------------------------------------------------------------------------
function main() {
  const ledger = readLedger(read(LEDGER));
  ok(ledger.size > 0, 'the ledger parses into rows at all — a parse that silently finds nothing would pass every check below');

  // (A) COVERAGE — every K row is probed, and every probe still has a row.
  const kRows = [...ledger.keys()].filter((id) => /^K\d+$/.test(id));
  ok(kRows.length > 0, 'the K theme still has rows');
  const unprobed = kRows.filter((id) => !PROBES[id]);
  ok(unprobed.length === 0,
    `every K row carries a probe here — unguarded: ${unprobed.join(', ')}. Add one in the same commit as the row.`);
  const orphaned = Object.keys(PROBES).filter((id) => !ledger.has(id));
  ok(orphaned.length === 0,
    `every probe still names a real ledger row — orphaned: ${orphaned.join(', ')}. A row was deleted and took its guard's subject with it.`);

  // (B) THE COMPARISON, BOTH WAYS.
  for (const [id, { what, probe }] of Object.entries(PROBES)) {
    const row = ledger.get(id);
    if (!row) continue;                       // already reported by (A)
    const built = probe();
    const claimed = claimsDone(row.status);
    if (claimed && !built) {
      ok(false, `${id} claims "${row.status}" (${LEDGER}:${row.line}) but the code does not show it: ${what}`);
    } else if (!claimed && built) {
      ok(false, `${id} still reads "${row.status}" (${LEDGER}:${row.line}) though the code HAS it: ${what}. Update the row — an open item that is actually done buries the ones that are not.`);
    } else {
      ok(true, `${id} — ledger says ${row.status}, code agrees`);
    }
  }

  // (C) The ledger must not contradict the parity doc about the same field. §2.1's close-out once said
  // street/streetCont/zipExt were "deliberately omitted"; §2.1a reversed it and the code now sends "".
  // Two sentences about one field, in one document, is how a reader ends up with the wrong one.
  // ⛔ IT MUST NOT FIRE ON THE PASSAGE THAT RETRACTS THE CLAIM. The first cut forbade the phrase
  // anywhere, and then failed on §2.66 — the very section explaining that the claim was withdrawn, which
  // necessarily quotes it. A guard like that gets "fixed" by deleting the explanation, leaving the
  // document tidier and less true. (The same trap `test-auth-screens-pure.js` documents for comments.)
  //
  // So the rule is about the claim being LIVE, not about the words existing: any paragraph that says
  // these fields are omitted must also point at §2.1a, the section that reversed it. A retraction and a
  // quotation both cite it; a restored claim would not.
  const parity = read('docs/longterm/LENDER-PRICE-PARITY-STATUS.md');
  const live = parity.split(/\n\s*\n/).filter((para) =>
    /deliberately omitted/i.test(para) && !/§2\.1a/.test(para));
  ok(live.length === 0,
    `the parity doc never claims street/streetCont/zipExt are deliberately omitted without pointing at §2.1a, which reversed it (the code sends the captures' own empty strings). Offending paragraph(s): ${live.map((p) => p.slice(0, 90).replace(/\n/g, ' ')).join(' || ')}`);

  console.log(failures.length
    ? `FAIL - lt ppe requirements ledger (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
    : `ok - lt ppe requirements ledger (${pass} assertions)`);
  process.exit(failures.length ? 1 : 0);
}

main();
