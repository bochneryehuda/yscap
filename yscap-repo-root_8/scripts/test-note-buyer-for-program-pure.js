/**
 * The registered PROGRAM chooses the NOTE BUYER (owner-directed 2026-08-06) —
 * the PURE half.
 *
 *   *"Just populate in our system: Fidelis for the standard, Blue Lake for the
 *   gold, EMCAP for the silver. Manual should be an open selection."*
 *
 * What must hold:
 *   A. The three pairings, in the owner's own words.
 *   B. MANUAL implies NOTHING — the team picks it later.
 *   C. Nothing is ever guessed: a blank / unknown / junk program implies nothing.
 *   D. The pairing is the SAME table the tape-export gate enforces — a derived
 *      buyer must never stamp a file whose tape it is then refused.
 *   E. Every label written is a spelling its own tape module recognises
 *      (the load-time self-check), so the derived buyer behaves exactly like a
 *      human-typed one everywhere downstream.
 *
 * No DB, no network.
 */
'use strict';

const M = require('../src/lib/note-buyer-for-program');
const { providerForProgram } = require('../src/lib/tapes/program-provider');
const { normNoteBuyer } = require('../src/lib/conditions/field-registry');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- A. The owner's three pairings -------------------------------------------
assert(M.noteBuyerForProgram('standard') === 'Fidelis Investors LLC',
  `A1 standard → Fidelis (got ${JSON.stringify(M.noteBuyerForProgram('standard'))})`);
assert(M.noteBuyerForProgram('gold') === 'Blue Lake Capital',
  `A2 gold → Blue Lake (got ${JSON.stringify(M.noteBuyerForProgram('gold'))})`);
assert(M.noteBuyerForProgram('silver') === 'EMCAP Financial',
  `A3 silver → EMCAP (got ${JSON.stringify(M.noteBuyerForProgram('silver'))})`);
assert(M.noteBuyerForProgram('GOLD') === 'Blue Lake Capital', 'A4 the program key is read case-insensitively');

// ---- B. Manual is an OPEN selection ------------------------------------------
assert(M.noteBuyerForProgram('manual') === null,
  `B1 MANUAL implies no note buyer — left untouched for the team to pick (got ${JSON.stringify(M.noteBuyerForProgram('manual'))})`);
assert(providerForProgram('manual') == null,
  'B2 …and that comes from the shared pairing table, which deliberately omits manual');

// ---- C. Never guess -----------------------------------------------------------
for (const bad of ['', null, undefined, 'bogus', 'platinum', 0, {}, []]) {
  assert(M.noteBuyerForProgram(bad) === null, `C1 an unrecognised program (${JSON.stringify(bad)}) implies nothing`);
}

// ---- D. ONE pairing table, shared with the tape-export gate -------------------
for (const program of ['standard', 'gold', 'silver']) {
  const key = providerForProgram(program);
  const label = M.noteBuyerForProgram(program);
  assert(!!key && !!label && M.LABEL_FOR_PROVIDER[key] === label,
    `D1 ${program} derives its buyer through the shared provider table (${key} → ${label})`);
}
assert(Object.keys(M.LABEL_FOR_PROVIDER).length === 3,
  'D2 exactly three providers carry a derived label — a fourth needs the owner to name it');

// ---- E. Every label is one its own tape recognises ----------------------------
const problems = M.verifyLabels();
assert(problems.length === 0,
  `E1 every derived label is recognised by its own tape module${problems.length ? ' — ' + problems.join('; ') : ''}`);
// Stated explicitly too, so the intent survives a refactor of verifyLabels.
const TAPES = require('../src/lib/tapes/registry').TAPES;
for (const [key, label] of Object.entries(M.LABEL_FOR_PROVIDER)) {
  const tape = TAPES.find((t) => t.buyerKey === key);
  const norm = normNoteBuyer(label);
  assert(!!tape && (norm === key || (tape.buyerAliases || []).includes(norm)),
    `E2 '${label}' (→ ${norm}) can export the ${key} tape`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
