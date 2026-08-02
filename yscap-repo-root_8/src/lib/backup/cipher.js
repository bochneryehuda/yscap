'use strict';
/**
 * Backup envelope encryption — AES-256-GCM over a stream, with a self-describing header.
 *
 * WHY THIS EXISTS: a database dump of this system is the single most sensitive artifact the
 * company produces — every borrower, every SSN (already column-encrypted, but also every name,
 * address, bank statement reference and loan term in the clear), sitting as one file in a bucket
 * that lives OUTSIDE our infrastructure. It is encrypted on THIS machine, before a single byte
 * leaves the process, so the storage vendor (and anyone who ever gets the bucket credentials)
 * holds ciphertext and nothing else. The vendor never sees the key; the key is never written to
 * the vault.
 *
 * NO NEW DEPENDENCIES — Node's built-in `crypto` only (same rule as src/lib/storage-s3.js).
 *
 * CONTAINER FORMAT (".ysbak"), all integers big-endian:
 *   magic       8 bytes   "YSCAPBAK"
 *   version     1 byte    0x01
 *   headerLen   4 bytes   length of the JSON header
 *   header      N bytes   UTF-8 JSON: { v, alg, kdf, salt, iv, keyId, createdAt, name, plainSha? }
 *   ciphertext  … bytes   AES-256-GCM
 *   authTag    16 bytes   GCM tag, at the very END
 *
 * The header (magic + version + headerLen + header bytes) is fed to the cipher as ADDITIONAL
 * AUTHENTICATED DATA, so a tampered header fails the tag check exactly like tampered ciphertext.
 * The tag lives at the end, which means TRUNCATION IS DETECTED: half a backup file does not
 * decrypt to half a dump, it fails outright. That is deliberate — a silently truncated restore is
 * worse than a failed one.
 *
 * KEY HANDLING: the operator supplies BACKUP_ENCRYPTION_KEY once (see docs). It is used as HKDF
 * input keying material, never as the AES key directly, and a FRESH random 32-byte salt per
 * backup derives a fresh data key — so the same master key encrypting a thousand nightly dumps
 * never reuses a key/IV pair. `keyId` is a non-reversible fingerprint of the master key, stored in
 * the clear, so an operator holding two keys can tell which one opens a given file without trying
 * both.
 */
const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('YSCAPBAK', 'utf8');
const FORMAT_VERSION = 1;
const TAG_BYTES = 16;
const IV_BYTES = 12;          // 96-bit nonce — the GCM standard
const SALT_BYTES = 32;
const KEY_BYTES = 32;         // AES-256
const HKDF_INFO = 'yscap-backup-v1';

/** The smallest key material we will accept. Below this the container is only as strong as the
 *  passphrase, and a weak backup key is indistinguishable from no encryption at all. */
const MIN_KEY_CHARS = 32;

/**
 * PURE — turn whatever the operator put in the env var into key material.
 *
 * Accepts three shapes so a correctly-generated key is never rejected on a formatting technicality:
 *   · 64 hex characters              → those 32 bytes
 *   · base64/base64url of >= 32 bytes → those bytes
 *   · anything else                  → the raw UTF-8 bytes of the passphrase (>= 32 characters)
 * In every case the bytes are HKDF INPUT, not the AES key, so a longer or shorter input is fine —
 * what matters is entropy, which is why a short value is refused outright rather than stretched.
 */
function keyMaterial(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('BACKUP_ENCRYPTION_KEY is not set — refusing to write an unencrypted backup');
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length >= KEY_BYTES) return b;
  }
  if (s.length < MIN_KEY_CHARS) {
    throw new Error(
      `BACKUP_ENCRYPTION_KEY is too short (${s.length} characters, need at least ${MIN_KEY_CHARS}). ` +
      'Generate one with:  openssl rand -base64 32');
  }
  return Buffer.from(s, 'utf8');
}

/** PURE — a stable, non-reversible fingerprint of the key material (first 16 hex of a salted hash). */
function keyFingerprint(ikm) {
  return crypto.createHash('sha256').update('yscap-backup-keyid').update(ikm).digest('hex').slice(0, 16);
}

/** PURE — HKDF-SHA256 to the 32-byte AES key. Node's hkdfSync returns an ArrayBuffer. */
function deriveKey(ikm, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(HKDF_INFO, 'utf8'), KEY_BYTES));
}

