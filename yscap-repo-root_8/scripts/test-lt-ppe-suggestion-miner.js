#!/usr/bin/env node
'use strict';
/**
 * LT PPE suggestion miner (Part 3 P2) — pure offline test (fake db).
 * Proves the glue that turns a Lender Price disqualified result into persisted per-investor
 * suggestions: analyze → saveSuggestions. Best-effort, never throws.
 *
 *   node scripts/test-lt-ppe-suggestion-miner.js
 */
const { mineFromParsed } = require('../src/longterm/ppe/suggestion-miner');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

console.log('LT PPE suggestion miner — offline\n');

const parsed = {
  ready: true, lenderCount: 1, itemCount: 1, reasonCount: 2,
  lenders: [{ lender: 'Some Lender', investor: 'Deephaven', items: [{ program: 'DSCR 30 Yr Fixed', reasons: [
    { rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' },
    { rule: 'Investor overlay applies', adjType: 'MysteryAdjustment' }, // unmappable
  ] }] }],
};

(async () => {
  // 1) Mines + saves; the fake db just records the upserts.
  {
    const upserts = [];
    const db = { query: async (t, p) => { upserts.push({ t, p }); return { rows: [] }; } };
    const out = await mineFromParsed(db, 'company', parsed);
    ok(out.ok, 'mine succeeds');
    ok(out.suggestionCount === 1 && out.unmappedCount === 1, '1 mappable suggestion + 1 unmapped counted');
    ok(out.investorCount === 1 && out.investors[0].investor === 'Deephaven', 'per-investor summary reported');
    ok(upserts.length === 2, 'both the mapped and unmapped rows are upserted (nothing dropped)');
  }

  // 2) An empty / not-ready result mines nothing (never throws).
  {
    const db = { query: async () => ({ rows: [] }) };
    const out = await mineFromParsed(db, 'company', { ready: false });
    ok(out.ok && out.saved === 0 && out.suggestionCount === 0, 'a not-ready result mines nothing');
  }

  // 3) A DB failure is caught and reported (best-effort, never throws).
  {
    const db = { query: async () => { throw new Error('db down'); } };
    const out = await mineFromParsed(db, 'company', parsed);
    ok(!out.ok && /db down/.test(out.error), 'a db failure returns { ok:false, error } and does not throw');
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
