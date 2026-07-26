'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Phase 1i wiring guard.
 *
 * The shadow FEED is a single guarded call in the auto-read batch loop
 * (src/routes/underwriting.js). This is a source-contract test that keeps that wiring from
 * silently drifting away: it proves the route imports maybeEnqueueUpload and calls it inside the
 * auto-read loop with the document id, loan id, and family — so bank_statement/insurance documents
 * are queued into the V2 shadow pipeline BESIDE Pipeline V1. (The enqueue behavior itself — gate,
 * idempotency, never-throws — is proven by test-enqueue-on-upload-{pure,db}.js.)
 */
const assert = require('assert');
const fs = require('fs');
const R = require('path').resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const src = fs.readFileSync(R + '/src/routes/underwriting.js', 'utf8');

// The route imports the shadow enqueue helper.
ok(/require\(['"]\.\.\/pipeline\/enqueue-on-upload['"]\)/.test(src), 'underwriting.js requires ../pipeline/enqueue-on-upload');
ok(/\bmaybeEnqueueUpload\b/.test(src), 'maybeEnqueueUpload is referenced');

// The call passes the right shape: documentId (item.id), loanId (app.id), family (item.expectedType).
const call = src.match(/maybeEnqueueUpload\(\s*db\s*,\s*\{[^}]*\}\s*\)/);
ok(!!call, 'maybeEnqueueUpload is called with (db, {...})');
if (call) {
  const body = call[0];
  ok(/documentId:\s*item\.id/.test(body), 'call passes documentId: item.id');
  ok(/loanId:\s*app\.id/.test(body), 'call passes loanId: app.id');
  ok(/family:\s*item\.expectedType/.test(body), 'call passes family: item.expectedType');
}

// The call sits inside the auto-read batch loop (after `for (const item of batch)` and before the
// V1 `analyzeOneDocument`), so it feeds shadow off the same per-document batch.
const loopIdx = src.indexOf('for (const item of batch)');
const callIdx = src.indexOf('maybeEnqueueUpload(db');
// The V1 analyze call for the batch item comes AFTER the enqueue call (analyzeOneDocument is a
// shared helper referenced earlier too, so search from the enqueue call forward).
const analyzeIdx = src.indexOf('analyzeOneDocument(app, doc', callIdx);
ok(loopIdx !== -1 && callIdx !== -1 && analyzeIdx !== -1, 'loop + call + analyze all present');
ok(loopIdx < callIdx && callIdx < analyzeIdx, 'shadow enqueue runs inside the loop, before the V1 analyze');

// The route module still loads (the new require resolves + the file parses).
let loaded = false;
try { require(R + '/src/routes/underwriting'); loaded = true; } catch (e) { console.log('  load error:', e && e.message); }
ok(loaded, 'src/routes/underwriting.js loads with the shadow-feed wiring');

console.log(`test-shadow-feed-wiring-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
