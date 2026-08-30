'use strict';
/**
 * LONG-TERM — THE REPORTING FIELD DICTIONARY.
 *
 * Owner-directed 2026-08-30: *"I want to start first to set up for myself as the
 * admin a reporting database where I can start building up my matrix … a full
 * reporting center where I can see for every file how long it took between which
 * and which step and who the processor was in that file, and then reporting per
 * processor."*
 *
 * HOW ENCOMPASS DOES IT, AND WHY THIS COPIES THAT SHAPE. Encompass's own Reporting
 * Database is not "SQL for loan officers" — it is a CURATED FIELD DICTIONARY over
 * the pipeline plus a filter grammar (field / operator / value rows), a column
 * picker and saved report definitions. The person building a report never names a
 * table or types an expression; they pick fields the dictionary offers, and every
 * filter value is DATA, never code. Three properties follow, and each is what
 * keeps an admin-authored report from becoming an admin-authored query:
 *
 *   1. THIS CATALOG IS THE ONLY THING A REPORT MAY NAME. A key it does not carry
 *      is REFUSED — a client can never smuggle an expression through a column
 *      name, a sort or a filter.
 *   2. EVERY VALUE IS BOUND ($n), never interpolated, and the operators are a
 *      per-type whitelist.
 *   3. THE COMPILED STATEMENT IS ALWAYS THE SAME SHAPE — the catalog decides the
 *      SELECT list, the one join, the WHERE and the ORDER BY.
 *
 * ONE JOIN, EVERY REPORT (`FROM_SQL`): the loan, its subject property, its
 * investor row, and its ladder folded in as per-milestone LATERALs. All LEFT, so a
 * loan missing any of them still reports.
 *
 * THIS IS LONG-TERM'S OWN. It reads `lt_*` tables and nothing else — no RTL table
 * appears here, and the RTL reporting database (`src/lib/reporting.js`) is a
 * separate build over `applications`. The two never join.
 *
 * THE INVESTOR IS INTERNAL, ALWAYS (CLAUDE.md rule 10). Every investor field is
 * marked `internalOnly`, and the compiler REFUSES to include one for any audience
 * that is not exactly `internal` — the same fail-closed posture `audience.js`
 * takes, because a report is one more surface a name can leak through.
 */

const spans = require('./spans');

/* Row caps. `DEFAULT_ROWS` is what a run returns unasked; `MAX_ROWS` is the hard
   ceiling. The response always says when it capped — no silent caps. */
const DEFAULT_ROWS = 500;
const MAX_ROWS = 5000;

/**
 * The one join every report runs over. The aliases are part of the catalog's
 * contract — a field's `sql` may reference exactly these.
 *
 * The ladder is folded in as ONE LATERAL PER MILESTONE the spans name, rather than
 * a join on `lt_loan_milestones` — a plain join multiplies the loan row by its
 * nineteen ladder rows, which would corrupt every count, every total and the row
 * cap itself.
 */
function fromSql(milestones, bind) {
  // THE MILESTONE NAME IS A BOUND VALUE, never interpolated. It is a tenant
  // SETTING — somebody can type it — so it goes through `bind` exactly like a
  // filter value, and the alias (which IS written into the statement) comes from
  // this module's own fixed key list and can never come from a request.
  //
  // The comparison is `stages.milestoneKey`'s rule expressed in SQL — lower-cased
  // with every run of non-alphanumerics collapsed to one space — so "Clear To
  // Close", "Clear to Close" and "CLEAR-TO-CLOSE" are one milestone whichever way
  // a tenant spells it, and the JavaScript twin in `spans.js` can never disagree
  // with the table about which ladder row a span is measured from.
  const key = (expr) => `btrim(lower(regexp_replace(${expr}, '[^a-zA-Z0-9]+', ' ', 'g')))`;
  const lat = Object.entries(milestones).map(([alias, name]) => `
  LEFT JOIN LATERAL (
    SELECT m.done, m.observed_done_at, m.observed_is_baseline,
           m.done_associate_id, m.done_associate_name,
           m.associate_id, m.associate_name, m.start_date
      FROM lt_loan_milestones m
     WHERE m.loan_id = l.id
       AND ${key('m.milestone_name')} = ${key(`${bind(name)}::text`)}
     LIMIT 1
  ) ${alias} ON true`).join('');

  return `
  FROM lt_loans l
  LEFT JOIN lt_properties p ON p.loan_id = l.id
  LEFT JOIN lt_loan_investors inv ON inv.loan_id = l.id${lat}`;
}

