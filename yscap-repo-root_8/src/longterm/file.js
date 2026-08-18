'use strict';
/**
 * LONG-TERM — the read-only file, sectioned the way the 1003 is.
 *
 * The workspace (`workspace.js`) decides WHICH sections a loan has and why one does
 * not apply. This fills them in. The split is deliberate: the menu is a pure function
 * of the loan row, so a screen can draw it before any of this has loaded, and this
 * module is one read that never has to know what a section menu looks like.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE SOCIAL SECURITY NUMBER NEVER LEAVES THE SERVER.
 *
 * `lt_parties.ssn_encrypted` and `entity_ein_encrypted` are NEVER selected here —
 * not to be decrypted, not to be counted, not to be tested for emptiness. What a
 * screen gets is `ssnLast4`, which is a separate column the sync already stores.
 *
 * This is a rule about the QUERY, not about the JSON: a `SELECT *` that fetches the
 * encrypted bytes and then deletes the key before responding is one careless spread
 * away from shipping them, and it puts them in a log the moment anything upstream
 * prints the row. `test-lt-file-pure.js` reads this source and fails on either
 * column name appearing in a SELECT.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A MISSING FIGURE IS NULL, NEVER ZERO. "No DSCR on file" and "a DSCR of 0" are
 * different loans and one of them is a decline; the same is true of a rent, a
 * balance and a value. Nothing here coalesces a number into 0.
 *
 * THE INVESTOR IS READ HERE, AND THIS MODULE IS STAFF-ONLY. `lt_loan_investors`
 * names who bought the loan, and rule 10 says that never reaches a borrower or a
 * TPO — so what makes it safe is that nothing a client can reach loads this module:
 * `loadFile` builds the STAFF file screen, where everything returned is internal.
 * The borrower's own screen (`routes/my-loans.js`) is built FOR the borrower rather
 * than filtered from this payload, which is the first of the two defences that rule
 * names. `audience.js` remains the one definition for anything that formats free
 * text, and `test-lt-investor-block.js` fails the build if either half slips.
 *
 * SEPARATION: reads only `lt_*` tables.
 */

const unsourced = require('./application/unsourced');
const dscrVerdict = require('./dscr-verdict');

const lazy = {
  get db() { return require('./db'); },
};

/** A number, or null. Never 0 for "we do not know". */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** A date column as the calendar day it is, never an instant in somebody's zone. */
const day = (v) => (v ? String(v).slice(0, 10) : null);

