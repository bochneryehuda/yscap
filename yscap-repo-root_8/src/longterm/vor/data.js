'use strict';
/**
 * LONG-TERM — FILLING THE OWNER'S VERIFICATION OF RENT IN FROM WHAT WE ALREADY KNOW.
 *
 * Owner-directed, corrected 2026-08-30: *"the VOR needs to be on the exact blank
 * form that I sent you"* and *"You leave empty even if it's pre-filled on the field
 * ID call."* So this builds ITEMS 1 THROUGH 9 of the form — the landlord we are
 * writing to, us, who is asking, the address the applicant rents and the applicants
 * themselves — and NOTHING ELSE. Part II and Part III belong to the landlord.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERS ────────────────────────────────────────
 *
 * An earlier reading prefilled "part two" as well — the rent and the term the
 * BORROWER stated, printed into the landlord's own boxes. The owner reported it:
 * *"You're pre-filling some of the information from part two."* It is not a
 * cosmetic error. A verification of rent is worth having only because an
 * independent party answers it; a form that arrives with the answers already typed
 * in invites a signature on our own numbers and verifies nothing. So the rent and
 * the duration are still READ from the file where they inform the desk, but they
 * are no longer form data and nothing prints them.
 *
 * ── ITEM 7 IS THE ADDRESS THEY RENT, NOT THE SUBJECT PROPERTY ───────────────
 *
 * On a long-term file the subject property is usually an investment property with
 * somebody else's tenant in it. Item 7 asks about the applicant's OWN tenancy, so it
 * takes the current residence off `lt_residences` — the same row whose
 * `residency_basis` is what put this form on the file at all. Sending the subject
 * address instead asks the right landlord about the wrong house.
 *
 * ── AN UNREADABLE READ SAYS SO ──────────────────────────────────────────────
 *
 * Each read is its own try/catch and reports which one failed. A form quietly short
 * a field reads as "we do not know that", which is a claim — and here it would send
 * a landlord a form with a blank where the address should be.
 *
 * SEPARATION: reads lt_* on the long-term pool, plus the SHARED staff roster
 * (authorized identity read). It writes nothing.
 */
const db = require('../db');
const F = require('./fields');
const vendorDirectory = require('../../lib/vendor-directory');   // the PURE half only — see the ledger

/** Item 2, "From (Name and address of lender)" — printed as the form's own block of
    lines rather than one run, because that is what a landlord's mailroom reads. */
const LENDER = {
  name: 'YS Capital Group',
  address: '5 New Montrose Avenue, #Bsmt',
  cityStateZip: 'Brooklyn, NY 11211',
  nmls: '2609746',
};
const LENDER_BLOCK = [LENDER.name, LENDER.address, LENDER.cityStateZip].join('\n');

/** Item 9, in the owner's own words. The applicant's authorisation was given on the
    signed application the form's "To Landlord:" paragraph cites, so item 9 says
    where it is rather than collecting a second one. */
const APPLICANT_SIGNATURE = 'See attached signature';

/** Item 4, "Title". `staff_users.role` is the only title we hold, and a form that
    says "Loan Officer" is a form a landlord can place. An unknown role falls back to
    nothing rather than printing a database token at a stranger. */
const TITLE_BY_ROLE = {
  loan_officer: 'Loan Officer',
  processor: 'Loan Processor',
  underwriter: 'Underwriter',
  admin: 'Loan Administrator',
};

function addressLine(r) {
  if (!r) return null;
  const street = String(r.street || '').trim();
  const city = String(r.city || '').trim();
  const state = String(r.state || '').trim().toUpperCase();
  const zip = String(r.zip || '').trim();
  const tail = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const line = [street, tail].filter(Boolean).join(', ');
  return line || null;
}

function partyName(p) {
  if (!p) return null;
  const n = [p.first_name, p.middle_name, p.last_name].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const suffix = String(p.name_suffix || '').trim();
  const full = [n, suffix].filter(Boolean).join(' ').trim();
  return full || null;
}

/** 'YYYY-MM-DD' from a date column, without ever passing a date-only value through
    `new Date()` (the repo's date-only rule — that is a UTC day-shift waiting to
    happen). */