/** PURE — serialize the header block (magic + version + length + JSON). Also the AAD. */
function buildHeaderBlock(headerObj) {
  const json = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), len, json]);
}

/**
 * PURE — parse a header block off the front of a buffer.
 * Returns { header, headerBlock, rest } or throws a message an operator can act on.
 */
function parseHeaderBlock(buf) {
  if (buf.length < MAGIC.length + 5) throw new Error('backup file is truncated (no header)');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a YS Capital backup file (bad magic) — is this the right object?');
  }
  const version = buf[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new Error(`backup format version ${version} is newer than this code understands (${FORMAT_VERSION})`);
  }
  const jsonLen = buf.readUInt32BE(MAGIC.length + 1);
  const start = MAGIC.length + 5;
  if (buf.length < start + jsonLen) throw new Error('backup file is truncated (header cut short)');
  const headerBlock = buf.subarray(0, start + jsonLen);
  let header;
  try {
    header = JSON.parse(buf.subarray(start, start + jsonLen).toString('utf8'));
  } catch (e) {
    throw new Error('backup header is not readable JSON — the file is corrupt');
  }
  return { header, headerBlock, rest: buf.subarray(start + jsonLen) };
}

/**
 * Build an ENCRYPTING transform stream. Pipe plaintext in (e.g. pg_dump's stdout), get a complete
 * .ysbak container out. The header is emitted first, the tag last.
 *
 * Returns the stream, with `.header` (the plaintext header object) readable immediately and
 * `.plainBytes` / `.cipherBytes` / `.plainSha256` / `.cipherSha256` populated by the time it ends —
 * everything the manifest needs to prove later that what came back is byte-identical.
 */
function createEncryptStream(rawKey, { name = 'backup', createdAt = new Date().toISOString(), meta = null } = {}) {
  const ikm = keyMaterial(rawKey);
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(ikm, salt);

  const header = {
    v: FORMAT_VERSION,
    alg: 'AES-256-GCM',
    kdf: 'HKDF-SHA256',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    keyId: keyFingerprint(ikm),
    createdAt,
    name,
  };
  if (meta) header.meta = meta;
  const headerBlock = buildHeaderBlock(header);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(headerBlock);

  const plainHash = crypto.createHash('sha256');
  const cipherHash = crypto.createHash('sha256');
  let plainBytes = 0, cipherBytes = 0;
  let wroteHeader = false;

  const push = (out, buf) => {
    if (!buf || !buf.length) return;
    cipherBytes += buf.length;
    cipherHash.update(buf);
    out.push(buf);
  };

  const stream = new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (!wroteHeader) { wroteHeader = true; push(this, headerBlock); }
        plainBytes += chunk.length;
        plainHash.update(chunk);
        push(this, cipher.update(chunk));
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        // An EMPTY dump still produces a valid (header + tag) container rather than a zero-byte
        // file — the difference between "the backup ran and the database was empty" and "the
        // backup produced nothing" must stay visible.
        if (!wroteHeader) { wroteHeader = true; push(this, headerBlock); }
        push(this, cipher.final());
        push(this, cipher.getAuthTag());
        stream.plainSha256 = plainHash.digest('hex');
        stream.cipherSha256 = cipherHash.digest('hex');
        stream.plainBytes = plainBytes;
        stream.cipherBytes = cipherBytes;
        cb();
      } catch (e) { cb(e); }
    },
  });

  stream.header = header;
  stream.keyId = header.keyId;
  return stream;
}

/**
 * Build a DECRYPTING transform stream. Pipe a .ysbak container in, get the original bytes out.
 *
 * The GCM tag is the last 16 bytes, so the stream keeps a 16-byte tail in hand at all times and
 * only treats it as the tag once the input actually ends. A wrong key, a flipped bit anywhere, a
 * doctored header or a truncated file all surface as one loud error at the end — never as partial
 * output that looks like a successful restore.
 *
 * `onHeader(header)` fires as soon as the header is parsed (used to check keyId / report progress).
 */
