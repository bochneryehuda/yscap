'use strict';
/**
 * LONG-TERM — the Encompass→ClickUp FIELD MAP and its write machinery.
 *
 * BY-VALUE COPY of the RTL mapper's proven machinery (src/clickup/mapper.js) —
 * writeValue, isBlankClickupValue, addressField, fieldValueEquivalent,
 * resolveOnly, the DOB-change detectors — under the CLICKUP WRITER'S
 * INHERITANCE sanction (owner, 2026-08-23, docs/LONG-TERM-AUTHORIZED-COPIES.md).
 * The MAP DATA is Long-Term's own: every ClickUp field id below was read off
 * the live workspace catalog (161 fields, 2026-08-24) and every Encompass
 * source id was verified live on two real loans before it was written down
 * (scratchpad probe, 2026-08-24 — the FR0117 lesson: never batch an unverified
 * id). Zero RTL imports.
 *
 * THE OWNER'S SPEC (2026-08-23, sent three times): a new Encompass file creates
 * a linked ClickUp task in the officer's folder with the ysportal stamp; field
 * changes update the linked card; "Don't fill this blindly! … pull up your
 * entire RTL mapping … all the guards … Only the mapping should be brand new."
 *
 * SOURCES — each row's `src(bag)` reads from ONE bag the push assembles:
 *   loan       lt_loans row (the Encompass mirror)
 *   prop       lt_properties row
 *   borrower   lt_parties role='borrower'   (mirror)
 *   coborrower lt_parties role='coborrower' (null = KNOWN none; undefined = unread)
 *   residence / priorResidence   the borrower's lt_residences rows
 *   ex         LIVE Encompass values read at push time (fieldReaderSplit) —
 *              Encompass always wins; {} when Encompass is off, and then the
 *              mirror fallback answers. Absent = not written, never cleared.
 *   officer / processor          {name, email, clickupUserId} or null
 *   subjectGeo / borrowerGeo / priorGeo   {lat,lng,formatted} or null
 *   investorLoanNumber, portalFileId, portalFileLink
 *
 * LOCATIONS ARE FILL-ONLY, BY DESIGN (a deliberate, SAFER departure from RTL):
 * RTL may rewrite a location through the sameAddress/compare machinery; the LT
 * writer NEVER rewrites an occupied location field — it only fills a blank one
 * (isBlankClickupValue decides). That forecloses the whole
 * geocoder-rewrites-the-address corruption class (the Piscataway incident)
 * without copying the 400-line address comparator, and an officer's hand-typed
 * address can never be fought over. The cost — an Encompass address CORRECTION
 * does not reach an occupied card — is accepted for v1 and recorded here.
 */

const T = require('./transforms');

// ---- ClickUp field ids (live catalog, 2026-08-24) --------------------------
const CU = Object.freeze({
  // Every id below was read off the LIVE workspace field catalog (161
  // fields, 2026-08-24) — generated, not typed, so a tail can never be a
  // guess. The comment on each line is the catalog's own type + name.
  channel: "6eb27010-b23a-46a7-9040-40d68d930e9d", // drop_down "*Wholesale / correspondent"
  companyLead: "ef5c471b-4289-4280-8379-9e5446a74b30", // checkbox "*Company lead"
  loanOfficer: "14839ebf-b214-4841-af35-ca10703397f3", // users "Loan Officer"
  loanOfficerEmail: "9f6cc87f-b93d-4dce-a13e-66de8f47616a", // email "*Loan Officer Email"
  processor: "926bad3b-d1a2-432b-8bb4-867c9f7d9a5b", // users "Processor"
  processorEmail: "4f7b2c03-44da-47a5-8d4c-c0aa823b1283", // email "Processor Email"
  clearFileNotes: "c80cd7aa-ec96-49b4-a313-be023178b125", // text "Clear File Notes"
  expectedClosing: "de57d9fb-4c9e-4881-b6bf-fcf6268e44a6", // date "Expected Closing Date"
  subjectAddress: "ef691991-2d07-4d61-aefe-e34a332d61de", // location "*Subject Property Address"
  borrowerName: "474a54a3-a430-4e1f-a3ca-b94d375bece8", // short_text "*Borrower Name"
  borrowerDOB: "d4e72161-3688-4653-9d35-bd73e04066f7", // date "Borrower DOB"
  borrowerSSN: "51e0826e-0293-4d13-ba73-04e4547de520", // short_text "Borrower SSN"
  borrowerEmail: "743c16d3-68f8-4ea2-bda2-e22bf30bbe3b", // email "*Borrower Email"
  secondBorrowerEmail: "a5e70ced-f60a-4832-92ba-0d7bee087eb1", // email "2nd Borrower Email"
  borrowerCell: "d60cf254-0914-4da9-91cb-c314a64eaa73", // short_text "📞 *Borrower Cell Number"
  secondBorrowerCell: "37837aab-8e6c-4550-b626-01b35e6f5bf0", // phone "2nd Borrower Cell Number"
  borrowerFico: "a67357ca-69f0-497b-afd4-39581af60a30", // number "Borrower FICO"
  borrowerAddress: "0b469d1b-a9b0-41de-aac3-b1c3c954d9b4", // location "*Borrower Address"
  primaryHousing: "6ae80836-6835-4c91-a3ef-209923f89e30", // drop_down "Primary Housing"
  primaryHousingPayment: "51a91012-5665-4f22-b0c6-3048ed862e3b", // currency "Primary Housing"
  yearsAtResidence: "fabf5994-e218-43ee-9694-3b2e0caf2a12", // short_text "How many Years at Primary Residence?"
  priorAddress: "616f218e-7bb3-4ee2-9f94-f9f96a054516", // location "If less than 2 years at Residence, add Prior Address"
  vesting: "173dc79a-a12d-4233-a6a6-9f4101770ca9", // drop_down "*Vesting"
  llcName: "8bb530c0-a903-487d-bfcd-17810ecffddd", // text "*LLC Name"
  maritalStatus: "b91e06a6-ed47-4249-afa5-eaaedf7b4c3e", // drop_down "Marital Status"
  coBorrowerFlag: "a62d4e6a-5699-4682-8ac1-144b5119f523", // drop_down "*Is there a Co-borrower?"
  coBorrowerName: "5e4d2128-886c-4705-afce-a22ad311a1a9", // short_text "Co-Borrower Name"
  lender: "a914ec5a-7419-480f-9c28-982f979e8702", // drop_down "*Lender"
  occupancy: "df9d81b5-0b5d-4e09-a44a-4bbfb3b0291c", // drop_down "* Occupancy "
  loanType: "ee1b564f-13cb-4841-af4c-e0f762cbcf52", // drop_down "*Loan type"
  program: "50eb857a-d8b1-4c48-9ffe-20b15cdf1338", // drop_down "*Program"
  propertyType: "541524d9-255f-4484-ac6d-1011ac60e87b", // drop_down "*Property Type"
  units: "81fc839f-23f5-4780-a5f1-8298121cce2b", // number "*Number of Units"
  pppTypeTerm: "82269a33-79e8-4495-9d74-320edf4e41b6", // short_text "*PPP Type & term"
  yearPurchased: "3668188f-baf5-4a8b-8683-0b223206f060", // short_text "Year Purchased? (Refi only)"
  originalPurchasePrice: "253e80ff-9a76-432e-a2ac-366db5a2c3c5", // currency "Original Purchase Price? (Refi only)"
  term: "b67dd5fd-c753-47e9-b3dd-aa576d742abd", // drop_down "Term"
  purchaseOrEstimate: "0fc6370c-60b7-4e20-8b5c-0facb90729cf", // currency "*Purchase price / Estimate Value? "
  loanAmount: "e393e64a-63e3-46cc-ae03-402520614f28", // currency "*Loan Amount"
  ltv: "3f5cd2e2-9238-4eff-9762-ca888c14201d", // short_text "*LTV"
  approxAppraised: "834d0ffb-38ac-4358-b1ea-13f5d345dd91", // currency "*Approximate Appraised Value"
  actualAppraised: "9356ceea-f3b2-4373-9271-d1354214db47", // currency "Actual Appraised Value"
  desiredRate: "bf47a4c9-3489-48b2-b4c3-531ca417ec3f", // short_text "Desired Intrest Rate"
  actualRate: "cf4fd648-efe9-47fc-b547-f166978d97de", // short_text "Actual Intrest Rate"
  desiredRatePct: "ca47de7f-40b7-4a98-b540-2378c0e87954", // number "Desired Rate %"
  dateAcquired: "dd703e85-247e-4b3b-9664-f73c4877162c", // date "Date Subject Property was Purchased?"
  cema: "c5e97bf7-5de5-4f2c-97ac-b8912f967dad", // checkbox "Will there be a CEMA?"
  subjectInsurance: "941037c6-d0f4-437e-b339-fb7657214fdc", // currency "Subject Property Insurance"
  subjectTaxes: "5e4ed4c7-6425-4f3b-974b-11df2252a45b", // currency "Subject Property Taxes"
  subjectHoa: "69d5d460-728a-4f25-9a58-571a4269b8e8", // currency "Subject Property HOA"
  subjectPmi: "4ae72bc7-64fc-41a3-a494-c92045fe3a85", // currency "Subject Property PMI"
  subjectRental: "6d7bf524-c33d-4322-a9d7-47c3fc66a427", // currency "Subject Property Rental Income"
  freeAndClear: "dbc94cf7-8551-491d-9311-14f5eb2b7e8a", // checkbox "Free and Clear"
  titleContact: "252cd875-adfa-4344-89e0-bdd1f0347d91", // email "Title Company Contact"
  insuranceContact: "0627751b-c206-4bbf-bd3e-943a99481fa8", // short_text "Insurance Company Contact Info"
  // Re-read off the live Loan Pipeline space catalog on 2026-09-03 (161 fields)
  // for the owner's "these stay blank on a Long-Term card" report. There is
  // also a short_text "1031 Agent Information" (2d566b9c-…) — deliberately NOT
  // mapped: Encompass carries no field for it on this tenant (the 2026-08 field
  // export has no 1031 / exchange field), so there is nothing to fill it from.
  citizenship: "045f993c-4c7a-4a03-b71d-44e3ed15aa07", // short_text "Citizenship"
  dependents: "19ce13e0-bdcd-43c3-b365-7b07f1f3824e", // short_text "Number of Dependents"
  dependentsAges: "2618c971-841e-40db-b4c9-46b20bb8ce1d", // text "Age of Dependents"
  titleCompany: "2c734172-ea63-40b4-b151-aca9cab05969", // short_text "Desired Title Company"
  insuranceCompany: "dc0b20e7-6b7b-462c-acaf-e9fecb8e84c9", // short_text "Insurance Company Name"
  dateSubmitted: "51ef2193-6f42-4b6a-ab8e-d4bc13f0bd0c", // date "Date File Submitted"
  actualClosing: "0846edc7-8619-4ee6-827e-a673570d3057", // date "Actual Closing Date"
  appSubmitted: "e1c2b5d7-14f4-47fe-98a5-13d733029f23", // drop_down "Application submitted?"
  investorLoanNumber: "8ff507cc-24f8-4aea-beec-349c7d575980", // short_text "investor Loan Number"
  ysLoanNumber: "a6da91bc-9eae-4f9d-b788-353afd4d2858", // short_text "YS Cap Loan Number"
  pppDropdown: "a7a92ef5-0011-49bf-9009-625064e6007e", // drop_down "Is there a Prepayment Penalty?"
  dscrRatio: "7157db7c-b102-4725-9dbe-2e88a83e5d55", // number "DSCR Ratio"
  portalFileId: "6bca11f0-47d5-460f-b915-30fc78c6e4c8", // short_text "YS Portal File ID"
  portalFileLink: "7b369ef5-452b-4448-8329-0683491e8917", // url "YS Portal File Link"
});

