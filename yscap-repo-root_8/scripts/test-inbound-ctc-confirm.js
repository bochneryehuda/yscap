'use strict';
/**
 * Clear-to-Close CONFIRM gate (owner-directed 2026-07-27): when ClickUp moves a
 * PRE-Clear-to-Close file to Clear to Close, PILOT holds the status and parks a
 * confirm review instead of advancing on its own. Pure test of the decision +
 * the confirm applier's input validation. No DB / network.
 */
const assert = require('assert');
const { shouldHoldCtc, confirmCtc, CTC, AT_OR_PAST_CTC } = require('../src/lib/inbound-ctc-confirm');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The move that IS held: incoming Clear to Close on a pre-CTC file.
ok(shouldHoldCtc('clear_to_close', 'underwriting') === true, 'hold: CTC arriving on an underwriting file');
ok(shouldHoldCtc('clear_to_close', 'in_review') === true, 'hold: CTC arriving on an in-review file');
ok(shouldHoldCtc('clear_to_close', 'approved') === true, 'hold: CTC arriving on an approved (but not yet CTC) file');
ok(shouldHoldCtc('clear_to_close', 'file_intake') === true, 'hold: CTC arriving on a brand-new file');
// declined/withdrawn are gated too — a surprise CTC on a terminal file is exactly
// what a human should confirm.
ok(shouldHoldCtc('clear_to_close', 'declined') === true, 'hold: CTC arriving on a declined file (a surprise to confirm)');

// NOT held: already at or past Clear to Close.
ok(shouldHoldCtc('clear_to_close', 'clear_to_close') === false, 'no-hold: already Clear to Close');
ok(shouldHoldCtc('clear_to_close', 'funded') === false, 'no-hold: already Funded (past CTC)');

// NOT held: the pull is not a move to Clear to Close.
ok(shouldHoldCtc('underwriting', 'in_review') === false, 'no-hold: an ordinary status move syncs normally');
ok(shouldHoldCtc('funded', 'clear_to_close') === false, 'no-hold: funded is not the CTC move');
ok(shouldHoldCtc('approved', 'underwriting') === false, 'no-hold: approved (not CTC) syncs normally');

// Unknown current status → never interfere.
ok(shouldHoldCtc('clear_to_close', null) === false, 'no-hold: unknown current status is left alone');
ok(shouldHoldCtc('clear_to_close', '') === false, 'no-hold: blank current status is left alone');

// Constants are what the rest of the stack expects.
ok(CTC === 'clear_to_close', 'CTC constant is the clear_to_close external bucket');
ok(AT_OR_PAST_CTC.has('clear_to_close') && AT_OR_PAST_CTC.has('funded') && !AT_OR_PAST_CTC.has('underwriting'),
  'AT_OR_PAST_CTC = {clear_to_close, funded}');

// ---------------------------------------------------------------------------
// THE READINESS GATE (owner-directed 2026-08-06: a file reached Clear to Close
// with conditions open and no executed term-sheet package, because confirmCtc
// wrote the status straight to the row and never consulted advancementBlockers).
//
// `advancementBlockers` lives on the staff ROUTE module, which confirmCtc
// requires LAZILY — so a stub planted in the require cache is enough to drive
// every branch with no database and no HTTP. The `client` parameter does the
// same for the row reads/writes.
// ---------------------------------------------------------------------------
const path = require('path');
const STAFF_PATH = require.resolve('../src/routes/staff');
let stubBlockers = { conditions: [], gates: [] };
let blockersThrows = false;
require.cache[STAFF_PATH] = {
  id: STAFF_PATH, filename: STAFF_PATH, loaded: true, exports: {
    advancementBlockers: async () => {
      if (blockersThrows) throw new Error('statement timeout');
      return stubBlockers;
    },
  },
};
const ICC = require('../src/lib/inbound-ctc-confirm');

// A client that answers every read plainly and records the writes, so the whole
// confirm path runs without a database.
function fakeClient(status) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      const s = String(sql);
      if (/^\s*SELECT status/i.test(s)) return { rows: [{ status, clickup_pipeline_task_id: null }] };
      if (/^\s*UPDATE applications/i.test(s)) { writes.push({ sql: s, params }); return { rows: [], rowCount: 1 }; }
      if (/INSERT INTO audit_log/i.test(s)) { writes.push({ sql: s, params }); return { rows: [] }; }
      if (/INSERT INTO application_status_history/i.test(s)) { writes.push({ sql: s, params }); return { rows: [] }; }
      return { rows: [{}] };
    },
  };
}
const APP = '11111111-1111-1111-1111-111111111111';
const wroteCtc = (c) => c.writes.some((w) => /UPDATE applications/i.test(w.sql) && w.params.includes('clear_to_close'));

