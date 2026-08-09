#!/usr/bin/env node
/**
 * SURVEY A REAL UAD 3.6 REPORT — the tool for finishing the field map.
 *
 * The 3.6 reader was written against a specification this environment cannot fetch
 * (see docs/appraisal-xml/uad-3.6-research.md §Access), so every field carries several
 * candidate paths and records WHICH one fired. This script is how that record is read:
 * point it at the first real report and it prints, in one page, what resolved, what did
 * not, which fields only resolved through the last-resort name sweep (those are the
 * paths to correct), and every element name the producer actually emitted.
 *
 *   node scripts/uad36-survey.js <file.xml | package.zip> [...more]
 *   node scripts/uad36-survey.js --tags <file.xml>     # element census only
 *
 * Read-only. Touches no database, sends nothing anywhere, writes no file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const X = require('../src/lib/appraisal/xml36');
const P = require('../src/lib/appraisal/package36');
const { extract36, detect36 } = require('../src/lib/appraisal/extract36');

const args = process.argv.slice(2);
const tagsOnly = args.includes('--tags');
const files = args.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.error('usage: node scripts/uad36-survey.js <file.xml | package.zip> [...]  [--tags]');
  process.exit(2);
}

/** Read a path as XML text — unwrapping a UAD 3.6 ZIP delivery when that is what it is. */
function loadXml(file) {
  const buf = fs.readFileSync(file);
  if (P.looksLikeZip(buf)) {
    const pkg = P.openPackage(buf);
    if (!pkg.ok) return { xml: null, note: `ZIP refused: ${pkg.error}` };
    return { xml: pkg.xml, note: `ZIP delivery — ${P.describePackage(pkg)}` };
  }
  return { xml: buf.toString('utf8'), note: 'bare XML' };
}

const pad = (s, n) => String(s).padEnd(n);

for (const file of files) {
  console.log(`\n${'='.repeat(78)}\n${path.basename(file)}`);
  let loaded;
  try { loaded = loadXml(file); } catch (e) { console.log(`  could not read: ${e.message}`); continue; }
  if (!loaded.xml) { console.log(`  ${loaded.note}`); continue; }
  console.log(`  ${loaded.note}`);

  const det = detect36(loaded.xml);
  console.log(`  detected: model=${det.model} ref=${det.ref || '—'} uad36=${det.uad36} grid=${det.hasGrid} ilad=${det.isIlad}`);

  if (tagsOnly) {
    const { root } = X.parse(loaded.xml);
    const census = [...X.tagCensus(root).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    console.log(`\n  ELEMENT CENSUS (${census.length} distinct names)`);
    for (const [name, n] of census) console.log(`    ${pad(n, 6)} ${name}`);
    continue;
  }

  const A = extract36(loaded.xml);
  if (!A.ok) { console.log(`  REFUSED: ${A.error}`); continue; }

  const cov = A.coverage;
  console.log(`\n  READ: form=${A.formType || '—'} subject via ${A.format.subjectVia} | comparables via ${A.format.comparablesVia || '—'} (${A.comparables.length})`);
  console.log(`  value: ${A.values.appraisedValue} basis=${A.values.basis} (${A.values.basisNote}) as-is=${A.values.asIs} arv=${A.values.arv}`);
  console.log(`  coverage: ${cov.resolved}/${cov.total} fields resolved`);

  if (cov.viaSweep.length) {
    console.log(`\n  *** RESOLVED ONLY BY THE NAME SWEEP (${cov.viaSweep.length}) — correct these paths first:`);
    for (const k of cov.viaSweep) console.log(`    ${pad(k, 34)} ${cov.fields[k].via}`);
  }

  // Group the unresolved by section so a whole missing block is obvious at a glance.
  // The comparables repeat one key list per row, so they are COLLAPSED with a count —
  // "gla missing on 4 of 4 rows" is the useful reading; four identical lists are not.
  const byGroup = new Map();
  for (const k of cov.unresolved) {
    const g = k.split('.')[0].replace(/\[\d+\]$/, '[]');
    const field = k.split('.').slice(1).join('.');
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    const m = byGroup.get(g);
    m.set(field, (m.get(field) || 0) + 1);
  }
  console.log(`\n  DID NOT RESOLVE (${cov.unresolved.length}):`);
  for (const [g, m] of [...byGroup.entries()].sort()) {
    const repeated = g.endsWith('[]');
    const list = [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([f, n]) => (repeated && n > 1 ? `${f}×${n}` : f));
    console.log(`    ${pad(g, 12)} ${list.join(', ')}`);
  }

  if (A.warnings.length) {
    console.log('\n  WARNINGS:');
    for (const w of A.warnings) console.log(`    ${pad(w.code, 28)} ${w.msg}`);
  }
}

console.log('');
