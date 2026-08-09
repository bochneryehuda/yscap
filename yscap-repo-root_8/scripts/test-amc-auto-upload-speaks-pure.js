'use strict';
/**
 * A REFUSAL ON THE UNATTENDED PATH IS STILL A REFUSAL (sixth audit finding, 2026-08-09).
 *
 * `autoUploadForOrder` is the poller doing by itself what a staffer does by hand: push
 * the scope of work and the contract to the order. When a person presses Send, the desk
 * now names what the appraisal company would not take and why. The poller's caller
 * DISCARDED the return value — so the same refusal, on the path where nobody is
 * watching, produced a successful-looking tick, no row, and not one word anywhere.
 *
 * PURE: `documents.autoUploadForOrder` is stubbed in the require cache and the console
 * is captured, so nothing here reaches a network or a database.
 */
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL: ' + m); } };

// Stub the document module BEFORE sync.js lazily requires it.
const docsPath = require.resolve(path.join(__dirname, '..', 'src/amc/documents'));
let nextResult = null;
require.cache[docsPath] = {
  id: docsPath, filename: docsPath, loaded: true,
  exports: { autoUploadForOrder: async () => nextResult },
};

const sync = require('../src/amc/sync');
const autoUploadStep = sync._internals && sync._internals.autoUploadStep;

// Capture what the poller says out loud.
const said = [];
const realWarn = console.warn, realErr = console.error;
const capture = (...a) => said.push(a.map(String).join(' '));

async function run(result) {
  nextResult = result;
  said.length = 0;
  console.warn = capture; console.error = capture;
  try { await autoUploadStep({ query: async () => ({ rows: [] }) }, { id: 7, application_id: 'app' }); }
  finally { console.warn = realWarn; console.error = realErr; }
  return said.join('\n');
}

(async () => {
  ok(typeof autoUploadStep === 'function',
     'the poller\'s auto-upload step is reachable for testing (it is what discards the result)');

  // The reported case: the scope of work refused, the contract sent.
  let out = await run({ ok: true, uploaded: 1, skipped: [
    { documentId: 'd-sow', filename: 'Scope of Work.pdf', reason: 'stage_rejected', detail: 'Rejected: file type not allowed' }] });
  ok(/Scope of Work\.pdf/.test(out), 'a refused document is named');
  ok(/file type not allowed/.test(out), 'with the appraisal company’s own reason');
  ok(/order 7/.test(out), 'and the order it was on');

  // Everything accepted: silence, so the log stays readable.
  out = await run({ ok: true, uploaded: 2, skipped: [] });
  ok(out === '', 'a clean run says nothing');

  // "Already sent" is not a refusal — it is the dedupe working.
  out = await run({ ok: true, uploaded: 0, skipped: [{ documentId: 'd1', reason: 'already_uploaded' }] });
  ok(out === '', 'and neither is a document we had already sent');

  // Nothing to do is not a refusal either.
  out = await run({ ok: false, error: 'nothing_to_upload', skipped: [] });
  ok(out === '', 'nor is having nothing to send');

  // WHOSE FAULT IT WAS DECIDES WHO HAS TO ACT. Our own storage failing is not the
  // appraisal company refusing, and on this path the log line is the only signal.
  out = await run({ ok: true, uploaded: 0, skipped: [
    { documentId: 'd1', filename: 'contract.pdf', reason: 'read_failed', detail: 'the stored copy could not be read' }] });
  ok(/could not send/.test(out) && !/would not accept/.test(out),
     'a storage failure is not reported as the appraisal company refusing');
  ok(/contract\.pdf/.test(out) && /could not be read/.test(out), 'and it still names the file and the reason');

  out = await run({ ok: true, uploaded: 1, skipped: [
    { documentId: 'd1', filename: 'a.pdf', reason: 'stage_rejected', detail: 'virus scan' },
    { documentId: 'd2', filename: 'b.pdf', reason: 'empty', detail: 'the stored copy is empty' }] });
  ok(/would not accept/.test(out) && /could not send/.test(out),
     'a mixed batch reports each side to the right party');

  // A whole-batch refusal is reported with its sentence.
  out = await run({ ok: false, error: 'stage_rejected', message: 'The appraisal company would not accept that document: sow.pdf — virus scan', skipped: [] });
  ok(/would not accept/.test(out), 'a whole-batch refusal is reported, with its own words');

  // A thrown error is still caught — the poller must never be taken down by this.
  nextResult = null;
  require.cache[docsPath].exports.autoUploadForOrder = async () => { throw new Error('boom'); };
  said.length = 0;
  console.warn = capture; console.error = capture;
  let threw = null;
  try { await autoUploadStep({ query: async () => ({ rows: [] }) }, { id: 7, application_id: 'app' }); }
  catch (e) { threw = e; } finally { console.warn = realWarn; console.error = realErr; }
  ok(!threw, 'a failure here never breaks the poll');
  ok(/boom/.test(said.join('\n')), 'and it is still said out loud');

  console.log(`\n[test-amc-auto-upload-speaks-pure] ${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, 'the unattended upload path swallowed a refusal');
})();