/* Loans a business report is ABOUT. An Encompass-archived record and a known
   duplicate are not the book — they are records the tenant has set aside, and a
   report that counted them would answer a different question than the pipeline. */
const BASE_SCOPE = 'l.encompass_archived = false AND l.archived_duplicate = false';

const F = (key, label, group, type, sql, extra) => ({ key, label, group, type, sql, ...(extra || {}) });

/**
 * THE DICTIONARY. Types: text | enum | money | number | pct | date | timestamp |
 * boolean | duration. Every `sql` is a READ over the aliases above.
 */
function baseFields() {
  return [
    // ── The file ───────────────────────────────────────────────────────────
    F('loan_number', 'Loan number', 'File', 'text', 'l.loan_number'),
    F('borrower_name', 'Borrower', 'File', 'text', "NULLIF(l.borrower_name,'')"),
    F('program', 'Program', 'File', 'text', 'l.program_name', { facet: true }),
    F('loan_purpose', 'Purpose', 'File', 'text', 'l.loan_purpose::text', { facet: true }),
    F('product_kind', 'Product', 'File', 'text', 'l.product_kind::text', { facet: true }),
    F('stage', 'Stage', 'File', 'text', 'l.stage_key', { facet: true }),
    F('milestone', 'Milestone', 'File', 'text', 'l.milestone_name', { facet: true }),
    F('ms_status', 'Encompass status', 'File', 'text', 'l.ms_status', { facet: true }),
    F('loan_folder', 'Encompass folder', 'File', 'text', 'l.loan_folder', { facet: true }),
    F('purchased_status', 'Purchased', 'File', 'text', 'l.purchased_status', { facet: true }),
    F('purchased_at', 'Purchased on', 'File', 'timestamp', 'l.purchased_at'),
    F('milestone_since', 'At milestone since', 'File', 'timestamp', 'l.milestone_since'),
    F('created_at', 'First seen by PILOT', 'File', 'timestamp', 'l.created_at'),
    F('encompass_last_modified', 'Encompass last touched', 'File', 'timestamp', 'l.encompass_last_modified'),

    // ── Money and terms ────────────────────────────────────────────────────
    F('loan_amount', 'Loan amount', 'Terms', 'money', 'l.loan_amount'),
    F('note_rate_pct', 'Note rate', 'Terms', 'pct', 'l.note_rate_pct'),
    F('term_months', 'Term (months)', 'Terms', 'number', 'l.term_months'),
    F('interest_only_months', 'Interest-only (months)', 'Terms', 'number', 'l.interest_only_months'),
    F('prepayment_penalty_months', 'Prepayment penalty (months)', 'Terms', 'number', 'l.prepayment_penalty_months'),
    F('dscr_ratio', 'DSCR', 'Terms', 'number', 'l.dscr_ratio'),
    F('housing_expense_total', 'Housing expense (PITIA)', 'Terms', 'money', 'l.housing_expense_total'),

    // ── The property ───────────────────────────────────────────────────────
    F('property_street', 'Subject address', 'Property', 'text', 'p.street'),
    F('property_state', 'State', 'Property', 'text', 'p.state', { facet: true }),
    F('property_city', 'City', 'Property', 'text', 'p.city', { facet: true }),
    F('property_zip', 'ZIP', 'Property', 'text', 'p.zip'),
    F('property_county', 'County', 'Property', 'text', 'p.county', { facet: true }),
    F('property_type', 'Property type', 'Property', 'text', 'p.gse_property_type', { facet: true }),
    F('occupancy_type', 'Occupancy', 'Property', 'text', 'p.occupancy_type', { facet: true }),
    F('unit_count', 'Units', 'Property', 'number', 'p.unit_count'),
    F('appraised_value', 'Appraised value', 'Property', 'money', 'p.appraised_value'),
    F('purchase_price', 'Purchase price', 'Property', 'money', 'p.purchase_price'),
    F('ltv_pct', 'LTV', 'Property', 'pct', 'p.ltv_pct'),
    F('gross_monthly_rent', 'Gross monthly rent', 'Property', 'money', 'p.gross_monthly_rent'),
    F('in_flood_zone', 'In a flood zone', 'Property', 'boolean', 'p.in_flood_zone'),

    // ── The investor — INTERNAL ONLY, on every surface (CLAUDE.md rule 10) ──
    F('investor_name', 'Investor', 'Investor', 'text', 'inv.accurate_name', { facet: true, internalOnly: true }),
    F('investor_loan_number', 'Investor loan number', 'Investor', 'text', 'inv.investor_loan_number', { internalOnly: true }),
    F('funding_channel', 'Funding channel', 'Investor', 'text', 'inv.funding_channel', { facet: true, internalOnly: true }),
  ];
}

