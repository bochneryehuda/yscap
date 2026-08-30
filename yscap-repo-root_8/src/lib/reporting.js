'use strict';
/**
 * THE REPORTING DATABASE (owner-directed 2026-08-28): "We need to work on a
 * reporting database that I can go in like an Encompass … where I can select
 * the fields I want, filter which files should be included, save the report …
 * export to excel. Massive reporting database available for the admin super
 * admin back office."
 *
 * HOW ENCOMPASS DOES IT, AND WHY THIS COPIES THAT SHAPE. Encompass's Reporting
 * Database is not "SQL for loan officers" — it is a CURATED FIELD DICTIONARY
 * over the loan pipeline plus a filter grammar (field / operator / value rows,
 * AND-combined), a column picker, and saved report definitions. The person
 * building a report never names a table or types an expression; they pick
 * fields the dictionary offers, and every filter value is data, never code.
 * That is exactly the safe shape for a query screen an admin drives:
 *
 *   1. REPORT_FIELDS is the dictionary — the ONLY fields a report can filter
 *      on, show, or sort by. Each entry carries the SQL expression over ONE
 *      fixed join (below), its display type, and its group. A key the catalog
 *      does not carry is REFUSED — a client can never smuggle an expression.
 *   2. Every value is BOUND ($n), never interpolated. The operators are a
 *      per-type whitelist; an operator a type does not support is refused.
 *   3. The compiled query is always the same statement shape:
 *      SELECT <catalog columns> FROM <the one join> WHERE <base scope> AND
 *      <compiled filters> ORDER BY <catalog sort> LIMIT <capped>.
 *
 * ONE JOIN, EVERY REPORT. `FROM_SQL` is the whole reporting surface: the file
 * (a), its borrowers (b, cb), the vesting entity (l), the team (lo/pr/uw), the
 * CURRENT product registration (reg — LATERAL, newest is_current row), and the
 * closing workflow (cw). All LEFT joins, so a file missing any of them still
 * reports. Soft-deleted files are excluded ALWAYS (the base scope) — a deleted
 * file in a business report is a wrong answer, and no filter may re-admit one.
 *
 * SINGLE-DEFINITION DISCIPLINE: the deal FICO is credit.dealFicoSql (the ONE
 * definition of the two-borrower middle-score rule), the address haystack is
 * file-search.ADDRESS_TEXT_SQL (both storage spellings), and the LIKE escaping
 * is file-search.likeParam — never a re-inlined copy of any of them.
 *
 * RTL ONLY. The join reads `applications` — the RTL table. Long-Term has its
 * own tables and does not appear here (product-separation rule 4).
 */
const db = require('../db');
const credit = require('./credit');
const fileSearch = require('./file-search');

/** A user-facing report problem — the route answers 400 with the message. */
class ReportError extends Error {
  constructor(msg) { super(msg); this.status = 400; this.expose = true; }
}

/* Row caps. `DEFAULT_ROWS` is what a run returns unasked; `MAX_ROWS` is the
   hard ceiling for both the screen and the Excel export. The response says
   when it capped (no silent caps). */
const DEFAULT_ROWS = 500;
const MAX_ROWS = 5000;

/* The one join every report runs over. Aliases are part of the catalog's
   contract — a field's `sql` may reference exactly these. */
const FROM_SQL = `
  FROM applications a
  LEFT JOIN borrowers b   ON b.id  = a.borrower_id
  LEFT JOIN borrowers cb  ON cb.id = a.co_borrower_id
  LEFT JOIN llcs l        ON l.id  = a.llc_id
  LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
  LEFT JOIN staff_users pr ON pr.id = a.processor_id
  LEFT JOIN staff_users uw ON uw.id = a.underwriter_id
  LEFT JOIN closing_workflow cw ON cw.application_id = a.id
  LEFT JOIN tpo_firms tf  ON tf.id = a.tpo_firm_id
  LEFT JOIN LATERAL (
    SELECT r2.* FROM product_registrations r2
     WHERE r2.application_id = a.id AND r2.is_current = true
     ORDER BY r2.created_at DESC LIMIT 1
  ) reg ON true`;

/* Files a business report is ABOUT: never a soft-deleted row. */
const BASE_SCOPE = 'a.deleted_at IS NULL';

