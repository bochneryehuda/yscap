'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Phase 3b document byte loader
 * (src/pipeline/document-bytes.js). Pure: exercises the never-throws GUARD paths with a fake db,
 * plus the happy path with a fake db whose row points at a stubbed storage read.
 *
 * Proves: no db / no documentId / missing row / missing storage_ref / empty bytes / a throwing db
 * ALL return null (never throw); a real row + readable bytes returns the normalized adapter request
 * ({ buffer, base64, mimeType, filename }).
 */
const R = require('path').resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// Stub the storage module BEFORE requiring document-bytes, so the loader reads our fake bytes
// instead of the disk. We control what storage.read returns per test via a mutable holder.
const storagePath = require.resolve(R + '/src/lib/storage');
let storageRead = async () => { throw new Error('storage not stubbed'); };
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { read: (ref) => storageRead(ref) } };

const DB = require(R + '/src/pipeline/document-bytes');

function dbReturning(rows) { return { query: async () => ({ rows }) }; }

(async function main() {
  // ---- GUARDS: every one returns null, never throws ----
  ok((await DB.loadDocumentBytes(null, 'd1')) === null, 'no db → null');
  ok((await DB.loadDocumentBytes({}, 'd1')) === null, 'db without .query → null');
  ok((await DB.loadDocumentBytes(dbReturning([]), null)) === null, 'no documentId → null');
  ok((await DB.loadDocumentBytes(dbReturning([]), 'd1')) === null, 'no matching row → null');
  ok((await DB.loadDocumentBytes(dbReturning([{ id: 'd1', storage_ref: null }]), 'd1')) === null, 'row with no storage_ref → null');

  const throwDb = { query: async () => { throw new Error('db down'); } };
  ok((await DB.loadDocumentBytes(throwDb, 'd1')) === null, 'a throwing db is swallowed → null (never throws)');

  // storage.read throws → swallowed → null
  storageRead = async () => { throw new Error('ENOENT'); };
  ok((await DB.loadDocumentBytes(dbReturning([{ id: 'd1', storage_ref: 'ab/x.pdf', content_type: 'application/pdf' }]), 'd1')) === null, 'storage.read throwing is swallowed → null');

  // storage.read returns empty buffer → null (nothing to read)
  storageRead = async () => Buffer.alloc(0);
  ok((await DB.loadDocumentBytes(dbReturning([{ id: 'd1', storage_ref: 'ab/x.pdf', content_type: 'application/pdf' }]), 'd1')) === null, 'empty bytes → null');

  // ---- HAPPY PATH: a real row + readable bytes → normalized request ----
  storageRead = async () => Buffer.from('%PDF-1.4 hello');
  const got = await DB.loadDocumentBytes(dbReturning([{ id: 'd1', filename: 'stmt.pdf', content_type: 'application/pdf', storage_ref: 'ab/x.pdf' }]), 'd1');
  ok(got && Buffer.isBuffer(got.buffer) && got.buffer.length > 0, 'happy: returns a buffer');
  ok(got && got.base64 === Buffer.from('%PDF-1.4 hello').toString('base64'), 'happy: base64 matches the bytes');
  ok(got && got.mimeType === 'application/pdf', 'happy: mimeType from content_type');
  ok(got && got.filename === 'stmt.pdf', 'happy: filename carried through');
  ok(got && got.bytes === Buffer.from('%PDF-1.4 hello').length, 'happy: byte count reported');

  // content_type missing → defaults to octet-stream
  const got2 = await DB.loadDocumentBytes(dbReturning([{ id: 'd2', filename: null, content_type: null, storage_ref: 'ab/y' }]), 'd2');
  ok(got2 && got2.mimeType === 'application/octet-stream', 'missing content_type → application/octet-stream default');

  console.log(`test-document-bytes-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