/** One person's name, from the four parts db/545 split it into. */
function personName(p) {
  const parts = [p.first_name, p.middle_name, p.last_name, p.name_suffix]
    .map((x) => text(x)).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/**
 * A party is a PERSON or an ENTITY, and the two carry different facts. Which one is
 * decided by `party_type` rather than by which columns happen to be filled: an entity
 * whose legal name has not been read yet is still an entity, and rendering it as a
 * person with a blank name would invent a human.
 */
function describeParty(p, extras = {}) {
  const isEntity = String(p.party_type || '').toLowerCase() === 'entity';
  return {
    id: p.id,
    role: p.role || null,
    partyType: isEntity ? 'entity' : 'person',
    name: isEntity ? text(p.entity_legal_name) : personName(p),
    // The last four digits ARE the identifier a person reads back on a phone call.
    // The number itself stays on the server; see the header.
    ssnLast4: text(p.ssn_last4),
    dateOfBirth: day(p.date_of_birth),
    email: text(p.email),
    homePhone: text(p.home_phone),
    mobilePhone: text(p.mobile_phone),
    citizenship: text(p.citizenship),
    maritalStatus: text(p.marital_status),
    dependentCount: p.dependent_count === null || p.dependent_count === undefined
      ? null : Number(p.dependent_count),
    credit: {
      experian: num(p.fico_experian),
      transUnion: num(p.fico_transunion),
      equifax: num(p.fico_equifax),
      // The qualifying score as Encompass computed it. It is READ, never recomputed
      // here: which score qualifies is a credit-policy setting, and two answers to
      // that question on two screens is worse than one answer we did not derive.
      representative: num(p.fico_representative),
    },
    entity: isEntity ? {
      legalName: text(p.entity_legal_name),
      entityType: text(p.entity_type),
      stateOfFormation: text(p.entity_state_of_formation),
      formationDate: day(p.entity_formation_date),
      title: text(p.entity_title),
      ownershipPct: num(p.entity_ownership_pct),
      // NOTE the EIN is deliberately absent, for the same reason the SSN is.
    } : null,
    ...extras,
  };
}

const describeResidence = (r) => ({
  id: r.id,
  type: text(r.residency_type),
  basis: text(r.residency_basis),
  address: [text(r.street), text(r.city), text(r.state), text(r.zip)].filter(Boolean).join(', ') || null,
  durationMonths: num(r.duration_months),
  monthlyRent: num(r.monthly_rent),
});

const describeEmployment = (e) => ({
  id: e.id,
  partyId: e.party_id,
  employer: text(e.employer_name),
  position: text(e.position),
  employmentType: text(e.employment_type),
  selfEmployed: e.is_self_employed === true,
  ownershipPct: num(e.ownership_pct),
  startDate: day(e.start_date),
  endDate: day(e.end_date),
  income: {
    base: num(e.monthly_base_income),
    overtime: num(e.monthly_overtime_income),
    bonus: num(e.monthly_bonus_income),
    commission: num(e.monthly_commission_income),
    other: num(e.monthly_other_income),
  },
  address: [text(e.employer_street), text(e.employer_city), text(e.employer_state), text(e.employer_zip)]
    .filter(Boolean).join(', ') || null,
  phone: text(e.employer_phone),
});

/**
 * Sum a set of figures, or answer null.
 *
 * A total of columns that are ALL empty is NOT zero — it is unknown, and printing
 * "$0" where nothing has been read is the exact confident-wrong-answer this file is
 * written to avoid. One real figure among blanks does total, because there the blanks
 * genuinely mean "none of this kind".
 */
function sumOrNull(values) {
  const known = values.map(num).filter((v) => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/**
 * Everything the workspace's sections need, in one read.
 *
 * Returns an object keyed by SECTION KEY, so a screen renders `file[active]` without
 * a map of its own. A section with nothing behind it is present and empty rather than
 * absent: "we have read this and there is nothing" and "we have not read this" are
 * different, and only the first should render as an empty list.
 *
 * Never throws for an ordinary failure — a section that cannot be read comes back
 * `null` with the reason, and the rest of the file still opens.
 */
async function loadFile(loanId, loan = null, opts = {}) {
  const db = lazy.db;
  const id = String(loanId);

  const q = async (sql, params) => {
    try {
      const { rows } = await db.query(sql, params);
      return { rows, error: null };
    } catch (e) {
      return { rows: [], error: String((e && e.message) || e).slice(0, 200) };
    }
  };

  const [parties, pairs, property, residences, employments, otherIncomes,
    assets, liabilities, reo, declarations, investor] = await Promise.all([
    q(`SELECT p.id, p.pair_id, p.role, p.party_type, p.borrower_id,
              p.first_name, p.middle_name, p.last_name, p.name_suffix,
              p.date_of_birth, p.ssn_last4, p.citizenship, p.marital_status, p.dependent_count,
              p.email, p.home_phone, p.mobile_phone,
              p.fico_experian, p.fico_transunion, p.fico_equifax, p.fico_representative,
              p.entity_legal_name, p.entity_type, p.entity_state_of_formation,
              p.entity_formation_date, p.entity_title, p.entity_ownership_pct
         FROM lt_parties p
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid
        ORDER BY bp.pair_number, p.role, p.last_name`, [id]),
    q(`SELECT id, pair_number, property_usage_type FROM lt_borrower_pairs
        WHERE loan_id = $1::uuid ORDER BY pair_number`, [id]),
    q('SELECT * FROM lt_properties WHERE loan_id = $1::uuid', [id]),
    q(`SELECT r.* FROM lt_residences r
         JOIN lt_parties p ON p.id = r.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid ORDER BY r.residency_type`, [id]),
    q(`SELECT e.* FROM lt_employments e
         JOIN lt_parties p ON p.id = e.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid ORDER BY e.start_date DESC NULLS LAST`, [id]),
    q(`SELECT o.* FROM lt_other_incomes o
         JOIN lt_parties p ON p.id = o.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid`, [id]),
    q(`SELECT a.* FROM lt_assets a
         JOIN lt_parties p ON p.id = a.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid ORDER BY a.section, a.institution_name`, [id]),
    q(`SELECT l.* FROM lt_liabilities l
         JOIN lt_parties p ON p.id = l.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid ORDER BY l.section, l.creditor_name`, [id]),
    q(`SELECT r.* FROM lt_reo_properties r
         JOIN lt_parties p ON p.id = r.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid ORDER BY r.street`, [id]),
    q(`SELECT d.* FROM lt_declarations d
         JOIN lt_parties p ON p.id = d.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid`, [id]),
    q('SELECT * FROM lt_loan_investors WHERE loan_id = $1::uuid', [id]),
  ]);

  const byParty = (rows, key = 'party_id') => {
    const m = new Map();
    for (const r of rows) {
      const k = String(r[key]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  const resByParty = byParty(residences.rows);
  const declByParty = byParty(declarations.rows);
  const incByParty = byParty(otherIncomes.rows);

  const people = parties.rows.map((p) => describeParty(p, {
    pairNumber: (pairs.rows.find((x) => String(x.id) === String(p.pair_id)) || {}).pair_number || null,
    residences: (resByParty.get(String(p.id)) || []).map(describeResidence),
    otherIncome: (incByParty.get(String(p.id)) || []).map((o) => ({
      type: text(o.income_type), monthlyAmount: num(o.monthly_amount), description: text(o.description),
    })),
  }));

  const prop = property.rows[0] || null;
  const l = loan || {};

  /**
   * What has actually been read, per section — the answer to "is this file thin, or is
   * something broken?", which nobody can tell from a screen full of dashes.
   *
   * THREE STATES, and collapsing any two of them is the whole bug this exists to avoid:
   *   `read`       — rows came back.
   *   `empty`      — the query RAN and there is genuinely nothing on this loan.
   *   `unreadable` — the query FAILED, so we know nothing either way.
   * "Encompass holds nothing for this borrower" and "we could not ask" look identical on
   * a screen and mean opposite things to whoever has to chase it.
   */
  const inv = investor.rows[0] || {};

  const coverage = (result, count) => ({
    state: result.error ? 'unreadable' : (count > 0 ? 'read' : 'empty'),
    count: result.error ? null : count,
  });

  /**
   * A section whose substance is not a LIST of rows.
   *
   * Income is the one: its real content is the DSCR, the rent and the housing expense —
   * all on the loan row — while `lt_other_incomes` is an extra that most DSCR files
   * correctly have none of. Counting only the rows would report a loan with a perfectly
   * good 1.35 DSCR as "nothing on file yet", which is exactly the confident wrong answer
   * the coverage block exists to prevent. `count` is null because there is nothing here
   * a number would honestly describe.
   */
  const coverageOf = (result, hasSubstance) => ({
    state: result.error ? 'unreadable' : (hasSubstance ? 'read' : 'empty'),
    count: null,
  });

  return {
    coverage: {
      borrowers: coverage(parties, parties.rows.length),
      property: coverage(property, property.rows.length),
      income: coverageOf(otherIncomes, otherIncomes.rows.length > 0
        || num(l.dscr_ratio) !== null
        || num(l.housing_expense_total) !== null
        || (prop ? num(prop.gross_monthly_rent) !== null || num(prop.actual_monthly_rent) !== null : false)),
      employment: coverage(employments, employments.rows.length),
      assets: coverage(assets, assets.rows.length + liabilities.rows.length),
      reo: coverage(reo, reo.rows.length),
      declarations: coverage(declarations, declarations.rows.length),
    },

    borrowers: {
      error: parties.error,
      pairs: pairs.rows.map((p) => ({
        id: p.id, number: p.pair_number, propertyUsage: text(p.property_usage_type),
      })),
      parties: people,
    },

    property: {
      error: property.error,
      // What PILOT knowingly does not hold, so the screen can SAY so rather than
      // draw a dash — a dash beside "In a flood zone" reads as "No", and "No" is an
      // answer somebody prices a loan on.
      notSourced: unsourced.notSourcedFor('lt_properties'),
      recorded: !!prop,
      address: prop
        ? [text(prop.street), text(prop.city), text(prop.state), text(prop.zip)].filter(Boolean).join(', ') || null
        : null,
      county: prop ? text(prop.county) : null,
      unitCount: prop ? num(prop.unit_count) : null,
      propertyType: prop ? text(prop.gse_property_type) : null,
      occupancy: prop ? text(prop.occupancy_type) : null,
      occupancyRatePct: prop ? num(prop.occupancy_rate_pct) : null,
      appraisedValue: prop ? num(prop.appraised_value) : null,
      estimatedValue: prop ? num(prop.estimated_value) : null,
      purchasePrice: prop ? num(prop.purchase_price) : null,
      originalCost: prop ? num(prop.original_cost) : null,
      ltvPct: prop ? num(prop.ltv_pct) : null,
      cltvPct: prop ? num(prop.cltv_pct) : null,
      inFloodZone: prop && prop.in_flood_zone !== null ? prop.in_flood_zone === true : null,
      floodZone: prop ? text(prop.flood_zone) : null,
    },

    terms: {
      loanAmount: num(l.loan_amount),
      noteRatePct: num(l.note_rate_pct),
      termMonths: num(l.term_months),
      interestOnlyMonths: num(l.interest_only_months),
      amortizationType: text(l.amortization_type),
      lienPosition: text(l.lien_position),
      productKind: text(l.product_kind),
      program: text(l.program_name),
      purpose: text(l.loan_purpose),
      prepaymentPenaltyMonths: num(l.prepayment_penalty_months),
      prepaymentPenaltyStructure: text(l.prepayment_penalty_structure),
      // The ARM block is only meaningful on an adjustable loan, and it is returned
      // ONLY there: a fixed loan showing a row of empty ARM fields reads as data we
      // failed to fetch rather than terms that do not exist.
      //
      // THE VALUE IS THE ENUM'S, NOT THE INDUSTRY'S WORD. `lt_amortization_type`
      // (db/549) is exactly `('fixed','adjustable')`, so the column can NEVER hold
      // 'arm' — gating on that word returns null on every adjustable loan in the
      // book, silently and forever, which is why this reads the enum verbatim.
      //
      // AND NOTHING WRITES ANY OF THE EIGHT. That is recorded rather than left to
      // be discovered — `unsourced` carries the measurement (the two fields that
      // look like ARM terms are the note rate under another name), and the screen
      // says it ONCE for the block instead of drawing eight dashes, each of which
      // would read as a term this loan does not have. `notHeld` is what makes that
      // sayable, and it gives way field by field the day a writer lands.
      arm: String(l.amortization_type || '').toLowerCase() === 'adjustable' ? {
        indexName: text(l.arm_index_name),
        marginPct: num(l.arm_margin_pct),
        firstAdjustmentMonths: num(l.arm_first_adjustment_months),
        adjustmentFrequencyMonths: num(l.arm_adjustment_frequency_months),
        initialCapPct: num(l.arm_initial_cap_pct),
        periodicCapPct: num(l.arm_periodic_cap_pct),
        lifetimeCapPct: num(l.arm_lifetime_cap_pct),
        floorPct: num(l.arm_floor_pct),
        notSourced: unsourced.notSourcedFor('lt_loans'),
        notHeld: !(l.arm_index_name != null || l.arm_margin_pct != null
          || l.arm_first_adjustment_months != null || l.arm_adjustment_frequency_months != null
          || l.arm_initial_cap_pct != null || l.arm_periodic_cap_pct != null
          || l.arm_lifetime_cap_pct != null || l.arm_floor_pct != null),
      } : null,
    },

    income: {
      // The same list as the property section, because two of the three figures on
      // this one live on `lt_properties` and one of them is knowingly empty.
      notSourced: unsourced.notSourcedFor('lt_properties'),
      // The DSCR as Encompass computed it, beside the two figures it is built from,
      // so an underwriter can see what the ratio rests on rather than a bare number.
      dscr: num(l.dscr_ratio),
      // …and which side of THIS COMPANY'S OWN thresholds it fell on. The rule is
      // one pure function and the thresholds travel with the answer, so a screen
      // can say what it compared against instead of pronouncing on the loan — and
      // a buyer who works to a different figure changes a setting, not code. Null
      // on a loan with no ratio: a mark nobody measured is worse than no mark.
      dscrVerdict: dscrVerdict.dscrVerdict(num(l.dscr_ratio), opts.settings),
      grossMonthlyRent: prop ? num(prop.gross_monthly_rent) : null,
      actualMonthlyRent: prop ? num(prop.actual_monthly_rent) : null,
      housingExpenseTotal: num(l.housing_expense_total),
      housingExpense: {
        firstMortgagePi: num(l.expense_first_mortgage_pi),
        otherFinancingPi: num(l.expense_other_financing_pi),
        hazardInsurance: num(l.expense_hazard_insurance),
        realEstateTaxes: num(l.expense_real_estate_taxes),
        associationDues: num(l.expense_association_dues),
        supplementalInsurance: num(l.expense_supplemental_insurance),
        other: num(l.expense_other),
      },
      otherIncome: otherIncomes.rows.map((o) => ({
        partyId: o.party_id, type: text(o.income_type),
        monthlyAmount: num(o.monthly_amount), description: text(o.description),
      })),
      error: otherIncomes.error,
    },

    employment: {
      error: employments.error,
      applies: l.employment_applies === true,
      rows: employments.rows.map(describeEmployment),
    },

    assets: {
      error: assets.error || liabilities.error,
      assets: assets.rows.map((a) => ({
        id: a.id, partyId: a.party_id, section: text(a.section), type: text(a.asset_type),
        institution: text(a.institution_name), accountLast4: text(a.account_last4),
        value: num(a.value), verified: a.is_verified === true,
      })),
      liabilities: liabilities.rows.map((x) => ({
        id: x.id, partyId: x.party_id, section: text(x.section), type: text(x.liability_type),
        creditor: text(x.creditor_name), accountLast4: text(x.account_last4),
        unpaidBalance: num(x.unpaid_balance), monthlyPayment: num(x.monthly_payment),
        monthsRemaining: num(x.months_remaining), toBePaidOff: x.to_be_paid_off === true,
        reoPropertyId: x.reo_property_id || null,
      })),
      totals: {
        assets: sumOrNull(assets.rows.map((a) => a.value)),
        unpaidBalance: sumOrNull(liabilities.rows.map((x) => x.unpaid_balance)),
        monthlyPayments: sumOrNull(liabilities.rows.map((x) => x.monthly_payment)),
      },
    },

    reo: {
      error: reo.error,
      rows: reo.rows.map((r) => ({
        id: r.id, partyId: r.party_id,
        address: [text(r.street), text(r.city), text(r.state), text(r.zip)].filter(Boolean).join(', ') || null,
        propertyType: text(r.property_type), occupancy: text(r.occupancy_type),
        disposition: text(r.disposition_status),
        presentValue: num(r.present_value), mortgageBalance: num(r.mortgage_balance),
        monthlyMortgagePayment: num(r.monthly_mortgage_payment), monthlyExpenses: num(r.monthly_expenses),
        grossMonthlyRent: num(r.gross_monthly_rent), netMonthlyRentalIncome: num(r.net_monthly_rental_income),
        acquiredDate: day(r.acquired_date), verified: r.is_verified === true,
      })),
      totals: {
        presentValue: sumOrNull(reo.rows.map((r) => r.present_value)),
        mortgageBalance: sumOrNull(reo.rows.map((r) => r.mortgage_balance)),
        netMonthlyRentalIncome: sumOrNull(reo.rows.map((r) => r.net_monthly_rental_income)),
      },
    },

    // WHO BOUGHT THE LOAN — STAFF ONLY, and that is a hard rule rather than a
    // preference (CLAUDE.md rule 10): the investor's name, their own loan number
    // and the funding channel never reach a borrower or a TPO, and the channel
    // counts because it names HOW a loan is funded, which implies WHO. This file
    // screen is behind the staff mount and has no client audience — everything it
    // returns is internal — so the guard here is that nothing may lift this block
    // onto a client payload without going through `audience.js`, the one
    // definition. `recorded` is what makes the difference between "not sold yet"
    // and "sold, and we cannot read it" sayable on the screen.
    investor: {
      error: investor.error,
      recorded: investor.rows.length > 0,
      shorthandName: text(inv.shorthand_name),
      accurateName: text(inv.accurate_name),
      canonicalKey: text(inv.canonical_key),
      // The only thing that lets us and the investor talk about the same loan.
      investorLoanNumber: text(inv.investor_loan_number),
      investorEmail: text(inv.investor_email),
      fundingChannel: text(inv.funding_channel),
      readAt: day(inv.updated_at),
    },

    declarations: {
      error: declarations.error,
      // One set per PARTY: two borrowers answer the 1003's declarations separately,
      // and merging them would attribute one person's bankruptcy to the other.
      rows: parties.rows.map((p) => {
        const d = (declByParty.get(String(p.id)) || [])[0] || null;
        return {
          partyId: p.id,
          party: describeParty(p).name,
          answered: !!d,
          answers: d ? {
            willOccupyAsPrimary: d.will_occupy_as_primary,
            hadOwnershipLast3Years: d.had_ownership_last_3_years,
            familyRelationshipToSeller: d.family_relationship_to_seller,
            borrowingOtherMoney: d.borrowing_other_money,
            applyingOtherMortgage: d.applying_other_mortgage,
            applyingNewCredit: d.applying_new_credit,
            propertySubjectToLien: d.property_subject_to_lien,
            isCoSignerOrGuarantor: d.is_co_signer_or_guarantor,
            hasOutstandingJudgments: d.has_outstanding_judgments,
            isDelinquentOnFederalDebt: d.is_delinquent_on_federal_debt,
            isPartyToLawsuit: d.is_party_to_lawsuit,
            hadTitleConveyedInLieu: d.had_title_conveyed_in_lieu,
            hadPreForeclosureSale: d.had_pre_foreclosure_sale,
            hadPropertyForeclosed: d.had_property_foreclosed,
            hasDeclaredBankruptcy: d.has_declared_bankruptcy,
            bankruptcyChapters: d.bankruptcy_chapters || null,
          } : null,
        };
      }),
    },
  };
}

module.exports = {
  loadFile,
  _internals: { describeParty, describeResidence, describeEmployment, sumOrNull, personName, num, text, day },
};
