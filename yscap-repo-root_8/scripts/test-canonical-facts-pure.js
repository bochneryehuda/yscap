'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-4 canonical fact selection
 * (src/pipeline/canonical-facts.js). Pure: no DB, no network.
 *
 * Proves: many evidence candidates for the same fact collapse to ONE canonical value chosen by
 * status rank → confidence → recency; a `superseded` candidate is dropped (version resolution); a
 * disagreement is flagged `contested`; facts are scoped by document family; empty/garbage → empty
 * summary; never throws.
 */
const R = require('path').resolve(__dirname, '..');
const CF = require(R + '/src/pipeline/canonical-facts');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const factFor = (res, key) => res.facts.find((f) => f.fieldKey === key);

(function main() {
  // ---- empty / garbage → empty summary, never throws ----
  ok(CF.selectCanonicalFacts(null).factCount === 0, 'null → 0 facts');
  ok(CF.selectCanonicalFacts([]).factCount === 0, 'empty array → 0 facts');
  ok(CF.selectCanonicalFacts([null, 5, 'x', {}]).factCount === 0, 'garbage rows → 0 facts (no throw)');
  ok(CF.selectCanonicalFacts([{ fieldKey: '', family: 'x', valueText: 'v' }]).factCount === 0, 'blank fieldKey skipped');

  // ---- status rank wins over confidence ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'a', family: 'bank_statement', fieldKey: 'holder', valueText: 'John Smith', status: 'verified', confidence: 0.6 },
      { id: 'b', family: 'bank_statement', fieldKey: 'holder', valueText: 'J. Smith', status: 'unverified', confidence: 0.99 },
    ]);
    const f = factFor(res, 'holder');
    ok(res.factCount === 1, 'two candidates for one fact → one canonical fact');
    ok(f && f.candidateId === 'a', 'higher STATUS (verified) beats higher confidence (unverified)');
    ok(f && f.alternativesCount === 1 && f.alternatives.length === 1, 'the loser is kept as an alternative');
    ok(f && f.contested === true, 'differing values flag the fact contested');
    ok(res.contestedCount === 1, 'contestedCount counts it');
  }

  // ---- confidence breaks a status tie ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'a', family: 'ins', fieldKey: 'coverage', valueText: '1200', status: 'verified', confidence: 0.7 },
      { id: 'b', family: 'ins', fieldKey: 'coverage', valueText: '1200', status: 'verified', confidence: 0.9 },
    ]);
    const f = factFor(res, 'coverage');
    ok(f && f.candidateId === 'b', 'same status → higher confidence wins');
    ok(f && f.contested === false, 'same value ("1200" vs "1200") → not contested');
  }

  // ---- recency breaks a status+confidence tie (newer document version wins) ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'old', family: 'bank', fieldKey: 'balance', valueText: '500', status: 'verified', confidence: 0.8, createdAt: '2026-07-01T00:00:00Z' },
      { id: 'new', family: 'bank', fieldKey: 'balance', valueText: '900', status: 'verified', confidence: 0.8, createdAt: '2026-07-20T00:00:00Z' },
    ]);
    const f = factFor(res, 'balance');
    ok(f && f.candidateId === 'new', 'status+confidence tie → newer createdAt wins (version resolution)');
    ok(f && f.value === '900', 'the newer value is canonical');
  }

  // ---- version resolution: a superseded candidate is dropped ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'sup', family: 'bank', fieldKey: 'holder', valueText: 'OLD LLC', status: 'superseded', confidence: 0.99 },
      { id: 'cur', family: 'bank', fieldKey: 'holder', valueText: 'NEW LLC', status: 'unverified', confidence: 0.5 },
    ]);
    const f = factFor(res, 'holder');
    ok(res.supersededDropped === 1, 'superseded candidate counted as dropped');
    ok(f && f.candidateId === 'cur', 'superseded never wins even at higher confidence');
    ok(f && f.contested === false, 'the dropped superseded value does not make the fact contested');
  }

  // ---- family scoping: the same fieldKey in two families is two facts ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'a', family: 'bank_statement', fieldKey: 'document_type', valueText: 'bank_statement', status: 'verified' },
      { id: 'b', family: 'insurance', fieldKey: 'document_type', valueText: 'insurance', status: 'verified' },
    ]);
    ok(res.factCount === 2, 'same fieldKey across two families → two separate facts');
  }

  // ---- contradicted status flags contested even with no rival value ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'a', family: 'x', fieldKey: 'k', valueText: 'v', status: 'contradicted', confidence: 0.9 },
    ]);
    const f = factFor(res, 'k');
    ok(f && f.contested === true, 'a contradicted winner is contested');
  }

  // ---- manual_verified is the strongest ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'v', family: 'x', fieldKey: 'k', valueText: 'a', status: 'verified', confidence: 0.99 },
      { id: 'm', family: 'x', fieldKey: 'k', valueText: 'b', status: 'manual_verified', confidence: 0.1 },
    ]);
    ok(factFor(res, 'k').candidateId === 'm', 'manual_verified beats verified regardless of confidence');
  }

  // ---- includeAlternatives:false drops the alternatives array but keeps the count ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'a', family: 'x', fieldKey: 'k', valueText: '1', status: 'verified' },
      { id: 'b', family: 'x', fieldKey: 'k', valueText: '2', status: 'unverified' },
    ], { includeAlternatives: false });
    const f = factFor(res, 'k');
    ok(f && f.alternatives === undefined && f.alternativesCount === 1, 'includeAlternatives:false → no array, count kept');
  }

  // ---- contested facts sort first ----
  {
    const res = CF.selectCanonicalFacts([
      { id: 'a', family: 'x', fieldKey: 'aaa', valueText: '1', status: 'verified' },
      { id: 'b', family: 'x', fieldKey: 'zzz', valueText: '1', status: 'verified' },
      { id: 'c', family: 'x', fieldKey: 'zzz', valueText: '2', status: 'unverified' },
    ]);
    ok(res.facts[0].fieldKey === 'zzz' && res.facts[0].contested, 'contested fact sorts before an uncontested one');
  }

  console.log(`test-canonical-facts-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
