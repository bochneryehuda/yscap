'use strict';
/* THE OFFICER'S "REVIEW & SIGN" BUTTON MUST OPEN DOCUSIGN — never the pipeline.
 * Owner-reported 2026-08-24, with the email in hand: *"My officer got this to sign the term
 * sheet, and it doesn't take him directly to DocuSign ... It's taking him to the pipeline ...
 * on previous files, if I go and I click the Resend button, it will actually resend them an
 * email that should actually take him to DocuSign because he can't sign it."*
 *
 * TWO DEFECTS, and the second is what put him on the pipeline.
 *
 * 1. THE GUARD ASKED THE ENVELOPE A QUESTION ABOUT THE RECIPIENT. `/api/esign/sign` selected
 *    `e.status` aliased plainly as `status`, never `r.status`, and then tested it as "can this
 *    person still sign?" beside two checks that DO read recipient columns (`signed_at`,
 *    `declined_at`). So a package that had been VOIDED, CLEARED or RE-ISSUED answered every
 *    click with `state=already` — "you have already signed" — about a signature that had never
 *    been given. Clicking Resend was the workaround, and it is the workaround this removes.
 *
 * 2. THE LANDING PAGE WAS BORROWER-ONLY. `EsignDone` sent everyone to `/app/:id`, and App.jsx's
 *    `<Private>` answers a staff session with `<Navigate to="/internal">` — THE PIPELINE. So a
 *    staff signer whose link did not reach DocuSign was silently deposited there with nothing
 *    on screen explaining why. `who=staff` + the internal file href is the fix.
 *
 * WHAT THIS SUITE PINS is the behaviour, through the REAL router with DocuSign stubbed: the
 * ordinary package opens, a dead link FOLLOWS to the live re-issue of the same package for the
 * same signer, a signature already given is never re-opened, and the follow can never cross to
 * another file. Fixtures are the shapes the DATABASE actually allows — `uq_esign_inflight`
 * forbids two in-flight envelopes per (file, purpose), and `clear.js` sets `status='voided'`
 * alongside `cleared_at`, so an invented "cleared but still sent" row proves nothing.
 *
 * Run: DATABASE_URL=... node scripts/test-esign-sign-link-db.js
 */
process.env.APP_URL = process.env.APP_URL || 'https://pilot.example.com';
const R = '/home/user/yscap/yscap-repo-root_8';
const db = require(R + '/src/db');
const magic = require(R + '/src/lib/esign/magic-link');
const dsPath = require.resolve(R + '/src/lib/integrations/docusign.js');
require(dsPath);
require.cache[dsPath].exports = Object.assign({}, require.cache[dsPath].exports, {
  createRecipientView: async (envId) => `https://demo.docusign.net/SESSION?env=${envId}`,
});
const express = require('express');
const http = require('http');

const mkEnv = async (app, status, envId, cleared) => (await db.query(
  `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, countersign_required, sent_at, cleared_at)
   VALUES ($1,'term_sheet_package',$2,$3,true, now(), $4) RETURNING id`,
  [app, status, envId, cleared ? new Date() : null])).rows[0].id;

const mkRec = async (env, email, rstatus, signed) => db.query(
  `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, is_countersigner, recipient_id_ds,
                                 borrower_id, name, email, embedded, client_user_id, status, signed_at)
   VALUES ($1,'loan_officer',1,false,'2',NULL,'Simcha Officer',$2,true,$3,$4,$5)`,
  [env, email, `${env}:loan_officer`, rstatus, signed ? new Date() : null]);

async function hit(token) {
  const a = express();
  a.use('/api/esign', require(R + '/src/routes/esign-public'));
  const srv = http.createServer(a);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/esign/sign?t=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const loc = res.headers.get('location') || '';
  srv.close();
  return loc;
}
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const read = (loc) => ({
  docusign: /docusign\.net/.test(loc),
  envelope: (loc.match(/[?&]env=([^&]+)/) || [null, null])[1],
  state: (loc.match(/state=([a-z_]+)/) || [null, null])[1],
  staff: /who=staff/.test(loc),
});

