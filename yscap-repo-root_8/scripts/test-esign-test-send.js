/**
 * Unit tests for the admin "send myself a test envelope" tool
 * (src/lib/esign/test-send.js). No real DB, no DocuSign — a routing stub db + a
 * fake docusign. Confirms the safety guards AND the new tracked behavior:
 *   • refuses when sending is off (no envelope built, no DB write);
 *   • blocks any recipient not on the test allow-list (in test mode);
 *   • refuses when the staff account has no email;
 *   • on success, sends the TWO tracked test packages to the allow-listed address
 *     and records an app-less is_test envelope row per package.
 *
 * Run: node scripts/test-esign-test-send.js
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const cfg = require(R + '/src/config').docusign;
const ts = require(R + '/src/lib/esign/test-send');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// Capture every built definition so a test can assert the uploaded documents carry
// the CORRECT format label + bytes (the disclosure is now a branded PDF, not a docx).
const builtDefs = [];
const fakeDs = (demo = false) => ({
  isDemoHost: () => demo,
  buildEnvelopeDefinition: (x) => { builtDefs.push(x); return { __def: x }; },
  createEnvelope: async () => ({ envelopeId: 'ENV-TEST-1' }),
  eventNotification: () => ({ __evt: true }),
  notificationSettings: () => ({ __notif: true }),
});
// Routing stub: staff lookup returns the admin; envelope INSERT returns a row id;
// everything else (recipients/docs inserts, updates) is a no-op.
let rowSeq = 0;
const stubDb = (email) => ({
  query: async (sql) => {
    if (/FROM staff_users/i.test(sql)) return { rows: email ? [{ email, full_name: 'Test Admin' }] : [] };
    if (/INSERT INTO esign_envelopes/i.test(sql) && /RETURNING id/i.test(sql)) return { rows: [{ id: `ROW-${++rowSeq}` }] };
    return { rows: [] };
  },
});

(async () => {
  const savedEnabled = cfg.sendEnabled, savedTest = cfg.testMode, savedAllow = cfg.testEmailAllowlist;

  // 1. sending master switch OFF → refuse (no envelope built)
  cfg.sendEnabled = false;
  await assert.rejects(
    () => ts.sendTestEnvelope({ actorId: 'x', db: stubDb('a@b.com'), docusign: fakeDs() }),
    (e) => /DOCUSIGN_SEND_ENABLED/.test(e.message) && e.retryable === false, 'refuses when sending off'); n++;

  // 2. sending ON + test mode + email NOT on the allow-list → blocked backstop
  cfg.sendEnabled = true; cfg.testMode = true; cfg.testEmailAllowlist = ['yehuda@yscapgroup.com'];
  await assert.rejects(
    () => ts.sendTestEnvelope({ actorId: 'x', db: stubDb('stranger@example.com'), docusign: fakeDs() }),
    (e) => /allow-?list/i.test(e.message), 'blocks a non-allow-listed recipient'); n++;

  // 3. sending ON + allow-listed email → succeeds, TWO tracked packages, to that email
  builtDefs.length = 0;
  const r = await ts.sendTestEnvelope({ actorId: 'x', db: stubDb('yehuda@yscapgroup.com'), docusign: fakeDs() });
  ok(r.to === 'yehuda@yscapgroup.com' && /^ENV-/.test(r.envelopeId), 'sends to the allow-listed address');
  ok(Array.isArray(r.packages) && r.packages.length === 2, 'sends the two packages (disclosure + Heter Iska)');
  ok(r.packages.every((p) => /^ENV-/.test(p.envelopeId) && /^ROW-/.test(p.envelopeRowId) && p.label), 'each package is a tracked envelope row');

  // 3b. the uploaded documents carry the RIGHT format label + bytes. Regression guard:
  // the disclosure AND the Heter Iska are branded PDFs our server builds now
  // (disclosure-pdf.js / iska-pdf.js) — DocuSign must be told 'pdf' (not 'docx', which
  // would run the PDF through the docx→PDF converter and corrupt/error it).
  const bpd = builtDefs.flatMap((d) => d.documents).find((doc) => /Disclosure/.test(doc.name));
  const iska = builtDefs.flatMap((d) => d.documents).find((doc) => /Iska/.test(doc.name));
  ok(bpd && bpd.fileExtension === 'pdf', 'test disclosure uploads AS a PDF (not mislabeled docx)');
  ok(bpd && Buffer.from(bpd.base64, 'base64').slice(0, 5).toString('latin1') === '%PDF-', 'test disclosure bytes really are a PDF');
  ok(iska && iska.fileExtension === 'pdf', 'test Heter Iska now uploads AS a PDF (not a docx handed to DocuSign)');
  ok(iska && Buffer.from(iska.base64, 'base64').slice(0, 5).toString('latin1') === '%PDF-', 'test Heter Iska bytes really are a PDF');

  // 4. staff account has no email → refuse
  await assert.rejects(
    () => ts.sendTestEnvelope({ actorId: 'x', db: stubDb(null), docusign: fakeDs() }),
    (e) => /no email/i.test(e.message), 'refuses when the staff account has no email'); n++;

  // 5. the sample loan is obviously fake (never mistaken for a real file)
  const s = ts.sampleData();
  ok(s.loanNumber === 'YS-TEST-0000' && s.bLast === 'Borrower' && !s.hasCoBorrower, 'sample loan is clearly a test');

  // 6. the two packages mirror production: disclosure and Heter Iska are SEPARATE
  ok(ts.TEST_PACKAGES.length === 2
     && ts.TEST_PACKAGES[0].docs.some((d) => d.kind === 'bp_disclosure')
     && ts.TEST_PACKAGES[1].docs.some((d) => d.kind === 'heter_iska'), 'two separate packages, mirroring the real flow');

  cfg.sendEnabled = savedEnabled; cfg.testMode = savedTest; cfg.testEmailAllowlist = savedAllow;
  console.log(`\n✓ esign test-send: ${n} assertions passed`);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
