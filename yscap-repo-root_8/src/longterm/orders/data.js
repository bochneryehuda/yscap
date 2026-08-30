'use strict';
/**
 * LONG-TERM — EVERYTHING AN ORDER NEEDS ABOUT A LOAN, IN ONE READ.
 *
 * The shared letter builder (`src/lib/order-email.js`) takes a plain object and
 * knows nothing about either product's tables. This is the long-term side's half of
 * that contract: it turns `lt_loans` + `lt_properties` + `lt_parties` + the file's
 * vendor cards into exactly that object.
 *
 * ── THE VENDOR DIRECTORY IS SHARED, THE LINK IS OURS ────────────────────────
 *
 * A vendor card is a `service_contacts` row — the SAME directory the short-term
 * desk uses, because the owner was explicit: *"You need to make sure you're not
 * copying the information. You're just using the information from the short-term
 * side."* One title company, one card, corrected in one place. What is ours is the
 * LINK (`lt_loan_vendors`): which card this loan uses for which job.
 *
 * The join is a LEFT JOIN and carries no foreign key (db/644's header says why), so
 * a card somebody deleted from the directory reads as GONE — `blockers` then refuses
 * the order and says so — rather than cascading into our table or blocking their
 * screen.
 *
 * ── A DEGRADED READ IS NOT AN EMPTY FILE ────────────────────────────────────
 *
 * Every read is its own try/catch and reports what it could not read. A blank
 * borrower name because the parties table was briefly unreachable must never be
 * printed to a title company as the borrower's name; the desk refuses instead.
 *
 * SEPARATION: reads `lt_*` and the authorized shared `service_contacts` /
 * `staff_users`. Writes nothing.
 */

const db = require('../db');
const orderEmail = require('../../lib/order-email');
const kinds = require('./kinds');
const switches = require('./switches');

/** A one-line property address from the long-term property row. */
function propertyLine(p) {
  if (!p) return '';
  const tail = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.street, tail].filter(Boolean).join(', ');
}

/** Purchase / Refinance, in the words a vendor uses, from the loan's own purpose. */
function transactionType(purpose) {
  const s = String(purpose || '').toLowerCase();
  if (!s) return '';
  if (/cash[_\s-]*out/.test(s)) return 'Cash-out refinance';
  if (/refi/.test(s)) return 'Refinance';
  if (/purchase/.test(s)) return 'Purchase';
  return String(purpose);
}

/** A person's name from a party row, however much of it we hold. */
function partyName(p) {
  if (!p) return '';
  if (p.entity_legal_name && String(p.party_type || '').toLowerCase() === 'entity') return String(p.entity_legal_name);
  return [p.first_name, p.middle_name, p.last_name, p.name_suffix]
    .map((x) => String(x || '').trim()).filter(Boolean).join(' ');
}

