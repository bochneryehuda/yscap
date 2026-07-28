'use strict';
/*
 * ENCOMPASS BUILDS THE PROFILE — the weekly READ-ONLY enrichment (owner-directed
 * 2026-07-26).
 *
 * "Pull every week all the Encompass data and use that … extra LLC names field
 * 1859 from each and every file to link extra track record and extra LLCs and
 * build up more borrower profile … with more phone numbers, more email
 * addresses. Verify their primary address according to the last file and let me
 * know if there's any conflict in the manual review section. … Don't use it to
 * create more files and more loans. Just read only."
 *
 * Every clause of that is a test here. The two that matter most are the ones a
 * regression would be silent about: the pass must never CREATE a loan file or
 * write to Encompass, and a home-address disagreement must never overwrite what
 * a human already put on the profile.
 *
 * Pure half always runs; the DB half needs DATABASE_URL and rolls back.
 */
const path = require('path');
const fs = require('fs');

let passes = 0, failures = 0;
const ok = (c, m) => { if (c) { passes++; } else { failures++; console.log(`FAIL ${m}`); } };

const enrich = require('../src/encompass/enrich');
const I = enrich._internals;

// ---- pure: extraction ------------------------------------------------------
{
  // FIELD 1859 is the owner-named source of EXTRA entity names, and it is
  // free text where people list several.
  const loan = {
    customFields: [
      { fieldName: 'CX.LLCNAME', value: 'Main Vesting LLC' },
      { fieldName: 'CX.LLCSTATE', value: 'NY' },
      { fieldName: '1859', value: 'Second Holdings LLC; Third Ventures LLC\nFourth Equities LLC' },
    ],
  };
  const names = I.vestingLlcs(loan).map((l) => l.name);
  ok(names.length === 4, 'field 1859 contributes EXTRA entities alongside the vesting one');
  ok(names[0] === 'Main Vesting LLC', 'the dedicated vesting field stays first');
  ok(names.includes('Third Ventures LLC') && names.includes('Fourth Equities LLC'),
    'a semicolon AND a newline both separate entities in the free-text list');
  ok(I.vestingLlcs(loan).every((l) => l.state === 'NY'), 'the formation state rides along');

  // A comma is NOT a separator — "Smith Holdings, LLC" is ONE entity, and
  // splitting on it would manufacture a bogus "LLC" row on a huge share of files.
  ok(I.splitEntityNames('Smith Holdings, LLC').length === 1,
    'a comma never splits an entity name ("Smith Holdings, LLC" is one company)');
  ok(I.splitEntityNames('N/A').length === 0 && I.splitEntityNames('LLC').length === 0
    && I.splitEntityNames('  ').length === 0, 'filler values are not entities');
  ok(I.vestingLlcs({}).length === 0, 'a loan with no entity fields contributes none — never invented');
  // The old single-value accessor still behaves for existing callers.
  ok(I.vestingLlc(loan).name === 'Main Vesting LLC' && I.vestingLlc({}) === null,
    'the original single-LLC accessor is unchanged');
  // Case-duplicates across two fields collapse to one.
  ok(I.vestingLlcs({ customFields: [{ fieldName: 'CX.LLCNAME', value: 'Alpha LLC' }, { fieldName: '1859', value: 'alpha llc' }] }).length === 1,
    'the same entity named in two fields is added once');

  // CONTACTS — every way to reach the person, cleaned.
  const party = {
    firstName: 'Leib', lastName: 'Lichtman',
    emailAddressText: 'Leib@Shomrim.COM', workEmail: 'leib@office.shomrim.com',
    mobilePhone: '(845) 825-0374', homePhoneNumber: '18458250374', workPhone: '718-555-0100',
  };
  const c = I.partyContacts(party);
  ok(c.emails.length === 2 && c.emails[0] === 'leib@shomrim.com',
    'every email on the file is captured, lower-cased');
  ok(c.phones.length === 2, 'a home number that is the SAME 10 digits as the cell is not a second number');
  ok(c.phones.includes('(718) 555-0100'), 'a work line IS a second number and is kept');
  ok(I.cleanEmail('nobody@clickup.local') === null, 'a synthesized shadow address is not a way to reach anyone');
  ok(I.cleanEmail('not-an-email') === null && I.cleanEmail('') === null, 'junk is not an email');
  ok(I.cleanEmail('someone@mail.example.com') === null, 'a reserved documentation domain cannot receive mail, sub-domain or not');
  ok(I.cleanPhone('555-01') === null, 'a partial number is unusable');
  ok(I.cleanPhone('0000000000') === null, 'filler digits are not a phone number');
  ok(I.cleanPhone('+1 (845) 825-0374') === '(845) 825-0374', 'a country code is normalized away');
  ok(I.partyContacts(null).emails.length === 0, 'a missing party yields nothing, never a throw');

  // THE PERSON'S OWN ADDRESS — not the subject property.
  const withResidences = {
    residences: [
      { residencyType: 'Prior', addressStreetLine1: '1 Old Rd', addressCity: 'Monsey', addressState: 'NY', addressPostalCode: '10952' },
      { residencyType: 'Current', addressStreetLine1: '10 New Way', addressCity: 'Monsey', addressState: 'NY', addressPostalCode: '10952' },
    ],
  };
  ok(/10 New Way/.test(I.partyAddress(withResidences).oneLine), 'the CURRENT residence wins over a prior one');
  ok(I.partyAddress({ urla2020StreetAddress: '5 Flat St', urla2020City: 'Lakewood', urla2020State: 'NJ', urla2020PostalCode: '08701' }).city === 'Lakewood',
    'a flat URLA-shaped party is read too (schema vintages differ per loan)');
  ok(I.partyAddress({ addressCity: 'Brooklyn', addressState: 'NY' }) === null,
    'a city with no street is a FRAGMENT, not an address — never stored as one');
  ok(I.partyAddress({}) === null && I.partyAddress(null) === null, 'no address data yields null');

  // "THE LAST FILE" — which loan wins the address check.
  ok(I.loanDateMs({ closingDocument: { closingDate: '2025-06-01' } }, '2020-01-01') > I.loanDateMs({}, '2020-01-01'),
    "a loan's own closing date beats our mirror's last-modified stamp");
  ok(I.loanDateMs({}, null) === 0, 'a loan with no usable date sorts last, never crashes');

  // The identity list and the raw-object list are read BY INDEX against each
  // other. If their skip rules ever diverge, one person's phone numbers and
  // home address land on another person's profile — silently.
  const messy = { applications: [
    { borrower: { firstName: '   ', lastName: '  ' }, coBorrower: { firstName: 'Real', lastName: 'Person' } },
    { borrower: { lastName: 'Solo' } },
    { borrower: null, coBorrower: 'not an object' },
  ] };
  const ids = I.extractParties(messy), rawp = I.collectParties(messy);
  ok(ids.length === rawp.length, 'the identity list and the raw-party list are the SAME length');
  ok(ids.length === 2 && ids[0].first === 'Real' && rawp[0].firstName === 'Real',
    'and the same person sits at the same index (a whitespace-only name is skipped by BOTH)');
}

