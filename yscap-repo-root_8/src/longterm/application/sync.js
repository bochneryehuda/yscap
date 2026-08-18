'use strict';
/**
 * LONG-TERM — filling the 1003 mirror from the loan we already read.
 *
 * db/549 shipped the whole URLA spine and `file.js`, `workspace.js` and
 * `pipeline.js` all READ it — the file's Property section, the summary rail's
 * value / LTV / occupancy / rent rows, and the pipeline's own property address and
 * LTV columns. Nothing ever WROTE it, so every one of those answered blank on
 * every loan, silently, from the day they shipped. This is that writer.
 *
 * ENCOMPASS IS NEVER WRITTEN, and nothing here even reads it: the caller hands in
 * the loan payload it already fetched. So this module has no client, no endpoint
 * and no way to reach the tenant.
 *
 * A PARTIAL READ MAY NEVER BLANK WHAT WE HOLD. Encompass omits an unpopulated
 * field entirely rather than sending a null, so "this loan has no appraised value"
 * and "this payload did not carry one" look identical on the wire — which means a
 * plain overwrite would empty the Property tab a column at a time on any thinner
 * read. Every column is written `COALESCE(EXCLUDED.x, existing.x)`. The accepted
 * cost, stated plainly: a figure genuinely CLEARED in Encompass stays on our copy
 * until it is replaced by a real value. Showing a stale number is bad; blanking a
 * whole book's property figures because one payload arrived thin is worse, and it
 * is the failure this tenant's own omission behaviour actually produces.
 *
 * SEPARATION: writes only `lt_*`.
 */

const mapper = require('./mapper');

const lazy = {
  get db() { return require('../db'); },
};

/**
 * Mirror one loan's subject property.
 *
 * Returns a plain report rather than throwing: the caller is a sweep over many
 * loans and one loan's failure is data, not an exception. It is called AFTER the
 * loan itself has been mirrored, so a failure here can never cost the loan.
 */
async function syncSubjectProperty(loanId, loan, opts = {}) {
  const row = mapper.readSubjectProperty(loan, opts.values);
  if (!row) return { ok: false, reason: 'no loan payload to read the property from' };

  // NOTHING FOUND IS NOT A PROPERTY. Writing an all-null row would put a
  // `lt_properties` record on the loan that reads, to every screen and every
  // LEFT JOIN, exactly like a property we read and found empty — and it would
  // then absorb the COALESCE protection above for ever after.
  if (row._found === 0) {
    return { ok: true, written: false, found: 0, fields: row._fields, reason: 'the payload carried no property figures' };
  }

  const db = opts.db || lazy.db;
  await db.query(
    `INSERT INTO lt_properties
       (loan_id, street, city, county, state, zip, unit_count, gse_property_type,
        occupancy_type, occupancy_rate_pct, appraised_value, estimated_value,
        purchase_price, original_cost, gross_monthly_rent, ltv_pct, cltv_pct, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
     ON CONFLICT (loan_id) DO UPDATE SET
       street             = COALESCE(EXCLUDED.street, lt_properties.street),
       city               = COALESCE(EXCLUDED.city, lt_properties.city),
       county             = COALESCE(EXCLUDED.county, lt_properties.county),
       state              = COALESCE(EXCLUDED.state, lt_properties.state),
       zip                = COALESCE(EXCLUDED.zip, lt_properties.zip),
       unit_count         = COALESCE(EXCLUDED.unit_count, lt_properties.unit_count),
       gse_property_type  = COALESCE(EXCLUDED.gse_property_type, lt_properties.gse_property_type),
       occupancy_type     = COALESCE(EXCLUDED.occupancy_type, lt_properties.occupancy_type),
       occupancy_rate_pct = COALESCE(EXCLUDED.occupancy_rate_pct, lt_properties.occupancy_rate_pct),
       appraised_value    = COALESCE(EXCLUDED.appraised_value, lt_properties.appraised_value),
       estimated_value    = COALESCE(EXCLUDED.estimated_value, lt_properties.estimated_value),
       purchase_price     = COALESCE(EXCLUDED.purchase_price, lt_properties.purchase_price),
       original_cost      = COALESCE(EXCLUDED.original_cost, lt_properties.original_cost),
       gross_monthly_rent = COALESCE(EXCLUDED.gross_monthly_rent, lt_properties.gross_monthly_rent),
       ltv_pct            = COALESCE(EXCLUDED.ltv_pct, lt_properties.ltv_pct),
       cltv_pct           = COALESCE(EXCLUDED.cltv_pct, lt_properties.cltv_pct),
       updated_at         = now()`,
    [loanId, row.street, row.city, row.county, row.state, row.zip, row.unitCount,
      row.gsePropertyType, row.occupancyType, row.occupancyRatePct, row.appraisedValue,
      row.estimatedValue, row.purchasePrice, row.originalCost, row.grossMonthlyRent,
      row.ltvPct, row.cltvPct],
  );

  return { ok: true, written: true, found: row._found, fields: row._fields };
}

