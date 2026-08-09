'use strict';
/**
 * BUILDING THE DOCLAB PAYLOAD — PURE. No database, no network, no config lookup.
 *
 * In: a loaded view of a loan file (the shape `lib/closing-prep.getClosingPrepData`
 * already returns) plus the standing lender facts. Out: the JSON DocLab wants, and
 * an honest itemised list of what is still missing from it.
 *
 * THE ONE RULE: A VALUE WE DO NOT HAVE IS ABSENT AND REPORTED — NEVER GUESSED.
 * This is the whole reason the module exists, and DocLab's own design is what makes
 * it non-negotiable: they require exactly three fields and treat every other
 * variable as optional. So a missing value does not bounce. It produces a mortgage,
 * a note or a guaranty with a blank where a number should be, or it surfaces days
 * later as a person at PLL asking a question. Neither failure is visible at the
 * moment we submit, which is precisely when it is cheap to fix. `readiness()` is
 * what makes it visible then.
 *
 * WHY EVERYTHING IS A STRING. Their master payload sends money as "$250,000",
 * rates as "5.2" with no percent sign, and dates as "October 31, 2025" — a document
 * merge field takes text, and the text is what gets printed. So formatting is a
 * correctness concern here, not a presentation one: `$250000` or `2025-10-31`
 * appearing on a recorded instrument is a defect. `money()`, `pct()` and `longDate()`
 * are the only places a value is turned into what the document will say.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not compute a loan number, a rate, a
 * holdback or a payment. Every figure comes from the REGISTERED quote exactly as
 * the engine sized it (the frozen-numbers rule) — this module reads and formats, it
 * never re-derives. If a figure is not on the registration, it is missing, and that
 * is the correct answer.
 */

const catalog = require('./catalog');
const scope = require('./scope');
const fieldMap = require('./field-map');
/* WHAT KIND OF COMPANY THE BORROWER IS — the ONE definition, shared with the
   entity screens, the document slots and the closing desk, so "is this an LLC or
   a corporation" cannot be answered one way here and another way there. It is
   itself pure (no database, no config, no requires), which is what lets this
   module keep its own promise. */
const entityType = require('../lib/entity-type');

/* ───────────────────────────── formatting ───────────────────────────── */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** A finite number, or null. Never NaN, never a coerced empty string. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Money the way a document prints it: `$250,000` whole, `$1,234.56` with cents.
 * Cents are kept only when there are any — their own payload sends both forms.
 */
function money(v) {
  const n = num(v);
  if (n === null) return null;
  const cents = Math.round(Math.abs(n) * 100) % 100;
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
  });
}

/** A percentage as a bare number — their comment: "Percentage sign not required". */
function pct(v) {
  const n = num(v);
  if (n === null) return null;
  return String(Math.round(n * 1000) / 1000);
}

/**
 * A COUNT, grouped the way a document prints it: `1,000`. Used for a share count,
 * which is a whole number of things — a fractional or negative one is not a count
 * at all, so it is refused rather than rounded into something plausible. Null,
 * blank and junk all read as "not answered", which is what makes the readiness
 * report say so instead of printing a zero onto a pledge.
 */
function wholeNumber(v) {
  const n = num(v);
  if (n === null || n <= 0 || Math.floor(n) !== n) return null;
  return n.toLocaleString('en-US');
}