// ---- tiny value helpers ----------------------------------------------------
const s = (v) => { const t = String(v == null ? '' : v).trim(); return t === '' ? null : t; };
// Reject null/blank BEFORE Number(): Number(null) is 0 (finite!), and a null
// prepay-months answering 0 would write 'Non' — "no penalty" — as a fact about
// a loan nobody has read. (The same trap addressField guards for coordinates.)
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
/** Live Encompass value for an id, '' → null. */
const exv = (bag, id) => s(bag && bag.ex && bag.ex[id]);
/** normalize for label matching: lowercase, alnum+spaces, squeezed. */
const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9&+ ]/g, ' ').replace(/\s+/g, ' ').trim();
/** first email-looking token out of free text (a contact box holds anything). */
function emailIn(text) {
  const m = String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}
const fullNameOf = (p) => s(p && [p.first_name, p.middle_name, p.last_name, p.name_suffix].filter(Boolean).join(' '));
const phoneOf = (p) => s(p && (p.mobile_phone || p.home_phone));

// ---- label mappers (each returns a ClickUp option LABEL or null) -----------

/** CX.TABLEFUNDER -> the '*Wholesale / correspondent' channel (owner's map,
 * 2026-08-23, against the live vocabulary: Correspondent 242 / blank 206 /
 * Table Funding 139 / Non Delegated Correspondent 68 / Delegate correspondent
 * ÷ Evolve|In House / Brokering out / Wholesale (Out)). Blank AND unmatched
 * default to the non-delegated-correspondent channel — the owner's own rule. */
function channelLabel(raw) {
  const v = norm(raw);
  if (!v) return 'Non Del Correspondent';
  if (v.includes('table')) return 'Table funding';
  if (v.includes('evolve')) return 'Evolve Underwriting';
  if (v.includes('in house') || v.includes('inhouse')) return 'Delegate Correspondent';
  if (v.includes('wholesale') || v.includes('brokering')) return 'Wholesale';
  if (v.includes('correspondent')) return 'Non Del Correspondent';
  return 'Non Del Correspondent';
}

/** FR0115 (+ FR0116 payment) -> 'Primary Housing'. Own with a payment is a
 * mortgage; own with none is free and clear.
 *
 * LIVE-VERIFIED 2026-09-03 against the list's own field definition (GET
 * /list/{id}/field, read-only): the dropdown's options are exactly
 * 'Rent' / 'Mortgage' / 'Free' / 'Own Free & Clear' / 'Rent Free'. Two
 * corrections came out of that read:
 *   - the label for an owner with no payment was 'own free and clear', which
 *     matches NO live option (the resolver compares whole lowercased names, so
 *     "and" vs "&" is a miss) — the dropdown silently stayed blank for every
 *     free-and-clear owner. It is now the live spelling.
 *   - FR0115's live vocabulary on this tenant is Rent / Own /
 *     NoPrimaryHousingExpense (3 of the 12 most recent loans carry the third;
 *     the URLA-2020 word for "lives rent free"), which reached no branch here
 *     and left the dropdown blank. It is 'Rent Free', the same answer the
 *     payment twin below gives it. */
function housingLabel(fr0115, paymentRaw) {
  const v = norm(fr0115);
  if (!v) return null;
  if (v.includes('rentfree') || v.includes('rent free') || v.includes('liverentfree') || v.includes('live rent free')
      || v.includes('noprimaryhousingexpense') || v.includes('no primary housing expense')) return 'Rent Free';
  if (v.includes('rent')) return 'Rent';
  if (v.includes('own')) {
    const pay = T.parseMoney(paymentRaw);
    return pay != null && pay > 0 ? 'Mortgage' : 'Own Free & Clear';
  }
  return null;
}

/**
 * THE PRIMARY HOUSING PAYMENT — the currency twin of the dropdown above
 * (owner-directed 2026-09-03: *"if he is renting, it should be filled with the
 * amount of the rent that is listed … If he owns you can look which mortgage
 * is tied to his primary residence. If you can find it. If not you can skip
 * this field if he owns."*).
 *
 *   rent       → the rent Encompass lists on the present address (FR0116), or
 *                the mirror's `lt_residences.monthly_rent` when Encompass is off.
 *   own        → FR0116 if Encompass carries a payment there; otherwise the
 *                mortgage TIED TO THE HOME — the borrower's REO row that is the
 *                primary residence (Encompass `propertyUsageType`
 *                PrimaryResidence, or the same street + zip as the present
 *                address), and on it the mortgage/HELOC liabilities Encompass
 *                hangs on that property (`lt_liabilities.reo_property_id`), or
 *                the REO's own `monthly_mortgage_payment` when no liability is
 *                linked. Two candidate homes, or none → SKIPPED, never guessed.
 *   rent free  → nothing to write.
 *
 * Pure: reads only the bag. Anything it cannot find answers null (= not
 * written, never cleared).
 */
