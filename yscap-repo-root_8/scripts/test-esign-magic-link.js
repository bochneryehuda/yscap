'use strict';
/**
 * test-esign-magic-link.js — PILOT's branded "ready to sign" magic-link flow
 * (owner-directed 2026-07-20): a borrower clicks PILOT's own email, goes STRAIGHT
 * to the DocuSign envelope, signs, and lands back INSIDE their loan file already
 * logged in. Covers:
 *   • the signed magic/return tokens (round-trip + kind guards);
 *   • auth.authenticate REFUSES a magic token presented as a Bearer session;
 *   • the whole HTTP flow through the real esign-public router against a live PG,
 *     with DocuSign.createRecipientView stubbed: GET /sign → 302 to DocuSign with a
 *     return-auth threaded in; GET /return exchanges it for a ONE-TIME login code;
 *     POST /claim-session mints a real borrower session ONCE (single-use);
 *   • notify-signers emails each pending signer their own magic link.
 *
 * Run: DATABASE_URL=... PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres node scripts/test-esign-magic-link.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-magic-link';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const express = require('express');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto');
const magic = require(REPO + '/src/lib/esign/magic-link');
const auth = require(REPO + '/src/auth');
const notifySigners = require(REPO + '/src/lib/esign/notify-signers');
const docusign = require(REPO + '/src/lib/integrations/docusign');

let n = 0, fail = 0;
const ok = (c, m) => { if (c) { n++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)})`);

// Stub DocuSign's embedded-view mint — record the returnUrl so we can assert the
// return-auth is threaded, and hand back a fake signing URL.
let crvArgs = null;
docusign.createRecipientView = async (envId, opts) => { crvArgs = { envId, opts }; return 'https://demo.docusign.net/signing/FAKE-VIEW'; };

const esignPublic = require(REPO + '/src/routes/esign-public');
const app = express();
app.use(express.json());
app.use('/api/esign', esignPublic);

const TAG = 'magiclink-' + Date.now().toString(36);
let server, base;
const listen = () => new Promise((res) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; res(); }); });

// fetch a URL WITHOUT following redirects, returning { status, location, json }.
async function hit(path, init = {}) {
  const r = await fetch(base + path, { redirect: 'manual', ...init });
  let json = null; try { json = await r.json(); } catch (_) { /* not json */ }
  return { status: r.status, location: r.headers.get('location') || '', json };
}
const qval = (url, key) => { const m = url && url.match(new RegExp('[?&]' + key + '=([^&]+)')); return m ? decodeURIComponent(m[1]) : null; };

