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
 * Evaluate the program registered for `investorKey` against a scenario's engine facts.
 * Returns the program verdict, or null if no program is registered for that investor (the caller decides
 * what an unknown investor means — we never fall back to a default program silently).
 */
function evaluateProgramFor(investorKey, facts, opts = {}) {
  const desc = programFor(investorKey);
  return desc ? runProgram(desc, facts, opts) : null;
}

module.exports = { programFor, evaluateProgramFor, listPrograms, _normKey: normKey };
