'use strict';
/**
 * LT PPE — THE INVESTOR PROGRAM REGISTRY (the seed of the versioned program catalog; PPE #47).
 *
 * WHAT THIS IS. `program-engine.runProgram` composes any program DESCRIPTOR into a verdict; each investor
 * program module builds and exports its own descriptor (today: `program-deephaven-dscr.DESCRIPTOR`). This
 * registry is the one place that CATALOGS those descriptors by investor key, so a caller can price "the
 * program for investor X" without importing X's module by name. Adding the second investor is: build its
 * descriptor in its own module, register it here — nothing in the pricing pipeline changes.
 *
 * The key is the normalized investor token (lowercased, non-alphanumerics stripped), matching how the rest
 * of the PPE keys an investor, so 'Deephaven', 'deephaven', 'Deephaven Mortgage' all resolve to the same
 * program by its registered aliases.
 *
 * SAFE. `programFor(key)` returns null for an unknown investor (never throws, never a wrong program);
 * `evaluateProgramFor(key, …)` returns null when there is no such program — a caller must decide what an
 * unknown investor means, rather than being handed a silent default. PURE: no DB, no network, no clock.
 * LT-only; no RTL import.
 */

const { runProgram } = require('./program-engine');
const deephaven = require('./program-deephaven-dscr');

const normKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

// Registered programs: normalized-alias → descriptor. Aliases let a live investor label (spelled many
// ways) resolve to one program without loosening the key normalizer.
const REGISTRATIONS = [
  { descriptor: deephaven.DESCRIPTOR, aliases: ['deephaven', 'deephavendscr', 'deephavenmortgage'] },
];

const BY_KEY = new Map();
for (const reg of REGISTRATIONS) {
  for (const a of reg.aliases) BY_KEY.set(normKey(a), reg.descriptor);
  BY_KEY.set(normKey(reg.descriptor.investor), reg.descriptor); // the descriptor's own investor name resolves too
}

// The program descriptor for an investor key, or null if none is registered. Never throws.
function programFor(investorKey) {
  return BY_KEY.get(normKey(investorKey)) || null;
}

// Every registered program's { investor, programName } — the catalog, for a UI/admin listing.
function listPrograms() {
  const seen = new Set();
  const out = [];
  for (const d of BY_KEY.values()) {
    if (seen.has(d)) continue;
    seen.add(d);
    out.push({ investor: d.investor, programName: d.programName });
  }
  return out;
}

/**
 * ⛔ THE ONE ANSWER TO "WHOSE PREPAYMENT LAYER APPLIES, AND WAS IT ASKED?" (§2.116).
 *
 * The agreement harness prices a SHEET, but a state's prepayment-penalty law lives in the INVESTOR's
 * Layer 3 (`deephaven-ppp-matrix`) and no rate sheet carries a borrower-type rule at all. So a run that
 * does not hand `buildOursLeg` a descriptor is BLIND to that layer — and it is blind SILENTLY, which is
 * the failure this whole workstream keeps finding. Measured 2026-08-19 over the canonical 305-scenario
 * battery on the built-in Deephaven sheet: without the descriptor our leg prices 262 and WITH it 260,
 * and one of the two it stops pricing is the battery's own `NJ Individual PPP prohibited` probe — a loan
 * the investor will not fund, which a blind run reports as "we price it, Lender Price refuses it", i.e.
 * as a sheet defect that is really our own omission.
 *
 * The verdict AND its wording live here because three callers need them — the agreement RUN route, the
 * pre-flight route, and the hand-run paid CLI — and a second copy would let one door claim the layer was
 * asked while another quietly skipped it. `asked:false` always carries a REASON and a sentence a person
 * can act on; a green run must never be able to hide "we did not look".
 */
function pppLayerFor(investorKey) {
  // A blank or whitespace-only investor is not a name we failed to register — it is no name at all, and
  // the two send a reader to different places (register a program vs. find out whose sheet this is).
  const raw = investorKey == null ? '' : String(investorKey).trim();
  const investor = raw === '' ? null : raw;
  const descriptor = investor ? programFor(investor) : null;
  if (descriptor) return { descriptor, asked: true, investor };
  return {
    descriptor: null,
    asked: false,
    investor,
    reason: investor ? 'no_registered_program' : 'investor_unknown',
    note: investor
      ? `No investor program is registered for “${investor}”, so its prepayment-penalty rules were not part of this measurement.`
      : 'This sheet\'s investor could not be read, so no prepayment-penalty rules were part of this measurement.',
  };
}

/**
 * Evaluate the program registered for `investorKey` against a scenario's engine facts.
 * Returns the program verdict, or null if no program is registered for that investor (the caller decides
 * what an unknown investor means — we never fall back to a default program silently).
 */
function evaluateProgramFor(investorKey, facts, opts = {}) {
  const desc = programFor(investorKey);
  return desc ? runProgram(desc, facts, opts) : null;
}

module.exports = { programFor, pppLayerFor, evaluateProgramFor, listPrograms, _normKey: normKey };
