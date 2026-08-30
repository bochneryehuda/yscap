'use strict';
/**
 * LONG-TERM TERM SHEETS — building the FROZEN, CONSUMER-SAFE snapshot.
 *
 * A term sheet is a promise about a moment. This module turns what an officer
 * selected on the board into the exact object that is stored, rendered and
 * replayed — and it is the ONE place that decides what may appear on it.
 *
 * ⛔ IT IS A WHITELIST, NOT A FILTER, AND THAT IS WHAT MAKES RULE 10 STRUCTURAL.
 * `CLAUDE.md` rule 10: the investor's name never reaches a client, in any form.
 * The vendor's answer carries `lender`, `investor`, `lenderId` and
 * `rateSheetName` on every row, and this snapshot is read back by a door a
 * borrower may reach. So nothing is spread off the caller's object — every key
 * is NAMED, exactly as `routes/my-loans.js` documents for the borrower's file
 * list: *"a column added tomorrow, an investor field, a funding channel, a buy
 * rate, cannot reach a client through this door because nobody asked for it."*
 * A blacklist has to be right about every key that will ever exist; a whitelist
 * has to be right once.
 *
 * ⛔ A PROGRAM WITH NO CONSUMER LABEL CANNOT BE SELECTED. On the staff board an
 * investor we cannot resolve is KEPT (hiding a row nobody chose to hide is a
 * silent drop). On anything a client reads, that same row is an investor we have
 * no consumer-safe name for, so the rule INVERTS: it is refused, by name, so the
 * officer learns the investor needs christening rather than getting a blank
 * column on a document.
 *
 * ⛔ EVERY DOLLAR IS RE-DERIVED HERE, from the vendor's raw price and the comp
 * plan the SERVER resolved. The client's own figures are accepted only as a
 * CROSS-CHECK: a monthly payment that disagrees with ours REFUSES the export
 * rather than issuing a document that contradicts the board the officer was
 * looking at.
 *
 * PURE. The caller hands in the plan and the selections; nothing here touches
 * the database or the network, so the whole rule runs under CI.
 */

const crypto = require('crypto');
const audience = require('../audience');
const overlay = require('./overlay');
const wording = require('./wording');
const comparison = require('./comparison');

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Text as it may appear on a document: control characters out (a stray one
 *  breaks a PDF string and would reach a client's screen as a glyph nobody
 *  typed), runs of whitespace collapsed, capped by the column that holds it. */
