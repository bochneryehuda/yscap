'use strict';
/**
 * LONG-TERM (LT) — export the Encompass field research to spreadsheets.
 *
 * The research lives as JSON so code can read it. This turns it into CSV so a
 * PERSON can — open it in Excel, sort it, filter it, hand it to somebody who has
 * never seen this repository. The owner's instruction: "save every single piece of
 * research that you did so that everybody should be able to access all the field
 * types, field data types, everything".
 *
 * It reads through the SAME accessor modules the application reads through
 * (field-intelligence, dropdowns, terms…) rather than the raw JSON, so a spreadsheet
 * can never show something different from what the code sees.
 *
 * Read-only in every sense: it reads committed research and writes CSV. It never
 * touches Encompass, never touches the database, and never modifies the research.
 *
 *   node scripts/lt-export-field-research.js            → docs/longterm/research-exports/
 *   node scripts/lt-export-field-research.js <outdir>
 *
 * Re-run it after the census is refreshed, and commit the result.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DICT = path.join(ROOT, 'src/longterm/encompass/dictionary');
const OUT = process.argv[2] || path.join(ROOT, 'docs/longterm/research-exports');

const FI = require(path.join(ROOT, 'src/longterm/encompass/field-intelligence'));
const DD = require(path.join(ROOT, 'src/longterm/encompass/dropdowns'));
const TERMS = require(path.join(ROOT, 'src/longterm/encompass/terms'));
const INV = require(path.join(ROOT, 'src/longterm/encompass/investors'));

/** RFC-4180 quoting. A value containing a comma, a quote or a newline must be
 *  quoted and an embedded quote doubled — otherwise one condition description with
 *  a comma in it silently shifts every column to its right. */
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) v = v.join(' | ');
  else if (typeof v === 'object') v = JSON.stringify(v);
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(name, headers, rows) {
  const body = [headers.map(cell).join(',')]
    .concat(rows.map((r) => r.map(cell).join(',')))
    .join('\r\n');
  // A BOM, so Excel opens it as UTF-8 — without one every em-dash in a label
  // arrives as mojibake.
  fs.writeFileSync(path.join(OUT, name), `﻿${body}\r\n`, 'utf8');
  console.log(`  ${String(rows.length).padStart(6)} rows  →  ${name}`);
}

const load = (f) => JSON.parse(fs.readFileSync(path.join(DICT, f), 'utf8'));

/** `observedTypes` is a {type: count} tally, not a list — a field declared String
 *  that holds 700 floats and 70 ints is a real case here, and the COUNTS are the
 *  interesting part. Rendered most-common-first as "float x700 | int x70". */
