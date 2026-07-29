'use strict';

/*
 * The four "workflow step" condition codes (LTC/LTV/ARV checked + interest
 * reserves) are HIDDEN from the conditions list on the client and, as of this
 * change, EXCLUDED from the server's readiness / "Go fix" aggregator so a hidden
 * row never shows as an outstanding item that leads nowhere.
 *
 * That only works if the two lists agree. The client list lives in
 * `app-v2/src/lib/condition-workflow-steps.js` (ESM), the server list in
 * `src/lib/conditions/workflow-step-codes.js` (CommonJS). This test parses both
 * files' code arrays and asserts they are IDENTICAL — a JS/DB-twin style guard, so
 * adding or removing a code in one place and forgetting the other fails the suite.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The server list — a plain require.
const { WORKFLOW_STEP_CODES } = require(path.join(ROOT, 'src/lib/conditions/workflow-step-codes'));

// The client list — parse the ESM source (no bundler in this test env). Pull the
// quoted codes out of the `new Set([ ... ])` literal.
const clientSrc = fs.readFileSync(
  path.join(ROOT, 'app-v2/src/lib/condition-workflow-steps.js'), 'utf8');
const setMatch = clientSrc.match(/WORKFLOW_STEP_CODES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
assert.ok(setMatch, 'could not find WORKFLOW_STEP_CODES = new Set([...]) in the client module');
const clientCodes = [...setMatch[1].matchAll(/['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]);

assert.ok(clientCodes.length > 0, 'parsed zero client codes — the regex or the file shape changed');

const serverSorted = [...WORKFLOW_STEP_CODES].sort();
const clientSorted = [...clientCodes].sort();

assert.deepStrictEqual(
  serverSorted, clientSorted,
  `workflow-step code lists have DRIFTED.\n  server: ${JSON.stringify(serverSorted)}\n  client: ${JSON.stringify(clientSorted)}\n` +
  'Update BOTH src/lib/conditions/workflow-step-codes.js and app-v2/src/lib/condition-workflow-steps.js.');

// The three clear-to-close GATES must NEVER be on this list (the server enforces
// them; hiding them would let a file close with a step un-done).
for (const gate of ['rtl_p4_ts', 'rtl_f_review', 'rtl_f_ctc']) {
  assert.ok(!WORKFLOW_STEP_CODES.includes(gate),
    `${gate} is a clear-to-close GATE and must never be a hidden workflow step`);
}

console.log(`workflow-step-codes parity OK — ${serverSorted.length} codes match: ${serverSorted.join(', ')}`);
