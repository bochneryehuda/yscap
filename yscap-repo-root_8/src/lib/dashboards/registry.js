'use strict';

/**
 * The Dashboards catalogue — every field a person may filter on, every number a card may
 * measure, every way a card may be grouped, and every date that may drive a period.
 *
 * WHY THIS FILE EXISTS AT ALL: a dashboard builder lets a human compose a database query.
 * The only safe way to do that is to make the STRUCTURE of the query un-authorable — the
 * human picks a key from this catalogue and supplies a VALUE, and nothing they type ever
 * becomes SQL. Every `sql` string below is written here, by a developer, and is the only
 * thing that reaches the query. Values are always bound. See ./compile.js.
 *
 * IT IS A SEPARATE REGISTRY FROM THE CONDITION CENTER'S, DELIBERATELY.
 * src/lib/conditions/field-registry.js drives the live auto-post engine — adding a field
 * there changes what CONDITIONS can key on, on real loan files. This catalogue answers a
 * different question ("what can a report group and total?") and needs fields that make no
 * sense as a condition (days since touched, officer, open-condition counts). They share
 * the TREE SHAPE and the validator (rules.validateRule takes a `fields` map), so the same
 * RuleBuilder edits both and there is no fourth DSL — but they do not share the field list,
 * so a reporting field can never accidentally start firing conditions on a borrower's file.
 *
 * FAIL CLOSED. An unknown field key is a validation ERROR, never a silently-false row; a
 * comparison against a NULL column does not match. Same posture as the conditions engine
 * (rules.js), the opposite of the investor-guideline desk. Stated here so nobody has to
 * guess which one this is.
 *
 * THE FROM CLAUSE IS FIXED AND CANNOT FAN OUT. Every join below is at most 1:1 —
 * product_registrations is unique per application where is_current (db/026), staff_users
 * and borrowers are by primary key. That is load-bearing: a one-to-many join would multiply
 * the application row and quietly inflate every COUNT and SUM on the dashboard. Do not add
 * a join to a child table (documents, conditions, draws) here — express it as a correlated
 * sub-select in the field's own `sql`, the way open_conditions does.
 */

// ---------------------------------------------------------------------------
// The fixed query surface
// ---------------------------------------------------------------------------

const FROM_SQL = `
  FROM applications a
  LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
  LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
  LEFT JOIN staff_users pc ON pc.id = a.processor_id
  LEFT JOIN borrowers  b  ON b.id  = a.borrower_id`;

/** Soft-deleted files never inflate a figure. On every query, always. */
const BASE_WHERE = `a.deleted_at IS NULL`;

/**
 * "Active file" has ONE definition in this system and it is not ours to invent.
 * Mirrors INACTIVE_FILE_STATUSES / ACTIVE_FILE_SQL in src/routes/staff.js:154-163, so a
 * dashboard's "live pipeline" and the pipeline screen's cannot drift apart.
 */
const INACTIVE_STATUSES = ['funded', 'declined', 'withdrawn', 'on_hold', 'file_intake'];
const ACTIVE_SQL = `a.status NOT IN ('funded','declined','withdrawn','on_hold','file_intake')`;

// The 11 borrower-facing statuses (db/123 CHECK). Kept in step by test-dashboards-pure.js,
// which reads the live CHECK constraint rather than trusting this copy.
const STATUS_OPTIONS = [
  { v: 'file_intake', label: 'File intake' },
  { v: 'new', label: 'Submitted' },
  { v: 'in_review', label: 'In review' },
  { v: 'processing', label: 'Processing' },
  { v: 'underwriting', label: 'Underwriting' },
  { v: 'approved', label: 'Approved' },
  { v: 'clear_to_close', label: 'Clear to close' },
  { v: 'funded', label: 'Funded' },
  { v: 'on_hold', label: 'On hold' },
  { v: 'declined', label: 'Declined' },
  { v: 'withdrawn', label: 'Withdrawn / cancelled' },
];

const PROGRAM_OPTIONS = [
  { v: 'flip', label: 'Fix & flip' },
  { v: 'bridge', label: 'Bridge' },
  { v: 'ground', label: 'Ground-up construction' },
  { v: 'hold', label: 'Fix & hold' },
];

