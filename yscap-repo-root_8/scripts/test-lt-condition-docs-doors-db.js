'use strict';
/**
 * THE LONG-TERM CONDITION CENTER CAN TAKE A DOCUMENT — proven over REAL HTTP,
 * against a REAL Postgres, through the REAL doors.
 *
 * THE OWNER'S COMPLAINT, verbatim: *"You can't really upload stuff. You can't do
 * anything. Nothing actually works."* It was literally true — the router had
 * eighteen routes and not one accepted a document — so this suite is the proof
 * that the four new ones exist, that they are the SHARED short-term service and
 * not a second copy of it, and that a document belonging to somebody else is
 * unreachable through them.
 *
 * NAMED `test-lt-…` ON PURPOSE: the separation gate reads a suite's FILENAME as
 * its product identity (`isLtTest`, scripts/check-product-separation.js), and
 * this one names `lt_loans`, `documents.lt_loan_id` and requires
 * `src/longterm/**`. A suite proving a SHARED door from BOTH sides has to be
 * able to name the Long-Term table, and only a `scripts/test-lt-*.js` name may.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. THE WHOLE ROUND TRIP, in the order a person does it: upload → the document
 *     lands with `lt_loan_id` set and `application_id` NULL → the condition
 *     moves → sign-off is REFUSED while nobody has looked at the document →
 *     accept → download the bytes back → sign off. Then, on a second condition:
 *     reject → the condition re-opens to `issue` → delete → it re-opens again
 *     and the row is gone.
 *
 *  B. THE CROSS-OWNER CASES, WHICH ARE THE ONES THAT MATTER, asserted at the
 *     STATEMENT rather than at a 403 a later refactor could drop: with the
 *     owner named, a document on ANOTHER long-term loan and a document on an RTL
 *     APPLICATION each reach NOTHING — on the read, on the serve AND on the
 *     DELETE itself, which is the one where "we check" and "it cannot happen"
 *     are genuinely different. And a condition id from another loan cannot be
 *     uploaded to, because the shared door's own lookup scopes it in the
 *     statement.
 *
 *  C. THE SAME THREE, THROUGH THE DOORS, so the wiring is proven as well as the
 *     library: an RTL document id 404s and is STILL THERE afterwards; a
 *     long-term document on a file this person may not open 404s; a condition on
 *     another loan 404s and files nothing.
 *
 *  D. NO SHORT-TERM MACHINERY FIRES. A long-term document carries no
 *     `borrower_id` — that column is what the short-term borrower portal's own
 *     document list selects on, so stamping it would put a long-term file's
 *     documents on an RTL borrower's screen — and no ClickUp/portal hook runs.
 *
 * PROBES THE DATABASE FIRST. `ensureSchema` gives up on an unreachable database
 * WITHOUT throwing, so a suite that does not probe prints a confident ok against
 * nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-condition-docs-doors-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-condition-docs-doors-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// The doors really store bytes, so give them a disposable disk of their own.
process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-cond-doors-'));

const db = require('../src/db');
const C = require('../src/lib/crypto');
const { ownerOf } = require('../src/lib/condition-owner');
const condUpload = require('../src/lib/condition-docs/upload');
const condReview = require('../src/lib/condition-docs/review');
const condRemove = require('../src/lib/condition-docs/remove');
const condServe = require('../src/lib/condition-docs/serve');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltcd-${process.pid}-${Date.now()}`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const docRow = async (id) => (await db.query(
  `SELECT id, application_id, lt_loan_id, borrower_id, llc_id, checklist_item_id, filename,
          slot_label, visibility, review_status, is_current, rejection_reason,
          uploaded_by_kind, uploaded_by_id, size_bytes, storage_ref
     FROM documents WHERE id = $1`, [id])).rows[0];
const itemRow = async (id) => (await db.query(
  `SELECT status, signed_off_at, waived_at, notes FROM checklist_items WHERE id = $1`, [id])).rows[0];

(async () => {
  // THE PROBE. Not decoration: without it an unreachable database produces a
  // green run against nothing.
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();   // db/650 + db/651 must be live before a single row is written

  const app = require('../src/server');
  let server = null;

  try {
    /* ───────────────────────────────── seed ────────────────────────────────── */
    const mkStaff = async (role, name) => {
      const { rows } = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active)
         VALUES ($1, $2, $3, true) RETURNING id, token_version`,
        [`${uniq}-${role}@example.test`, name, role]);
      return {
        id: String(rows[0].id),
        token: C.signJwt({ sub: String(rows[0].id), kind: 'staff', role, tv: rows[0].token_version, sid: uniq }),
      };
    };
    const admin = await mkStaff('super_admin', 'LT Doc Admin');
    // A loan officer sees only their OWN long-term files, and is on neither of
    // these — so they are the person a cross-file link must be refused for.
    const stranger = await mkStaff('loan_officer', 'LT Doc Stranger');

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Bo','Rrower',$1) RETURNING id`,
      [`${uniq}-bo@example.test`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status) VALUES ($1,'underwriting') RETURNING id`,
      [borrowerId])).rows[0].id;

    /* `lt_loans.id` carries no default — the Long-Term side mints its own ids.
       THE LOAN CARRIES ITS BORROWER deliberately: without it, "the document never
       gets a borrower_id" would be true for the boring reason that there was no
       borrower to stamp, and the assertion would pass on a door that stamps one. */
    const mkLoan = async (n) => (await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id)
       VALUES ($1::uuid,$2,'Bo Rrower',$3) RETURNING id`,
      [crypto.randomUUID(), `${uniq}-${n}`, borrowerId])).rows[0].id;
    const loanA = String(await mkLoan('A'));
    const loanB = String(await mkLoan('B'));

    const OWNER_A = ownerOf('lt_loan', loanA);

    /* A DOCUMENT condition: `item_kind='document'` with NO tool_key is precisely
       what the shared sign-off gate's document arm keys on, so these are the rows
       that must refuse a sign-off with nothing accepted on them. */
    const mkLtItem = async (loanId, label) => (await db.query(
      `INSERT INTO checklist_items
         (scope, lt_loan_id, category, label, borrower_label, audience, status,
          item_kind, is_required)
       VALUES ('lt_loan',$1::uuid,'prior_to_approval',$2,$2,'both','outstanding','document',true)
       RETURNING id`, [loanId, label])).rows[0].id;
    const condA1 = String(await mkLtItem(loanA, 'LT bank statements'));
    const condA2 = String(await mkLtItem(loanA, 'LT insurance binder'));
    const condB1 = String(await mkLtItem(loanB, 'Another loan’s condition'));

    // A real RTL condition + document, so the cross-product cases are asserted
    // against something that genuinely exists rather than against an empty table.
    const rtlItem = (await db.query(
      `INSERT INTO checklist_items (scope, application_id, label, borrower_label, audience, status)
       VALUES ('application',$1,'RTL insurance binder','RTL insurance binder','both','outstanding')
       RETURNING id`, [appId])).rows[0].id;
    const rtlUp = await condUpload.uploadConditionDocument({}, {
      owner: ownerOf('application', appId),
      body: { filename: 'rtl.pdf', contentType: 'application/pdf', dataBase64: b64('rtl-bytes-1234') },
      actorId: admin.id, borrowerId, hooks: {}, q: db,
    });
    const rtlDocId = String(rtlUp.documentId);

    /* ───────────────────────────── the HTTP doors ──────────────────────────── */
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const LT = '/api/lt/condition-center';

    const call = async (method, p, who, body) => {
      const res = await fetch(base + p, {
        method,
        headers: Object.assign(
          { authorization: `Bearer ${who.token}` },
          body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const raw = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      return { status: res.status, body: parsed, raw };
    };
    const raw = async (p, who) => {
      const res = await fetch(base + p, { headers: { authorization: `Bearer ${who.token}` } });
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    };

    /* ═════════════ A. THE ROUND TRIP, IN THE ORDER A PERSON DOES IT ═════════ */

    assert((await itemRow(condA1)).status === 'outstanding', 'A0 the condition starts outstanding');

    const BYTES = 'lt-bank-statement-bytes';
    const up = await call('POST', `${LT}/loans/${loanA}/conditions/${condA1}/documents`, admin, {
      filename: 'statement.pdf', contentType: 'application/pdf', dataBase64: b64(BYTES), slot: 'August',
    });
    assert(up.status === 201 && up.body && up.body.ok === true,
      `A1 the upload door answers 201 (${up.status} ${up.raw.slice(0, 160)})`);
    const docId = up.body && up.body.documentId;
    assert(!!docId, 'A2 …and hands back the document it created');

    const d1 = await docRow(docId);
    assert(!!d1 && d1.lt_loan_id === loanA && d1.application_id === null,
      'A3 the document lands with lt_loan_id set and application_id NULL');
    assert(!!d1 && d1.checklist_item_id === condA1 && d1.slot_label === 'August',
      'A4 …on the condition the PATH named, in the slot it was given');
    assert(!!d1 && d1.review_status === 'pending' && d1.is_current === true,
      'A5 …pending review and current');
    assert(!!d1 && d1.uploaded_by_kind === 'staff' && d1.uploaded_by_id === admin.id
      && Number(d1.size_bytes) === Buffer.byteLength(BYTES) && !!d1.storage_ref,
      'A6 …the bytes were really stored and the uploader recorded');
    assert((await itemRow(condA1)).status === 'received',
      'A7 the evidence re-open moved the condition to received');

    // THE SIGN-OFF GATE STILL BITES. Nothing un-reviewed is ever fulfilment.
    const early = await call('POST', `${LT}/loans/${loanA}/conditions/${condA1}/satisfy`, admin, {});
    assert(early.status === 422 && /looked at/i.test(String(early.body && early.body.error || '')),
      `A8 signing off is refused while nobody has looked at the document (${early.status})`);

    const acc = await call('POST', `${LT}/documents/${docId}/review`, admin, { action: 'accept' });
    assert(acc.status === 200 && acc.body && acc.body.review_status === 'accepted',
      `A9 the review door accepts it (${acc.status} ${acc.raw.slice(0, 160)})`);
    assert((await docRow(docId)).review_status === 'accepted', 'A10 …and the row says so');
    assert((await itemRow(condA1)).status === 'received',
      'A11 accepting a document marks the condition RECEIVED, never satisfied (#135)');

    const dl = await raw(`${LT}/documents/${docId}/file`, admin);
    assert(dl.status === 200 && dl.buf.toString('utf8') === BYTES,
      'A12 the download door hands back the exact bytes that were uploaded');
    assert(/attachment/i.test(String(dl.headers.get('content-disposition') || '')),
      'A13 …as a download by default');
    const inline = await raw(`${LT}/documents/${docId}/file?inline=1`, admin);
    assert(inline.status === 200 && /inline/i.test(String(inline.headers.get('content-disposition') || '')),
      'A14 …and inline when a preview asks for it');

    const off = await call('POST', `${LT}/loans/${loanA}/conditions/${condA1}/satisfy`, admin, {});
    assert(off.status === 200 && off.body && off.body.ok === true,
      `A15 with the document accepted the condition signs off (${off.status} ${off.raw.slice(0, 160)})`);
    const a1 = await itemRow(condA1);
    assert(a1.status === 'satisfied' && !!a1.signed_off_at, 'A16 …and it is recorded as satisfied');

    /* ═════════════ A′. REJECT, THEN DELETE, ON A SECOND CONDITION ═══════════ */

    const up2 = await call('POST', `${LT}/loans/${loanA}/conditions/${condA2}/documents`, admin, {
      filename: 'binder.pdf', contentType: 'application/pdf', dataBase64: b64('lt-binder-bytes-xyz'),
    });
    assert(up2.status === 201, `A17 a second condition takes its own document (${up2.status})`);
    const doc2 = up2.body.documentId;

    const noReason = await call('POST', `${LT}/documents/${doc2}/review`, admin, { action: 'reject' });
    assert(noReason.status === 400, 'A18 a rejection with no reason is refused, in the shared door’s own words');

    const rej = await call('POST', `${LT}/documents/${doc2}/review`, admin,
      { action: 'reject', reason: 'The August page is missing.' });
    assert(rej.status === 200 && (await docRow(doc2)).review_status === 'rejected',
      'A19 a rejection with a reason is recorded on the document');
    assert((await itemRow(condA2)).status === 'issue',
      'A20 …and re-opens the condition to issue');

    const del = await call('DELETE', `${LT}/documents/${doc2}`, admin);
    assert(del.status === 200 && del.body && del.body.deleted === true,
      `A21 the delete door removes it (${del.status} ${del.raw.slice(0, 160)})`);
    assert(!(await docRow(doc2)), 'A22 …permanently — the row is gone, not merely superseded');
    assert((await itemRow(condA2)).status === 'outstanding',
      'A23 …and with nothing accepted left the condition is asked for again');

    /* ═════════ B. THE CROSS-OWNER CASES, ASSERTED AT THE STATEMENT ══════════ */

    // Set up a real document on the OTHER long-term loan, through the same door.
    const upB = await call('POST', `${LT}/loans/${loanB}/conditions/${condB1}/documents`, admin, {
      filename: 'other.pdf', contentType: 'application/pdf', dataBase64: b64('other-loan-bytes-99'),
    });
    assert(upB.status === 201, `B0 the other long-term loan has a real document of its own (${upB.status})`);
    const docB = upB.body.documentId;

    assert((await condReview.loadDocument(db, docB, OWNER_A)) === null,
      'B1 the review read scopes the owner IN THE STATEMENT — another loan’s document reaches nothing');
    assert((await condRemove.loadDocument(db, docB, OWNER_A)) === null,
      'B2 …so does the remove read');
    assert((await condServe.documentForServe(db, docB, OWNER_A)) === null,
      'B3 …so does the serve read');
    assert((await condReview.loadDocument(db, rtlDocId, OWNER_A)) === null,
      'B4 an RTL application’s document reaches nothing under a long-term owner');
    assert((await condServe.documentForServe(db, rtlDocId, OWNER_A)) === null,
      'B5 …on the serve read too');

    /* THE DELETE ITSELF IS SCOPED, not merely the read in front of it. Handed a
       row read WITHOUT an owner — which is how a refactor that dropped the read's
       owner would leave it — the statement still matches nothing and the document
       is untouched. This is the assertion a 403 could never make. */
    const foreignRow = await condRemove.loadDocument(db, docB);
    assert(!!foreignRow, 'B6 (control) the other loan’s document is readable with no owner named');
    const refused = await condRemove.removeDocument(db, { doc: foreignRow, owner: OWNER_A, hooks: {} });
    assert(refused && refused.deleted === false,
      'B7 the DELETE is owner-scoped in the statement — it reports that it removed nothing');
    assert(!!(await docRow(docB)), 'B8 …and the other loan’s document is still there');

    const rtlRow = await condRemove.loadDocument(db, rtlDocId);
    const refusedRtl = await condRemove.removeDocument(db, { doc: rtlRow, owner: OWNER_A, hooks: {} });
    assert(refusedRtl && refusedRtl.deleted === false && !!(await docRow(rtlDocId)),
      'B9 an RTL document cannot be deleted under a long-term owner, and is still there');

    // A CONDITION from another loan matches NO ROW in the shared door's own
    // lookup — a property of the query, not of a check somebody remembers.
    let condScoped = false;
    try {
      await condUpload.loadChecklistItem(db, { owner: OWNER_A, checklistItemId: condB1 });
    } catch (e) { condScoped = e && e.status === 404; }
    assert(condScoped,
      'B10 a condition id from another loan is scoped in the statement — the shared lookup finds nothing');

    /* ═════════════ C. THE SAME THREE, THROUGH THE REAL DOORS ═══════════════ */

    const rtlThroughLt = await call('GET', `${LT}/documents/${rtlDocId}/file`, admin);
    assert(rtlThroughLt.status === 404,
      `C1 an RTL document id reaches nothing through the long-term door (${rtlThroughLt.status})`);
    const rtlDelete = await call('DELETE', `${LT}/documents/${rtlDocId}`, admin);
    assert(rtlDelete.status === 404 && !!(await docRow(rtlDocId)),
      'C2 …and the delete door refuses it AND leaves it in place');
    const rtlReview = await call('POST', `${LT}/documents/${rtlDocId}/review`, admin, { action: 'accept' });
    assert(rtlReview.status === 404 && (await docRow(rtlDocId)).review_status === 'pending',
      'C3 …and the review door refuses it AND leaves its verdict alone');

    // A long-term document on a file this person may not open: the file gate is
    // what refuses, and it refuses with the same sentence, so the existence of a
    // document on somebody else's loan is not something this door reveals.
    const strangerRead = await call('GET', `${LT}/documents/${docB}/file`, stranger);
    assert(strangerRead.status === 404,
      `C4 a long-term document on a file this person may not open is refused (${strangerRead.status})`);
    const strangerDelete = await call('DELETE', `${LT}/documents/${docB}`, stranger);
    assert(strangerDelete.status === 404 && !!(await docRow(docB)),
      'C5 …and they cannot delete it either');

    const crossCond = await call('POST', `${LT}/loans/${loanA}/conditions/${condB1}/documents`, admin, {
      filename: 'wrong.pdf', contentType: 'application/pdf', dataBase64: b64('should-never-land'),
    });
    assert(crossCond.status === 404,
      `C6 uploading to a condition that is on another loan is refused (${crossCond.status})`);
    const strayCount = Number((await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE checklist_item_id = $1 AND filename = 'wrong.pdf'`,
      [condB1])).rows[0].n);
    assert(strayCount === 0, 'C7 …and nothing was filed against the other loan’s condition');

    /* THE CONDITION COMES FROM THE PATH, NEVER FROM THE BODY. The path is what
       `scopedCondition` authorized, and the body is the caller's. The reachable
       hazard is a condition on the SAME loan — the other-loan case is refused by
       the owner scoping either way — so that is the one asserted: a document must
       land on the condition the URL named, whatever the payload says. */
    const condA3 = String(await mkLtItem(loanA, 'LT appraisal invoice'));
    const bodyNamed = await call('POST', `${LT}/loans/${loanA}/conditions/${condA3}/documents`, admin, {
      filename: 'path-wins.pdf', contentType: 'application/pdf', dataBase64: b64('path-wins-bytes'),
      checklistItemId: condA2,
    });
    assert(bodyNamed.status === 201, `C6b (control) that upload is accepted (${bodyNamed.status})`);
    const landed = await docRow(bodyNamed.body.documentId);
    assert(landed.checklist_item_id === condA3,
      'C6c the condition comes from the PATH — a condition named in the body is ignored');

    const badId = await call('GET', `${LT}/documents/not-a-uuid/file`, admin);
    assert(badId.status === 404,
      'C8 a malformed document id is answered before it can reach Postgres');
    const noSuch = await call('GET', `${LT}/documents/00000000-0000-4000-8000-000000000000/file`, admin);
    assert(noSuch.status === 404, 'C9 …and so is one that names no document at all');

    /* ═════════ D. NO SHORT-TERM MACHINERY FIRES ON A LONG-TERM DOCUMENT ═════ */

    const noBorrower = await docRow(docId);
    assert(noBorrower.borrower_id === null,
      'D1 a long-term document carries NO borrower_id — the short-term borrower portal selects on that column');
    assert(noBorrower.visibility === 'borrower',
      'D2 …and the shared visibility rule still applies (a borrower-audience condition is not staff-only)');

    const staffOnlyItem = String((await db.query(
      `INSERT INTO checklist_items
         (scope, lt_loan_id, category, label, borrower_label, audience, status, item_kind, is_required)
       VALUES ('lt_loan',$1::uuid,'prior_to_approval','LT internal review','LT internal review','staff','outstanding','document',true)
       RETURNING id`, [loanA])).rows[0].id);
    const upStaff = await call('POST', `${LT}/loans/${loanA}/conditions/${staffOnlyItem}/documents`, admin, {
      filename: 'internal.pdf', contentType: 'application/pdf', dataBase64: b64('internal-only-bytes'),
    });
    assert(upStaff.status === 201 && (await docRow(upStaff.body.documentId)).visibility === 'staff_only',
      'D3 a staff-audience condition stores the document staff-only — the shared rule, unchanged');

    /* ═════════ E. THE READ THE SCREEN DRAWS FROM CARRIES THE DOCUMENTS ══════ */

    const centre = await call('GET', `${LT}/loans/${loanA}`, admin);
    assert(centre.status === 200, `E1 the conditions read answers (${centre.status})`);
    const allConds = []
      .concat(...((centre.body && centre.body.buckets) || []).map((b) => b.conditions || []));
    const shown = allConds.find((c) => c.id === condA1);
    assert(!!shown && Array.isArray(shown.documents.list) && shown.documents.list.length === 1,
      'E2 the team’s read carries the condition’s documents, not only their counts');
    assert(!!shown && shown.documents.list[0].review_status === 'accepted'
      && shown.documents.list[0].filename === 'statement.pdf'
      && shown.documents.list[0].reviewed_by_name === 'LT Doc Admin',
      'E3 …in the shared table’s own column names, which is what the shared components read');

    const clientRead = await require('../src/longterm/conditions-center/read')
      .forLoan(loanA, { audience: 'client', db });
    const clientConds = []
      .concat(...(clientRead.buckets || []).map((b) => b.conditions || []));
    assert(clientConds.length > 0 && clientConds.every((c) => !c.documents.list),
      'E4 …and the BORROWER’s payload carries no document list — a rejection reason is staff free text');
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }

  console.log(failures ? `\ntest-lt-condition-docs-doors-db: ${failures} FAILED` : '\ntest-lt-condition-docs-doors-db: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