/** One line for a residence row, for the borrower's MAILING address. */
function residenceLine(r) {
  if (!r) return null;
  const tail = [r.city, [r.state, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const s = [r.street, tail].filter(Boolean).join(', ');
  return s || null;
}

/**
 * Everything an order email or the desk needs about one loan.
 *
 * @returns {Promise<object|null>} null only when the loan does not exist. A loan
 *          that exists but could not be fully read comes back with `unreadable`
 *          populated — the caller decides, and `blockers` refuses on it.
 */
async function getOrderData(loanId, client = db) {
  const id = String(loanId);
  const out = { loanId: id, appId: id, unreadable: [] };

  const one = async (what, sql, params, assign) => {
    try {
      const { rows } = await client.query(sql, params);
      assign(rows);
    } catch (e) {
      out.unreadable.push({ what, why: String((e && e.message) || e).slice(0, 200) });
      assign(null);
    }
  };

  let loan = null;
  await one('loan',
    `SELECT l.id, l.loan_number, l.borrower_name, l.borrower_email, l.borrower_id,
            l.loan_amount, l.loan_purpose, l.program_name, l.product_kind,
            l.vesting_entity_name, l.milestone_name, l.stage_key, l.loan_officer_id,
            l.product_kind,
            p.street, p.city, p.state, p.zip, p.unit_count, p.gse_property_type,
            p.in_flood_zone, p.purchase_price, p.appraised_value, p.estimated_value,
            p.gross_monthly_rent
       FROM lt_loans l
       LEFT JOIN lt_properties p ON p.loan_id = l.id
      WHERE l.id = $1::uuid`,
    [id], (rows) => { loan = (rows && rows[0]) || null; });

  if (!loan && !out.unreadable.length) return null;
  if (!loan) loan = {};

  out.loanNumber = loan.loan_number || null;
  out.hasLoanNumber = !!String(loan.loan_number || '').trim();
  out.propertyLine = propertyLine(loan);
  out.propertyState = loan.state || null;
  out.propertyType = loan.gse_property_type || null;
  out.unitCount = loan.unit_count == null ? null : Number(loan.unit_count);
  out.inFloodZone = loan.in_flood_zone === true ? true : (loan.in_flood_zone === false ? false : null);
  out.loanAmountRaw = loan.loan_amount == null ? null : Number(loan.loan_amount);
  out.loanAmount = orderEmail.money(out.loanAmountRaw);
  out.purchasePrice = loan.purchase_price == null ? null : Number(loan.purchase_price);
  out.appraisedValue = loan.appraised_value == null ? null : Number(loan.appraised_value);
  out.grossMonthlyRent = loan.gross_monthly_rent == null ? null : Number(loan.gross_monthly_rent);
  out.transactionType = transactionType(loan.loan_purpose);
  out.loanPurpose = loan.loan_purpose || null;
  out.programName = loan.program_name || null;
  out.productKind = loan.product_kind || null;
  /* DOES THIS LOAN EXIT AS A RENTAL? On a DSCR loan it does by definition — the loan
     is qualified on the property's own rent — which is what decides whether the
     appraisal order also asks for a rent schedule. A product kind we cannot read
     answers NULL rather than true: asking an appraiser for a schedule nobody needs
     costs a fee and a week, and adding one later is the cheap half. */
  out.rentalExit = loan.product_kind ? String(loan.product_kind).toLowerCase() === 'dscr' : null;
  out.entityName = loan.vesting_entity_name || null;
  out.borrowerName = loan.borrower_name || null;
  out.borrowerEmail = loan.borrower_email || null;
  // A long-term loan has no expected closing date of its own, so the letters say
  // "we will confirm it as soon as it is set" rather than printing a guess.
  out.expectedClosing = null;
  out.rehabBudget = null;

  // ── The people on the loan ────────────────────────────────────────────────
  let parties = [];
  await one('parties',
    `SELECT pa.id, pa.role, pa.party_type, pa.first_name, pa.middle_name, pa.last_name,
            pa.name_suffix, pa.date_of_birth, pa.email, pa.mobile_phone, pa.home_phone,
            pa.entity_legal_name, bp.pair_number
       FROM lt_parties pa
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid
      ORDER BY bp.pair_number, pa.role`,
    [id], (rows) => { parties = rows || []; });

  const people = parties.filter((p) => String(p.party_type || '').toLowerCase() !== 'entity');
  const primary = people.find((p) => String(p.role || '').toLowerCase() === 'borrower') || people[0] || null;
  const co = people.find((p) => p !== primary) || null;
  if (!out.borrowerName && primary) out.borrowerName = partyName(primary);
  if (!out.borrowerEmail && primary) out.borrowerEmail = primary.email || null;
  out.coBorrowerName = co ? partyName(co) : null;
  out.coBorrowerEmail = co ? (co.email || null) : null;
  out.borrowerPhone = primary ? (primary.mobile_phone || primary.home_phone || null) : null;
  out.dob = primary && primary.date_of_birth ? orderEmail.dayText(primary.date_of_birth) : null;
  if (!out.entityName) {
    const entity = parties.find((p) => String(p.party_type || '').toLowerCase() === 'entity' || p.entity_legal_name);
    out.entityName = entity ? (entity.entity_legal_name || null) : null;
  }

  // The borrower's own HOME address, which is where an insurance policy is mailed —
  // never the subject property, which on a long-term file is a rental somebody else
  // lives in.
  await one('residences',
    `SELECT r.street, r.city, r.state, r.zip, r.residency_type
       FROM lt_residences r
       JOIN lt_parties pa ON pa.id = r.party_id
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid`,
    [id], (rows) => {
      const list = rows || [];
      const current = list.find((r) => String(r.residency_type || '').toLowerCase() === 'current') || list[0] || null;
      out.borrowerMailingAddress = residenceLine(current);
    });

  // ── Who signs the order ───────────────────────────────────────────────────
  // The loan officer, from the SHARED staff roster (authorized read). This is the
  // person the vendor can telephone, and — once send-as-user is on — the address
  // the order comes FROM.
  await one('officer',
    `SELECT su.id, NULLIF(btrim(su.full_name), '') AS name, su.email, su.phone, su.title, su.nmls_id
       FROM staff_users su
      WHERE su.id = $1::uuid AND su.is_active = true`,
    [loan.loan_officer_id || null], (rows) => {
      const r = rows && rows[0];
      out.officer = r ? { id: r.id, name: r.name || null, title: r.title || 'Loan Officer', email: r.email || null, phone: r.phone || null, nmls: r.nmls_id || null } : null;
    });

  // The processor, off the loan's own Encompass-mirrored contact roles. Their card
  // rides the Cc so a vendor's reply reaches the person actually working the file.
  await one('contacts',
    `SELECT role, encompass_name, encompass_email, COALESCE(override_staff_id, staff_id) AS staff_id
       FROM lt_loan_contacts WHERE loan_id = $1::uuid`,
    [id], (rows) => {
      const list = rows || [];
      const proc = list.find((c) => /process/i.test(String(c.role || '')));
      out.processor = proc && proc.encompass_email ? { name: proc.encompass_name || null, email: proc.encompass_email } : null;
      out.contacts = list.map((c) => ({ role: c.role, name: c.encompass_name || null, email: c.encompass_email || null }));
    });

  // A long-term file has no helper login of its own yet, so nobody is ever CC'd as
  // one. Stated rather than omitted: the shared recipient rule reads `data.helpers`,
  // and an absent key would read the same as an empty one only by luck.
  out.helpers = [];

  // ── The vendor cards ──────────────────────────────────────────────────────
  await one('vendors',
    `SELECT v.id AS link_id, v.kind, v.is_primary, v.service_contact_id,
            sc.id AS contact_id, sc.company_name, sc.contact_name, sc.email, sc.emails,
            sc.phone, sc.phones, sc.address, sc.contact_type
       FROM lt_loan_vendors v
       LEFT JOIN service_contacts sc ON sc.id = v.service_contact_id
      WHERE v.loan_id = $1::uuid
      ORDER BY v.is_primary DESC, sc.company_name NULLS LAST`,
    [id], (rows) => {
      const byKind = {};
      const extras = {};
      for (const r of (rows || [])) {
        const card = r.contact_id
          ? {
            id: r.contact_id, company_name: r.company_name, contact_name: r.contact_name,
            email: r.email, emails: r.emails, phone: r.phone, phones: r.phones,
            address: r.address, contact_type: r.contact_type,
          }
          // The card was removed from the shared directory. Recorded as MISSING
          // rather than dropped, so the desk can say "the company on this file is
          // no longer in the directory" instead of "no vendor" — two different
          // instructions for the person reading it.
          : { id: null, missing: true, serviceContactId: r.service_contact_id };
        if (r.is_primary && !byKind[r.kind]) byKind[r.kind] = card;
        else (extras[r.kind] = extras[r.kind] || []).push(card);
      }
      out.vendorCards = byKind;
      out.vendorCardsExtra = extras;
    });

  // The shared builder and the shared recipient rule read `data.vendors[<orderKind>]`,
  // so the cards are re-keyed by ORDER kind through the registry — one mapping, in
  // one place, rather than each call site remembering that an insurance order is
  // addressed to the hazard-insurance card.
  out.vendors = {};
  out.vendorsExtra = {};
  for (const k of kinds.ORDER_KIND_KEYS) {
    const vk = kinds.vendorKindFor(k);
    out.vendors[k] = (out.vendorCards || {})[vk] || null;
    out.vendorsExtra[k] = ((out.vendorCardsExtra || {})[vk] || []);
  }

  /* WHICH ORDERS ARE SWITCHED ON, read LIVE from the condition library rather than
     from the code constant — the owner's rule: "everything should be able to be
     configured differently in settings; the system is only prefilled with the rules
     of the system". `switches.resolve` falls back to the shipped default on an
     unreadable read, so an outage can never switch an order on that shipped off.
     Read here, once, so the desk and the send re-check the SAME answer. */
  out.enabled = await switches.resolve(client);

  return out;
}

/** Every address an order of this kind would go TO. The ONE reading — the shared
    `vendorEmails` folds the legacy scalar `email` and the `emails` array, which is
    the trap db/224 left behind on the short-term side. */
function vendorEmails(kind, data) {
  return orderEmail.vendorEmails(kind, data);
}

/**
 * WHAT STILL STOPS THIS ORDER — an empty list means it is ready to send.
 *
 * Each code is a distinct instruction for the person reading it, and they are NOT
 * interchangeable: "no vendor on the file" sends you to the contacts form, "the
 * company on this file is no longer in the directory" sends you to the vendors
 * screen, and "this kind is switched off" is not something anybody can clear at all.
 *
 * FAILS CLOSED on an unreadable file: a loan we could not read is not a loan we know
 * is ready, and an order transmits a borrower's details to an outside company.
 */
function blockers(kind, data) {
  const out = [];
  const def = kinds.orderKind(kind);
  if (!def) return ['unknown_kind'];
  if (!data) return ['file'];
  if (Array.isArray(data.unreadable) && data.unreadable.length) out.push('unreadable');
  /* THE SWITCH IS THE SETTING, and the code constant is only what we ship with.
     `stateFor` falls back to that default when the map is absent, so a caller that
     never read it behaves exactly as before. */
  if (!switches.stateFor(data.enabled, def.key).enabled) out.push('disabled');
  if (!data.hasLoanNumber) out.push('loan_number');
  if (!String(data.propertyLine || '').trim()) out.push('property');
  const card = (data.vendors || {})[def.key];
  if (!card) out.push('contact');
  else if (card.missing) out.push('contact_removed');
  else if (!vendorEmails(def.key, data).length) out.push('contact_email');
  if (!String(data.borrowerName || '').trim()) out.push('borrower');
  return out;
}

/** Why an order cannot go, in words a person can act on. One sentence per code. */
const BLOCKER_TEXT = Object.freeze({
  unknown_kind: 'There is no such order.',
  file: 'That loan is not here.',
  unreadable: 'PILOT could not read the whole loan just now, so it will not send an order off a partial file. Try again in a moment.',
  disabled: 'This order is switched off in settings.',
  loan_number: 'The loan number is not on the file yet, and every order carries it in the mortgagee clause.',
  property: 'The property address is not on the file yet.',
  contact: 'Nobody is on the file for this yet — add them on the file contacts.',
  contact_removed: 'The company on this file is no longer in the vendor directory. Pick another card.',
  contact_email: 'The company on this file has no email address on its card.',
  borrower: 'The borrower’s name is not on the file yet.',
});

function blockerText(code) { return BLOCKER_TEXT[code] || String(code); }

module.exports = {
  getOrderData, blockers, blockerText, vendorEmails, BLOCKER_TEXT,
  _internals: { propertyLine, transactionType, partyName, residenceLine },
};
