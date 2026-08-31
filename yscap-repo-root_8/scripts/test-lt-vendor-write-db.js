'use strict';
/**
 * ONE VENDOR DIRECTORY, TWO PRODUCTS — the long-term WRITE half, and the proof that
 * the short-term suggester did not move a byte.
 *
 * =============================================================================
 * WHAT THIS SUITE IS ABOUT
 * =============================================================================
 *
 * Owner-directed 2026-08-30 (docs/longterm/SHARE-THE-CODE-DIRECTIVE.md): *"the
 * FileContacts should come directly from the short-term side … it should be the
 * exact same vendor setup and use the same information … No parallel contact store
 * may ever exist on the LT side."*
 *
 * Until this change the long-term orders desk could only LINK a `service_contacts`
 * card that somebody had already created on a SHORT-TERM file. A desk that can link
 * and never create is exactly the pressure that produces a parallel store: the
 * title company's details end up in a spreadsheet, or in the order's free text, or
 * typed again on the next loan. So the desk gained two doors — create-and-link, and
 * edit — and BOTH write the SHARED card.
 *
 * Three things are proven here, and each one is a different kind of claim:
 *
 *   A. THE CONTROL — the short-term suggester answers BYTE-IDENTICALLY before and
 *      after the change that made its "used on N files" count injectable. The
 *      baseline is built by STRIPPING the change out of today's source, never by
 *      reading git: a git baseline stops proving anything the moment the change is
 *      committed, because HEAD then carries it too and the comparison degenerates
 *      into "the module equals itself".
 *   B. THE LONG-TERM WRITE — over real HTTP, on a real Postgres: a card lands in
 *      `service_contacts`, a link lands in `lt_loan_vendors`, the email scalar and
 *      the `emails` array agree, an edit corrects the SHARED card, and the refusals
 *      refuse.
 *   C. THE SEAM ITSELF — the same suggester, handed the long-term link table,
 *      counts long-term loans. That is what "the exact same vendor setup" means in
 *      code rather than in prose.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'none';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

/* ─────────────────────────────────────────────────────────────────────────────
   THE BASELINE — today's vendor-directory with the injectable count REMOVED.

   The strip has to be provably exact or the "byte-identical" claim is worthless:
   a regex that matches nothing quietly compares the module against ITSELF and
   passes forever. So every anchor is asserted to appear EXACTLY once before it is
   replaced, and the finished baseline is asserted to name the short-term link
   table directly and to carry no trace of the parameter. This is the
   `scripts/lib/engine-baseline.js` discipline, applied to a module that is not an
   engine.
   ───────────────────────────────────────────────────────────────────────────── */
