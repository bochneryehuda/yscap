'use strict';
/**
 * P0 — pure tests for the routing accuracy aggregator. Proves it turns a stream
 * of per-read outcomes into the scoreboard the owner asked for: per document
 * family (which engine won, disagreement rate, re-read rate, avg weak pages,
 * correction rate) and per engine (wins, rescues, correction rate), plus a
 * measured primary-reader recommendation. Advisory — it measures, never routes.
 */
const assert = require('assert');
const rt = require('../src/lib/ai/routing-telemetry');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const events = [
  // bank statements — Azure wins, one disagreement, one page re-read
  { docFamily: 'bank_statement', winnerEngine: 'azure-docint', engineSequence: ['azure', 'google'], disagreement: true, weakPageCount: 1, rereadPageCount: 1 },
  { docFamily: 'bank_statement', winnerEngine: 'azure-docint', engineSequence: ['azure'], disagreement: false, weakPageCount: 0, rereadPageCount: 0 },
  { docFamily: 'bank_statement', winnerEngine: 'google-docai', engineSequence: ['azure', 'google'], disagreement: false, weakPageCount: 2, rereadPageCount: 0, humanCorrected: true },
  // government IDs — Google rescues Azure both times
  { docFamily: 'government_id', winnerEngine: 'google-docai', engineSequence: ['azure', 'google'], disagreement: false, weakPageCount: 0, rereadPageCount: 0 },
  { docFamily: 'government_id', winnerEngine: 'google-docai', engineSequence: ['azure', 'google'], disagreement: false, weakPageCount: 0, rereadPageCount: 0 },
];

const agg = rt.aggregateRoutingOutcomes(events);

// --- totals ---
assert.strictEqual(agg.totals.reads, 5);
assert.strictEqual(agg.totals.disagreements, 1);
assert.strictEqual(agg.totals.rereads, 1);
assert.strictEqual(agg.totals.corrections, 1);
ok('totals roll up reads / disagreements / rereads / corrections');

// --- per family ---
const bs = agg.byFamily.bank_statement;
assert.strictEqual(bs.reads, 3);
assert.strictEqual(bs.winnerEngineCounts['azure-docint'], 2);
assert.strictEqual(bs.winnerEngineCounts['google-docai'], 1);
assert.strictEqual(bs.disagreementRate, +(1 / 3).toFixed(4), 'disagreement rate per family');
assert.strictEqual(bs.rereadRate, +(1 / 3).toFixed(4));
assert.strictEqual(bs.avgWeakPages, +(3 / 3).toFixed(4), 'avg weak pages = (1+0+2)/3');
assert.strictEqual(bs.correctionRate, +(1 / 3).toFixed(4));
ok('per-family scoreboard: winning engines, disagreement/reread/correction rates, avg weak pages');

// --- per engine: rescues counted when the winner was not first tried ---
const g = agg.byEngine['google-docai'];
assert.strictEqual(g.wins, 3, 'google won 3 reads (1 bank + 2 ids)');
assert.strictEqual(g.rescues, 3, 'every google win came after azure was tried first → 3 rescues');
const az = agg.byEngine['azure-docint'];
assert.strictEqual(az.wins, 2);
assert.strictEqual(az.rescues, 0, 'azure was always the first engine → 0 rescues');
ok('per-engine scoreboard: wins + rescues (won after another engine was tried first)');

// --- recommendPrimary suggests the empirical winner once there are enough reads ---
let rec = rt.recommendPrimary(agg.byFamily, { minReads: 2 });
assert.strictEqual(rec.bank_statement.engine, 'azure-docint', 'azure won the most bank-statement reads');
assert.strictEqual(rec.government_id.engine, 'google-docai', 'google won every government_id read');
ok('recommendPrimary suggests the measured best engine per family');

// --- a tie on win count is broken by the engine's own correction rate (lower wins) ---
const tie = rt.aggregateRoutingOutcomes([
  { docFamily: 'title', winnerEngine: 'azure-docint', engineSequence: ['azure'], humanCorrected: true },
  { docFamily: 'title', winnerEngine: 'google-docai', engineSequence: ['azure', 'google'] },
]);
// both engines have 1 win for 'title'; azure was corrected once (rate 1), google 0 → google wins the tie
const tieRec = rt.recommendPrimary(tie.byFamily, { minReads: 2, byEngine: tie.byEngine });
assert.strictEqual(tieRec.title.engine, 'google-docai', 'a win-count tie is broken by lower correction rate');
ok('a win-count tie is broken by the engine with the lower correction rate');

// --- below the min-reads threshold, no recommendation (not enough evidence) ---
rec = rt.recommendPrimary(agg.byFamily, { minReads: 100 });
assert.deepStrictEqual(rec, {}, 'not enough reads → no recommendation');
ok('recommendPrimary withholds a recommendation until there is enough evidence');

// --- empty / junk input is safe ---
assert.deepStrictEqual(rt.aggregateRoutingOutcomes([]).totals, { reads: 0, disagreements: 0, rereads: 0, corrections: 0 });
assert.doesNotThrow(() => rt.aggregateRoutingOutcomes(null));
ok('empty / null input returns a safe zeroed scoreboard (never throws)');

console.log(`\nP0 routing-telemetry pure — ${passed} checks passed`);
