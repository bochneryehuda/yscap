'use strict';

/**
 * THE STREAMING UPLOAD DOOR — a document goes from the browser to storage without PILOT
 * ever holding it in memory.
 *
 * WHY IT EXISTS (owner-directed 2026-08-21): *"we need to increase the limit of megabytes
 * that we can upload to unlimit it. We should be able to upload any kind of document …
 * Why is it 20 MB? The sky is the limit."*
 *
 * THE OLD CEILING WAS NOT ARBITRARY, AND RAISING IT ALONE WOULD HAVE TAKEN THE SITE DOWN.
 * Every upload door in this codebase takes `{filename, contentType, dataBase64}` as JSON,
 * which express buffers and parses whole. MEASURED on Node 22, not assumed: the wire body,
 * the string express makes of it, the string JSON.parse makes of the base64 value and the
 * decoded Buffer together peak at about FIVE TIMES the file —
 *
 *     25 MB file → 168 MB peak · 50 MB → 294 MB · 100 MB → 410 MB
 *
 * — and the web service is a Render `starter` instance with 512 MB total, most of a
 * quarter of which the app already occupies. A 100 MB base64 upload is an out-of-memory
 * kill of the whole site, for everybody, not a failed upload for one person. So "the sky
 * is the limit" needed a different TRANSPORT, not a bigger number.
 *
 * WHAT THIS DOES INSTEAD. The bytes arrive as the raw request body and are streamed
 * straight to a temp file, hashed on the way past, then handed to storage as a PATH
 * (`storage.saveFile`) — a rename on the local disk, an 8 MB-at-a-time multipart upload on
 * R2. Peak memory is a few megabytes whatever the size of the document, so the ceiling
 * stops being about RAM at all.
 *
 * WHAT IS STILL BOUNDED, AND HONESTLY SO. `cfg.maxUploadMb` remains — not because of
 * memory now, but because an unbounded body from an authenticated-but-mistaken client (a
 * runaway script, a wrong file) would fill the disk or the bucket, and because a request
 * that will be refused should be refused EARLY rather than after ten minutes of upload.
 * It is a number the owner can raise to anything, and nothing about the transport changes
 * when they do.
 *
 * THE METADATA RIDES IN HEADERS, not in the body — the body IS the document. `x-upload-meta`
 * is base64 JSON so a filename with a comma, a quotation mark or a non-Latin character
 * cannot break the header (a raw header value is latin-1 on the wire and would corrupt
 * silently, which is the same class of bug as the base64 data: URL this codebase already
 * carries a chokepoint for).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const storage = require('./storage');

const MB = 1024 * 1024;

/** The ceiling, in bytes. One definition; every door asks this rather than doing the arithmetic. */
function maxUploadBytes() {
  return Math.max(1, Number(cfg.maxUploadMb) || 20) * MB;
}

/**
 * What a LEGACY base64-in-JSON door may accept — a different question, deliberately, and
 * one that must never be answered with the document ceiling. See the note in `config.js`:
 * express buffers and parses such a body whole, at about five times the file. Every base64
 * door asks THIS, so raising the document ceiling can never widen the JSON parser's blast
 * radius, and a door added later inherits the right answer by asking the right function.
 */
function jsonUploadBytes() {
  return Math.max(1, Number(cfg.maxJsonUploadMb) || 25) * MB;
}

/**
 * WHAT A REFUSAL SAYS, in one place, in plain words — the owner's *"if Pilot is giving an
 * error and he can't upload something, he should tell exactly what the error is"*.
 * It names the file, what was wrong with it, and what the limit actually is, because
 * "upload failed" tells nobody anything they can act on.
 */
function tooLargeMessage(filename, bytes, maxBytes = maxUploadBytes()) {
  const mb = (n) => `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`;
  const name = filename ? `“${filename}” ` : 'That file ';
  return `${name}is ${mb(bytes)}, which is over the ${mb(maxBytes)} limit for a single upload. `
    + 'Split it into smaller files, or ask an admin to raise the limit.';
}

/** Read the metadata a streaming upload carries in its headers. Never throws. */
function metaFromHeaders(req) {
  const raw = String((req.headers || {})['x-upload-meta'] || '');
  if (!raw) return {};
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const o = JSON.parse(json);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) { return {}; }
}

/**
 * Stream this request's body into storage.
 *
 * Resolves `{ ref, provider, bytes, sha256, tmpPath }` — `tmpPath` is already gone; it is
 * reported only so a caller can say where the bytes were staged if something failed after.
 * Rejects with `err.status` set (413 too large, 400 empty) so a route answers the reason
 * rather than a generic 500.
 *
 * THE SIZE GUARD BITES DURING THE STREAM, not after it: a client that ignores the limit is
 * cut off the moment it crosses, so a hostile or broken caller cannot fill the disk by
 * sending forever. And the temp file is removed on EVERY path — success, refusal, or a
 * socket dying halfway — because a document is the most sensitive thing this system holds
 * and a stray copy in /tmp is exactly what must not survive.
 */
