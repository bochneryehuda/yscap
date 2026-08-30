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
  const consumerLabel = str(s.consumerLabel, 60);
  if (!consumerLabel) {
    return refuse('program_not_named',
      'This program has no client-facing name yet, so it cannot go on a term sheet. Ask for the investor to be '
      + 'named on the white-label sheet, then price it again.');
  }
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

  return {
    ok: true,
    snapshot: {
      version: 1,
      kind: members.length > 1 ? 'comparison' : 'single',
      members,
      comparison: compare,
      prepared: {
        borrowerName: str(prepared.borrowerName, 120),
        propertyAddress: str(prepared.propertyAddress, 200),
        officerName: str(prepared.officerName, 120),
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

module.exports = { buildMember, buildSnapshot, canonicalize, hashSnapshot, projectScenario, _internals: { refuse, str, num } };