/**
 * THE MILESTONE + SPAN FIELDS, GENERATED FROM THE SPAN DEFINITIONS — never a
 * second hand-kept list. Rename a milestone in settings and the columns follow;
 * add a span and its four fields appear on their own.
 */
function ladderFields(overrides) {
  const names = spans.milestoneNames(overrides);
  const out = [];

  for (const [alias, name] of Object.entries(names)) {
    out.push(F(`ms_${alias}_done_at`, `${name} — completed`, 'Milestones', 'timestamp',
      `CASE WHEN ${alias}.observed_is_baseline THEN NULL ELSE ${alias}.observed_done_at END`,
      { note: 'Blank when the step was already done the first time PILOT read the loan — that stamp is when we started watching, never when it moved.' }));
    out.push(F(`ms_${alias}_who`, `${name} — who`, 'Milestones', 'text',
      `COALESCE(${alias}.done_associate_name, ${alias}.associate_name)`, { facet: true }));
  }

  for (const s of spans.allSpans(overrides)) {
    const a = aliasOf(names, s.from);
    const b = aliasOf(names, s.to);
    if (!a || !b) continue;
    // A span is a NUMBER ONLY when both ends are witnessed completions. Every
    // guard here mirrors `spans.measureSpan` exactly, or the table and the
    // scorecard would answer differently about one file.
    const measurable = `${a}.done AND ${b}.done
       AND ${a}.observed_done_at IS NOT NULL AND ${b}.observed_done_at IS NOT NULL
       AND NOT ${a}.observed_is_baseline AND NOT ${b}.observed_is_baseline
       AND ${b}.observed_done_at >= ${a}.observed_done_at`;
    out.push(F(`span_${s.key}_days`, `${s.label} — days`, 'How long it took', 'duration',
      `CASE WHEN ${measurable}
             THEN round(EXTRACT(EPOCH FROM (${b}.observed_done_at - ${a}.observed_done_at)) / 86400.0, 2)
             ELSE NULL END`,
      { note: s.blurb }));
    if (s.ownerMilestoneName) {
      const o = aliasOf(names, s.ownerMilestone);
      out.push(F(`span_${s.key}_owner`, `${s.label} — ${String(s.ownerLabel || 'owner').toLowerCase()}`, 'How long it took', 'text',
        `COALESCE(${o}.done_associate_name, ${o}.associate_name)`, { facet: true }));
    }
  }
  return out;
}

function aliasOf(names, aliasKey) {
  return Object.prototype.hasOwnProperty.call(names, aliasKey) ? aliasKey : null;
}

/** The whole dictionary for a given milestone naming. */
function allFields(overrides) {
  return [...baseFields(), ...ladderFields(overrides)];
}

/** key → field, for the compiler's whitelist test. */
function fieldMap(overrides) {
  const m = Object.create(null);
  for (const f of allFields(overrides)) m[f.key] = f;
  return m;
}

/**
 * The dictionary a given AUDIENCE may see.
 *
 * FAILS CLOSED, exactly as `audience.js` does: anything that is not the string
 * `internal` is a client, and a client never sees an investor field. There is no
 * client-facing long-term report today; this is here so that adding one cannot
 * become the way the investor's name gets out.
 */
function fieldsFor(audience, overrides) {
  const internal = audience === 'internal';
  return allFields(overrides).filter((f) => internal || !f.internalOnly);
}

/** The groups, in reading order, for a picker. */
const GROUP_ORDER = ['File', 'Terms', 'Property', 'Milestones', 'How long it took', 'Investor'];

module.exports = {
  DEFAULT_ROWS, MAX_ROWS, BASE_SCOPE, GROUP_ORDER,
  fromSql, baseFields, ladderFields, allFields, fieldMap, fieldsFor,
};
