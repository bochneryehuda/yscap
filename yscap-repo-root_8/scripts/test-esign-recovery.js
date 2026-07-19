/**
 * Recovery/robustness tests for the esign failure paths (audit findings B1 + B2).
 * Requires a migrated Postgres: DATABASE_URL=postgres://… node scripts/test-esign-recovery.js
 * Uses fakes (no network, no DocuSign account).
 *
 * B1: the durable send-retry backstop must actually SEND (the poller used to call
 *     drainDue with no buildDefinition → every retry silently threw + no-op'd).
 * B2: on completion the signed docs are stored BEFORE the envelope is stamped
 *     'completed' — a download failure must NOT leave a green "completed" with
 *     missing signed docs (it must stay re-drivable).
 */
const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');
const send = require(R + '/src/lib/esign/send');
const webhook = require(R + '/src/lib/esign/webhook');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

async function newEnvelope(status = 'not_sent') {
  const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','B',$1) RETURNING id`, [`t${Math.random()}@e.com`]);
  const a = await db.query(`INSERT INTO applications(borrower_id) VALUES($1) RETURNING id`, [b.rows[0].id]);
  const e = await db.query(
    `INSERT INTO esign_envelopes(application_id,purpose,status,product_version) VALUES($1,'term_sheet_package',$2,1) RETURNING *`,
    [a.rows[0].id, status]);
  return e.rows[0];
}
const getEnv = async (id) => (await db.query(`SELECT * FROM esign_envelopes WHERE id=$1`, [id])).rows[0];

function fakeDs(overrides = {}) {
  let created = 0;
  return {
    isDemoHost: () => false,
    idempotencyKey: (a, p, v) => `idem:${a}:${p}:${v}`,
    buildEnvelopeDefinition: (inp) => ({ ...inp, _built: true }),
    createEnvelope: async () => { created++; return { envelopeId: 'ENV-' + created, status: 'sent' }; },
    parseRecipients: () => [],
    get created() { return created; },
    ...overrides,
  };
}
const goodInputs = () => ({ subject: 'x', documents: [{ base64: 'AAAA', documentId: 1 }],
  signers: [{ recipientId: 1, name: 'B', email: 'b@example.com', routingOrder: 1, tabsByDoc: { 1: { sign: ['/s/'] } } }] });

