/* ASSIGNING AN OFFICER MOVES THE CARD OUT OF LEAD CAPTURE — the decision half, no network.
 *
 * Owner-directed 2026-08-21: *"if some file comes in without a loan officer and we assign a
 * loan officer to it, it should automatically move from the lead capture folder in ClickUp to
 * the loan officers folder in ClickUp. That task should move over. Do a lot of research on how
 * to make sure to do that and not mess up other stuff."*
 *
 * The "don't mess up other stuff" risk in this workspace is the STATUS. Statuses here are
 * LIST-level and the sets genuinely differ (verified live 2026-08-21): Lead Capture's list
 * carries `approved` and `imported to bank (2-em)`, which an officer list does not; an officer
 * list carries the whole `delegated …` ladder and the post-closing statuses, which Lead
 * Capture does not. Move a card naively and ClickUp re-buckets it — and PILOT reads that
 * status straight back inbound, moving the borrower's own status and, on a `(#-em)` status,
 * making ClickUp send an email.
 *
 * So this pins:
 *   A. the status plan — same name → touch nothing; absent → map ONLY through the
 *      word-preserving LANDING_INTERNAL table; not expressible → REFUSE, never guess;
 *   B. the WORD-PRESERVING property itself, asserted over every status in the map rather than
 *      on a couple of examples;
 *   C. the real Lead-Capture-only statuses from the live workspace, both ways;
 *   D. the client fence — v3 exists for exactly ONE call, and deletes are still impossible;
 *   E. the wiring — the assign door and the sweep both call it.
 *
 * Pure — no database, no network.
 * Run: node scripts/test-clickup-officer-move-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

const M = require('../src/clickup/officer-move');
const S = require('../src/clickup/status');
const client = require('../src/clickup/client');

const st = (id, name) => ({ id, status: name });

// The two real status sets, read off the LIVE workspace on 2026-08-21 (trimmed to what
// matters here). Using the real names is the point: an invented fixture would prove nothing
// about the lists this actually runs against.
const LEAD_CAPTURE_STATUSES = [
  'starting', 'prospect / pricing', 'active / fill clickup(1-em', 'self procesing',
  'assigned to processor', 'imported to bank (2-em)', 'in underwriting', 'approved',
  'approval processing (3-em)', 'waiting for docs', 'resubmitted (4-em)',
  'final submission (4-em)', 'ctc (4-email)', 'scheduling closing', 'active closing',
  'declined', 'rolled back ', 'structuring loan', 'inactive / on hold',
  'closed (6-email funded)', 'cancelled', 'refinanced', 'recalled', 'pre-recall', 'paid off',
].map((n, i) => st(`sc_lc_${i}`, n));
const OFFICER_STATUSES = [
  'starting', 'prospect / pricing', 'active / fill clickup(1-em', 'self procesing',
  'assigned to processor', 'delegated initial', 'delegated conditional',
  'delegated ctc submission', 'non del imported ba(2-em)', 'in underwriting', 'workflow',
  'secondary workflow', 'approval processing (3-em)', 'file being worked', 'file on desk',
  'waiting for docs', 'resubmitted (4-em)', 'final submission (4-em)', 'ctc (4-email)',
  'scheduling closing', 'active closing', 'declined', 'rolled back ', 'structuring loan',
  'inactive / on hold', 'closed (6-email funded)', 'cancelled', 'refinanced', 'recalled',
  'pre-recall', 'trash', 'cancelled & reconciled', 'in purchase review', 'purchase conditions',
  'pa issued-post closing.', 'waiting for final docs', 'non del closed reconciled',
  'closed reconciled',
].map((n, i) => st(`sc_of_${i}`, n));

// ---------------------------------------------------------------- A. the status plan
eq('A1 the same status exists in the destination → nothing is mapped',
  M.planStatusMapping(st('a', 'starting'), OFFICER_STATUSES), { ok: true, mappings: [] });
ok('A2 …case and trailing spaces do not fool it',
  M.planStatusMapping(st('a', '  Rolled Back '), OFFICER_STATUSES).mappings.length === 0);

{
  // The headline case: `approved` exists ONLY on the Lead Capture list.
  const p = M.planStatusMapping(st('src', 'approved'), OFFICER_STATUSES);
  ok('A3 a status the destination does not have IS mapped', p.ok && p.mappings.length === 1);
  const dest = OFFICER_STATUSES.find((x) => x.id === p.mappings[0].destination_status_id);
  eq('A4 …to the word-preserving landing status', dest.status, 'delegated ctc submission');
  eq('A5 …and the source id is the card’s own', p.mappings[0].source_status_id, 'src');
}

eq('A6 a status with no landing anywhere is REFUSED, never guessed',
  M.planStatusMapping(st('a', 'approved'), [st('b', 'starting')]).reason,
  'landing_status_missing_in_destination');
eq('A7 an unreadable destination list refuses too — never a blind move',
  M.planStatusMapping(st('a', 'starting'), []).reason, 'destination_statuses_unreadable');
eq('A8 a card with no readable status refuses',
  M.planStatusMapping(st('a', ''), OFFICER_STATUSES).reason, 'unknown_current_status');
eq('A9 …and so does one whose status carries no id to map FROM',
  M.planStatusMapping({ status: 'approved' }, OFFICER_STATUSES).reason, 'status_ids_unreadable');

// ---------------------------------------------------------------- B. word-preserving
// The whole safety argument is that a mapping cannot change what the BORROWER sees. Assert it
// over every status either list can hold, not on a couple of hand-picked examples.
{
  let checked = 0, broke = 0, refused = 0;
  for (const src of LEAD_CAPTURE_STATUSES.concat(OFFICER_STATUSES)) {
    for (const destList of [OFFICER_STATUSES, LEAD_CAPTURE_STATUSES]) {
      const p = M.planStatusMapping(src, destList);
      if (!p.ok) { refused++; continue; }
      checked++;
      if (!p.mappings.length) continue;   // same name — nothing moved
      const dest = destList.find((x) => x.id === p.mappings[0].destination_status_id);
      if (S.externalFor(dest.status) !== S.externalFor(src.status)) broke++;
    }
  }
  ok(`B1 every accepted mapping preserves the borrower-facing word (${checked} checked)`, broke === 0 && checked > 100);
  ok(`B2 …and what it cannot express, it refuses rather than guesses (${refused} refused)`, refused > 0);
}

// A mapping must never land the card on a status that makes ClickUp email somebody. The two
// deliberate exceptions are the ones the portal's own status door already accepts.
{
  const emailish = (n) => /\(\s*\d+\s*-\s*em/i.test(String(n));
  const allowed = new Set(['clear_to_close', 'funded']);
  let surprises = 0;
  for (const src of LEAD_CAPTURE_STATUSES) {
    const p = M.planStatusMapping(src, OFFICER_STATUSES);
    if (!p.ok || !p.mappings.length) continue;
    const dest = OFFICER_STATUSES.find((x) => x.id === p.mappings[0].destination_status_id);
    if (emailish(dest.status) && !allowed.has(S.externalFor(dest.status))) surprises++;
  }
  eq('B3 no mapping can land on a surprise email-firing ClickUp status', surprises, 0);
}

// ---------------------------------------------------------------- C. the real gaps, both ways
{
  const lcNames = new Set(LEAD_CAPTURE_STATUSES.map((s) => s.status.trim().toLowerCase()));
  const ofNames = new Set(OFFICER_STATUSES.map((s) => s.status.trim().toLowerCase()));
  ok('C1 CONTROL: the two real lists really do differ (this is the whole hazard)',
    ['approved', 'imported to bank (2-em)', 'paid off'].every((n) => lcNames.has(n) && !ofNames.has(n))
    && ['delegated ctc submission', 'closed reconciled'].every((n) => ofNames.has(n) && !lcNames.has(n)));

  // Two statuses were MISSING from EXTERNAL_FOR entirely and fell through the keyword
  // fallback (which matches "approval", not "approved") to **processing** — so a card on
  // either read to the borrower as "Processing". Found while building this move, whose
  // mapping is only safe because the derivation is right.
  eq('C2 a bare `approved` card reads as Approved, not Processing', S.externalFor('approved'), 'approved');
  eq('C3 a `paid off` card reads as Funded, not Processing', S.externalFor('paid off'), 'funded');
  eq('C4 …and `imported to bank (2-em)` was already right', S.externalFor('imported to bank (2-em)'), 'underwriting');
}

// ---------------------------------------------------------------- D. the client fence
// v3 exists for exactly ONE call. Everything else on that surface is refused BEFORE the wire.
ok('D1 the sanctioned move is allowed',
  (() => { try { client.guardV3TaskPath('PUT', '/workspaces/9011888435/tasks/abc/home_list/123'); return true; } catch (_) { return false; } })());
for (const [m, p] of [
  ['DELETE', '/workspaces/9011888435/tasks/abc/home_list/123'],
  ['POST', '/workspaces/9011888435/tasks/abc/home_list/123'],
  ['PUT', '/workspaces/9011888435/tasks/abc'],
  ['GET', '/workspaces/9011888435/tasks/abc/comments'],
]) {
  let blocked = false;
  try { client.guardV3TaskPath(m, p); } catch (e) { blocked = e.code === 'CLICKUP_V3_FORBIDDEN'; }
  ok(`D2 ${m} ${p} is refused on v3`, blocked);
}
ok('D3 a v2 path is untouched by the v3 fence',
  (() => { try { client.guardV3TaskPath('POST', '/task/abc/field/xyz'); return true; } catch (_) { return false; } })());
// HARD STOP 1 is unchanged — a task delete is still impossible.
{
  let blocked = false;
  try { client.guardNoTaskDeletion('DELETE', '/task/abc'); } catch (e) { blocked = e.code === 'CLICKUP_DELETE_FORBIDDEN'; }
  ok('D4 deleting a task is still permanently blocked', blocked);
}

// ---------------------------------------------------------------- E. the wiring
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'clickup', 'officer-move.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

ok('E1 custom fields are explicitly carried across — ClickUp does not do it on its own',
  /move_custom_fields:\s*true/.test(code));
ok('E2 it never creates, renames or deletes anything', !/createTask|updateTask|deleteTask|setField/.test(code));
ok('E3 it counts into the ONE shared outbound volume breaker', /circuitCheck\(/.test(code));
ok('E4 the destination list is resolved the SAME way a NEW card’s list is',
  /orchestrator\.firstListId\(/.test(code));
ok('E5 the card’s current home is read LIVE, not from our cached column',
  /clickup\.getTask\(/.test(code) && /task\.folder/.test(code));
ok('E6 …and the cached column is never the thing that decides',
  !/clickup_folder_id\s*===|row\.clickup_folder_id\s*===/.test(code));

const staffSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
ok('E7 the assign door calls it', /officer-move'\)\s*\n?\s*\.maybeMoveToOfficerFolder\(/.test(staffSrc));
ok('E8 …only for a loan officer — a processor never owns the folder',
  /if \(loanOfficerId\) \{\s*\n\s*require\('\.\.\/clickup\/officer-move'\)/.test(staffSrc));
const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'sync', 'clickup-sync.js'), 'utf8');
ok('E9 the back-book sweep is on the sync worker', /officerMove\.sweepLeadCaptureOnce\(\)/.test(syncSrc));
ok('E10 …and it obeys the LIVE outbound switch, not a boot-time env read',
  /switches\.on\('CLICKUP_OUTBOUND_ENABLED'\)[\s\S]{0,120}sweepLeadCaptureOnce/.test(syncSrc));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