/* The canonical file statuses, for the status picker (display convenience —
   an unknown value still filters fine as bound text). */
const FILE_STATUSES = [
  'file_intake', 'processing', 'underwriting', 'appraisal', 'approved',
  'clear_to_close', 'funded', 'on_hold', 'declined', 'withdrawn',
];

const F = (key, label, group, type, sql, extra) => ({ key, label, group, type, sql, ...(extra || {}) });

/**
 * THE FIELD DICTIONARY. Groups mirror how the team talks about a file. Types:
 * text | enum | money | number | pct | date | timestamp | boolean.
 * Every `sql` is a read over the FROM_SQL aliases — nothing here writes.
 */
const REPORT_FIELDS = [
  // ── File ───────────────────────────────────────────────────────────────
  F('ys_loan_number', 'Loan number', 'File', 'text', 'a.ys_loan_number'),
  F('file_status', 'File status', 'File', 'enum', 'a.status', { options: FILE_STATUSES, facet: true }),
  F('internal_status', 'Internal status (ClickUp)', 'File', 'text', 'a.internal_status', { facet: true }),
  F('source', 'File source', 'File', 'text', 'a.source', { facet: true }),
  F('channel', 'Channel', 'File', 'text', 'a.channel', { facet: true }),
  F('tpo_firm', 'Broker firm (TPO)', 'File', 'text', 'tf.name', { facet: true }),
  F('clickup_created_at', 'ClickUp card created', 'File', 'timestamp', 'a.clickup_created_at'),
  F('is_tpo', 'Broker (TPO) file', 'File', 'boolean', 'a.is_tpo'),
  F('created_at', 'File created', 'File', 'timestamp', 'a.created_at'),
  F('submitted_at', 'Application submitted', 'File', 'timestamp', 'a.submitted_at'),
  F('open_conditions', 'Open required conditions', 'File', 'number',
    `(SELECT count(*)::int FROM checklist_items ci
       WHERE ci.application_id = a.id AND ci.is_required = true
         AND ci.status <> 'satisfied' AND ci.signed_off_at IS NULL AND ci.waived_at IS NULL)`),

  // ── Borrower ───────────────────────────────────────────────────────────
  F('borrower_name', 'Borrower', 'Borrower', 'text', "NULLIF(b.full_name,'')"),
  F('borrower_email', 'Borrower email', 'Borrower', 'text', 'b.email::text'),
  F('borrower_phone', 'Borrower phone', 'Borrower', 'text', 'b.cell_phone'),
  F('borrower_fico', 'Borrower FICO', 'Borrower', 'number', 'b.fico'),
  // The ONE deal-FICO rule: one borrower = the middle score; two = the higher
  // of the two middle scores (credit.dealFicoSql — never re-inlined).
  F('deal_fico', 'Deal FICO (higher middle)', 'Borrower', 'number', credit.dealFicoSql('b', 'cb')),
  F('co_borrower_name', 'Co-borrower', 'Borrower', 'text', "NULLIF(cb.full_name,'')"),
  F('co_borrower_fico', 'Co-borrower FICO', 'Borrower', 'number', 'cb.fico'),
  F('entity_name', 'Vesting entity', 'Borrower', 'text', 'l.llc_name', { facet: true }),

  // ── Property ───────────────────────────────────────────────────────────
  F('property_address', 'Property address', 'Property', 'text', fileSearch.ADDRESS_TEXT_SQL('a')),
  F('property_city', 'Property city', 'Property', 'text', "a.property_address->>'city'", { facet: true }),
  F('property_state', 'Property state', 'Property', 'text', "a.property_address->>'state'", { facet: true }),
  F('property_zip', 'Property ZIP', 'Property', 'text', "a.property_address->>'zip'"),
  F('property_type', 'Property type', 'Property', 'text', 'a.property_type', { facet: true }),
  F('units', 'Units', 'Property', 'number', 'a.units'),
  F('occupancy', 'Occupancy', 'Property', 'text', 'a.occupancy', { facet: true }),
  F('sqft_pre', 'Sq ft (before)', 'Property', 'number', 'a.sqft_pre'),
  F('sqft_post', 'Sq ft (after)', 'Property', 'number', 'a.sqft_post'),
  F('year_built', 'Year built', 'Property', 'number', 'a.year_built'),

  // ── Deal & pricing ─────────────────────────────────────────────────────
  F('program', 'Program (file)', 'Deal & pricing', 'text', 'a.program', { facet: true }),
  F('registered_program', 'Program (registered)', 'Deal & pricing', 'text', 'reg.program', { facet: true }),
  F('product_label', 'Product (registered)', 'Deal & pricing', 'text', 'reg.product_label', { facet: true }),
  F('loan_type', 'Loan purpose', 'Deal & pricing', 'text', 'a.loan_type', { facet: true }),
  F('rehab_type', 'Rehab type', 'Deal & pricing', 'text', 'a.rehab_type', { facet: true }),
  F('loan_amount', 'Loan amount', 'Deal & pricing', 'money', 'a.loan_amount'),
  F('registered_loan', 'Registered loan', 'Deal & pricing', 'money', 'reg.total_loan'),
  F('note_rate', 'Note rate (registered)', 'Deal & pricing', 'pct', 'reg.note_rate'),
  F('rate_pct', 'Rate (file)', 'Deal & pricing', 'pct', 'a.rate_pct'),
  F('purchase_price', 'Purchase price', 'Deal & pricing', 'money', 'a.purchase_price'),
  F('as_is_value', 'As-is value', 'Deal & pricing', 'money', 'a.as_is_value'),
  F('arv', 'ARV', 'Deal & pricing', 'money', 'a.arv'),
  F('rehab_budget', 'Rehab budget', 'Deal & pricing', 'money', 'a.rehab_budget'),
  F('ltv', 'LTV', 'Deal & pricing', 'pct', 'a.ltv'),
  F('dscr_ratio', 'DSCR', 'Deal & pricing', 'number', 'a.dscr_ratio'),
  F('term', 'Term', 'Deal & pricing', 'text', 'a.term', { facet: true }),
  F('accrual_type', 'Accrual type', 'Deal & pricing', 'text', 'a.accrual_type', { facet: true }),
  F('requested_ir_months', 'Interest reserve (months)', 'Deal & pricing', 'number', 'a.requested_ir_months'),
  F('deferred_orig_pct', 'Deferred origination %', 'Deal & pricing', 'pct', 'a.deferred_orig_pct'),
  F('is_assignment', 'Assignment of contract', 'Deal & pricing', 'boolean', 'a.is_assignment'),
  F('assignment_fee', 'Assignment fee', 'Deal & pricing', 'money', 'a.assignment_fee'),
  F('payoff_amount', 'Payoff amount', 'Deal & pricing', 'money', 'a.payoff_amount'),
  F('estimated_cash_out', 'Estimated cash-out', 'Deal & pricing', 'money', 'a.estimated_cash_out'),
  F('verified_cash_out', 'Verified cash-out', 'Deal & pricing', 'money', 'a.verified_cash_out'),
  F('existing_debt', 'Existing debt', 'Deal & pricing', 'money', 'a.existing_debt'),
  F('first_lien', 'First lien', 'Deal & pricing', 'money', 'a.first_lien'),
  F('second_lien', 'Second lien', 'Deal & pricing', 'money', 'a.second_lien'),
  F('financed_rehab_budget', 'Financed rehab budget', 'Deal & pricing', 'money', 'a.financed_rehab_budget'),
  F('original_purchase_price', 'Original purchase price', 'Deal & pricing', 'money', 'a.original_purchase_price'),
  F('rental_income', 'Rental income', 'Deal & pricing', 'money', 'a.rental_income'),
  F('property_taxes', 'Property taxes', 'Deal & pricing', 'money', 'a.property_taxes'),
  F('property_insurance', 'Property insurance', 'Deal & pricing', 'money', 'a.property_insurance'),
  F('payoff_lender', 'Payoff lender (refi)', 'Deal & pricing', 'text', 'a.payoff_lender', { facet: true }),
  F('registration_status', 'Registration status', 'Deal & pricing', 'text', 'reg.status', { facet: true }),
  F('registration_stale', 'Registration needs re-pricing', 'Deal & pricing', 'boolean', 'reg.stale'),
  F('registration_needs_approval', 'Registration awaiting approval', 'Deal & pricing', 'boolean', 'reg.needs_approval'),
  F('asset_months', 'Reserve months (manual)', 'Deal & pricing', 'number', 'reg.asset_months'),
  F('is_manual_product', 'Manual product', 'Deal & pricing', 'boolean', 'reg.is_manual'),
  F('registered_at', 'Registered on', 'Deal & pricing', 'timestamp', 'reg.created_at'),

  // ── Dates ──────────────────────────────────────────────────────────────
  F('expected_closing', 'Expected closing (confirmed)', 'Dates', 'date', 'a.expected_closing'),
  F('est_closing_date', 'Estimated closing (term sheet)', 'Dates', 'date', 'a.est_closing_date'),
  // The same confirmed-else-estimate resolution the pipeline's closing-range
  // filter and closing prep use.
  F('expected_closing_any', 'Expected closing (any)', 'Dates', 'date', 'COALESCE(a.expected_closing, a.est_closing_date)'),
  F('actual_closing', 'Actual closing', 'Dates', 'date', 'a.actual_closing'),
  F('funded_date', 'Funded date', 'Dates', 'date', 'a.funded_date'),
  F('sold_at', 'Sold date', 'Dates', 'date', 'a.sold_at'),
  F('purchase_advice_date', 'Purchase advice date', 'Dates', 'date', 'a.purchase_advice_date'),
  F('first_payment_date', 'First payment date', 'Dates', 'date', 'a.first_payment_date'),
  F('maturity_date', 'Maturity date', 'Dates', 'date', 'a.maturity_date'),
  F('status_changed_at', 'Status last changed', 'Dates', 'timestamp', 'a.status_changed_at'),
  F('payoff_date', 'Payoff date', 'Dates', 'date', 'a.payoff_date'),
  F('acquisition_date', 'Property acquired (refi seasoning)', 'Dates', 'date', 'a.acquisition_date'),

  // ── Team ───────────────────────────────────────────────────────────────
  F('loan_officer', 'Loan officer', 'Team', 'text', 'lo.full_name', { facet: true }),
  F('processor', 'Processor', 'Team', 'text', 'pr.full_name', { facet: true }),
  F('underwriter', 'Underwriter', 'Team', 'text', 'uw.full_name', { facet: true }),

  // ── Investor & closing ─────────────────────────────────────────────────
  // STAFF-ONLY by nature (the note buyer) — this whole surface is admin-gated
  // and none of it ever reaches a borrower.
  F('investor', 'Investor (note buyer)', 'Investor & closing', 'text', 'a.lender', { facet: true }),
  F('investor_loan_number', 'Investor loan number', 'Investor & closing', 'text', 'a.investor_loan_number'),
  F('closing_handling', 'Closing handling (file override)', 'Investor & closing', 'enum', 'a.closing_handling',
    { options: ['internal', 'attorney', 'lender_direct'] }),
  F('warehouse', 'Warehouse / funding line', 'Investor & closing', 'text', 'cw.warehouse', { facet: true }),
  F('closing_stage', 'Closing stage', 'Investor & closing', 'text', 'cw.stage', { facet: true }),
  F('investor_ctc', 'Investor CTC received', 'Investor & closing', 'boolean', 'cw.investor_ctc'),
  F('wire_sent_at', 'Wire sent', 'Investor & closing', 'timestamp', 'cw.wire_sent_at'),
  F('fully_closed_at', 'Fully closed', 'Investor & closing', 'timestamp', 'cw.fully_closed_at'),
  F('actual_cash_to_close', 'Actual cash to close', 'Investor & closing', 'money', 'cw.actual_cash_to_close'),
  F('liquidity_ok', 'Liquidity verified', 'Investor & closing', 'boolean', 'cw.liquidity_ok'),
  F('table_funded', 'Table funded', 'Investor & closing', 'boolean', 'cw.table_funded'),
  F('title_company', 'Title company', 'Investor & closing', 'text', 'a.title_company', { facet: true }),
  F('insurance_company', 'Insurance company', 'Investor & closing', 'text', 'a.insurance_company', { facet: true }),
  F('flood_zone_override', 'Flood zone (manual flag)', 'Investor & closing', 'boolean', 'a.flood_zone_override'),
];

