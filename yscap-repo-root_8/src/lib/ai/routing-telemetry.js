'use strict';
/**
 * P0 — Routing accuracy telemetry (deterministic aggregator, ADVISORY).
 *
 * The owner's Gap 1: "you have an impressive engine but not yet a proven
 * product — you can't yet answer which OCR provider performs best by document
 * type, how often two reads disagree, how often a page needs a re-read." Every
 * document-aware read (routing-matrix) now emits an OUTCOME: the winning engine,
 * whether the two reads reconciled, which pages were weak, which were re-read.
 * This module turns a stream of those outcomes into the SCOREBOARD — per
 * document family and per engine — so a human can SEE which reader is best where,
 * and (later) let the router self-improve on measured accuracy.
 *
 * Pure: no DB, no I/O. The persistence layer (db/270 routing_outcomes) feeds it
 * rows; this computes the rollup. Advisory — it measures, it never routes or
 * blocks. `recommendPrimary` is a SUGGESTION for a human/config to adopt, never
 * auto-applied.
 */

// A single routing outcome, as recorded per read:
//   { docFamily, winnerEngine, engineSequence:[...], disagreement:bool,
//     weakPageCount:int, rereadPageCount:int, humanCorrected?:bool }
// humanCorrected (optional) = a human later changed an extracted value from this
// read — the ground-truth signal that the winning engine got it wrong.

function inc(obj, key, by) { obj[key] = (obj[key] || 0) + (by == null ? 1 : by); }
function rate(n, d) { return d > 0 ? +(n / d).toFixed(4) : 0; }

/**
 * aggregateRoutingOutcomes(events) → {
 *   byFamily: { [docFamily]: { reads, winnerEngineCounts, disagreementRate,
 *                              rereadRate, avgWeakPages, correctionRate } },
 *   byEngine: { [engine]: { wins, rescues, correctionRate, reads } },
 *   totals:   { reads, disagreements, rereads, corrections },
 * }
 * A "rescue" = the engine won a read where it was NOT the first engine tried
 * (it rescued a weak/empty primary). correctionRate needs humanCorrected on the
 * events; it's 0 when that signal is absent (absence ≠ accuracy).
 */
function aggregateRoutingOutcomes(events) {
  const list = Array.isArray(events) ? events : [];
  const byFamily = {};
  const byEngine = {};
  const totals = { reads: 0, disagreements: 0, rereads: 0, corrections: 0 };

  for (const e of list) {
    if (!e) continue;
    const fam = e.docFamily || 'unknown';
    const eng = e.winnerEngine || 'unknown';
    const seq = Array.isArray(e.engineSequence) ? e.engineSequence : [];

    totals.reads++;
    if (e.disagreement) totals.disagreements++;
    if ((e.rereadPageCount || 0) > 0) totals.rereads++;
    if (e.humanCorrected) totals.corrections++;

    const f = byFamily[fam] || (byFamily[fam] = { reads: 0, winnerEngineCounts: {}, _disagree: 0, _reread: 0, _weak: 0, _corrected: 0 });
    f.reads++;
    inc(f.winnerEngineCounts, eng);
    if (e.disagreement) f._disagree++;
    if ((e.rereadPageCount || 0) > 0) f._reread++;
    f._weak += Number(e.weakPageCount || 0);
    if (e.humanCorrected) f._corrected++;

    const en = byEngine[eng] || (byEngine[eng] = { reads: 0, wins: 0, rescues: 0, _corrected: 0 });
    en.reads++;
    en.wins++;
    // A rescue: the winner is not the FIRST engine in the sequence.
    if (seq.length > 1 && seq[0] && seq[0] !== engineShort(eng)) en.rescues++;
    if (e.humanCorrected) en._corrected++;
  }

  // Finalize rates.
  for (const fam of Object.keys(byFamily)) {
    const f = byFamily[fam];
    f.disagreementRate = rate(f._disagree, f.reads);
    f.rereadRate = rate(f._reread, f.reads);
    f.avgWeakPages = rate(f._weak, f.reads);
    f.correctionRate = rate(f._corrected, f.reads);
    delete f._disagree; delete f._reread; delete f._weak; delete f._corrected;
  }
  for (const eng of Object.keys(byEngine)) {
    const en = byEngine[eng];
    en.correctionRate = rate(en._corrected, en.reads);
    delete en._corrected;
  }

  return { byFamily, byEngine, totals };
}

// The engineSequence records short engine keys ('azure'/'google'/'mistral');
// winnerEngine is the full label ('azure-docint'). Normalize the label to its
// short key for the rescue comparison.
function engineShort(label) {
  const l = String(label || '');
  if (l.indexOf('azure') !== -1) return 'azure';
  if (l.indexOf('google') !== -1) return 'google';
  if (l.indexOf('mistral') !== -1) return 'mistral';
  return l;
}

/**
 * recommendPrimary(byFamily, { minReads, byEngine }) → { [docFamily]: { engine, basis } }.
 * For each family with enough reads, SUGGESTS the engine that won the most reads
 * as the family's primary reader — the seed for measured routing self-improvement.
 * Ties are broken by the engine's own correction rate ASC (lower is more
 * accurate) when `byEngine` is supplied, else by engine name for determinism.
 * Advisory only; a human/config adopts it.
 */
function recommendPrimary(byFamily, opts = {}) {
  const minReads = opts.minReads != null ? opts.minReads : 20;
  const byEngine = opts.byEngine || {};
  const corr = (eng) => (byEngine[eng] && Number.isFinite(byEngine[eng].correctionRate)) ? byEngine[eng].correctionRate : 0;
  const out = {};
  for (const fam of Object.keys(byFamily || {})) {
    const f = byFamily[fam];
    if (!f || f.reads < minReads) continue;
    const engines = Object.keys(f.winnerEngineCounts || {});
    if (!engines.length) continue;
    // Rank by win count DESC, then by the engine's own correction rate ASC (a
    // real per-engine accuracy signal), then by engine name for determinism.
    engines.sort((a, b) =>
      (f.winnerEngineCounts[b] - f.winnerEngineCounts[a])
      || (corr(a) - corr(b))
      || (a < b ? -1 : a > b ? 1 : 0));
    const engine = engines[0];
    out[fam] = {
      engine,
      basis: { reads: f.reads, wins: f.winnerEngineCounts[engine], disagreementRate: f.disagreementRate, correctionRate: f.correctionRate },
    };
  }
  return out;
}

module.exports = { aggregateRoutingOutcomes, recommendPrimary, _internals: { engineShort } };
