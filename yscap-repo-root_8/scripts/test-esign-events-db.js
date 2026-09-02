#!/usr/bin/env node
'use strict';
/**
 * THE FULL LOG OF A SIGNING PACKAGE, and a RESEND THAT RESENDS. Real Postgres; nothing sent.
 *
 * Owner-directed 2026-09-01: a plain Resend (same address) on every package, and a
 * full activity log — sent / re-sent / email changed / viewed / signed — at the
 * bottom of every package card, everywhere they render.
 */
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP esign events DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const events = require(R + '/src/lib/esign/events');
  const fs = require('fs');
  const sfx = `ev-${process.pid}-${Math.floor(Math.random() * 1e6)}`;

  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Sam Staffer','admin',true) RETURNING id`, [`${sfx}@ev.test`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ev','Test',$1) RETURNING id`, [`${sfx}-b@ev.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, status, loan_type, ys_loan_number, property_address)
     VALUES ($1,'underwriting','Purchase',$2,'{"line1":"1 Ev St","city":"Lakewood","state":"NJ","zip":"08701"}') RETURNING id`,
    [borrowerId, `YS-${sfx}`])).rows[0].id;
  const mkEnv = async (purpose, cols = {}) => (await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, created_by, created_at, sent_at, delivered_at, completed_at)
     VALUES ($1,$2,$3,$4,$5, now() - interval '3 days', $6, $7, $8) RETURNING id`,
    [appId, purpose, cols.status || 'sent', `env-${sfx}-${Math.random().toString(36).slice(2, 7)}`, staffId,
     cols.sent_at || null, cols.delivered_at || null, cols.completed_at || null])).rows[0].id;
  const mkRecip = async (envId, role, email, cols = {}) => (await db.query(
    `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, status,
                                   sent_at, delivered_at, signed_at, invited_at, invite_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [envId, role, cols.order || 1, cols.rid || '1', role === 'borrower' ? borrowerId : null, cols.name || 'Ev Test', email,
     cols.status || 'sent', cols.sent_at || null, cols.delivered_at || null, cols.signed_at || null, cols.invited_at || null, cols.invite_count || 0])).rows[0].id;
  const audit = (action, detail, at) => db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail, created_at) VALUES ('staff',$1,$2,'application',$3,$4::jsonb,$5)`,
    [staffId, action, appId, JSON.stringify(detail), at]);
  const T = (h) => new Date(Date.now() - h * 3600e3).toISOString();

  try {
    // ── 1. One envelope, the whole story ─────────────────────────────────────
    const env = await mkEnv('term_sheet_package', { sent_at: T(70), delivered_at: T(60) });
    const rid = await mkRecip(env, 'borrower', `${sfx}-b@ev.test`, { sent_at: T(70), delivered_at: T(40), invited_at: T(69), invite_count: 2 });
    await audit('esign_send', { purpose: 'term_sheet_package', envelopeRowId: env }, T(71));
    await audit('esign_resend', { purpose: 'term_sheet_package', envelopeRowId: env, sent: 1, recipients: [`${sfx}-b@ev.test`] }, T(30));
    await audit('esign_recipient_email_changed', { purpose: 'term_sheet_package', envelopeRowId: env, recipientRowId: rid, from: 'old@ev.test', to: `${sfx}-b@ev.test` }, T(20));
    const log = (await events.envelopeEvents(db, [env]))[String(env)];
    ok(Array.isArray(log) && log.length >= 7, `the log has the whole story (${log && log.length} events)`);
    const kinds = log.map((e) => e.kind);
    for (const k of ['created', 'sent', 'delivered', 'invited', 'signer_sent', 'viewed', 'audit:esign_send', 'audit:esign_resend', 'audit:esign_recipient_email_changed']) {
      ok(kinds.includes(k), `the log carries "${k}"`);
    }
    ok(log.every((e, i) => i === 0 || e.at >= log[i - 1].at), 'events are in time order');
    ok(log.find((e) => e.kind === 'audit:esign_resend').label.includes(`${sfx}-b@ev.test`), 'the re-sent line names who got it');
    ok(/from old@ev\.test to /.test(log.find((e) => e.kind === 'audit:esign_recipient_email_changed').label), 'the email-change line says from → to');
    ok(log.find((e) => e.kind === 'audit:esign_resend').who === 'Sam Staffer', 'a staff action names the person');
    ok(log.find((e) => e.kind === 'viewed').label.includes('opened the package'), 'a signer opening it reads as "opened"');
    ok(!kinds.includes('signed') && !kinds.includes('completed'), 'nothing is invented: unsigned means no "signed" line');

    // ── 2. Two envelopes of the same purpose: a legacy audit row is NOT guessed onto either ──
    const a = await mkEnv('heter_iska', { sent_at: T(50), status: 'voided' });   // only one may be in flight (uq_esign_inflight)
    const b = await mkEnv('heter_iska', { sent_at: T(10) });
    await audit('esign_resend', { purpose: 'heter_iska' }, T(5));                       // legacy: no envelopeRowId
    await audit('esign_void', { purpose: 'heter_iska', envelopeRowId: a, reason: 'wrong borrower' }, T(4));
    const both = await events.envelopeEvents(db, [a, b]);
    ok(!both[String(a)].some((e) => e.kind === 'audit:esign_resend') && !both[String(b)].some((e) => e.kind === 'audit:esign_resend'),
      'an old resend row with no envelope id is attributed to NEITHER of two same-purpose envelopes');
    ok(both[String(a)].some((e) => e.kind === 'audit:esign_void' && /wrong borrower/.test(e.label)) && !both[String(b)].some((e) => e.kind === 'audit:esign_void'),
      'a stamped row lands on exactly its own envelope');
    // A legacy row IS attributed when the envelope is the only one of its purpose.
    const solo = await mkEnv('noo_affidavit', { sent_at: T(9) });
    await audit('esign_resend', { purpose: 'noo_affidavit' }, T(8));
    ok((await events.envelopeEvents(db, [solo]))[String(solo)].some((e) => e.kind === 'audit:esign_resend'),
      'a legacy row is attributed when there is only one envelope it could belong to');

    // ── 3. Attach + never throw ───────────────────────────────────────────────
    const objs = [{ id: env }, { id: '00000000-0000-0000-0000-000000000000' }];
    await events.attachEvents(db, objs);
    ok(Array.isArray(objs[0].events) && objs[0].events.length > 0 && Array.isArray(objs[1].events) && objs[1].events.length === 0,
      'attachEvents fills every envelope, an unknown one with []');
    ok(Object.keys(await events.envelopeEvents(db, [])).length === 0, 'no ids → no work');

    // ── 4. Every card reads it (the tracking shape + the wire form), and the resend RESENDS ──
    const tracking = fs.readFileSync(R + '/src/lib/esign/tracking.js', 'utf8');
    ok(/require\('\.\/events'\)\.attachEvents\(db, envelopes\)/.test(tracking), 'tracking.js attaches the log to every envelope it serves');
    const { envelopes } = await require(R + '/src/lib/esign/tracking').dashboard(db, { where: 'AND a.id = $1', params: [appId] });
    const served = envelopes.find((x) => String(x.id) === String(env));
    ok(served && Array.isArray(served.events) && served.events.length === log.length, 'the served envelope carries the same log');
    ok(/envelopeEvents\(db, \[env\.id\]\)/.test(fs.readFileSync(R + '/src/routes/sitewire.js', 'utf8')), 'the draw wire form reads the same log');
    const staff = fs.readFileSync(R + '/src/routes/staff.js', 'utf8');
    const resendRoute = staff.slice(staff.indexOf("router.post('/esign/:rowId/resend'"), staff.indexOf("router.post('/esign/:rowId/recipient-email'"));
    ok(/notify-signers'\)\.notifyReadyToSign\(row\.id, \{[\s\S]{0,80}force: true/.test(resendRoute),
      'the Resend button now re-sends PILOT\'s own invitation (force) — DocuSign emails a captive signer nothing');
    ok(!/return res\.status\(409\)\.json\(\{ error: 'The borrower’s email on file changed/.test(resendRoute),
      'a drifted file email no longer REFUSES the resend — it warns');
    ok(/sent: nudged\.sent, recipients: nudged\.recipients/.test(resendRoute), 'the resend audit row records what went out, with the envelope id');
    ok(/envelopeRowId: row\.id/.test(resendRoute), 'the resend audit row names its envelope');
    for (const act of ['esign_recipient_email_changed', 'esign_void', 'esign_clear', 'esign_countersign_view']) {
      const i = staff.indexOf(`audit(req, '${act}'`);
      ok(i > 0 && /envelopeRowId: row\.id/.test(staff.slice(i, i + 400)), `the ${act} audit row names its envelope`);
    }
    for (const [file, why] of [['app-v2/src/components/EsignFileSection.jsx', 'per-file section'], ['app-v2/src/screens/EsignDashboard.jsx', 'cockpit'], ['app-v2/src/components/DrawsPanel.jsx', 'draw wire form']]) {
      const src = fs.readFileSync(R + '/' + file, 'utf8');
      ok(/EsignEventLog/.test(src) && /<EsignEventLog events=\{/.test(src), `the ${why} mounts the shared log`);
    }
    ok(/Resend to this address/.test(fs.readFileSync(R + '/app-v2/src/components/EsignFileSection.jsx', 'utf8')), 'a per-signer resend exists');
  } catch (e) {
    fail++; console.log('  FAIL: harness threw:', e && e.stack ? e.stack : e);
  }
  await db.pool.end().catch(() => {});
  console.log(`esign events: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