const BY_KEY = new Map(REPORT_FIELDS.map((f) => [f.key, f]));

/* The per-type operator whitelist — the whole filter grammar. */
const NUM_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'];
const DATE_OPS = ['on', 'before', 'after', 'between', 'is_empty', 'not_empty'];
const OPS_BY_TYPE = {
  text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'is_empty', 'not_empty'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'not_empty'],
  money: NUM_OPS, number: NUM_OPS, pct: NUM_OPS,
  date: DATE_OPS, timestamp: DATE_OPS,
  boolean: ['is_true', 'is_false'],
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function coerceValue(field, raw, what) {
  if (field.type === 'money' || field.type === 'number' || field.type === 'pct') {
    const n = Number(raw);
    if (!isFinite(n)) throw new ReportError(`"${field.label}" needs a number ${what}`);
    return n;
  }
  if (field.type === 'date' || field.type === 'timestamp') {
    const s = String(raw == null ? '' : raw).trim().slice(0, 10);
    if (!DAY_RE.test(s)) throw new ReportError(`"${field.label}" needs a date (YYYY-MM-DD) ${what}`);
    return s;
  }
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new ReportError(`"${field.label}" needs a value ${what}`);
  return s.slice(0, 200);
}

function pairOf(field, raw) {
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw.from, raw.to] : null);
  if (!arr || arr.length !== 2) throw new ReportError(`"${field.label}": "between" needs two values`);
  return [coerceValue(field, arr[0], '(from)'), coerceValue(field, arr[1], '(to)')];
}

