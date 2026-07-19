/**
 * DB-backed behavioral test for the esign send-once engine (src/lib/esign/send.js).
 * Requires a live Postgres: DATABASE_URL=postgres://... node scripts/test-esign-send.js
 * Uses a FAKE DocuSign (dependency-injected) — no network, no real account.
 * Covers: happy path, idempotent no-op, send-once race, retry+backoff, permanent
 * dead-letter, the demo-email allow-list gate, and the M-12 stale-claim reclaim.
 */
const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');
const send = require(R + '/src/lib/esign/send');
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;} else {fail++; console.log('  FAIL:',m);} };

// a configurable fake docusign
function fakeDs({ demo=false, createImpl } = {}) {
  let calls = 0;
  return {
    isDemoHost: () => demo,
    idempotencyKey: (a,p,v) => `idem:${a}:${p}:${v}`,
    buildEnvelopeDefinition: (inp) => ({ ...inp, _built:true }),
    createEnvelope: async (def, opts) => { calls++; return createImpl ? createImpl(def, opts, calls) : { envelopeId: 'ENV-'+calls, status:'sent' }; },
    get calls(){ return calls; },
  };
}
const goodInputs = () => ({ subject:'x', documents:[{base64:'AAAA',documentId:1}], signers:[{recipientId:1,name:'B',email:'b@example.com',routingOrder:1,tabsByDoc:{1:{sign:['/s/']}}}] });
const buildDefinition = async () => goodInputs();

async function newRow(purpose='term_sheet_package', extra={}){
  const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','B',$1) RETURNING id`,[`t${Math.random()}@e.com`]);
  const a = await db.query(`INSERT INTO applications(borrower_id) VALUES($1) RETURNING id`,[b.rows[0].id]);
  const e = await db.query(`INSERT INTO esign_envelopes(application_id,purpose,status,product_version) VALUES($1,$2,'not_sent',1) RETURNING *`,[a.rows[0].id,purpose]);
  return e.rows[0];
}
const get = async (id) => (await db.query(`SELECT * FROM esign_envelopes WHERE id=$1`,[id])).rows[0];

(async () => {
  // 1. happy path
  let row = await newRow();
  const ds1 = fakeDs();
  const r1 = await send.sendClaimedEnvelope(row.id, { db, docusign: ds1, buildDefinition });
  ok(r1.sent === true, 'happy path returns sent');
  ok(ds1.calls === 1, 'createEnvelope called exactly once');
  let after = await get(row.id);
  ok(after.status === 'sent' && after.envelope_id === 'ENV-1', 'row stamped sent + envelope_id');
  ok(after.idempotency_key === `idem:${row.application_id}:term_sheet_package:1`, 'deterministic idempotency key stored');
  ok(after.sent_at && after.attempts === 1, 'sent_at + attempts=1');

  // 2. re-run on an already-sent row is a no-op (skip)
  const r1b = await send.sendClaimedEnvelope(row.id, { db, docusign: ds1, buildDefinition });
  ok(r1b.skipped === true && ds1.calls === 1, 're-run on sent row skips, no 2nd create');

  // 3. SEND-ONCE race: two concurrent claims on a fresh row → only one sends
  row = await newRow();
  const dsRace = fakeDs();
  const [ra, rb] = await Promise.all([
    send.sendClaimedEnvelope(row.id, { db, docusign: dsRace, buildDefinition }),
    send.sendClaimedEnvelope(row.id, { db, docusign: dsRace, buildDefinition }),
  ]);
  const sentCount = [ra,rb].filter(x=>x.sent).length;
  const skipCount = [ra,rb].filter(x=>x.skipped).length;
  ok(sentCount === 1 && skipCount === 1, 'concurrent: exactly one sends, one skips');
  ok(dsRace.calls === 1, 'concurrent: createEnvelope called exactly once');

  // 4. retryable (500) → not sent, backoff scheduled, claim released, attempts incremented
  row = await newRow();
  const ds500 = fakeDs({ createImpl: () => { const e=new Error('boom'); e.status=500; e.retryable=true; throw e; } });
  const r4 = await send.sendClaimedEnvelope(row.id, { db, docusign: ds500, buildDefinition });
  ok(r4.retry === true, 'retryable failure → retry');
  after = await get(row.id);
  ok(after.status === 'not_sent' && after.envelope_id === null, 'retryable: stays not_sent, no envelope');
  ok(after.next_attempt_at && after.send_claimed_at === null, 'retryable: backoff set, claim released');
  ok(after.attempts === 1 && after.dead_lettered_at === null, 'retryable: attempt counted, not dead');

  // 5. permanent (4xx retryable=false) → dead-letter immediately
  row = await newRow();
  let dlCalled = 0;
  const dsPerm = fakeDs({ createImpl: () => { const e=new Error('bad request'); e.status=400; e.retryable=false; throw e; } });
  const r5 = await send.sendClaimedEnvelope(row.id, { db, docusign: dsPerm, buildDefinition, onDeadLetter: async()=>{dlCalled++;} });
  ok(r5.dead === true, 'permanent failure → dead');
  after = await get(row.id);
  ok(after.status === 'error' && after.dead_lettered_at !== null, 'permanent: status=error + dead_lettered_at');
  ok(dlCalled === 1, 'permanent: onDeadLetter hook fired (human surfaced)');

  // 6. demo email gate: demo host + signer not in allowlist → dead-letter blocked
  row = await newRow();
  const dsDemo = fakeDs({ demo:true });
  const r6 = await send.sendClaimedEnvelope(row.id, { db, docusign: dsDemo, buildDefinition });
  ok(r6.dead === true, 'demo gate: unlisted email → dead (blocked)');
  ok(dsDemo.calls === 0, 'demo gate: createEnvelope NEVER called for unlisted email');
  after = await get(row.id);
  ok(/DOCUSIGN_TEST_EMAIL_ALLOWLIST|Demo send blocked/.test(after.last_error||''), 'demo gate: clear reason recorded');

  // 7. M-12 reclaim: stale claim (6 min old, no envelope) is reclaimed and sent
  row = await newRow();
  await db.query(`UPDATE esign_envelopes SET send_claimed_at = now() - interval '6 minutes' WHERE id=$1`,[row.id]);
  const dsReclaim = fakeDs();
  const r7 = await send.sendClaimedEnvelope(row.id, { db, docusign: dsReclaim, buildDefinition });
  ok(r7.sent === true && dsReclaim.calls === 1, 'M-12: stale claim reclaimed + sent (idempotency key replayed)');

  // 7b. fresh claim held by another (2 min old) is NOT reclaimed
  row = await newRow();
  await db.query(`UPDATE esign_envelopes SET send_claimed_at = now() - interval '2 minutes' WHERE id=$1`,[row.id]);
  const r7b = await send.sendClaimedEnvelope(row.id, { db, docusign: fakeDs(), buildDefinition });
  ok(r7b.skipped === true, 'fresh in-flight claim (2 min) is not stolen');

  // 8. drainDue picks up eligible rows
  const d1 = await newRow(); const d2 = await newRow();
  const dsDrain = fakeDs();
  const res = await send.drainDue({ db, docusign: dsDrain, buildDefinition, limit: 50 });
  const sentIds = new Set(res.filter(x=>x.sent).map(x=>x.envelopeId));
  ok(sentIds.size >= 2, 'drainDue sent the due rows');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end?.();
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(2); });
