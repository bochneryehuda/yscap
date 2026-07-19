/* WO-6 (F-M14) — a deleted ClickUp task is a hard 404, never a 401.
 *
 * isTaskDeletedError decides whether a failed getTask means "this task was
 * deleted" — which lets reconcile archive/merge the portal file. Previously it
 * also accepted a 401 whose message said "not found"; but ClickUp returns
 * "Authorization token not found" for a bad/missing/ROTATING token, so during a
 * token rotation live files could be misclassified as orphans and archived
 * (only the 50%-orphan breaker stood in the way). The fix requires a hard 404.
 *
 * Verifies, with no DB / no network. Run: node scripts/test-task-deleted-detection.js */
const sync = require('../src/sync/clickup-sync');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  if (got === exp) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

// A real deletion → 404 → true.
eq('404 is a deletion', sync.isTaskDeletedError({ status: 404 }), true);
eq('404 with a body is a deletion', sync.isTaskDeletedError({ status: 404, body: { err: 'Task not found' } }), true);

// The bug this fixes: a 401 auth error must NEVER be read as a deletion, no
// matter what its message says (token rotation, revoked token, etc.).
eq('401 "Authorization token not found" is NOT a deletion',
  sync.isTaskDeletedError({ status: 401, body: { err: 'Authorization token not found' }, message: 'ClickUp GET /task/x -> 401' }), false);
eq('401 "does not exist" is NOT a deletion',
  sync.isTaskDeletedError({ status: 401, message: 'token does not exist' }), false);
eq('401 plain is NOT a deletion', sync.isTaskDeletedError({ status: 401 }), false);

// Transient / other errors are not deletions either.
eq('429 is not a deletion', sync.isTaskDeletedError({ status: 429 }), false);
eq('500 is not a deletion', sync.isTaskDeletedError({ status: 500 }), false);
eq('network error is not a deletion', sync.isTaskDeletedError({ message: 'fetch failed' }), false);
eq('null error is not a deletion', sync.isTaskDeletedError(null), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