function housingBasis(fr0115, mirrorBasis) {
  const v = norm(fr0115) || norm(mirrorBasis);
  if (!v) return null;
  if (v.includes('rentfree') || v.includes('rent free') || v.includes('liverentfree') || v.includes('live rent free')
      || v.includes('no primary housing expense') || v.includes('noprimaryhousingexpense')) return 'rent_free';
  if (v.includes('rent')) return 'rent';
  if (v.includes('own')) return 'own';
  return null;
}
function sameStreetAndZip(a, b) {
  const st = (x) => norm(x && x.street);
  const zip = (x) => String((x && x.zip) || '').replace(/\D/g, '').slice(0, 5);
  return !!(st(a) && st(b) && zip(a) && zip(b) && st(a) === st(b) && zip(a) === zip(b));
}
function isPrimaryResidenceReo(reo, residence) {
  const occ = norm(reo && reo.occupancy_type);
  if (occ === 'primaryresidence' || occ === 'primary residence' || occ === 'primary') return true;
  return sameStreetAndZip(reo, residence);
}
function isMortgageLiability(liab) {
  const t = norm(liab && liab.liability_type);
  return t.includes('mortgage') || t.includes('heloc');
}
function primaryResidenceMortgagePayment(bag) {
  const reos = Array.isArray(bag && bag.reos) ? bag.reos : [];
  const homes = reos.filter((r) => isPrimaryResidenceReo(r, bag.residence));
  if (homes.length !== 1) return null;                   // none, or two — a guess either way
  const home = homes[0];
  const liabs = (Array.isArray(bag.liabilities) ? bag.liabilities : [])
    .filter((l) => l && l.reo_property_id && String(l.reo_property_id) === String(home.id)
      && !l.to_be_paid_off && isMortgageLiability(l));
  const fromLiabs = liabs.reduce((sum, l) => sum + (T.parseMoney(l.monthly_payment) || 0), 0);
  if (fromLiabs > 0) return fromLiabs;
  const own = T.parseMoney(home.monthly_mortgage_payment);
  return own != null && own > 0 ? own : null;
}
function housingPayment(bag) {
  const residence = (bag && bag.residence) || null;
  const basis = housingBasis(exv(bag, 'FR0115'), residence && residence.residency_basis);
  if (!basis || basis === 'rent_free') return null;
  const listed = T.parseMoney(exv(bag, 'FR0116'));
  if (listed != null && listed > 0) return listed;
  if (basis === 'rent') {
    const mirror = T.parseMoney(residence && residence.monthly_rent);
    return mirror != null && mirror > 0 ? mirror : null;
  }
  return primaryResidenceMortgagePayment(bag);
}

/** URLA.X1 (`urla2020CitizenshipResidencyType`; live vocabulary USCitizen /
 * PermanentResidentAlien / NonPermanentResidentAlien) -> the 'Citizenship'
 * short_text, spelled the way the card's team reads it. An unmeasured word is
 * never guessed. */
function citizenshipLabel(v) {
  const t = norm(v).replace(/ /g, '');
  if (!t) return null;
  if (t === 'uscitizen' || t === 'unitedstatescitizen' || t === 'citizen') return 'US Citizen';
  if (t === 'permanentresidentalien' || t === 'permanentresident') return 'Permanent Resident Alien';
  if (t === 'nonpermanentresidentalien' || t === 'nonpermanentresident') return 'Non-Permanent Resident Alien';
  return null;
}

/** Field 53 / `lt_parties.dependent_count` -> the 'Number of Dependents'
 * short_text. A stated 0 IS an answer ("no dependants") and is written; a
 * blank states nothing. */
function dependentsCountText(live, mirror) {
  const pick = (x) => { const n = num(x); return n != null && n >= 0 && Number.isInteger(n) ? n : null; };
  const n = pick(live) != null ? pick(live) : pick(mirror);
  return n == null ? null : String(n);
}

/** A vendor card off the file's own contacts desk (`lt_loan_vendors` →
 * `service_contacts`), or null. The bag carries `vendors.title` and
 * `vendors.hazard_insurance`; a desk the push could not read is `undefined`. */
const vendorCard = (bag, kind) => (bag && bag.vendors && bag.vendors[kind]) || null;
const vendorCompany = (bag, kind) => { const c = vendorCard(bag, kind); return s(c && c.company_name); };
/** The card's scalar column, else the first entry of its array twin (db/224
 * added `emails[]` / `phones[]` beside `email` / `phone`). A missing array is
 * null, never the boolean `false` that `&&` would hand to String(). */