/**
 * Compile ONE filter row into SQL + bound params. `params` is the shared bind
 * array — positions are computed from its live length, values only ever pushed.
 */
function compileFilter(row, params) {
  if (!row || typeof row !== 'object') throw new ReportError('a filter row is malformed');
  const field = BY_KEY.get(String(row.field || ''));
  if (!field) throw new ReportError(`unknown report field "${String(row.field || '')}"`);
  const op = String(row.op || '');
  if (!OPS_BY_TYPE[field.type].includes(op)) {
    throw new ReportError(`"${field.label}" does not support the "${op}" filter`);
  }
  const e = field.sql;
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const isText = field.type === 'text' || field.type === 'enum';

  switch (op) {
    case 'is_empty': return isText ? `NULLIF((${e})::text,'') IS NULL` : `(${e}) IS NULL`;
    case 'not_empty': return isText ? `NULLIF((${e})::text,'') IS NOT NULL` : `(${e}) IS NOT NULL`;
    case 'is_true': return `(${e}) IS TRUE`;
    case 'is_false': return `(${e}) IS NOT TRUE`;
    case 'eq':
      return isText
        ? `LOWER(COALESCE((${e})::text,'')) = LOWER(${bind(coerceValue(field, row.value, 'to compare against'))})`
        : `(${e}) = ${bind(coerceValue(field, row.value, 'to compare against'))}`;
    case 'neq':
      return isText
        ? `LOWER(COALESCE((${e})::text,'')) <> LOWER(${bind(coerceValue(field, row.value, 'to compare against'))})`
        : `((${e}) IS DISTINCT FROM ${bind(coerceValue(field, row.value, 'to compare against'))})`;
    case 'contains': case 'not_contains': {
      // ONE definition of LIKE escaping (a typed % or _ is a literal).
      const p = fileSearch.likeParam(coerceValue(field, row.value, 'to search for'), { min: 1 });
      if (!p) throw new ReportError(`"${field.label}" needs text to search for`);
      const c = `COALESCE((${e})::text,'') ILIKE ${bind(p)}`;
      return op === 'contains' ? c : `NOT (${c})`;
    }
    case 'starts_with': {
      const v = coerceValue(field, row.value, 'to search for').replace(/([\\%_])/g, '\\$1');
      return `COALESCE((${e})::text,'') ILIKE ${bind(v + '%')}`;
    }
    case 'in': case 'not_in': {
      const raw = Array.isArray(row.value) ? row.value : String(row.value || '').split(',');
      const vals = raw.map((v) => String(v == null ? '' : v).trim()).filter(Boolean).slice(0, 100);
      if (!vals.length) throw new ReportError(`"${field.label}" needs at least one value`);
      const c = `LOWER(COALESCE((${e})::text,'')) = ANY(SELECT LOWER(x) FROM unnest(${bind(vals)}::text[]) x)`;
      return op === 'in' ? c : `NOT (${c})`;
    }
    case 'gt': return `(${e}) > ${bind(coerceValue(field, row.value, 'to compare against'))}`;
    case 'gte': return `(${e}) >= ${bind(coerceValue(field, row.value, 'to compare against'))}`;
    case 'lt': return `(${e}) < ${bind(coerceValue(field, row.value, 'to compare against'))}`;
    case 'lte': return `(${e}) <= ${bind(coerceValue(field, row.value, 'to compare against'))}`;
    case 'on': return `(${e})::date = ${bind(coerceValue(field, row.value, 'to compare against'))}::date`;
    case 'before': return `(${e})::date < ${bind(coerceValue(field, row.value, 'to compare against'))}::date`;
    case 'after': return `(${e})::date > ${bind(coerceValue(field, row.value, 'to compare against'))}::date`;
    case 'between': {
      const [lo2, hi] = pairOf(field, row.value);
      if (field.type === 'date' || field.type === 'timestamp') {
        return `(${e})::date BETWEEN ${bind(lo2)}::date AND ${bind(hi)}::date`;
      }
      return `(${e}) BETWEEN ${bind(lo2)} AND ${bind(hi)}`;
    }
    default: throw new ReportError(`unsupported filter "${op}"`); // unreachable — the whitelist gates first
  }
}