(async () => {
  const dcfg = require(R + '/src/config').docusign;
  dcfg.testMode = false;   // send-mechanics as if live (gate tested elsewhere)

  // ---- B1: drainDue WITHOUT buildDefinition no-ops (the old poller bug) --------
  {
    const row = await newEnvelope();
    const ds = fakeDs();
    const res = await send.drainDue({ db, docusign: ds });   // no buildDefinition
    ok(ds.created === 0, 'B1: drainDue with no buildDefinition creates nothing (documents the old silent no-op)');
    const after = await getEnv(row.id);
    ok(after.status === 'not_sent' && after.envelope_id === null, 'B1: row left unsent by the broken call');
    ok(res.some((r) => /buildDefinition/.test(r.error || '')), 'B1: the failure was the missing buildDefinition');
  }

  // ---- B1: drainDue WITH buildDefinition actually sends (the fix) --------------
  {
    const row = await newEnvelope();
    const ds = fakeDs();
    await send.drainDue({ db, docusign: ds, buildDefinition: async () => goodInputs() });
    ok(ds.created >= 1, 'B1: drainDue WITH buildDefinition sends due rows (the fix)');
    const after = await getEnv(row.id);
    ok(after.status === 'sent' && /^ENV-/.test(after.envelope_id || ''), 'B1: this row now stamped sent + envelope_id');
  }

  // ---- B1: the poller wires a buildDefinition into drainDue --------------------
  {
    const poller = require(R + '/src/lib/esign/poller');
    const row = await newEnvelope();
    const ds = fakeDs();
    // retrySend re-gates then builds via orchestrate. With no conditions the gate
    // fails → permanent dead-letter (NOT a silent no-op). Either way createEnvelope
    // is reached only through a real buildDefinition, proving the wiring.
    await poller.retrySend({ db, docusign: ds }).catch(() => {});
    const after = await getEnv(row.id);
    ok(after.attempts >= 1, 'B1: poller.retrySend actually claims + processes the row (attempts incremented)');
    ok(after.status === 'error' || after.status === 'sent', 'B1: row reaches a terminal/handled state, not left as a silent no-op');
  }

  // ---- B2: completion stores docs BEFORE stamping completed -------------------
  {
    const env = await newEnvelope('sent');
    await db.query(`UPDATE esign_envelopes SET envelope_id='ENV-C1' WHERE id=$1`, [env.id]);
    // one bound doc → its condition
    await db.query(`INSERT INTO checklist_templates(code,label,scope) VALUES('rtl_cond_signedts','Signed term sheet','application') ON CONFLICT (code) DO NOTHING`);
    const t = await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_signedts' LIMIT 1`);
    const ci = await db.query(`INSERT INTO checklist_items(application_id,template_id,status,scope,label) VALUES($1,$2,'outstanding','application','Signed term sheet') RETURNING id`, [env.application_id, t.rows[0].id]);
    await db.query(`INSERT INTO esign_envelope_docs(envelope_row_id,document_id,doc_kind,checklist_item_id) VALUES($1,1,'term_sheet_signed',$2)`, [env.id, ci.rows[0].id]);

    // First reconcile: DocuSign says completed, but the signed-PDF download FAILS.
    const dsFail = {
      getEnvelope: async () => ({ status: 'completed', recipients: { signers: [] } }),
      parseRecipients: () => [],
      getDocument: async () => { throw new Error('doc API 503'); },
      getCertificate: async () => Buffer.from('cert'),
    };
    let threw = false;
    try { await webhook.reconcileEnvelope(db, dsFail, require(R + '/src/lib/storage'), await getEnv(env.id)); }
    catch (e) { threw = true; }
    ok(threw, 'B2: a failed signed-doc download throws (surfaced, retried) instead of silently completing');
    const stuck = await getEnv(env.id);
    ok(stuck.status !== 'completed', 'B2: envelope NOT stamped completed while signed docs are missing');
    const noDoc = await db.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind='term_sheet_signed'`, [env.application_id]);
    ok(noDoc.rows[0].n === 0, 'B2: no half-stored signed doc');
    const condStuck = await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [ci.rows[0].id]);
    ok(condStuck.rows[0].status === 'outstanding', 'B2: the condition was NOT cleared on the failed completion');

    // Retry: download now succeeds → completes cleanly.
    const dsOk = {
      getEnvelope: async () => ({ status: 'completed', recipients: { signers: [] } }),
      parseRecipients: () => [],
      getDocument: async () => Buffer.from('signed-pdf'),
      getCertificate: async () => Buffer.from('cert'),
    };
    await webhook.reconcileEnvelope(db, dsOk, require(R + '/src/lib/storage'), await getEnv(env.id));
    const done = await getEnv(env.id);
    ok(done.status === 'completed' && done.completed_at, 'B2: retry completes the envelope once docs are stored');
    const gotDoc = await db.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind='term_sheet_signed'`, [env.application_id]);
    ok(gotDoc.rows[0].n === 1, 'B2: signed doc stored exactly once on recovery');
    const condDone = await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [ci.rows[0].id]);
    ok(condDone.rows[0].status === 'received', 'B2: condition cleared to received after recovery');
  }

  // ---- B5: a re-issue's signed doc supersedes the prior copy ------------------
  {
    const env2 = await newEnvelope('sent');
    await db.query(`UPDATE esign_envelopes SET envelope_id='ENV-C2' WHERE id=$1`, [env2.id]);
    await db.query(`INSERT INTO esign_envelope_docs(envelope_row_id,document_id,doc_kind) VALUES($1,1,'term_sheet_signed')`, [env2.id]);
    // First envelope's signed copy.
    const first = await webhook.storeSignedDocument(db, require(R + '/src/lib/storage'),
      { applicationId: env2.application_id, docKind: 'term_sheet_signed', filename: 'term_sheet_signed_ENV-A.pdf', bytes: Buffer.from('v1') });
    // Re-issue: a NEW envelope's signed copy (new deterministic filename).
    const second = await webhook.storeSignedDocument(db, require(R + '/src/lib/storage'),
      { applicationId: env2.application_id, docKind: 'term_sheet_signed', filename: 'term_sheet_signed_ENV-B.pdf', bytes: Buffer.from('v2') });
    const cur = await db.query(`SELECT id,is_current FROM documents WHERE application_id=$1 AND doc_kind='term_sheet_signed' ORDER BY created_at`, [env2.application_id]);
    const currentIds = cur.rows.filter((r) => r.is_current).map((r) => r.id);
    ok(currentIds.length === 1 && currentIds[0] === second, 'B5: only the latest signed copy stays is_current (no duplicate into TPR/SharePoint)');
    ok(cur.rows.find((r) => r.id === first).is_current === false, 'B5: prior signed copy superseded');
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} esign recovery: ${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