async function main() {
  await require(REPO + '/src/migrate-boot').ensureSchema();
  await listen();

  // ---- Part A — the tokens (no DB) -------------------------------------------
  console.log('\nA. magic + return tokens');
  {
    const t = magic.mintSigningToken({ envelopeRowId: 'ER1', borrowerId: 'B1', recipientIdDs: '1' });
    const v = magic.verifySigningToken(t);
    ok(v && v.envelopeRowId === 'ER1' && v.borrowerId === 'B1' && v.recipientIdDs === '1', 'signing token round-trips');
    ok(magic.verifySigningToken('garbage') === null, 'a garbage signing token is rejected');
    // `sub` is the ENVELOPE id, never the borrower id (so it can never be a session).
    const claims = C.verifyJwt(t);
    eq(claims.kind, 'esign_magic', 'signing token kind is esign_magic');
    eq(claims.sub, 'ER1', 'signing token sub is the envelope id (not the borrower id)');
    const ra = magic.mintReturnAuth({ borrowerId: 'B1', applicationId: 'APP1' });
    const rv = magic.verifyReturnAuth(ra);
    ok(rv && rv.borrowerId === 'B1' && rv.applicationId === 'APP1', 'return-auth round-trips');
    ok(magic.verifyReturnAuth(t) === null, 'a signing token is NOT accepted as a return-auth (kind guard)');
    ok(magic.verifySigningToken(ra) === null, 'a return-auth is NOT accepted as a signing token (kind guard)');
    ok(magic.signingUrl(t).includes('/api/esign/sign?t='), 'signingUrl is a plain path+query (tracking-safe)');
  }

  // ---- Part B — a magic token can NEVER be a Bearer session ------------------
  console.log('\nB. auth.authenticate refuses a magic token as a Bearer');
  {
    for (const tok of [magic.mintSigningToken({ envelopeRowId: 'X', borrowerId: 'Y', recipientIdDs: '1' }),
                       magic.mintReturnAuth({ borrowerId: 'Y', applicationId: 'Z' })]) {
      let code = 0; const req = { get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${tok}` : ''), headers: {} };
      const res = { status(c) { code = c; return this; }, json() { return this; } };
      await auth.authenticate(req, res, () => { code = 200; });
      eq(code, 401, 'authenticate() 401s a magic/return token used as a session');
    }
  }

  const bId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  let appId, envRowId, envId = 'ENV-' + TAG;
  try {
    // ---- seed a borrower with a login + a sent envelope + an embedded recipient -
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Mia','Sign',$2)`, [bId, `mia+${TAG}@example.com`]);
    await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, email_verified) VALUES ($1,'x',true)`, [bId]);
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Stranger','X',$2)`, [otherId, `stranger+${TAG}@example.com`]);
    appId = (await db.query(
      `INSERT INTO applications (ys_loan_number, borrower_id, property_address, loan_amount)
       VALUES ($1,$2,'{"line1":"9 Sign St","city":"Lakewood","state":"NJ","zip":"08701","oneLine":"9 Sign St, Lakewood, NJ 08701"}',400000)
       RETURNING id`, [`YSCAP-${TAG}`, bId])).rows[0].id;
    envRowId = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, envelope_id, countersign_required)
       VALUES ($1,'term_sheet_package','sent',$2,true) RETURNING id`, [appId, envId])).rows[0].id;
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'borrower',1,'1',$2,'Mia Sign',$3,true,$4,'sent')`,
      [envRowId, bId, `mia+${TAG}@example.com`, `${envRowId}:borrower`]);

    // ---- Part C — the HTTP flow ------------------------------------------------
    console.log('\nC. /sign → /return → /claim-session');
    const goodTok = magic.mintSigningToken({ envelopeRowId: envRowId, borrowerId: bId, recipientIdDs: '1' });

    // GET /sign → 302 straight to DocuSign, with a return-auth threaded into returnUrl.
    crvArgs = null;
    let r = await hit(`/api/esign/sign?t=${encodeURIComponent(goodTok)}`);
    eq(r.status, 302, '/sign redirects');
    eq(r.location, 'https://demo.docusign.net/signing/FAKE-VIEW', '/sign 302s straight to the DocuSign view');
    ok(crvArgs && crvArgs.envId === envId, '/sign minted the view for the right envelope');
    const returnUrl = crvArgs.opts.returnUrl;
    ok(/dest=borrower/.test(returnUrl) && returnUrl.includes(`env=${encodeURIComponent(envId)}`), 'returnUrl carries env + dest=borrower');
    const ra = qval(returnUrl, 'ra');
    ok(ra && magic.verifyReturnAuth(ra), 'returnUrl carries a valid return-auth token');

    // GET /return with the return-auth → 302 to /#/esign/done with a one-time login code.
    r = await hit(`/api/esign/return?app=${appId}&env=${encodeURIComponent(envId)}&dest=borrower&ra=${encodeURIComponent(ra)}&event=signing_complete`);
    eq(r.status, 302, '/return redirects');
    ok(r.location.includes('/#/esign/done'), '/return lands on the esign/done handoff route');
    ok(r.location.includes(`app=${appId}`) && /state=signed/.test(r.location), '/return carries the file + signed state');
    const li = qval(r.location, 'li');
    ok(li, '/return handed the SPA a one-time login code');

    // ONE-SHOT: replaying the SAME return-auth (a captured returnUrl) mints NO second
    // login code — closes the browser-history/proxy-log replay window (audit MED-1).
    const r2 = await hit(`/api/esign/return?app=${appId}&env=${encodeURIComponent(envId)}&dest=borrower&ra=${encodeURIComponent(ra)}&event=signing_complete`);
    ok(r2.status === 302 && !qval(r2.location, 'li'), 'a replayed return-auth mints NO second login code (one-shot)');
    ok(/#\/app\//.test(r2.location), '…a replay just lands on the file (no session handed out)');

    // POST /claim-session → a real borrower session, ONCE.
    r = await hit('/api/esign/claim-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ li }) });
    eq(r.status, 200, '/claim-session succeeds');
    const claims = r.json && r.json.token ? C.verifyJwt(r.json.token) : null;
    ok(claims && claims.kind === 'borrower' && claims.sub === bId, '/claim-session mints a borrower session for the right borrower');
    // single-use
    r = await hit('/api/esign/claim-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ li }) });
    eq(r.status, 400, '/claim-session rejects a re-used login code (single-use)');

    // A garbage magic token → the friendly "expired" landing, never a 500/crash.
    r = await hit('/api/esign/sign?t=nope');
    eq(r.status, 302, '/sign with a bad token still redirects');
    ok(/state=expired/.test(r.location), '/sign with a bad token → friendly expired landing');

    // FORGED return-auth for a DIFFERENT borrower must NOT mint a login code (the
    // envelope isn't theirs) — it falls through to the plain file landing, no `li`.
    const forged = magic.mintReturnAuth({ borrowerId: otherId, applicationId: appId });
    r = await hit(`/api/esign/return?app=${appId}&env=${encodeURIComponent(envId)}&dest=borrower&ra=${encodeURIComponent(forged)}&event=signing_complete`);
    ok(r.status === 302 && !qval(r.location, 'li'), 'a return-auth for a non-recipient mints NO login code');
    ok(/#\/app\//.test(r.location), '…and still lands on the file (embedded-style), never a session');

    // Once the recipient has signed, /sign steers to "already", not a dead DocuSign view.
    await db.query(`UPDATE esign_recipients SET signed_at=now(), status='completed' WHERE envelope_row_id=$1`, [envRowId]);
    r = await hit(`/api/esign/sign?t=${encodeURIComponent(goodTok)}`);
    ok(r.status === 302 && /state=already/.test(r.location), '/sign on an already-signed package → "already" landing');
    await db.query(`UPDATE esign_recipients SET signed_at=NULL, status='sent' WHERE envelope_row_id=$1`, [envRowId]);

    // ---- Part D — notify-signers emails each pending signer a magic link -------
    console.log('\nD. notify-signers');
    const sends = [];
    const fakeMail = { send: async (kind, to, args) => { sends.push({ kind, to, args }); return { ok: true }; } };
    const res = await notifySigners.notifyReadyToSign(envRowId, { db, mail: fakeMail });
    eq(res.sent, 1, 'notify-signers emailed the one pending signer');
    eq(sends.length, 1, 'exactly one email built');
    eq(sends[0].kind, 'esignReadyToSign', 'uses the PILOT branded template');
    eq(sends[0].to, `mia+${TAG}@example.com`, 'sent to the signer');
    ok(sends[0].args.signUrl && sends[0].args.signUrl.includes('/api/esign/sign?t='), 'email carries a direct-to-DocuSign magic link');
    ok(sends[0].args.loanNumber === `YSCAP-${TAG}` && /9 Sign St/.test(sends[0].args.propertyLabel || ''), 'email names the loan # + property (borrower-safe)');
    // and the emailed link verifies back to THIS recipient/envelope
    const emailTok = qval(sends[0].args.signUrl, 't');
    const ev = magic.verifySigningToken(emailTok);
    ok(ev && ev.envelopeRowId === envRowId && ev.borrowerId === bId && ev.recipientIdDs === '1', 'the emailed link is bound to the right envelope + recipient');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${n} passed, ${fail} failed`);
  } finally {
    // cleanup (children cascade off borrowers/applications/envelopes)
    await db.query(`DELETE FROM email_tokens WHERE borrower_id=$1`, [bId]).catch(() => {});
    if (envRowId) await db.query(`DELETE FROM esign_envelopes WHERE id=$1`, [envRowId]).catch(() => {});
    if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bId, otherId]]).catch(() => {});
    await new Promise((r) => server.close(r));
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