/* The totals (summarize) grammar: which aggregations exist, and which types
   they may run over. `count` needs no field; everything else needs a numeric
   one — averaging a city is not a thing anyone means. */
const METRIC_FNS = { count: 'count', sum: 'sum', avg: 'avg', min: 'min', max: 'max' };
const NUMERIC_TYPES = new Set(['money', 'number', 'pct']);

function normalizeSummarize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const groupBy = (Array.isArray(raw.groupBy) ? raw.groupBy : [raw.groupBy])
    .map((k) => String(k || '')).filter((k) => BY_KEY.has(k));
  if (!groupBy.length) return null;
  if (groupBy.length > 2) throw new ReportError('totals can group by at most two fields');
  const metrics = [];
  for (const m of (Array.isArray(raw.metrics) ? raw.metrics.slice(0, 6) : [])) {
    const fn = METRIC_FNS[String(m && m.fn || '').toLowerCase()];
    if (!fn) throw new ReportError(`unknown total "${String(m && m.fn || '')}"`);
    if (fn === 'count') { metrics.push({ fn: 'count' }); continue; }
    const f = BY_KEY.get(String(m.field || ''));
    if (!f) throw new ReportError(`unknown report field "${String(m && m.field || '')}" in a total`);
    if (!NUMERIC_TYPES.has(f.type)) {
      throw new ReportError(`"${f.label}" is not a number — a ${fn} total needs a money or number field`);
    }
    metrics.push({ fn, field: f.key });
  }
  if (!metrics.length) metrics.push({ fn: 'count' });
  return { groupBy: [...new Set(groupBy)], metrics };
}

