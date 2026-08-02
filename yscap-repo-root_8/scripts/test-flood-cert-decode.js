'use strict';
/**
 * The flood certificate must actually get FILED — the return-shape trap (no DB).
 *
 * THE BUG THIS PINS (owner-reported 2026-08-02: "The certificate came back but
 * could not be read as a PDF. Upload it manually instead."): Xactus DID return the
 * certificate — the desk's `no_pdf` check passed — but the PDF was never attached.
 * `upload-bytes.decodeUploadBase64` returns **{ buf, sha256 }**, NOT a Buffer, and
 * both flood-desk call sites did:
 *
 *     const buf = decodePdf(pdfBase64);
 *     if (buf && buf.length) documentId = await attachCertificate(order, buf);
 *
 * `{buf,sha256}.length` is `undefined` → falsy → attachCertificate was NEVER called
 * on a perfectly good PDF, and the desk reported an undiagnosable "could not be read
 * as a PDF". The bare `catch (_) { return null }` inside decodePdf then made a real
 * base64 rejection produce the SAME message, so the two causes were indistinguishable.
 *
 * Three layers here:
 *   1. the library CONTRACT — the wrapper's `.length` is undefined (why it was silent),
 *   2. FUNCTIONAL — completeOrder + fetchCertificate really file the certificate
 *      (db/storage/client stubbed; each assertion fails on the pre-fix code),
 *   3. a repo-wide SOURCE guard — every decodeUploadBase64 call site unwraps, so the
 *      class cannot come back in a future upload path.
 *
 * Runs in `npm test`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

let n = 0;
function ok(msg, cond) { n++; assert.ok(cond, msg); }

const SRC = path.join(__dirname, '..', 'src');
const U = require('../src/lib/upload-bytes');

// A minimal but REAL pdf: decodeUploadBase64 requires non-empty bytes, and the
// vendor's extractor only hands back payloads whose base64 starts "JVBER" (= "%PDF").
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');
const PDF_B64 = PDF.toString('base64');
const PDF_SHA = crypto.createHash('sha256').update(PDF).digest('hex');

const ORDER = { id: 'ord-1', application_id: 'app-1', order_id: 'CERT-9', checklist_item_id: 'item-1', ordered_by: 'staff-1' };

// flood-desk needs pg (unavailable here), so `../db`, storage, the conditions engine
// and the Xactus client are stubbed at the loader. Everything else is the real code.
//
// The hook must stay installed for the whole CALL, not just the require: the desk
// pulls storage / checklist-evidence / sharepoint-backup / the conditions engine
// LAZILY inside its functions, so restoring too early quietly runs the real storage
// (which then writes actual files and makes the stub's counters read zero).
async function withDesk(opts, body) {
  const { statusQueryPdf = null, existingDoc = null } = opts || {};
  const calls = { inserts: [], saved: [], evidence: [], sharepointKicks: 0, statusQueries: 0, completed: 0 };
  const dbStub = {
    async query(sql) {
      if (/INSERT INTO documents/i.test(sql)) { calls.inserts.push(sql); return { rows: [{ id: 'doc-1' }] }; }
      if (/UPDATE encompass_flood_orders[\s\S]*status='completed'/i.test(sql)) { calls.completed++; return { rows: [] }; }
      if (/SELECT id FROM documents/i.test(sql)) return { rows: existingDoc ? [{ id: existingDoc }] : [] };
      if (/SELECT borrower_id FROM applications/i.test(sql)) return { rows: [{ borrower_id: 'bor-1' }] };
      if (/SELECT 1 FROM documents/i.test(sql)) return { rows: [] };          // certificateOnFile → not filed yet
      if (/SELECT \*[\s\S]*FROM encompass_flood_orders/i.test(sql)) return { rows: [{ ...ORDER }] };
      return { rows: [] };
    },
  };
  const stubs = {
    '../db': dbStub,
    './flood': {
      enabled: () => true,
      configured: () => true,
      productIdentifier: () => 'life',
      async getOrderStatus() { calls.statusQueries++; return statusQueryPdf ? { pdfBase64: statusQueryPdf } : {}; },
    },
    '../lib/storage': { async save(buf, o) { calls.saved.push({ buf, filename: o && o.filename }); return { ref: 'ref-1', provider: 'local' }; } },
    '../lib/checklist-evidence': { async reopenConditionEvidence(_db, itemId, st) { calls.evidence.push([itemId, st]); } },
    '../lib/sharepoint-backup': { kick() { calls.sharepointKicks++; } },
    '../lib/conditions/engine': { async evaluateApplication() {} },
  };
  const deskPath = require.resolve('../src/xactus/flood-desk');
  delete require.cache[deskPath];
  const realLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && /flood-desk\.js$/.test(parent.filename) && stubs[request]) return stubs[request];
    return realLoad.apply(this, arguments);
  };
  try { return await body(require('../src/xactus/flood-desk'), calls); }
  finally { Module._load = realLoad; delete require.cache[deskPath]; }
}

async function main() {
  // ── 1. The library contract — WHY this was silent ──────────────────────────
  {
    const out = U.decodeUploadBase64(PDF_B64);
    ok('decodeUploadBase64 returns a { buf, sha256 } wrapper, not a Buffer', !Buffer.isBuffer(out) && Buffer.isBuffer(out.buf));
    ok('the wrapper carries the sha256 with the bytes', out.sha256 === PDF_SHA);
    // THE TRAP: the wrapper answers `undefined` to .length, so a `buf && buf.length`
    // guard silently reads a good file as "no bytes" instead of throwing.
    ok('the wrapper has NO .length (the silent-failure trap)', out.length === undefined);
    ok('the real bytes are intact', out.buf.equals(PDF));
    ok('base64 starting JVBER is what the vendor sends', /^JVBER/.test(PDF_B64));
  }

  // ── 2a. completeOrder — the certificate rides back inside the order response ─
  await withDesk({}, async (desk, calls) => {
    await desk.completeOrder({ ...ORDER }, { pdfBase64: PDF_B64, sfha: false, floodZone: 'X', statusText: 'ok' });

    ok('completeOrder FILES the certificate (the reported bug: it did not)', calls.inserts.length === 1);
    ok('the stored bytes are the real PDF', calls.saved.length === 1 && calls.saved[0].buf.equals(PDF));
    ok('a real Buffer reaches storage, never the { buf, sha256 } wrapper', Buffer.isBuffer(calls.saved[0].buf));
    ok('the filename carries the vendor reference', /CERT-9/.test(calls.saved[0].filename));
    // The mirror's integrity audit verifies against documents.sha256 (db/115); a
    // NULL hash there leaves the flood certificate unverifiable in SharePoint.
    ok('sha256 is in the INSERT column list', /\bsha256\b/.test(calls.inserts[0]));
    ok('the condition is moved to received', calls.evidence.length === 1 && calls.evidence[0][1] === 'received');
    ok('the SharePoint mirror is kicked', calls.sharepointKicks === 1);
    ok('no needless StatusQuery when the PDF already came back', calls.statusQueries === 0);
  });

  // ── 2b. No PDF in the order response → StatusQuery retrieval fills it ───────
  await withDesk({ statusQueryPdf: PDF_B64 }, async (desk, calls) => {
    await desk.completeOrder({ ...ORDER }, { pdfBase64: null, sfha: false, floodZone: 'X' });
    ok('a missing PDF is retrieved with a StatusQuery', calls.statusQueries === 1);
    ok('the retrieved certificate is filed too', calls.inserts.length === 1 && calls.saved[0].buf.equals(PDF));
  });

  // ── 2c. fetchCertificate — the owner's "Get the certificate PDF" action ─────
  await withDesk({ statusQueryPdf: PDF_B64 }, async (desk, calls) => {
    const r = await desk.fetchCertificate({ appId: 'app-1', actorId: 'staff-1' });
    ok('fetchCertificate SUCCEEDS on a good certificate (the reported failure)', r.ok === true);
    ok('it reports the filed document', r.documentId === 'doc-1');
    ok('it files exactly one document', calls.inserts.length === 1);
    ok('it no longer says "could not be read as a PDF"', !/could not be read as a PDF/.test(r.message || ''));
  });

  // ── 2d. A GENUINELY bad payload names its reason instead of the old catch-all ─
  await withDesk({ statusQueryPdf: 'not base64 at all !!!' }, async (desk) => {
    const r = await desk.fetchCertificate({ appId: 'app-1', actorId: 'staff-1' });
    ok('a truly undecodable certificate still fails', r.ok === false && r.error === 'file_failed');
    ok('the REAL reason is surfaced, not swallowed', /readable PDF/i.test(r.message || ''));
    ok('in plain words — no developer jargon reaches staff', !/base64|data:\s*URL/i.test(r.message || ''));
    ok('and it still tells staff what to do', /upload it manually/i.test(r.message || ''));
  });

  // ── 2d2. A failed PDF must NEVER lose the determination ────────────────────
  // decodePdf now THROWS where it used to return null, so the guard that the flood
  // zone still gets recorded (and the conditions re-run) has to be explicit: the
  // zone is the answer the file needs; the certificate is the paperwork.
  await withDesk({}, async (desk, calls) => {
    await desk.completeOrder({ ...ORDER }, { pdfBase64: 'not base64 at all !!!', sfha: true, floodZone: 'AE' });
    ok('a bad certificate does not stop the order completing', calls.completed === 1);
    ok('and nothing half-filed is written', calls.inserts.length === 0);
  });

  // ── 2e. Idempotent: a certificate already on file is reused, never duplicated ─
  await withDesk({ existingDoc: 'doc-existing' }, async (desk, calls) => {
    await desk.completeOrder({ ...ORDER }, { pdfBase64: PDF_B64, sfha: false, floodZone: 'X' });
    ok('an already-filed certificate is not filed twice', calls.inserts.length === 0);
  });

  // ── 3. Repo-wide guard: every call site UNWRAPS the { buf, sha256 } return ──
  // The root is a shared helper whose return shape is easy to misread, so the guard
  // belongs at the class level — not only on the two lines that were reported.
  {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && p.endsWith('.js')) files.push(p);
      }
    })(SRC);

    // A call is safe when the line destructures `{ buf ... } = ...decodeUploadBase64(`
    // or reads `.buf` off it. Import lines and comments are not calls.
    const DESTRUCTURED = /\{[^}]*\bbuf\b[^}]*\}\s*=\s*[^=]*decodeUploadBase64\s*\(/;
    const DOT_BUF = /decodeUploadBase64\s*\(.*\)\s*\.\s*buf\b/;
    const IMPORT = /\{[^}]*decodeUploadBase64[^}]*\}\s*=\s*require\(/;
    const offenders = [];
    let scanned = 0;

    for (const f of files) {
      if (f.endsWith(path.join('lib', 'upload-bytes.js'))) continue;   // the definition itself
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!/decodeUploadBase64\s*\(/.test(line)) return;
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;   // prose
        if (IMPORT.test(line)) return;
        scanned++;
        if (!DESTRUCTURED.test(line) && !DOT_BUF.test(line)) offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${t.slice(0, 110)}`);
      });
    }

    ok('the guard actually found the call sites (it would pass vacuously otherwise)', scanned >= 12);
    ok(`every decodeUploadBase64 call must unwrap { buf } — treating it as a Buffer silently drops the file:\n  ${offenders.join('\n  ')}\n`,
      offenders.length === 0);
  }

  // ── 4. Both flood desks stamp the certificate's content hash ───────────────
  for (const rel of ['xactus/flood-desk.js', 'encompass/flood-desk.js']) {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    ok(`${rel} stamps documents.sha256 on the flood certificate`, /INSERT INTO documents[\s\S]{0,700}?\bsha256\b/.test(src));
  }

  console.log(`test-flood-cert-decode: ${n} assertions passed`);
}

main().catch((e) => { console.error(e && e.message || e); process.exit(1); });