function buildPreChangeVendorDirectory() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'vendor-directory.js'), 'utf8');
  const strips = [
    // The parameter, back to the pre-change signature.
    [/async function suggest\(\{\n\s*type, q = '', borrowerId = null, audience = 'borrower', limit = 12,\n\s*usedCountFrom = 'application_service_contacts',\n\} = \{\}, dbc = null\) \{/g,
      "async function suggest({ type, q = '', borrowerId = null, audience = 'borrower', limit = 12 } = {}, dbc = null) {"],
    // The identifier guard and the built fragment, gone entirely.
    [/\n {4}\/\* THE ONLY INTERPOLATED THING[\s\S]*?const usedCountSql = linkTable === null\n\s*\? '0'\n\s*: `\(SELECT count\(\*\)::int FROM \$\{linkTable\} x WHERE x\.service_contact_id = sc\.id\)`;\n/g, '\n'],
    // The SELECT list, back to the hard-coded subquery.
    [/\$\{usedCountSql\} AS files_used/g,
      '(SELECT count(*)::int FROM application_service_contacts x WHERE x.service_contact_id = sc.id) AS files_used'],
  ];
  let out = src;
  for (const [re, replacement] of strips) {
    const hits = src.match(re) || [];
    assert.strictEqual(hits.length, 1,
      `the baseline strip must match its anchor EXACTLY once (got ${hits.length} for ${re}) — a strip that misses `
      + 'leaves the change in the baseline and makes the whole comparison a tautology');
    out = out.replace(re, replacement);
  }
  /* COMMENTS ARE STRIPPED BEFORE THE "no trace" CHECK. This module's header
     necessarily NAMES the parameter to explain why it exists, and a guard that read
     the prose would fail on that explanation and then get "fixed" by deleting it. */
  const codeOnly = out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/usedCountFrom/.test(codeOnly), 'the baseline must carry no trace of the injected parameter');
  assert.ok(out.includes('(SELECT count(*)::int FROM application_service_contacts x WHERE x.service_contact_id = sc.id) AS files_used'),
    'the baseline must count the short-term link table directly, as it did before');
  assert.notStrictEqual(out, src, 'the baseline must actually DIFFER from the current module');

  const file = path.join(os.tmpdir(), `vendor-directory-baseline-${process.pid}.js`);
  fs.writeFileSync(file, out);
  return { file, cleanup: () => { try { fs.unlinkSync(file); } catch (_) { /* best effort */ } } };
}

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-vendor-write');

  const app = require('../src/server');
  const C = require('../src/lib/crypto');
  const db = require('../src/db');
  const ltDb = require('../src/longterm/db');
  const VD = require('../src/lib/vendor-directory');
  const kinds = require('../src/longterm/orders/kinds');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.deepStrictEqual(a, b, w); checks++; };

  const stamp = `ltvw-${Date.now().toString(36)}`;
  const madeLoans = [];
  const madeBorrowers = [];
  const madeApps = [];
  const cardIds = [];
  let server = null;
  const baseline = buildPreChangeVendorDirectory();

  try {
    // ── FIXTURES ────────────────────────────────────────────────────────────
    const { rows: st } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, 'LT Vendor Admin', 'super_admin', true) RETURNING id, token_version`,
      [`${stamp}-admin@example.test`]);
    const admin = {
      id: String(st[0].id),
      token: C.signJwt({ sub: String(st[0].id), kind: 'staff', role: 'super_admin', tv: st[0].token_version, sid: stamp }),
    };

    const { rows: br } = await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Vendor', 'Borrower', $1) RETURNING id`,
      [`${stamp}-borrower@example.test`]);
    const borrowerId = String(br[0].id);
    madeBorrowers.push(borrowerId);

    const { rows: ln } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key, loan_folder, borrower_id)
       VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline', $2::uuid) RETURNING id`,
      [`${stamp}-1`, borrowerId]);
    const loanId = String(ln[0].id);
    madeLoans.push(loanId);

    // A SECOND loan with NO borrower on it — `service_contacts.borrower_id` has been
    // nullable since db/032 (the vendors screen writes company-wide cards with none),
    // so an early Encompass-mirrored loan must still be able to create a card.
    const { rows: ln2 } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key, loan_folder)
       VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline') RETURNING id`,
      [`${stamp}-2`]);
    const loanNoBorrower = String(ln2[0].id);
    madeLoans.push(loanNoBorrower);

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => {
      const r = await fetch(base + p, {
        method,
        headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      return { status: r.status, body: parsed, raw };
    };

    // =========================================================================
    console.log('\nA. THE CONTROL — the short-term suggester did not move');
    // =========================================================================
    // A directory fixture with enough shape to exercise the folding, the ordering
    // and the "used on N files" count: two rows describing ONE title company (one
    // richer than the other), one row belonging to somebody else, and a real
    // application link so the count is not uniformly zero.
    const { rows: appRow } = await db.query(
      `INSERT INTO applications (borrower_id, status, program, loan_type)
       VALUES ($1::uuid, 'underwriting', 'Standard Program', 'Purchase') RETURNING id`,
      [borrowerId]);
    const appId = String(appRow[0].id);
    madeApps.push(appId);

    const seedCard = async (fields) => {
      const { rows } = await db.query(
        `INSERT INTO service_contacts
           (borrower_id, contact_type, company_name, contact_name, email, emails, phone, address, last_used_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING id`,
        [fields.borrowerId || null, fields.contactType, fields.companyName || null, fields.contactName || null,
          fields.email || null, fields.emails || null, fields.phone || null, fields.address || null]);
      cardIds.push(String(rows[0].id));
      return String(rows[0].id);
    };
    const richId = await seedCard({
      borrowerId, contactType: 'title_company', companyName: `${stamp} Madison Title`,
      contactName: 'Sarah Klein', email: 'closing@madison.test', emails: ['closing@madison.test', 'sarah@madison.test'],
      phone: '5551234567', address: '1 Madison Ave',
    });
    await seedCard({
      borrowerId, contactType: 'title_company', companyName: `${stamp} Madison Title`,
      email: 'closing@madison.test',
    });
    await seedCard({
      contactType: 'title_company', companyName: `${stamp} Other Title`, email: 'hello@other.test',
    });
    await db.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type, added_by_kind, added_by_id)
       VALUES ($1::uuid, $2::uuid, 'title_company', 'staff', $3::uuid)`,
      [appId, richId, admin.id]);

    const before = require(baseline.file);
    /* THE POOL IS PASSED EXPLICITLY to both modules. The baseline lives outside the
       tree, so its own lazy `require('../db')` cannot resolve — and `dbc` is the
       injection seam the module has always carried, so handing both the SAME pool
       compares the STATEMENT rather than the plumbing. The default (no `dbc`) path
       is asserted separately below. */
    const ask = (mod, extra = {}) => mod.suggest({
      type: 'title_company', q: stamp, borrowerId, audience: 'staff', limit: 12, ...extra,
    }, db);

    const oldOut = await ask(before);
    const newOut = await ask(VD);
    const defaultPool = await VD.suggest({
      type: 'title_company', q: stamp, borrowerId, audience: 'staff', limit: 12,
    });
    eq(JSON.stringify(defaultPool), JSON.stringify(newOut),
      'the module still reaches for its own pool when handed none — the lazy default is untouched');
    ok(oldOut.length > 0, 'the fixture must actually produce suggestions, or "identical" is a tautology');
    eq(JSON.stringify(newOut), JSON.stringify(oldOut),
      'THE ONE THAT MATTERS: with nothing passed, the suggester answers byte-identically to the module '
      + 'without the change — every short-term type-ahead is unmoved');
    ok(oldOut.some((s) => s.usedCount === 1),
      'the control run really did count the short-term link table (so the comparison covers the changed line)');

    // Explicitly naming the short-term table is the same statement as the default.
    const named = await ask(VD, { usedCountFrom: 'application_service_contacts' });
    eq(JSON.stringify(named), JSON.stringify(oldOut), 'naming the default table explicitly changes nothing');

    /* `null` means "do not count", and the fold then falls back to the group size —
       the module's own long-standing behaviour for a row with no files. The two
       Madison rows fold into ONE suggestion, so the number MOVES (1 file → 2 rows):
       asserting a bare "at least one" would hold whether or not the skip did
       anything, and would prove nothing. */
    const madisonOf = (list) => list.find((s) => String(s.companyName || '').includes('Madison Title'));
    eq(madisonOf(oldOut).usedCount, 1, 'counted against the short-term link table, the folded pair stands for ONE file');
    const uncounted = await ask(VD, { usedCountFrom: null });
    eq(uncounted.length, oldOut.length, 'skipping the count returns the same suggestions');
    eq(madisonOf(uncounted).usedCount, 2, '…with no count at all, it falls back to the two rows it folded');

    /* A name that is not a plain identifier is REFUSED rather than spliced, and the
       refusal rides the module's own law (an assist, never a gate) — so it answers
       nothing rather than throwing at the caller.

       THE SCHEMA-QUALIFIED CASE IS THE ONE THAT DISCRIMINATES. A statement-injection
       attempt is refused by the driver anyway (a parameterised query may not carry a
       second statement), so with the guard REMOVED it would still answer nothing and
       the assertion would prove nothing about the guard. `public.<table>` is valid
       SQL that would splice cleanly and answer normally, so only the guard can turn
       it into a refusal. */
    const qualified = await ask(VD, { usedCountFrom: 'public.application_service_contacts' });
    eq(qualified, [], 'even a VALID schema-qualified name is refused — the shape allowed is a bare identifier, nothing else');
    const injected = await ask(VD, { usedCountFrom: 'application_service_contacts x; DROP TABLE service_contacts --' });
    eq(injected, [], 'a link table carrying a second statement answers nothing and splices nothing');
    const { rows: stillThere } = await db.query('SELECT 1 FROM service_contacts WHERE id = $1::uuid', [richId]);
    ok(stillThere.length === 1, '…and the directory is still there');

    // =========================================================================
    console.log('\nB. THE LONG-TERM CREATE-AND-LINK DOOR');
    // =========================================================================
    const created = await call('POST', `/api/lt/orders/loans/${loanId}/vendors/new`, {
      kind: 'title',
      companyName: `${stamp} Bishop Title Agency`,
      contactName: 'Dov Weiss',
      // The email pair rule's own trap: a duplicate in a different casing, and a
      // blank, both of which must fold away before either column is written.
      emails: ['Closing@Bishop.test', 'ap@bishop.test', 'closing@bishop.test', ''],
      phone: '(555) 987-6543',
      address: '10 Bishop St',
      notes: 'Asks for the CPL first',
    });
    ok(created.status === 201, `the create-and-link door answers 201 (got ${created.status} ${created.raw})`);
    ok(created.body && created.body.contactId && created.body.linkId, '…naming the card it made and the link it made');

    const { rows: card } = await db.query(
      `SELECT borrower_id, contact_type, custom_type, company_name, contact_name, email, emails, phone, address, notes,
              added_by_staff_id
         FROM service_contacts WHERE id = $1::uuid`, [created.body.contactId]);
    ok(card.length === 1, 'the card is in the SHARED directory');
    cardIds.push(String(created.body.contactId));
    eq(card[0].contact_type, 'title_company',
      'the long-term kind is filed under the directory\'s OWN word, so the short-term type-ahead can find it');
    eq(card[0].custom_type, null, 'a kind the directory has a word for carries no free text');
    eq(String(card[0].borrower_id), borrowerId, 'the card hangs off the loan\'s borrower, so it reaches their profile');
    eq(card[0].email, 'Closing@Bishop.test', 'THE EMAIL PAIR: the scalar is the FIRST of the array');
    eq(card[0].emails, ['Closing@Bishop.test', 'ap@bishop.test'],
      '…and the array carries every address, case-duplicate and blank folded away');
    eq(card[0].company_name, `${stamp} Bishop Title Agency`, 'the company is stored');
    eq(card[0].notes, 'Asks for the CPL first', 'the note is stored');
    eq(String(card[0].added_by_staff_id), admin.id, 'the card records who entered it, exactly as a short-term card does');

    const { rows: link } = await ltDb.query(
      `SELECT kind, is_primary, service_contact_id FROM lt_loan_vendors WHERE id = $1::uuid AND loan_id = $2::uuid`,
      [created.body.linkId, loanId]);
    ok(link.length === 1, 'the link is on the long-term loan');
    eq(link[0].kind, 'title', '…for the job it was entered under');
    eq(link[0].is_primary, true, '…and it is the card the order is addressed to');
    eq(String(link[0].service_contact_id), String(created.body.contactId), '…pointing at the shared card');

    const listed = await call('GET', `/api/lt/orders/loans/${loanId}/vendors`);
    eq(listed.status, 200, 'the desk reads the loan\'s contacts');
    const shown = (listed.body.vendors || []).find((v) => v.id === created.body.linkId);
    ok(shown && shown.companyName === `${stamp} Bishop Title Agency` && shown.missing === false,
      '…and shows the new card as present, not as a missing one');
    eq(shown.emails, ['Closing@Bishop.test', 'ap@bishop.test'],
      '…reading BOTH email columns through the one shared definition');

    // The kinds the directory has no word for keep their long-term label.
    const hoa = await call('POST', `/api/lt/orders/loans/${loanId}/vendors/new`, {
      kind: 'hoa', companyName: `${stamp} Bishop Court Association`, email: 'board@bishopcourt.test',
    });
    ok(hoa.status === 201, 'an HOA can be entered too');
    cardIds.push(String(hoa.body.contactId));
    const { rows: hoaCard } = await db.query(
      'SELECT contact_type, custom_type FROM service_contacts WHERE id = $1::uuid', [hoa.body.contactId]);
    eq(hoaCard[0].contact_type, 'other', 'a kind the directory has no word for is filed under `other`');
    eq(hoaCard[0].custom_type, 'HOA management company', '…and says what it is in the free-text field');

    // A loan whose borrower link has not been made yet still gets a usable card.
    const noBorrower = await call('POST', `/api/lt/orders/loans/${loanNoBorrower}/vendors/new`, {
      kind: 'realtor', contactName: `${stamp} Unlinked Loan Realtor`, phone: '5550001111',
    });
    ok(noBorrower.status === 201, 'a loan with no borrower on it can still create a card, not a 500');
    cardIds.push(String(noBorrower.body.contactId));
    const { rows: orphan } = await db.query(
      'SELECT borrower_id, contact_type FROM service_contacts WHERE id = $1::uuid', [noBorrower.body.contactId]);
    eq(orphan[0].borrower_id, null, '…with no borrower on the card, which is a company-wide card and legal since db/032');
    eq(orphan[0].contact_type, 'realtor', '…still filed under the right directory type');

    // Refusals.
    const badKind = await call('POST', `/api/lt/orders/loans/${loanId}/vendors/new`, {
      kind: 'not_a_kind', companyName: `${stamp} Nowhere Inc`,
    });
    eq(badKind.status, 400, 'a kind the desk does not carry is refused before Postgres sees it');
    const empty = await call('POST', `/api/lt/orders/loans/${loanId}/vendors/new`, { kind: 'title' });
    eq(empty.status, 400, 'a card with no detail on it is refused — it is a row that will be typed again');
    const { rows: nothingExtra } = await ltDb.query(
      'SELECT count(*)::int AS n FROM lt_loan_vendors WHERE loan_id = $1::uuid', [loanId]);
    eq(nothingExtra[0].n, 2, 'a refused create leaves nothing behind');

    // =========================================================================
    console.log('\nC. THE EDIT DOOR — one company, one card, corrected in one place');
    // =========================================================================
    // A SECOND loan links the SAME card, so the edit can be shown to reach both.
    const { rows: ln3 } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key, loan_folder, borrower_id)
       VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline', $2::uuid) RETURNING id`,
      [`${stamp}-3`, borrowerId]);
    const otherLoan = String(ln3[0].id);
    madeLoans.push(otherLoan);
    const linkedElsewhere = await call('POST', `/api/lt/orders/loans/${otherLoan}/vendors`, {
      kind: 'title', serviceContactId: created.body.contactId,
    });
    eq(linkedElsewhere.status, 200, 'the existing link door still links the same card to another loan');

    const edited = await call('PATCH', `/api/lt/orders/loans/${loanId}/vendors/${created.body.linkId}`, {
      kind: 'title',
      companyName: `${stamp} Bishop Title Agency LLC`,
      contactName: 'Dov Weiss',
      emails: ['newclosing@bishop.test', 'ap@bishop.test'],
      phone: '(555) 987-6543',
      address: '12 Bishop St',
      notes: 'Moved offices',
    });
    eq(edited.status, 200, 'the edit door answers');
    eq(String(edited.body.contactId), String(created.body.contactId),
      '…and edits the SAME shared card rather than making a second one');

    const { rows: after } = await db.query(
      'SELECT company_name, email, emails, address, notes, contact_type FROM service_contacts WHERE id = $1::uuid',
      [created.body.contactId]);
    eq(after[0].company_name, `${stamp} Bishop Title Agency LLC`, 'the correction landed on the shared card');
    eq(after[0].email, 'newclosing@bishop.test', 'THE EMAIL PAIR HOLDS ON AN EDIT: the scalar moved with the array');
    eq(after[0].emails, ['newclosing@bishop.test', 'ap@bishop.test'], '…and the array is the full set');
    eq(after[0].address, '12 Bishop St', 'the address moved');

    const otherLoanView = await call('GET', `/api/lt/orders/loans/${otherLoan}/vendors`);
    const onOther = (otherLoanView.body.vendors || []).find((v) => String(v.serviceContactId) === String(created.body.contactId));
    eq(onOther.companyName, `${stamp} Bishop Title Agency LLC`,
      'ONE COMPANY, ONE CARD: the other loan sees the correction with nothing to sync');

    // Moving the card to another job moves the link AND the card's directory type.
    const moved = await call('PATCH', `/api/lt/orders/loans/${loanId}/vendors/${created.body.linkId}`, {
      kind: 'buyers_attorney', companyName: `${stamp} Bishop Title Agency LLC`,
      emails: ['newclosing@bishop.test', 'ap@bishop.test'],
    });
    eq(moved.status, 200, 'a card can be moved to another job on the loan');
    const { rows: movedLink } = await ltDb.query(
      'SELECT kind FROM lt_loan_vendors WHERE id = $1::uuid', [created.body.linkId]);
    eq(movedLink[0].kind, 'buyers_attorney', '…the link records the new job');
    const { rows: movedCard } = await db.query(
      'SELECT contact_type FROM service_contacts WHERE id = $1::uuid', [created.body.contactId]);
    eq(movedCard[0].contact_type, 'attorney',
      '…and the card follows it into the directory type that job maps to, because the type lives ON the card');
    // Put it back so the rest of the suite reads a title company.
    await call('PATCH', `/api/lt/orders/loans/${loanId}/vendors/${created.body.linkId}`, {
      kind: 'title', companyName: `${stamp} Bishop Title Agency LLC`,
      emails: ['newclosing@bishop.test', 'ap@bishop.test'],
    });

    // A save that does not mention the kind leaves the card filed where it is.
    await call('PATCH', `/api/lt/orders/loans/${loanId}/vendors/${created.body.linkId}`, {
      companyName: `${stamp} Bishop Title Agency LLC`,
      emails: ['newclosing@bishop.test', 'ap@bishop.test'], phone: '5559876543',
    });
    const { rows: keptType } = await db.query(
      'SELECT contact_type FROM service_contacts WHERE id = $1::uuid', [created.body.contactId]);
    eq(keptType[0].contact_type, 'title_company', 'an edit that says nothing about the kind keeps the card where it is');

    // Refusals on the edit door.
    const foreign = await call('PATCH', `/api/lt/orders/loans/${loanNoBorrower}/vendors/${created.body.linkId}`, {
      companyName: 'Somebody Else', email: 'x@y.test',
    });
    eq(foreign.status, 404,
      'a link id from another loan matches no row as a property of the query — not a check made afterwards');
    const blankEdit = await call('PATCH', `/api/lt/orders/loans/${loanId}/vendors/${created.body.linkId}`, {});
    eq(blankEdit.status, 400, 'an edit that empties the card is refused');
    const { rows: unmoved } = await db.query(
      'SELECT company_name FROM service_contacts WHERE id = $1::uuid', [created.body.contactId]);
    eq(unmoved[0].company_name, `${stamp} Bishop Title Agency LLC`, '…and the card is untouched');

    // A link whose card was deleted from the directory reads as gone, not as an error.
    const goneCardId = await seedCard({ borrowerId, contactType: 'realtor', companyName: `${stamp} Vanishing Realty` });
    const goneLink = await call('POST', `/api/lt/orders/loans/${loanId}/vendors`, {
      kind: 'realtor', serviceContactId: goneCardId,
    });
    eq(goneLink.status, 200, 'a card can be linked before it disappears');
    const { rows: goneLinkRow } = await ltDb.query(
      `SELECT id FROM lt_loan_vendors WHERE loan_id = $1::uuid AND service_contact_id = $2::uuid`,
      [loanId, goneCardId]);
    await db.query('DELETE FROM service_contacts WHERE id = $1::uuid', [goneCardId]);
    const editGone = await call('PATCH', `/api/lt/orders/loans/${loanId}/vendors/${goneLinkRow[0].id}`, {
      companyName: `${stamp} Vanishing Realty`, email: 'gone@nowhere.test',
    });
    eq(editGone.status, 404, 'editing a card that is no longer in the directory is a 404, not a silent ok');

    // =========================================================================
    console.log('\nD. THE SEAM — the same suggester, counting long-term loans');
    // =========================================================================
    // The card is on ONE long-term loan (the title link on `loanId`; the buyers-attorney
    // move was put back) and on ONE more (`otherLoan`), and on NO short-term files.
    const ltCounts = await VD.suggest({
      type: 'title_company', q: `${stamp} Bishop`, borrowerId, audience: 'staff', limit: 12,
      usedCountFrom: 'lt_loan_vendors',
    }, ltDb);
    const bishop = ltCounts.find((s) => String(s.companyName || '').includes('Bishop Title'));
    ok(bishop, 'the shared suggester finds the card the long-term desk created');
    eq(bishop.usedCount, 2, '…and, handed the long-term link table, counts the long-term loans it is on');
    eq(bishop.emails, ['newclosing@bishop.test', 'ap@bishop.test'],
      '…folding both email columns through the one shared definition');

    const rtlCounts = await VD.suggest({
      type: 'title_company', q: `${stamp} Bishop`, borrowerId, audience: 'staff', limit: 12,
    });
    const bishopRtl = rtlCounts.find((s) => String(s.companyName || '').includes('Bishop Title'));
    ok(bishopRtl, 'the SAME card is offered to the short-term type-ahead — one directory, both products');
    eq(bishopRtl.usedCount, 1,
      '…counted against SHORT-TERM files, of which it is on none, so the fold falls back to the one row it stands for');

    // The mapping the write half depends on: every long-term kind files under a type
    // the short-term suggester will actually search.
    for (const kind of Object.keys(kinds.VENDOR_KINDS)) {
      const dir = kinds.directoryTypeFor(kind);
      ok(dir && VD.SUGGEST_TYPES.has(dir.contactType),
        `the '${kind}' card is filed under a type the directory can suggest ('${dir && dir.contactType}') — `
        + 'a card nobody can find again is a card that gets typed twice');
    }
    eq(kinds.directoryTypeFor('nope'), null, 'a kind the desk does not carry maps to nothing, never to a default');
  } finally {
    baseline.cleanup();
    if (madeLoans.length) {
      await ltDb.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
    }
    if (madeApps.length) {
      await db.query('DELETE FROM applications WHERE id = ANY($1::uuid[])', [madeApps]).catch(() => {});
    }
    /* EVERY card this run made is removed BY ID. Several of them deliberately carry
       no borrower (a company-wide card is legal since db/032), so the borrower
       CASCADE cannot be relied on to take them away — and a card left behind folds
       into the next run's suggestions and makes it fail for a reason that is a fact
       about the leftovers rather than about the code. */
    if (cardIds.length) {
      await db.query('DELETE FROM service_contacts WHERE id = ANY($1::uuid[])', [cardIds]).catch(() => {});
    }
    if (madeBorrowers.length) {
      await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [madeBorrowers]).catch(() => {});
    }
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    if (server) server.close();
    await Promise.race([
      Promise.all([db.pool.end().catch(() => {}), ltDb.pool.end().catch(() => {})]),
      new Promise((r) => setTimeout(r, 3000).unref()),
    ]);
  }

  console.log(`\n✓ lt vendor write (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt vendor write (db) FAILED');
  console.error(e);
  process.exit(1);
});