const str = (v, max = 200) => {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

/** A refusal a screen can print verbatim. */
function refuse(code, message) { return { ok: false, error: code, message }; }

/**
 * The SCENARIO facts a term sheet may state. Whitelisted, and deliberately
 * narrow: the sheet describes the DEAL, not the search. Nothing here can carry
 * an investor, a lender, a rate sheet or a vendor identifier because none of
 * those is a key on this list.
 */
function projectScenario(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const termFromMonths = num(s.term) != null ? num(s.term) / 12 : null;
  return {
    purpose: str(s.purpose, 40),
    propertyType: str(s.propertyType, 40),
    units: num(s.units),
    propertyValue: num(s.value != null ? s.value : s.propertyValue),
    loanAmount: num(s.loan != null ? s.loan : s.loanAmount),
    ltv: num(s.ltv),
    termYears: num(s.termYears) != null ? num(s.termYears) : termFromMonths,
    interestOnly: s.io === true || s.interestOnly === true,
    escrowWaive: s.escrowWaive === true,
    prepayMonths: num(s.prepayMonths),
    prepayStructure: str(s.prepayStructure, 40),
    dscr: num(s.dscr),
    fico: num(s.fico),
    zip: str(s.zip, 10),
    state: str(s.state, 2),
    county: str(s.county, 60),
    city: str(s.city, 60),
    // The qualifying figures the officer typed into the DSCR calculator. They
    // are facts about the deal, not about the vendor, and a borrower reading the
    // sheet expects to see what it was qualified on.
    rentMonthly: num(s.rentMonthly),
    taxMonthly: num(s.taxMonthly),
    insuranceMonthly: num(s.insuranceMonthly),
    hoaMonthly: num(s.hoaMonthly),
  };
}

/**
 * THE THREE DOCUMENTS. Owner-directed 2026-08-30, choosing the shape himself:
 *
 *   *"A term sheet should only have one option. It should be a comparison
 *   sheet, which should be the same scenario, different options. There should
 *   be a scenario sheet, which is different scenarios and different options
 *   broken down."*
 *
 * ⛔ THE KIND IS DERIVED FROM THE OPTIONS, NEVER TAKEN FROM THE CALLER. A sheet
 * that called itself a term sheet while carrying three options would print a
 * signature block under a comparison, and one that called itself a comparison
 * with a single option would draw a comparison table with one column. The
 * members decide: one option is a TERM SHEET; several options that are the same
 * loan priced differently are a COMPARISON; several options that are different
 * loans are a SCENARIO COMPARISON. `comparison.detectWorkflow` already answers
 * that second question ('A' = same loan, 'B' = different loans) for the break-even
 * arithmetic, so asking it again here means the document can never disagree with
 * its own table about what it is comparing.
 */
const DOC_KINDS = { TERM_SHEET: 'term_sheet', COMPARISON: 'comparison', SCENARIO: 'scenario_comparison' };

function documentKind(members, compare) {
  const n = Array.isArray(members) ? members.length : 0;
  if (n <= 1) return DOC_KINDS.TERM_SHEET;
  return compare && compare.workflow === 'B' ? DOC_KINDS.SCENARIO : DOC_KINDS.COMPARISON;
}

/** How the officer says it, so a refusal can be quoted straight onto a screen. */
const KIND_WORDS = {
  [DOC_KINDS.TERM_SHEET]: 'term sheet',
  [DOC_KINDS.COMPARISON]: 'comparison sheet',
  [DOC_KINDS.SCENARIO]: 'scenario comparison',
};

/** The manual program name a screen may offer, and its warning — ONE definition,
 *  so the box, the refusal and the officer's audit trail all say it identically. */
const MANUAL_NAME_WARNING = 'Give the program a name a borrower can read — never the investor\'s own name.';

/**
 * THE PROGRAM'S CLIENT-FACING NAME, or a refusal.
 *
 * ⛔ THE OFFICER MAY NAME AN UNNAMED PROGRAM, AND MAY NOT NAME IT AFTER THE
 * INVESTOR. Owner-directed 2026-08-30, both halves in one sentence: *"the loan
 * officer should tell the loan officer this doesn't have a name and the loan
 * officer can put in manually a program name. You warn him not to put in an
 * investor name as a program name."*
 *
 * ⛔ THE WARNING IS NOT THE CONTROL — the REFUSAL IS. A sentence under a text
 * box is advice; the box still accepts whatever is typed, and the one thing that
 * must never happen here is an investor's name reaching a borrower's document
 * (rule 10, which is a HARD rule for exactly this reason). So the typed name is
 * put through `audience.mentionsInvestor` — the ONE definition, built on the
 * 117-spelling registry, never a second `!== 'Deephaven'` check that
 * `Deepahven Select` walks straight past — and a name that names an investor is
 * refused outright. The officer is told which rule they hit and why.
 *
 * The registry-supplied white-label name always wins: a program that HAS a name
 * is never renamed by hand, or two sheets would call one program two things.
 */
function resolveProgramName(sel) {
  const registry = str(sel.consumerLabel, 60);
  if (registry) return { ok: true, name: registry, namedBy: 'registry' };

  const typed = str(sel.manualProgramName, 60);
  if (!typed) {
    return refuse('program_not_named',
      'This program has no client-facing name yet, so it cannot go on a term sheet. Either have the investor '
      + 'named on the white-label sheet and price it again, or type a program name for this sheet. '
      + MANUAL_NAME_WARNING);
  }
  if (typed.length < 3) {
    return refuse('program_name_too_short',
      `"${typed}" is too short to be a program name. Give it a name a borrower can read.`);
  }
  if (audience.mentionsInvestor(typed)) {
    return refuse('program_name_names_investor',
      `"${typed}" names the investor, so it cannot go on a borrower's document. ${MANUAL_NAME_WARNING} `
      + 'Something like "30-Year Rental Select" describes the program without naming who funds it.');
  }
  return { ok: true, name: typed, namedBy: 'manual' };
}

/**
 * ONE selected quote → the member that is stored and printed.
 *
 * Returns `{ok:true, member}` or a refusal naming what is wrong. Every refusal
 * is a sentence an officer can act on — "this program has no name we may show a
 * borrower" tells them to have the investor christened; a bare 422 does not.
 */
function buildMember(sel, plan, opts = {}) {
  const s = sel && typeof sel === 'object' ? sel : {};
  const mode = String(s.mode || opts.mode || '');
  if (!overlay.ISSUABLE_MODES.includes(mode)) {
    return refuse('raw_cannot_export',
      'A term sheet can only be issued from borrower-paid or lender-paid pricing. Raw pricing is the vendor\'s own '
      + 'numbers before our compensation, so it is never sent to a borrower.');
  }
  const named = resolveProgramName(s);
  if (!named.ok) return named;
  const consumerLabel = named.name;
  const ratePct = num(s.ratePct);
  if (ratePct == null || ratePct <= 0) return refuse('missing_rate', 'That quote has no rate on it.');
  const rawPrice = num(s.rawPrice);
  if (rawPrice == null) return refuse('missing_price', 'That quote has no price on it.');

  const scenario = projectScenario(s.scenario);
  if (scenario.loanAmount == null || scenario.loanAmount <= 0) {
    return refuse('missing_loan', 'That quote has no loan amount, so the fees cannot be worked out.');
  }

  const waive = s.waiveLenderFees === true;
  const charges = overlay.quoteCharges(mode, plan, rawPrice, scenario.loanAmount, waive);
  if (!charges) {
    return refuse('no_comp_plan',
      'Your compensation settings could not be read, so the fees on this quote cannot be worked out. '
      + 'Check your personal settings and try again.');
  }
  const closing = overlay.closingSheet(charges, {
    propertyValue: scenario.propertyValue,
    loanAmount: scenario.loanAmount,
    purpose: scenario.purpose,
  });
  const monthlyPI = overlay.monthlyPI({
    loanAmount: scenario.loanAmount,
    ratePct,
    termYears: scenario.termYears,
    interestOnly: scenario.interestOnly,
  });

  // THE CROSS-CHECK. The board shows the vendor's own monthly payment; if ours
  // disagrees the sheet would contradict the screen the officer just read, which
  // is the silent-divergence class this repository refuses to ship. A dollar of
  // tolerance covers rounding conventions; anything more is a real disagreement.
  const vendorPI = num(s.vendorMonthlyPI);
  if (vendorPI != null && monthlyPI != null && Math.abs(vendorPI - monthlyPI) > 1) {
    return refuse('payment_disagreement',
      `The monthly payment on the board (${wording.moneyExact(vendorPI)}) and the one this term sheet works out `
      + `(${wording.moneyExact(monthlyPI)}) do not agree, so nothing was issued. Re-price the scenario and try again.`);
  }

  return {
    ok: true,
    member: {
      label: str(s.label, 60) || `${wording.rate(ratePct)} — ${consumerLabel}`,
      // The CONSUMER identity, and nothing else. `lender`, `investor`,
      // `lenderId` and `rateSheetName` are not keys on this object.
      consumerLabel,
      // WHO named it. A sheet whose program name an officer typed says so on its
      // face, because a reader deserves to know the difference between a program
      // we publish under that name and one this officer called that today.
      programNamedBy: named.namedBy,
      product: str(s.product, 80),
      mode,
      waiveLenderFees: waive,
      ratePct,
      monthlyPI,
      scenario,
      charges,
      closing,
      pricedAt: str(s.pricedAt, 40) || null,
      // Denormalised for the comparison engine, which asks about the DEAL.
      loanAmount: scenario.loanAmount,
      propertyValue: scenario.propertyValue,
      purpose: scenario.purpose,
      termYears: scenario.termYears,
      interestOnly: scenario.interestOnly,
      ltv: scenario.ltv,
      dscr: scenario.dscr,
      prepayLabel: wording.prepaySentence(scenario.prepayMonths, scenario.prepayStructure),
    },
  };
}

/**
 * MAY THIS BE EXPORTED? — the completeness gate, as a pure verdict.
 *
 * ⛔ A TERM SHEET IS THE COMPLETE DOCUMENT; A COMPARISON IS NOT. Owner-directed
 * 2026-08-30: *"Term sheet should only be able to be exported if they enter the
 * full scenario and calculate the ratio. They put in the monthly rent, taxes,
 * and insurance, so the term sheet can be fully completed with the principal,
 * interest, tax, and insurance, and fully calculated. If you didn't do that,
 * then you can just export comparisons, and then it should not have the
 * principal, interest, tax, and insurance."*
 *
 * So the gate is on the TERM SHEET alone, and the comparison's half needs no
 * gate at all: the PITI block renders only when `wording.housingCost` says the
 * figures are complete, so a comparison exported without taxes and insurance
 * carries no PITI *by construction* rather than by a second rule that could
 * drift from this one.
 *
 * ⛔ IT NAMES EVERY MISSING THING AT ONCE, and each one is a box the officer can
 * fill from the screen they are already on. A gate that reveals its blockers one
 * at a time is four round trips; a gate whose remedy is somewhere else is a dead
 * end. `missing[]` carries machine-readable keys so the screen can point at the
 * fields, and `message` is a sentence it can print verbatim.
 *
 * The borrower's name and the property address are required for a TERM SHEET
 * only. That is a judgement, and it is stated rather than buried: a term sheet
 * is the formal one-program offer, it carries an acceptance block, and a
 * signature line over a blank "Prepared for" is a defective document. A
 * comparison is a working document and needs neither.
 */
const GATE_LABELS = {
  rentMonthly: 'the monthly rent',
  taxMonthly: 'the monthly property taxes',
  insuranceMonthly: 'the monthly insurance',
  dscr: 'the calculated DSCR',
  dscrMismatch: 'a price obtained at the ratio these figures actually produce',
  partyName: "the borrower's name or the vesting entity",
  propertyAddress: 'the full property address',
};

/**
 * THE RATIO THE PRICE WAS OBTAINED AT MUST BE ONE THIS DEAL ACTUALLY MEETS.
 *
 * ⛔ OWNER-REPORTED 2026-08-30, and it is a MONEY rule, not a tidiness one:
 * *"you allow the system to issue the term sheet even if the DSCR disagrees …
 * if the scenario was 1.25 but the details that I'm entering to issue the term
 * sheet are 1.2, it allows the system to issue the term sheet. This means we are
 * giving him better pricing than we should have given him."*
 *
 * The board prices a SEARCH — the officer types a DSCR and Lender Price answers
 * at that ratio, applying the investor's own DSCR adjustment. The term sheet
 * then prints the rent, taxes and insurance actually entered. If those work out
 * LOWER than the ratio the search ran at, the price on the document was bought
 * in a band this loan does not qualify for, and the borrower gets a rate we
 * would not have quoted. That is a loss on every such sheet.
 *
 * ⛔ IT REFUSES, IT NO LONGER WARNS. This shipped as a prominent warning that
 * still let the sheet issue, on the reasoning that a hard stop with no way
 * through would trap an officer who knew better. That reasoning was wrong: the
 * way through is to RE-PRICE at the true ratio, which is one press, and the cost
 * of the warning being ignored is money. Corrected at the owner's direction.
 *
 * ⛔ ONLY DOWNWARD. A ratio that comes out HIGHER than the search ran at is not
 * this problem — the borrower qualifies by more than we priced, so nothing was
 * given away. (They may deserve a better price; that is an opportunity, not a
 * refusal, and the screen says so rather than blocking.)
 *
 * ⛔ AND IT NEVER GUESSES. The comparison needs the ratio the search was priced
 * at AND every figure the true ratio is worked out from. Missing any of them,
 * this rule stands down entirely and the ordinary completeness gate — which
 * already demands the rent, the taxes, the insurance and a ratio — is what
 * refuses. A refusal invented from half a scenario would be worse than none.
 *
 * The tolerance is one hundredth: both sides are printed to two decimals, so
 * 1.2449 and 1.24 are the same claim on the paper and must not be a refusal.
 */
const DSCR_TOLERANCE = 0.005;

function ratioProblem(member) {
  const m = member && typeof member === 'object' ? member : {};
  const sc = m.scenario || {};
  const priced = num(sc.dscr);
  if (priced == null || priced <= 0) return null;

  const pi = num(m.monthlyPI);
  const rent = num(sc.rentMonthly);
  const tax = num(sc.taxMonthly);
  const ins = num(sc.insuranceMonthly);
  if (pi == null || rent == null || tax == null || ins == null) return null;
  const hoa = num(sc.hoaMonthly) || 0;
  const housing = pi + tax + ins + hoa;
  if (!(housing > 0) || !(rent > 0)) return null;

  // ⛔ ROUNDED TO TWO BEFORE IT IS COMPARED, and that is not cosmetic. The tenant's
  // DSCR is DEFINED as Round([1005] / [912], 2) (owner-confirmed, recorded in
  // encompass/formulas.js), the screen's own calculator returns exactly that, and the
  // priced figure is a two-decimal band edge. Comparing a raw quotient here against a
  // rounded one there is how a server refusal and a screen warning end up disagreeing
  // about the same loan at the boundary — so both sides compare the SAME number, and
  // dscrCalc.ratioVerdict is the browser's copy of this rule, held to it by
  // test-lt-comparison-ux-pure.
  const actual = Math.round((rent / housing) * 100) / 100;
  const pricedRounded = Math.round(priced * 100) / 100;
  if (actual >= pricedRounded - DSCR_TOLERANCE) return null;

  return { priced: pricedRounded, actual };
}

function exportGate(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const kind = s.docKind || documentKind(s.members, s.comparison);
  if (kind !== DOC_KINDS.TERM_SHEET) return { ok: true, kind, missing: [], message: null };

  const m = (Array.isArray(s.members) && s.members[0]) || {};
  const sc = m.scenario || {};
  const p = s.prepared || {};
  const missing = [];
  if (num(sc.rentMonthly) == null || num(sc.rentMonthly) <= 0) missing.push('rentMonthly');
  if (num(sc.taxMonthly) == null) missing.push('taxMonthly');
  if (num(sc.insuranceMonthly) == null) missing.push('insuranceMonthly');
  if (num(sc.dscr) == null || num(sc.dscr) <= 0) missing.push('dscr');
  // ⛔ ONE NAME IS ENOUGH, AND EITHER ONE WILL DO. Owner-directed 2026-08-30:
  // *"a name of the person and/or a name of the entity."* A DSCR loan is
  // routinely vested in an LLC with the individual behind it as guarantor, and
  // it is just as routinely quoted to a person before an entity exists — so
  // demanding BOTH would refuse two perfectly ordinary deals, and demanding the
  // individual alone (which is what this used to do) refuses the first of them.
  // What a term sheet cannot be is addressed to NOBODY: it carries an
  // acceptance block, and a signature line over a blank "prepared for" is a
  // defective document. So the requirement is at least one, reported under the
  // single key `partyName` — the screen points at both boxes and either fills it.
  if (!str(p.borrowerName, 120) && !str(p.entityName, 120)) missing.push('partyName');
  if (!str(p.propertyAddress, 200)) missing.push('propertyAddress');
  // ⛔ ASKED AFTER THE FIELDS ARE IN, DELIBERATELY. The ratio cannot be worked out
  // until the rent, taxes and insurance are there, so a half-filled scenario must
  // be told what is missing rather than accused of a mismatch it cannot yet have.
  if (!missing.length) {
    const r = ratioProblem(m);
    if (r) {
      return {
        ok: false,
        kind,
        missing: ['dscrMismatch'],
        error: 'dscr_below_priced',
        repriceAt: r.actual,
        pricedAt: r.priced,
        message: `These figures work out to a DSCR of ${r.actual.toFixed(2)}, but this option was priced `
          + `at ${r.priced.toFixed(2)}. Issuing it would give the borrower a rate obtained in a band `
          + `this loan does not qualify for. Re-price the scenario at ${r.actual.toFixed(2)} and issue `
          + 'from the new price.',
      };
    }
    return { ok: true, kind, missing: [], message: null };
  }

  const words = missing.map((k) => GATE_LABELS[k] || k);
  const list = words.length === 1 ? words[0]
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return {
    ok: false, kind, missing,
    error: 'term_sheet_incomplete',
    message: `A term sheet states the whole loan, so it needs ${list}. Fill those in and it will export. `
      + 'Until then you can still export a comparison — it simply leaves out the monthly taxes, insurance '
      + 'and the total payment.',
  };
}

/**
 * The whole snapshot: the members, the comparison model, and the header facts.
 *
 * `kind` is derived from the member count rather than taken from the caller —
 * a single-member sheet that called itself a comparison would render a
 * comparison table with one column.
 */
function buildSnapshot({ selections, plan, anchorIndex = 0, prepared = {}, maxMembers = 8 } = {}) {
  const list = Array.isArray(selections) ? selections : [];
  if (!list.length) return refuse('nothing_selected', 'Pick at least one program before issuing a term sheet.');
  if (list.length > maxMembers) {
    return refuse('too_many',
      `A term sheet compares at most ${maxMembers} options — past that it stops being a comparison `
      + 'and becomes a catalogue.');
  }
  const members = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = buildMember(list[i], plan);
    if (!r.ok) return { ...r, memberIndex: i };
    members.push(r.member);
  }
  const compare = members.length > 1 ? comparison.buildComparison(members, anchorIndex) : null;
  const docKind = documentKind(members, compare);

  return {
    ok: true,
    snapshot: {
      version: 1,
      // `kind` is the RENDERING shape the layout has always branched on — one
      // option or several. `docKind` is WHICH OF THE THREE DOCUMENTS this is,
      // which is a finer question (a comparison and a scenario comparison are
      // both "several"). Both are stored: the first is what the page does, the
      // second is what the document is called, and neither is derivable from the
      // other without re-running the comparison engine.
      kind: members.length > 1 ? 'comparison' : 'single',
      docKind,
      members,
      comparison: compare,
      prepared: {
        borrowerName: str(prepared.borrowerName, 120),
        // THE VESTING ENTITY, when the loan is going into one. Owner-directed
        // 2026-08-30: *"a name of the person and/or a name of the entity."*
        //
        // ⛔ IT IS ITS OWN FIELD, NEVER FOLDED INTO THE BORROWER'S NAME. They
        // are two different parties who sign two different lines: on a DSCR
        // loan the entity is the BORROWER and the individual behind it is the
        // GUARANTOR, so a single "prepared for" string carrying both would put
        // one name on a signature line meant for the other. This projection is
        // a WHITELIST — a key nobody lists here is silently dropped — so adding
        // one is a decision about what may appear on a client's document.
        entityName: str(prepared.entityName, 120),
        propertyAddress: str(prepared.propertyAddress, 200),
        officerName: str(prepared.officerName, 120),
        // The officer's JOB TITLE — business contact information, exactly like
        // the name, the telephone number and the NMLS beside it, and the same
        // thing the RTL footer prints. ⛔ ADDED DELIBERATELY: this projection is
        // a WHITELIST, so a producer that sets a key nobody listed here has its
        // value silently dropped — which is what happened to this one when the
        // footer started printing it. Adding a key is a decision about what may
        // appear on a client's document, never a formality.
        officerTitle: str(prepared.officerTitle, 80),
        officerEmail: str(prepared.officerEmail, 160),
        officerPhone: str(prepared.officerPhone, 40),
        officerNmls: str(prepared.officerNmls, 40),
        companyName: str(prepared.companyName, 120),
        companyNmls: str(prepared.companyNmls, 40),
        preparedAt: str(prepared.preparedAt, 40),
        expiresAt: str(prepared.expiresAt, 40),
      },
      disclosure: wording.DISCLOSURE,
      thirdParty: wording.THIRD_PARTY,
    },
  };
}

/**
 * A stable content hash of the snapshot.
 *
 * ⛔ CANONICALISED FIRST — object key order is an accident of construction, so
 * hashing `JSON.stringify` directly would make a byte-identical snapshot hash
 * two different ways depending on which code path built it, and a replay would
 * report tampering on a document nobody touched. Keys are sorted at every depth;
 * arrays keep their order, because the order of the members IS the document.
 */
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = canonicalize(v[k]);
    }
    return out;
  }
  return v;
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(snapshot))).digest('hex');
}

module.exports = {
  buildMember, buildSnapshot, canonicalize, hashSnapshot, projectScenario,
  documentKind, exportGate, resolveProgramName,
  DOC_KINDS, KIND_WORDS, MANUAL_NAME_WARNING, GATE_LABELS,
  _internals: { refuse, str, num },
};
