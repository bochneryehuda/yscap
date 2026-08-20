'use strict';
/**
 * THE RECORDS STAMP — the ONE definition and its three mirrors, pinned.
 *
 * src/lib/track-record/records-stamp.js owns the wording. Three surfaces cannot
 * require it and carry a MIRROR instead (the lib/payoff.js arrangement — the
 * portal bundle and the static tools have no access to server code):
 *   · app-v2/src/components/track-record/RecordsStamp.jsx  (STAMP_WORDING)
 *   · web/v2/tools/track-record-portal.js                  (RSTAMP + summary)
 *   · web/v2/tools/track-record.js                         (cells + summary)
 * This suite reads ALL FOUR files and fails the moment any pair drifts — the
 * CLAUDE.md rule: where a mirror is unavoidable, a test must fail when they
 * disagree.
 *
 * Also here, pure: exportCellText / summaryLine truth tables, the SQL
 * provenance shape, the borrower self-search wording (never the vendor's name,
 * never "you have no history"), the self-search privacy wiring (a borrower run
 * never searches a bare personal name), and line-details' storable /
 * suggestionsFor (fill-only offers; a differing value is shown, never offered).
 */

const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const RS = require('../src/lib/track-record/records-stamp');
const W = RS.WORDING;

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const jsxSrc = read('app-v2/src/components/track-record/RecordsStamp.jsx');
const bridgeSrc = read('web/v2/tools/track-record-portal.js');
const toolSrc = read('web/v2/tools/track-record.js');
const styles = read('app-v2/src/styles.css');

console.log('\nA. The server wording itself — the owner\'s words, pinned');
{
  ok(W.verified.cell === '✓ Verified to Elementix', 'verified cell is the owner\'s exact words');
  ok(W.sourced.cell === '○ Sourced via Elementix', 'sourced cell names the source without claiming a match');
  ok(W.verified.stamp === 'VERIFIED TO ELEMENTIX', 'the export stamp headline is "VERIFIED TO ELEMENTIX"');
  ok(/public records/i.test(W.verified.chip) && /public records/i.test(W.sourced.chip),
    'both screen chips speak about the PUBLIC RECORDS (what the claim is about)');
  ok(W.verified.chip !== W.sourced.chip && W.verified.cell !== W.sourced.cell,
    'the two states never collapse — different chip, different cell');
  ok(/not yet matched/i.test(W.sourced.long),
    'the sourced long text says plainly it is NOT yet matched line by line');
}

