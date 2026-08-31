'use strict';
/**
 * THE LONG-TERM BORROWER CAN SEE THEIR CONDITIONS AND SEND A DOCUMENT — proven
 * over REAL HTTP, against a REAL Postgres, through the REAL doors.
 *
 * WHAT WAS MISSING. The staff half of the shared Condition Center works; a
 * long-term borrower signed in and saw a card with a loan amount on it and
 * nothing else. Zero conditions, no upload, no way to learn what was still
 * needed — so every long-term document had to be chased by telephone and email,
 * the way it worked before PILOT. This suite is the proof that the audience
 * exists now, and — much more importantly — that it reaches ONLY their own file.
 *
 * NAMED `test-lt-…` DELIBERATELY: the separation gate reads a suite's FILENAME as
 * its product identity, and this one names `lt_loans`, `lt_settings` and
 * `documents.lt_loan_id`.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. THE ROUND TRIP a borrower actually does: open the loan, see the condition
 *     addressed to them, send a document, watch the condition move.
 *
 *  B. THE REFUSALS, WHICH ARE THE POINT. Another borrower's loan, a staff-only
 *     condition, a condition belonging to a different loan, and the whole side
 *     switched off. Each is asserted on the WRITE as well as the read: a door
 *     that answers 404 and files the document anyway has refused nothing.
 *
 *  C. WHAT THE PAYLOAD CARRIES AND WHAT IT MUST NOT. The internal note, the
 *     internal label, who signed a condition off and the document list are all
 *     staff facts; a rejected document's REASON is the borrower's, because
 *     rejecting their document is an instruction and one with no reason cannot
 *     be followed.
 *
 *  D. THE DOCUMENT NEVER LANDS ON THEIR SHORT-TERM SCREEN. `documents.borrower_id`
 *     is what the RTL borrower portal's own list selects on, so a long-term
 *     upload must leave it NULL however tempting it looks — while still
 *     recording who sent it.
 *
 *  E. THE BIG DOCUMENT. A phone photograph of a bank statement is exactly the
 *     upload that hits the base64 ceiling, so the borrower's door carries the
 *     streamed sibling too.
 *
 * PROBES THE DATABASE FIRST — `ensureSchema` gives up on an unreachable database
 * WITHOUT throwing, so a suite that does not probe prints a confident ok against
 * nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-borrower-conditions-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-borrower-conditions-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
// Small on purpose: section E is about the RELATIONSHIP between the two doors'
// ceilings, and 2 MB against a 1 MB base64 cap is the same relationship a 40 MB
// scan has against the real one — proven in a second rather than a minute.
process.env.MAX_UPLOAD_MB = process.env.MAX_UPLOAD_MB || '32';
process.env.MAX_JSON_UPLOAD_MB = process.env.MAX_JSON_UPLOAD_MB || '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-bor-cond-'));

const db = require('../src/db');
const C = require('../src/lib/crypto');
const auth = require('../src/auth');
const settingsStore = require('../src/longterm/settings/store');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltbc-${process.pid}-${Date.now()}`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

(async () => {
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();

  const app = require('../src/server');
  let server = null;

  try {
    /* ───────────────────────────────── seed ────────────────────────────────── */
    const mkStaff = async (role, name) => {
      const { rows } = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active)
         VALUES ($1,$2,$3,true) RETURNING id, token_version`,
        [`${uniq}-${role}@example.test`, name, role]);
      return { id: String(rows[0].id),
        token: C.signJwt({ sub: String(rows[0].id), kind: 'staff', role, tv: rows[0].token_version, sid: uniq }) };
    };
    const mkBorrower = async (tag) => {
      const { rows } = await db.query(
        `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,$2,$3) RETURNING id`,
        [uniq, tag, `${uniq}-${tag}@example.test`]);
      await db.query(
        `INSERT INTO borrower_auth (borrower_id, password_hash, email_verified)
         VALUES ($1::uuid,'x',true) ON CONFLICT (borrower_id) DO NOTHING`, [rows[0].id]);
      return { id: String(rows[0].id), token: await auth.mintBorrowerSession(String(rows[0].id)) };
    };

    const admin = await mkStaff('super_admin', 'LT Borrower Cond Admin');
    const mine = await mkBorrower('mine');
    const other = await mkBorrower('other');
    assert(!!mine.token && !!other.token,
      'A0 both borrower sessions were really minted — a refusal below can never be a dead key');

    const mkLoan = async (n, borrowerId) => (await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months,
                             program_name, loan_amount, loan_folder)
       VALUES ($1::uuid,$2,'Bo Rrower',$3,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline')
       RETURNING id`, [crypto.randomUUID(), `${uniq}-${n}`, borrowerId])).rows[0].id;
    const myLoan = String(await mkLoan('mine', mine.id));
    const theirLoan = String(await mkLoan('other', other.id));

    const mkItem = async (loanId, label, audience) => (await db.query(
      `INSERT INTO checklist_items
         (scope, lt_loan_id, category, label, borrower_label, hint, borrower_hint,
          audience, status, item_kind, is_required, notes)
       VALUES ('lt_loan',$1::uuid,'prior_to_approval',$2,$3,'internal hint','what you need to send',
               $4,'outstanding','document',true,'INTERNAL underwriting note')
       RETURNING id`,
      [loanId, `INTERNAL ${label}`, `Please send ${label}`, audience])).rows[0].id;

    const condMine = String(await mkItem(myLoan, 'your last two bank statements', 'both'));
    const condStaffOnly = String(await mkItem(myLoan, 'the flood certificate', 'staff'));
    const condTheirs = String(await mkItem(theirLoan, 'their insurance binder', 'both'));

    // The client-facing switch, pinned ON so this suite is independent of the
    // shipped default rather than quietly asserting an empty list if it moves.
    await db.query(
      `INSERT INTO lt_settings (scope, key, value, updated_at)
       VALUES ('company','borrower.longTermVisible','true'::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    settingsStore.bust();

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const MY = '/api/lt/my';

    const call = async (method, p, who, body) => {
      const res = await fetch(base + p, {
        method,
        headers: Object.assign({ authorization: `Bearer ${who.token}` },
          body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const raw = await res.text();
      let parsed = null; try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      return { status: res.status, body: parsed, raw };
    };
    const condsOf = (payload) => []
      .concat(...(((payload && payload.buckets) || []).map((b) => b.conditions || [])));

    /* ═══════════════ A. THE ROUND TRIP A BORROWER ACTUALLY DOES ═════════════ */

    const seen = await call('GET', `${MY}/loans/${myLoan}/conditions`, mine);
    assert(seen.status === 200, `A1 the borrower can open their own loan's conditions (${seen.status})`);
    const list = condsOf(seen.body);
    assert(list.length === 1 && String(list[0].id) === condMine,
      `A2 …and sees the ONE addressed to them, not the staff-only one (${list.length} shown)`);
    assert(!!list[0] && list[0].label === 'Please send your last two bank statements',
      `A3 …in the wording written FOR them, never the internal label (${list[0] && list[0].label})`);
    assert(!!list[0] && list[0].hint === 'what you need to send',
      'A4 …with the borrower hint, not the internal one');

    const up = await call('POST', `${MY}/loans/${myLoan}/conditions/${condMine}/documents`, mine, {
      filename: 'statement.pdf', contentType: 'application/pdf', dataBase64: b64('my-bank-statement'),
    });
    assert(up.status === 201 && up.body && up.body.ok === true,
      `A5 the borrower can send a document (${up.status} ${up.raw.slice(0, 90)})`);
    const docId = up.body && up.body.documentId;

    const after = (await db.query(
      `SELECT status FROM checklist_items WHERE id = $1`, [condMine])).rows[0];
    assert(!!after && after.status === 'received',
      `A6 …and the condition moves off outstanding (${after && after.status})`);

    const reread = condsOf((await call('GET', `${MY}/loans/${myLoan}/conditions`, mine)).body);
    assert(reread[0] && reread[0].documents && reread[0].documents.total === 1,
      'A7 …and their own screen counts it');

    /* ═══════════════ B. THE REFUSALS, WHICH ARE THE POINT ═══════════════════ */

    const theirs = await call('GET', `${MY}/loans/${theirLoan}/conditions`, mine);
    assert(theirs.status === 404, `B1 another borrower's loan is not found (${theirs.status})`);

    const crossWrite = await call('POST',
      `${MY}/loans/${theirLoan}/conditions/${condTheirs}/documents`, mine, {
        filename: 'x.pdf', contentType: 'application/pdf', dataBase64: b64('should-never-land'),
      });
    assert(crossWrite.status === 404, `B2 …and cannot be written to (${crossWrite.status})`);
    const onTheirs = (await db.query(
      `SELECT count(*)::int n FROM documents WHERE checklist_item_id = $1`, [condTheirs])).rows[0].n;
    assert(onTheirs === 0,
      `B3 …asserted on the TABLE, not on the status code: nothing landed (${onTheirs})`);

    const staffOnly = await call('POST',
      `${MY}/loans/${myLoan}/conditions/${condStaffOnly}/documents`, mine, {
        filename: 'flood.pdf', contentType: 'application/pdf', dataBase64: b64('not-theirs-to-send'),
      });
    assert(staffOnly.status === 404,
      `B4 a staff-only condition on their OWN loan refuses the upload (${staffOnly.status})`);
    const onStaffOnly = (await db.query(
      `SELECT count(*)::int n FROM documents WHERE checklist_item_id = $1`, [condStaffOnly])).rows[0].n;
    assert(onStaffOnly === 0, `B5 …and nothing landed on it either (${onStaffOnly})`);

    /* A condition that IS borrower-facing but belongs to another loan, named
       through the path of a loan they DO own.

       TWO INDEPENDENT LAYERS REFUSE THIS, AND SAYING SO IS THE POINT. This
       door's own lookup welds the loan into the statement; so does the SHARED
       upload service, whose condition read is `id = $1 AND lt_loan_id = $2`.
       Neutralising this file's loan term leaves the suite GREEN — measured, not
       assumed — because the shared door still refuses. So a status-code
       assertion here proves NEITHER layer, which is the tautology this repo
       keeps re-learning: when a gate has two independent reasons to refuse, an
       assertion on it proves neither.

       What is asserted instead is the property that actually matters and that
       holds whichever layer answers: the document does not exist, on either
       condition. The layer that is genuinely THIS file's own — the audience
       test — is pinned by B4/B5, which no other layer holds. */
    const wrongLoan = await call('POST',
      `${MY}/loans/${myLoan}/conditions/${condTheirs}/documents`, mine, {
        filename: 'y.pdf', contentType: 'application/pdf', dataBase64: b64('wrong-loan'),
      });
    assert(wrongLoan.status === 404,
      `B6 a condition from another loan is refused through their own loan's path (${wrongLoan.status})`);
    const strayCount = (await db.query(
      `SELECT count(*)::int n FROM documents
        WHERE checklist_item_id = $1 OR (lt_loan_id = $2::uuid AND filename = 'y.pdf')`,
      [condTheirs, myLoan])).rows[0].n;
    assert(strayCount === 0,
      `B6b …and it landed NOWHERE — not on the other loan's condition, and not loose on their own file (${strayCount})`);

    // AND THE SWITCH. Off must mean off for the documents too, not only the list.
    await db.query(
      `UPDATE lt_settings SET value = 'false'::jsonb, updated_at = now()
        WHERE scope = 'company' AND key = 'borrower.longTermVisible'`);
    settingsStore.bust();
    const offRead = await call('GET', `${MY}/loans/${myLoan}/conditions`, mine);
    const offWrite = await call('POST', `${MY}/loans/${myLoan}/conditions/${condMine}/documents`, mine, {
      filename: 'z.pdf', contentType: 'application/pdf', dataBase64: b64('side-is-off'),
    });
    assert(offRead.status === 404 && offWrite.status === 404,
      `B7 with the borrower-facing side switched OFF both doors close (${offRead.status}/${offWrite.status})`);
    await db.query(
      `UPDATE lt_settings SET value = 'true'::jsonb, updated_at = now()
        WHERE scope = 'company' AND key = 'borrower.longTermVisible'`);
    settingsStore.bust();
    assert((await call('GET', `${MY}/loans/${myLoan}/conditions`, mine)).status === 200,
      'B8 CONTROL and switching it back on opens them again — B7 was the switch, not a broken door');

    /* AND THE THREE THINGS A BORROWER MAY NOT NAME ABOUT THEIR OWN UPLOAD.
       All three ride the request body, all three are stripped, and none of the
       three was covered until a mutation showed the strip could be deleted with
       the suite still green.

         · `docKind` — and the value that matters is `term_sheet`, not something
           exotic. The shared door deliberately honours that ONE kind from the
           body (the Term Sheet Studio captures its own PDF through the ordinary
           upload path), and honouring it means superseding every other term
           sheet on the file and stamping the final/initial flag the issuance
           gate reads. So a borrower who could name it could supersede the term
           sheet we sent them. An invented kind like `credit_xml` is ignored by
           that same function, which is why a mutation testing THAT value proves
           nothing — this is the sharp one and it has to be tested with the sharp
           value.
         · `visibility` decides who may read it back. HONEST NOTE, measured: the
           shared door derives this from the condition's audience and never reads
           it from the body, so stripping it is REDUNDANT today and removing the
           strip does not fail this suite. It is kept as the second lock on a
           door whose first lock lives in another module, and it is recorded as
           redundant rather than left to imply it bites.
         · `replaceDocumentId` supersedes an existing copy — including one WE
           have already accepted, which is a way to make a cleared condition
           un-clear itself. */
    const accepted = (await db.query(
      `SELECT id FROM documents WHERE checklist_item_id = $1 AND is_current LIMIT 1`,
      [condMine])).rows[0];
    const forged = await call('POST', `${MY}/loans/${myLoan}/conditions/${condMine}/documents`, mine, {
      filename: 'forged.pdf', contentType: 'application/pdf', dataBase64: b64('forged-body-keys'),
      docKind: 'term_sheet', visibility: 'staff_only',
      replaceDocumentId: accepted ? String(accepted.id) : null,
    });
    assert(forged.status === 201, `B9 the upload itself still succeeds (${forged.status})`);
    const forgedRow = forged.body && forged.body.documentId ? (await db.query(
      `SELECT doc_kind, visibility FROM documents WHERE id = $1`, [forged.body.documentId])).rows[0] : null;
    assert(!!forgedRow && forgedRow.doc_kind !== 'term_sheet',
      `B10 …but the borrower cannot mark it a TERM SHEET — the one kind the shared door honours from a body (${forgedRow && forgedRow.doc_kind})`);
    assert(!!forgedRow && forgedRow.visibility !== 'staff_only',
      `B11 …and so is the visibility they asked for (${forgedRow && forgedRow.visibility})`);
    const stillCurrent = accepted ? (await db.query(
      `SELECT is_current FROM documents WHERE id = $1`, [accepted.id])).rows[0] : null;
    assert(!accepted || (stillCurrent && stillCurrent.is_current === true),
      'B12 …and the copy they named as replaced is untouched — superseding is ours, not theirs');

    /* ═════════ C. WHAT THE PAYLOAD CARRIES, AND WHAT IT MUST NOT ════════════ */

    const shown = condsOf((await call('GET', `${MY}/loans/${myLoan}/conditions`, mine)).body)[0];
    const asText = JSON.stringify(shown);
    assert(!/INTERNAL/.test(asText),
      'C1 neither the internal label nor the internal note reaches the borrower');
    assert(shown && shown.documents && !shown.documents.list,
      'C2 …and neither does the document list — that is the team’s view of their file');
    for (const k of ['notes', 'config', 'satisfiedBy', 'waivedBy', 'waivedReason', 'origin', 'audience']) {
      assert(!(k in shown), `C3 the staff-only key "${k}" is absent from the client payload`);
    }

    // The REJECTION REASON is theirs, because rejecting their document is an
    // instruction to them. Staff reject through the shared door.
    const rejected = await fetch(
      `${base}/api/lt/condition-center/documents/${docId}/review`,
      { method: 'POST',
        headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reject', reason: 'The second page is missing.' }) });
    assert(rejected.status === 200, `C4 staff rejected the document (${rejected.status})`);
    const afterReject = condsOf((await call('GET', `${MY}/loans/${myLoan}/conditions`, mine)).body)[0];
    assert(afterReject && afterReject.rejectionReason === 'The second page is missing.',
      `C5 …and the borrower is TOLD why, or they send the same wrong document again (${afterReject && afterReject.rejectionReason})`);

    /* ═════ D. IT NEVER LANDS ON THEIR SHORT-TERM SCREEN ═════════════════════ */

    const row = (await db.query(
      `SELECT borrower_id, lt_loan_id, application_id, uploaded_by_kind, uploaded_by_id
         FROM documents WHERE id = $1`, [docId])).rows[0];
    assert(!!row && row.borrower_id === null,
      'D1 the document carries NO borrower_id — that column is what the RTL borrower portal selects on');
    assert(!!row && String(row.lt_loan_id) === myLoan && row.application_id === null,
      'D2 …and is owned by the long-term loan, with no application');
    assert(!!row && row.uploaded_by_kind === 'borrower' && String(row.uploaded_by_id) === mine.id,
      `D3 …while still recording WHO sent it (${row && row.uploaded_by_kind})`);

    /* ═════════════ E. THE BIG DOCUMENT — a phone photo of a statement ═══════ */

    const BIG = Buffer.alloc(2 * 1024 * 1024, 0x43);
    const streamed = await fetch(
      `${base}${MY}/loans/${myLoan}/conditions/${condMine}/documents/binary`,
      { method: 'POST',
        headers: {
          authorization: `Bearer ${mine.token}`,
          'content-type': 'application/octet-stream',
          'x-upload-meta': Buffer.from(JSON.stringify(
            { filename: 'statement-photo.jpg', contentType: 'image/jpeg' }), 'utf8').toString('base64'),
        },
        body: BIG });
    const streamedBody = await streamed.json().catch(() => null);
    assert(streamed.status === 201 && streamedBody && streamedBody.ok === true,
      `E1 a ${BIG.length / 1048576} MB photograph lands through the streamed door (${streamed.status})`);
    const bigRow = streamedBody && streamedBody.documentId ? (await db.query(
      `SELECT size_bytes, borrower_id FROM documents WHERE id = $1`, [streamedBody.documentId])).rows[0] : null;
    assert(!!bigRow && Number(bigRow.size_bytes) === BIG.length,
      `E2 …whole (${bigRow && bigRow.size_bytes} of ${BIG.length})`);
    assert(!!bigRow && bigRow.borrower_id === null,
      'E3 …and the streamed door obeys the same disclosure rule as the JSON one');

    const tooBig = await call('POST', `${MY}/loans/${myLoan}/conditions/${condMine}/documents`, mine, {
      filename: 'statement-photo.jpg', contentType: 'image/jpeg', dataBase64: BIG.toString('base64'),
    });
    assert(tooBig.status === 413,
      `E4 CONTROL the same photograph is refused by the JSON door — E1 is the streamed one, not a roomy ceiling (${tooBig.status})`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }

  console.log(failures
    ? `\ntest-lt-borrower-conditions-db: ${failures} FAILED`
    : '\ntest-lt-borrower-conditions-db: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