const firstOf = (scalar, arr) => s(scalar) || (Array.isArray(arr) && arr.length ? s(arr[0]) : null);
const vendorEmail = (bag, kind) => { const c = vendorCard(bag, kind); return c ? firstOf(c.email, c.emails) : null; };
/** "Contact info" for a short_text: who · email · phone — whatever the card holds. */
function vendorContactText(bag, kind) {
  const c = vendorCard(bag, kind);
  if (!c) return null;
  const parts = [s(c.contact_name), vendorEmail(bag, kind), firstOf(c.phone, c.phones)].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** 4008 word -> the '*Vesting' dropdown (the db/624 rule: Individual means
 * individual; Officer/Trustee are entity vestings). */
function vestingLabel(vestingType) {
  const v = norm(vestingType);
  if (!v) return null;
  if (v === 'individual') return 'Individual';
  if (v === 'officer') return 'LLC / Corp';
  if (v === 'trustee') return 'Trust';
  return null;                                   // an unmeasured word is never guessed
}

/** field 19 -> '*Loan type'. Live vocabulary: Purchase 345 / Cash-Out
 * Refinance 289 / NoCash-Out Refinance 70. */
function loanTypeLabel(purpose) {
  const v = norm(purpose);
  if (!v) return null;
  if (v.includes('delayed')) return 'Delayed Purchase Financing';
  if (v.includes('heloc')) return 'HELOC';
  if (v.includes('cash') && v.includes('no')) return 'Refi Rate & Term';
  if (v.includes('cash')) return 'Refi Cash-Out';
  if (v.includes('purchase')) return 'Purchase';
  if (v.includes('refinance') || v.includes('refi')) return 'Refi Rate & Term';
  return null;
}
const isRefi = (purpose) => { const l = loanTypeLabel(purpose); return !!l && l.startsWith('Refi'); };

/** field 1401 program name -> '*Program'. The owner's rule: "if it has any NEW
 * loan program, it should be mapped to this DSCR till the mapping is updated" —
 * a PRESENT-but-unmapped program defaults to DSCR (line at the bottom). A BLANK
 * mirror value is NOT a program (pre-merge audit round 2, obs 2): defaulting a
 * blank would rewrite a hand-set card label to DSCR on every full push during
 * a read gap, so a blank writes nothing. Live vocabulary: Investor DSCR 429 /
 * Fix & Flip 229 (short-term — never written) / DSCR I/O 29 / Conventional 6 /
 * HELOC 1. A SHORT-TERM program is skipped, never defaulted — writing DSCR
 * onto a bridge card would be a lie. */
function programLabel(programName) {
  const v = norm(programName);
  if (v.includes('flip') || v.includes('bridge') || v.includes('ground') || v.includes('hard money')) return null;
  if (!v) return null;
  if (v.includes('dscr')) return 'Non-QM - DSCR Ratio';
  if (v.includes('conventional')) return 'Conventional';
  if (v.includes('heloc')) return 'HELOC';
  if (v.includes('closed end sec') || v.includes('second')) return null;   // a loan TYPE here, not a program
  if (v.includes('bank statement')) {
    const months = v.includes('24') ? '24' : '12';
    const kind = v.includes('business') ? 'Business' : 'Personal';
    return `Non-QM - ${kind} Bank Statements ${months} Months`;
  }
  if (v.includes('full doc')) return 'Non-QM - Full Doc';
  if (v.includes('no ratio')) return 'Non-QM -  No Ratio';
  return 'Non-QM - DSCR Ratio';                  // the owner's default for this book
}

/** CX.PROPERTYTYPE -> '*Property Type'. Live vocabulary 2026-08-24:
 * Single Family Residence 250 / 2-4 Family 194 / Condo 19 / 2-4 Unit
 * Residential 18 / Multifamily (5+ Units) 15 / Mixed Use 4 / 5-10 Unit 1. */
function propertyTypeLabel(raw) {
  const v = norm(raw);
  if (!v) return null;
  if (v.includes('single family')) return 'SFR';
  if (v.includes('2 4') || v.includes('2-4') || v.includes('duplex') || v.includes('triplex') || v.includes('fourplex')) return 'Multi 2-4';
  if (v.includes('5+') || v.includes('5 units') || v.includes('multifamily') || v.includes('5 10')) return 'Multi 5+';
  if (v.includes('non warrantable')) return 'Non-warrantable condo';
  if (v.includes('warrantable')) return 'Warrantable condo';
  if (v.includes('condo')) return 'Condo';
  if (v.includes('townhouse') || v.includes('townhome')) return 'Townhouse';
  if (v.includes('mixed')) return 'Mixed Use';
  if (v.includes('co op') || v.includes('coop')) return 'Co-Op';
  return null;
}

/** field 1811 -> '* Occupancy '. Live: Investor 705 / PrimaryResidence 4. */
function occupancyLabel(raw) {
  const v = norm(raw);
  if (!v) return null;
  if (v.includes('invest')) return 'Investment';
  if (v.includes('primary')) return 'Primary';
  if (v.includes('second')) return 'Secondary';
  return null;
}

/** term months + interest-only months -> the 'Term' dropdown (owner's map). */
function termLabel(termMonths, ioMonths) {
  const t = num(termMonths);
  if (t == null) return null;
  const io = (num(ioMonths) || 0) > 0;
  if (t === 360) return io ? '30 year IO - 10 YEAR IO AND 20 Y FIXED' : '30 year';
  if (t === 480) return io ? '40 year IO - 10 YEAR IO AND 30 Y FIXED' : null;  // no plain 40-year option exists
  if (t === 180) return '15 year';
  if (t === 12) return '12 Months';
  return null;                                   // an unmapped term is never guessed
}

/** CX.PPPTERM (live vocabulary: '5 Year'…'No PPP') else prepay months ->
 * 'Is there a Prepayment Penalty?'. */
function pppLabel(pppTermRaw, months) {
  const v = norm(pppTermRaw);
  if (v) {
    if (v.includes('no ppp') || v === 'no' || v.includes('none')) return 'Non';
    const m = v.match(/^([1-5])\s*year/);
    if (m) return `${m[1]} Years`;
    if (v.includes('6 month')) return '6 Months';
  }
  const n = num(months);
  if (n == null) return null;
  if (n === 0) return 'Non';
  if (n === 6) return '6 Months';
  if (n % 12 === 0 && n >= 12 && n <= 60) return `${n / 12} Years`;
  return null;
}

/** CX.PPPTERM + CX.PPPTYPE -> the free-text '*PPP Type & term'. */
function pppText(term, type) {
  const a = s(term), b = s(type);
  if (!a && !b) return null;
  if (a && b && norm(a) === norm(b)) return a;   // 'No PPP' / 'No PPP' says it once
  return [a, b].filter(Boolean).join(' — ');
}

/** VEND.X263 -> the 45-option '*Lender' dropdown. ONLY the spellings measured
 * on the live book (40 distinct, 2026-08-24) that map to exactly one option —
 * an unmatched spelling is SKIPPED, never guessed; the owner finishes the rest
 * (#41). Short tokens (RCN, BPL, ARC…) match as whole words only. */
const LENDER_RULES = [
  { test: (v) => v.includes('deephaven') || v.includes('deepahven') || v.includes('deephven') || v.includes('deep haven'), label: 'Deephaven' },
  { test: (v) => v.includes('champion'), label: 'Champions' },
  { test: (v) => v.includes('oaktree') || v.includes('oak tree'), label: 'Oak Tree' },
  { test: (v) => v.includes('acra'), label: 'Acra Lending' },
  { test: (v) => v.includes('a&d') || v.includes('a & d') || /\bad mortgage\b/.test(v), label: 'A&D Mortgage' },
  { test: (v) => /\brcn\b/.test(v), label: 'RCN Capital' },
  { test: (v) => v.includes('american heritag') || /\bahl\b/.test(v), label: 'American Heritage lending' },
  { test: (v) => /\broc\b/.test(v) || v.includes('roc capital'), label: 'Roc Capital' },
  { test: (v) => v.includes('onslow'), label: 'Onslow Bay' },
  { test: (v) => v.includes('constructive cap') || /\bbpl\b/.test(v), label: 'BPL' },
  { test: (v) => /\bemcap\b/.test(v), label: 'EMCAP Financial' },
  { test: (v) => /\bnqm\b/.test(v) || v.includes('nonqm funding'), label: 'NQM Funding' },
  { test: (v) => v.includes('fidelis warehouse'), label: 'Fidelis Warehouse' },
  { test: (v) => v.includes('fidelis'), label: 'Fidelis Investors LLC' },
  { test: (v) => v.includes('corrfirst') || v.includes('corr first'), label: 'CorrFirst' },
  { test: (v) => v.includes('dominion'), label: 'dominion financial ' },
  { test: (v) => v.includes('the loan store'), label: 'The Loan Store' },
  { test: (v) => v.includes('cake'), label: 'Cake Mortgage' },
  { test: (v) => v.includes('eresi'), label: 'eResi' },
  { test: (v) => v.includes('foundation'), label: 'Foundation ' },
  { test: (v) => v.includes('bluelake') || v.includes('blue lake'), label: 'Blue Lake Capital' },
  { test: (v) => v.includes('pennymac') || v.includes('penny mac'), label: 'PennyMac ' },
  { test: (v) => /\bphh\b/.test(v), label: 'PHH' },
  { test: (v) => v.includes('amwest') || v.includes('am west'), label: 'AmWest' },
  { test: (v) => v.includes('the lender'), label: 'The Lender' },
  { test: (v) => /\barc\b/.test(v), label: 'ARC' },
  { test: (v) => v.includes('temple view') || v.includes('templeview'), label: 'Temple View funding ' },
  { test: (v) => v.includes('logan'), label: 'Logan Finance' },
  { test: (v) => v.includes('amerihome') || v.includes('ameri home'), label: 'AmeriHome' },
  { test: (v) => v.includes('broadview'), label: 'Broadview funding' },
  { test: (v) => v.includes('church hill') || v.includes('churchill'), label: 'Church Hill' },
  { test: (v) => v.includes('newrez') || v.includes('new rez'), label: 'NewRez' },
];
function lenderLabel(raw) {
  const v = norm(raw);
  if (!v || v === '-' || /^[\d\s.-]+$/.test(v)) return null;   // junk: '--', pasted numbers
  for (const r of LENDER_RULES) { if (r.test(v)) return r.label; }
  return null;                                   // the owner maps the rest (#41)
}

/** CX.SUBMITEDTOINVESTOR 'X' -> 'YES' (blank claims nothing — never guessed). */
const appSubmittedLabel = (raw) => (s(raw) ? 'YES' : null);

const isChecked = (raw) => { const v = norm(raw); return v === 'x' || v === 'y' || v === 'yes' || v === 'true'; };

/** LTV text: '35.000' -> '35', '67.500' -> '67.5'. */
function ltvText(raw) {
  const n = num(String(raw == null ? '' : raw).replace(/[%,\s]/g, ''));
  if (n == null || n <= 0 || n > 200) return null;
  return String(Number(n.toFixed(3)));
}

/** FR0112 years + FR0124 months -> 'How many Years at Primary Residence?'. */
function yearsAtResidenceText(years, months, durationMonths) {
  let y = num(years), m = num(months);
  if (y == null && m == null) {
    const d = num(durationMonths);
    if (d == null) return null;
    y = Math.floor(d / 12); m = d % 12;
  }
  const parts = [];
  if (y != null && y > 0) parts.push(`${y} year${y === 1 ? '' : 's'}`);
  if (m != null && m > 0) parts.push(`${m} month${m === 1 ? '' : 's'}`);
  if (!parts.length) return (y != null || m != null) ? 'Less than a month' : null;
  return parts.join(' ');
}

/** The dynamic '*Purchase price / Estimate Value?' (owner's rule, verified
 * live: purchase -> 136 always; refi -> 1821 until 356 overwrites). */
function purchaseOrEstimate(bag) {
  const purpose = exv(bag, '19') || s(bag.loan && bag.loan.loan_purpose);
  if (isRefi(purpose)) {
    return exv(bag, '356') || s(bag.prop && bag.prop.appraised_value)
        || exv(bag, '1821') || s(bag.prop && bag.prop.estimated_value);
  }
  return exv(bag, '136') || s(bag.prop && bag.prop.purchase_price);
}

// ---- THE FIELD MAP ---------------------------------------------------------
// Each row: { cu, key, name, type, src(bag) }. For a dropdown, src returns the
// option LABEL (writeValue resolves the live UUID). A src returning null/''
// means "nothing to write" — the push SKIPS it (never clears, G2).
const FIELD_MAP = [
  { cu: CU.channel, key: 'channel', name: '*Wholesale / correspondent', type: 'dropdown',
    // ANSWERED beats UNREAD (pre-merge audit 2026-08-24, defect 1). The
    // fieldReader returns '' for a genuinely BLANK field — the key is PRESENT —
    // and omits a field it could not read; readExtras collapses a whole outage
    // into {}. The owner's blank→'Non Del Correspondent' default may only ever
    // stand in for Encompass ANSWERING blank: defaulting on an UNREAD channel
    // rewrote every occupied '*Wholesale / correspondent' dropdown (139 live
    // cards carry 'Table funding') to the default during any Encompass outage.
    // Unread live → the mirror's channel if the mirror holds one; else claim
    // NOTHING (absent = not written, never cleared — the file's own contract).
    src: (b) => {
      if (b && b.ex && ('CX.TABLEFUNDER' in b.ex)) return channelLabel(b.ex['CX.TABLEFUNDER']);
      const mirror = s(b && b.investorChannel);
      return mirror ? channelLabel(mirror) : null;
    } },
  { cu: CU.companyLead, key: 'company_lead', name: '*Company lead', type: 'checkbox',
    src: (b) => (isChecked(exv(b, 'CX.COMPANYLEAD')) ? true : null) },
  { cu: CU.loanOfficerEmail, key: 'loan_officer_email', name: '*Loan Officer Email', type: 'email',
    src: (b) => s(b.officer && b.officer.email) },
  { cu: CU.loanOfficer, key: 'loan_officer', name: 'Loan Officer', type: 'users',
    src: (b) => (b.officer && b.officer.clickupUserId ? Number(b.officer.clickupUserId) : null) },
  // The processor pair is BOTH-or-NEITHER (§5.2 of the guard contract) —
  // enforced after the loop in buildTaskFields.
  { cu: CU.processor, key: 'processor', name: 'Processor', type: 'users',
    src: (b) => (b.processor && b.processor.clickupUserId ? Number(b.processor.clickupUserId) : null) },
  { cu: CU.processorEmail, key: 'processor_email', name: 'Processor Email', type: 'email',
    src: (b) => s(b.processor && b.processor.email) },
  { cu: CU.clearFileNotes, key: 'clear_file_notes', name: 'Clear File Notes', type: 'text',
    src: (b) => exv(b, 'CX.FILENOTESTASKPAGE') },
  { cu: CU.expectedClosing, key: 'expected_closing', name: 'Expected Closing Date', type: 'date',
    src: (b) => exv(b, '763') },
  { cu: CU.subjectAddress, key: 'subject_address', name: '*Subject Property Address', type: 'location',
    src: (b) => b.subjectGeo || null },
  { cu: CU.borrowerName, key: 'borrower_name', name: '*Borrower Name', type: 'text',
    src: (b) => {
      // THE PARSED NAME WINS (owner-reported 2026-08-24 — the card read surname
      // first). `loan.borrower_name` is the Encompass PIPELINE display string in
      // "LAST, FIRST" order; the parsed parts are already in reading order AND
      // carry the middle name and suffix, so preferring them fixes the order and
      // gains detail. The pipeline name is the fallback for a loan we have only
      // discovered and not yet fully read — reordered when it is provably safe.
      const v = fullNameOf(b.borrower) || T.reorderCommaName(s(b.loan && b.loan.borrower_name));
      return T.isPlaceholderName(v) ? null : (s(v) || null);
    } },
  { cu: CU.borrowerDOB, key: 'date_of_birth', name: 'Borrower DOB', type: 'date',
    src: (b) => exv(b, '1402') || s(b.borrower && b.borrower.date_of_birth) },
  { cu: CU.borrowerSSN, key: 'ssn', name: 'Borrower SSN', type: 'text',
    // LIVE ONLY, pass-through — the mirror deliberately stores last-4 alone.
    // Owner-directed 2026-08-23: the real Social goes onto the card.
    src: (b) => {
      const digits = String(exv(b, '65') || '').replace(/\D/g, '');
      return digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : null;
    } },
  { cu: CU.borrowerEmail, key: 'borrower_email', name: '*Borrower Email', type: 'email',
    src: (b) => {
      const v = exv(b, '1240') || s(b.loan && b.loan.borrower_email) || s(b.borrower && b.borrower.email);
      return v && !T.isShadowEmail(v) ? v : null;
    } },
  { cu: CU.secondBorrowerEmail, key: 'co_borrower_email', name: '2nd Borrower Email', type: 'email',
    src: (b) => {
      const v = exv(b, '1268') || s(b.coborrower && b.coborrower.email);
      return v && !T.isShadowEmail(v) ? v : null;
    } },
  { cu: CU.borrowerCell, key: 'borrower_cell', name: '*Borrower Cell Number', type: 'phone_text',
    src: (b) => phoneOf(b.borrower) },
  { cu: CU.secondBorrowerCell, key: 'co_borrower_cell', name: '2nd Borrower Cell Number', type: 'phone',
    src: (b) => phoneOf(b.coborrower) },
  { cu: CU.borrowerFico, key: 'fico', name: 'Borrower FICO', type: 'number',
    src: (b) => {
      const v = num(exv(b, 'VASUMM.X23')) != null ? num(exv(b, 'VASUMM.X23'))
        : num(b.borrower && b.borrower.fico_representative);
      return v != null && v >= 300 && v <= 850 ? v : null;
    } },
  { cu: CU.borrowerAddress, key: 'current_address', name: '*Borrower Address', type: 'location',
    src: (b) => b.borrowerGeo || null },
  { cu: CU.primaryHousing, key: 'primary_housing', name: 'Primary Housing', type: 'dropdown',
    src: (b) => housingLabel(exv(b, 'FR0115'), exv(b, 'FR0116')) },
  { cu: CU.primaryHousingPayment, key: 'primary_housing_payment', name: 'Primary Housing ($)', type: 'currency',
    src: (b) => housingPayment(b) },
  { cu: CU.yearsAtResidence, key: 'years_at_residence', name: 'How many Years at Primary Residence?', type: 'text',
    src: (b) => yearsAtResidenceText(exv(b, 'FR0112'), exv(b, 'FR0124'), b.residence && b.residence.duration_months) },
  { cu: CU.priorAddress, key: 'prior_address', name: 'Prior Address', type: 'location',
    // ClickUp's own label carries the rule: only when under 2 years at the
    // present residence.
    src: (b) => {
      const months = (num(exv(b, 'FR0112')) || 0) * 12 + (num(exv(b, 'FR0124')) || 0);
      const dur = months > 0 ? months : num(b.residence && b.residence.duration_months);
      if (dur == null || dur >= 24) return null;
      return b.priorGeo || null;
    } },
  { cu: CU.vesting, key: 'vesting', name: '*Vesting', type: 'dropdown',
    src: (b) => vestingLabel(b.loan && b.loan.vesting_type) },
  { cu: CU.llcName, key: 'llc_name', name: '*LLC Name', type: 'text',
    src: (b) => {
      const t = norm(b.loan && b.loan.vesting_type);
      if (t !== 'officer' && t !== 'trustee') return null;   // Individual NEVER writes an entity name (db/624)
      return s(b.loan && b.loan.vesting_entity_name);
    } },
  { cu: CU.citizenship, key: 'citizenship', name: 'Citizenship', type: 'text',
    src: (b) => citizenshipLabel(exv(b, 'URLA.X1') || s(b.borrower && b.borrower.citizenship)) },
  { cu: CU.dependents, key: 'dependents', name: 'Number of Dependents', type: 'text',
    src: (b) => dependentsCountText(exv(b, '53'), b.borrower && b.borrower.dependent_count) },
  { cu: CU.dependentsAges, key: 'dependents_ages', name: 'Age of Dependents', type: 'text',
    src: (b) => exv(b, '54') || s(b.borrower && b.borrower.dependents_ages) },
  { cu: CU.maritalStatus, key: 'marital_status', name: 'Marital Status', type: 'dropdown',
    src: (b) => {
      const verdict = T.normalizeMarried(exv(b, '52') || s(b.borrower && b.borrower.marital_status));
      return verdict == null ? null : (verdict ? 'YES' : 'NO');
    } },
  { cu: CU.coBorrowerFlag, key: 'co_borrower_flag', name: '*Is there a Co-borrower?', type: 'dropdown',
    // null = KNOWN none (the borrower pair was read and holds one party);
    // undefined = the parties were never read — claim nothing.
    src: (b) => {
      if (b.coborrower === undefined) return null;
      return b.coborrower ? 'YES' : 'NO';
    } },
  { cu: CU.coBorrowerName, key: 'co_borrower_name', name: 'Co-Borrower Name', type: 'text',
    src: (b) => {
      const v = fullNameOf(b.coborrower);
      return T.isPlaceholderName(v) ? null : v;
    } },
  { cu: CU.lender, key: 'lender', name: '*Lender', type: 'dropdown',
    src: (b) => lenderLabel(exv(b, 'VEND.X263') || s(b.investorName)) },
  { cu: CU.occupancy, key: 'occupancy', name: '* Occupancy ', type: 'dropdown',
    src: (b) => occupancyLabel(exv(b, '1811') || s(b.prop && b.prop.occupancy_type)) },
  { cu: CU.loanType, key: 'loan_type', name: '*Loan type', type: 'dropdown',
    src: (b) => loanTypeLabel(exv(b, '19') || s(b.loan && b.loan.loan_purpose)) },
  { cu: CU.program, key: 'program', name: '*Program', type: 'dropdown',
    src: (b) => programLabel(s(b.loan && b.loan.program_name)) },
  { cu: CU.propertyType, key: 'property_type', name: '*Property Type', type: 'dropdown',
    src: (b) => propertyTypeLabel(exv(b, 'CX.PROPERTYTYPE') || s(b.prop && b.prop.gse_property_type)) },
  { cu: CU.units, key: 'units', name: '*Number of Units', type: 'number',
    src: (b) => num(exv(b, '16')) != null ? num(exv(b, '16')) : num(b.prop && b.prop.unit_count) },
  { cu: CU.pppTypeTerm, key: 'ppp_type_term', name: '*PPP Type & term', type: 'text',
    src: (b) => pppText(exv(b, 'CX.PPPTERM'), exv(b, 'CX.PPPTYPE')) },
  { cu: CU.yearPurchased, key: 'year_purchased', name: 'Year Purchased? (Refi only)', type: 'text',
    src: (b) => (isRefi(exv(b, '19') || s(b.loan && b.loan.loan_purpose)) ? exv(b, '24') : null) },
  { cu: CU.originalPurchasePrice, key: 'original_purchase_price', name: 'Original Purchase Price? (Refi only)', type: 'currency',
    src: (b) => (isRefi(exv(b, '19') || s(b.loan && b.loan.loan_purpose))
      ? (exv(b, '25') || s(b.prop && b.prop.original_cost)) : null) },
  { cu: CU.term, key: 'term', name: 'Term', type: 'dropdown',
    src: (b) => termLabel(b.loan && b.loan.term_months,
      num(exv(b, '1177')) != null ? num(exv(b, '1177')) : (b.loan && b.loan.interest_only_months)) },
  { cu: CU.purchaseOrEstimate, key: 'purchase_or_estimate', name: '*Purchase price / Estimate Value? ', type: 'currency',
    src: (b) => purchaseOrEstimate(b) },
  { cu: CU.loanAmount, key: 'loan_amount', name: '*Loan Amount', type: 'currency',
    src: (b) => s(b.loan && b.loan.loan_amount) },
  { cu: CU.ltv, key: 'ltv', name: '*LTV', type: 'text',
    src: (b) => ltvText(exv(b, '353') || s(b.prop && b.prop.ltv_pct)) },
  { cu: CU.approxAppraised, key: 'approx_appraised', name: '*Approximate Appraised Value', type: 'currency',
    src: (b) => exv(b, '1821') || s(b.prop && b.prop.estimated_value) },
  { cu: CU.actualAppraised, key: 'actual_appraised', name: 'Actual Appraised Value', type: 'currency',
    src: (b) => exv(b, '356') || s(b.prop && b.prop.appraised_value) },
  { cu: CU.desiredRate, key: 'desired_rate', name: 'Desired Intrest Rate', type: 'text',
    src: (b) => s(exv(b, '3') || (b.loan && b.loan.note_rate_pct)) },
  { cu: CU.actualRate, key: 'actual_rate', name: 'Actual Intrest Rate', type: 'text',
    src: (b) => s(exv(b, '3') || (b.loan && b.loan.note_rate_pct)) },
  { cu: CU.desiredRatePct, key: 'desired_rate_pct', name: 'Desired Rate %', type: 'number',
    src: (b) => num(exv(b, '3')) != null ? num(exv(b, '3')) : num(b.loan && b.loan.note_rate_pct) },
  { cu: CU.dateAcquired, key: 'date_acquired', name: 'Date Subject Property was Purchased?', type: 'date',
    src: (b) => exv(b, 'CX.DATEACQUIRED') },
  { cu: CU.cema, key: 'cema', name: 'Will there be a CEMA?', type: 'checkbox',
    src: (b) => (isChecked(exv(b, 'CORRESPONDENT.X141')) ? true : null) },
  { cu: CU.subjectInsurance, key: 'subject_insurance', name: 'Subject Property Insurance', type: 'currency',
    src: (b) => exv(b, '230') || s(b.loan && b.loan.expense_hazard_insurance) },
  { cu: CU.subjectTaxes, key: 'subject_taxes', name: 'Subject Property Taxes', type: 'currency',
    src: (b) => exv(b, '1405') || s(b.loan && b.loan.expense_real_estate_taxes) },
  { cu: CU.subjectHoa, key: 'subject_hoa', name: 'Subject Property HOA', type: 'currency',
    src: (b) => exv(b, '233') || s(b.loan && b.loan.expense_association_dues) },
  { cu: CU.subjectPmi, key: 'subject_pmi', name: 'Subject Property PMI', type: 'currency',
    src: (b) => exv(b, '232') },
  { cu: CU.subjectRental, key: 'subject_rental', name: 'Subject Property Rental Income', type: 'currency',
    src: (b) => exv(b, '1005') || s(b.prop && (b.prop.gross_monthly_rent || b.prop.actual_monthly_rent)) },
  { cu: CU.freeAndClear, key: 'free_and_clear', name: 'Free and Clear', type: 'checkbox',
    src: (b) => (isChecked(exv(b, 'CX.FREECLEAR')) ? true : null) },
  // THE VENDOR CONTACTS (owner-directed 2026-09-03: "fill the vendor contact
  // information from Encompass"). Encompass's File Contacts first — 411 is the
  // title company's name (filled on 232 of the tenant's long-term loans in the
  // 2026-08 export), 88 its email, L252 the hazard insurer's name (215), and the
  // two CX contact boxes — then the file's own contacts desk (the title and
  // hazard-insurance cards the loan officer picked before submittal) when
  // Encompass holds nothing.
  { cu: CU.titleCompany, key: 'title_company', name: 'Desired Title Company', type: 'text',
    src: (b) => exv(b, '411') || vendorCompany(b, 'title') },
  { cu: CU.titleContact, key: 'title_contact', name: 'Title Company Contact', type: 'email',
    src: (b) => emailIn(exv(b, 'CX.TITLECONTACT')) || emailIn(exv(b, '88')) || vendorEmail(b, 'title') },
  { cu: CU.insuranceCompany, key: 'insurance_company', name: 'Insurance Company Name', type: 'text',
    src: (b) => exv(b, 'L252') || vendorCompany(b, 'hazard_insurance') },
  { cu: CU.insuranceContact, key: 'insurance_contact', name: 'Insurance Company Contact Info', type: 'text',
    src: (b) => exv(b, 'CX.INSURANCECONTACT') || vendorContactText(b, 'hazard_insurance') },
  { cu: CU.dateSubmitted, key: 'date_submitted', name: 'Date File Submitted', type: 'date',
    src: (b) => exv(b, '745') },
  { cu: CU.actualClosing, key: 'actual_closing', name: 'Actual Closing Date', type: 'date',
    src: (b) => exv(b, 'CX.FUNDEDDATE') },
  { cu: CU.appSubmitted, key: 'app_submitted', name: 'Application submitted?', type: 'dropdown',
    src: (b) => appSubmittedLabel(exv(b, 'CX.SUBMITEDTOINVESTOR')) },
  { cu: CU.investorLoanNumber, key: 'investor_loan_number', name: 'investor Loan Number', type: 'text',
    src: (b) => exv(b, 'VEND.X276') || s(b.investorLoanNumber) },
  { cu: CU.ysLoanNumber, key: 'ys_loan_number', name: 'YS Cap Loan Number', type: 'text',
    src: (b) => {
      const v = s(b.loan && b.loan.loan_number);
      return T.isPlaceholderLoanNumber(v) ? null : v;    // a placeholder is never written (G13)
    } },
  { cu: CU.pppDropdown, key: 'ppp', name: 'Is there a Prepayment Penalty?', type: 'dropdown',
    src: (b) => pppLabel(exv(b, 'CX.PPPTERM'), b.loan && b.loan.prepayment_penalty_months) },
  { cu: CU.dscrRatio, key: 'dscr_ratio', name: 'DSCR Ratio', type: 'number',
    src: (b) => num(b.loan && b.loan.dscr_ratio) },
  { cu: CU.portalFileId, key: 'portal_file_id', name: 'YS Portal File ID', type: 'text',
    src: (b) => s(b.portalFileId) },
  { cu: CU.portalFileLink, key: 'portal_file_link', name: 'YS Portal File Link', type: 'url',
    src: (b) => s(b.portalFileLink) },
];

const FIELD_TYPE = new Map(FIELD_MAP.map((f) => [f.cu, f.type]));
const FIELD_BY_KEY = new Map(FIELD_MAP.map((f) => [f.key, f]));

/** The live Encompass ids the push reads at push time (through the
 * split-tolerant reader, so one bad id can never blank the batch). Every id
 * either passed the 2026-08-24 two-loan probe or is a standard URLA housing-
 * expense id riding the split tolerance. */
const EX_FIELD_IDS = Object.freeze([
  '3', '16', '19', '24', '25', '52', '65', '136', '230', '232', '233',
  '353', '356', '745', '763', '1005', '1177', '1240', '1268', '1402', '1405',
  '1811', '1821',
  'CX.TABLEFUNDER', 'CX.COMPANYLEAD', 'CX.FILENOTESTASKPAGE', 'CX.PROPERTYTYPE',
  'CX.PPPTERM', 'CX.PPPTYPE', 'CX.DATEACQUIRED', 'CORRESPONDENT.X141',
  'CX.FREECLEAR', 'CX.TITLECONTACT', 'CX.INSURANCECONTACT', 'CX.FUNDEDDATE',
  'CX.SUBMITEDTOINVESTOR', 'VEND.X276', 'VEND.X263',
  'FR0115', 'FR0116', 'FR0112', 'FR0124', 'FR0326', 'FR0306', 'FR0315',
  'VASUMM.X23',
  // 2026-09-03 — the blank-card report. Every id below is in the tenant's own
  // 2026-08 field export (docs/longterm/research-exports/01-every-field.csv)
  // with its long-term fill count: URLA.X1 citizenship (488), 53 dependants
  // count (273), 54 their ages (281), 411 title company name (232), 88 title
  // company email (223), L252 hazard insurer name (215).
  'URLA.X1', '53', '54', '411', '88', 'L252',
  // The status engine's terminal signal (live vocabulary: 'Loan Originated' /
  // 'Active Loan' / 'Application withdrawn' / 'Application denied').
  '1393',
  // The CO-borrower's own Social + DOB (standard URLA ids; unverified on the
  // two-loan probe — both loans had no co-borrower — and safe to carry BECAUSE
  // the reader is split-tolerant: an invalid id is omitted, never a blanked
  // batch).
  '97', '1403',
]);

// ---- write helpers (COPY of the RTL machinery) -----------------------------
function writeValue(f, val, options) {
  if (val == null || val === '') return undefined;
  switch (f.type) {
    case 'dropdown': {
      const label = String(val);
      if (!label) return undefined;
      return T.dropdownLabelToId((options && options[f.cu]) || [], label) || undefined;
    }
    case 'currency': case 'number': return T.numToString(T.parseMoney(val) != null ? T.parseMoney(val) : val);
    // Date-only fields write ClickUp's OWN convention (4 AM workspace time), so
    // the calendar day renders correctly for every viewer — an epoch at UTC
    // midnight displays as the previous day to the whole US-based team (the
    // 2026-07-15 "portal changed the DOBs" incident). Never write toEpochMs here.
    case 'date': return T.dateOnlyToClickUpEpoch(val);
    case 'phone': case 'phone_text': return T.normalizePhone(val);
    case 'checkbox': return val ? 'true' : 'false';
    case 'users': {
      const id = Number(val);
      return Number.isFinite(id) && id > 0 ? { add: [id] } : undefined;
    }
    case 'location': {
      const af = addressField(f.cu, val);
      return af ? af.value : undefined;
    }
    default: return String(val);
  }
}

/**
 * Is a ClickUp custom-field value EMPTY? The fill-only guards decide "may I
 * write here?" off this, so it has to recognise every shape an unset field
 * comes back as — including a `location` field, which arrives as null, as {},
 * or as an object carrying a blank formatted_address and no coordinates.
 * Reading one of those as OCCUPIED is what leaves a blank card permanently
 * un-fillable. Pure. (COPY of RTL mapper.js:201-219.)
 */
function isBlankClickupValue(v) {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v !== 'object') return false;
  const loc = v.location || v.position || v.geolocation || null;
  const looksLocationish = loc != null || 'formatted_address' in v || 'formattedAddress' in v;
  if (looksLocationish) {
    const lat = loc ? (loc.lat != null ? loc.lat : loc.latitude) : null;
    const lng = loc ? (loc.lng != null ? loc.lng : loc.longitude) : null;
    // Reject null explicitly BEFORE Number(): Number(null) is 0, which is finite,
    // so a coordinate-less location would otherwise read as occupied and the card
    // could never be filled (the same trap addressField() guards on the write side).
    const hasCoords = lat != null && lng != null
      && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const text = String(v.formatted_address || v.formattedAddress || v.value || '').trim();
    return !hasCoords && !text;
  }
  return Object.keys(v).length === 0;
}