console.log('\nB. The React mirror (RecordsStamp.jsx) agrees word for word');
{
  const grab = (key) => {
    const m = jsxSrc.match(new RegExp(key + String.raw`:\s*\{\s*chip:\s*'([^']*)',\s*long:\s*'([^']*)'`, 's'));
    return m ? { chip: m[1], long: m[2] } : null;
  };
  const v = grab('verified'); const s = grab('sourced');
  ok(v && v.chip === W.verified.chip, 'verified chip matches the server');
  ok(v && v.long === W.verified.long, 'verified long matches the server');
  ok(s && s.chip === W.sourced.chip, 'sourced chip matches the server');
  ok(s && s.long === W.sourced.long, 'sourced long matches the server');
  ok(/adopted_source/.test(jsxSrc) && /'elementix'/.test(jsxSrc),
    'EntityRecordsStamp keys on adopted_source === elementix (the db/400 stamp)');
  ok(!/var\(--ink/.test(jsxSrc), 'no --ink* token near text (the light-token trap)');
  ok(/\.rstamp-verified/.test(styles) && /\.rstamp-sourced/.test(styles),
    'the namespaced .rstamp-* state classes exist (never a bare .off/.on)');
}

console.log('\nC. The tool-bridge mirror (track-record-portal.js) agrees');
{
  const grab = (key) => {
    const m = bridgeSrc.match(new RegExp(key + String.raw`:\s*\{\s*chip:\s*"([^"]*)",\s*long:\s*"([^"]*)",\s*cell:\s*"([^"]*)"`, 's'));
    return m ? { chip: m[1], long: m[2], cell: m[3] } : null;
  };
  const v = grab('verified'); const s = grab('sourced');
  ok(v && v.chip === W.verified.chip && v.long === W.verified.long && v.cell === W.verified.cell,
    'bridge RSTAMP.verified matches the server (chip + long + cell)');
  ok(s && s.chip === W.sourced.chip && s.long === W.sourced.long && s.cell === W.sourced.cell,
    'bridge RSTAMP.sourced matches the server (chip + long + cell)');
}

console.log('\nD. The summary sentence — fragments derived FROM the server, present in both tool files');
{
  // Fragments are computed from live summaryLine output, never retyped — so a
  // server wording change moves the fragments and a stale mirror fails here.
  const mixed = RS.summaryLine([{ records_stamp: 'verified' }, { records_stamp: 'sourced' }, {}]);
  const sOnly = RS.summaryLine([{ records_stamp: 'sourced' }]);
  const frag = (line, re) => { const m = line.match(re); return m ? m[0] : null; };
  const frags = [
    frag(mixed, /^[A-Z ]+ — /),                                   // 'VERIFIED TO ELEMENTIX — '
    frag(mixed, /matched to the county public records/),
    frag(mixed, /more imported from the records/),
    frag(sOnly, /^[A-Z ]+ — /),                                   // 'SOURCED VIA ELEMENTIX — '
    frag(sOnly, /imported from the county public records/),
  ];
  ok(frags.every(Boolean), 'the fragment battery derives from live summaryLine output');
  for (const f of frags) {
    ok(bridgeSrc.includes(f.trim()), `bridge carries "${f.trim().slice(0, 40)}…"`);
    ok(toolSrc.includes(f.trim()), `tool carries "${f.trim().slice(0, 40)}…"`);
  }
  ok(toolSrc.includes(W.verified.cell) && toolSrc.includes(W.sourced.cell),
    'the tool\'s Excel cells carry the exact server cell wording');
}

console.log('\nE. exportCellText — the one-cell truth table');
{
  ok(RS.exportCellText(null, '2026-01-01') === '', 'no stamp → a genuinely empty cell');
  ok(RS.exportCellText('bogus', null) === '', 'an unknown state → empty, never a guess');
  ok(RS.exportCellText('verified', '2026-01-02T10:11:12Z') === '✓ Verified to Elementix · 2026-01-02',
    'verified + timestamp → cell + the day only');
  ok(RS.exportCellText('sourced', null) === '○ Sourced via Elementix', 'sourced with no date → the cell alone');
  ok(RS.exportCellText('sourced', 'garbage') === '○ Sourced via Elementix', 'an unreadable date is dropped, never printed');
}

console.log('\nF. summaryLine — every branch');
{
  ok(RS.summaryLine([]) === null, 'no rows → null (an unstamped export carries no stamp at all)');
  ok(RS.summaryLine([{}, { records_stamp: null }]) === null, 'unstamped rows → null');
  ok(RS.summaryLine([{ records_stamp: 'verified' }])
    === 'VERIFIED TO ELEMENTIX — 1 of 1 property matched to the county public records',
  'verified-only, singular noun');
  ok(RS.summaryLine([{ records_stamp: 'sourced' }, {}])
    === 'SOURCED VIA ELEMENTIX — 1 of 2 properties imported from the county public records',
  'sourced-only names the import, never a match');
  const mixed = RS.summaryLine([{ records_stamp: 'verified' }, { records_stamp: 'sourced' }, { records_stamp: 'sourced' }, {}]);
  ok(mixed === 'VERIFIED TO ELEMENTIX — 1 of 4 properties matched to the county public records; 2 more imported from the records',
    'mixed leads with VERIFIED and counts the sourced tail');
}

console.log('\nG. The SQL provenance shape — what makes a line verified/sourced');
{
  const sql = RS.STAMP_SQL('t');
  ok(/auto_source\s*=\s*'elementix'/.test(sql) && /auto_verdict\s*=\s*'proved'/.test(sql),
    'verified = a PROVED elementix pillar observation (verify-run\'s columns)');
  ok(/pillar IN \('ownership','exit'\)/.test(sql),
    'only ownership + exit count (recency is date-derived, never a records match)');
  ok(/origin\s*=\s*'public_records'/.test(sql), 'sourced reads the importer\'s origin');
  ok(/status\s*=\s*'imported'/.test(sql) && /status\s*=\s*'merged'/.test(sql),
    'a candidate counts only on the two SUCCESS verbs (a declined candidate proves nothing)');
  ok(!/is_verified/.test(sql), 'the stamp NEVER reads is_verified — the human verification is a third thing');
  ok(/adopted_source\s*=\s*'elementix'/.test(RS.ENTITY_STAMP_SQL('l')), 'the entity stamp reads the db/400 adoption source');
}

console.log('\nH. The borrower self-search wording — borrower-safe by construction');
{
  const SS = require('../src/lib/track-record/self-search');
  const { borrowerSummary } = SS._internals;
  const kinds = ['cooldown', 'limit', 'unavailable', 'nothing_to_search', 'for_review', 'nothing_found'];
  for (const k of kinds) {
    const s = borrowerSummary(k, { forReview: 2 });
    ok(typeof s === 'string' && s.length > 20, `${k} answers a real sentence`);
    ok(!/elementix/i.test(s), `${k} never names the vendor to a borrower`);
  }
  const imp = borrowerSummary('imported', { imported: 2, merged: 1, entitiesAdded: 1, forReview: 3 });
  ok(/2 projects from the public records were added/.test(imp), 'imported states the count in plain words');
  ok(/1 company was added/.test(imp), 'and the companies added');
  ok(/3 possible matches are waiting/.test(imp), 'and what still waits for the borrower');
  ok(/1 possible match is waiting/.test(borrowerSummary('imported', { imported: 1, forReview: 1 })),
    'singular pluralization holds ("1 possible match is")');
  ok(/2 properties in the public records/.test(borrowerSummary('for_review', { forReview: 2 }))
    && /1 property in the public records/.test(borrowerSummary('for_review', { forReview: 1 })),
  'for_review pluralizes property/properties correctly');
  ok(/loan team[’']s review/.test(imp), 'imported never claims the lines already count toward experience');
  ok(/does not mean there is nothing/.test(borrowerSummary('nothing_found')),
    '"found nothing" is never worded as "you have no history"');
  ok(SS.COOLDOWN_MINUTES === 15 && SS.MONTHLY_CAP === 10, 'the durable budget constants');

  // The privacy rule is STRUCTURAL: the borrower door always passes
  // personalNameSearch:false, and the importer skips the bare-name search on it.
  const ssSrc = read('src/lib/track-record/self-search.js');
  ok(/personalNameSearch:\s*false/.test(ssSrc), 'selfSearch always passes personalNameSearch:false');
  ok(/requestedBy:\s*'borrower'/.test(ssSrc), 'and stamps requestedBy=borrower (the ceiling counts on it)');
  const impSrc = read('src/lib/track-record/importer.js');
  ok(/personal_name_not_searched/.test(impSrc), 'the importer records the suppressed name search as a skip, with a reason');
  const routeSrc = read('src/routes/borrower.js');
  ok(/borrower-tr-search/.test(routeSrc), 'the route rides its own keyed per-borrower rate bucket');
  ok(/_audit/.test(routeSrc) && /\.\.\.body\s*}\s*=\s*out|const\s*\{\s*_audit,\s*\.\.\.body\s*\}/.test(routeSrc.replace(/\n/g, ' ')),
    'the route strips _audit before answering the borrower');
}

console.log('\nI. line-details — storable + suggestionsFor (fill-only offers)');
{
  const LD = require('../src/lib/track-record/line-details');
  const { storable, suggestionsFor } = LD._internals;
  ok(storable('money', '1,250,000') === 1250000, 'money parses formatted figures');
  ok(storable('money', 1e12) === null, 'a figure past numeric(14,2) is unstorable, never a 22003');
  ok(storable('money', -5) === null, 'a negative price is refused');
  ok(storable('date', '2024-05-06T00:00:00Z') === '2024-05-06', 'a timestamp stores as its day');
  ok(storable('date', '1800-01-01') === null && storable('date', 'soon') === null, 'off-calendar / unreadable dates are refused');
  ok(String(storable('text', 'x'.repeat(200))).length === 160, 'text is capped to the column');

  const cand = { purchase_price: 410000, purchase_date: '2020-01-02', sale_price: null, raw: { counterparty: 'SMITH FAMILY TRUST' } };
  const blank = { purchase_price: null, purchase_date: '', sale_price: null, seller_name: null };
  const sugg = suggestionsFor(blank, cand);
  const byField = Object.fromEntries(sugg.map((s) => [s.field, s]));
  ok(byField.purchase_price && byField.purchase_price.fillable === true, 'a blank column with a recorded figure is offered');
  ok(byField.seller_name && byField.seller_name.fillable === true && byField.seller_name.material === false,
    'the counterparty rides raw.counterparty and is NON-material (db/485)');
  ok(byField.purchase_price.material === true, 'a money fill is material (it re-opens a verification)');
  ok(!byField.sale_price, 'a field the records do not state is never offered');

  const holds = suggestionsFor({ purchase_price: 400000 }, cand);
  const diff = holds.find((s) => s.field === 'purchase_price');
  ok(diff && diff.fillable === false && diff.current === 400000,
    'a DIFFERING value is shown but never offered — the records never rewrite what somebody typed');
  ok(suggestionsFor({ purchase_price: 410000, purchase_date: '2020-01-02', seller_name: 'SMITH FAMILY TRUST' }, cand)
    .every((s) => s.field !== 'purchase_price'), 'an equal value raises nothing');

  // The UPDATE itself is COALESCE — the guard against a CONCURRENT edit filling
  // the column between the suggestion read and the write. A behavior test
  // cannot stage that race over HTTP, so the shape is pinned at the source.
  const ldSrc = read('src/lib/track-record/line-details.js');
  ok(/COALESCE\(\$\{s\.field\},\s*\$\$\{vals\.length\}\)/.test(ldSrc),
    'the apply writes col = COALESCE(col, $n) — fill-only against a concurrent edit, by construction');
}

console.log('\nJ. The server exports carry the stamp through ONE definition');
{
  const TRX = require('../src/lib/track-record-export');
  const sections = [
    { rows: [{ __recordsStamp: 'verified' }, { __recordsStamp: null }] },
    { rows: [{ __recordsStamp: 'sourced' }] },
  ];
  ok(TRX.recordsStampLine(sections)
    === 'VERIFIED TO ELEMENTIX — 1 of 3 properties matched to the county public records; 1 more imported from the records',
  'recordsStampLine delegates to summaryLine over both sections');
  ok(TRX.recordsStampLine([{ rows: [{}, {}] }]) === null, 'an unstamped book prints no stamp at all');
  const aoa = TRX.trackRecordAoa([{ title: 'T', columns: [{ header: 'P', key: 'p' }], rows: [{ p: 'x', __recordsStamp: 'verified' }] }], {});
  ok(aoa.some((r) => /VERIFIED TO ELEMENTIX/.test(String(r[0]))), 'the xlsx verification summary carries the stamp line');
  const aoa2 = TRX.trackRecordAoa([{ title: 'T', columns: [{ header: 'P', key: 'p' }], rows: [{ p: 'x' }] }], {});
  ok(!aoa2.some((r) => /ELEMENTIX/.test(String(r[0]))), 'and an unstamped export is unchanged');
  const tprSrc = read('src/lib/tpr-export.js');
  ok(/exportCellText\(r\.records_stamp,\s*r\.records_stamp_at\)/.test(tprSrc),
    'the TPR row cell goes through exportCellText — never a re-typed wording');
  ok(/records\.some\(\(r\) => r\.records_stamp\)/.test(tprSrc),
    'the TPR stamp column appears only when a line actually carries a stamp');
}

console.log('');
if (fail) { console.error(`${fail} FAILURE(S)`); process.exit(1); }
console.log('records-stamp pure: ALL PASS');
