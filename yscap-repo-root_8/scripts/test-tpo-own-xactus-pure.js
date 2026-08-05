/**
 * TPO own-Xactus (Phase 5b) — PURE seam tests (no DB, no network).
 *
 * Proves the credit provider runs a pull on a broker FIRM's own Xactus login when
 * one is supplied, falls back to our shared company account otherwise (a partial /
 * missing / broken firm login can NEVER change how our pulls run), and that a
 * firm's password is scrubbed from any error/log line + is only ever recovered by
 * decrypting the stored ciphertext.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-local-run-only';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// Give OUR shared account a known config so fallback is observable + distinct.
process.env.XACTUS_API_URL = process.env.XACTUS_API_URL || 'https://ours.xactus.example/uaweb/mismo3';
process.env.XACTUS_API_USERNAME = process.env.XACTUS_API_USERNAME || 'OUR_LOGIN';
process.env.XACTUS_API_PASSWORD = process.env.XACTUS_API_PASSWORD || 'our-shared-password';

const R = require('path').resolve(__dirname, '..');
const provider = require(R + '/src/lib/credit/provider');
const firmCreds = require(R + '/src/lib/credit/firm-credentials');
const C = require(R + '/src/lib/crypto');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const FIRM = {
  endpoint: 'https://firm.xactus.example/uaweb/mismo3/',
  username: 'FIRM_LOGIN',
  password: 'firm-secret-pw-123',
  authMode: 'query',
};

// ── resolveCfg: firm login wins when complete; ours otherwise ──
const rc = provider._seam.resolveCfg;
const fc = rc(FIRM);
ok(fc.endpoint === 'https://firm.xactus.example/uaweb/mismo3' && fc.username === 'FIRM_LOGIN' && fc.password === 'firm-secret-pw-123',
  'resolveCfg(complete firm creds) → the firm login (trailing slash trimmed)');
ok(fc.authMode === 'query', 'resolveCfg carries the firm authMode');
ok(fc.version === '3.4' && fc.requestingParty === 'YS Capital Group',
  'resolveCfg falls back to OUR version / requesting party when the firm omits them');
ok(fc._source === 'firm', 'resolveCfg marks a firm login as _source=firm');

// partial / missing / empty → our shared account (a broken firm row never changes our pulls)
for (const [label, creds] of [
  ['missing password', { endpoint: FIRM.endpoint, username: FIRM.username }],
  ['missing endpoint', { username: FIRM.username, password: FIRM.password }],
  ['empty object', {}],
  ['null', null],
  ['undefined', undefined],
]) {
  const r = rc(creds);
  ok(r.endpoint === 'https://ours.xactus.example/uaweb/mismo3' && r.username === 'OUR_LOGIN' && r._source !== 'firm',
    `resolveCfg(${label}) → OUR shared account (fallback)`);
}

// ── configured() reflects the resolved login ──
ok(provider.configured(FIRM) === true, 'configured(firm creds) is true');
ok(provider.configured() === true, 'configured() (ours, seeded) is true');
ok(provider.configured({ endpoint: 'https://x/', username: 'u' }) === true,
  'configured(partial firm) falls back to ours (true because ours is seeded) — never uses the partial');

// ── scrubCredentials strips the ACTIVE login (the firm password) ──
const leak = `POST failed for FIRM_LOGIN using firm-secret-pw-123 at https://firm.xactus.example`;
const scrubbed = provider._seam.scrubCredentials(leak, FIRM);
ok(!scrubbed.includes('firm-secret-pw-123'), "scrubCredentials(err, firm creds) removes the FIRM's password");
ok(!scrubbed.includes('FIRM_LOGIN'), "scrubCredentials(err, firm creds) removes the FIRM's username");
// with no creds it scrubs OURS (back-compat) and leaves the firm secret (that path never sees it)
const scrubbedOurs = provider._seam.scrubCredentials('our-shared-password leaked', undefined);
ok(!scrubbedOurs.includes('our-shared-password'), 'scrubCredentials(err) with no creds still scrubs our shared password (back-compat)');

// ── crypto secret round-trip + credsFromRow ──
const enc = C.encryptSecret('firm-secret-pw-123');
ok(Buffer.isBuffer(enc) && enc.length > 0, 'encryptSecret returns a non-empty bytea buffer');
ok(C.decryptSecret(enc) === 'firm-secret-pw-123', 'decryptSecret round-trips the secret');
ok(C.decryptSecret(Buffer.from('garbage-not-ciphertext')) === null, 'decryptSecret returns null on garbage (never throws)');

const row = { endpoint: FIRM.endpoint, username: FIRM.username, password_encrypted: enc, account: '', client_id: '', version: null, requesting_party: null, auth_mode: 'query' };
const built = firmCreds._internals.credsFromRow(row);
ok(built && built.password === 'firm-secret-pw-123' && built.username === 'FIRM_LOGIN' && built.authMode === 'query',
  'credsFromRow decrypts the password + shapes the provider credentials');
ok(firmCreds._internals.credsFromRow({ ...row, password_encrypted: Buffer.from('nope') }) === null,
  'credsFromRow returns null on an undecryptable password (→ pull falls back to our account, never fails)');
ok(firmCreds._internals.credsFromRow({ ...row, endpoint: '' }) === null,
  'credsFromRow returns null on an incomplete row');
ok(firmCreds._internals.credsFromRow(null) === null, 'credsFromRow(null) → null');

console.log(`\ntest-tpo-own-xactus-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