/**
 * A calendar string (`YYYY-MM-DD`) — or a Date — as "October 31, 2025".
 *
 * PARSED BY HAND, NEVER THROUGH `new Date('YYYY-MM-DD')`. That constructor reads a
 * date-only string as UTC midnight and then renders it in local time, which shifts
 * it to the previous day for anybody west of Greenwich. This repo has already been
 * bitten by exactly that (the ClickUp date incident), and the value here ends up
 * printed as the closing date on a mortgage.
 */
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function longDate(v) {
  const o = ymd(v);
  return o ? `${MONTHS[o.m - 1]} ${o.d}, ${o.y}` : null;
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** The last day of the month a date falls in — the per-diem accrual end. */
function lastDayOfMonth(v) {
  const o = ymd(v);
  if (!o) return null;
  return longDate(`${o.y}-${String(o.m).padStart(2, '0')}-${String(daysInMonth(o.y, o.m)).padStart(2, '0')}`);
}

/** The same day one year on. Calendar arithmetic only — no Date maths. */
function plusOneYear(v) {
  const o = ymd(v);
  if (!o) return null;
  const y = o.y + 1;
  const d = Math.min(o.d, daysInMonth(y, o.m));
  return longDate(`${y}-${String(o.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

function trimmed(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

function upper(v) { const s = trimmed(v); return s ? s.toUpperCase() : null; }

/* ───────────────────────────── the parties ───────────────────────────── */

/**
 * "the Guarantor" vs "collectively the Guarantor", and the three other phrases
 * DocLab wants spelled a particular way. Their master payload's comments give the
 * exact permitted strings, so these are transcriptions, not choices.
 */
function pluralPhrase(count, one, many) { return count > 1 ? many : one; }

/**
 * A person or company's one-line address. Their fields are single strings, so a
 * structured address is flattened here — and a PARTIAL address is refused rather
 * than flattened into something like ", NY " that looks like an address and is not.
 */
function addressLine(a) {
  if (!a) return null;
  if (typeof a === 'string') return trimmed(a);
  const street = trimmed(a.line1 || a.street || a.address1);
  const city = trimmed(a.city);
  const state = trimmed(a.state);
  const zip = trimmed(a.zip || a.postal_code);
  if (!street || !city || !state) return null;
  return `${street}, ${city}, ${state}${zip ? ' ' + zip : ''}`;
}

/* ───────────────────────────── the builder ───────────────────────────── */

/**
 * Records a variable, or records why it is missing.
 *
 * `required` here means "this template's matrix column asks for it", which is
 * computed from the catalog — not a hand-kept list, and not DocLab's own
 * three-field minimum (which would tell us nothing useful).
 */
function collector(requiredKeys) {
  const variables = {};
  const missing = [];
  const wanted = new Set(requiredKeys);
  return {
    variables, missing,
    set(key, value, why) {
      if (value === null || value === undefined || value === '') {
        if (wanted.has(key)) missing.push({ key, reason: why || 'PILOT has no value for this yet.' });
        return false;
      }
      variables[key] = value;
      return true;
    },
    /** Always sent, whether or not this template asks for it (DocLab requires it). */
    always(key, value) { if (value !== null && value !== undefined && value !== '') variables[key] = value; },
  };
}

/**
 * Build the request.
 *
 * @param file   the loaded loan-file view (see `lib/closing-prep.getClosingPrepData`)
 * @param lender the standing YS Capital facts (from config — never from the file)
 * @param opts   { requestId, loanCategory, prepaymentAllowed, autoApprove, autoApprovePdf, licenseType }
 *
 * Returns `{ payload, missing, warnings, readiness, canSubmit }`. It NEVER throws
 * on incomplete data — an incomplete file is a normal state and the caller decides
 * what to do about it. It DOES throw on an out-of-scope request, because that is
 * not a completeness question: submitting a DSCR category or a DSCR prepayment code
 * is a thing this build must be structurally unable to do.
 */
function buildPayload(file, lender, opts = {}) {
  const f = file || {};
  const L = lender || {};
  const loanCategory = trimmed(opts.loanCategory) || null;
  const warnings = [];

  // The scope gate runs FIRST. Nothing below it can put a DSCR category or a DSCR
  // prepayment clause into a payload, even by accident.
  //
  // IT ONLY THROWS ON AN AFFIRMATIVE "NO", NOT ON "WE DON'T KNOW YET". A file whose
  // category has not been decided is INCOMPLETE, not out of scope — and this is the
  // function a screen calls to show a human what is still missing, so throwing there
  // would replace that list with a stack trace on exactly the files that need it.
  // A blank category is recorded as a fatal missing field instead (see TEMPLATE_KEYS
  // below), which is the same refusal in a form somebody can act on.
  //
  // The fail-closed guarantee is not weakened, because it lives at the TRANSPORT:
  // `client.submitLoanDocument` re-asserts scope on the way out and refuses a blank
  // category outright. Nothing can be submitted without passing that.
  const prepay = scope.rtlPrepaymentCode(opts.prepaymentAllowed);
  if (loanCategory) scope.assertInScope({ loanCategory, prepaymentOptionCode: prepay.code });
  if (!prepay.code) {
    warnings.push({ code: 'prepayment_unresolved', message: prepay.reason });
  }
  const scopeCheck = scope.check({ loanCategory, prepaymentOptionCode: prepay.code });
  for (const p of scopeCheck.problems) if (p.warning) warnings.push({ code: p.code, message: p.message });

  const required = new Set(catalog.variablesForCategory(loanCategory).filter((k) => !catalog.isPseudoKey(k)));
  const c = collector(required);

  /* ── the parties ── */
  const borrowerName = trimmed(f.vestsIndividually ? f.borrowerName : f.entityName)
    || trimmed(f.entityName) || trimmed(f.borrowerName);
  const members = Array.isArray(f.entityMembers) ? f.entityMembers : [];
  const signatories = members
    .map((m) => ({ signatory_name: trimmed(m.name), signatory_title: trimmed(m.title) }))
    .filter((s) => s.signatory_name);

  const borrowers = borrowerName ? [{
    borrower_name: borrowerName,
    borrower_state: trimmed(f.entityState) || undefined,
    borrower_address: addressLine(f.borrowerAddress) || undefined,
    borrower_title: trimmed(f.borrowerTitle) || undefined,
    signatories: signatories.length ? signatories : undefined,
  }] : [];
  if (!borrowers.length) c.missing.push({ key: 'borrowers', reason: 'The file has no borrowing entity or borrower name.' });

  // Guarantors are the individuals behind the entity. An APPROVED co-borrower
  // guaranty waiver means the co-borrower is a member but NOT a guarantor — the
  // file already carries that decision, so it is honoured rather than re-litigated.
  const guarantorPeople = (Array.isArray(f.guarantors) ? f.guarantors : [])
    .filter((g) => trimmed(g && g.name));
  const guarantors = guarantorPeople.map((g) => ({
    guarantor_name: trimmed(g.name),
    guarantor_address: addressLine(g.address) || undefined,
  }));
  if (!guarantors.length) c.missing.push({ key: 'guarantors', reason: 'The file names nobody as a personal guarantor.' });

  const pledgors = (Array.isArray(f.pledgors) ? f.pledgors : []).filter((p) => trimmed(p && p.name));

  /* ── the collateral ── */
  const pa = f.propertyAddress || {};
  const collateral = trimmed(pa.line1 || pa.street) ? [{
    collateral_property_address: addressLine(pa) || undefined,
    collateral_property_state: trimmed(pa.state) || undefined,
    collateral_property_city: trimmed(pa.city) || undefined,
    collateral_property_town: trimmed(pa.city) || undefined,
    collateral_property_county: trimmed(f.propertyCounty) || undefined,
  }] : [];
  if (!collateral.length) c.missing.push({ key: 'collateral_properties', reason: 'The file has no subject-property address.' });
  if (collateral.length && !collateral[0].collateral_property_county) {
    c.missing.push({ key: 'collateral_property_county', reason: 'PILOT does not store the county. It is on the title commitment.' });
  }

  /* ── the money, read off the registered quote and never re-derived ── */
  const q = f.quote || {};
  const sizing = q.sizing || {};
  c.set('loan_amount', money(sizing.totalLoan != null ? sizing.totalLoan : f.loanAmount),
    'The file has no registered loan amount — register the product first.');
  c.set('initial_advance', money(sizing.initialAdvance));
  c.set('construction_holdback', money(sizing.rehabHoldback));
  c.set('interest_reserve', money(sizing.financedReserve));
  c.set('monthly_payment', money(sizing.monthlyPayment));
  c.set('amount_at_closing', money(f.amountAtClosing),
    'Net funds to the borrower at closing. Derived from the registered quote once the fee set is settled.');
  c.set('borrower_contribution', money(q.cashToClose));
  c.set('interest_rate', pct(f.noteRate));
  c.set('purchase_refinance', f.purchaseOrRefinance || null);
  c.set('purpose_of_loan', trimmed(f.purposeOfLoan));
  c.set('loan_id', trimmed(f.loanNumber), 'The file has no YS loan number yet.');

  /* ── the dates ── */
  const closing = f.closingDate || null;
  c.set('date_of_closing', longDate(closing), 'No closing date is set on the file.');
  const closingParts = ymd(closing);
  c.set('month_of_closing', closingParts ? MONTHS[closingParts.m - 1] : null);
  c.set('year_for_notary_block', closingParts ? String(closingParts.y) : null);
  c.set('last_day_of_the_month', lastDayOfMonth(closing));
  c.set('first_payment_date', longDate(f.firstPaymentDate));
  c.set('monthly_payment_date_begin', longDate(f.firstPaymentDate));
  c.set('first_day_of_month_plus_1_year', plusOneYear(f.firstPaymentDate));
  c.set('maturity_date', longDate(f.maturityDate));
  c.set('maturity_date_of_loan', longDate(f.maturityDate));
  c.set('last_day_to_draw', longDate(f.lastDayToDraw),
    'Nobody has set the last day to draw. The usual convention is two months before maturity, but that has not been adopted as our rule.');

  /* ── the fees ── */
  const cc = q.closingCosts || {};
  c.set('origination_fee', money(cc.origination));
  c.set('draw_fee_amount', money(f.drawFee));
  c.set('exit_fee_percentage', pct(f.deferredOrigPct));

  /* ── the lender: standing facts, never read off the file ── */
  c.set('lender_name', trimmed(L.name), 'The lending entity name is not configured.');
  c.set('lender_name_all_caps', upper(L.name));
  c.set('lender_address', trimmed(L.address), 'The lender address is not configured.');
  c.set('lender_state', trimmed(L.state));
  c.set('lender_town_and_state', trimmed(L.townAndState));
  c.set('lender_type_of_organization', trimmed(L.orgType));
  c.set('governing_law', trimmed(L.governingLaw),
    'Which state\'s law governs has not been decided. It is a legal choice, so it is never inferred from the property.');
  c.set('governing_law_all_caps', upper(L.governingLaw));
  c.set('servicer_name', trimmed(L.servicerName));
  c.set('servicer_address', trimmed(L.servicerAddress));

  /* ── the third parties ── */
  c.set('title_agent', trimmed(f.titleAgentName));
  c.set('title_agent_name', trimmed(f.titleAgentName));
  c.set('title_agent_name_and_address', trimmed(f.titleAgentNameAndAddress));
  c.set('settlement_agent_name', trimmed(f.settlementAgentName));
  c.set('settlement_agent_name_and_address', trimmed(f.settlementAgentNameAndAddress));
  c.set('underwriter', trimmed(f.titleUnderwriter),
    'The TITLE underwriter issuing the loan policy (not our underwriter). It is on the title commitment.');
  c.set('trustee', trimmed(f.trustee),
    'Deed-of-trust states name a trustee. It is a legal designation, so it is never auto-filled from the title contact.');

  /* ── the property legal identity ── */
  c.set('legal_description', trimmed(f.legalDescription),
    'The metes-and-bounds description off the title commitment. PILOT does not parse it out of the document yet.');
  c.set('legal_description_image', trimmed(f.legalDescription));
  c.set('section_number', trimmed(f.sectionNumber), 'NY tax-map section — off the title commitment.');
  c.set('block_number', trimmed(f.blockNumber), 'NY tax-map block — off the title commitment.');
  c.set('lot_number', trimmed(f.lotNumber), 'NY tax-map lot — off the title commitment.');
  c.set('district_number', trimmed(f.districtNumber), 'NY tax-map district — off the title commitment.');
  c.set('property_town', trimmed(pa.city));

  /* ── the entity's character ──
     ALL FOUR OF THESE ARE ONE ANSWER (owner-directed 2026-08-09). `llcs.entity_type`
     says whether this company has MEMBERS holding a percentage or SHAREHOLDERS
     holding shares, and src/lib/entity-type.js turns that one key into the exact
     wording DocLab's own master payload uses — so "what kind of company is this"
     has ONE definition in this codebase rather than one in the entity code and a
     second one here. A caller may still override any of them explicitly (the
     `f.entityOrgType` family), which is what a closer needs when a real entity is
     unusual; the derivation is the default, never a ceiling.

     AN UNCONFIRMED TYPE IS STILL SENT, AND WARNED ABOUT. db/506 stamped the whole
     back book `llc` without anybody choosing it, so on those files this is our
     assumption rather than a stated fact — and a document that says "operating
     agreement" about a corporation is worse than one that says nothing. The value
     goes out (an LLC is right the overwhelming majority of the time and omitting
     it prints a blank on a mortgage either way) with a warning naming the file. */
  const ET = entityType;
  /* The SUB-KIND rides along, and it changes a word that is printed onto a
     recorded instrument: a "general partnership" and a "limited partnership" are
     different legal entities with different liability. It never changes a
     trust's word — "trust" is never wrong and the trust's own name carries the
     rest. See the SUBTYPES note in lib/entity-type.js. */
  const entityRow = { entity_type: f.entityType, entity_subtype: f.entitySubtype };
  const derived = ET.docLabVariables(entityRow);
  const entityKind = ET.typeOf(f.entityType);
  if (trimmed(f.entityName) && !ET.isRecognized(f.entityType)) {
    warnings.push({
      code: 'entity_type_assumed',
      message: `Nobody has stated whether "${trimmed(f.entityName)}" is an LLC, a corporation, a partnership or a trust, so the documents will describe it as a limited liability company. Confirm the entity type before these go out.`,
    });
  }
  if (trimmed(f.entityName) && ET.hasSubtypes(f.entityType) && !ET.subtypeOf(entityRow) && !trimmed(f.entityOrgType)) {
    warnings.push({
      code: 'entity_subtype_unstated',
      message: `Nobody has said what kind of ${entityKind.label.toLowerCase()} "${trimmed(f.entityName)}" is, so the documents will describe it as a plain "${derived.type_of_organization}". A general partnership and a limited partnership are different legal entities — confirm it before these go out.`,
    });
  }
  c.set('type_of_organization', trimmed(f.entityOrgType) || derived.type_of_organization);
  c.set('acknowledgement_corporate_status',
    trimmed(f.acknowledgementCorporateStatus) || derived.acknowledgement_corporate_status);
  c.set('bylaws_operating_agreement',
    trimmed(f.bylawsOrOperatingAgreement) || derived.bylaws_operating_agreement);
  c.set('operating_agreement_or_bylaws',
    trimmed(f.operatingAgreementOrBylaws) || derived.operating_agreement_or_bylaws);

  /* WHAT AN OWNER HOLDS — a PERCENTAGE or SHARES, never both. Sending a share
     count for an LLC or a membership percentage for a corporation is not a
     harmless extra: the merge prints whichever the template asks for, so the
     wrong one lands on a pledge as a fact. Each is left ABSENT (and reported
     missing when the template wants it) on the side it does not belong to. */
  if (entityKind.usesShares) {
    c.set('number_of_shares', wholeNumber(f.entityShares),
      'A corporation\'s pledge names a share count. Record it on the entity\'s owners in the borrower profile.');
    c.set('certificate_number', trimmed(f.entityCertificateNumber),
      'The numbered stock certificate being pledged — it comes off the certificate itself. Record it on the entity\'s owners in the borrower profile.');
  } else {
    c.set('membership_interest_percentage', f.membershipInterestPct != null ? pct(f.membershipInterestPct) : null);
  }

  /* ── the derived phrases ── */
  c.set('guarantor_or_collectively_the_guarantor',
    guarantors.length ? pluralPhrase(guarantors.length, 'the "Guarantor"', 'collectively the "Guarantor"') : null);
  c.set('individual_jointly_and_severally',
    guarantors.length ? pluralPhrase(guarantors.length, 'individually', 'jointly and severally') : null);
  c.set('pledgor', pledgors.length ? pledgors.map((p) => trimmed(p.name)).join(', ') : null);
  c.set('pledgor_address', pledgors.length ? (addressLine(pledgors[0].address) || null) : null);
  c.set('pledgor_or_collectively_the_pledgor',
    pledgors.length ? pluralPhrase(pledgors.length, 'the "Pledgor"', 'collectively the "Pledgor"') : null);

  /* ── the three DocLab requires inside `variables` regardless ──
     Their Template Selection page insists lender_name, state and loan_category all
     appear here too, and their own master payload sends the last two as a single
     SPACE. Reproduced exactly: the real values live in the template object. */
  c.always('state', ' ');
  c.always('loan_category', ' ');

  /* ── the arrays ── */
  if (borrowers.length) c.variables.borrowers = borrowers;
  if (guarantors.length) c.variables.guarantors = guarantors;
  if (collateral.length) c.variables.collateral_properties = collateral;
  // Required "even if the selected option does not utilize it" — their words.
  c.variables.pre_payment_penalty = [{ prepayment_penalty_date: '', prepayment_penalty_type: '' }];

  const fees = buildFees(f);
  if (fees) c.variables.fees = fees;

  /* ── the envelope ── */
  const payload = {
    template: {
      lender_name: trimmed(L.templateLenderName) || undefined,
      loan_category: loanCategory || undefined,
      state: trimmed(pa.state) || undefined,
    },
    variables: c.variables,
  };
  if (opts.requestId) payload.requestId = String(opts.requestId);
  if (prepay.code) payload.prepayment_option_code = prepay.code;
  if (opts.autoApprove !== undefined) payload.auto_approve = !!opts.autoApprove;
  if (opts.autoApprovePdf !== undefined) payload.auto_approve_pdf = !!opts.autoApprovePdf;
  if (opts.licenseType !== undefined) payload.license_type = opts.licenseType;

  // The three template fields are the only ones DocLab genuinely refuses without.
  for (const k of catalog.TEMPLATE_KEYS) {
    if (!payload.template[k]) {
      c.missing.push({ key: `template.${k}`, reason: 'DocLab cannot choose a document template without this.', fatal: true });
    }
  }

  const readiness = fieldMap.gapsForCategory(loanCategory);
  if (!readiness.matrixKnown && loanCategory) {
    warnings.push({ code: 'matrix_unknown',
      message: `DocLab has not published which variables "${loanCategory}" needs, so PILOT cannot check this package for holes. Ask PLL for that template's field list before sending one.` });
  }

  return {
    payload,
    missing: c.missing,
    warnings,
    readiness,
    // Submittable at all — which is a much lower bar than complete, and the
    // difference between the two is exactly what `missing` is for.
    canSubmit: !c.missing.some((m) => m.fatal),
  };
}

/**
 * The `fees` object — DocLab's two-array structure.
 *
 * `sort_order` is ONE sequence across both arrays, not one per array: their master
 * payload numbers seven single fees 1–7 and then the multiple-fee group 8. Getting
 * that wrong reorders the fee paragraphs in the loan agreement.
 *
 * Returns null when the file carries no fees at all — an empty structure would
 * claim there are none, which is a different statement from having nothing to say.
 */
function buildFees(f) {
  const list = Array.isArray(f.fees) ? f.fees : [];
  if (!list.length) return null;

  const single = [];
  const grouped = [];
  let order = 1;

  for (const fee of list) {
    const amount = money(fee && fee.amount);
    if (!amount) continue;
    const template = trimmed(fee.feeTemplate);
    const known = catalog.SINGLE_FEE_TEMPLATES.some((t) => t.template === template);
    if (known) {
      single.push({ fee_amount: amount, sort_order: order++, fee_template: template });
    } else {
      // Anything without its own legal paragraph rides the generic "Standard Fee",
      // which is the only template that may repeat.
      grouped.push({ fee_name: trimmed(fee.name) || template || 'Fee', fee_amount: amount });
    }
  }

  const out = {};
  if (single.length) out.single_fee = single;
  if (grouped.length) {
    out.multiple_fees = [{ fee_template: 'Standard Fee', sort_order: order++, fee: grouped }];
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  buildPayload, buildFees,
  // exported for the tests — formatting is a correctness concern here
  _internals: { money, pct, longDate, lastDayOfMonth, plusOneYear, ymd, addressLine, pluralPhrase, num },
};