const REGISTERED_PROGRAM_OPTIONS = [
  { v: 'standard', label: 'Standard' },
  { v: 'gold', label: 'Gold Standard' },
  { v: 'silver', label: 'Silver' },
  { v: 'speed', label: 'Speed' },
  { v: 'manual', label: 'Manual / custom' },
];

const PROPERTY_TYPE_OPTIONS = [
  { v: 'sfr', label: 'Single family' },
  { v: 'multi_2_4', label: 'Multi 2–4' },
  { v: 'multi_5_plus', label: 'Multi 5+' },
  { v: 'condo', label: 'Condo' },
  { v: 'townhouse', label: 'Townhouse / PUD' },
  { v: 'mixed_use', label: 'Mixed use' },
];

const REHAB_TYPE_OPTIONS = [
  { v: 'cosmetic', label: 'Cosmetic / light' },
  { v: 'moderate', label: 'Moderate' },
  { v: 'heavy', label: 'Heavy' },
  { v: 'adding_sf', label: 'Adding square footage' },
  { v: 'ground_up', label: 'Ground-up' },
];

const LOAN_TYPE_OPTIONS = [
  { v: 'purchase', label: 'Purchase' },
  { v: 'refinance', label: 'Refinance (any)' },
  { v: 'cash_out', label: 'Refinance — cash out' },
  { v: 'rate_term', label: 'Refinance — rate & term' },
];

const SOURCE_OPTIONS = [
  { v: 'portal', label: 'Borrower portal' },
  { v: 'website_form', label: 'Marketing site' },
  { v: 'termsheet', label: 'Term sheet tool' },
  { v: 'manual', label: 'Entered by staff' },
  { v: 'clickup_backfill', label: 'Imported from ClickUp' },
];

const US_STATES = require('../conditions/field-registry').US_STATES || [];

// ---------------------------------------------------------------------------
// Filter fields — what a person may put a condition on
// ---------------------------------------------------------------------------
// `sql`      the expression, written here, never composed from input
// `type`     drives which operators the builder offers (rules.OPERATORS_BY_TYPE)
// `sparse`   this column is not populated for the whole book — a card built on it
//            reports its coverage so a partial answer can never read as a total
// ---------------------------------------------------------------------------