function addressField(id, addr) {
  // Only emit a location field when we have REAL coordinates (ClickUp requires
  // lat/lng). Reject null AND non-finite (NaN/Infinity) explicitly: Number(null)
  // is 0 (finite!) and a NaN would JSON-serialize to null — either way ClickUp
  // would receive a location-clearing/garbage write. (COPY of RTL G9.)
  if (!addr || addr.lat == null || addr.lng == null
      || !Number.isFinite(Number(addr.lat)) || !Number.isFinite(Number(addr.lng))) return null;
  const formatted = addr.formatted_address || addr.formatted || addr.oneLine
    || [addr.street, addr.city, [addr.state, addr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (!String(formatted || '').trim()) return null;
  return { id, value: { location: { lat: Number(addr.lat), lng: Number(addr.lng) }, formatted_address: formatted } };
}

/**
 * Build the full ClickUp field set for a loan. Returns [{id, key, name, value}]
 * — everything non-empty, transformed, dropdowns resolved to live UUIDs.
 * A dropdown whose label has no live option is SKIPPED (never invent, §4.3).
 */
function buildTaskFields(bag, options = {}) {
  const out = [];
  for (const f of FIELD_MAP) {
    let raw;
    try { raw = f.src(bag); } catch (_) { raw = null; }
    const value = writeValue(f, raw, options);
    if (value === undefined || value === null || value === '') continue;
    out.push({ id: f.cu, key: f.key, name: f.name, value });
  }
  // The processor pair is BOTH-or-NEITHER: a half-written pair manufactures the
  // exact stale-artifact signature RTL's inbound guards exist to catch (§5.2).
  const hasProc = out.some((x) => x.id === CU.processor);
  const hasProcEmail = out.some((x) => x.id === CU.processorEmail);
  if (hasProc !== hasProcEmail) {
    const idx = out.findIndex((x) => x.id === (hasProc ? CU.processor : CU.processorEmail));
    if (idx >= 0) out.splice(idx, 1);
  }
  return out;
}

/**
 * The CO-BORROWER SUBTASK's field set (owner-directed 2026-08-23: a
 * co-borrower gets their own SUBTASK under the loan card, carrying their
 * personal + contact fields; the parent keeps the yes/no flag + the name).
 *
 * LIVE-VERIFIED on a POPULATED sample 2026-08-24 (YSCAP258134711, Pipeline,
 * Investor DSCR — the two original probe loans had no co-borrower): 4004/4005/
 * 4006 carry the co first/middle/last name, 97 the co SSN — NINE DIGITS AND
 * ALREADY DASHED in the live value, which is why the digits are extracted
 * before re-dashing below — 1403 the co DOB in the US 'MM/DD/YYYY' form the
 * date transform handles, and 1268 a real co email. Corpus-wide (the 772-loan
 * field dictionary): 23 DSCR + 37 fix&flip files carry the family, at
 * identical fill counts across 97/1403/4004/4006 — one consistent family, not
 * scattered leftovers.
 * The subtask reuses the PRIMARY borrower field ids — custom fields are
 * space-level, so on the subtask "Borrower SSN" simply holds the co-borrower's
 * Social. Same guards apply on the way out (the shield keys on these ids).
 */
function buildCoBorrowerFields(bag, options = {}) {
  const co = bag && bag.coborrower;
  if (!co) return [];
  const rows = [];
  const putRaw = (cu, key, name, type, raw) => {
    const f = { cu, key, name, type };
    const value = writeValue(f, raw, options);
    if (value !== undefined && value !== null && value !== '') rows.push({ id: cu, key, name, value });
  };
  const coSsn = (() => {
    const digits = String(exv(bag, '97') || '').replace(/\D/g, '');
    return digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : null;
  })();
  const name = fullNameOf(co);
  if (!T.isPlaceholderName(name)) putRaw(CU.borrowerName, 'co_name', 'Borrower Name (co)', 'text', name);
  putRaw(CU.borrowerDOB, 'co_dob', 'Borrower DOB (co)', 'date', exv(bag, '1403') || s(co.date_of_birth));
  if (coSsn) putRaw(CU.borrowerSSN, 'co_ssn', 'Borrower SSN (co)', 'text', coSsn);
  const email = exv(bag, '1268') || s(co.email);
  if (email && !T.isShadowEmail(email)) putRaw(CU.borrowerEmail, 'co_email', 'Borrower Email (co)', 'email', email);
  putRaw(CU.borrowerCell, 'co_cell', 'Borrower Cell (co)', 'phone_text', phoneOf(co));
  const fico = num(co.fico_representative);
  if (fico != null && fico >= 300 && fico <= 850) putRaw(CU.borrowerFico, 'co_fico', 'Borrower FICO (co)', 'number', fico);
  const married = T.normalizeMarried(s(co.marital_status));
  if (married != null) putRaw(CU.maritalStatus, 'co_marital', 'Marital Status (co)', 'dropdown', married ? 'YES' : 'NO');
  return rows;
}

// ---- PII overwrite shield + scoped-push keys (COPY of the RTL shape) -------
// A push may FILL a blank identity field, never REWRITE a differing one —
// blocked writes are journaled + queued for review. DOB has its own, stricter
// gate (any change to an existing DOB is a human decision). Locations are
// fill-only for EVERYTHING (see the header), so they need no shield entry.
const PII_OVERWRITE_SHIELD = Object.freeze({
  [CU.borrowerName]: 'borrower name',
  [CU.borrowerSSN]: 'borrower SSN',
  [CU.borrowerEmail]: 'borrower email',
  [CU.borrowerCell]: 'borrower cell',
  [CU.coBorrowerName]: 'co-borrower name',
  [CU.secondBorrowerEmail]: 'co-borrower email',
  [CU.secondBorrowerCell]: 'co-borrower cell',
});

/** field id -> the scoped re-push key an approved review uses. */
const PII_REVIEW_KEY = Object.freeze({
  [CU.borrowerName]: 'borrower_name',
  [CU.borrowerSSN]: 'ssn',
  [CU.borrowerEmail]: 'borrower_email',
  [CU.borrowerCell]: 'borrower_cell',
  [CU.coBorrowerName]: 'co_borrower_name',
  [CU.secondBorrowerEmail]: 'co_borrower_email',
  [CU.secondBorrowerCell]: 'co_borrower_cell',
  [CU.borrowerDOB]: 'date_of_birth',
});

/** Masked preview for a review row / journal — an SSN never lands readable. */
function reviewPreview(fieldId, value) {
  const v = value == null ? '' : String(value);
  if (fieldId === CU.borrowerSSN) return T.maskSSN(v);
  return v.length > 120 ? `${v.slice(0, 117)}…` : v;
}

/** Scoped-push resolver: a logical key -> the field ids it may write. */
function resolveOnly(keys) {
  const ids = new Set();
  for (const k of Array.isArray(keys) ? keys : [keys]) {
    if (k === 'portal_stamp') { ids.add(CU.portalFileId); ids.add(CU.portalFileLink); continue; }
    if (k === 'processor') { ids.add(CU.processor); ids.add(CU.processorEmail); continue; }
    if (k === 'co_borrower') {
      ids.add(CU.coBorrowerFlag); ids.add(CU.coBorrowerName);
      ids.add(CU.secondBorrowerEmail); ids.add(CU.secondBorrowerCell); continue;
    }
    const f = FIELD_BY_KEY.get(String(k));
    if (f) ids.add(f.cu);
  }
  return ids;
}

// ---- per-type no-op equivalence (COPY of the RTL contract, LT ids) ---------
const EMAIL_FIELD_IDS = new Set([
  CU.loanOfficerEmail, CU.processorEmail, CU.borrowerEmail, CU.secondBorrowerEmail, CU.titleContact,
]);
const PHONE_FIELD_IDS = new Set([CU.borrowerCell, CU.secondBorrowerCell]);
const NAME_FIELD_IDS = new Set([CU.borrowerName, CU.coBorrowerName]);

/** Same person, spelled with more or less detail? First and last word must
 * agree (case-insensitively); a middle name one side omits is the same person.
 * FRESH LT implementation (RTL's person-name module is not authorized here). */
function sameNameLoose(a, b) {
  const words = (x) => String(x || '').toLowerCase().replace(/[^a-z' -]/g, '').split(/[\s-]+/).filter(Boolean);
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return false;
  if (wa[0] !== wb[0] || wa[wa.length - 1] !== wb[wb.length - 1]) return false;
  // every word of the shorter form must appear in the longer one, in order
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  let j = 0;
  for (const w of shorter) { const at = longer.indexOf(w, j); if (at < 0) return false; j = at + 1; }
  return true;
}

/** Is the value already on the task equivalent to what we're about to write?
 *  Conservative: any doubt → NOT equivalent (the caller writes, preserving old
 *  behavior). ClickUp reads dropdowns as orderindex INTEGERS while writes take
 *  option UUIDs, and dates come back as epoch strings — so compare through the
 *  same transforms the sync itself uses. */
function fieldValueEquivalent(fieldId, oldVal, newVal, options, pushOpts) {
  if (oldVal === undefined) return false;               // unknown before → write
  if (oldVal === null || oldVal === '') return newVal == null || newVal === '';
  const type = FIELD_TYPE.get(fieldId);
  try {
    if (type === 'date') return T.fromEpochMs(oldVal) === T.fromEpochMs(newVal);
    if (type === 'currency' || type === 'number') return Number(oldVal) === Number(newVal);
    if (type === 'checkbox') return String(oldVal) === String(newVal);
    if (type === 'dropdown') {
      const asId = T.dropdownIndexToId((options && options[fieldId]) || [], oldVal);
      return asId != null && asId === newVal;
    }
    if (newVal && typeof newVal === 'object') {
      if (newVal.location && Number.isFinite(Number(newVal.location.lat))) {
        // Locations are FILL-ONLY here (see the header), so this branch is only
        // reached in unusual shapes; compare the formatted text, letters and
        // digits only, and treat agreement as equivalent. Doubt → not equivalent.
        const fa = (x) => String((x && (x.formatted_address || x.formattedAddress)) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return !!fa(oldVal) && fa(oldVal) === fa(newVal);
      }
      // USERS: the write shape is {add:[id]} — equivalent when every id to add
      // is already assigned (an add-only write would be a no-op).
      if (Array.isArray(newVal.add)) {
        const have = Array.isArray(oldVal) ? oldVal.map((u) => Number(u && u.id != null ? u.id : u)) : [];
        return newVal.add.length > 0 && newVal.add.every((uid) => have.includes(Number(uid)));
      }
      return false;  // unknown object shape — always write
    }
    // PHONE fields: '555-5550142', '+15555550142', '(555) 555-0142' are the
    // SAME number. Compare by the last 10 digits; shorter/garbled values fall
    // through to the exact-string compare.
    if (PHONE_FIELD_IDS.has(fieldId)) {
      const od = String(oldVal).replace(/\D/g, ''), nd = String(newVal == null ? '' : newVal).replace(/\D/g, '');
      if (od.length >= 10 && nd.length >= 10) return od.slice(-10) === nd.slice(-10);
    }
    // EMAIL fields: case- and whitespace-insensitive.
    if (EMAIL_FIELD_IDS.has(fieldId)) {
      return String(oldVal).trim().toLowerCase() === String(newVal == null ? '' : newVal).trim().toLowerCase();
    }
    // SSN: compare DIGITS-ONLY so a pure formatting difference (dashed vs bare)
    // is never read as an overwrite. A garbled/short value falls through.
    if (fieldId === CU.borrowerSSN) {
      const od = String(oldVal).replace(/\D/g, ''), nd = String(newVal == null ? '' : newVal).replace(/\D/g, '');
      if (od.length === 9 && nd.length === 9) return od === nd;
    }
    // NAME fields: the same person with a middle name added is NOT an
    // overwrite. Dropped when the push is an approved review — the one way a
    // human says "write exactly this".
    if (NAME_FIELD_IDS.has(fieldId)) {
      const humanNameEdit = !!(pushOpts && pushOpts.approvedReview);
      if (!humanNameEdit && sameNameLoose(String(oldVal), String(newVal == null ? '' : newVal))) return true;
    }
    return String(oldVal).trim() === String(newVal).trim();
  } catch (_) { return false; }
}

/** ANY change to an existing DOB (any magnitude) is a human decision — the
 *  push blocks it and queues a review. Filling a blank DOB is allowed. */
function isDobChange(fieldId, oldVal, newVal) {
  if (fieldId !== CU.borrowerDOB) return false;
  const oldDay = T.fromEpochMs(oldVal), newDay = T.fromEpochMs(newVal);
  return !!oldDay && !!newDay && oldDay !== newDay;
}

module.exports = {
  CU, FIELD_MAP, FIELD_TYPE, FIELD_BY_KEY, EX_FIELD_IDS,
  buildTaskFields, buildCoBorrowerFields, writeValue, addressField, isBlankClickupValue,
  fieldValueEquivalent, isDobChange, resolveOnly,
  PII_OVERWRITE_SHIELD, PII_REVIEW_KEY, reviewPreview,
  _internals: {
    channelLabel, housingLabel, vestingLabel, loanTypeLabel, isRefi, programLabel,
    propertyTypeLabel, occupancyLabel, termLabel, pppLabel, pppText, lenderLabel,
    appSubmittedLabel, ltvText, yearsAtResidenceText, purchaseOrEstimate,
    sameNameLoose, emailIn, isChecked,
    housingBasis, housingPayment, primaryResidenceMortgagePayment, citizenshipLabel,
    dependentsCountText, vendorContactText,
    // exported as a TEST SEAM so a guard can reach the real field row rather than
    // restating its logic — a test that re-types the rule proves nothing about it.
    FIELD_MAP,
  },
};
