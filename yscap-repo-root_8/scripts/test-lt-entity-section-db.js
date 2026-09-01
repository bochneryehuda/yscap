'use strict';
/**
 * THE ENTITY SECTION IS THE SAME ONE ON BOTH PRODUCTS — proven over REAL HTTP,
 * against a REAL Postgres, through the REAL doors.
 *
 * Owner-directed 2026-08-31: *"I think you're missing the entire entity section
 * that we were officially needing to bring in from the RTL side. The logic
 * should work the same: The exact entity section, same exact form information to
 * type in an entity section. The exact verification workflow. The entity section
 * should be directly linked to the profile. The exact document slots and
 * bi-directional … We can set who owns it, percentages, and layered entities.
 * Bring in the entire logic, just giving you authorization to share the code.
 * Don't reinvent."*
 *
 * ── WHAT WAS MISSING, AND WHY A PURE TEST COULD NOT SEE IT ──────────────────
 *
 * The Long-Term side had the READ (which company, which slots, what is on them)
 * and the CREATE (put it on the profile) — both already shared. It had no EDIT
 * at all: no details form, no entity type, no ownership percentages, no
 * signature titles, no shares, no layered entities and no verification. Those
 * rules were not missing from the codebase; they were INLINE in three
 * `src/routes/staff.js` handlers, where no second caller could reach them. So
 * they were extracted into `src/lib/llc-edit.js` and the short-term routes
 * re-pointed at it FIRST — extract-then-share, never copy.
 *
 * That makes the claim under test a claim about ONE ROW being edited from two
 * products, which only a database can answer. A pure test can prove a rule; it
 * cannot prove that a long-term door reaches the same company a short-term
 * screen reads.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. ONE DEFINITION OF THE VERIFIED LOCK, asserted from BOTH products and from
 *     the SOURCE — the sentence exists once, and a verified company's papers
 *     cannot be replaced from either side. This is the guard that matters most:
 *     the entity is SHARED, so a long-term upload walking past the lock would
 *     replace the evidence a SHORT-TERM verification stands on.
 *  B. THE FORM, THE OWNERSHIP AND THE VERIFICATION WORKFLOW through the
 *     long-term doors — including the refusal that NAMES what is still missing,
 *     because a "not ready" with no list is a dead end.
 *  C. LAYERED ENTITIES: an owner in the chain is reachable from the file that
 *     depends on it (verification is bottom-up), and nothing else on the
 *     borrower's profile is.
 *  D. BI-DIRECTIONAL, asserted on the STORED ROW: what is typed on a long-term
 *     file is the borrower's own record, and a document filed from there belongs
 *     to the COMPANY with no file owner at all — which is what makes it ONE
 *     document rather than a copy.
 *  E. THE DOWNLOAD DOOR derives the company from the document, so a nested
 *     owner's document opens through the same call — and a document belonging to
 *     a loan file, or to another borrower's company, reaches nothing.
 *  F. THE CONDITION on both products moves with the verification.
 *  G. SOURCE: the screen MOUNTS the shared section rather than re-implementing
 *     it. No behaviour test can see a second copy of a form.
 *
 * PROBES THE DATABASE FIRST — `ensureSchema` gives up on an unreachable database
 * WITHOUT throwing, so a suite that does not probe prints a confident ok against
 * nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-entity-section-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-entity-section-db (no DATABASE_URL)'); process.exit(0); }
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

process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-entity-'));

const db = require('../src/db');
const C = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltent-${process.pid}-${Date.now()}`;
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* COMMENTS ARE STRIPPED before every "must not appear" assertion. The code that
   shares a rule necessarily NAMES the thing it replaced in a comment, so a guard
   that read comments would fail on its own explanation and then be "fixed" by
   deleting the explanation. */
const noComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