const FILTER_FIELDS = [
  // ---- Loan & stage ----
  { key: 'status', label: 'Status', group: 'Loan & stage', type: 'enum',
    options: STATUS_OPTIONS, sql: 'a.status' },
  { key: 'internal_status', label: 'ClickUp stage (detailed)', group: 'Loan & stage', type: 'text',
    sql: 'a.internal_status',
    description: 'The exact ClickUp stage. 39 of them roll up into the 11 statuses above.' },
  { key: 'is_active', label: 'Is a live file', group: 'Loan & stage', type: 'boolean',
    sql: `(${ACTIVE_SQL})`,
    description: 'Not funded, declined, withdrawn, on hold or intake — the one definition the pipeline screen uses.' },
  { key: 'program', label: 'Deal type', group: 'Loan & stage', type: 'enum',
    options: PROGRAM_OPTIONS, sql: 'pilot_program_norm(a.program)' },
  { key: 'registered_program', label: 'Priced product', group: 'Loan & stage', type: 'enum',
    options: REGISTERED_PROGRAM_OPTIONS, sql: 'pr.program', sparse: true },
  { key: 'loan_type', label: 'Purchase or refinance', group: 'Loan & stage', type: 'enum',
    options: LOAN_TYPE_OPTIONS,
    // The system's own predicate for "is this a refinance" is a substring test on the
    // free-text label (src/lib/deal-basis.js). Reproduced here so a report and the pricing
    // engine can never disagree about what a refinance is.
    sql: `CASE
            WHEN a.loan_type ~* 'cash.?out' THEN 'cash_out'
            WHEN a.loan_type ~* 'rate' THEN 'rate_term'
            WHEN a.loan_type ~* 'refi' THEN 'refinance'
            ELSE 'purchase' END` },
  { key: 'note_buyer', label: 'Note buyer', group: 'Loan & stage', type: 'text',
    sql: 'a.lender', staffOnly: true,
    description: 'The capital partner. Staff only — never shown to a borrower.' },
  { key: 'term', label: 'Term', group: 'Loan & stage', type: 'text', sql: 'a.term' },
  { key: 'source', label: 'Where it came from', group: 'Loan & stage', type: 'enum',
    options: SOURCE_OPTIONS, sql: `COALESCE(a.source,'portal')` },

  // ---- Property ----
  { key: 'state', label: 'State', group: 'Property', type: 'enum',
    options: US_STATES.map((s) => (typeof s === 'string' ? { v: s, label: s } : s)),
    // pilot_state_norm (db/326) folds "New York" and "NY" together, and is IMMUTABLE, so
    // db/421 can index this exact expression.
    sql: `pilot_state_norm(a.property_address->>'state')` },
  { key: 'city', label: 'City', group: 'Property', type: 'text',
    sql: `a.property_address->>'city'` },
  { key: 'zip', label: 'ZIP', group: 'Property', type: 'text',
    sql: `a.property_address->>'zip'` },
  { key: 'property_type', label: 'Property type', group: 'Property', type: 'enum',
    options: PROPERTY_TYPE_OPTIONS, sql: 'pilot_property_type_norm(a.property_type)' },
  { key: 'units', label: 'Units', group: 'Property', type: 'number', sql: 'a.units' },
  { key: 'year_built', label: 'Year built', group: 'Property', type: 'number',
    sql: 'a.year_built', sparse: true },

  // ---- Money ----
  { key: 'loan_amount', label: 'Loan amount', group: 'Money', type: 'money', sql: 'a.loan_amount' },
  { key: 'purchase_price', label: 'Purchase price', group: 'Money', type: 'money',
    sql: 'a.purchase_price', sparse: true,
    description: 'Deliberately empty on a refinance — that deal is sized on the as-is value.' },
  { key: 'as_is_value', label: 'As-is value', group: 'Money', type: 'money', sql: 'a.as_is_value' },
  { key: 'arv', label: 'After-repair value', group: 'Money', type: 'money', sql: 'a.arv' },
  { key: 'rehab_budget', label: 'Rehab budget', group: 'Money', type: 'money', sql: 'a.rehab_budget' },
  { key: 'is_assignment', label: 'Is an assignment', group: 'Money', type: 'boolean',
    sql: 'COALESCE(a.is_assignment,false)' },

  // ---- Leverage & rate (from the priced record, never the sparse file columns) ----
  { key: 'ltc_pct', label: 'Loan to cost %', group: 'Leverage & rate', type: 'percent',
    sql: `NULLIF(pr.quote->'sizing'->>'ltcPct','')::numeric`, sparse: true },
  { key: 'ltv_pct', label: 'Loan to as-is value %', group: 'Leverage & rate', type: 'percent',
    sql: `NULLIF(pr.quote->'sizing'->>'acqLtvPct','')::numeric`, sparse: true },
  { key: 'arv_pct', label: 'Loan to ARV %', group: 'Leverage & rate', type: 'percent',
    sql: `NULLIF(pr.quote->'sizing'->>'arvPct','')::numeric`, sparse: true },
  { key: 'note_rate', label: 'Rate %', group: 'Leverage & rate', type: 'percent',
    // product_registrations.note_rate is a FRACTION (0.1050). Presented as a percent
    // everywhere a human reads it, so the filter takes a percent too.
    sql: 'pr.note_rate * 100', sparse: true },

  // ---- People ----
  { key: 'loan_officer_id', label: 'Loan officer', group: 'People', type: 'text',
    sql: 'a.loan_officer_id::text', lookup: 'staff' },
  { key: 'has_officer', label: 'Has a loan officer', group: 'People', type: 'boolean',
    sql: '(a.loan_officer_id IS NOT NULL)' },
  { key: 'processor_id', label: 'Processor', group: 'People', type: 'text',
    sql: 'a.processor_id::text', lookup: 'staff' },
  { key: 'underwriter_id', label: 'Underwriter', group: 'People', type: 'text',
    sql: 'a.underwriter_id::text', lookup: 'staff' },
  { key: 'borrower_name', label: 'Borrower name', group: 'People', type: 'text',
    sql: `NULLIF(b.full_name,'')` },

  // ---- Dates ----
  { key: 'created_at', label: 'File created', group: 'Dates', type: 'date', sql: 'a.created_at::date' },
  { key: 'submitted_at', label: 'Application submitted', group: 'Dates', type: 'date',
    sql: 'a.submitted_at::date' },
  { key: 'actual_closing', label: 'Funded (actual closing)', group: 'Dates', type: 'date',
    sql: 'a.actual_closing' },
  { key: 'expected_closing', label: 'Expected closing', group: 'Dates', type: 'date',
    sql: 'a.expected_closing' },
  { key: 'maturity_date', label: 'Maturity', group: 'Dates', type: 'date', sql: 'a.maturity_date' },
  { key: 'updated_at', label: 'Last touched', group: 'Dates', type: 'date', sql: 'a.updated_at::date' },

  // ---- Work & ops ----
  { key: 'days_since_touched', label: 'Days since anyone touched it', group: 'Work', type: 'number',
    sql: `FLOOR(EXTRACT(epoch FROM (now() - a.updated_at)) / 86400.0)` },
  { key: 'days_in_pipeline', label: 'Days since the file opened', group: 'Work', type: 'number',
    // clickup_created_at is the TRUE age on an imported back-book row, whose created_at is
    // the import timestamp, not the intake date (db/055).
    sql: `FLOOR(EXTRACT(epoch FROM (now() - COALESCE(a.clickup_created_at, a.created_at))) / 86400.0)` },
  { key: 'days_to_maturity', label: 'Days to maturity', group: 'Work', type: 'number',
    sql: `(a.maturity_date - CURRENT_DATE)` },
  { key: 'open_conditions', label: 'Open conditions', group: 'Work', type: 'number',
    sql: `(SELECT count(*) FROM checklist_items ci
            WHERE ci.application_id = a.id AND ci.status IN ('outstanding','requested'))` },
  { key: 'conditions_awaiting_review', label: 'Conditions waiting on us', group: 'Work', type: 'number',
    sql: `(SELECT count(*) FROM checklist_items ci
            WHERE ci.application_id = a.id AND ci.status = 'received')` },
  { key: 'conditions_sent_back', label: 'Conditions sent back to the borrower', group: 'Work', type: 'number',
    sql: `(SELECT count(*) FROM checklist_items ci
            WHERE ci.application_id = a.id AND ci.status = 'issue')` },
  { key: 'was_extended', label: 'Has been extended', group: 'Work', type: 'boolean',
    sql: `(a.original_maturity_date IS NOT NULL AND a.maturity_date IS DISTINCT FROM a.original_maturity_date)` },
];

