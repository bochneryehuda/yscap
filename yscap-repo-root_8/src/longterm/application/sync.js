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

module.exports = { syncSubjectProperty };
