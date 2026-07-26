'use strict';
/**
 * The registered PROGRAM ↔ capital-provider (note-buyer) pairing that a NON-ADMIN
 * tape export must satisfy (owner-directed 2026-07-26). This is the "backend
 * understanding" that ties a loan's registered product to the capital provider
 * whose tape it may export:
 *
 *     Gold      ↔  Blue Lake  (bluelake)
 *     Standard  ↔  Fidelis    (fidelis)
 *     Silver    ↔  EMCAP      (emcap)   — PARKED, see below
 *
 * A non-admin may export a provider's tape only when the loan's capital provider
 * AND its registered program BOTH line up per this table (see buyer-rule.js
 * `exportGate`). An ADMIN bypasses the pairing entirely and can export any tape.
 *
 * MANUAL is intentionally NOT in this table. A manual (admin-approved) loan's
 * program is not locked to any one provider, so its tape is ADMIN-ONLY — only an
 * admin may export a tape for a manual file (owner-directed).
 *
 * SILVER is PARKED: 'silver' is a recognized program NAME wired to EMCAP so the
 * system understands the pairing, but it is NOT a live/registerable program yet
 * (there is no register path, pricing, or studio card for it). No loan can carry
 * `registered_program = 'silver'` today, so in practice an EMCAP tape is
 * admin-only until the Silver program is built and activated. Do NOT wire Silver
 * into the register/pricing flow here — the pairing alone is the whole job for now.
 */

// program key (product_registrations.program) → capital-provider (note-buyer) key.
const PROVIDER_FOR_PROGRAM = Object.freeze({
  gold: 'bluelake',
  standard: 'fidelis',
  silver: 'emcap', // PARKED — recognized name, not yet a registerable program
});

// The reverse: capital-provider key → the program a loan must be registered as.
const PROGRAM_FOR_PROVIDER = Object.freeze(
  Object.fromEntries(Object.entries(PROVIDER_FOR_PROGRAM).map(([p, b]) => [b, p]))
);

// Programs recognized but intentionally dormant (no register/pricing path yet).
const PARKED_PROGRAMS = Object.freeze(new Set(['silver']));

// Plain-language program labels for messages (staff-facing).
const PROGRAM_LABEL = Object.freeze({
  gold: 'Gold', standard: 'Standard', silver: 'Silver', manual: 'Manual',
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
  return !!p && PROVIDER_FOR_PROGRAM[p] === buyerKey;
}

function programLabel(program) {
  const p = normProgram(program);
  return PROGRAM_LABEL[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : '');
}

module.exports = {
  PROVIDER_FOR_PROGRAM, PROGRAM_FOR_PROVIDER, PARKED_PROGRAMS, PROGRAM_LABEL,
  normProgram, providerForProgram, programForProvider, programMatchesBuyer, programLabel,
};
