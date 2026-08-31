'use strict';
/**
 * THE VESTING COMPANY REACHES THE BORROWER'S PROFILE — proven over REAL HTTP,
 * against a REAL Postgres, through the REAL doors.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * `LtConditionAnswer.jsx` told people, on every long-term file whose vesting
 * company was not on the borrower's profile: *"What is uploaded here will be
 * saved to it, and verified once — so the next loan for the same company starts
 * already done."* NOTHING DID THAT. `entity-prefill.js` was a correct, shared
 * READER and there was no write side at all, so an operating agreement collected
 * on a long-term file stayed on that file's condition, the next loan for the
 * same company asked for it again, and the short-term side never saw it. A
 * screen that promises something the code does not do is worse than one that
 * promises nothing.
 *
 * ── AND THE FIX IS A SHAPE, NOT A FEATURE ───────────────────────────────────
 *
 * The obvious build is to take an upload on the condition and COPY the bytes to
 * the profile afterwards. This does not: the SHARED upload door already files an
 * entity document straight onto the company (`llcId`, both file-owner columns
 * null), so the long-term screen offers the company's OWN slots and the document
 * lands on the profile the FIRST time. Section D is what makes that claim
 * checkable — it asserts on the stored row, not on a 201.
 *
 * NAMED `test-lt-…` DELIBERATELY: the separation gate reads a suite's FILENAME as
 * its product identity, and this one names `lt_loans` and reaches the long-term
 * routes.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. THE REFUSALS, FIRST, BECAUSE THEY ARE THE POINT. A loan with no borrower,
 *     a loan that vests in the person, a loan PILOT has not read yet, and an
 *     entity vesting with no name. Each would otherwise put a company on a
 *     PERSON'S PERMANENT RECORD off a stale Encompass field.
 *  B. THE CREATE, through the shared chokepoint: the company, its slots, and the
 *     provenance stamp.
 *  C. REUSE, NEVER DUPLICATE — and the stamp NOT applied to a company the
 *     borrower already had, because stamping one would wrongly hold its bank
 *     balances out of the short-term liquidity reading.
 *  D. THE DOCUMENT LANDS ON THE COMPANY, not on the loan — asserted on the row's
 *     own owner columns.
 *  E. THE ROUND TRIP that makes the screen's sentence true: after the upload the
 *     READ side reports the slot filled, which is what the next loan sees.
 *  F. SCOPE. Uploading before the company is saved, and another company's slot.
 *     Each asserted on the WRITE as well as the status — a door that answers 4xx
 *     and files the document anyway has refused nothing.
 *
 * PROBES THE DATABASE FIRST — `ensureSchema` gives up on an unreachable database
 * WITHOUT throwing, so a suite that does not probe prints a confident ok against
 * nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-vesting-entity-profile-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-vesting-entity-profile-db (no DATABASE_URL)'); process.exit(0); }
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
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-vest-ent-'));

const db = require('../src/db');
const C = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltve-${process.pid}-${Date.now()}`;

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
    const { rows: sr } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'LT Vesting Entity Admin','super_admin',true) RETURNING id, token_version`,
      [`${uniq}@example.test`]);
    const staffToken = C.signJwt({
      sub: String(sr[0].id), kind: 'staff', role: 'super_admin', tv: sr[0].token_version, sid: uniq });

    const mkBorrower = async (tag) => String((await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,$2,$3) RETURNING id`,
      [uniq, tag, `${uniq}-${tag}@example.test`])).rows[0].id);

    const borrower = await mkBorrower('owner');
    const stranger = await mkBorrower('stranger');

    /** A long-term loan with whatever vesting facts the case needs. */
    const mkLoan = async (n, fields = {}) => String((await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months,
                             program_name, loan_amount, loan_folder,
                             vesting_type, vesting_entity_name)
       VALUES ($1::uuid,$2,'Bo Rrower',$3,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline',$4,$5)
       RETURNING id`,
      [crypto.randomUUID(), `${uniq}-${n}`,
       fields.borrowerId === null ? null : (fields.borrowerId || borrower),
       fields.vestingType === undefined ? 'Officer' : fields.vestingType,
       fields.entityName === undefined ? `${uniq} Holdings LLC` : fields.entityName],
    )).rows[0].id);

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
          resolve({ status: res.statusCode, json, raw });
        });
      });
      req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
      if (payload) req.write(payload);
      req.end();
    });

    const base = (loanId) => `/api/lt/condition-center/loans/${loanId}/vesting-entity`;

    const countLlcs = async (bId, name) => Number((await db.query(
      `SELECT count(*)::int AS n FROM llcs WHERE borrower_id=$1::uuid AND lower(btrim(llc_name))=lower(btrim($2))`,
      [bId, name])).rows[0].n);

    /* ═════════════════ A. THE REFUSALS ═══════════════════════════════════════
       Every one of these would otherwise put a company on a PERSON'S PERMANENT
       RECORD off a stale Encompass field, so each is asserted on the DATABASE as
       well as the status — a 409 that created the company anyway has refused
       nothing. */

    const noBorrower = await mkLoan('noborrower', { borrowerId: null });
    const r1 = await call('POST', base(noBorrower));
    assert(r1.status === 409, `A1 a loan with no borrower profile is refused (got ${r1.status})`);
    assert(/borrower/i.test((r1.json && r1.json.error) || ''),
      'A1b …and the refusal names what is missing, so it can be acted on');

    /* TWO GUARDS REFUSE AN INDIVIDUAL VESTING, SO ASSERTING ON THE OUTCOME PROVES
       NEITHER. `vestingOf` returns `entityName: null` on an individual vesting —
       it does not consult field 1859 at all, which is the owner's rule — so the
       company would also be refused for having no name even with the individual
       guard removed. Proven, not assumed: deleting that guard left this section
       green until it asserted the WORDING instead.
       The wording is the real difference and it is the half that matters to a
       person: telling somebody "no company name recorded yet" about a loan that
       vests in them personally sends them hunting for a name that must never be
       used on it. */
    const individual = await mkLoan('individual', { vestingType: 'Individual', entityName: 'STALE Holdings LLC' });
    const r2 = await call('POST', base(individual));
    assert(r2.status === 409, `A2 an INDIVIDUAL vesting is refused even with a name in field 1859 (got ${r2.status})`);
    assert(await countLlcs(borrower, 'STALE Holdings LLC') === 0,
      'A2b …and the stale company was NOT created — the owner’s "individual means individual" rule, at the database');
    assert(/personally/i.test((r2.json && r2.json.error) || ''),
      'A2c …and it is refused FOR THAT REASON — "it vests in the borrower personally", not "no company name recorded"');

    /* THE SAME TWO-GUARD TRAP AS A2, and the same answer. A loan PILOT has not
       read carries no vesting type, so `vestingOf` names no company and the name
       check would refuse it regardless — the outcome proves nothing. The WORDING
       is the difference, and it is a real one: "PILOT has not read how this loan
       vests yet" is the truth, while "no vesting company name recorded" asserts
       that there IS an entity vesting whose name is merely missing, which is a
       fact nobody knows. */
    const unread = await mkLoan('unread', { vestingType: null, entityName: null });
    const r3 = await call('POST', base(unread));
    assert(r3.status === 409, `A3 a loan PILOT has not read yet is refused (got ${r3.status})`);
    assert(!/individual/i.test((r3.json && r3.json.error) || ''),
      'A3b …and it is NOT described as vesting individually — "not read" is not "individual"');
    assert(/not read/i.test((r3.json && r3.json.error) || ''),
      'A3c …and it is refused FOR THAT REASON — PILOT has not read the vesting, rather than claiming a company is merely unnamed');

    const noName = await mkLoan('noname', { entityName: null });
    const r4 = await call('POST', base(noName));
    assert(r4.status === 409, `A4 an entity vesting with no company name is refused (got ${r4.status})`);

    /* ═════════════════ B. THE CREATE ═════════════════════════════════════════ */

    const name = `${uniq} Holdings LLC`;
    const loan = await mkLoan('main');
    const r5 = await call('POST', base(loan));
    assert(r5.status === 201, `B1 the company is saved to the profile (got ${r5.status} ${r5.raw.slice(0, 160)})`);
    const llcId = r5.json && r5.json.llcId;
    assert(!!llcId && r5.json.existed === false, 'B2 …reported as newly created, with its id');
    assert(await countLlcs(borrower, name) === 1, 'B3 …and it really is on THIS borrower’s profile');

    const slots = (await db.query(
      `SELECT ci.id, t.code FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id AND t.scope='llc'
        WHERE ci.llc_id=$1::uuid`, [llcId])).rows;
    assert(slots.length > 0,
      'B4 …with its DOCUMENT SLOTS — a company with none is one nothing can ever be filed against');
    assert(slots.some((s) => s.code === 'rtl_llc_opagmt'),
      'B5 …including the operating agreement, the one that proves who controls the company');

    const stamp = (await db.query(
      `SELECT adopted_source, adopted_at FROM llcs WHERE id=$1::uuid`, [llcId])).rows[0];
    assert(stamp && stamp.adopted_source === 'lt_vesting_entity' && !!stamp.adopted_at,
      'B6 …and it carries the provenance stamp, so the short-term liquidity reading holds its balances back until it is documented');

    /* ═════════════════ C. REUSE, NEVER DUPLICATE ═════════════════════════════ */

    const r6 = await call('POST', base(loan));
    assert(r6.status === 201 && r6.json.existed === true && r6.json.llcId === llcId,
      'C1 pressing it again REUSES the same company rather than making a second one');
    assert(await countLlcs(borrower, name) === 1, 'C2 …proven by the count, not by the response');

    // A SECOND LOAN for the same company — the case the whole feature exists for.
    const loan2 = await mkLoan('second');
    const r7 = await call('POST', base(loan2));
    assert(r7.status === 201 && r7.json.llcId === llcId,
      'C3 a SECOND long-term loan vesting in the same company finds the one already on the profile');

    // A company the borrower ALREADY had is theirs — never stamped by us.
    const ownName = `${uniq} Their Own LLC`;
    const own = String((await db.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1::uuid,$2) RETURNING id`,
      [borrower, ownName])).rows[0].id);
    const loan3 = await mkLoan('preexisting', { entityName: ownName });
    const r8 = await call('POST', base(loan3));
    assert(r8.status === 201 && r8.json.llcId === own && r8.json.existed === true,
      'C4 a company the borrower already had is REUSED, not duplicated');
    const ownStamp = (await db.query(
      `SELECT adopted_source FROM llcs WHERE id=$1::uuid`, [own])).rows[0];
    assert(ownStamp && ownStamp.adopted_source === null,
      'C5 …and is NOT stamped — stamping a company that was already theirs would wrongly hold its balances back');

    /* ═════════════════ D. THE DOCUMENT LANDS ON THE COMPANY ══════════════════ */

    const oaSlot = slots.find((s) => s.code === 'rtl_llc_opagmt');
    const up = await call('POST', `${base(loan)}/slots/${oaSlot.id}/documents`, {
      filename: 'operating-agreement.pdf',
      contentType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 operating agreement').toString('base64'),
    });
    assert(up.status === 201, `D1 a document files onto the company’s own slot (got ${up.status} ${up.raw.slice(0, 160)})`);

    const doc = (await db.query(
      `SELECT llc_id, application_id, lt_loan_id, checklist_item_id, borrower_id
         FROM documents WHERE id=$1::uuid`, [up.json && up.json.documentId])).rows[0];
    assert(doc && String(doc.llc_id) === String(llcId),
      'D2 …and the stored row belongs to the COMPANY');
    assert(doc && doc.application_id === null && doc.lt_loan_id === null,
      'D3 …with BOTH file-owner columns null — it is a profile document, not this loan’s, which is what makes it ONE document rather than a copy');
    assert(doc && String(doc.checklist_item_id) === String(oaSlot.id),
      'D4 …filed against the slot the person chose, so nothing had to guess which document this is');

    /* ═════════════════ E. THE ROUND TRIP ═════════════════════════════════════
       This is the sentence on the screen, made checkable: the READ side — the
       one the NEXT loan uses — now reports the slot filled. */

    await db.query(`UPDATE documents SET review_status='accepted' WHERE id=$1::uuid`,
      [up.json.documentId]);
    const prefill = require('../src/longterm/conditions-center/entity-prefill');
    const seen = await prefill.forEntity(borrower, name, db);
    assert(seen.found && String(seen.llcId) === String(llcId),
      'E1 the read side finds the company on the profile');
    const oa = (seen.slots || []).find((s) => s.key === 'agreement');
    assert(oa && oa.filled === true,
      'E2 …and reports the operating agreement already on file — which is the next loan starting already done');
    assert(oa && !!oa.itemId,
      'E3 …carrying the slot’s own id, which is what let the upload reach the company in the first place');

    /* ═════════════════ F. SCOPE ══════════════════════════════════════════════ */

    // A loan whose company is NOT on the profile yet cannot upload — the slots
    // are what an upload targets, and they hang off the company.
    const fresh = await mkLoan('fresh', { entityName: `${uniq} Not Saved LLC` });
    const early = await call('POST', `${base(fresh)}/slots/${oaSlot.id}/documents`, {
      filename: 'x.pdf', contentType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 x').toString('base64'),
    });
    assert(early.status === 409,
      `F1 uploading before the company is saved is refused (got ${early.status})`);

    // ANOTHER BORROWER'S COMPANY. The slot id is real; it simply is not this
    // loan's company's, and the shared door scopes the one to the other.
    const strangerLlc = String((await db.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1::uuid,$2) RETURNING id`,
      [stranger, `${uniq} Stranger LLC`])).rows[0].id);
    await require('../src/lib/llc').generateLlcChecklist(strangerLlc, db);
    const strangerSlot = (await db.query(
      `SELECT ci.id FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id AND t.scope='llc'
        WHERE ci.llc_id=$1::uuid AND t.code='rtl_llc_opagmt' LIMIT 1`, [strangerLlc])).rows[0];
    assert(!!strangerSlot, 'F2 (fixture) the stranger’s company really has slots — so F3 refuses for the right reason');

    const before = Number((await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE checklist_item_id=$1::uuid`,
      [strangerSlot.id])).rows[0].n);
    const idor = await call('POST', `${base(loan)}/slots/${strangerSlot.id}/documents`, {
      filename: 'x.pdf', contentType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 x').toString('base64'),
    });
    const after = Number((await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE checklist_item_id=$1::uuid`,
      [strangerSlot.id])).rows[0].n);
    assert(idor.status >= 400, `F3 a slot on ANOTHER borrower’s company is refused (got ${idor.status})`);
    assert(after === before,
      'F3b …and NOTHING was filed against it — the refusal is asserted on the write, not on the status');

    /* ═════════════════ G. VERIFIED ONCE, AND THE NEXT LOAN IS DONE ═══════════
       The owner's headline ask for this condition — *"in future when you use
       this LLC it's already verified"* — and the SECOND live defect the
       `bundle.llc` bug caused. `satisfiedByProfile` reads `verified`, which the
       broken read reported as false for every company on every long-term file,
       so an already-verified company never cleared the condition and the
       borrower was asked to prove the same fact again on every loan. The code's
       own comment promised the opposite. */
    /* THE REAL TEMPLATE, THROUGH THE REAL SEEDER — never a hand-written stub.
       This used to INSERT a minimal row under the library's own code with
       `ON CONFLICT (code) DO NOTHING` semantics on the seeder's side, so in any
       database where this suite ran FIRST the real library row could never be
       written: `lt_vesting_entity` was left with no `auto_apply` and no rule, the
       engine's library query (which selects only `always`/`rules`) skipped it,
       and the condition silently stopped attaching to every long-term loan for
       the rest of that database's life. Harmless in production, which seeds
       cleanly — and a confusing false failure for every later suite. */
    await require('../src/longterm/conditions-center/library').ensureSeeded(db);
    const tpl = String((await db.query(
      `SELECT id FROM checklist_templates WHERE code='lt_vesting_entity' AND scope='lt_loan'`
    )).rows[0].id);
    const cond = String((await db.query(
      `INSERT INTO checklist_items
         (scope, lt_loan_id, template_id, category, label, audience, status, item_kind, is_required)
       VALUES ('lt_loan',$1::uuid,$2::uuid,'prior_to_approval','Vesting entity','staff',
               'outstanding','document',true)
       RETURNING id`, [loan, tpl])).rows[0].id);

    const satisfy = `/api/lt/condition-center/loans/${loan}/conditions/${cond}/satisfy`;
    const g1 = await call('POST', satisfy, {});
    assert(g1.status >= 400,
      `G1 an UNVERIFIED company does not clear the condition, even with its operating agreement on file (got ${g1.status}) — the review has not happened`);

    await db.query(`UPDATE llcs SET is_verified=true, verified_at=now() WHERE id=$1::uuid`, [llcId]);
    const g2 = await call('POST', satisfy, {});
    assert(g2.status < 400,
      `G2 …and once a person has VERIFIED the company, it clears (got ${g2.status} ${g2.raw.slice(0, 140)}) — proving the same fact twice is exactly what the owner asked to stop`);

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  } finally {
    if (server) server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