function dayOf(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

/**
 * Build our half of the form for a loan.
 *
 * @returns {Promise<{data:object, unreadable:string[], landlord:{name,email,phone}|null,
 *                    borrowerRents:boolean|null}>}
 */
async function prefill(loanId, client = db, opts = {}) {
  const landlordDefaults = {};
  const id = String(loanId);
  const unreadable = [];
  const data = {
    lender_block: LENDER_BLOCK,
    request_date: new Date().toISOString().slice(0, 10),
    applicant_signature: APPLICANT_SIGNATURE,
  };
  let landlord = null;
  let borrowerRents = null;

  async function one(what, sql, params, apply) {
    try { apply((await client.query(sql, params)).rows); }
    catch (e) { unreadable.push(what); }
  }

  let loan = null;
  await one('loan',
    `SELECT l.id, l.loan_number, l.loan_officer_id, l.borrower_name
       FROM lt_loans l WHERE l.id = $1::uuid`,
    [id], (rows) => { loan = (rows && rows[0]) || null; });
  if (!loan && !unreadable.length) return null;
  loan = loan || {};
  // Item 6, "Lender's No. (Optional)" — our own file number, so a landlord's reply
  // files itself and a second request on the same loan is recognisable as one.
  if (loan.loan_number) data.loan_number = String(loan.loan_number);
  if (loan.borrower_name) data.account_name = String(loan.borrower_name);

  // ── who is applying: items 7 (account name) and 8 (name and address) ──────
  let parties = [];
  await one('parties',
    `SELECT pa.id, pa.role, pa.party_type, pa.first_name, pa.middle_name, pa.last_name,
            pa.name_suffix, bp.pair_number
       FROM lt_parties pa
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid
      ORDER BY bp.pair_number, pa.role`,
    [id], (rows) => { parties = rows || []; });
  /* An ENTITY does not rent an apartment — a person does, and it is that person's
     tenancy the form asks about. So the borrowing LLC is dropped here even though it
     is the borrower on the note. */
  const people = parties.filter((p) => String(p.party_type || '').toLowerCase() !== 'entity');
  const primary = people.find((p) => String(p.role || '').toLowerCase() === 'borrower') || people[0] || null;
  const co = people.find((p) => p !== primary) || null;
  const names = [partyName(primary), partyName(co)].filter(Boolean);
  if (names.length) data.account_name = names.join(' and ');
  /* Item 9's second X-line only exists when there IS a co-applicant. Leaving it
     empty otherwise is the form's own way of saying "one applicant". */
  if (co) data.coapplicant_signature = APPLICANT_SIGNATURE;

  /* ── where they live, and whether they RENT it ──────────────────────────────
     The condition this form answers only exists on a file where the borrower rents
     (Encompass FR0115, mirrored here as `residency_basis`). The CURRENT residence
     is the one being verified; a previous one is somebody else's landlord and a
     different form.

     `monthly_rent` and `duration_months` are read but NEVER put on the form: they
     are the BORROWER's account of Part II, and Part II is the landlord's to answer.
     They ride back on the result so the desk can show a processor what the file
     says, beside — never inside — the form. */
  await one('residence',
    `SELECT r.street, r.city, r.state, r.zip, r.residency_basis, r.residency_type,
            r.duration_months, r.monthly_rent
       FROM lt_residences r
       JOIN lt_parties pa ON pa.id = r.party_id
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid
      ORDER BY (CASE WHEN lower(r.residency_type::text) = 'current' THEN 0 ELSE 1 END),
               pa.id`,
    [id], (rows) => {
      const list = rows || [];
      const current = list.find((r) => String(r.residency_type || '').toLowerCase() === 'current') || list[0] || null;
      if (!current) return;
      const basis = String(current.residency_basis || '').toLowerCase();
      borrowerRents = basis ? /rent/.test(basis) : null;
      const line = addressLine(current);
      if (line) {
        data.property_address = line;
        // Item 8 is "Name AND Address of Applicant(s)" — one block, the way the
        // form's own box is ruled.
        data.applicant_block = [names.join(' and '), line].filter(Boolean).join('\n');
      }
    });
  if (!data.applicant_block && names.length) data.applicant_block = names.join(' and ');

  // ── item 1: the landlord we already hold ─────────────────────────────────
  // The same vendor card the orders desk would send to, so the form and the order
  // can never name two different landlords. `address` is read here because item 1 is
  // "Name AND address of landlord" — a name alone is a form nobody can post.
  await one('landlord',
    `SELECT sc.company_name, sc.contact_name, sc.address, sc.email, sc.emails, sc.phone, sc.phones
       FROM lt_loan_vendors v
       JOIN service_contacts sc ON sc.id = v.service_contact_id
      WHERE v.loan_id = $1::uuid AND v.kind = 'landlord'
      ORDER BY v.is_primary DESC, v.created_at DESC
      LIMIT 1`,
    [id], (rows) => {
      const r = rows && rows[0];
      if (!r) return;
      /* db/224 put an `emails` ARRAY beside the legacy `email` scalar and backfilled
         only the rows that existed then, so reading either one alone silently drops
         addresses. `allEmails` is the ONE reading of that pair — the reason the
         crossing was authorized in the first place. Same for the phones. */
      const emails = vendorDirectory.allEmails(r);
      const phones = vendorDirectory.allPhones(r);
      const company = String(r.company_name || '').trim();
      const person = String(r.contact_name || '').trim();
      const name = person || company || null;
      landlord = { name, email: emails[0] || null, emails, phone: phones[0] || null };
      /* Both names print when we hold both — "Rivka Stein" alone at a management
         company is a letter that reaches nobody, and the company alone loses the
         person who actually answers. */
      /* THE WHOLE BLOCK, not just a name and a street. Owner-directed
         2026-08-31: *"It needs to be able to be several lines: name of the
         management, address of the management, contact information for the
         management. We also need to be able to enter email address and phone
         number."* Item 1 is a four-line band on the form, so the details fit
         where the form already leaves room. Blank parts collapse — a block with
         a trailing empty line reads as a form somebody abandoned. */
      const block = [
        person,
        company !== person ? company : null,
        String(r.address || '').trim(),
        [emails[0] || null, phones[0] || null].filter(Boolean).join(' · ') || null,
      ].filter(Boolean).join('\n');
      if (block) data.landlord_block = block;
      /* AND THE SAME PHONE STARTS ITEM 16 — *"The phone number should
         automatically populate the bottom, also where it asks for the Landlord
         phone number."* It travels in its OWN channel, never in `data`:
         `cleanOurData` drops every key whose field is not ours (which is what
         keeps Part III the landlord's), so a landlord key put in `data` is
         SILENTLY discarded and the pre-fill simply never appears. Kept apart it
         can be drawn on the paper copy and offered as a DocuSign tab's starting
         value without any of it becoming an answer WE gave. */
      if (phones[0]) landlordDefaults.ll_phone = String(phones[0]);
    });

  /* ── items 3 and 4: who at YS Capital is asking, and what they are ────────
     THE PERSON SENDING IT, not the file's officer. Owner-directed 2026-08-31:
     *"On the VOR form, the signature of the lender and the title of the person
     of the lender should be pre-filled with the user that is sending it out."*
     A form signed in the officer's name by whoever happened to open it says the
     wrong person asked — and on a document that goes to an outside landlord and
     comes back as evidence, that is the name on the record.

     TWO SHAPES REACH HERE and both are the same fact: the screen doors pass
     `{actor: req.actor}`, and the SEND door passes `staffId` (it already needs
     it for the envelope's `sent_by`). Reading only one would leave the single
     path the owner actually named falling back to the file's officer.

     The officer stays LAST as the fallback, so a form previewed by nobody in
     particular still carries a real signatory. Only a row that resolves to an
     ACTIVE staff member counts — an id we cannot place must never blank out the
     officer we could. */
  const signatoryIds = [
    (opts && opts.actor && opts.actor.id) || null,
    (opts && opts.staffId) || null,
    loan.loan_officer_id || null,
  ].filter(Boolean);
  for (const staffId of signatoryIds) {
    if (data.lender_signature) break;
    // eslint-disable-next-line no-await-in-loop
    await one('signatory',
      `SELECT NULLIF(btrim(su.full_name), '') AS name, su.role, su.email, su.phone
         FROM staff_users su
        WHERE su.id = $1::uuid AND su.is_active = true`,
      [staffId], (rows) => {
        const r = rows && rows[0];
        if (!r) return;
        if (r.name) data.lender_signature = String(r.name);
        const title = TITLE_BY_ROLE[String(r.role || '').toLowerCase()];
        if (title) data.lender_title = title;
      });
  }

  return { data: F.cleanOurData(data), landlordDefaults, unreadable, landlord, borrowerRents };
}

/**
 * The prefill MERGED under whatever a person has already edited.
 *
 * A person's own value always wins — the whole reason the form is editable is that
 * the file is sometimes wrong — but a field they never touched picks up anything
 * new the file has learned since. So re-opening a half-edited form neither loses
 * their corrections nor freezes a stale address.
 */
function mergeSaved(prefilled, saved) {
  const out = { ...(prefilled || {}) };
  for (const [k, v] of Object.entries(saved || {})) {
    if (v == null || String(v).trim() === '') continue;
    out[k] = v;
  }
  return F.cleanOurData(out);
}

module.exports = {
  prefill, mergeSaved, LENDER, LENDER_BLOCK, APPLICANT_SIGNATURE, TITLE_BY_ROLE,
  _internals: { addressLine, partyName, dayOf },
};