const FIELD_BY_KEY = Object.create(null);
for (const f of FILTER_FIELDS) FIELD_BY_KEY[f.key] = f;

/** The map shape rules.validateRule / summarizeRule expect. */
function fieldMap() {
  return FIELD_BY_KEY;
}

// ---------------------------------------------------------------------------
// Measures — what a card counts
// ---------------------------------------------------------------------------
// `sql`        the aggregate expression
// `coverage`   an expression counting the rows that actually carried a value, so a card
//              built on a partly-populated column can say "based on 214 of 390 files"
//              instead of quietly averaging the half of the book that has data
// ---------------------------------------------------------------------------

const MEASURES = {
  file_count: {
    label: 'Number of files', format: 'count',
    sql: 'COUNT(*)::bigint',
  },
  loan_volume: {
    label: 'Loan volume', format: 'money',
    sql: 'COALESCE(SUM(a.loan_amount),0)::numeric',
    coverage: 'COUNT(a.loan_amount)::bigint',
  },
  avg_loan: {
    label: 'Average loan size', format: 'money',
    sql: 'AVG(a.loan_amount)::numeric',
    coverage: 'COUNT(a.loan_amount)::bigint',
  },
  rehab_total: {
    label: 'Rehab budget total', format: 'money',
    sql: 'COALESCE(SUM(a.rehab_budget),0)::numeric',
    coverage: 'COUNT(a.rehab_budget)::bigint',
  },
  borrower_count: {
    label: 'Number of borrowers', format: 'count',
    sql: 'COUNT(DISTINCT a.borrower_id)::bigint',
  },

  // --- Speed. Median and the slow tail, never the mean: one 400-day zombie file drags
  //     an average into fiction, and the tail is what borrowers actually talk about.
  //
  //     BOTH SIDES ARE COUNTED AS CALENDAR DAYS, and that is the whole point. `actual_closing`
  //     is a DATE and `submitted_at` is an instant; casting the DATE to timestamptz pins it to
  //     00:00 in the SERVER's zone (UTC on Render), so a file submitted at 09:00 on the very
  //     day it closed measured as NEGATIVE — rendered "-0 days" and shown GREEN against the
  //     7-day target, because lower is better. Subtracting two DATEs gives a plain integer of
  //     days and cannot pick up a zone at all. Same reasoning as the time-grain note in
  //     compile.js: never let a zone touch a value that is a calendar date. ---
  days_to_fund_p50: {
    label: 'Days to fund (typical)', format: 'days',
    sql: `percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (a.actual_closing - a.submitted_at::date))
            FILTER (WHERE a.actual_closing IS NOT NULL AND a.submitted_at IS NOT NULL)`,
    coverage: `COUNT(*) FILTER (WHERE a.actual_closing IS NOT NULL AND a.submitted_at IS NOT NULL)::bigint`,
  },
  days_to_fund_p90: {
    label: 'Days to fund (slowest 10%)', format: 'days',
    sql: `percentile_cont(0.9) WITHIN GROUP (
            ORDER BY (a.actual_closing - a.submitted_at::date))
            FILTER (WHERE a.actual_closing IS NOT NULL AND a.submitted_at IS NOT NULL)`,
    coverage: `COUNT(*) FILTER (WHERE a.actual_closing IS NOT NULL AND a.submitted_at IS NOT NULL)::bigint`,
  },
  avg_days_open: {
    label: 'Average days open', format: 'days',
    sql: `AVG(EXTRACT(epoch FROM (now() - COALESCE(a.clickup_created_at, a.created_at))) / 86400.0)`,
  },

  // --- Leverage. Weighted by loan size, and the WEIGHT is only counted where the ratio
  //     exists — otherwise a file with no priced record silently drags the average down. ---
  wavg_ltc: {
    label: 'Weighted average LTC', format: 'percent',
    sql: `SUM(NULLIF(pr.quote->'sizing'->>'ltcPct','')::numeric * a.loan_amount)
          / NULLIF(SUM(a.loan_amount) FILTER (WHERE NULLIF(pr.quote->'sizing'->>'ltcPct','') IS NOT NULL), 0)`,
    coverage: `COUNT(*) FILTER (WHERE NULLIF(pr.quote->'sizing'->>'ltcPct','') IS NOT NULL)::bigint`,
  },
  wavg_ltv: {
    label: 'Weighted average LTV (as-is)', format: 'percent',
    sql: `SUM(NULLIF(pr.quote->'sizing'->>'acqLtvPct','')::numeric * a.loan_amount)
          / NULLIF(SUM(a.loan_amount) FILTER (WHERE NULLIF(pr.quote->'sizing'->>'acqLtvPct','') IS NOT NULL), 0)`,
    coverage: `COUNT(*) FILTER (WHERE NULLIF(pr.quote->'sizing'->>'acqLtvPct','') IS NOT NULL)::bigint`,
  },
  wavg_arv: {
    label: 'Weighted average ARV %', format: 'percent',
    sql: `SUM(NULLIF(pr.quote->'sizing'->>'arvPct','')::numeric * a.loan_amount)
          / NULLIF(SUM(a.loan_amount) FILTER (WHERE NULLIF(pr.quote->'sizing'->>'arvPct','') IS NOT NULL), 0)`,
    coverage: `COUNT(*) FILTER (WHERE NULLIF(pr.quote->'sizing'->>'arvPct','') IS NOT NULL)::bigint`,
  },
  wavg_rate: {
    label: 'Weighted average rate', format: 'percent',
    sql: `SUM(pr.note_rate * 100 * a.loan_amount)
          / NULLIF(SUM(a.loan_amount) FILTER (WHERE pr.note_rate IS NOT NULL), 0)`,
    coverage: `COUNT(*) FILTER (WHERE pr.note_rate IS NOT NULL)::bigint`,
  },

  // --- Ratios. Numerator and denominator over the SAME rows, in one pass. ---
  // `cohort: true` is the warning label: these are timed on the APPLICATION date, so a
  // recent month is still seasoning and will look worse than it will finally be. The card
  // says so; see compile.ratioSelects for why any other shape is wrong.
  pull_through: {
    label: 'Pull-through', format: 'percent', kind: 'ratio', asPercent: true,
    cohort: true, defaultDateField: 'created_at', additive: false,
    numerator: { combinator: 'and', rules: [{ field: 'status', operator: 'eq', value: 'funded' }] },
    denominator: { combinator: 'and',
      rules: [{ field: 'status', operator: 'in', value: ['funded', 'declined', 'withdrawn'] }] },
    note: 'Of the files that reached a decision, the share that funded.',
  },
  fallout_rate: {
    label: 'Fallout', format: 'percent', kind: 'ratio', asPercent: true,
    cohort: true, defaultDateField: 'created_at', additive: false,
    numerator: { combinator: 'and', rules: [{ field: 'status', operator: 'eq', value: 'withdrawn' }] },
    denominator: { combinator: 'and',
      rules: [{ field: 'status', operator: 'in', value: ['funded', 'declined', 'withdrawn'] }] },
    note: 'Deals we had won and then lost — a different problem from a decline.',
  },
  decline_rate: {
    label: 'Decline rate', format: 'percent', kind: 'ratio', asPercent: true,
    cohort: true, defaultDateField: 'created_at', additive: false,
    numerator: { combinator: 'and', rules: [{ field: 'status', operator: 'eq', value: 'declined' }] },
    denominator: { combinator: 'and',
      rules: [{ field: 'status', operator: 'in', value: ['funded', 'declined', 'withdrawn'] }] },
  },
  extension_rate: {
    label: 'Extension rate', format: 'percent', kind: 'ratio', asPercent: true,
    additive: false, defaultDateField: 'actual_closing',
    numerator: { combinator: 'and', rules: [{ field: 'was_extended', operator: 'is_true' }] },
    denominator: { combinator: 'and', rules: [{ field: 'maturity_date', operator: 'not_empty' }] },
    note: 'Loans whose maturity moved. The earliest honest signal that projects are running late.',
  },

  // --- Work ---
  open_conditions_total: {
    label: 'Open conditions', format: 'count',
    sql: `COALESCE(SUM((SELECT count(*) FROM checklist_items ci
                         WHERE ci.application_id = a.id
                           AND ci.status IN ('outstanding','requested'))),0)::bigint`,
  },
  avg_conditions_per_file: {
    label: 'Average conditions per file', format: 'number',
    sql: `AVG((SELECT count(*) FROM checklist_items ci WHERE ci.application_id = a.id))`,
  },
};