function metricLabel(m) {
  if (m.fn === 'count') return 'Files';
  const f = BY_KEY.get(m.field);
  const fnWord = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' }[m.fn] || m.fn;
  return `${fnWord} ${f ? f.label.toLowerCase() : m.field}`;
}

/** Validate + normalize a whole definition. Throws ReportError on anything off.
 *
 * FILTER SHAPE — two accepted spellings, one meaning:
 *   filters: [row, …]              — the layer-1 shape: ONE group, all ANDed.
 *   groups:  [[row, …], [row, …]]  — layer 2 (owner-directed 2026-08-29
 *            "or-logic"): rows AND within a group, groups OR'd together —
 *            the HubSpot/Metabase filter-group shape, which reads naturally
 *            ("all of these… OR all of those…") where free-form parentheses
 *            do not. Every saved layer-1 report normalizes losslessly.
 */
function normalizeDefinition(def) {
  const d = def && typeof def === 'object' ? def : {};
  let groups = [];
  if (Array.isArray(d.groups)) {
    groups = d.groups.slice(0, 10)
      .map((g) => (Array.isArray(g) ? g : (g && Array.isArray(g.filters) ? g.filters : [])))
      .map((g) => g.slice(0, 20))
      .filter((g) => g.length);
  } else if (Array.isArray(d.filters) && d.filters.length) {
    groups = [d.filters.slice(0, 40)];
  }
  const filters = Array.isArray(d.filters) ? d.filters.slice(0, 40) : [];
  let columns = Array.isArray(d.columns) ? d.columns.map((k) => String(k || '')).filter((k) => BY_KEY.has(k)) : [];
  columns = [...new Set(columns)].slice(0, 60);
  if (!columns.length) columns = ['ys_loan_number', 'borrower_name', 'property_address', 'file_status', 'loan_amount', 'loan_officer'];
  let sort = null;
  if (d.sort && typeof d.sort === 'object' && BY_KEY.has(String(d.sort.field || ''))) {
    sort = { field: String(d.sort.field), dir: String(d.sort.dir).toLowerCase() === 'desc' ? 'desc' : 'asc' };
  }
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(d.limit) || DEFAULT_ROWS));
  const summarize = normalizeSummarize(d.summarize);
  return { filters, groups, columns, sort, limit, summarize };
}