(async () => {
  let threw = null;
  try { await confirmCtc({ appId: null }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.expose === true,
    'confirm: a missing application id is refused (422, before any DB work)');

  // --- ctcReadiness: the AI advisory filter mirrors the portal status door ---
  stubBlockers = {
    conditions: [{ title: 'Signed term sheet' }, { title: 'AI advisory: something', source: 'ai_advisory' },
                 { title: 'AI hint', source: 'ai_suggestion' }],
    gates: [],
  };
  let rd = await ICC.ctcReadiness(APP);
  ok(rd.conditions.length === 1 && rd.conditions[0].title === 'Signed term sheet',
    'readiness: AI advisory/suggestion rows are filtered out (they never gate — the HARD RULE)');
  ok(rd.ready === false, 'readiness: a real outstanding condition means NOT ready');

  stubBlockers = { conditions: [{ title: 'AI advisory: x', source: 'ai_advisory' }], gates: [] };
  rd = await ICC.ctcReadiness(APP);
  ok(rd.ready === true, 'readiness: a file whose ONLY blockers are AI advisories IS ready');

  // A GATE alone is enough to be not-ready — this is the executed term-sheet
  // package, the exact thing the owner found missing on a CTC file.
  stubBlockers = { conditions: [], gates: [{ title: 'Term sheet package not fully executed' }] };
  rd = await ICC.ctcReadiness(APP);
  ok(rd.ready === false && rd.gates.length === 1,
    'readiness: the executed term-sheet-package GATE alone makes a file not ready');
  ok(/Term sheet package not fully executed/.test(ICC.readinessSummary(rd) || ''),
    'readiness: the summary NAMES what is outstanding (never just a count)');
  ok(/ready for Clear to Close/.test(ICC.readinessSummary({ ready: true, conditions: [], gates: [] }) || ''),
    'readiness: a ready file gets plain confirmation wording');

  // --- the gate itself ---
  stubBlockers = { conditions: [{ title: 'Insurance binder' }], gates: [{ title: 'Term sheet package not fully executed' }] };
  let c = fakeClient('underwriting');
  threw = null;
  try { await confirmCtc({ appId: APP, client: c }); } catch (e) { threw = e; }
  ok(threw && threw.status === 409 && threw.code === 'ctc_not_ready' && threw.expose === true,
    'GATE: confirming an UNFINISHED file is refused (409), not silently applied');
  ok(threw && /Term sheet package not fully executed/.test(threw.message) && /Insurance binder/.test(threw.message),
    'GATE: the refusal names BOTH the missing package and the open condition');
  ok(!wroteCtc(c), 'GATE: a refused confirm writes NO status (the owner’s bug: it used to write anyway)');

  // A non-admin cannot force past it — force alone is not authority.
  c = fakeClient('underwriting'); threw = null;
  try { await confirmCtc({ appId: APP, force: true, allowForce: false, client: c }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'ctc_not_ready', 'GATE: force WITHOUT admin authority is still refused');
  ok(!wroteCtc(c), 'GATE: a non-admin force writes no status');

  // An ADMIN override advances it — the recorded escape hatch every gate has.
  c = fakeClient('underwriting');
  let out = await confirmCtc({ appId: APP, actorId: 'staff-1', force: true, allowForce: true, client: c });
  ok(out && out.forced === true && out.alreadyThere === false, 'OVERRIDE: an admin force advances the file');
  ok(wroteCtc(c), 'OVERRIDE: the status is actually written');
  const auditRow = c.writes.find((w) => /INSERT INTO audit_log/i.test(w.sql));
  ok(auditRow && /Term sheet package not fully executed/.test(String(auditRow.params[3])),
    'OVERRIDE IS NEVER SILENT: the audit row records WHAT was outstanding when it was overridden');
  ok(c.writes.some((w) => /INSERT INTO application_status_history/i.test(w.sql) && w.params.includes('clear_to_close')),
    'OVERRIDE: the move is recorded as real stage history (this door used to write none)');

  // A READY file confirms normally — the gate must not stand in the way of the
  // ordinary case it exists to protect.
  stubBlockers = { conditions: [], gates: [] };
  c = fakeClient('underwriting');
  out = await confirmCtc({ appId: APP, actorId: 'staff-1', client: c });
  ok(out && out.forced === false && wroteCtc(c), 'READY: a finished file confirms with no override needed');

  // An unreadable readiness check FAILS CLOSED — but retryably, and it must
  // never claim the file was moved.
  blockersThrows = true;
  c = fakeClient('underwriting'); threw = null;
  try { await confirmCtc({ appId: APP, client: c }); } catch (e) { threw = e; }
  ok(threw && threw.status === 503 && threw.expose === true,
    'FAILS CLOSED: an unreadable readiness check refuses (503 — retryable), never advances');
  ok(!wroteCtc(c), 'FAILS CLOSED: nothing is written when readiness could not be checked');
  blockersThrows = false;

  // FUNDED / CLOSED IS NOT GATED (owner: "it should only gate the actual clear
  // to close" — an inbound funded must flow through even on a held file).
  ok(shouldHoldCtc('funded', 'underwriting') === false,
    'NOT GATED: an inbound FUNDED on a file PILOT is holding pre-CTC applies normally');
  ok(shouldHoldCtc('funded', 'approved') === false, 'NOT GATED: funded is never held for confirmation');

  // A file already at/past CTC short-circuits BEFORE the readiness gate — there
  // is nothing to confirm, and re-judging a funded file would be nonsense.
  stubBlockers = { conditions: [{ title: 'something open' }], gates: [] };
  c = fakeClient('funded');
  out = await confirmCtc({ appId: APP, client: c });
  ok(out && out.alreadyThere === true && !wroteCtc(c),
    'NOT GATED: an already-Funded file is a no-op, never re-judged by the readiness gate');

  // The advisory-source list must stay identical to the portal door's.
  const staffSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
  const m = staffSrc.match(/AI_BLOCKER_SOURCES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  const portalSet = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort() : null;
  ok(portalSet && portalSet.join('|') === [...ICC.AI_BLOCKER_SOURCES].sort().join('|'),
    'PARITY: the advisory sources this gate ignores are exactly the portal status door’s');

  assert.strictEqual(failures, 0, `${failures} assertion(s) failed`);
  console.log(failures ? `\n${failures} failed` : '\nALL inbound-ctc-confirm assertions passed');
  process.exit(failures ? 1 : 0);
})();