// ---------------------------------------------------------------------------
// Dimensions — how a card breaks its number down
// ---------------------------------------------------------------------------

const TIME_GRAINS = {
  month: { label: 'Month', trunc: 'month', fmt: 'YYYY-MM' },
  quarter: { label: 'Quarter', trunc: 'quarter', fmt: 'YYYY-"Q"Q' },
  year: { label: 'Year', trunc: 'year', fmt: 'YYYY' },
  week: { label: 'Week', trunc: 'week', fmt: 'YYYY-MM-DD' },
};

const DIMENSIONS = {
  status: { label: 'Status', sql: 'a.status', options: STATUS_OPTIONS },
  internal_status: { label: 'ClickUp stage', sql: `NULLIF(a.internal_status,'')` },
  program: { label: 'Deal type', sql: 'pilot_program_norm(a.program)', options: PROGRAM_OPTIONS },
  registered_program: { label: 'Priced product', sql: 'pr.program', options: REGISTERED_PROGRAM_OPTIONS },
  property_type: { label: 'Property type', sql: 'pilot_property_type_norm(a.property_type)', options: PROPERTY_TYPE_OPTIONS },
  state: { label: 'State', sql: `pilot_state_norm(a.property_address->>'state')` },
  city: { label: 'City', sql: `a.property_address->>'city'` },
  note_buyer: { label: 'Note buyer', sql: `NULLIF(a.lender,'')`, staffOnly: true },
  loan_officer: { label: 'Loan officer', sql: `NULLIF(lo.full_name,'')` },
  processor: { label: 'Processor', sql: `NULLIF(pc.full_name,'')` },
  source: { label: 'Where it came from', sql: `COALESCE(a.source,'portal')`, options: SOURCE_OPTIONS },
  rehab_type: { label: 'Rehab type', sql: `NULLIF(a.rehab_type,'')` },
  // Aging buckets — the shape the pipeline screen already uses, so the two agree.
  age_bucket: {
    label: 'Age of the file',
    sql: `CASE
            WHEN COALESCE(a.clickup_created_at, a.created_at) > now() - interval '7 days'  THEN '0-7 days'
            WHEN COALESCE(a.clickup_created_at, a.created_at) > now() - interval '14 days' THEN '8-14 days'
            WHEN COALESCE(a.clickup_created_at, a.created_at) > now() - interval '30 days' THEN '15-30 days'
            ELSE '30+ days' END`,
    order: ['0-7 days', '8-14 days', '15-30 days', '30+ days'],
  },
  maturity_bucket: {
    label: 'Maturity',
    sql: `CASE
            WHEN a.maturity_date IS NULL THEN 'No maturity date'
            WHEN a.maturity_date < CURRENT_DATE THEN 'Past maturity'
            WHEN a.maturity_date <= CURRENT_DATE + 30 THEN 'Next 30 days'
            WHEN a.maturity_date <= CURRENT_DATE + 60 THEN '31-60 days'
            WHEN a.maturity_date <= CURRENT_DATE + 90 THEN '61-90 days'
            ELSE 'Beyond 90 days' END`,
    order: ['Past maturity', 'Next 30 days', '31-60 days', '61-90 days', 'Beyond 90 days', 'No maturity date'],
  },
};

