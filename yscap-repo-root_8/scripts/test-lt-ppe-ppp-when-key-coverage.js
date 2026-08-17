#!/usr/bin/env node
'use strict';
/**
 * LT PPE — EVERY PPP STATE-RULE `when`-KEY IS ONE THE MATCHER CAN EVALUATE (the Layer-3 vocabulary-drift
 * guard; the PPP-boundary analogue of the LLPA-dimension-parity and disqualify-overlay guards. CLAUDE.md
 * build-rules #4 "generate, don't hand-maintain" + #5 "fail closed, and never silently" + the E3 gate's
 * owner HARD RULE 2026-08-17: agree with Lender Price on every ineligibility to the penny).
 *
 * THE FAILURE MODE. `deephaven-ppp-matrix.whenMatches` decides whether a state's PPP rule fires. The OLD
 * implementation checked a FIXED list of `when`-keys and `return true`-fell-through on anything else — so
 * a rule carrying a key it did not handle (a typo `unitMax`/`borrowrType`, or a genuinely new dimension
 * added to a rule but not taught to the matcher) had that clause SILENTLY IGNORED. Because these rules
 * resolve overwhelmingly to `prohibited`, an ignored clause makes the rule match MORE BROADLY than
 * intended → a PPP prohibition fires on scenarios it should not → a FALSE disqualifier → our engine
 * declines a loan Lender Price prices → a PERMANENT FALSE E3 DISAGREEMENT scored `our_encoding_bug`.
 *
 * The reachability guard (test-lt-ppe-... #73) cannot catch this: an over-broad rule is still reachable.
 * So the matcher now FAILS CLOSED on an unknown key (the clause does not match) and the module REJECTS a
 * bad key at load; this guard proves both, and mutation-proves the failure mode is real.
 *
 * PURE. No DB, no network. LT-only; no RTL import.
 */
const {
  STATE_RULES,
  pppResult,
  _internals: { whenMatches, WHEN_HANDLERS, SUPPORTED_WHEN_KEYS, unsupportedWhenKeys },
} = require('../src/longterm/ppe/deephaven-ppp-matrix');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — every PPP state-rule when-key is one the matcher can evaluate\n');

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// A verbatim copy of the ORIGINAL whenMatches (before the WHEN_HANDLERS refactor) — the ONLY reason it
// exists is to prove the refactor is byte-identical for the supported keys. It returns true on an unknown
// key (the old silent-broadening), so it is only run over clauses whose keys are all supported.
function whenMatchesOLD(when, input) {
  const w = when || {};
  if (w.borrowerType && input.borrowerType !== w.borrowerType) return false;
  if (w.unitsMax != null) { if (!isNum(input.units) || input.units > w.unitsMax) return false; }
  if (w.unitsMin != null) { if (!isNum(input.units) || input.units < w.unitsMin) return false; }
  if (w.lien && String(input.lien || 'first').toLowerCase() !== w.lien) return false;
  if (w.aprGt != null) { if (!isNum(input.apr) || !(input.apr > w.aprGt)) return false; }
  if (w.loanAmountLt != null) { if (!isNum(input.loanAmount) || !(input.loanAmount < w.loanAmountLt)) return false; }
  if (w.loanAmountLe != null) { if (!isNum(input.loanAmount) || !(input.loanAmount <= w.loanAmountLe)) return false; }
  if (w.loanAmountGt != null) { if (!isNum(input.loanAmount) || !(input.loanAmount > w.loanAmountGt)) return false; }
  if (w.loanAmountGe != null) { if (!isNum(input.loanAmount) || !(input.loanAmount >= w.loanAmountGe)) return false; }
  if (w.ruralProperty === true && input.ruralProperty !== true) return false;
  return true;
}

// (1) COVERAGE: every `when`-key across the committed STATE_RULES is one the matcher supports. A typo'd or
//     un-taught key fails HERE, which is also what the module's own load-time guard throws on.
const uncovered = unsupportedWhenKeys(STATE_RULES);
ok(uncovered.length === 0, 'every when-key in STATE_RULES is supported by WHEN_HANDLERS (no dead/ignored rule key)'
  + (uncovered.length ? `\n        UNSUPPORTED: ${uncovered.join(', ')} — the matcher would fail these closed, dropping a real PPP prohibition` : ''));

// The supported set is DERIVED from the handler table (not a second hand-typed list).
ok(SUPPORTED_WHEN_KEYS.size === Object.keys(WHEN_HANDLERS).length
  && [...SUPPORTED_WHEN_KEYS].every((k) => k in WHEN_HANDLERS),
  'SUPPORTED_WHEN_KEYS is derived from WHEN_HANDLERS (one source of truth)');