/** Compile a definition into ONE ready-to-run statement. */
function compileWhere(d, params) {
  const where = [BASE_SCOPE];
  const groupSql = d.groups
    .map((g) => g.map((row) => compileFilter(row, params)).join('\n        AND '))
    .filter(Boolean);
  if (groupSql.length === 1) where.push(groupSql[0]);
  else if (groupSql.length > 1) where.push('(' + groupSql.map((g) => `(${g})`).join('\n       OR ') + ')');
  return where;
}

function compileReport(def) {
  const d = normalizeDefinition(def);
  const params = [];
  const where = compileWhere(d, params);
  const cols = d.columns.map((k) => `(${BY_KEY.get(k).sql}) AS "${k}"`).join(', ');
  const order = d.sort
    ? `(${BY_KEY.get(d.sort.field).sql}) ${d.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, a.created_at DESC`
    : 'a.created_at DESC';
  const sql = `SELECT a.id AS "_id", ${cols}, count(*) OVER () AS "_total"
    ${FROM_SQL}
    WHERE ${where.join('\n      AND ')}
    ORDER BY ${order}
    LIMIT ${d.limit + 1}`;
  return { sql, params, def: d };
}

/** THE TOTALS RUN — group the matching files and aggregate. Same join, same
    compiled WHERE, so the totals can never disagree with the row run about
    which files are in the report. */
async function runSummary(def, client = db) {
  const d = normalizeDefinition(def);
  if (!d.summarize) throw new ReportError('totals need at least one group-by field');
  const params = [];
  const where = compileWhere(d, params);
  const gb = d.summarize.groupBy.map((k, i) => `(${BY_KEY.get(k).sql}) AS "g${i}"`);
  const gbRefs = d.summarize.groupBy.map((_, i) => String(i + 1));
  const ms = d.summarize.metrics.map((m, i) => {
    // avg is ROUNDED in SQL — a 16-decimal average on a money column reads as
    // noise on the screen and in the export alike.
    const expr = m.fn === 'count' ? 'count(*)::int'
      : m.fn === 'avg' ? `round(avg((${BY_KEY.get(m.field).sql})::numeric), 2)`
        : `${m.fn}((${BY_KEY.get(m.field).sql})::numeric)`;
    return `${expr} AS "m${i}"`;
  });
  const sql = `SELECT ${[...gb, ...ms].join(', ')}, count(*) OVER () AS "_total"
    ${FROM_SQL}
    WHERE ${where.join('\n      AND ')}
    GROUP BY ${gbRefs.join(', ')}
    ORDER BY "m0" DESC NULLS LAST, 1 ASC
    LIMIT 1001`;
  const r = await client.query(sql, params);
  const total = r.rows.length ? Number(r.rows[0]._total) : 0;
  const capped = r.rows.length > 1000;
  return {
    mode: 'summary',
    groupBy: d.summarize.groupBy.map((k, i) => {
      const f = BY_KEY.get(k);
      return { key: `g${i}`, field: f.key, label: f.label, type: f.type };
    }),
    metrics: d.summarize.metrics.map((m, i) => ({
      key: `m${i}`, fn: m.fn, field: m.field || null,
      label: metricLabel(m), type: m.fn === 'count' ? 'number' : BY_KEY.get(m.field).type,
    })),
    rows: r.rows.slice(0, 1000).map((row) => { const o = { ...row }; delete o._total; return o; }),
    total, capped,
  };
}