// ---------------------------------------------------------------------------
// Date fields — which date a period applies to
// ---------------------------------------------------------------------------

const DATE_FIELDS = {
  actual_closing: { label: 'Funded date', sql: 'a.actual_closing',
    description: 'The actual closing date. This is what funded volume is counted on.' },
  created_at: { label: 'File created', sql: 'a.created_at::date' },
  clickup_created_at: { label: 'File created (true date)', sql: 'COALESCE(a.clickup_created_at, a.created_at)::date' },
  submitted_at: { label: 'Application submitted', sql: 'a.submitted_at::date' },
  expected_closing: { label: 'Expected closing', sql: 'a.expected_closing' },
  maturity_date: { label: 'Maturity', sql: 'a.maturity_date' },
  status_changed_at: { label: 'Status last changed', sql: 'a.status_changed_at::date' },
  updated_at: { label: 'Last touched', sql: 'a.updated_at::date' },
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** The catalogue the builder UI renders, in the shape RuleBuilder already expects. */
function meta({ staff = true } = {}) {
  const rules = require('../conditions/rules');
  const visible = (f) => (staff ? true : !f.staffOnly);
  return {
    fields: FILTER_FIELDS.filter(visible).map((f) => ({
      key: f.key, label: f.label, group: f.group, type: f.type,
      options: f.options || undefined, description: f.description || undefined,
      sparse: f.sparse || undefined, lookup: f.lookup || undefined,
    })),
    operators: rules.OPERATORS_BY_TYPE,
    operatorLabels: rules.OPERATOR_LABEL,
    measures: Object.entries(MEASURES).map(([k, m]) => ({ key: k, label: m.label, format: m.format })),
    dimensions: Object.entries(DIMENSIONS)
      .filter(([, d]) => (staff ? true : !d.staffOnly))
      .map(([k, d]) => ({ key: k, label: d.label })),
    dateFields: Object.entries(DATE_FIELDS).map(([k, d]) => ({ key: k, label: d.label, description: d.description })),
    timeGrains: Object.entries(TIME_GRAINS).map(([k, g]) => ({ key: k, label: g.label })),
  };
}

module.exports = {
  FROM_SQL, BASE_WHERE, ACTIVE_SQL, INACTIVE_STATUSES,
  FILTER_FIELDS, FIELD_BY_KEY, fieldMap,
  MEASURES, DIMENSIONS, DATE_FIELDS, TIME_GRAINS,
  STATUS_OPTIONS, PROGRAM_OPTIONS, PROPERTY_TYPE_OPTIONS,
  meta, has,
};
