#!/usr/bin/env node
/* The condition action ladder — app-v2/src/lib/condition-actions.js.
 *
 * Pure: no DB, no browser, no server. What it locks down is the thing a wrong
 * answer costs most — WHICH button a person is shown as their next step. Get
 * that wrong and somebody signs off a condition whose document nobody has read,
 * or a loan officer is offered a sign-off they cannot perform.
 *
 * Run: node scripts/test-condition-actions-pure.js
 */
const assert = require('assert');
const { pathToFileURL } = require('url');
const path = require('path');

const MOD = pathToFileURL(path.join(__dirname, '..', 'app-v2', 'src', 'lib', 'condition-actions.js')).href;

let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; };

(async () => {
  const { canComplete, pendingDocs, nextStep, docNextStep } = await import(MOD);

  // ---- who may complete -------------------------------------------------
  for (const r of ['processor', 'admin', 'super_admin', 'underwriter', 'loan_coordinator']) {
    ok(canComplete(r), `${r} may complete`);
  }
  for (const r of ['loan_officer', 'closer', 'draw_coordinator', '', null, undefined]) {
    ok(!canComplete(r), `${r} may NOT complete`);
  }

  // ---- pending documents ------------------------------------------------
  eq(pendingDocs([]).length, 0, 'no documents -> nothing pending');
  eq(pendingDocs(null).length, 0, 'null documents is safe');
  eq(pendingDocs([{ review_status: 'accepted' }]).length, 0, 'accepted is not pending');
  eq(pendingDocs([{ review_status: 'rejected' }]).length, 0, 'rejected is not pending');
  eq(pendingDocs([{ review_status: 'pending' }]).length, 1, 'pending is pending');
  eq(pendingDocs([{}]).length, 1, 'an ABSENT review_status reads as pending (the rows read it that way)');

  // ---- a completer's ladder --------------------------------------------
  const open = { id: 'a', status: 'outstanding' };
  const P = { role: 'processor', docs: [] };

  eq(nextStep(open, P).key, 'signoff', 'a completer on an open condition signs off');
  eq(nextStep(open, P).tone, 'primary', 'and it is the primary action');
  eq(nextStep(open, P).patch.signedOff, true, 'the patch actually signs off');
  ok(!/accept/i.test(nextStep(open, P).hint), 'with no documents the hint says nothing about accepting');

  // THE CASE THE OWNER REPORTED: a document is uploaded and now three buttons
  // all sound final. The next step is still sign-off, but the hint must say
  // the document comes first.
  const withPending = { role: 'processor', docs: [{ review_status: 'pending' }] };
  eq(nextStep(open, withPending).key, 'signoff', 'still sign-off with a document waiting');
  ok(/accept the document above first/i.test(nextStep(open, withPending).hint),
    'the hint names accepting the document as the step before sign-off');
  ok(/2 documents/.test(nextStep(open, { role: 'processor', docs: [{}, {}] }).hint),
    'two waiting documents are counted, and pluralised');
  ok(!/accept/i.test(nextStep(open, { role: 'processor', docs: [{ review_status: 'accepted' }] }).hint),
    'an already-accepted document does not ask to be accepted again');

  // ---- cleared conditions ----------------------------------------------
  const signedOff = { id: 'b', status: 'satisfied', signed_off_at: '2026-07-01' };
  eq(nextStep(signedOff, P).key, 'undo_signoff', 'a signed-off condition offers the undo');
  eq(nextStep(signedOff, P).tone, 'ghost', 'an undo is never the prominent button');
  eq(nextStep(signedOff, P).patch.signedOff, false, 'and it un-signs');

  const waivedItem = { id: 'c', status: 'satisfied', waived_at: '2026-07-01', signed_off_at: '2026-07-01' };
  eq(nextStep(waivedItem, P).key, 'undo_waive',
    'a WAIVED condition offers undo-waive, not undo-sign-off — a waive sets both stamps, so order matters');
  eq(nextStep(waivedItem, P).patch.waived, false, 'and it un-waives');

  // ---- the loan officer's ladder ---------------------------------------
  const LO = { role: 'loan_officer', docs: [] };
  eq(nextStep(open, LO).key, 'done', 'a loan officer marks done');
  eq(nextStep(open, LO).patch.reviewed, true, 'the patch records the review');
  ok(!/sign off/i.test(nextStep(open, LO).label),
    'a loan officer is NEVER offered sign-off as their next step — they cannot perform it');
  eq(nextStep({ ...open, reviewed_at: 'x' }, LO).key, 'undo_done', 'once done, the undo');

  // A loan officer on a SIGNED-OFF condition must not be handed an undo they
  // have no authority for — the undo branches are gated on completer.
  for (const item of [signedOff, waivedItem]) {
    const s = nextStep(item, LO);
    ok(s.key !== 'undo_signoff' && s.key !== 'undo_waive',
      'a loan officer is never offered an undo they cannot perform');
    ok(/already cleared/i.test(s.hint),
      'and is told the condition is already finished rather than promised a sign-off still to come');
  }
  ok(/back office signs off after you/i.test(nextStep(open, LO).hint),
    'on an OPEN condition the loan officer is told who clears it after them');

  // ---- a staff role that is neither ------------------------------------
  const CLOSER = { role: 'closer', docs: [] };
  eq(nextStep(open, CLOSER).key, 'done', 'another staff role can still mark done');
  ok(/someone with sign-off clears it after you/i.test(nextStep(open, CLOSER).hint),
    'and is told who clears it after them, without naming a back office they are not part of');
  ok(!/sign off/i.test(nextStep(open, CLOSER).label), 'but is never offered sign-off');

  // ---- the document row's step -----------------------------------------
  eq(docNextStep({ review_status: 'pending' }, { role: 'processor' }).key, 'accept',
    'a completer accepts a pending document');
  eq(docNextStep({}, { role: 'processor' }).key, 'accept',
    'an absent review_status is pending here too');
  eq(docNextStep({ review_status: 'accepted' }, { role: 'processor' }), null,
    'an accepted document has no forward step');
  eq(docNextStep({ review_status: 'rejected' }, { role: 'processor' }).key, 'accept',
    'a rejected document can still be accepted after all');
  eq(docNextStep({ review_status: 'pending' }, { role: 'loan_officer' }), null,
    'a loan officer is not offered Accept — only a completer may accept');
  eq(docNextStep(null, { role: 'processor' }).key, 'accept', 'a missing document is safe');

  // ---- every step is renderable ----------------------------------------
  for (const role of ['processor', 'loan_officer', 'closer', 'super_admin']) {
    for (const item of [open, signedOff, waivedItem, { ...open, reviewed_at: 'x' }]) {
      const s = nextStep(item, { role, docs: [] });
      ok(s && s.key && s.label && s.hint && s.title, `${role} on ${item.id} gets a complete step`);
      ok(s.tone === 'primary' || s.tone === 'ghost', `${role} on ${item.id} has a known tone`);
      ok(s.patch && typeof s.patch === 'object', `${role} on ${item.id} has a patch to send`);
    }
  }

  console.log(`condition-actions: ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