/**
 * Mirror the loan's own terms, its housing expense and its DSCR.
 *
 * NOT NULL columns with defaults (`amortization_type`, `lien_position`,
 * `product_kind`, `employment_applies`) are only ever written when we actually
 * read one — the COALESCE keeps the default rather than pushing a null at a
 * column that will not take it, so a payload that says nothing about the
 * amortization leaves the row's `fixed` alone instead of failing the whole write.
 *
 * `dscr_source` is NOT a column and is deliberately not made one: db/549 has no
 * place for it, adding one for a provenance note would be a schema change nobody
 * asked for, and the value is reported to the caller where a sync screen can show
 * it. If it ever needs to be durable, that is its own decision.
 */
async function syncLoanTerms(loanId, loan, opts = {}) {
  const row = mapper.readLoanTerms(loan, opts.values);
  if (!row) return { ok: false, reason: 'no loan payload to read the terms from' };
  if (row._found === 0) {
    return { ok: true, written: false, found: 0, reason: 'the payload carried no terms' };
  }

  const db = opts.db || lazy.db;
  await db.query(
    `UPDATE lt_loans SET
       amortization_type              = COALESCE($2::lt_amortization_type, amortization_type),
       loan_purpose                   = COALESCE($3::lt_loan_purpose, loan_purpose),
       lien_position                  = COALESCE($4::lt_lien_position, lien_position),
       interest_only_months           = COALESCE($5, interest_only_months),
       note_rate_pct                  = COALESCE($6, note_rate_pct),
       housing_expense_total          = COALESCE($7, housing_expense_total),
       expense_first_mortgage_pi      = COALESCE($8, expense_first_mortgage_pi),
       expense_other_financing_pi     = COALESCE($9, expense_other_financing_pi),
       expense_hazard_insurance       = COALESCE($10, expense_hazard_insurance),
       expense_real_estate_taxes      = COALESCE($11, expense_real_estate_taxes),
       expense_association_dues       = COALESCE($12, expense_association_dues),
       expense_other                  = COALESCE($13, expense_other),
       expense_supplemental_insurance = COALESCE($14, expense_supplemental_insurance),
       dscr_ratio                     = COALESCE($15, dscr_ratio),
       prepayment_penalty_months      = COALESCE($16, prepayment_penalty_months),
       prepayment_penalty_structure   = COALESCE($17, prepayment_penalty_structure),
       employment_applies             = COALESCE($18, employment_applies),
       updated_at                     = now()
     WHERE id = $1::uuid`,
    [loanId, row.amortizationType, row.loanPurpose, row.lienPosition,
      row.interestOnlyMonths, row.noteRatePct, row.housingExpenseTotal,
      row.expenseFirstMortgagePi, row.expenseOtherFinancingPi, row.expenseHazardInsurance,
      row.expenseRealEstateTaxes, row.expenseAssociationDues, row.expenseOther,
      row.expenseSupplementalInsurance, row.dscrRatio,
      row.prepaymentPenaltyMonths, row.prepaymentPenaltyStructure, row.employmentApplies],
  );

  return { ok: true, written: true, found: row._found, dscr: row.dscrRatio, dscrSource: row.dscrSource };
}

