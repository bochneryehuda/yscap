/**
 * TPO own-Xactus (Phase 5b) — real Postgres + HTTP.
 *
 * A brokerage firm may pull CREDIT on their OWN Xactus account. Proves:
 *   • resolveForApplication returns a firm's login ONLY for that firm's TPO file,
 *     and null for a retail file / an unconfigured firm / an inactive row (→ our
 *     shared account, unchanged);
 *   • the password is ENCRYPTED at rest and is NEVER returned by status / the API;
 *   • provider.pull routes to the FIRM's endpoint + login when firm creds resolve,
 *     and to OUR shared account otherwise;
 *   • importCredit threads the resolved firm credentials to provider.pull;
 *   • the internal admin routes set / show (no secret) / toggle / clear / test, are
 *     gated, and one firm's account never leaks to another firm's file.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-local-run-only';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// Seed OUR shared account so the "fall back to ours" path is observable + distinct.
process.env.XACTUS_API_URL = 'https://ours.xactus.example/uaweb/mismo3';
process.env.XACTUS_API_USERNAME = 'OUR_LOGIN';
process.env.XACTUS_API_PASSWORD = 'our-shared-pw';

const http = require('http');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => {
        const buf = Buffer.concat(ch); let j = null;
        try { j = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: buf.toString('utf8') });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO own-Xactus DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const firmCreds = require(R + '/src/lib/credit/firm-credentials');
  const provider = require(R + '/src/lib/credit/provider');
  const credit = require(R + '/src/lib/credit');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@ox.test`;
  const staffTok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
  const FIRM_A = { endpoint: 'https://firma.xactus.example/uaweb/mismo3', username: 'FIRMA_LOGIN', password: 'firmA-secret-pw', authMode: 'query' };

  try {
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`OX Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`OX Firm B ${sfx}`])).rows[0].id;
    const hash = await C.hashPassword('Pw123456!');
    const admin = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,password_hash,token_version) VALUES ($1,'Ox Admin','super_admin',true,$2,0) RETURNING id`, [mail('admin'), hash])).rows[0].id;
    const lo = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,password_hash,token_version) VALUES ($1,'Ox LO','loan_officer',true,$2,0) RETURNING id`, [mail('lo'), hash])).rows[0].id;
    const brokerA = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version) VALUES ($1,'Broker A','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const adminTok = staffTok(admin, 'super_admin'), loTok = staffTok(lo, 'loan_officer');

    // a borrower with an SSN + address so a live pull would actually be attempted
    const ssn = C.ssnForStorage('444556666');
    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,ssn_encrypted,ssn_last4,ssn_hash,current_address,origin)
       VALUES ('Cy','Ox',$1,$2,$3,$4,$5,'tpo') RETURNING id`,
      [mail('cy'), ssn.encrypted, ssn.last4, ssn.hash, JSON.stringify({ line1: '1 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
    const mkApp = async (isTpo, firm) => (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source)
       VALUES ($1,$2,$3,$4,$5,'in_review','Purchase','tpo') RETURNING id`,
      [borId, isTpo, firm, isTpo ? brokerA : null, `OX${sfx}${isTpo ? firm.slice(0, 3) : 'R'}`.slice(0, 20)])).rows[0].id;
    const tpoAppA = await mkApp(true, firmA);
    const tpoAppB = await mkApp(true, firmB);
    const retailApp = await mkApp(false, null);

    // ── configure firm A's own account ──
    await firmCreds.setForFirm(firmA, FIRM_A, admin);

    // ── resolution ──
    const rA = await firmCreds.resolveForApplication(tpoAppA);
    ok(rA && rA.endpoint === FIRM_A.endpoint && rA.username === 'FIRMA_LOGIN' && rA.password === 'firmA-secret-pw' && rA.authMode === 'query',
      "resolveForApplication(firm A's TPO file) → firm A's decrypted login");
    ok((await firmCreds.resolveForApplication(tpoAppB)) === null, "firm B's TPO file → null (firm B has no own account)");
    ok((await firmCreds.resolveForApplication(retailApp)) === null, 'a retail file → null (never a firm account)');

    // ── encrypted at rest + status never leaks the password ──
    const raw = (await db.query(`SELECT password_encrypted FROM tpo_firm_credit_credentials WHERE tpo_firm_id=$1`, [firmA])).rows[0].password_encrypted;
    ok(Buffer.isBuffer(raw) && !raw.toString('utf8').includes('firmA-secret-pw'), 'the password is stored ENCRYPTED (not plaintext) at rest');
    ok(C.decryptSecret(raw) === 'firmA-secret-pw', 'the stored ciphertext decrypts back to the password');
    const st = await firmCreds.statusForFirm(firmA);
    ok(st.configured && st.hasPassword === true && st.username === 'FIRMA_LOGIN' && st.password === undefined && st.passwordEncrypted === undefined,
      'statusForFirm reports presence + non-secret config, NEVER the password');

    // ── active toggle ──
    await firmCreds.setActiveForFirm(firmA, false);
    ok((await firmCreds.resolveForApplication(tpoAppA)) === null, 'an INACTIVE firm account resolves to null (→ our shared account)');
    await firmCreds.setActiveForFirm(firmA, true);
    ok((await firmCreds.resolveForApplication(tpoAppA)) !== null, 're-activating restores the firm account');

    // ── provider.pull routes to the firm endpoint / login (stub fetch) ──
    const seen = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => { seen.push({ url: String(url), auth: (opts.headers && opts.headers.Authorization) || null }); return { ok: true, status: 200, text: async () => '<MESSAGE></MESSAGE>', headers: { get: () => 'text/xml' } }; };
    const borrowerArg = { firstName: 'Cy', lastName: 'Ox', ssn: '444556666', address: { line1: '1 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' } };
    try {
      await provider.pull({ borrower: borrowerArg, pullType: 'soft', requestType: 'new', credentials: rA });
      ok(seen.length === 1 && seen[0].url.startsWith('https://firma.xactus.example'), "provider.pull(firm creds) posts to the FIRM's endpoint");
      ok(seen[0].url.includes('LoginAccountIdentifier=FIRMA_LOGIN'), "provider.pull(firm creds, query auth) uses the FIRM's login");
      seen.length = 0;
      await provider.pull({ borrower: borrowerArg, pullType: 'soft', requestType: 'new' });   // no creds → ours
      ok(seen.length === 1 && seen[0].url.startsWith('https://ours.xactus.example'), 'provider.pull(no creds) posts to OUR shared endpoint');
      ok(seen[0].auth && Buffer.from(seen[0].auth.replace('Basic ', ''), 'base64').toString().startsWith('OUR_LOGIN:'), 'provider.pull(no creds) uses OUR shared login (basic auth)');
    } finally { global.fetch = origFetch; }

    // ── importCredit threads the resolved firm credentials to provider.pull ──
    const origPull = provider.pull;
    let captured = 'UNSET';
    provider.pull = async (opts) => { captured = opts.credentials || null; const e = new Error('SENTINEL_STOP'); e._sentinel = true; throw e; };
    try {
      captured = 'UNSET';
      await credit.importCredit(tpoAppA, { consent: true, borrowerIds: [borId] }).catch(() => {});
      ok(captured && captured.username === 'FIRMA_LOGIN', 'importCredit threads the FIRM credentials to provider.pull for a configured TPO file');
      captured = 'UNSET';
      await credit.importCredit(retailApp, { consent: true, borrowerIds: [borId] }).catch(() => {});
      ok(captured === null, 'importCredit passes NO firm credentials for a retail file (→ our shared account)');
    } finally { provider.pull = origPull; }

    // ── internal admin routes ──
    // set firm B via the API
    const put = await call(server, 'PUT', `/api/admin/tpo/firms/${firmB}/credit-credentials`, adminTok,
      { endpoint: 'https://firmB.xactus.example/uaweb/mismo3', username: 'FIRMB_LOGIN', password: 'firmB-secret-pw', authMode: 'basic' });
    ok(put.status === 200 && put.body.credit && put.body.credit.configured, 'admin PUT sets a firm credit account (200)');
    ok(!put.raw.includes('firmB-secret-pw'), 'the PUT response NEVER echoes the password');
    const get = await call(server, 'GET', `/api/admin/tpo/firms/${firmB}/credit-credentials`, adminTok);
    ok(get.status === 200 && get.body.credit.hasPassword === true && !get.raw.includes('firmB-secret-pw'), 'admin GET shows status (hasPassword) but NEVER the password');
    // firm isolation: firm B's own account is used for firm B's file, NOT firm A's
    ok((await firmCreds.resolveForApplication(tpoAppB)).username === 'FIRMB_LOGIN', "firm B's file now resolves to FIRM B's login");
    ok((await firmCreds.resolveForApplication(tpoAppA)).username === 'FIRMA_LOGIN', "firm A's file still resolves to FIRM A's login (no cross-firm leak)");
    // toggle + clear
    const off = await call(server, 'POST', `/api/admin/tpo/firms/${firmB}/credit-credentials/active`, adminTok, { active: false });
    ok(off.status === 200 && off.body.credit.isActive === false, 'admin can deactivate a firm account');
    const del = await call(server, 'DELETE', `/api/admin/tpo/firms/${firmB}/credit-credentials`, adminTok);
    ok(del.status === 200 && del.body.credit.configured === false, 'admin can clear a firm account');
    // gating: a non-admin staffer cannot reach the internal TPO admin surface at all
    const denied = await call(server, 'GET', `/api/admin/tpo/firms/${firmA}/credit-credentials`, loTok);
    ok(denied.status === 403, 'a non-admin staffer is refused (403) — the surface is internal-admin only');
    // a bad payload is a clean 400 (not a 500)
    const bad = await call(server, 'PUT', `/api/admin/tpo/firms/${firmA}/credit-credentials`, adminTok, { endpoint: 'not-a-url', username: 'x', password: 'y' });
    ok(bad.status === 400, 'an invalid endpoint is refused with a clean 400');
    // SSRF/egress guard: an endpoint at a private/internal host is refused (400) — the
    // firm password + borrower PII would otherwise be POSTed to it.
    const ssrf = await call(server, 'PUT', `/api/admin/tpo/firms/${firmA}/credit-credentials`, adminTok, { endpoint: 'https://169.254.169.254/latest', username: 'x', password: 'y' });
    ok(ssrf.status === 400, 'a private/internal endpoint host is refused with a 400 (SSRF guard)');
    // a non-existent firm → 404
    const nf = await call(server, 'GET', `/api/admin/tpo/firms/00000000-0000-0000-0000-000000000000/credit-credentials`, adminTok);
    ok(nf.status === 404, 'an unknown firm id → 404');

    console.log(`\ntest-tpo-own-xactus-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('  FAIL (threw):', e && e.stack || e); fail++;
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) {}
  }
  process.exit(fail ? 1 : 0);
})();
