/* WHICH TRACK-RECORD LINES AN EXPORT CARRIES, AND HOW AN UNVERIFIED ONE IS STAMPED — the rule,
 * with no database and no network.
 *
 * Owner-directed 2026-08-21 (item 7): *"the regular export button (PDF or Excel) should only
 * export the verified ones. There should be an extra option to export the PDF or an Excel from
 * the unverified ones, but everything that is unverified should have a stamp that it's not
 * verified yet, and it still needs to go through verification."*
 *
 * What this pins:
 *   A. the three scopes, and that an unreadable instruction falls back to the SAFE narrow one;
 *   B. the SQL predicates PARTITION the record — verified and unverified are exact complements
 *      and neither loses a NULL, so a line can never exist on the record and appear in neither
 *      export (the three-valued-logic trap this codebase has been bitten by before);
 *   C. the per-row stamp, and that a verified-only export carries NO stamp column at all — that
 *      export must stay byte-identical to the one that shipped before this feature;
 *   D. the filename tells the three apart without opening them;
 *   E. THE WORDING IS STATED ONCE. This is the promise `export-scope.js` makes in its own header:
 *      the Excel writer, the PDF writer, the export builder and the browser control are read here
 *      and this test fails the moment ANY of them states the rule in its own words.
 *
 * Pure — no database, no network.
 * Run: node scripts/test-export-scope-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const S = require('../src/lib/track-record/export-scope');
const DOC = require('../src/lib/track-record/export-doc');

// ---------------------------------------------------------------- A. the three scopes
eq('A1 the scopes, in the order a chooser offers them', S.SCOPES, ['verified', 'all', 'unverified']);
eq('A2 the DEFAULT is the narrow, safe one', S.DEFAULT_SCOPE, 'verified');
eq('A3 a blank instruction resolves to the default', S.normalizeScope(''), 'verified');
eq('A4 …and so does junk — never the wide set', S.normalizeScope('everything'), 'verified');
eq('A5 …and undefined', S.normalizeScope(undefined), 'verified');
eq('A6 casing and stray spacing are read, not refused', S.normalizeScope('  ALL '), 'all');
ok('A7 isScope tells a real instruction from junk',
  S.isScope('unverified') && S.isScope(' All ') && !S.isScope('everything') && !S.isScope('') && !S.isScope(null));
for (const k of S.SCOPES) {
  ok(`A8 every scope carries its own wording (${k})`, (() => {
    const m = S.scopeMeta(k);
    return m && m.key === k && m.button && m.title && m.note;
  })());
}
ok('A9 the verified export carries NO banner — it is the ordinary one', S.scopeMeta('verified').banner === null);
ok('A10 …and both wide ones DO, so "why is this list longer" is answerable from the page',
  !!S.scopeMeta('all').banner && !!S.scopeMeta('unverified').banner);
ok('A11 both banners say the lines still need verification, in the ONE wording',
  [S.scopeMeta('all').banner, S.scopeMeta('unverified').banner]
    .every((b) => /still needs to go through verification/.test(b)));

// ---------------------------------------------------------------- B. the SQL partitions
{
  const sql = S.scopeSql('t');
  eq('B1 verified is the plain boolean test', sql.verified, 't.is_verified = true');
  eq('B2 all is always safe to AND into a WHERE', sql.all, 'TRUE');
  eq('B3 unverified is NULL-SAFE — a NULL row lands here, never in neither export',
    sql.unverified, 'COALESCE(t.is_verified, false) = false');
  ok('B4 …and it is NOT the bare negation that would drop a NULL from BOTH',
    !/^NOT\s/.test(sql.unverified) && sql.unverified.includes('COALESCE'));

  // The partition, evaluated the way Postgres would: every possible value of the column must
  // satisfy EXACTLY ONE of verified / unverified, and ALL must accept every one of them.
  const evalPred = (pred, v) => {
    if (pred === 'TRUE') return true;
    if (pred === 't.is_verified = true') return v === true;              // NULL = unknown = not returned
    if (pred === 'COALESCE(t.is_verified, false) = false') return (v == null ? false : v) === false;
    throw new Error('unknown predicate ' + pred);
  };
  for (const v of [true, false, null, undefined]) {
    const inV = evalPred(sql.verified, v);
    const inU = evalPred(sql.unverified, v);
    ok(`B5 is_verified=${String(v)} appears in exactly one of the two narrow scopes`, inV !== inU);
    ok(`B6 …and always in "all"`, evalPred(sql.all, v) === true);
  }
  eq('B7 scopePredicate hands back the one for that scope', S.scopePredicate('unverified', 't'), sql.unverified);
  eq('B8 an unrecognised scope predicate is the DEFAULT one, never TRUE',
    S.scopePredicate('everything', 't'), sql.verified);
  ok('B9 the alias is sanitized — no punctuation somebody typed survives into the predicate',
    /^[A-Za-z0-9_]+\.is_verified = true$/.test(S.scopeSql('t; DROP TABLE track_records --').verified));
  eq('B10 …and an unusable alias falls back to t', S.scopeSql('!!!').verified, 't.is_verified = true');
}

// ---------------------------------------------------------------- C. the per-row stamp
eq('C1 a verified row carries no stamp', S.rowStamp({ is_verified: true }), null);
ok('C2 an unverified row carries the ONE wording', (() => {
  const st = S.rowStamp({ is_verified: false });
  return st && st.text === S.NOT_VERIFIED_STAMP && st.short === S.NOT_VERIFIED_SHORT;
})());
ok('C3 a NULL verification is stamped — never silently read as verified', !!S.rowStamp({ is_verified: null }));
ok('C4 …and so is a row that says nothing at all', !!S.rowStamp({}) && !!S.rowStamp(null));
ok('C5 the export row shape (__verified) is read too', S.rowStamp({ __verified: true }) === null);
ok('C6 the long stamp says BOTH halves — not verified, and still to be verified',
  /NOT VERIFIED/.test(S.NOT_VERIFIED_STAMP) && /still needs to go through verification/.test(S.NOT_VERIFIED_STAMP));

ok('C7 a book with nothing unverified needs no stamp column at all',
  S.hasUnverified([{ rows: [{ __verified: true }, { __verified: true }] }]) === false);
ok('C8 …one unverified line anywhere turns it on',
  S.hasUnverified([{ rows: [{ __verified: true }] }, { rows: [{ __verified: false }] }]) === true);
ok('C9 an empty book is not stamped', S.hasUnverified([]) === false && S.hasUnverified(null) === false);
ok('C10 a section with no rows does not throw', S.hasUnverified([{}]) === false);

// ---------------------------------------------------------------- D. the filename
{
  const f = (n, s, fmt) => DOC.exportFilename(n, s, fmt, '2026-08-21');
  ok('D1 the scope is in the NAME, so two downloads are told apart unopened',
    /\(Verified\)/.test(f('Ann Lee', 'verified', 'xlsx'))
    && /\(All\)/.test(f('Ann Lee', 'all', 'xlsx'))
    && /\(Unverified\)/.test(f('Ann Lee', 'unverified', 'xlsx')));
  ok('D2 the format decides the extension', f('Ann Lee', 'all', 'pdf').endsWith('.pdf')
    && f('Ann Lee', 'all', 'xlsx').endsWith('.xlsx'));
  ok('D3 a name that would break a filesystem is cleaned',
    !/[\\/:*?"<>|]/.test(f('A/B: "C" <D>', 'verified', 'xlsx')));
  ok('D4 …and a missing name still produces a real filename',
    f('', 'verified', 'xlsx').startsWith('Borrower') && f(null, 'verified', 'pdf').startsWith('Borrower'));
}

// ---------------------------------------------------------------- E. stated ONCE
{
  // The promise export-scope.js makes in its own header. A writer that retypes the wording is a
  // second definition, and the one that drifts is the one that leaks — a PDF headed "verified
  // only" carrying a line nobody verified.
  const RETYPED = [/NOT VERIFIED/, /still needs to go through verification/, /CONTAINS UNVERIFIED/];
  for (const [label, file] of [
    ['the Excel + PDF writers', 'src/lib/track-record-export.js'],
    ['the section builder', 'src/lib/track-record/export-build.js'],
    ['the export door', 'src/lib/track-record/export-doc.js'],
  ]) {
    // Comments may QUOTE the rule (that is how the reasoning is recorded); only CODE may not
    // restate it, so the file is stripped of comments before the check.
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of RETYPED) {
      ok(`E1 ${label} never states the stamp wording in its own words (${re.source})`, !re.test(src));
    }
  }
  const trx = read('src/lib/track-record-export.js');
  ok('E2 …the writers ask export-scope instead', /require\('\.\/track-record\/export-scope'\)/.test(trx));
  ok('E3 the Excel writer prints the scope the document is in', /aoa\.push\(\[scope\.title\]\)/.test(trx));
  ok('E4 …and stamps each row from the ONE rule', /SCOPE\.rowStamp\(row\)/.test(trx));
  ok('E5 …only when the book actually carries something unverified',
    /const stamped = SCOPE\.hasUnverified\(sections\)/.test(trx));

  const doc = read('src/lib/track-record/export-doc.js');
  ok('E6 the export selects through the ONE predicate — never a re-inlined is_verified test',
    /SCOPE\.scopePredicate\(scope, 't'\)/.test(doc));
  ok('E7 …and the rows/sections are the SAME ones the investor package builds',
    /export-build'\)\.buildTrackRecordSections\(records, docsByTr\)/.test(doc));

  const staff = read('src/routes/staff.js');
  ok('E8 the door REFUSES an instruction it does not recognise rather than quietly widening',
    /isScope\(raw\)\)\s*\{[\s\S]{0,220}?status\(400\)/.test(staff));
  ok('E9 …and the export is audited, with its scope', /'track_record_export'/.test(staff));

  // The browser control cannot require server code, so it MIRRORS the wording. Read both and
  // fail the moment they disagree: a button that promises one thing while the document says
  // another is exactly what one definition exists to prevent.
  const ui = read('app-v2/src/components/track-record/ExportRecord.jsx');
  for (const k of S.SCOPES) {
    const m = S.scopeMeta(k);
    ok(`E10 the browser control carries the same button wording (${k})`, ui.includes(`button: '${m.button}'`));
    ok(`E11 …and the same note (${k})`, ui.includes(`note: '${m.note}'`));
  }
  ok('E12 the control offers the scopes in the same order',
    JSON.stringify(S.SCOPES) === JSON.stringify((ui.match(/key: '(verified|all|unverified)'/g) || [])
      .map((s) => s.replace(/.*'(\w+)'.*/, '$1'))));
  ok('E13 the regular export leads and is the VERIFIED one', /pair\('verified', true\)/.test(ui));
  ok('E14 …and both formats are offered on every scope',
    /run\(scope, 'xlsx'\)/.test(ui) && /run\(scope, 'pdf'\)/.test(ui));
  ok('E15 the control goes through the ONE api helper', /api\.staffTrackRecordExport\(borrowerId, \{ scope, format \}\)/.test(ui));

  // ONE control, mounted on every surface that shows the record — three copies of an export
  // menu is how two screens come to offer different exports of one borrower's record.
  for (const screen of ['StaffApplication.jsx', 'StaffBorrowerDetail.jsx', 'StaffTrackRecordWorkspace.jsx']) {
    const src = read(`app-v2/src/screens/${screen}`);
    ok(`E16 ${screen} mounts the shared control`,
      /import ExportRecord from/.test(src) && /<ExportRecord\s/.test(src));
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
