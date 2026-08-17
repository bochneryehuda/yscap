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

    for (const p of pair.parties) {
      // Keyed on (pair, role) — the unique index db/549 already carries. A person
      // is identified by the SLOT they occupy on the application, because a name
      // changes (a marriage, a correction) and a slot does not.
      await db.query(
        `INSERT INTO lt_parties
           (id, pair_id, role, party_type, first_name, middle_name, last_name, name_suffix,
            date_of_birth, ssn_last4, citizenship, marital_status, dependent_count,
            email, home_phone, mobile_phone,
            fico_experian, fico_transunion, fico_equifax, fico_representative, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::lt_party_role, $3::lt_party_type,
                 $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, now())
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
           updated_at         = now()`,
        [pairId, p.role, p.partyType, p.firstName, p.middleName, p.lastName, p.nameSuffix,
          p.dateOfBirth, p.ssnLast4, p.citizenship, p.maritalStatus, p.dependentCount,
          p.email, p.homePhone, p.mobilePhone,
          p.ficoExperian, p.ficoTransunion, p.ficoEquifax, p.ficoRepresentative],
      );
      parties += 1;
    }
  }

  return { ok: true, pairs: pairs.length, parties };
}

module.exports = { syncSubjectProperty, syncBorrowerPairs };