function createDecryptStream(rawKey, { onHeader = null } = {}) {
  const ikm = keyMaterial(rawKey);
  let pending = Buffer.alloc(0);      // bytes not yet consumed (header phase) / the held-back tail
  let decipher = null;
  const plainHash = crypto.createHash('sha256');
  let plainBytes = 0;

  const stream = new Transform({
    transform(chunk, _enc, cb) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

        if (!decipher) {
          // Check the MAGIC the moment enough bytes exist. Doing this BEFORE waiting for the rest
          // of the header matters: a wrong file (a text file, an HTML error page saved as a
          // backup) has a garbage length field, so waiting first would report it as "truncated"
          // instead of "this is not a backup" — two very different things to be told at 2am.
          if (pending.length >= MAGIC.length && !pending.subarray(0, MAGIC.length).equals(MAGIC)) {
            throw new Error('not a YS Capital backup file (bad magic) — is this the right object?');
          }
          // Wait until the whole header block has arrived before parsing it.
          if (pending.length < MAGIC.length + 5) { cb(); return; }
          const jsonLen = pending.readUInt32BE(MAGIC.length + 1);
          if (pending.length < MAGIC.length + 5 + jsonLen) { cb(); return; }
          const { header, headerBlock, rest } = parseHeaderBlock(pending);
          const fp = keyFingerprint(ikm);
          if (header.keyId && header.keyId !== fp) {
            throw new Error(
              `this backup was encrypted with a DIFFERENT key (file wants keyId ${header.keyId}, ` +
              `the key supplied is ${fp}). Restore needs the key that was live when it was written.`);
          }
          decipher = crypto.createDecipheriv(
            'aes-256-gcm', deriveKey(ikm, Buffer.from(header.salt, 'base64')), Buffer.from(header.iv, 'base64'));
          decipher.setAAD(headerBlock);
          stream.header = header;
          if (onHeader) onHeader(header);
          pending = rest;
        }

        // Always hold back TAG_BYTES: until the input ends we cannot know whether these are
        // ciphertext or the tag.
        if (pending.length > TAG_BYTES) {
          const body = pending.subarray(0, pending.length - TAG_BYTES);
          pending = Buffer.from(pending.subarray(pending.length - TAG_BYTES));
          const out = decipher.update(body);
          if (out.length) { plainBytes += out.length; plainHash.update(out); this.push(out); }
        }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (!decipher) throw new Error('backup file ended before its header was complete');
        if (pending.length !== TAG_BYTES) {
          throw new Error(`backup file is truncated — expected a ${TAG_BYTES}-byte authentication tag, got ${pending.length}`);
        }
        decipher.setAuthTag(pending);
        const out = decipher.final();          // throws if the tag does not verify
        if (out.length) { plainBytes += out.length; plainHash.update(out); this.push(out); }
        stream.plainSha256 = plainHash.digest('hex');
        stream.plainBytes = plainBytes;
        cb();
      } catch (e) {
        cb(new Error(
          'BACKUP FAILED VERIFICATION: ' + e.message +
          ' — the file was altered, corrupted or truncated, or the encryption key is wrong. Do NOT restore from it.'));
      }
    },
  });

  return stream;
}

/** Convenience for small payloads (the manifest): encrypt/decrypt a Buffer in one call. */
function encryptBuffer(rawKey, buf, opts) {
  return new Promise((resolve, reject) => {
    const enc = createEncryptStream(rawKey, opts);
    const chunks = [];
    enc.on('data', (c) => chunks.push(c));
    enc.on('error', reject);
    enc.on('end', () => resolve(Buffer.concat(chunks)));
    enc.end(buf);
    enc.resume();
  });
}
function decryptBuffer(rawKey, buf, opts) {
  return new Promise((resolve, reject) => {
    const dec = createDecryptStream(rawKey, opts);
    const chunks = [];
    dec.on('data', (c) => chunks.push(c));
    dec.on('error', reject);
    dec.on('end', () => resolve(Buffer.concat(chunks)));
    dec.end(buf);
    dec.resume();
  });
}

module.exports = {
  createEncryptStream,
  createDecryptStream,
  encryptBuffer,
  decryptBuffer,
  keyFingerprint: (raw) => keyFingerprint(keyMaterial(raw)),
  _internals: {
    MAGIC, FORMAT_VERSION, TAG_BYTES, MIN_KEY_CHARS,
    keyMaterial, deriveKey, buildHeaderBlock, parseHeaderBlock,
  },
};
