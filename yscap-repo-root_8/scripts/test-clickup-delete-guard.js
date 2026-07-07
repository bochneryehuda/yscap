/* Safety regression test for the ClickUp "never delete a file" hard stop.
 * Locks in the owner-directed rule: deleting a file in the portal must NEVER
 * delete/remove the task in ClickUp. The guard lives in src/clickup/client.js
 * at the single request choke point, so no code path can ever issue a task
 * deletion. Run: node scripts/test-clickup-delete-guard.js  (no DB / network) */
const client = require('../src/clickup/client');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// A DELETE addressed to a specific task MUST be blocked (hard stop).
const blocked = (method, path) => {
  try { client.guardNoTaskDeletion(method, path); return false; }
  catch (e) { return e.code === 'CLICKUP_DELETE_FORBIDDEN'; }
};
// A call the guard must let through (it may fail later for other reasons, but
// the guard itself must not throw).
const allowed = (method, path) => {
  try { client.guardNoTaskDeletion(method, path); return true; } catch { return false; }
};

// ---- BLOCKED: every way to delete/remove a task/file ----
ok('DELETE /task/{id} blocked',                 blocked('DELETE', '/task/868abc'));
ok('DELETE /task/{id}?custom_task_ids blocked', blocked('DELETE', '/task/ABC-123?custom_task_ids=true&team_id=9'));
ok('DELETE /list/{id}/task/{id} blocked',       blocked('DELETE', '/list/900/task/868abc')); // remove-from-list
ok('lowercase delete method blocked',           blocked('delete', '/task/868abc'));
ok('subtask delete blocked (same endpoint)',    blocked('DELETE', '/task/subtask999'));

// ---- ALLOWED: reads, updates, and non-file plumbing are never blocked ----
ok('GET task allowed',            allowed('GET',    '/task/868abc'));
ok('PUT task (update) allowed',   allowed('PUT',    '/task/868abc'));
ok('POST set-field allowed',      allowed('POST',   '/task/868abc/field/f1'));
ok('POST create task allowed',    allowed('POST',   '/list/900/task'));
ok('POST add-to-list allowed',    allowed('POST',   '/list/900/task/868abc'));
ok('DELETE /webhook/{id} allowed (plumbing, not a file)', allowed('DELETE', '/webhook/wh_123'));

// ---- The exported helper that IS a task-delete must itself be blocked when invoked ----
(async () => {
  let threw = null;
  try { await client.removeTaskFromList('900', '868abc'); } catch (e) { threw = e.code; }
  ok('removeTaskFromList() is blocked by the guard', threw === 'CLICKUP_DELETE_FORBIDDEN');

  console.log(`\nclickup delete-guard: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