/**
 * ONE child row on one person — a residence, an income, an REO property, an
 * asset, a debt.
 *
 * ONE writer for five tables, because the RULE is the same for all of them and
 * five copies of it would drift: keyed on Encompass's own id, COALESCEd onto what
 * we hold, nothing deleted. The COLUMNS differ, so they are passed in; the SHAPE
 * does not, so it lives here.
 *
 * THE `ON CONFLICT` REPEATS THE INDEX'S `WHERE`. db/575's unique indexes are
 * PARTIAL — a row Encompass sends without an id must still be storable, and a
 * blanket unique index over a nullable column would collapse two real rows that
 * both arrived without one. Postgres cannot infer a partial index without its
 * predicate, and leaving it off is a 42P10 at runtime, inside a catch, reading
 * for ever as "these rows would not store".
 *
 * A ROW WITH NO ID IS INSERTED AND NEVER RE-KEYED — the same trade the condition
 * thread makes, for the same reason. Here it is bounded differently: this writer
 * runs on a per-loan basis and an id-less row would multiply on every read, so it
 * is COUNTED and skipped rather than filed. If a tenant turns out to send these
 * without ids, that number climbs loudly on the first pass.
 *
 * The column names and casts are the CALLER's, and every one of them is checked
 * against the real schema by the DB suite — a phantom column here would sit
 * inside its caller's catch reporting a confident success.
 */
async function upsertChild(db, table, partyId, encompassId, cols) {
  if (!encompassId) return false;

  const names = Object.keys(cols);
  const params = [partyId, encompassId, ...names.map((n) => cols[n].v)];
  const placeholders = names.map((n, i) => `$${i + 3}${cols[n].cast || ''}`);
  const setters = names.map((n) => `${n} = COALESCE(EXCLUDED.${n}, ${table}.${n})`);

  await db.query(
    `INSERT INTO ${table} (id, party_id, encompass_id, ${names.join(', ')}, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, ${placeholders.join(', ')}, now())
     ON CONFLICT (party_id, encompass_id) WHERE encompass_id IS NOT NULL
     DO UPDATE SET ${setters.join(', ')}, updated_at = now()`,
    params,
  );
  return true;
}

/**
 * Mirror the borrower pairs and the people in them (URLA §1a).
 *
 * THE SOCIAL SECURITY NUMBER IS NEVER WRITTEN. `lt_parties.ssn_encrypted` stays
 * NULL: the only encryption in this codebase is an RTL module, and reaching it
 * from the long-term side is a crossing that needs the owner's written
 * authorization in `docs/LONG-TERM-AUTHORIZED-COPIES.md`. Only `ssn_last4` is
 * stored, which is what `file.js` reads and what a person reads back on a phone
 * call — so nothing on a screen is waiting on that decision.
 *
 * A PAIR THAT DISAPPEARS IS NOT DELETED. Encompass can only ever ADD pairs in
 * practice, but a payload that momentarily carries one fewer must not take a
 * borrower off a file — so nothing here removes a pair or a party, and a stale one
 * would be visible on the screen rather than silently gone. That is the same
 * choice the condition mirror makes for the same reason.
 */
