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
  F('file_status', 'File status', 'File', 'enum', 'a.status', { options: FILE_STATUSES }),
  F('internal_status', 'Internal status (ClickUp)', 'File', 'text', 'a.internal_status'),
  F('source', 'File source', 'File', 'text', 'a.source'),
  F('is_tpo', 'Broker (TPO) file', 'File', 'boolean', 'a.is_tpo'),
  F('created_at', 'File created', 'File', 'timestamp', 'a.created_at'),
  F('submitted_at', 'Application submitted', 'File', 'timestamp', 'a.submitted_at'),

  // ── Borrower ───────────────────────────────────────────────────────────
  F('borrower_name', 'Borrower', 'Borrower', 'text', "NULLIF(b.full_name,'')"),
  F('borrower_email', 'Borrower email', 'Borrower', 'text', 'b.email::text'),
  F('borrower_phone', 'Borrower phone', 'Borrower', 'text', 'b.cell_phone'),
  F('borrower_fico', 'Borrower FICO', 'Borrower', 'number', 'b.fico'),
  // The ONE deal-FICO rule: one borrower = the middle score; two = the higher
  // of the two middle scores (credit.dealFicoSql — never re-inlined).
  F('deal_fico', 'Deal FICO (higher middle)', 'Borrower', 'number', credit.dealFicoSql('b', 'cb')),
  F('co_borrower_name', 'Co-borrower', 'Borrower', 'text', "NULLIF(cb.full_name,'')"),
  F('entity_name', 'Vesting entity', 'Borrower', 'text', 'l.llc_name'),

  // ── Property ───────────────────────────────────────────────────────────
  F('property_address', 'Property address', 'Property', 'text', fileSearch.ADDRESS_TEXT_SQL('a')),
  F('property_city', 'Property city', 'Property', 'text', "a.property_address->>'city'"),
  F('property_state', 'Property state', 'Property', 'text', "a.property_address->>'state'"),
  F('property_zip', 'Property ZIP', 'Property', 'text', "a.property_address->>'zip'"),
  F('property_type', 'Property type', 'Property', 'text', 'a.property_type'),
  F('units', 'Units', 'Property', 'number', 'a.units'),
  F('occupancy', 'Occupancy', 'Property', 'text', 'a.occupancy'),
  F('year_built', 'Year built', 'Property', 'number', 'a.year_built'),

  // ── Deal & pricing ─────────────────────────────────────────────────────
  F('program', 'Program (file)', 'Deal & pricing', 'text', 'a.program'),
  F('registered_program', 'Program (registered)', 'Deal & pricing', 'text', 'reg.program'),
  F('loan_type', 'Loan purpose', 'Deal & pricing', 'text', 'a.loan_type'),
  F('rehab_type', 'Rehab type', 'Deal & pricing', 'text', 'a.rehab_type'),
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
  F('term', 'Term', 'Deal & pricing', 'text', 'a.term'),
  F('is_assignment', 'Assignment of contract', 'Deal & pricing', 'boolean', 'a.is_assignment'),
  F('assignment_fee', 'Assignment fee', 'Deal & pricing', 'money', 'a.assignment_fee'),
  F('payoff_amount', 'Payoff amount', 'Deal & pricing', 'money', 'a.payoff_amount'),
  F('estimated_cash_out', 'Estimated cash-out', 'Deal & pricing', 'money', 'a.estimated_cash_out'),
  F('registration_status', 'Registration status', 'Deal & pricing', 'text', 'reg.status'),
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

  // ── Team ───────────────────────────────────────────────────────────────
  F('loan_officer', 'Loan officer', 'Team', 'text', 'lo.full_name'),
  F('processor', 'Processor', 'Team', 'text', 'pr.full_name'),
  F('underwriter', 'Underwriter', 'Team', 'text', 'uw.full_name'),

  // ── Investor & closing ─────────────────────────────────────────────────
  // STAFF-ONLY by nature (the note buyer) — this whole surface is admin-gated
  // and none of it ever reaches a borrower.
  F('investor', 'Investor (note buyer)', 'Investor & closing', 'text', 'a.lender'),
  F('investor_loan_number', 'Investor loan number', 'Investor & closing', 'text', 'a.investor_loan_number'),
  F('closing_handling', 'Closing handling (file override)', 'Investor & closing', 'enum', 'a.closing_handling',
    { options: ['internal', 'attorney', 'lender_direct'] }),
  F('warehouse', 'Warehouse / funding line', 'Investor & closing', 'text', 'cw.warehouse'),
  F('table_funded', 'Table funded', 'Investor & closing', 'boolean', 'cw.table_funded'),
  F('title_company', 'Title company', 'Investor & closing', 'text', 'a.title_company'),
  F('insurance_company', 'Insurance company', 'Investor & closing', 'text', 'a.insurance_company'),
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

/** Validate + normalize a whole definition. Throws ReportError on anything off. */
function normalizeDefinition(def) {
  const d = def && typeof def === 'object' ? def : {};
  const filters = Array.isArray(d.filters) ? d.filters.slice(0, 40) : [];
  let columns = Array.isArray(d.columns) ? d.columns.map((k) => String(k || '')).filter((k) => BY_KEY.has(k)) : [];
  columns = [...new Set(columns)].slice(0, 60);
  if (!columns.length) columns = ['ys_loan_number', 'borrower_name', 'property_address', 'file_status', 'loan_amount', 'loan_officer'];
  let sort = null;
  if (d.sort && typeof d.sort === 'object' && BY_KEY.has(String(d.sort.field || ''))) {
    sort = { field: String(d.sort.field), dir: String(d.sort.dir).toLowerCase() === 'desc' ? 'desc' : 'asc' };
  }
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(d.limit) || DEFAULT_ROWS));
  return { filters, columns, sort, limit };
}

/** Compile a definition into ONE ready-to-run statement. */
function compileReport(def) {
  const d = normalizeDefinition(def);
  const params = [];
  const where = [BASE_SCOPE];
  for (const row of d.filters) where.push(compileFilter(row, params));
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

/** Run a report. Returns {columns:[{key,label,type}], rows:[{...}], total, capped}. */
async function runReport(def, client = db) {
  const { sql, params, def: d } = compileReport(def);
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
  }));
}

module.exports = {
  ReportError, REPORT_FIELDS, OPS_BY_TYPE, DEFAULT_ROWS, MAX_ROWS,
  catalog, normalizeDefinition, compileReport, runReport, buildReportXlsx,
  _internals: { compileFilter, coerceValue, cellValue, FROM_SQL, BASE_SCOPE },
};
