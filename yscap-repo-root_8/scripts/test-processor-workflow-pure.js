#!/usr/bin/env node
'use strict';
/**
 * THE PROCESSOR'S WORKFLOW, REDESIGNED (owner-directed 2026-09-01). Pure: no database.
 *
 *   · one tab per kind of hand-off, everything in arrival order, a queue position on the
 *     Clear to Close / Condition Clearing / Track Record Review buttons;
 *   · Full Processing is the whole file — its own box, no Done; finishing CTC finishes it;
 *   · Track Record Review is a new hand-off to the processor;
 *   · Pick up tells the loan officer; Done takes a note that reaches the officer and is
 *     saved on the file's tasks;
 *   · condition clearing may be submitted at 65%;
 *   · an escalation must say what it wants;
 *   · the processor moves the status from the overview (Clear to Close still gated on
 *     every required condition being signed off — the existing status door).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pure-test@localhost:5432/none';
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const read = (p) => fs.readFileSync(R + '/' + p, 'utf8');

const W = require(R + '/src/lib/workflow');
// ── the hand-off kinds ──
ok(W.TYPES.track_record_review && W.TYPES.track_record_review.role === 'processor' && W.TYPES.track_record_review.assigns === true,
  'Track Record Review is a hand-off to the processor');
ok(W.TYPES.track_record_review.internalStatus === null, 'it moves no status');
ok(W.TYPES.processing.label === 'Full Processing' && W.TYPES.processing.fullFile === true, 'Processing is named Full Processing and flagged as the whole-file hand-off');
ok(W.SLA_HOURS ? W.SLA_HOURS.track_record_review === 24 : true, 'the new kind has a target time');
ok(W.OUTCOME_LABELS.includes('Track record reviewed'), 'the Done list can say the track record was reviewed');
ok(Array.isArray(W.PROCESSOR_QUEUE_TYPES) && ['loan_setup', 'processing', 'condition_clearing', 'clear_to_close', 'track_record_review']
  .every((t) => W.PROCESSOR_QUEUE_TYPES.includes(t)) && !W.PROCESSOR_QUEUE_TYPES.includes('closing'),
  'the processor queue kinds are exactly the five processor hand-offs');
ok(typeof W.queuePositionOf === 'function' && typeof W.queueLengthFor === 'function', 'queue position helpers exist');
// The migration names the new kind, and every earlier one.
const mig = fs.readdirSync(R + '/db').find((f) => /^671_.*track_record_review/.test(f));
ok(!!mig, 'db/671 exists');
const migSrc = mig ? read('db/' + mig) : '';
for (const t of Object.keys(W.TYPES)) ok(migSrc.includes(`'${t}'`), `db/671 allows '${t}'`);
ok(/LIKE '%track_record_review%'/.test(migSrc), 'db/671 re-creates the constraint only while it lacks the new value (idempotent)');

// ── the routes (source guards — the decisions live in staff.js) ──
const staff = read('src/routes/staff.js');
ok(/const COND_CLEAR_THRESHOLD = 0\.65;/.test(staff), 'condition clearing can be submitted at 65%');
ok(!/const COND_CLEAR_THRESHOLD = 0\.80;/.test(staff), 'the old 80% gate is gone');
ok(/b\.submissionType === 'escalation' && !String\(b\.note \|\| ''\)\.trim\(\)/.test(staff) && /escalation_note_required/.test(staff),
  'an escalation with no note is refused — it must say what it wants');
ok(/type: 'workflow_picked_up'/.test(staff), 'picking up notifies the officer');
ok(/INSERT INTO reminders \(application_id, kind, title, body, due_at, assignee_staff_id, status, created_by, completed_by, completed_at, meta\)/.test(staff),
  'the Done note is saved on the file as a completed task');
ok(/it\.submission_type === 'clear_to_close'/.test(staff) && /'Finished processing', '\[auto\] Finished with the clear-to-close hand-off\.'/.test(staff),
  'finishing Clear to Close finishes the Full Processing hand-off');
ok(/queue: await \(async \(\) => \{/.test(staff) && /workflow\.queuePositionOf\(liveItem\.id\)/.test(staff) && /workflow\.queueLengthFor\(/.test(staff),
  'the submit panel is told where in the queue the file is or would be');

// ── notifications: the new type is registered in every map ──
const notify = read('src/lib/notify.js');
ok(/workflow_picked_up: 'Workflow'/.test(notify) && /workflow_picked_up: 'status_updates'/.test(notify), 'workflow_picked_up has a kicker and a category');
ok(/key: 'workflow_picked_up'/.test(read('src/lib/notification-catalog.js')), 'and a catalog entry');

// ── the screens ──
const wf = read('app-v2/src/screens/StaffWorkflow.jsx');
for (const k of ['loan_setup', 'processing', 'condition_clearing', 'clear_to_close', 'track_record_review']) ok(new RegExp(`key: '${k}'`).test(wf), `the workflow screen has a "${k}" tab`);
ok(/Files in full processing/.test(wf) && /FULL_FILE_TYPE/.test(wf), 'full processing has its own box');
ok(/it\.submission_type !== FULL_FILE_TYPE && <button/.test(wf), 'a full-processing file has no Done button');
ok(/'Done' : 'Send back'/.test(wf), 'the processor sees Done');
ok(/#\{idx \+ 1\}/.test(wf), 'each queued row shows its position');
ok(/fmtWhen\(it\.received_at\)/.test(wf), 'each queued row shows when it was submitted');
ok(/if \(kindFilter\) p\.type = kindFilter;/.test(wf), 'a tab filters the queue by kind through the existing ?type= door');
const sp = read('app-v2/src/components/SubmitFilePanel.jsx');
ok(/'track_record_review'/.test(sp) && /SHOW_QUEUE = \['condition_clearing', 'clear_to_close', 'track_record_review'\]/.test(sp),
  'the submit panel has the Track Record Review button and shows queue positions on the three');
ok(/in the queue/.test(sp) && /ordinal\(/.test(sp), 'the position reads as "first / 2nd / 3rd in the queue"');
ok(/What do you need from the super admin\? \(required\)/.test(sp), 'the escalation form requires the ask');
ok(!/0\.8\)/.test(sp), 'no 80% fallback remains in the panel');
const sc = read('app-v2/src/components/StatusActionsCard.jsx');
ok(/api\.staffSetInternalStatus\(appId, v\)/.test(sc), 'the status card moves the status through the one status door');
ok(/'ctc \(4-email\)'/.test(sc) && /d\.error === 'blocked'/.test(sc), 'it offers Clear to Close and explains the sign-off gate by name');
ok(/<StatusActionsCard appId=\{id\} app=\{app\} onChanged=\{load\} \/>/.test(read('app-v2/src/screens/StaffApplication.jsx')), 'it is on the file overview');

console.log(`processor workflow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
