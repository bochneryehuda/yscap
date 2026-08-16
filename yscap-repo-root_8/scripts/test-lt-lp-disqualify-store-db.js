#!/usr/bin/env node
'use strict';
/**
 * LT Lender Price durable ineligible-store (db/559) — proves the A-to-Z audit's #1 ineligible-workflow
 * fix: the disqualify kickoff + cached result SURVIVE a reboot (the in-memory Map is L1; Postgres is
 * the durable L2). Degrades gracefully when the DB is absent.
 *
 *   node scripts/test-lt-lp-disqualify-store-db.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-lp-disqualify-store-db.js
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/longterm/lenderprice/disqualify-store');
const lp = require('../src/longterm/lenderprice/client');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

(async () => {
  console.log('LT LP durable ineligible store — degrade-gracefully (no DB)\n');

  // ---- PURE: with no DB injected the whole module quietly no-ops (never throws) ----
  store._setDb(null);
  ok(store.enabled() === false, 'with no DB the store is disabled');
  ok((await store.persist('k', { url: 'u', body: {}, requestId: 'r', expiresAt: Date.now() + 1000 })) === false, 'persist degrades to false (no throw)');
  ok((await store.load('k')) === null, 'load degrades to null');
  ok((await store.saveResult('k', { x: 1 })) === false, 'saveResult degrades to false');
  ok((await store.prune()) === 0, 'prune degrades to 0');

  if (!process.env.DATABASE_URL) {
    console.log('\n(DB round-trip skipped — set DATABASE_URL to run it.)');
    console.log(`\n${failures ? failures + ' FAILED' : 'all passed (pure)'}`);
    process.exit(failures ? 1 : 0);
  }

  console.log('\nLT LP durable ineligible store — DB round-trip\n');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  store._setDb(db); // client's disqStore is the SAME cached module — one injection covers both
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '559_lt_lp_disqualify_search.sql'), 'utf8');
    await db.query(sql); // idempotent
    ok(true, 'db/559 applied (idempotent)');
    ok(store.enabled() === true, 'the store is enabled once a DB is present');

    const key = 'test_' + Math.abs(process.pid || 1) + '_' + Date.now();
    await db.query('DELETE FROM lt_lp_disqualify_search WHERE search_key LIKE $1', ['test_%']);

    const body = { criteria: { loanPurpose: 'Purchase', loanAmount: 375000 }, cachedDisqualified: false };
    const exp = Date.now() + 60000;
    ok((await store.persist(key, { url: 'https://x/searchRaw', body, requestId: 'RID_FIRST', expiresAt: exp })) === true, 'persist stores a kickoff');

    const loaded = await store.load(key);
    ok(loaded && loaded.requestId === 'RID_FIRST' && loaded.body.criteria.loanAmount === 375000, 'load returns the body + requestId verbatim');
    ok(loaded.result === null, 'no result yet');

    // §27.4 parity — a second identical kickoff must NOT overwrite the first requestId (COALESCE).
    await store.persist(key, { url: 'https://x/searchRaw', body, requestId: 'RID_SECOND', expiresAt: Date.now() + 90000 });
    ok((await store.load(key)).requestId === 'RID_FIRST', 'a concurrent second kickoff keeps the FIRST requestId (COALESCE)');

    // Materialize a parsed result (the compact structure, not the huge raw tree).
    const parsedResult = { ready: true, lenderCount: 2, itemCount: 3, lenders: [{ lender: 'Acme', items: [{ program: 'DSCR30' }] }] };
    ok((await store.saveResult(key, parsedResult, { summary: true })) === true, 'saveResult materializes the parsed result');
    ok((await store.load(key)).result.lenderCount === 2, 'the materialized result round-trips');

    // THE REBOOT: wipe the in-memory L1 Map. A poll must rehydrate from Postgres and serve the cached
    // result WITHOUT re-running the search (no network).
    lp._internals.DISQ_STORE.clear();
    ok(lp._internals.hasStoredSearch(key) === false, 'after the "reboot" the L1 Map has NO record of the search');
    const pr = await lp._internals.pollDisqualifiedByKey(key);
    ok(pr.ok === true && pr.ready === true && pr.cached === true, 'the poll rehydrates from Postgres and serves the cached result');
    ok(pr.parsed && pr.parsed.lenderCount === 2, '…and it is the SAME materialized result (no re-download)');
    ok(lp._internals.hasStoredSearch(key) === true, 'the rehydrated entry is back in L1');

    // Prune removes an expired row.
    const oldKey = key + '_old';
    await store.persist(oldKey, { url: 'u', body: {}, requestId: 'r', expiresAt: Date.now() - 1000 });
    ok((await store.load(oldKey)) === null, 'an expired row is not loaded');
    await store.prune();
    const stillThere = await db.query('SELECT 1 FROM lt_lp_disqualify_search WHERE search_key = $1', [oldKey]);
    ok(stillThere.rows.length === 0, 'prune deletes the expired row');

    // cleanup
    await db.query('DELETE FROM lt_lp_disqualify_search WHERE search_key LIKE $1', ['test_%']);
  } finally {
    store._setDb(null);
    await db.end();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
