#!/usr/bin/env node
'use strict';
/**
 * PRIOR TO SUBMITTAL — COMPLETED: the rules, the refusals and the wiring,
 * without a database (owner-directed 2026-09-02).
 *
 *   A. WHOSE conditions: the orders and the VOR envelope are loan setup's;
 *      everything else in the bucket is the officer's.
 *   B. WHAT "done" means for the list: signed off / waived / did not apply is
 *      done; substance without Done is "click Done on it"; Done without
 *      substance is listed with what is missing — a stamp on an empty
 *      condition is not a finished one.
 *   C. THE OFFICER STAGE of the sign-off gate: an upload counts before the
 *      back office accepts it; a rejected one never does; every other rule is
 *      the same at both stages.
 *   D. THE CLICKUP WRITE refuses, in order: no card, writer off, unreadable
 *      card, no field, no "Completed" option; skips a card already Completed;
 *      writes the option's LIVE id (never a pinned one); journals both.
 *   E. THE WIRING: the worker's retry pass, the three routes, the client
 *      methods, the panel under the one bucket.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

const submittal = require('../src/longterm/conditions-center/submittal.js');
const write = require('../src/longterm/conditions-center/write.js');
const cu = require('../src/longterm/clickup/submittal.js');
const { judge } = submittal._internals;

console.log('\nA. WHOSE CONDITIONS');
{
  ok(submittal.NOT_THE_OFFICERS.has('order') && submittal.NOT_THE_OFFICERS.has('esign'),
    'the orders and the envelope (the verification of rent) are loan setup\'s — the owner\'s list: "the VOR order, the insurance order, the title order"');
  ok(!submittal.NOT_THE_OFFICERS.has('document') && !submittal.NOT_THE_OFFICERS.has('form'),
    'a document or a form condition is the officer\'s');
  ok(submittal.BUCKET === 'prior_to_submission', 'the list is the prior-to-submission bucket, in the library\'s own key');
}

console.log('\nB. WHAT "DONE" MEANS FOR THE LIST');
{
  const cond = (over) => ({ id: 'c1', code: 'lt_purchase_contract', kind: 'document', status: 'outstanding', reviewedAt: null, ...over });
  const found = (files, over) => ({
    condition: { code: 'lt_purchase_contract', kind: 'document', is_required: true, slots: [{ key: 'contract', label: 'Executed contract', required: true }] },
    files, readFailed: false, entity: null, contacts: null, liabilities: null, card: null, ...over,
  });
  const accepted = [{ slot_label: 'Executed contract', review_status: 'accepted', is_current: true }];

  for (const status of ['satisfied', 'waived', 'not_applicable']) {
    const v = judge(cond({ status }), null);
    ok(v.done === true && v.blockers.length === 0, `"${status}" is done, without loading anything`, JSON.stringify(v));
  }
  const noDoc = judge(cond({ reviewedAt: '2026-09-02T00:00:00Z' }), found([]));
  ok(noDoc.done === false && noDoc.blockers.length === 1 && /Still waiting on: Executed contract/.test(noDoc.blockers[0]),
    'Done pressed on an EMPTY condition is not done — the missing document is named', JSON.stringify(noDoc.blockers));
  const docNoDone = judge(cond(), found(accepted));
  ok(docNoDone.done === false && docNoDone.blockers.length === 1 && docNoDone.blockers[0] === submittal.CLICK_DONE,
    'the document is there but Done was not pressed — "Click Done on it."');
  const both = judge(cond({ reviewedAt: '2026-09-02T00:00:00Z' }), found(accepted));
  ok(both.done === true && both.how === 'marked done', 'document AND Done — done');
  const unread = judge(cond(), null);
  ok(unread.done === false && /could not read/.test(unread.blockers[0]), 'a condition that could not be read is never done, and says so');
}

console.log('\nC. THE OFFICER STAGE OF THE GATE');
{
  const condition = { code: 'lt_purchase_contract', kind: 'document', is_required: true, slots: [{ key: 'contract', label: 'Executed contract', required: true }] };
  const pending = [{ slot_label: 'Executed contract', review_status: 'pending', is_current: true }];
  const rejected = [{ slot_label: 'Executed contract', review_status: 'rejected', is_current: true }];
  ok(write.signOffProblem(condition, pending, {}).ok === false, 'the back office cannot sign off on a PENDING document');
  ok(write.signOffProblem(condition, pending, { stage: 'officer' }).ok === true, 'the officer\'s part is done once it is UPLOADED — accepting it is the back office\'s');
  ok(write.signOffProblem(condition, rejected, { stage: 'officer' }).ok === false, 'a REJECTED document counts for nobody at either stage');
  ok(write.signOffProblem(condition, [], { stage: 'officer' }).ok === false, 'and nothing uploaded is nothing, at either stage');
  // The other rules are the same at both stages.
  const contactsMissing = { missing: [{ key: 'title', label: 'Title company', whyUnknown: null }], unreadable: false };
  const form = { code: 'lt_file_contacts', kind: 'form', is_required: true, slots: [] };
  ok(write.signOffProblem(form, [], { contacts: contactsMissing }).ok === false
    && write.signOffProblem(form, [], { contacts: contactsMissing, stage: 'officer' }).ok === false,
    'a missing contact blocks at both stages');
  ok(write.signOffProblem(form, [], { contacts: { missing: [], unreadable: true }, stage: 'officer' }).ok === false,
    'unreadable contacts are refused, never read as "nothing missing"');
  const reo = { code: 'lt_reo_liabilities', kind: 'document', is_required: true, slots: [] };
  const noCredit = write.signOffProblem(reo, [], { liabilities: { count: 0, unreadable: false }, stage: 'officer' });
  ok(noCredit.ok === false && /reissue the credit in Encompass/i.test(noCredit.why),
    'the mortgages condition is not done until the credit has come across — "reissue the credit in Encompass"');
  const arrived = write.signOffProblem(reo, [], { liabilities: { count: 3, unreadable: false }, stage: 'officer' });
  ok(arrived.ok === false && /nobody has marked which of them are mortgages/.test(arrived.why),
    'liabilities that arrived but nobody has looked at are not "filled" — the classification array is absent');
  const lookedNone = write.signOffProblem({ ...reo, answer: { mortgages: [] } }, [], { liabilities: { count: 3, unreadable: false }, stage: 'officer' });
  ok(lookedNone.ok === true, 'a person who looked and ticked none (an EMPTY array) has answered it');
  const card = { code: 'lt_appraisal_card', kind: 'form', is_required: true, slots: [] };
  ok(write.signOffProblem(card, [], { card: { available: false }, stage: 'officer' }).ok === false, 'no card on the profile blocks the appraisal-card condition');
  ok(write.signOffProblem(card, [], { card: { available: true, expired: true, brand: 'Visa', last4: '4242', exp: '01/25' }, stage: 'officer' }).ok === false, 'an expired card blocks it too');
  ok(write.signOffProblem(card, [], { card: { available: true, expired: false }, stage: 'officer' }).ok === true, 'a current card clears it');
}

console.log('\nD. THE CLICKUP WRITE');
{
  const FIELD = cu.FIELD;
  ok(FIELD.id === 'bfbe7258-c59f-4b52-b0e4-4992ffcd9e11' && FIELD.name === 'Prior to submittal conditions' && FIELD.option === 'Completed',
    'the field is the one read off the live workspace, and the value is "Completed"');
  const option = { id: 'opt-live-uuid', name: 'Completed', orderindex: 0 };
  const card = (value, opts = [option]) => ({ id: 't1', custom_fields: [{ id: FIELD.id, name: FIELD.name, type: 'drop_down', type_config: { options: opts }, value }] });
  const journal = [];
  const deps = (task, setField) => ({
    getTask: async () => task,
    setField: setField || (async () => { throw new Error('setField must not be called'); }),
    journal: async (row) => { journal.push(row); },
  });
  const saved = { on: process.env.LT_CLICKUP_WRITE_ENABLED, dry: process.env.LT_CLICKUP_WRITE_DRYRUN };
  (async () => {
    try {
      delete process.env.LT_CLICKUP_WRITE_ENABLED; delete process.env.LT_CLICKUP_WRITE_DRYRUN;
      let r = await cu.pushCompleted({ taskId: '', deps: deps(card(null)) });
      ok(r.ok === false && /no ClickUp card/.test(r.reason), 'no card: refused, in words');
      r = await cu.pushCompleted({ taskId: 't1', deps: deps(card(null)) });
      ok(r.ok === false && /switched off/.test(r.reason), 'writer off: refused, and says the completion is recorded here');

      process.env.LT_CLICKUP_WRITE_ENABLED = '1';
      r = await cu.pushCompleted({ taskId: 't1', deps: { getTask: async () => { throw new Error('502'); } } });
      ok(r.ok === false && /could not read the card first/.test(r.reason), 'an unreadable card is refused before any write');
      r = await cu.pushCompleted({ taskId: 't1', deps: deps({ id: 't1', custom_fields: [] }) });
      ok(r.ok === false && /has no "Prior to submittal conditions" field/.test(r.reason), 'a card without the field: refused, naming the field to add');
      r = await cu.pushCompleted({ taskId: 't1', deps: deps(card(null, [{ id: 'x', name: 'Something else', orderindex: 0 }])) });
      ok(r.ok === false && /no "Completed" option/.test(r.reason), 'a dropdown without a Completed option: refused — PILOT never invents one');

      journal.length = 0;
      r = await cu.pushCompleted({ taskId: 't1', ltLoanId: 'L', deps: deps(card(0)) });
      ok(r.ok === true && r.wrote === false && r.skipped === 'already_completed', 'a card already Completed (read as orderindex 0) is not written again');
      ok(journal.length === 1 && journal[0].changed === false && journal[0].blocked === false && journal[0].source === 'submittal', '…and the no-op is journaled');
      r = await cu.pushCompleted({ taskId: 't1', deps: deps(card('opt-live-uuid')) });
      ok(r.ok === true && r.skipped === 'already_completed', 'a card already Completed (read as the option id) is not written again either');

      const writes = [];
      journal.length = 0;
      r = await cu.pushCompleted({ taskId: 't1', ltLoanId: 'L', deps: deps(card(null), async (taskId, fieldId, value) => { writes.push({ taskId, fieldId, value }); }) });
      ok(r.ok === true && r.wrote === true, 'a blank field is written');
      ok(writes.length === 1 && writes[0].fieldId === FIELD.id && writes[0].value === 'opt-live-uuid',
        'THE ONE THAT MATTERS: exactly one write, to the pinned field, with the option\'s LIVE id off the card — never a pinned option id', JSON.stringify(writes));
      ok(journal.length === 1 && journal[0].changed === true && journal[0].newValue === 'Completed' && journal[0].fieldKey === 'prior_to_submittal', '…and it is journaled as a change');

      journal.length = 0;
      r = await cu.pushCompleted({ taskId: 't1', ltLoanId: 'L', deps: deps(card(null), async () => { const e = new Error('HTTP 429'); e.retryable = true; throw e; }) });
      ok(r.ok === false && r.retryable === true && journal.length === 1 && journal[0].blocked === true, 'a write ClickUp refused is reported retryable and journaled as blocked');

      process.env.LT_CLICKUP_WRITE_DRYRUN = '1';
      const noWrite = deps(card(null));
      r = await cu.pushCompleted({ taskId: 't1', deps: noWrite });
      ok(r.ok === true && r.dryRun === true && r.wrote === false, 'a dry run builds the plan and sends nothing');

      // The source never carries an option id: it is resolved live, by label.
      const src = strip(read('src/longterm/clickup/submittal.js'));
      ok(!/6fa587f4/.test(src), 'the option id seen on the day is not in the code — option ids churn');
      ok(/writer\.setField/.test(src) && /circuitCheck\(\)/.test(src) && /countWrite\(\)/.test(src),
        'the write goes through the guarded writer, the circuit breaker and the write counter');
      ok(/push\.writeEnabled\(\)/.test(src) && /push\.dryRun\(\)/.test(src), 'behind the writer\'s own two switches');
      ok(!/\.value\s*=\s*null|setField\([^)]*null/.test(src), 'nothing here can clear the field');
    } finally {
      if (saved.on === undefined) delete process.env.LT_CLICKUP_WRITE_ENABLED; else process.env.LT_CLICKUP_WRITE_ENABLED = saved.on;
      if (saved.dry === undefined) delete process.env.LT_CLICKUP_WRITE_DRYRUN; else process.env.LT_CLICKUP_WRITE_DRYRUN = saved.dry;
    }

    console.log('\nE. THE WIRING');
    {
      const worker = strip(read('src/longterm/sync/worker.js'));
      ok(/require\('\.\.\/clickup\/submittal'\)/.test(worker) && /runLog\.record\('submittal_clickup',\s*trigger,\s*\(\)\s*=>\s*clickupSubmittal\.pushPass\(\{\}\)\)/.test(worker),
        'the worker retries the owed completions on every tick, under its own run-log name');
      ok(worker.indexOf("runLog.record('clickup_link'") < worker.indexOf("runLog.record('submittal_clickup'"),
        '…AFTER the link pass, so a card linked this tick is told this tick');
      const routes = strip(read('src/longterm/routes/condition-center.js'));
      ok(/router\.get\('\/loans\/:loanId\/submittal'/.test(routes) && /submittal\.readiness\(scoped\.loan\.id/.test(routes), 'GET …/submittal reads the list');
      ok(/router\.post\('\/loans\/:loanId\/submittal\/complete'/.test(routes) && /submittal\.complete\(scoped\.loan\.id,\s*staffId\(req\)/.test(routes), 'POST …/submittal/complete is the button, with who pressed it');
      ok(/router\.post\('\/loans\/:loanId\/submittal\/push-clickup'/.test(routes) && /clickupSubmittal\.pushForLoan\(scoped\.loan\.id/.test(routes), 'POST …/submittal/push-clickup is the by-hand retry');
      ok(/status \|\| 400\)\.json\(\{ error: out\.error, outstanding: out\.outstanding \|\| \[\] \}\)/.test(routes), 'a refusal carries the outstanding list, not only a sentence');
      const api = strip(read('app-v2/src/longterm/api.js'));
      ok(/submittalReadiness:/.test(api) && /submittalComplete:/.test(api) && /submittalPushClickup:/.test(api), 'the client has the three methods');
      const screen = strip(read('app-v2/src/longterm/LtFileConditions.jsx'));
      ok(/import LtSubmittalPanel from '\.\/LtSubmittalPanel\.jsx'/.test(screen) && /b\.key === 'prior_to_submission' && \(\s*<LtSubmittalPanel/.test(screen),
        'the panel is drawn under the prior-to-submission bucket and no other');
      const panel = strip(read('app-v2/src/longterm/LtSubmittalPanel.jsx'));
      ok(/disabled=\{busy \|\| !data\.ready\}/.test(panel), 'the button is disabled until the server says ready');
      ok(/ltApi\.submittalComplete\(loanId\)/.test(panel) && /ltApi\.submittalReadiness\(loanId\)/.test(panel), 'and the panel reads and completes through the client, never deciding anything itself');
      ok(/Not on this list, by design/.test(read('app-v2/src/longterm/LtSubmittalPanel.jsx')), 'the orders are named as loan setup\'s, so nobody hunts for them here');
    }

    console.log('\nE. WHAT THE A-TO-Z WALK FOUND (2026-09-02) — the source half');
    {
      const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const screen = strip(fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtFileConditions.jsx'), 'utf8'));
      ok(/cond\.slots\.length === 1/.test(screen) && /\.\.\.\(slot \? \{ slot \} : \{\}\)/.test(screen),
        'the screen names the slot on an upload to a single-slot condition — an unnamed upload never filled its slot');
      const eng = strip(fs.readFileSync(path.join(__dirname, '..', 'src/longterm/conditions-center/engine.js'), 'utf8'));
      ok(/const cx = lockClient \|\| client;/.test(eng) && !/loadContext\(loanId, client\)/.test(eng),
        'the rules pass runs every statement on the lock\'s own connection, never two per pass');
      const w = strip(fs.readFileSync(path.join(__dirname, '..', 'src/longterm/conditions-center/write.js'), 'utf8'));
      ok(w.indexOf('if (opts.readFailed)') > w.indexOf('if (opts.contacts)') && w.indexOf('if (opts.readFailed)') > w.indexOf('if (opts.card)'),
        'a documents-read failure is answered AFTER the contacts, credit and card gates, so it can never sign those off');
      const entity = strip(fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtEntity.jsx'), 'utf8'));
      ok(/href=\{`#\/internal\/borrowers\//.test(entity), 'the profile link stays inside the portal (a HashRouter route), never a bare /internal path');
    }

    console.log(`\n${pass} passed, ${fails.length} failed`);
    if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
  })().catch((e) => { console.error('UNEXPECTED', e); process.exit(1); });
}
