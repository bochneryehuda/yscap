/**
 * Unit tests for the DocuSign core library's PURE logic — no network, no DB.
 * Run: node scripts/test-docusign-lib.js
 *
 * Covers the send-once / correlation / webhook primitives that must never
 * regress: deterministic idempotency keys, the anchor-tab envelope builder
 * (per-recipient + documentId-scoped tabs, ignore-if-not-present), argument
 * validation, and fail-closed multi-key base64 Connect HMAC verification.
 */
process.env.DOCUSIGN_CONNECT_HMAC_SECRET = 'testkey1,testkey2';   // multi-key rotation
// Dummy creds so configured() passes (lets the returnUrl-pin path run without a
// real account); a fixed APP_URL so the origin allow-list is deterministic.
process.env.DOCUSIGN_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY || 'test-ik';
process.env.DOCUSIGN_USER_ID = process.env.DOCUSIGN_USER_ID || 'test-user';
process.env.DOCUSIGN_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID || 'test-acct';
process.env.DOCUSIGN_PRIVATE_KEY = process.env.DOCUSIGN_PRIVATE_KEY || 'test-key';
process.env.APP_URL = process.env.APP_URL || 'https://www.yscapgroup.com';
const crypto = require('crypto');
const d = require('../src/lib/integrations/docusign');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// 1. idempotency key — deterministic, version-sensitive, sha256 hex
const k1 = d.idempotencyKey('app-1', 'term_sheet_package', 3);
const k2 = d.idempotencyKey('app-1', 'term_sheet_package', 3);
const k3 = d.idempotencyKey('app-1', 'term_sheet_package', 4);
ok(k1 === k2, 'idempotency key deterministic');
ok(k1 !== k3, 'idempotency key changes with product version');
ok(/^[0-9a-f]{64}$/.test(k1), 'idempotency key is sha256 hex');

// 2. buildEnvelopeDefinition — per-recipient, documentId-scoped anchor tabs
const def = d.buildEnvelopeDefinition({
  subject: 'Sign', brandId: 'brand-x',
  documents: [{ base64: 'AAAA', name: 'App', documentId: 1 }, { base64: 'BBBB', name: 'TS', documentId: 2 }],
  signers: [
    { recipientId: 1, name: 'Borrower One', email: 'b1@example.com', routingOrder: 1,
      tabsByDoc: { 1: { sign: ['/app_b1_sig/'], date: ['/app_b1_date/'] }, 2: { sign: ['/ts_b1_sig/'] } } },
    { recipientId: 2, name: 'Co Borrower', email: 'b2@example.com', routingOrder: 1,
      tabsByDoc: { 1: { sign: ['/app_b2_sig/'] } } },
  ],
  customFields: { textCustomFields: [{ name: 'applicationId', value: 'app-1', show: 'false' }] },
  eventNotification: d.eventNotification('https://www.yscapgroup.com/api/webhooks/docusign'),
});
ok(def.status === 'sent', 'status sent');
ok(def.brandId === 'brand-x', 'brandId set');
ok(def.documents.length === 2 && def.documents[0].documentId === '1', 'documents mapped w/ string ids');
const s1 = def.recipients.signers[0];
ok(s1.tabs.signHereTabs.length === 2, 'signer1 has 2 sign tabs (doc1+doc2)');
ok(s1.tabs.signHereTabs.every((t) => t.anchorIgnoreIfNotPresent === 'true'), 'anchors ignore-if-not-present');
ok(s1.tabs.signHereTabs.find((t) => t.anchorString === '/ts_b1_sig/').documentId === '2', 'sign tab is documentId-scoped');
ok(s1.tabs.dateSignedTabs.length === 1, 'signer1 has 1 date tab');
const s2 = def.recipients.signers[1];
ok(s2.tabs.signHereTabs.length === 1 && s2.tabs.signHereTabs[0].anchorString === '/app_b2_sig/', 'co-borrower anchor scoped to that recipient only');
ok(def.customFields.textCustomFields[0].value === 'app-1', 'custom field correlation carried');
ok(def.eventNotification.requireAcknowledgment === 'true', 'eventNotification requires ack (no silent loss)');
ok(def.eventNotification.includeCertificateOfCompletion === 'true', 'CoC included in webhook');

// 3. arg validation
let threw = false;
try { d.buildEnvelopeDefinition({ documents: [{ base64: 'x' }], signers: [{ recipientId: 1, name: 'X', email: 'bad-email' }] }); } catch (e) { threw = /invalid signer email/.test(e.message); }
ok(threw, 'invalid email rejected');
threw = false;
try { d.buildEnvelopeDefinition({ documents: [], signers: [{ recipientId: 1, name: 'X', email: 'a@b.co' }] }); } catch (e) { threw = /document required/.test(e.message); }
ok(threw, 'no documents rejected');

// 4. HMAC verify — base64, multi-key, constant-time, fail-closed
const body = Buffer.from('{"envelopeId":"abc","event":"envelope-completed"}');
const goodSig = crypto.createHmac('sha256', Buffer.from('testkey2', 'utf8')).update(body).digest('base64');
ok(d.verifyConnectHmac(body, [goodSig]) === true, 'valid HMAC (2nd rotation key) accepted');
ok(d.verifyConnectHmac(body, ['wrong-signature']) === false, 'bad signature rejected');
ok(d.verifyConnectHmac(Buffer.from('tampered'), [goodSig]) === false, 'tampered body rejected');
ok(d.verifyConnectHmac(body, []) === false, 'no signature header rejected');

// 5. connectSignatureHeaders extraction
const req = { headers: { 'x-docusign-signature-1': 'sigA', 'x-docusign-signature-2': 'sigB', 'content-type': 'application/json' } };
const sigs = d.connectSignatureHeaders(req);
ok(sigs.length === 2 && sigs[0] === 'sigA' && sigs[1] === 'sigB', 'extracts all X-DocuSign-Signature-N headers');

// 6. L-A: signers default to PARALLEL routing (order 1) when no routingOrder given
const parDef = d.buildEnvelopeDefinition({
  documents: [{ base64: 'AAAA', documentId: 1 }],
  signers: [
    { recipientId: 1, name: 'A', email: 'a@b.co', tabsByDoc: { 1: { sign: ['/a/'] } } },
    { recipientId: 2, name: 'B', email: 'b@b.co', tabsByDoc: { 1: { sign: ['/b/'] } } },
  ],
});
ok(parDef.recipients.signers.every((s) => s.routingOrder === '1'), 'L-A: co-signers default to parallel routing (order 1)');

// 7. L-C: createRecipientView rejects a returnUrl NOT on the app origin (before any network)
(async () => {
  let blocked = false;
  try { await d.createRecipientView('env-x', { returnUrl: 'https://evil.example.com/steal', clientUserId: 'c1', recipientId: 1, email: 'a@b.co', userName: 'A' }); }
  catch (e) { blocked = /returnUrl must be on|DOCUSIGN_ARG/.test(e.message) || e.code === 'DOCUSIGN_ARG'; }
  ok(blocked, 'L-C: off-origin returnUrl rejected (open-redirect defense)');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