/** THE VALUE DROPDOWN (owner-directed 2026-08-29: "it should come up with a
    dropdown of those fields everywhere") — the DISTINCT values a faceted field
    actually holds across active files, busiest first, so a filter is picked
    off the live data instead of typed from memory. Faceted fields only: a
    free-form field (an address, an email) has no useful value list. */
async function distinctValues(fieldKey, client = db) {
  const f = BY_KEY.get(String(fieldKey || ''));
  if (!f) throw new ReportError(`unknown report field "${String(fieldKey || '')}"`);
  if (!f.facet && !f.options) throw new ReportError(`"${f.label}" has no value list — type the value`);
  if (f.options) return { values: f.options.map((v) => ({ v, n: null })), truncated: false };
  const r = await client.query(
    `SELECT NULLIF((${f.sql})::text,'') AS v, count(*)::int AS n
      ${FROM_SQL}
      WHERE ${BASE_SCOPE} AND NULLIF((${f.sql})::text,'') IS NOT NULL
      GROUP BY 1 ORDER BY n DESC, 1 ASC LIMIT 201`);
  return { values: r.rows.slice(0, 200), truncated: r.rows.length > 200 };
}

/** Run a report. Returns {columns:[{key,label,type}], rows:[{...}], total, capped}.
    A definition carrying `summarize` runs the TOTALS shape instead. */
async function runReport(def, client = db) {
  const dd = normalizeDefinition(def);
  if (dd.summarize) return runSummary(dd, client);
  const { sql, params, def: d } = compileReport(dd);
  const r = await client.query(sql, params);
  const total = r.rows.length ? Number(r.rows[0]._total) : 0;
  const capped = r.rows.length > d.limit;
  const rows = r.rows.slice(0, d.limit).map((row) => {
    const out = { _id: row._id };
    for (const k of d.columns) out[k] = row[k];
    return out;
  });
  return {
    columns: d.columns.map((k) => {
      const f = BY_KEY.get(k);
      return { key: f.key, label: f.label, type: f.type };
    }),
    rows, total, capped, limit: d.limit,
  };
}

/* ── display formatting (shared by the screen contract + the Excel export) ── */
function cellValue(field, v) {
  if (v == null) return '';
  if (field.type === 'boolean') return v === true ? 'Yes' : 'No';
  if (field.type === 'money' || field.type === 'number' || field.type === 'pct') {
    const n = Number(v);
    return isFinite(n) ? n : String(v);
  }
  if (field.type === 'timestamp') return String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  if (field.type === 'date') return String(v).slice(0, 10);
  return String(v);
}

/** The Excel export — one sheet, a label header row, then the data. */
function buildReportXlsx(result, { name = 'Report' } = {}) {
  const { buildXlsx } = require('./xlsx');
  if (result.mode === 'summary') {
    const cols = [...result.groupBy, ...result.metrics];
    const rows = [cols.map((c) => c.label)];
    for (const row of result.rows) {
      rows.push(cols.map((c) => cellValue(BY_KEY.get(c.field) || { type: c.type }, row[c.key])));
    }
    return buildXlsx(rows, String(name).slice(0, 31) || 'Report');
  }
  const fields = result.columns.map((c) => BY_KEY.get(c.key));
  const rows = [result.columns.map((c) => c.label)];
  for (const row of result.rows) rows.push(fields.map((f) => cellValue(f, row[f.key])));
  return buildXlsx(rows, String(name).slice(0, 31) || 'Report');
}

/** The dictionary as the client sees it (no SQL — expressions stay server-side). */
function catalog() {
  return REPORT_FIELDS.map((f) => ({
    key: f.key, label: f.label, group: f.group, type: f.type,
    ops: OPS_BY_TYPE[f.type], options: f.options || null,
    facet: !!(f.facet || f.options), numeric: NUMERIC_TYPES.has(f.type),
  }));
}

module.exports = {
  ReportError, REPORT_FIELDS, OPS_BY_TYPE, DEFAULT_ROWS, MAX_ROWS,
  catalog, normalizeDefinition, compileReport, runReport, runSummary,
  distinctValues, buildReportXlsx,
  _internals: { compileFilter, compileWhere, coerceValue, cellValue, metricLabel, FROM_SQL, BASE_SCOPE },
};
