/**
 * Tests for the second-wave e-sign hardening:
 *   • orchestrate.validateGenerated — a real send never renders a blank/zero on a
 *     legal document (loan #, amount, property, signer name).  [pure]
 *   • send.sendClaimedEnvelope disposition — a claim miss is disambiguated into
 *     already_sent (success) vs dead vs queued (NOT delivered), so no false "Sent".
 *     [needs a migrated Postgres: DATABASE_URL=postgres://… node scripts/test-esign-hardening.js]
 *
 * The disposition cases use app-less is_test rows: the send engine's claim requires
 * application_id IS NOT NULL, so the claim always misses and the disposition branch
 * (envelope_id? dead? else queued) is exercised directly — with no real loan file.
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const orchestrate = require(R + '/src/lib/esign/orchestrate');
const send = require(R + '/src/lib/esign/send');
const db = require(R + '/src/db');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const TS = orchestrate.PACKAGES.term_sheet_package;   // has bp_disclosure (generated)
const IS = orchestrate.PACKAGES.heter_iska;           // generated, but no loan#/property

const full = { loanNumber: 'YS-1', loanAmount: 500000, bFirst: 'Pat', bLast: 'B',
  hasCoBorrower: false, propStreet: '1 Main', propCity: 'Lakewood', propState: 'NJ', propZip: '08701' };

(async () => {
  // ---- validateGenerated (pure) --------------------------------------------
  assert.doesNotThrow(() => orchestrate.validateGenerated(TS, full), 'complete data passes'); n++;
  const throws = (data, re, m) => { assert.throws(() => orchestrate.validateGenerated(TS, data),
    (e) => re.test(e.message) && e.retryable === false, m); n++; };
  throws({ ...full, loanAmount: null }, /loan amount/, 'missing amount throws');
  throws({ ...full, loanNumber: '' }, /loan number/, 'missing loan number throws');
  throws({ ...full, propStreet: '', propCity: '', propState: '', propZip: '' }, /property/, 'blank property throws');
  throws({ ...full, bFirst: '', bLast: '' }, /borrower name/, 'nameless borrower throws');
  throws({ ...full, hasCoBorrower: true, cbFirst: '', cbLast: '' }, /co-borrower name/, 'nameless co-borrower throws');
  // The Heter Iska prints the amount + names but NOT the loan number / property.
  assert.doesNotThrow(() => orchestrate.validateGenerated(IS, { loanAmount: 1, bFirst: 'A', bLast: 'B', hasCoBorrower: false }),
    'iska package does not require loan number / property'); n++;

  // ---- send disposition (DB) -----------------------------------------------
  const mk = (cols) => db.query(
    `INSERT INTO esign_envelopes (application_id, is_test, test_label, purpose, status, envelope_id, dead_lettered_at, last_error)
     VALUES (NULL, true, 'hardening TEST', 'test', $1, $2, $3, $4) RETURNING id`,
    [cols.status, cols.envelope_id || null, cols.dead_at || null, cols.err || null]);
  const boom = () => { throw new Error('buildDefinition must not run on a claim miss'); };

  const sent = (await mk({ status: 'sent', envelope_id: 'ENV-A' })).rows[0].id;
  const r1 = await send.sendClaimedEnvelope(sent, { db, buildDefinition: boom });
  ok(r1.alreadySent === true && r1.disposition === 'already_sent', 'an already-sent envelope → already_sent (a real success)');

  const dead = (await mk({ status: 'error', dead_at: new Date().toISOString(), err: 'nope' })).rows[0].id;
  const r2 = await send.sendClaimedEnvelope(dead, { db, buildDefinition: boom });
  ok(r2.dead === true && r2.disposition === 'dead', 'a dead-lettered envelope → dead');

  const queued = (await mk({ status: 'not_sent', err: 'transient 503' })).rows[0].id;
  const r3 = await send.sendClaimedEnvelope(queued, { db, buildDefinition: boom });
  ok(r3.queued === true && r3.disposition === 'queued' && !r3.alreadySent, 'a backing-off / undelivered envelope → queued (NOT a false Sent)');

  const r4 = await send.sendClaimedEnvelope('00000000-0000-0000-0000-000000000000', { db, buildDefinition: boom });
  ok(r4.disposition === 'gone', 'a vanished row → gone');

  await db.query(`DELETE FROM esign_envelopes WHERE id = ANY($1)`, [[sent, dead, queued]]);
  console.log(`\n✓ esign hardening: ${n} assertions passed`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