function observedTypes(f) {
  const t = f.observedTypes;
  if (!t || typeof t !== 'object') return '';
  return Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} x${n}`)
    .join(' | ');
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`Exporting the long-term Encompass research to ${path.relative(ROOT, OUT)}/\n`);

// ── 1. Every field ───────────────────────────────────────────────────────────
// The main event: one row per field, carrying what Encompass DECLARES it to be AND
// what the live data actually turned out to be. Both columns are present because
// they disagree often enough to matter — a field declared String holding integers
// is common in this tenant, and a mapping built on the declaration alone breaks.
{
  const rows = FI.ids().map((id) => {
    const f = FI.field(id);
    return [
      f.id,
      f.label,
      f.kind,                                     // standard | custom | virtual
      f.declaredType,                             // what the schema says it is
      f.declaredFormat,                           // …and how it is formatted
      observedTypes(f),                           // what the live values actually were
      f.jsonPath,
      f.contractPath,
      f.multiInstance,                            // repeats per borrower pair / per unit
      f.readOnly,
      f.fill && f.fill.dscrCount,
      f.fill && f.fill.dscrPct,
      f.fill && f.fill.fixflipCount,
      f.fill && f.fill.fixflipPct,
      f.distinctValues,
      f.range && f.range.min,
      f.range && f.range.p25,
      f.range && f.range.median,
      f.range && f.range.p75,
      f.range && f.range.max,
      f.populatedFrom,                            // earliest milestone it appears at
      f.inLegacyCatalog,
      f.valuesWithheld || '',                     // set where sample values are PII
    ];
  });
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }));
  writeCsv('01-every-field.csv', [
    'Field ID', 'Label', 'Kind', 'Declared type', 'Declared format',
    'Data types actually seen', 'JSON path', 'Contract path', 'Repeats?', 'Read-only?',
    'Filled on long-term (count)', 'Filled on long-term (%)',
    'Filled on short-term (count)', 'Filled on short-term (%)',
    'Distinct values', 'Min', '25th percentile', 'Median', '75th percentile', 'Max',
    'First filled at milestone', 'In legacy catalog?', 'Sample values withheld because',
  ], rows);
}

// ── 2. When each field gets filled ───────────────────────────────────────────
// One row per field per milestone: what percentage of files at that stage carry a
// value. This is the answer to "at which step is this filled" — the thing you need
// before you can decide when to ASK for something.
{
  const rows = [];
  for (const id of FI.ids()) {
    const f = FI.field(id);
    const byStage = f.fillByStage || {};
    for (const stage of Object.keys(byStage).sort()) {
      rows.push([f.id, f.label, stage, byStage[stage]]);
    }
  }
  writeCsv('02-field-fill-by-milestone.csv',
    ['Field ID', 'Label', 'Milestone', 'Filled at this milestone (%)'], rows);
}

// ── 3. Every dropdown, and what may go in it ─────────────────────────────────
// Two things a mapping must know and cannot guess: the option list, and whether
// that list is AUTHORITATIVE. A CUSTOM dropdown publishes no options through the
// API, so its list here is inferred from values actually seen — a floor, not a
// ceiling. Never reject a value against an inferred list.
{
  const rows = [];
  for (const f of DD.list()) {
    const opts = DD.options(f.id);
    if (!opts.length) {
      rows.push([f.id, f.label, f.kind, f.dataType, f.format, '', '', '', '',
        f.declaredSetDrift || '']);
      continue;
    }
    for (const o of opts) {
      rows.push([
        f.id, f.label, f.kind, f.dataType, f.format,
        o.value, o.text,
        o.inferred ? 'inferred from live data' : 'declared by Encompass',
        o.loans == null ? '' : o.loans,
        f.declaredSetDrift || '',
      ]);
    }
  }
  writeCsv('03-dropdown-options.csv', [
    'Field ID', 'Label', 'Kind', 'Data type', 'Format', 'Option value', 'Option text',
    'Where this option came from', 'Long-term loans using it', 'Known drift',
  ], rows);
}

// ── 4. The loan programs ─────────────────────────────────────────────────────
{
  const { programs } = load('program-taxonomy.json');
  writeCsv('04-loan-programs.csv',
    ['Program', 'Family', 'Loans', 'Term (months)', 'Interest-only?',
      'Interest-only (months)', 'Amortization', 'Loan type', 'Purpose', 'Occupancy',
      'Units', 'Property type'],
    programs.map((p) => [
      p.program, p.family, p.loans, p.termMonths, p.interestOnly, p.interestOnlyMonths,
      p.amortizationType, p.loanType, p.loanPurpose, p.occupancy, p.units, p.propertyType,
    ]));
}

// ── 5. The term structures, measured ─────────────────────────────────────────
// What the book actually contains, and — just as important — what it does not.
{
  const rows = TERMS.TERM_STRUCTURES.map((s) => [
    s.label, s.program, s.termMonths, s.interestOnlyMonths, s.amortizingMonths,
    s.loans, 'yes', s.plainEnglish, s.watchOut || '',
  ]);
  for (const s of TERMS.TERM_STRUCTURES_NOT_PRESENT) {
    rows.push([s.label, '', s.termMonths, '', '', 0, 'NO — not in the book', s.note, '']);
  }
  writeCsv('05-term-structures.csv', [
    'Structure', 'Program name', 'Term (months)', 'Interest-only (months)',
    'Amortizing (months)', 'Loans', 'Exists in the live book?', 'What it means',
    'Watch out for',
  ], rows);
}

// ── 6. The PITI the DSCR is measured against ─────────────────────────────────
{
  const rows = TERMS.PITI.components.map((c) => [
    c.fieldId, c.label, c.path, c.filledOn, c.of,
    Math.round((c.filledOn / c.of) * 1000) / 10, c.note || '',
  ]);
  rows.push([TERMS.PITI.totalFieldId, `TOTAL — ${TERMS.PITI.label}`, TERMS.PITI.totalPath,
    '', '', '', 'READ THIS, never rebuild it from the parts. ' + TERMS.PITI.theOtherThirtyNine.consequence]);
  writeCsv('06-piti-components.csv', [
    'Field ID', 'What it is', 'JSON path', 'Filled on (long-term loans)',
    'Out of', 'Filled (%)', 'Note',
  ], rows);
}

// ── 7. Investors, and every way each one has been spelled ────────────────────
// Nothing can be matched, rolled up or pushed to ClickUp on a value spelled several
// ways. This is the list that turns what staff typed into something joinable.
{
  const rows = [];
  for (const inv of INV.list()) {
    const spellings = inv.spellings && inv.spellings.length ? inv.spellings : [inv.label];
    for (const s of spellings) {
      rows.push([inv.key, inv.label, s, inv.alsoOnRtl ? 'yes' : 'no']);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]) || String(a[2]).localeCompare(String(b[2])));
  writeCsv('07-investor-spellings.csv', [
    'Canonical key (join on THIS, never the name)', 'Canonical label',
    'Spelling seen in Encompass', 'Also a note buyer on the short-term side?',
  ], rows);
}

// ── 8. The condition library ─────────────────────────────────────────────────
{
  const lib = load('condition-library.json');
  writeCsv('08-condition-templates.csv',
    ['Template', 'Type', 'Short code', 'Category', 'Prior to', 'Active?',
      'Where it prints', 'Description (staff)', 'Description (borrower)'],
    (lib.templates || []).map((t) => [
      t.title, t.conditionType, t.internalId, t.category, t.priorTo, t.active,
      t.printDefinitions, t.internalDescription, t.externalDescription,
    ]));
  writeCsv('09-condition-sets.csv', ['Set', 'Type'],
    (lib.conditionSets || []).map((s) => [s.title, s.conditionType]));
}

// ── 10. The eFolder document types ───────────────────────────────────────────
{
  const cat = load('efolder-catalog.json');
  writeCsv('10-efolder-document-types.csv', ['Document type', 'Description'],
    (cat.documentTypes || []).map((d) => [d.name, d.description]));
}

// ── 11. The API surface ──────────────────────────────────────────────────────
// Which Encompass calls answer and which do not — including the ones that cost
// hours: a 200 with an empty list on a file that plainly has the data.
{
  const api = load('api-surface.json');
  const rows = [];
  for (const e of api.working || []) rows.push([e.path, 'works', e.status, e.shape]);
  for (const e of api.blocked || []) rows.push([e.path, 'blocked or empty', e.status, e.shape]);
  writeCsv('11-api-surface.csv',
    ['Endpoint', 'Result', 'HTTP status', 'What came back'], rows);
}

console.log('\nDone. A snapshot of the live tenant, measured 2026-08-14.');
console.log('Regenerate with this script after any re-census; never hand-edit a CSV.');
