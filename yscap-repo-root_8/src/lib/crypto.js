/**
 * Zero-dependency security primitives on Node's built-in crypto.
 *   - Passwords: scrypt (memory-hard) + random salt, timing-safe verify.
 *   - JWT: compact HS256 sign/verify (access + refresh).
 *   - TOTP: RFC 6238 (SHA1, 6 digits, 30s) for MFA — compatible with
 *           Google Authenticator / Authy / 1Password.
 *   - SSN: AES-256-GCM encrypt/decrypt for at-rest PII.
 * No argon2/otplib/jsonwebtoken => no native build => clean Render deploys.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const cfg = require('../config');

// ---------- passwords (scrypt) ----------
// scrypt is memory-hard and CPU-heavy (~100-300ms on a shared-CPU instance).
// We use the ASYNC form so the hashing runs on libuv's threadpool instead of
// blocking Node's single event loop. Blocking it here was a real outage engine:
// a burst of logins would freeze the whole process — health checks included —
// long enough for the platform to declare the instance unhealthy and restart
// it, surfacing to users as a wall of 502s around sign-in.
const scryptAsync = promisify(crypto.scrypt);
// 16 MiB is the working set for N=16384,r=8; give the threadpool headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptAsync(String(pw), salt, 32, { N: 16384, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${dk.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [, N, r, p, saltB64, hashB64] = stored.split('$');
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await scryptAsync(String(pw), salt, expected.length,
      { N: +N, r: +r, p: +p, maxmem: SCRYPT_MAXMEM });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

// ---------- JWT (HS256) ----------
const b64u  = (buf) => Buffer.from(buf).toString('base64url');
const b64uJSON = (o) => b64u(JSON.stringify(o));
function signJwt(payload, ttlSec = cfg.accessTtlSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const data = `${b64uJSON(header)}.${b64uJSON(body)}`;
  const sig = crypto.createHmac('sha256', cfg.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyJwt(token) {
  try {
    const [h, p, sig] = String(token).split('.');
    if (!h || !p || !sig) return null;
    const expected = crypto.createHmac('sha256', cfg.jwtSecret).update(`${h}.${p}`).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (body.exp && Math.floor(Date.now() / 1000) > body.exp) return null;
    return body;
  } catch { return null; }
}

// ---------- TOTP (RFC 6238) ----------
function newTotpSecret() {
  // base32 (RFC 4648) of 20 random bytes
  const bytes = crypto.randomBytes(20);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', out = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function _b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const v = A.indexOf(c); if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function _totpAt(secret, counter) {
  const key = _b32decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return (code % 1e6).toString().padStart(6, '0');
}
function verifyTotp(secret, code, window = 1) {
  if (!secret || !code) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (_totpAt(secret, step + w) === String(code).padStart(6, '0')) return true;
  }
  return false;
}
function totpUri(secret, label, issuer = 'YS Capital') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`
       + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6&algorithm=SHA1`;
}

// ---------- SSN at rest (AES-256-GCM) ----------
function _key() { return crypto.createHash('sha256').update(cfg.ssnKey).digest(); }
function encryptSSN(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]); // stored in bytea
}
function decryptSSN(buf) {
  if (!buf) return null;
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const iv = b.subarray(0, 12), tag = b.subarray(12, 28), enc = b.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', _key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---------- generic at-rest secret (AES-256-GCM) ----------
// A third-party vendor login (Xactus operator password) is not an SSN, but it
// is the same class of at-rest secret and rides the SAME master key + GCM frame
// as encryptSSN (iv|tag|ciphertext bytea). Named separately so intent is clear
// at every call site (a credential, not PII) and so a future key-separation is a
// one-line change here. Throws on a decrypt whose auth tag fails (tamper/wrong
// key) — a credential that silently decrypts to garbage would authenticate as a
// blank password, so callers must see the failure, not a null.
function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]); // stored in bytea
}
function decryptSecret(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), enc = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', _key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); // throws on bad tag
}

// #91/#92 — the SINGLE chokepoint for persisting an SSN. Normalizes to the 9
// digits and returns { encrypted, last4, digits } — or NULL when the value isn't a
// full 9-digit SSN. Every write path should go through this instead of hand-rolling
// encryptSSN(raw) + slice(-4): the ad-hoc form stored an encrypted dash-formatted
// string and a wrong/blank last4 on a partial or non-numeric value (audit #234).
// Encrypting the CLEAN digits also makes the ciphertext canonical regardless of the
// input's formatting. (fields.js has no requires, so this can't create a cycle.)
function ssnForStorage(raw) {
  const digits = require('./fields').sanitizeSsnDigits(raw);
  if (!digits) return null;
  return { encrypted: encryptSSN(digits), last4: digits.slice(-4), digits };
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

// ---------- MFA backup (recovery) codes ----------
// One-time codes a user saves when they enable 2FA, so a lost authenticator app
// doesn't lock them out. Format xxxxx-xxxxx (easy to read/type). Stored HASHED;
// the plaintext is returned exactly once. `normalizeBackupCode` makes entry
// forgiving (case + separators) so the hash matches what the user types back.
const normalizeBackupCode = (c) => String(c == null ? '' : c).toLowerCase().replace(/[^a-z0-9]/g, '');
const hashBackupCode = (c) => sha256(normalizeBackupCode(c));
function newBackupCodes(n = 10) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    out.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return out;
}

// ---------- password strength (S1-02) ----------
// One shared rule applied at EVERY interactive password-set point (staff +
// borrower registration, self-change, admin reset, invite accept). Returns a
// plain-language reason the password is too weak, or null if it passes. Hardened
// for a regulated lender (HIPAA-aware / NYDFS 23 NYCRR 500): at least 10
// characters with a lowercase letter, an uppercase letter, a number, AND a
// symbol, and it rejects obviously guessable passwords (common weak passwords,
// a single repeated character, or a value that just echoes the user's own email
// / name). This only gates NEW password sets — it never re-checks existing
// stored passwords, so nobody is locked out of an account they already have.
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200; // guard scrypt against absurd inputs; well above any real password
// A small denylist of the most-guessed passwords + patterns. Not a substitute
// for a breach-corpus check, but it stops the worst offenders that still satisfy
// the composition rules (e.g. "Password1!"). Compared case-insensitively.
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password1!', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword1',
  'welcome1', 'welcome123', 'qwerty123', 'qwertyuiop', 'letmein1', 'admin123', 'iloveyou1',
  'abc123456', 'changeme1', '1q2w3e4r5t', 'q1w2e3r4t5', 'monkey123', 'football1', 'sunshine1',
]);
function passwordProblem(pw, hints) {
  const s = String(pw == null ? '' : pw);
  if (s.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (s.length > PASSWORD_MAX) return `Password must be ${PASSWORD_MAX} characters or fewer.`;
  if (!/[a-z]/.test(s)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(s)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(s)) return 'Password must include a number.';
  if (!/[^A-Za-z0-9]/.test(s)) return 'Password must include a symbol (e.g. ! ? @ # $ %).';
  const low = s.toLowerCase();
  if (WEAK_PASSWORDS.has(low)) return 'That password is too common — please choose a less guessable one.';
  if (/^(.)\1+$/.test(s)) return 'Password can’t be a single repeated character.';
  // Reject a password that merely echoes the user's identity (email local part,
  // first/last name). `hints` is optional (a string or array of strings); older
  // callers that don't pass it simply skip this check.
  const toks = (Array.isArray(hints) ? hints : [hints])
    .filter(Boolean)
    .flatMap(h => String(h).toLowerCase().split(/[@.\s]+/))
    .filter(t => t.length >= 4);
  if (toks.some(t => low.includes(t))) return 'Password can’t contain your name or email.';
  return null;
}

module.exports = {
  hashPassword, verifyPassword,
  signJwt, verifyJwt,
  newTotpSecret, verifyTotp, totpUri,
  encryptSSN, decryptSSN, ssnForStorage,
  encryptSecret, decryptSecret,
  sha256, randomToken,
  passwordProblem, PASSWORD_MIN, PASSWORD_MAX,
  newBackupCodes, hashBackupCode, normalizeBackupCode,
};