(async () => {
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();

  const app = require('../src/server');
  const llcLib = require('../src/lib/llc');
  const llcEdit = require('../src/lib/llc-edit');
  let server = null;

  try {
    /* ───────────────────────────────── seed ────────────────────────────────── */
    const { rows: sr } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'LT Entity Admin','super_admin',true) RETURNING id, token_version`,
      [`${uniq}@example.test`]);
    const staffId = String(sr[0].id);
    const staffToken = C.signJwt({
      sub: staffId, kind: 'staff', role: 'super_admin', tv: sr[0].token_version, sid: uniq });

    const mkBorrower = async (tag) => String((await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,$2,$3) RETURNING id`,
      [uniq, tag, `${uniq}-${tag}@example.test`])).rows[0].id);

    const borrower = await mkBorrower('owner');
    const stranger = await mkBorrower('stranger');

    const mkLoan = async (n, entityName) => String((await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months,
                             program_name, loan_amount, loan_folder,
                             vesting_type, vesting_entity_name)
       VALUES ($1::uuid,$2,'Bo Rrower',$3,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline','Officer',$4)
       RETURNING id`,
      [crypto.randomUUID(), `${uniq}-${n}`, borrower, entityName])).rows[0].id);

    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    const call = (method, p, body, token = staffToken) => new Promise((resolve) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1', port, method, path: p,
        headers: Object.assign(
          { Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      }, (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => {
          let json = null; try { json = JSON.parse(raw); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      });
      req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
      if (payload) req.write(payload);
      req.end();
    });

    const entityName = `${uniq} Holdings LLC`;
    const loan = await mkLoan('main', entityName);
    const ent = (llcId) => `/api/lt/condition-center/loans/${loan}/entities/${llcId}`;

    // Put the company on the profile through the door that owns that step.
    const put = await call('POST', `/api/lt/condition-center/loans/${loan}/vesting-entity`);
    assert(put.status === 201 && put.json && put.json.llcId,
      `seed the vesting company reached the profile (got ${put.status} ${put.raw.slice(0, 140)})`);
    const llcId = String(put.json.llcId);

    const slotsOf = async (id) => (await db.query(
      `SELECT ci.id, t.code FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id AND t.scope='llc'
        WHERE ci.llc_id=$1::uuid`, [id])).rows;
    const slots = await slotsOf(llcId);
    const slotFor = (code) => (slots.find((s) => s.code === code) || {}).id;

    const pdf = (t) => ({
      filename: `${t}.pdf`, contentType: 'application/pdf',
      dataBase64: Buffer.from(`%PDF-1.4 ${t}`).toString('base64'),
    });
    const uploadTo = (id, slotId, tag) =>
      call('POST', `${ent(id)}/slots/${slotId}/documents`, pdf(tag));

    /* ═════════════════ A. ONE VERIFIED LOCK, BOTH PRODUCTS ═══════════════════
       The most load-bearing guard in the change: `llcs` is a BORROWER's record,
       shared by the two products, so a long-term upload that walked past the
       lock would replace the very evidence a SHORT-TERM verification stands on.
       Asserted three ways — the sentence exists ONCE in the source, and each
       product's door refuses with it. */

    const staffSrc = noComments(read('src/routes/staff.js'));
    const ltSrc = noComments(read('src/longterm/routes/condition-center.js'));
    const lockSentence = 'revoke verification before replacing its documents';
    assert(read('src/lib/llc-edit.js').includes(lockSentence),
      'A1 the verified-document lock is stated in the shared module');
    assert(!staffSrc.includes(lockSentence) && !ltSrc.includes(lockSentence),
      'A2 …and NEITHER product’s routes restate it — a second copy is two answers about one company');
    assert(/llcEdit\.documentLockFor\(/.test(staffSrc),
      'A3 the short-term upload doors ask the shared lock');
    assert(/llcEdit\.documentLock\(/.test(ltSrc),
      'A4 …and so does the long-term one');

    // And it BITES on both, on the same company, in the same sentence.
    const lockTest = String((await db.query(
      `INSERT INTO llcs (borrower_id, llc_name, is_verified) VALUES ($1::uuid,$2,true) RETURNING id`,
      [borrower, `${uniq} Locked LLC`])).rows[0].id);
    await llcLib.generateLlcChecklist(lockTest, db);
    const lockSlot = (await slotsOf(lockTest)).find((s) => s.code === 'rtl_llc_opagmt');
    const rtlLocked = await call('POST', `/api/staff/llcs/${lockTest}/documents`, pdf('rtl'));
    assert(rtlLocked.status === 409 && /revoke verification/i.test((rtlLocked.json || {}).error || ''),
      `A5 the SHORT-TERM door refuses a verified company’s document (got ${rtlLocked.status})`);
    const lockedDocs = Number((await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE llc_id=$1::uuid`, [lockTest])).rows[0].n);
    assert(lockedDocs === 0,
      'A6 …and NOTHING was filed — the refusal is asserted on the write, not on the status');

    /* THE LONG-TERM HALF, on the loan's OWN company so the lock is what refuses
       it rather than the scope. Verify it first, upload, then un-verify. */
    await db.query(`UPDATE llcs SET is_verified=true WHERE id=$1::uuid`, [llcId]);
    const ltLocked = await uploadTo(llcId, slotFor('rtl_llc_opagmt'), 'locked');
    assert(ltLocked.status === 409 && /revoke verification/i.test((ltLocked.json || {}).error || ''),
      `A7 the LONG-TERM door refuses the same upload, in the same words (got ${ltLocked.status})`);
    const ltLockedDocs = Number((await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE llc_id=$1::uuid`, [llcId])).rows[0].n);
    assert(ltLockedDocs === 0, 'A8 …and it filed nothing either');
    await db.query(`UPDATE llcs SET is_verified=false WHERE id=$1::uuid`, [llcId]);

    /* ═════════════════ B. THE FORM, THE OWNERSHIP, THE WORKFLOW ══════════════ */

    const g1 = await call('GET', ent(llcId));
    assert(g1.status === 200 && g1.json && String(g1.json.id) === llcId,
      `B1 the long-term door reads the whole entity bundle (got ${g1.status})`);
    assert(Array.isArray(g1.json.slots) && Array.isArray(g1.json.members) && g1.json.completeness,
      'B2 …the SAME bundle the short-term section renders — slots, members and completeness');
    assert(g1.json.vesting === true,
      'B3 …and it says this is the loan’s own vesting company, so the screen need not work it out');

    const p1 = await call('PATCH', ent(llcId), {
      ein: '12-3456789', formationState: 'NJ', formationDate: '2020-04-01',
      entityType: 'corporation', ownershipPct: '60',
    });
    assert(p1.status === 200, `B4 the details form saves (got ${p1.status} ${p1.raw.slice(0, 160)})`);
    const saved = ((await db.query(
      `SELECT ein, formation_state, entity_type, entity_type_confirmed, ownership_pct
         FROM llcs WHERE id=$1::uuid`, [llcId])).rows[0]) || {};
    assert(saved.ein === '12-3456789',
      `B5 …through the SHARED normalizer — the EIN is stored in ONE canonical shape whichever product typed it (got ${saved.ein})`);
    assert(!!saved && saved.entity_type === 'corporation' && saved.entity_type_confirmed === true,
      'B6 …and a CORPORATION chosen here is recorded as CHOSEN, not assumed — the owner’s "we can choose corporations"');

    // The entity type re-words the company's own document slots, so a corporation
    // is asked for bylaws rather than an operating agreement.
    const worded = (await db.query(
      `SELECT ci.label FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id AND t.code='rtl_llc_opagmt'
        WHERE ci.llc_id=$1::uuid`, [llcId])).rows[0];
    assert(worded && /bylaw/i.test(worded.label),
      `B7 …and its document slot is re-worded for that kind ("${worded && worded.label}")`);

    /* THE BORROWER'S OWN SHARE IS NOT A MEMBER ROW — it is `llcs.ownership_pct`,
       set by the details form above (60%). So the members are everybody ELSE,
       and the shared rule adds the two together. Getting that wrong is how a
       fixture ends up refused for arithmetic while claiming to test titles. */
    const m1 = await call('PUT', `${ent(llcId)}/members`, {
      members: [
        { fullName: 'Second Owner', ownershipPct: 30, memberKind: 'person',
          email: `${uniq}-second@example.test`, memberTitle: 'Secretary', shares: 300,
          certificateNumber: 'C-2' },
        { fullName: 'Third Owner', ownershipPct: 10, memberKind: 'person',
          memberTitle: 'Treasurer', shares: 100 },
      ],
    });
    assert(m1.status === 200, `B8 who owns it and how much saves (got ${m1.status} ${m1.raw.slice(0, 160)})`);
    const mem = (await db.query(
      `SELECT full_name, ownership_pct, member_title, shares, certificate_number
         FROM llc_members WHERE llc_id=$1::uuid ORDER BY ownership_pct DESC`, [llcId])).rows;
    assert(mem.length === 2 && mem[0] && Number(mem[0].ownership_pct) === 30 && Number(mem[1].ownership_pct) === 10,
      'B9 …with the percentages the owner asked for — 60 the borrower’s own plus 30 and 10 is the whole company');
    assert(mem[0] && mem[0].member_title === 'Secretary' && Number(mem[0].shares) === 300 && mem[0].certificate_number === 'C-2',
      'B10 …and the signature title, the shares and the certificate number a corporation needs — the STAFF fields, on this staff desk');

    /* THE TITLE VOCABULARY IS CLOSED, and this case is written so that ONLY the
       title can refuse it: the percentages still add to 100, so a pass here
       cannot be the ownership rule answering for the wrong reason. */
    const badTitle = await call('PUT', `${ent(llcId)}/members`, {
      members: [{ fullName: 'Second Owner', ownershipPct: 40, memberKind: 'person', memberTitle: 'boss' }],
    });
    assert(badTitle.status >= 400 && /titles we record/i.test((badTitle.json || {}).error || ''),
      `B10b a title that is not on the list is refused — it prints under a signature line, so it may not be typed three ways (got ${badTitle.status} ${(badTitle.json || {}).error || ''})`);

    const over = await call('PUT', `${ent(llcId)}/members`, {
      members: [{ fullName: 'Too Much', ownershipPct: 90, memberKind: 'person' }],
    });
    assert(over.status >= 400 && /100/.test((over.json || {}).error || ''),
      `B11 ownership over 100% is refused BY THE SHARED RULE (got ${over.status} ${(over.json || {}).error || ''})`);

    // VERIFY — the refusal must NAME what is missing, or it is a dead end.
    const notReady = await call('POST', `${ent(llcId)}/verify`, { verified: true });
    assert(notReady.status === 409, `B12 a company with no documents cannot be verified (got ${notReady.status})`);
    assert(Array.isArray(notReady.json && notReady.json.missing) && notReady.json.missing.length > 0,
      'B13 …and the refusal LISTS what is still missing, so somebody can act on it');

    /* ═════════════════ C. LAYERED ENTITIES ═══════════════════════════════════
       An OWNER in the chain has to be workable from the file that depends on it,
       because verification is bottom-up. Nothing else on the profile is. */

    const parentName = `${uniq} Parent Holdings LLC`;
    const m2 = await call('PUT', `${ent(llcId)}/members`, {
      members: [
        { fullName: 'Second Owner', ownershipPct: 10, memberKind: 'person', memberTitle: 'Secretary' },
        { fullName: parentName, ownershipPct: 30, memberKind: 'entity', ownerLlcName: parentName },
      ],
    });
    assert(m2.status === 200, `C1 an ENTITY can own part of the company (got ${m2.status} ${m2.raw.slice(0, 160)})`);
    const parent = (await db.query(
      `SELECT id FROM llcs WHERE borrower_id=$1::uuid AND lower(btrim(llc_name))=lower(btrim($2))`,
      [borrower, parentName])).rows[0];
    assert(!!parent, 'C2 …and the owning company is on the borrower’s profile as a company of its own');
    if (!parent) throw new Error('C2 failed — the rest of C, D, E and F all turn on the owning company existing');

    const gp = await call('GET', ent(String(parent.id)));
    assert(gp.status === 200 && String(gp.json.id) === String(parent.id),
      `C3 the OWNING company is reachable from this loan — verification is bottom-up (got ${gp.status})`);
    assert(gp.json.vesting === false,
      'C4 …and is correctly NOT reported as the vesting company');

    const strangerLlc = String((await db.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1::uuid,$2) RETURNING id`,
      [stranger, `${uniq} Stranger LLC`])).rows[0].id);
    const gs = await call('GET', ent(strangerLlc));
    assert(gs.status === 404,
      `C5 another borrower’s company is NOT reachable from this loan (got ${gs.status})`);
    const ps = await call('PATCH', ent(strangerLlc), { ein: '99-9999999' });
    assert(ps.status === 404, `C6 …and cannot be edited through it either (got ${ps.status})`);
    const strangerEin = (await db.query(
      `SELECT ein FROM llcs WHERE id=$1::uuid`, [strangerLlc])).rows[0].ein;
    assert(!strangerEin,
      'C7 …asserted on the ROW — a 404 that wrote the field anyway has refused nothing');

    // A company on the borrower's OWN profile that this loan has nothing to do
    // with is refused for the same reason: the loan says which companies it may
    // reach, not the borrower.
    const unrelated = String((await db.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1::uuid,$2) RETURNING id`,
      [borrower, `${uniq} Unrelated LLC`])).rows[0].id);
    const gu = await call('GET', ent(unrelated));
    assert(gu.status === 404,
      `C8 an unrelated company on the SAME borrower is not reachable from this loan either (got ${gu.status})`);

    /* ═════════════════ D. BI-DIRECTIONAL, ON THE ROW ═════════════════════════ */

    const up = await uploadTo(llcId, slotFor('rtl_llc_opagmt'), 'agreement');
    assert(up.status === 201, `D1 a document files onto the company’s slot from the long-term file (got ${up.status} ${up.raw.slice(0, 160)})`);
    const doc = ((await db.query(
      `SELECT llc_id, application_id, lt_loan_id, borrower_id, checklist_item_id
         FROM documents WHERE id=$1::uuid`, [(up.json || {}).documentId || null])).rows[0]) || {};
    assert(String(doc.llc_id) === llcId && doc.application_id === null && doc.lt_loan_id === null,
      'D2 …and it belongs to the COMPANY with NO file owner — one document, not a copy per loan');
    assert(String(doc.borrower_id) === borrower,
      'D3 …stamped to the borrower, which is what puts it on their profile screens');

    // THE SHORT-TERM SIDE SEES ALL OF IT — same row, same bundle, no sync.
    const rtlBundle = await call('GET', `/api/staff/llcs/${llcId}`);
    assert(rtlBundle.status === 200, `D4 the short-term entity door reads the same company (got ${rtlBundle.status})`);
    assert(!!rtlBundle.json && rtlBundle.json.ein === '12-3456789' && rtlBundle.json.entity_type === 'corporation',
      `D5 …carrying what was typed on the LONG-TERM file — the owner’s "bi-directional", asserted across the products (got ein=${rtlBundle.json && rtlBundle.json.ein} type=${rtlBundle.json && rtlBundle.json.entity_type})`);
    const rtlSlot = ((rtlBundle.json || {}).slots || []).find((s) => /bylaw|operating/i.test(s.label || ''));
    assert(rtlSlot && rtlSlot.document_id,
      'D6 …and the document filed from the long-term file is on the short-term screen’s own slot');

    /* ═════════════════ E. THE DOWNLOAD DOOR ══════════════════════════════════ */

    const dl = await call('GET',
      `/api/lt/condition-center/loans/${loan}/entities/documents/${(up.json || {}).documentId}/file`);
    assert(dl.status === 200, `E1 the company’s document opens from the long-term file (got ${dl.status})`);

    // A NESTED OWNER'S document opens through the SAME call — which is why the
    // company is derived from the document rather than taken from the path.
    await llcLib.generateLlcChecklist(String(parent.id), db);
    const parentSlot = (await slotsOf(String(parent.id))).find((s) => s.code === 'rtl_llc_opagmt');
    const upParent = await uploadTo(String(parent.id), parentSlot.id, 'parent-agreement');
    assert(upParent.status === 201, `E2 a document files onto the OWNING company’s slot too (got ${upParent.status})`);
    const dlParent = await call('GET',
      `/api/lt/condition-center/loans/${loan}/entities/documents/${(upParent.json || {}).documentId}/file`);
    assert(dlParent.status === 200,
      `E3 …and opens through the same call, with no second id to carry (got ${dlParent.status})`);

    // A STRANGER'S company document. The id is real; it simply is not reachable.
    await llcLib.generateLlcChecklist(strangerLlc, db);
    const strangerDoc = String((await db.query(
      `INSERT INTO documents (llc_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, visibility)
       VALUES ($1::uuid,$2::uuid,'x.pdf','application/pdf',3,'local','nope','staff',$3,'borrower')
       RETURNING id`, [strangerLlc, stranger, staffId])).rows[0].id);
    const dlStranger = await call('GET',
      `/api/lt/condition-center/loans/${loan}/entities/documents/${strangerDoc}/file`);
    assert(dlStranger.status === 404,
      `E4 another borrower’s company document is unreachable (got ${dlStranger.status})`);

    /* A LOAN-FILE DOCUMENT IS NOT AN ENTITY DOCUMENT, and this door must not
       become a second way to reach one — the loan's own document door governs
       those, with its own product boundary and its own review rules.

       THE FIXTURE CARRIES BOTH THE LOAN AND A REACHABLE COMPANY, deliberately.
       A loan document with a NULL company is already refused by the
       reachability check, so asserting on that shape proves NOTHING about the
       exclusion: the mutation was run, and with the owner-column test deleted a
       null-company fixture still 404'd. This one can only be refused by the
       exclusion itself. */
    const loanDoc = String((await db.query(
      `INSERT INTO documents (lt_loan_id, llc_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, visibility)
       VALUES ($1::uuid,$2::uuid,'file.pdf','application/pdf',3,'local','nope','staff',$3,'staff_only')
       RETURNING id`, [loan, llcId, staffId])).rows[0].id);
    const dlLoanDoc = await call('GET',
      `/api/lt/condition-center/loans/${loan}/entities/documents/${loanDoc}/file`);
    assert(dlLoanDoc.status === 404,
      `E5 a document on the loan FILE is not reachable through the entity door, even when it names a company this loan CAN reach (got ${dlLoanDoc.status})`);

    /* ═════════════════ F. THE CONDITION MOVES WITH IT ════════════════════════ */

    // Make the company verifiable: accept its documents and fill what is required.
    await db.query(`UPDATE documents SET review_status='accepted' WHERE llc_id=$1::uuid`, [llcId]);
    for (const s of await slotsOf(llcId)) {
      if (s.code === 'rtl_llc_opagmt') continue;
      const u = await uploadTo(llcId, s.id, `slot-${s.code}`);
      if (u.status === 201) {
        await db.query(`UPDATE documents SET review_status='accepted' WHERE id=$1::uuid`, [u.json.documentId]);
      }
    }
    // The parent must be verified first — verification is bottom-up.
    await db.query(`UPDATE llcs SET is_verified=true WHERE id=$1::uuid`, [parent.id]);

    /* THE LOAN'S OWN CONDITIONS. The vesting-entity condition is attached by the
       long-term ENGINE from the loan's own facts, exactly as it is in production
       — never inserted by hand here, or F2 would prove that a test can write a
       row rather than that verifying a company moves a real condition.

       The engine's `vests_in_entity` reads the loan's PARTIES (an entity party,
       or a party carrying an entity's legal name), not the `vesting_entity_name`
       column — so the fixture has to give the loan the party that makes it true,
       or the condition is correctly never attached and F2 would be asserting
       against a file the rule does not apply to. */
    const pair = String((await db.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number)
       VALUES ($1::uuid, $2::uuid, 1) RETURNING id`,
      [crypto.randomUUID(), loan])).rows[0].id);
    await db.query(
      `INSERT INTO lt_parties (id, pair_id, role, party_type, entity_legal_name)
       VALUES ($1::uuid, $2::uuid, 'borrower', 'entity', $3)`,
      [crypto.randomUUID(), pair, entityName]);
    const ev = await require('../src/longterm/conditions-center/engine').evaluateLoan(loan);
    assert(ev.ok && !ev.degraded,
      `F-seed the engine ran cleanly over the loan (${ev.degraded || 'ok'})`);

    const condOf = async () => (await db.query(
      `SELECT ci.status FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id AND t.code='lt_vesting_entity'
        WHERE ci.lt_loan_id=$1::uuid`, [loan])).rows[0];
    const hasCond = !!(await condOf());
    assert(hasCond, 'F0 (fixture) the loan really carries the vesting-entity condition — so F2 moves for the right reason');

    const ver = await call('POST', `${ent(llcId)}/verify`, { verified: true });
    assert(ver.status === 200 && ver.json.verified === true,
      `F1 the company verifies through the long-term door (got ${ver.status} ${ver.raw.slice(0, 200)})`);
    const after = await condOf();
    assert(after && after.status === 'satisfied',
      `F2 …and the long-term vesting-entity condition is satisfied (got ${after && after.status})`);

    const noReason = await call('POST', `${ent(llcId)}/verify`, { verified: false });
    assert(noReason.status === 400,
      `F3 a revoke with no reason is refused — the borrower is told why (got ${noReason.status})`);
    assert((await db.query(`SELECT is_verified FROM llcs WHERE id=$1::uuid`, [llcId])).rows[0].is_verified === true,
      'F3b …and nothing was revoked');

    /* THE TRANSITION, NOT THE END STATE. A condition that never became satisfied
       is ALSO "outstanding" after a revoke, so asserting the end state alone
       passes just as happily when the sync is broken — which is exactly what it
       did while `syncLtEntityCondition` was throwing into a swallowed catch. */
    const beforeRevoke = await condOf();
    const rev = await call('POST', `${ent(llcId)}/verify`, { verified: false, reason: 'the agreement was superseded' });
    assert(rev.status === 200 && rev.json.verified === false,
      `F4 a revoke WITH a reason goes through (got ${rev.status})`);
    const reopened = await condOf();
    assert(beforeRevoke && beforeRevoke.status === 'satisfied'
      && reopened && reopened.status === 'outstanding',
      `F5 …and the condition REOPENS — satisfied before, outstanding after (got ${beforeRevoke && beforeRevoke.status} → ${reopened && reopened.status})`);

    /* ═════════════════ G. THE SCREEN MOUNTS IT, NOT A COPY ═══════════════════
       No behaviour test can see a second copy of a form: a re-implemented entity
       section would answer every assertion above identically and then drift the
       first time a rule changed on the short-term side. */

    const ltEntity = read('app-v2/src/longterm/LtEntity.jsx');
    assert(/from '\.\.\/components\/LlcManager\.jsx'/.test(ltEntity),
      'G1 the long-term entity screen MOUNTS the shared section');
    assert(/<LlcManager\b/.test(ltEntity), 'G2 …and renders it');
    const ltEntityBody = noComments(ltEntity);
    for (const own of ['formationState', 'entityType', 'ownershipPct', 'memberTitle', 'certificateNumber']) {
      assert(!ltEntityBody.includes(own),
        `G3 …and re-implements no part of the form (no "${own}" field of its own)`);
    }
    const answer = noComments(read('app-v2/src/longterm/LtConditionAnswer.jsx'));
    assert(!/function EntityBlock/.test(answer),
      'G4 the read-only block it replaced is GONE, not left beside it as a second answer');
    assert(/<LtEntity\b/.test(answer), 'G5 …and the condition renders the real section instead');

    console.log(failures ? `\nFAILED ${failures} assertion(s)` : `\nOK test-lt-entity-section-db (all assertions passed)`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