async function syncBorrowerPairs(loanId, loan, opts = {}) {
  const pairs = mapper.readBorrowerPairs(loan);
  if (!pairs.length) return { ok: true, pairs: 0, parties: 0, reason: 'the payload carried no applications' };

  const db = opts.db || lazy.db;
  let parties = 0;
  let children = 0;
  let unkeyed = 0;
  let orphaned = 0;

  for (const pair of pairs) {
    const { rows } = await db.query(
      `INSERT INTO lt_borrower_pairs
         (id, loan_id, pair_number, encompass_application_id, property_usage_type, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, now())
       ON CONFLICT (loan_id, pair_number) DO UPDATE SET
         encompass_application_id = COALESCE(EXCLUDED.encompass_application_id, lt_borrower_pairs.encompass_application_id),
         property_usage_type      = COALESCE(EXCLUDED.property_usage_type, lt_borrower_pairs.property_usage_type),
         updated_at               = now()
       RETURNING id`,
      [loanId, pair.pairNumber, pair.encompassApplicationId, pair.propertyUsageType],
    );
    const pairId = rows[0] && rows[0].id;
    if (!pairId) continue;

    const partyIdByRole = new Map();

    for (const p of pair.parties) {
      // Keyed on (pair, role) — the unique index db/549 already carries. A person
      // is identified by the SLOT they occupy on the application, because a name
      // changes (a marriage, a correction) and a slot does not.
      const party = await db.query(
        `INSERT INTO lt_parties
           (id, pair_id, role, party_type, first_name, middle_name, last_name, name_suffix,
            date_of_birth, ssn_last4, citizenship, marital_status, dependent_count,
            email, home_phone, mobile_phone,
            fico_experian, fico_transunion, fico_equifax, fico_representative,
            encompass_id, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::lt_party_role, $3::lt_party_type,
                 $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, now())
         ON CONFLICT (pair_id, role) DO UPDATE SET
           first_name         = COALESCE(EXCLUDED.first_name, lt_parties.first_name),
           middle_name        = COALESCE(EXCLUDED.middle_name, lt_parties.middle_name),
           last_name          = COALESCE(EXCLUDED.last_name, lt_parties.last_name),
           name_suffix        = COALESCE(EXCLUDED.name_suffix, lt_parties.name_suffix),
           date_of_birth      = COALESCE(EXCLUDED.date_of_birth, lt_parties.date_of_birth),
           ssn_last4          = COALESCE(EXCLUDED.ssn_last4, lt_parties.ssn_last4),
           citizenship        = COALESCE(EXCLUDED.citizenship, lt_parties.citizenship),
           marital_status     = COALESCE(EXCLUDED.marital_status, lt_parties.marital_status),
           dependent_count    = COALESCE(EXCLUDED.dependent_count, lt_parties.dependent_count),
           email              = COALESCE(EXCLUDED.email, lt_parties.email),
           home_phone         = COALESCE(EXCLUDED.home_phone, lt_parties.home_phone),
           mobile_phone       = COALESCE(EXCLUDED.mobile_phone, lt_parties.mobile_phone),
           fico_experian      = COALESCE(EXCLUDED.fico_experian, lt_parties.fico_experian),
           fico_transunion    = COALESCE(EXCLUDED.fico_transunion, lt_parties.fico_transunion),
           fico_equifax       = COALESCE(EXCLUDED.fico_equifax, lt_parties.fico_equifax),
           fico_representative = COALESCE(EXCLUDED.fico_representative, lt_parties.fico_representative),
           encompass_id       = COALESCE(EXCLUDED.encompass_id, lt_parties.encompass_id),
           updated_at         = now()
         RETURNING id`,
        [pairId, p.role, p.partyType, p.firstName, p.middleName, p.lastName, p.nameSuffix,
          p.dateOfBirth, p.ssnLast4, p.citizenship, p.maritalStatus, p.dependentCount,
          p.email, p.homePhone, p.mobilePhone,
          p.ficoExperian, p.ficoTransunion, p.ficoEquifax, p.ficoRepresentative,
          p.encompassId || null],
      );
      parties += 1;

      const partyId = party.rows[0] && party.rows[0].id;
      if (!partyId) continue;
      partyIdByRole.set(p.role, partyId);

      for (const r of (p.residences || [])) {
        const wrote = await upsertChild(db, 'lt_residences', partyId, r.encompassId, {
          residency_type: { v: r.residencyType, cast: '::lt_residency_type' },
          residency_basis: { v: r.residencyBasis, cast: '::lt_residency_basis' },
          street: { v: r.street }, city: { v: r.city }, state: { v: r.state },
          zip: { v: r.zip }, country: { v: r.country },
          duration_months: { v: r.durationMonths }, monthly_rent: { v: r.monthlyRent },
        });
        if (wrote) children += 1; else unkeyed += 1;
      }

      for (const e of (p.employments || [])) {
        const wrote = await upsertChild(db, 'lt_employments', partyId, e.encompassId, {
          employer_name: { v: e.employerName }, position: { v: e.position },
          employment_type: { v: e.employmentType, cast: '::lt_employment_type' },
          is_self_employed: { v: e.isSelfEmployed }, ownership_pct: { v: e.ownershipPct },
          start_date: { v: e.startDate, cast: '::date' }, end_date: { v: e.endDate, cast: '::date' },
          monthly_base_income: { v: e.monthlyBaseIncome },
          monthly_overtime_income: { v: e.monthlyOvertimeIncome },
          monthly_bonus_income: { v: e.monthlyBonusIncome },
          monthly_commission_income: { v: e.monthlyCommissionIncome },
          monthly_other_income: { v: e.monthlyOtherIncome },
          employer_street: { v: e.employerStreet }, employer_city: { v: e.employerCity },
          employer_state: { v: e.employerState }, employer_zip: { v: e.employerZip },
          employer_phone: { v: e.employerPhone },
        });
        if (wrote) children += 1; else unkeyed += 1;
      }

      // The declarations are keyed on the PARTY itself (db/549's primary key), so
      // they need no Encompass id and go through their own statement.
      if (p.declarations) {
        const d = p.declarations;
        await db.query(
          `INSERT INTO lt_declarations
             (party_id, will_occupy_as_primary, had_ownership_last_3_years,
              family_relationship_to_seller, borrowing_other_money, applying_other_mortgage,
              applying_new_credit, property_subject_to_lien, is_co_signer_or_guarantor,
              has_outstanding_judgments, is_delinquent_on_federal_debt, is_party_to_lawsuit,
              had_title_conveyed_in_lieu, had_pre_foreclosure_sale, had_property_foreclosed,
              has_declared_bankruptcy, bankruptcy_chapters, updated_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
           ON CONFLICT (party_id) DO UPDATE SET
             will_occupy_as_primary        = COALESCE(EXCLUDED.will_occupy_as_primary, lt_declarations.will_occupy_as_primary),
             had_ownership_last_3_years    = COALESCE(EXCLUDED.had_ownership_last_3_years, lt_declarations.had_ownership_last_3_years),
             family_relationship_to_seller = COALESCE(EXCLUDED.family_relationship_to_seller, lt_declarations.family_relationship_to_seller),
             borrowing_other_money         = COALESCE(EXCLUDED.borrowing_other_money, lt_declarations.borrowing_other_money),
             applying_other_mortgage       = COALESCE(EXCLUDED.applying_other_mortgage, lt_declarations.applying_other_mortgage),
             applying_new_credit           = COALESCE(EXCLUDED.applying_new_credit, lt_declarations.applying_new_credit),
             property_subject_to_lien      = COALESCE(EXCLUDED.property_subject_to_lien, lt_declarations.property_subject_to_lien),
             is_co_signer_or_guarantor     = COALESCE(EXCLUDED.is_co_signer_or_guarantor, lt_declarations.is_co_signer_or_guarantor),
             has_outstanding_judgments     = COALESCE(EXCLUDED.has_outstanding_judgments, lt_declarations.has_outstanding_judgments),
             is_delinquent_on_federal_debt = COALESCE(EXCLUDED.is_delinquent_on_federal_debt, lt_declarations.is_delinquent_on_federal_debt),
             is_party_to_lawsuit           = COALESCE(EXCLUDED.is_party_to_lawsuit, lt_declarations.is_party_to_lawsuit),
             had_title_conveyed_in_lieu    = COALESCE(EXCLUDED.had_title_conveyed_in_lieu, lt_declarations.had_title_conveyed_in_lieu),
             had_pre_foreclosure_sale      = COALESCE(EXCLUDED.had_pre_foreclosure_sale, lt_declarations.had_pre_foreclosure_sale),
             had_property_foreclosed       = COALESCE(EXCLUDED.had_property_foreclosed, lt_declarations.had_property_foreclosed),
             has_declared_bankruptcy       = COALESCE(EXCLUDED.has_declared_bankruptcy, lt_declarations.has_declared_bankruptcy),
             bankruptcy_chapters           = COALESCE(EXCLUDED.bankruptcy_chapters, lt_declarations.bankruptcy_chapters),
             updated_at                    = now()`,
          [partyId, d.willOccupyAsPrimary, d.hadOwnershipLast3Years, d.familyRelationshipToSeller,
            d.borrowingOtherMoney, d.applyingOtherMortgage, d.applyingNewCredit,
            d.propertySubjectToLien, d.isCoSignerOrGuarantor, d.hasOutstandingJudgments,
            d.isDelinquentOnFederalDebt, d.isPartyToLawsuit, d.hadTitleConveyedInLieu,
            d.hadPreForeclosureSale, d.hadPropertyForeclosed, d.hasDeclaredBankruptcy,
            d.bankruptcyChapters],
        );
        children += 1;
      }
    }

    // The application-level lists say WHOSE they are with an `owner`, so they are
    // routed by role — and a row whose owner is not on this file is DROPPED rather
    // than parked on the primary, because one person's debts on another's schedule
    // is what a DSCR file is underwritten on.
    const route = (rowsIn, table, cols) => rowsIn.filter((r) => partyIdByRole.has(r.role))
      .map((r) => ({ partyId: partyIdByRole.get(r.role), id: r.encompassId, cols: cols(r), table }));

    // WRITTEN BEFORE THE DEBTS, on purpose: a liability names the rental it is
    // secured on by Encompass's id, and the row it points at has to exist before
    // that can be turned into our own key.
    const childWrites = [
      ...route(pair.incomes, 'lt_other_incomes', (r) => ({
        income_type: { v: r.incomeType }, monthly_amount: { v: r.monthlyAmount },
        description: { v: r.description },
      })),
      ...route(pair.reo, 'lt_reo_properties', (r) => ({
        street: { v: r.street }, city: { v: r.city }, state: { v: r.state }, zip: { v: r.zip },
        property_type: { v: r.propertyType }, occupancy_type: { v: r.occupancyType },
        disposition_status: { v: r.dispositionStatus },
        present_value: { v: r.presentValue }, mortgage_balance: { v: r.mortgageBalance },
        monthly_mortgage_payment: { v: r.monthlyMortgagePayment },
        monthly_expenses: { v: r.monthlyExpenses },
        gross_monthly_rent: { v: r.grossMonthlyRent },
        net_monthly_rental_income: { v: r.netMonthlyRentalIncome },
      })),
      ...route(pair.assets, 'lt_assets', (r) => ({
        section: { v: r.section, cast: '::lt_asset_section' },
        asset_type: { v: r.assetType }, institution_name: { v: r.institutionName },
        account_last4: { v: r.accountLast4 }, value: { v: r.value },
      })),
    ];

    for (const w of childWrites) {
      if (await upsertChild(db, w.table, w.partyId, w.id, w.cols)) children += 1;
      else unkeyed += 1;
    }

    // ── The debts, once their rentals are on the table ──────────────────────
    //
    // A mortgage on a rental is a different fact from a mortgage on nothing: the
    // first is covered by that property's own rent and the second is not, which on
    // a DSCR file is the difference between two underwriting answers. Encompass
    // hangs the link on the DEBT (`vols[].reoProperty.entityId`), so it is resolved
    // to our own row here rather than stored as a foreign id nothing can join.
    //
    // An id that resolves to NOTHING leaves the link empty rather than guessing —
    // the commonest reason is honest: a debt secured on the SUBJECT property, whose
    // REO row this mirror deliberately does not keep (see mapper.readReoProperties),
    // because filing it would show an investor's subject twice on their schedule.
    const reoIds = new Map();
    const partyIds = [...partyIdByRole.values()];
    if (partyIds.length) {
      const { rows: reoRows } = await db.query(
        `SELECT id, party_id, encompass_id FROM lt_reo_properties
          WHERE party_id = ANY($1::uuid[]) AND encompass_id IS NOT NULL`,
        [partyIds],
      );
      for (const r of reoRows) reoIds.set(`${r.party_id}:${r.encompass_id}`, r.id);
    }

    const debtWrites = route(pair.liabilities, 'lt_liabilities', (r) => ({
      section: { v: r.section, cast: '::lt_liability_section' },
      liability_type: { v: r.liabilityType }, creditor_name: { v: r.creditorName },
      account_last4: { v: r.accountLast4 }, unpaid_balance: { v: r.unpaidBalance },
      monthly_payment: { v: r.monthlyPayment }, months_remaining: { v: r.monthsRemaining },
      to_be_paid_off: { v: r.toBePaidOff },
      reo_property_id: {
        v: (r.reoEncompassId && reoIds.get(`${partyIdByRole.get(r.role)}:${r.reoEncompassId}`)) || null,
        cast: '::uuid',
      },
    }));

    for (const w of debtWrites) {
      if (await upsertChild(db, w.table, w.partyId, w.id, w.cols)) children += 1;
      else unkeyed += 1;
    }

    // A row the OWNER named as somebody not on this file. Counted rather than
    // parked on the primary: one person's debts on another's schedule is what a
    // DSCR file is underwritten on, and a silent drop is how nobody finds out.
    const routed = childWrites.length + debtWrites.length;
    const offered = pair.incomes.length + pair.reo.length + pair.assets.length + pair.liabilities.length;
    orphaned += offered - routed;
  }

  return { ok: true, pairs: pairs.length, parties, children, unkeyed, orphaned };
}

module.exports = { syncSubjectProperty, syncLoanTerms, syncBorrowerPairs };
