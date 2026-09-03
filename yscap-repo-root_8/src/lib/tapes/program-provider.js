'use strict';
/**
 * The registered PROGRAM ↔ capital-provider (note-buyer) pairing that a NON-ADMIN
 * tape export must satisfy (owner-directed 2026-07-26). This is the "backend
 * understanding" that ties a loan's registered product to the capital provider
 * whose tape it may export:
 *
 *     Gold      ↔  Blue Lake  (bluelake)
 *     Standard  ↔  Fidelis    (fidelis)
 *     Silver    ↔  EMCAP      (emcap)
 *
 * A non-admin may export a provider's tape only when the loan's capital provider
 * AND its registered program BOTH line up per this table (see buyer-rule.js
 * `exportGate`). An ADMIN bypasses the pairing entirely and can export any tape.
 *
 * MANUAL is intentionally NOT in this table. A manual (admin-approved) loan's
 * program is not locked to any one provider, so its tape is ADMIN-ONLY — only an
 * admin may export a tape for a manual file (owner-directed).
 *
 * SILVER went LIVE 2026-07-29 (owner-directed — the EMCAP Silver program build):
 * it is a registerable program with its own frozen engine
 * (web/tools/silver-program.js), a studio card, register path and pricing
 * defaults. The pairing below now gates the EMCAP tape exactly like the other
 * two programs.
 */

// program key (product_registrations.program) → capital-provider (note-buyer) key.
const PROVIDER_FOR_PROGRAM = Object.freeze({
  gold: 'bluelake',
  standard: 'fidelis',
  silver: 'emcap',
});

// THE SPEED PROGRAM (owner-directed 2026-09-03) MAY BE SOLD TO EITHER OF ITS TWO
// PARENTS' BUYERS — it is the stricter of Standard and Silver on every axis, so a
// Speed loan is one Fidelis would buy AND one EMCAP would buy. It therefore has NO
// single implied provider (providerForProgram → null, so registration leaves the
// buyer for the team to choose, exactly like Manual) but it DOES match both in the
// export gate: once the file's buyer is set, that buyer's tape may be exported.
const PROVIDERS_FOR_PROGRAM = Object.freeze({ speed: Object.freeze(['fidelis', 'emcap']) });

// The reverse: capital-provider key → the program a loan must be registered as.
const PROGRAM_FOR_PROVIDER = Object.freeze(
  Object.fromEntries(Object.entries(PROVIDER_FOR_PROGRAM).map(([p, b]) => [b, p]))
);

// Programs recognized but intentionally dormant (no register/pricing path yet).
// Silver went live 2026-07-29; nothing is parked today — the set stays for the
// next program to incubate in.
const PARKED_PROGRAMS = Object.freeze(new Set([]));

// Plain-language program labels for messages (staff-facing).
const PROGRAM_LABEL = Object.freeze({
  gold: 'Gold', standard: 'Standard', silver: 'Silver', speed: 'Speed', manual: 'Manual',
});

function normProgram(program) { return String(program || '').trim().toLowerCase(); }

// The capital-provider key a given registered program is paired with (or null).
function providerForProgram(program) {
  return PROVIDER_FOR_PROGRAM[normProgram(program)] || null;
}

// The program a loan must be registered as to export a given provider's tape.
function programForProvider(buyerKey) {
  return (buyerKey && PROGRAM_FOR_PROVIDER[buyerKey]) || null;
}

// True when a registered program is the correct one for a tape's capital provider.
function programMatchesBuyer(program, buyerKey) {
  if (!buyerKey) return false;
  const p = normProgram(program);
  if (!p) return false;
  if (PROVIDERS_FOR_PROGRAM[p]) return PROVIDERS_FOR_PROGRAM[p].includes(buyerKey);
  return PROVIDER_FOR_PROGRAM[p] === buyerKey;
}

// Every provider a program may be sold to (one for the paired programs, two for Speed, none for manual).
function providersForProgram(program) {
  const p = normProgram(program);
  if (PROVIDERS_FOR_PROGRAM[p]) return PROVIDERS_FOR_PROGRAM[p].slice();
  return PROVIDER_FOR_PROGRAM[p] ? [PROVIDER_FOR_PROGRAM[p]] : [];
}

function programLabel(program) {
  const p = normProgram(program);
  return PROGRAM_LABEL[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : '');
}

module.exports = {
  PROVIDER_FOR_PROGRAM, PROVIDERS_FOR_PROGRAM, PROGRAM_FOR_PROVIDER, PARKED_PROGRAMS, PROGRAM_LABEL,
  normProgram, providerForProgram, providersForProgram, programForProvider, programMatchesBuyer, programLabel,
};