// ---- pure: the read-only + no-file-creation guarantees ---------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'encompass', 'enrich.js'), 'utf8');
  ok(!/INSERT INTO applications/i.test(src),
    'the enrichment NEVER creates a loan file — the owner asked for profiles, not deals');
  ok(!/encompass\/client|_fetchGuarded|require\('\.\/client'\)/.test(src),
    'it never talks to Encompass at all — it reads the mirror table we already pulled');
  // Every borrower write must be additive or fill-only. An unguarded UPDATE of a
  // populated column is exactly the regression these lines are here to catch.
  //
  // There are exactly THREE, and each one's WHERE clause is what proves it:
  //   1. the home address, only when the profile has none;
  //   2. the middle name (db/345), only when the profile has none;
  //   3. clearing the "please confirm this name split" prompt once Encompass has
  //      independently confirmed our split — a flag, never a name.
  // If a fourth appears, this test must be read and the new WHERE clause proved
  // fill-only before the count is raised.
  const updates = src.match(/UPDATE borrowers[\s\S]*?(?=`)/g) || [];
  ok(updates.length === 3, `enrichment makes exactly 3 borrower writes, all fill-only (found ${updates.length})`);
  ok(updates.some((u) => /current_address IS NULL OR current_address::text IN/.test(u)),
    'the home-address write only ever FILLS a profile that has none');
  ok(updates.some((u) => /middle_name\s*=\s*\$2/.test(u) && /middle_name IS NULL OR btrim\(middle_name\) = ''/.test(u)),
    'the middle-name write only ever FILLS a profile that has none — it can never overwrite one');
  ok(updates.every((u) => !/first_name\s*=/.test(u) && !/last_name\s*=/.test(u)),
    'enrichment NEVER rewrites a first or last name — a disagreement is a review, not a write');
  ok(/fieldKey: 'middle_name'/.test(src) && /queueReview/.test(src),
    'a middle name that DISAGREES goes to manual review instead of being overwritten');

  // main's rule (#800): what we STORE is the mailing one-line ClickUp's picker
  // shows, never a geocoder display name. Encompass gives structured fields so
  // our own build is already correct — but a loan carrying one long provider
  // string must not slip a display name onto the profile through this path.
  ok(/compactFormattedAddress/.test(src),
    'the Encompass address write goes through the shared mailing-one-line compactor');
  const AD = require('../src/lib/address');
  const longForm = '26, South 10th Street, Williamsburg, Brooklyn, Kings County, New York, 11249, United States';
  ok(/^26 S 10th St, Brooklyn, NY 11249/.test(AD.compactFormattedAddress(longForm)),
    'and that compactor really does turn a geocoder display name into the mailing form');
  ok(AD.compactFormattedAddress('9 Recent Road, Monsey, NY 10952') === '9 Recent Road, Monsey, NY 10952',
    'while an address already in mailing form passes through untouched');

  const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'sync', 'encompass-sync.js'), 'utf8');
  ok(/ENCOMPASS_ENRICH_DAYS', 7\)/.test(worker), 'the pass runs WEEKLY by default, as asked');
  ok(/enrichEnabled = \(\) => _flagOn\('ENCOMPASS_ENRICH_ENABLED'\)/.test(worker),
    'and stays opt-in — a profile-writing pass is never on by accident');

  // The resolver must branch on `source` BEFORE any ClickUp branch, or an
  // Encompass row's namespaced task_id would be sent to clickup.getTask.
  const ar = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sync-autoresolve.js'), 'utf8');
  const guardAt = ar.indexOf("row.source === 'encompass'");
  ok(guardAt > 0 && guardAt < ar.indexOf("if (fieldKey === 'date_of_birth')"),
    'an Encompass review is settled BEFORE any branch that would call ClickUp');
  const recheck = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sync-review-recheck.js'), 'utf8');
  ok(/row\.source === 'encompass'/.test(recheck), 'and "look again" refuses it rather than fetching a task that does not exist');

  // An Encompass row hangs on a BORROWER, never a file — and that borrower may
  // have no loan file at all (a DSCR-only client). Scoping it the file way would
  // hide the card from the one officer who can answer it.
  const staff = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
  ok(/ENCOMPASS_REVIEW_SCOPE = \(p\) =>[\s\S]{0,300}VISIBLE_BORROWER_SQL\('eb', p\)/.test(staff),
    'the reviews scope reaches an Encompass row through the BORROWER scope, not the file scope');
  ok((staff.match(/\$\{ENCOMPASS_REVIEW_SCOPE\(/g) || []).length === 2,
    'and both the list AND the sidebar count use it — a card you cannot count is a card you never look for');
}

console.log(`test-encompass-profile-enrich: PURE ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
if (!process.env.DATABASE_URL) { console.log('  (SKIP DB — no DATABASE_URL)'); process.exit(0); }

// ---- DB: the whole pass, end to end ---------------------------------------
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let dbPass = 0, dbFail = 0;
  const okd = (c, m) => { if (c) { dbPass++; } else { dbFail++; console.log(`FAIL ${m}`); } };
  try {
    await client.query('BEGIN');
    // Isolate the pass to this test's fixtures (rolled back at the end).
    await client.query('DELETE FROM encompass_loan_snapshot');
    const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

    const bId = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,date_of_birth,current_address)
       VALUES ('Shulem','Weiss',$1,'(845) 111-2222','1979-11-05',$2::jsonb) RETURNING id`,
      [`enr-a-${sfx}@test.local`, JSON.stringify({ oneLine: '77 Portal Place, Monsey, NY 10952' })])).rows[0].id;
    // A second person whose profile has NO home address at all.
    const bEmpty = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
       VALUES ('Chaim','Berger',$1,'1988-02-14') RETURNING id`, [`enr-b-${sfx}@test.local`])).rows[0].id;

    const snap = (guid, raw, when) => client.query(
      `INSERT INTO encompass_loan_snapshot (encompass_loan_guid, loan_number, raw, last_modified, pulled_at)
       VALUES ($1,$1,$2::jsonb,$3, now())`, [guid, JSON.stringify(raw), when]);

    // `closing` is the day the loan FUNDED — these stand for closed deals, which
    // is what puts a property on the track record. A loan with no `closing` is
    // still in flight (owner-directed 2026-07-27: its property stays off).
    const loan = ({ first, last, dob, home, subject, llc1859, email, mobile, work, closing }) => ({
      closingDocument: closing ? { closingDate: closing, fundingDate: closing } : undefined,
      applications: [{
        borrower: {
          firstName: first, lastName: last, birthDate: dob,
          emailAddressText: email || undefined, mobilePhone: mobile || undefined, workPhone: work || undefined,
          residences: home ? [{ residencyType: 'Current', addressStreetLine1: home.street, addressCity: home.city, addressState: home.state, addressPostalCode: home.zip }] : undefined,
        },
      }],
      property: subject ? { streetAddress: subject.street, city: subject.city, state: subject.state, postalCode: subject.zip } : undefined,
      customFields: llc1859 ? [{ fieldName: '1859', value: llc1859 }, { fieldName: 'CX.LLCSTATE', value: 'NY' }] : [],
    });

    // OLDER file: an out-of-date home address, one property, two entities.
    await snap(`enr-old-${sfx}`, loan({
      first: 'Shulem', last: 'Weiss', dob: '1979-11-05',
      home: { street: '5 Ancient Ave', city: 'Monsey', state: 'NY', zip: '10952' },
      subject: { street: '100 First St', city: 'Scranton', state: 'PA', zip: '18504' },
      llc1859: 'Weiss Equities LLC; Weiss Capital LLC',
      email: `enr-old-${sfx}@test.local`, mobile: '(845) 111-2222', work: '(718) 333-4444',
      closing: '2022-03-01',
    }), '2022-03-02T00:00:00Z');

    // NEWER file: a DIFFERENT home address (the one the check must use), another
    // property, one repeated entity + one new one, another email.
    await snap(`enr-new-${sfx}`, loan({
      first: 'Shulem', last: 'Weiss', dob: '1979-11-05',
      home: { street: '9 Recent Road', city: 'Monsey', state: 'NY', zip: '10952' },
      subject: { street: '200 Second St', city: 'Wilkes-Barre', state: 'PA', zip: '18702' },
      llc1859: 'weiss equities llc / Weiss Ventures LLC',
      email: `enr-new-${sfx}@test.local`, mobile: '(845) 999-8888',
      closing: '2025-09-01',
    }), '2025-09-02T00:00:00Z');

    // The second person: profile has NO address, so the file's should FILL it.
    await snap(`enr-fill-${sfx}`, loan({
      first: 'Chaim', last: 'Berger', dob: '1988-02-14',
      home: { street: '3 Blank Blvd', city: 'Lakewood', state: 'NJ', zip: '08701' },
      subject: { street: '300 Third St', city: 'Allentown', state: 'PA', zip: '18101' },
      email: `enr-fill-${sfx}@test.local`, mobile: '(732) 222-3333',
      closing: '2024-05-01',
    }), '2024-05-02T00:00:00Z');

    // THE FILE HE IS IN THE MIDDLE OF: a live Encompass loan, no funding yet. Its
    // subject property must NOT reach his track record (owner-reported 2026-07-27),
    // while everything else on it — his entity, his phone — still counts.
    await snap(`enr-live-${sfx}`, loan({
      first: 'Shulem', last: 'Weiss', dob: '1979-11-05',
      subject: { street: '500 In Progress Ave', city: 'Newark', state: 'NJ', zip: '07102' },
      llc1859: 'Weiss Live Deal LLC',
      mobile: '(845) 777-6666',
    }), '2026-07-01T00:00:00Z');

    const s = await enrich.enrichAllOnce({ dbc: client });
    okd(s.loans === 4 && s.matched === 4, 'every loan in the mirror is read and matched to its person');

    // ── Entities add up, including everything field 1859 named ──────────────
    const llcs = (await client.query(`SELECT llc_name, origin, is_verified FROM llcs WHERE borrower_id=$1 ORDER BY llc_name`, [bId])).rows;
    okd(llcs.length === 4, 'field 1859 across the files yields four distinct entities');
    okd(llcs.some((l) => /Weiss Live Deal/i.test(l.llc_name)),
      'the entity on the file he is in the MIDDLE of still counts — an entity is his whether or not the deal closed');
    okd(llcs.some((l) => /Weiss Ventures/i.test(l.llc_name)) && llcs.some((l) => /Weiss Capital/i.test(l.llc_name)),
      'the entities only one file named are both picked up');
    okd(llcs.filter((l) => /Weiss Equities/i.test(l.llc_name)).length === 1,
      'the entity BOTH files named is added once, not twice');
    okd(llcs.every((l) => l.origin === 'encompass' && l.is_verified === false),
      'everything Encompass contributes is tagged and UNVERIFIED — it never inflates experience');

    // ── Properties add up — but only the ones that CLOSED ──────────────────
    const trs = (await client.query(`SELECT property_address FROM track_records WHERE borrower_id=$1`, [bId])).rows;
    okd(trs.length === 2, 'each CLOSED file\'s subject property lands in the track record');
    okd(!/In Progress Ave/.test(JSON.stringify(trs)),
      'the property he has not closed yet is NOT on his track record');
    okd(s.addressesSkippedNotClosed === 1, 'and the pass reports holding it back');

    // ── Phones and emails add up ───────────────────────────────────────────
    const contacts = (await client.query(`SELECT kind, value, source FROM borrower_contacts WHERE borrower_id=$1`, [bId])).rows;
    const hasC = (k, v) => contacts.some((c) => c.kind === k && String(c.value).toLowerCase() === v.toLowerCase());
    okd(hasC('email', `enr-old-${sfx}@test.local`) && hasC('email', `enr-new-${sfx}@test.local`),
      'every email address across the files accumulates on the profile');
    okd(hasC('phone', '(718) 333-4444') && hasC('phone', '(845) 999-8888') && hasC('phone', '(845) 777-6666'),
      'as does every phone number — including the one on the file still in flight');
    okd(!contacts.some((c) => c.kind === 'phone' && c.value.includes('111-2222')),
      'the number that is ALREADY the profile\'s primary is not re-added as an extra');
    okd(contacts.every((c) => /^encompass:/.test(c.source || '')),
      'each one records the exact Encompass loan it came from');

    // ── The primary address: verified against THE LAST FILE ────────────────
    const after = (await client.query(`SELECT current_address FROM borrowers WHERE id=$1`, [bId])).rows[0];
    okd(/77 Portal Place/.test(JSON.stringify(after.current_address)),
      'a home address a human already put on the profile is NEVER overwritten');
    okd(s.addressConflicts === 1, 'the disagreement is reported as a conflict');
    const rev = (await client.query(
      `SELECT * FROM sync_review_queue WHERE borrower_id=$1 AND field_key='current_address' AND status='open'`, [bId])).rows;
    okd(rev.length === 1, 'and it goes to the manual review section, exactly once');
    okd(rev[0] && rev[0].source === 'encompass', 'tagged as an Encompass row, so no resolver mistakes it for a ClickUp task');
    okd(rev[0] && /9 Recent Road/.test(rev[0].proposed_value || ''),
      'THE LAST FILE is the one it verifies against — not whichever loan happened to be read first');
    okd(rev[0] && /77 Portal Place/.test(rev[0].portal_value || ''), 'with PILOT\'s value alongside, so a human can compare');
    okd(rev[0] && String(rev[0].task_id || '').startsWith('encompass:'),
      'its task id is namespaced — it is a loan guid, never a ClickUp task');

    // The EMPTY profile is FILLED (pure gain, no review needed).
    const filled = (await client.query(`SELECT current_address FROM borrowers WHERE id=$1`, [bEmpty])).rows[0];
    okd(/3 Blank Blvd/.test(JSON.stringify(filled.current_address)),
      'a profile with NO home address is filled from the file — that is gain, not a decision');
    okd(s.addressesFilled === 1, 'and reported as filled rather than as a conflict');
    okd((await client.query(
      `SELECT count(*)::int n FROM sync_review_queue WHERE borrower_id=$1 AND status='open'`, [bEmpty])).rows[0].n === 0,
      'filling an empty field never bothers a human');

    // ── No loan files, ever ────────────────────────────────────────────────
    okd((await client.query(
      `SELECT count(*)::int n FROM applications WHERE borrower_id = ANY($1::uuid[])`, [[bId, bEmpty]])).rows[0].n === 0,
      'THE HARD RULE: enrichment created no loan file for anybody');

    // ── Idempotent: a second week adds nothing and does not re-nag ─────────
    const s2 = await enrich.enrichAllOnce({ dbc: client });
    okd(s2.llcsAdded === 0 && s2.addressesAdded === 0 && s2.emailsAdded === 0 && s2.phonesAdded === 0,
      'next week\'s pass over the same data adds nothing');
    okd((await client.query(
      `SELECT count(*)::int n FROM sync_review_queue WHERE borrower_id=$1 AND field_key='current_address' AND status='open'`,
      [bId])).rows[0].n === 1,
      'and does not pile up a second review card for the same unresolved disagreement');

    await client.query('ROLLBACK');

    // ── Resolving an Encompass review writes the PROFILE, and nothing else ──
    // COMMITTED fixtures on purpose: `applyReviewWinner` is a route-level
    // operation that uses the pool, so it cannot see rows held in an open
    // transaction. Cleaned up explicitly below.
    const AR = require('../src/lib/sync-autoresolve');
    const rId = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,current_address)
       VALUES ('Resolve','Test',$1,$2::jsonb) RETURNING id`,
      [`enr-res-${sfx}@test.local`, JSON.stringify({ oneLine: '1 Before St, Monsey, NY' })])).rows[0].id;
    try {
      const row = {
        id: 0, source: 'encompass', field_key: 'current_address', borrower_id: rId,
        application_id: null, task_id: `encompass:res-${sfx}`,
        proposed_value: '9 Recent Road, Monsey, NY 10952', portal_value: '1 Before St, Monsey, NY',
      };
      const out = await AR.applyReviewWinner(row, 'encompass');
      okd(out.wrote === true && /9 Recent Road/.test(out.value), 'adopting the Encompass value applies it');
      okd(/9 Recent Road/.test(JSON.stringify(
        (await client.query(`SELECT current_address FROM borrowers WHERE id=$1`, [rId])).rows[0].current_address)),
        'the borrower profile now carries the address the reviewer chose');

      const kept = await AR.applyReviewWinner(row, 'portal');
      okd(kept.wrote === false, 'keeping PILOT\'s value writes nothing anywhere — Encompass is read-only');

      let refused = null;
      try { await AR.applyReviewWinner(row, 'clickup'); } catch (e) { refused = e; }
      okd(refused && refused.status === 400,
        'and "adopt ClickUp" is REFUSED on an Encompass row — there is no ClickUp task behind it');
    } finally {
      await client.query(`DELETE FROM borrowers WHERE id=$1`, [rId]).catch(() => {});
    }
  } catch (e) {
    dbFail++; console.log('FAIL threw:', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DELETE FROM borrowers WHERE email LIKE 'enr-res-%@test.local'`).catch(() => {});
  } finally {
    client.release(); await pool.end();
    console.log(`test-encompass-profile-enrich: DB ${dbPass} passed, ${dbFail} failed`);
    process.exit(dbFail ? 1 : 0);
  }
})();