(async () => {
  const sfx = () => Math.random().toString(36).slice(2, 8);
  const bor = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Shmuel','Wolosow',$1) RETURNING id`, [`b-${sfx()}@x.test`])).rows[0].id;
  const off = (await db.query(`INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Simcha Officer','loan_officer',true) RETURNING id, email`, [`simcha-${sfx()}@yscapgroup.com`])).rows[0];
  const mkApp = async () => (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, status, loan_type, property_address)
     VALUES ($1,$2,'in_review','Purchase','{"oneLine":"5705 Melvin St"}'::jsonb) RETURNING id`,
    [bor, `YSCAP-${sfx()}`])).rows[0].id;
  const tok = (env) => magic.mintSigningToken({ envelopeRowId: String(env), borrowerId: null, staffId: String(off.id), recipientIdDs: '2' });

  console.log('\nA. the officer clicks "Review & sign"');
  // THE CONTROL. Without it every assertion below could pass on a route that never opens
  // DocuSign for anybody, and the suite would be measuring nothing.
  let app = await mkApp();
  let e1 = await mkEnv(app, 'sent', 'ds-live-' + sfx(), false); await mkRec(e1, off.email, 'sent', false);
  ok('CONTROL: a live package opens the signing session', read(await hit(tok(e1))).docusign);

  // Nothing live to open. It must SAY the package was replaced — not "already signed", which
  // is false about a signature never given — and it must be flagged as a staff landing so the
  // page never sends one of ours to a borrower route.
  app = await mkApp();
  e1 = await mkEnv(app, 'voided', 'ds-void-' + sfx(), false); await mkRec(e1, off.email, 'sent', false);
  {
    const r = read(await hit(tok(e1)));
    ok('a voided package with no replacement says SUPERSEDED', r.state === 'superseded');
    ok('...and never claims he already signed', r.state !== 'already');
    ok('...and lands him as STAFF, not on a borrower route', r.staff === true);
  }

  // THE OWNER'S CASE. The emailed link points at a dead envelope while a live re-issue of the
  // same package is waiting on the same signature. This is what Resend was working around.
  app = await mkApp();
  const deadId = 'ds-dead-' + sfx(), liveId = 'ds-reissued-' + sfx();
  const dead = await mkEnv(app, 'voided', deadId, false); await mkRec(dead, off.email, 'sent', false);
  const live = await mkEnv(app, 'sent', liveId, false); await mkRec(live, off.email, 'sent', false);
  {
    const r = read(await hit(tok(dead)));
    ok('THE REPORTED BUG: a dead link opens the LIVE package', r.docusign);
    // Opening SOME session is not enough — it must be the re-issued envelope, built from THAT
    // envelope's own recipient. DocuSign refuses a view assembled from two envelopes.
    ok('...and it is the re-issued envelope, not the dead one', r.envelope === liveId);
  }

  // A CLEARED package is the same story by a different door: clear.js sets status='voided'
  // AND cleared_at, so a fixture with status='sent' + cleared_at is a state that cannot exist.
  app = await mkApp();
  const clr = await mkEnv(app, 'voided', 'ds-clr-' + sfx(), true); await mkRec(clr, off.email, 'sent', false);
  const afterClear = 'ds-after-clear-' + sfx();
  const live2 = await mkEnv(app, 'sent', afterClear, false); await mkRec(live2, off.email, 'sent', false);
  {
    const r = read(await hit(tok(clr)));
    ok('a CLEARED package follows to its re-issue too', r.docusign && r.envelope === afterClear);
  }
  void live2;

  // A SIGNATURE ALREADY GIVEN IS NEVER RE-OPENED. This is the one the follow-up must not eat:
  // "he has answered" and "this envelope is dead" are different facts, and only the second may
  // ever be followed. (uq_esign_inflight forbids a second in-flight envelope here, which is why
  // the fixture does not invent one.)
  app = await mkApp();
  const done = await mkEnv(app, 'sent', 'ds-done-' + sfx(), false); await mkRec(done, off.email, 'completed', true);
  {
    const r = read(await hit(tok(done)));
    ok('a signature already given is never re-opened', !r.docusign && r.state === 'already');
  }

  // THE SCOPE HOLDS. The same officer is an outstanding signer on a DIFFERENT file's live
  // package; the follow-up must never cross to it. A token proves who you are on ONE file.
  app = await mkApp();
  const dead2 = await mkEnv(app, 'voided', 'ds-d2-' + sfx(), false); await mkRec(dead2, off.email, 'sent', false);
  const foreign = await mkEnv(await mkApp(), 'sent', 'ds-foreign-' + sfx(), false); await mkRec(foreign, off.email, 'sent', false);
  {
    const r = read(await hit(tok(dead2)));
    ok('a live package on ANOTHER file is never followed to', !r.docusign && r.state === 'superseded');
  }
  void foreign;

  /* ---------------------------------------------------------------- B. the landing page
     THE PIPELINE SYMPTOM LIVES HERE, and no HTTP assertion above can see it: the route can
     redirect perfectly and the SCREEN can still hand a staff session to a borrower route,
     which App.jsx answers with <Navigate to="/internal"> — the pipeline. So the screen is
     pinned too. Comments are stripped first: the note explaining this change necessarily
     says "pipeline" and "/app/" repeatedly, and a guard that read comments would pass on an
     explanation alone and then be "fixed" by deleting the explanation. */
  console.log('\nB. the landing page never sends one of ours to a borrower route');
  {
    const fs = require('fs');
    const raw = fs.readFileSync(R + '/app-v2/src/screens/EsignDone.jsx', 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('it knows a staff signer when it sees one', /who'\)\s*===\s*'staff'|isStaff/.test(code));
    ok('a staff signer is sent to the INTERNAL file', /\/internal\/app\/\$\{app\}/.test(code));
    ok('...and to the internal home when there is no file', /:\s*'\/internal'/.test(code));
    ok('a borrower still goes to their own file', /`\/app\/\$\{app\}/.test(code));
    ok('"replaced" is a real outcome, distinct from "already signed"', /superseded/.test(code));
  }

  console.log(`\ntest-esign-sign-link-db: ${fail ? 'FAILED' : 'OK'} (${pass} assertions${fail ? `, ${fail} failed` : ''})`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
