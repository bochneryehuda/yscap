'use strict';
/**
 * Pure test for WHICH UPLOAD ACTION goes on the wire when documents are sent up to
 * an AppraisalScope order. No DB, no network.
 *
 * TWO THINGS AT ONCE, and they are the same lesson.
 *
 * (1) THE ACTION WAS UNVALIDATED. `uploadToOrder` took `action` straight off the
 *     request body and handed it to `buildUploadDocuments`, which puts it on the
 *     wire as `requestActionType`. So a typo — or a name somebody invented because
 *     it read plausibly — became a request the gateway has never heard of. That is
 *     exactly the class the invented `CancelOrder` belonged to: it looks like it
 *     works and answers a NACK the first time anybody presses it in anger.
 *
 * (2) `UploadContract` HAD NO CALLER, and only because nothing offered it. It is
 *     one of the three uploads the vendor documents, and sending the purchase
 *     contract as the CONTRACT rather than as a generic supporting document is what
 *     puts it in the slot the appraiser looks in.
 */
// documents.js reaches db.js at load (see the note in test-amc-cancel-pure.js); a
// placeholder silences the production-only "DATABASE_URL is not set" alarm. No pool
// is ever asked for a connection — every assertion below is on a pure function.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pure-test/never-connected';

const docs = require('../src/amc/documents');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- the default follows the COUNT, exactly as it always has ---------------
eq(docs.uploadAction(null, 1), 'UploadDocument', 'one document, unnamed → UploadDocument');
eq(docs.uploadAction(null, 2), 'UploadDocumentMulti', 'several documents, unnamed → UploadDocumentMulti');
eq(docs.uploadAction(undefined, 3), 'UploadDocumentMulti', 'an absent action behaves the same as a null one');
eq(docs.uploadAction('', 1), 'UploadDocument', 'an empty action is not a choice — it is the default');

// ---- a named action is honoured, in the VENDOR'S casing --------------------
eq(docs.uploadAction('UploadContract', 1), 'UploadContract', 'the contract upload is reachable');
eq(docs.uploadAction('UploadContract', 4), 'UploadContract', 'and a named action beats the count');
eq(docs.uploadAction('uploadcontract', 1), 'UploadContract', 'a caller’s casing is corrected to theirs, never sent as typed');
eq(docs.uploadAction('  UploadDocumentMulti  ', 1), 'UploadDocumentMulti', 'padding is not part of an action name');

// ---- anything else is REFUSED, never forwarded -----------------------------
// Null is the refusal; `uploadToOrder` turns it into a plain message naming the
// three. The point is that nothing unrecognised can reach the gateway.
for (const bad of ['UploadContracts', 'Upload_Contract', 'CancelOrder', 'DROP TABLE', 'UploadDocumen', '  ', 0, {}, []]) {
  eq(docs.uploadAction(bad, 1), null, `"${String(bad)}" is refused rather than put on the wire`);
}

// ---- the list is the vendor's three, and only theirs ------------------------
eq(docs.UPLOAD_ACTIONS.join(','), 'UploadDocument,UploadDocumentMulti,UploadContract',
  'the three uploads the vendor documents — adding a fourth means finding it in their package first');

// ---- the refusal happens BEFORE anything is read or staged ------------------
// A rejected action must cost nothing: no storage read, no /postdocuments call, no
// journal row about a request that was never going to be sent.
(async () => {
  let touched = false;
  const out = await docs.uploadToOrder(
    { query: async () => { touched = true; return { rows: [] }; } },
    { id: 1, application_id: 'app-1' },
    { documentIds: ['00000000-0000-0000-0000-000000000001'], action: 'UploadContracts' },
    {
      authContext: { apiKey: 'K', subdomain: 's' },
      readStorage: async () => { throw new Error('must not read storage'); },
      postDocuments: async () => { throw new Error('must not stage'); },
      transport: { write: async () => { throw new Error('must not send'); } },
    });
  ok(!out.ok && out.error === 'unknown_action', 'an unrecognised action is refused');
  ok(/UploadDocument, UploadDocumentMulti, UploadContract/.test(out.message || ''),
    'and the refusal NAMES what is allowed, so it is actionable rather than a dead end');
  ok(touched === false, 'nothing is even read from the database for an action that can never be sent');

  console.log(`\n[test-amc-upload-action-pure] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