// (2) BYTE-IDENTICAL: over a battery of inputs, the refactored matcher agrees with the ORIGINAL on every
//     committed clause (whose keys are all supported), so the fail-closed refactor changed nothing today.
const INPUTS = [];
for (const units of [1, 2, 3, 4, 5, 8]) {
  for (const lien of ['first', 'junior']) {
    for (const apr of [5, 8, 9]) {
      for (const loanAmount of [50000, 116000, 200000, 400000, 900000, 1200000]) {
        for (const borrowerType of ['natural_person', 'business_entity']) {
          for (const ruralProperty of [true, false]) {
            INPUTS.push({ units, lien, apr, loanAmount, borrowerType, ruralProperty });
          }
        }
      }
    }
  }
}
let identical = true; let firstDiff = null;
for (const [state, list] of Object.entries(STATE_RULES)) {
  for (const r of list) {
    for (const input of INPUTS) {
      const a = whenMatches(r.when, input);
      const b = whenMatchesOLD(r.when, input);
      if (a !== b) { identical = false; firstDiff = { state, when: r.when, input, a, b }; }
    }
  }
}
ok(identical, `the refactored matcher is byte-identical to the original over ${INPUTS.length} inputs × every committed clause`
  + (identical ? '' : `\n        first diff: ${JSON.stringify(firstDiff)}`));

// (3) FAIL-CLOSED on an unknown key: a clause carrying a key the matcher does not handle must NOT match
//     (the old code fell through to `return true`). Prove both directions on ONE input.
const goodInput = { units: 2, lien: 'first', apr: 5, loanAmount: 200000, borrowerType: 'natural_person', ruralProperty: false };
ok(whenMatches({ unitsMax: 4 }, goodInput) === true, 'a clause with only supported keys still matches (control)');
ok(whenMatches({ unitsMax: 4, unitMax: 4 /* typo */ }, goodInput) === false,
  'a clause with an UNKNOWN key (`unitMax` typo) fails CLOSED — it does not match (old code silently matched)');
ok(whenMatchesOLD({ unitsMax: 4, unitMax: 4 }, goodInput) === true,
  'the ORIGINAL matcher WOULD have matched that typo\'d clause — the exact silent broadening this closes');

// (4) MUTATION PROOF end-to-end — a `prohibited` rule whose real gate is a typo'd key. Under the OLD
//     matcher the typo is ignored and the prohibition over-fires; under the fixed matcher the clause fails
//     closed, so the rule does not falsely prohibit — AND the coverage guard flags the typo so it can
//     never ship silently in the first place.
const DRIFTED = {
  // "ZZ": prohibit ONLY a natural person, but the borrower-type gate is misspelled `borrowrType`.
  ZZ: [{ when: { borrowrType: 'natural_person', unitsMax: 4 }, result: 'prohibited' }, { when: {}, result: 'standard' }],
};
const drifted = unsupportedWhenKeys(DRIFTED);
ok(drifted.length === 1 && drifted[0] === 'ZZ:borrowrType',
  'unsupportedWhenKeys catches a typo\'d rule key (`ZZ:borrowrType`) — the coverage guard bites');
// A BUSINESS entity on a ZZ 2-unit: the rule is MEANT to prohibit only a natural person. With the typo,
// the old matcher ignores the borrower gate and prohibits the business entity too (over-fire); the fixed
// matcher fails the typo'd clause closed, so it correctly falls through to `standard`.
const bizInput = { units: 2, lien: 'first', apr: 5, loanAmount: 200000, borrowerType: 'business_entity', ruralProperty: false };
ok(whenMatches(DRIFTED.ZZ[0].when, bizInput) === false && whenMatchesOLD(DRIFTED.ZZ[0].when, bizInput) === true,
  'the typo\'d prohibition OVER-FIRES on a business entity under the old matcher; the fixed matcher does not (a false PPP disqualifier averted)');

// (5) The load-time self-check is REAL: pppResult still resolves the owner's NJ example correctly (a
//     natural person is prohibited, a business entity is not) — proving the refactor kept the live path.
const njNatural = pppResult({ state: 'NJ', borrowerType: 'natural_person', units: 2, lien: 'first' });
const njEntity = pppResult({ state: 'NJ', borrowerType: 'business_entity', units: 2, lien: 'first' });
ok(njNatural.result === 'prohibited' && njEntity.result === 'standard',
  'NJ still prohibits a natural person and allows a business entity (the owner\'s example, unchanged)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