function receiveUpload(req, { maxBytes = maxUploadBytes(), filename = null } = {}) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-up-'));
    const tmpPath = path.join(tmpDir, 'body');
    const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* already gone */ }
      try { fs.rmdirSync(tmpDir); } catch (_) { /* already gone */ }
    };
    const fail = (msg, status) => {
      if (settled) return;
      settled = true;
      try { req.unpipe(out); } catch (_) {}
      out.destroy();
      cleanup();
      const e = new Error(msg);
      e.status = status;
      reject(e);
      // Stop the client sending the rest of a body we have already refused.
      try { req.destroy(); } catch (_) {}
    };

    req.on('error', (e) => fail(`the upload was interrupted (${(e && e.message) || 'connection lost'})`, 400));
    out.on('error', (e) => fail(`PILOT could not store the file (${(e && e.message) || 'write failed'})`, 500));

    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(tooLargeMessage(filename, bytes, maxBytes), 413); return; }
      hash.update(chunk);
    });

    req.pipe(out);

    out.on('close', async () => {
      if (settled) return;
      if (!bytes) { fail('the upload arrived empty — nothing was sent', 400); return; }
      settled = true;
      try {
        const saved = await storage.saveFile(tmpPath, { filename });
        resolve({ ...saved, bytes: saved.bytes != null ? saved.bytes : bytes, sha256: hash.digest('hex'), tmpPath });
      } catch (e) {
        const err = new Error(`PILOT could not store the file (${(e && e.message) || 'storage failed'})`);
        err.status = 500;
        reject(err);
      } finally { cleanup(); }
    });
  });
}

/**
 * EXPRESS MIDDLEWARE for a `/binary` sibling of an existing JSON upload door.
 *
 * It streams the body into storage, then hands the SAME handler the metadata it always
 * read from `req.body` — so the door's authorization, its condition lookups, its
 * visibility rules and its notifications are the ones that already exist and are already
 * tested. Two doors, one handler: the alternative is a second upload route per surface,
 * and a second route is a second place the visibility rule can drift.
 */
function binaryIntake(req, res, next) {
  const meta = metaFromHeaders(req);
  const filename = meta.filename || String((req.headers || {})['x-upload-filename'] || '') || null;
  receiveUpload(req, { filename })
    .then((stored) => {
      req.uploaded = stored;
      // The handler reads `req.body` exactly as it does on the JSON door. `dataBase64` is
      // set to a marker rather than left absent because every one of those handlers
      // refuses a body without it — and the marker is never decoded: `takeUpload` sees
      // `req.uploaded` first and returns the bytes already in storage.
      req.body = Object.assign({}, meta, { dataBase64: '__streamed__' });
      next();
    })
    .catch((e) => {
      res.status(e && e.status ? e.status : 500)
        .json({ error: (e && e.message) || 'the upload failed' });
    });
}

/**
 * THE ONE PLACE A DOOR TURNS A REQUEST INTO STORED BYTES — whichever way they arrived.
 *
 * Streamed: already in storage, nothing in memory, `buf` is null.
 * base64: decoded through the strict chokepoint (`upload-bytes`), size-checked against the
 * JSON ceiling with the shared wording, then stored.
 *
 * Throws with `err.status` set, so a route answers the real reason — the owner's
 * *"if Pilot is giving an error and he can't upload something, he should tell exactly
 * what the error is"*.
 */
async function takeUpload(req, body) {
  if (req && req.uploaded) return req.uploaded;
  const b = body || {};
  const { decodeUploadBase64 } = require('./upload-bytes');
  const max = jsonUploadBytes();
  const { buf, sha256 } = decodeUploadBase64(b.dataBase64);
  if (buf.length > max) {
    const e = new Error(tooLargeMessage(b.filename, buf.length, max));
    e.status = 413;
    throw e;
  }
  const saved = await storage.save(buf, { filename: b.filename });
  return { ...saved, bytes: buf.length, sha256, buf };
}

/**
 * THE BYTES, WHEN A DOOR GENUINELY NEEDS THEM IN MEMORY.
 *
 * A JSON upload already has them. A STREAMED one deliberately does not — that is the
 * whole point — so this reads them back from storage, and only when the file is small
 * enough that doing so is free of consequence. `limitBytes` is the caller's own answer to
 * "how big may this get before holding it costs more than the feature is worth" (the mail
 * providers' ~3 MB inline-attachment ceiling, say).
 *
 * Returns null rather than throwing: every consumer of this is an EXTRA — an emailed copy,
 * a research read — and none of them may turn a stored document into a failed upload.
 */
async function readUploadBytes(up, limitBytes = 0) {
  if (!up) return null;
  /* THE LIMIT IS CHECKED BEFORE THE IN-MEMORY SHORTCUT, deliberately. A JSON upload
     already holds its bytes, so returning them without consulting the limit would make
     the JSON door behave DIFFERENTLY from the streaming one — the borrower-upload email,
     for instance, attaches a copy only up to ~3 MB, and shortcutting past that would
     start attaching 20 MB files on one door and not the other. */
  if (limitBytes && Number(up.bytes) > limitBytes) return null;
  if (up.buf) return up.buf;
  try { return await storage.read(up.ref); } catch (_) { return null; }
}

module.exports = {
  receiveUpload, metaFromHeaders, maxUploadBytes, jsonUploadBytes, tooLargeMessage,
  binaryIntake, takeUpload, readUploadBytes, MB,
};
