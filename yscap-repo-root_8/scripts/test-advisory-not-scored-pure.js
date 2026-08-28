'use strict';
/**
 * Advisory-only findings must never score, rank or notify (post-merge audit 2026-07-27).
 *
 * The file view deliberately keeps the note-buyer desk's rows OUT of `summary.fatal/warning/info`
 * so the desk can never disagree with the clear-to-close gate. Six OTHER queries aggregated the
 * same table with no source filter and re-admitted those rows through a different door — measured
 * at up to 7 rows x 8 points = 56, which puts an amber ELEVATED badge on a file with nothing wrong,
 * promotes note-only files into the admin "top 5 riskiest" email, and starts a weekly digest for
 * officers whose files are clean.
 *
 * HONEST ABOUT WHAT THIS IS: a STRUCTURAL guard, not a behavioural one. It cannot prove the SQL is
 * right — only that every aggregate which weights severities also carries the shared filter. That
 * is exactly the regression worth catching here (someone adds a seventh scoring query and forgets),
 * and it is a genuinely textual property, unlike a behaviour a regex only appears to test.
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const aiSug = require('../src/lib/underwriting/ai-suggestions');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok ${name}`); };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

console.log('advisory findings are not scored (pure)');

t('the shared filter renders valid SQL, with and without an alias', () => {
  assert.strictEqual(aiSug.notScoredSql(), "source <> ALL(ARRAY['investor_guideline_desk']::text[])");
  assert.strictEqual(aiSug.notScoredSql('s'), "s.source <> ALL(ARRAY['investor_guideline_desk']::text[])");
  assert.ok(Array.isArray(aiSug.ADVISORY_ONLY_SOURCES) && aiSug.ADVISORY_ONLY_SOURCES.length >= 1);
});

t('a source is quoted exactly once and cannot break out of the array literal', () => {
  for (const s of aiSug.ADVISORY_ONLY_SOURCES) {
    assert.ok(/^[a-z0-9_]+$/.test(s),
      `an advisory source must be a bare identifier — "${s}" would need escaping in the SQL literal`);
  }
});

// THE SITES, NAMED. The first cut counted `WHEN 'fatal' THEN 25` and asserted
// `filters >= aggregates`, which was wrong in BOTH directions: it missed the two pipeline chips and
// the nightly fatal email (they count `severity='fatal'`, not the weights), and once widened it
// over-matched `document_findings` queries and inner `FILTER (WHERE severity='fatal')` clauses that
// an outer filter already covers. A count heuristic cannot tell those apart.
//
// So: assert each known consumer by the text that identifies it. WHAT THIS CANNOT DO is notice a
// BRAND-NEW aggregate nobody added here — for that, `ADVISORY_ONLY_SOURCES`' doc comment is the
// instruction, and this list is the checklist. Add a case when you add a consumer.
const FILTER = /notScoredSql\(/g;
const count = (str, re) => (str.match(re) || []).length;

// THE CHECK IS A COUNT PER SQL STATEMENT, NOT "IS A FILTER SOMEWHERE NEARBY" (pre-merge
// audit 2026-07-27, second pass). Two earlier cuts both proved nothing:
//   1. a ±1300-character window around each marker — the three staff.js consumers sit within
//      ~850 characters of each other, so every window saw all three filters;
//   2. scoping to the enclosing SQL statement — the pipeline's three consumers are three
//      aggregates inside ONE 2,054-character query, so deleting one of its three filters
//      still left two in scope.
// Both stayed green under mutation. A guard that cannot fail is worse than none: it reads as
// coverage. So: group the known consumers by the statement they live in, and require that
// statement to carry AT LEAST that many filters. Delete one and the count drops below the
// number of consumers, which is exactly the regression worth catching.
//
// (Neither file contains an escaped backtick, so the enclosing template literal really is the
// statement — `sqlSpanAround` is exact, and the self-test below pins that.)
function sqlSpanAround(src, idx) {
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== '`') continue;
    if (start < 0) { start = i; continue; }
    if (idx > start && idx < i) return [start, i + 1];
    start = -1;
  }
  return null;
}
const sqlStatementAround = (src, idx) => {
  const sp = sqlSpanAround(src, idx);
  return sp ? src.slice(sp[0], sp[1]) : null;
};

/* THREE SITES LEFT THIS LIST ON 2026-08-21, and they were REMOVED rather than filtered.
   The pipeline's two red stamps — the open-fatal chip and the 0-100 risk score — were taken off
   the list screen by owner direction ("take them off the pipeline"), and the three correlated
   subqueries that fed them went with them. A site that no longer exists cannot be guarded, so the
   guard against them coming back is the assertion below the table, not an entry in it. */
const SITES = [
  ['src/lib/notification-digests.js', /ORDER BY score DESC[\s\S]{0,40}?LIMIT 5/, 'the admin top-5-riskiest email'],
  ['src/lib/notification-digests.js', /FROM staff_users u/, 'the LO-digest officer discovery'],
  ['src/lib/notification-digests.js', /ORDER BY score DESC, a\.id\s*\n\s*LIMIT 10/, 'the per-officer file list'],
  ['src/lib/notification-digests.js', /a\.status IN \('approved','clear_to_close','funded'\)/, 'the nightly "advanced with an open fatal" email'],
  // The 7th consumer, MISSED by the first cut: the admin AI Command Center's aged-fatal list
  // ranks files by open fatal suggestions with no source filter, so a file whose only fatals
  // are note-buyer advisories headlines the admin's overview as "oldest 30 days".
  ['src/routes/admin-insights.js', /AS open_fatal,/, 'the admin aged-fatal-files tile'],
];

t('the PIPELINE does not score files at all — the stamps were removed, not filtered', () => {
  /* Owner-directed 2026-08-21, after reviewing the two red stamps on the pipeline list: *"take
     them off the pipeline"*. The reason they were worth reviewing is the standing HARD RULE that
     AI findings are ADVISORY and never block — a red stamp on the one screen the whole team scans
     reads as a STOP on that file. The findings themselves are untouched and still render on the
     FILE, where the person who can resolve one is looking.

     So this asserts ABSENCE, in both places, which a filter-carrying entry in SITES could not:
     re-adding a scoring subquery would pass that table (it would carry the filter) while putting
     the stamp straight back on the pipeline. */
  const sql = read('src/routes/staff.js');
  for (const gone of ['open_fatal_ai', 'ai_risk_score']) {
    assert.ok(!sql.includes(gone),
      `the pipeline query must not compute ${gone} — the stamp it fed was removed by owner direction`);
  }
  const screen = read('app-v2/src/screens/StaffQueue.jsx');
  for (const gone of ['FatalAiChip', 'RiskScoreChip']) {
    // Stripped of comments first: the change that removed these necessarily NAMES them in the
    // note explaining why, and a guard that read comments would fail on its own explanation.
    const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!code.includes(gone), `the pipeline row must not render ${gone}`);
  }
});

t('every KNOWN fatal-counting / scoring consumer carries its OWN filter', () => {
  const byStatement = new Map();      // "file@start" → { stmt, labels[] }
  for (const [rel, marker, label] of SITES) {
    const src = read(rel);
    const m = marker.exec(src);
    assert.ok(m, `${rel}: could not find ${label} — did it move? update this list`);
    const sp = sqlSpanAround(src, m.index);
    assert.ok(sp, `${rel}: ${label} is not inside a SQL template literal — update this check`);
    const k = `${rel}@${sp[0]}`;
    if (!byStatement.has(k)) byStatement.set(k, { rel, stmt: src.slice(sp[0], sp[1]), labels: [] });
    byStatement.get(k).labels.push(label);
  }
  for (const { rel, stmt, labels } of byStatement.values()) {
    const filters = count(stmt, /notScoredSql\(/g);
    assert.ok(filters >= labels.length,
      `${rel}: ${labels.length} advisory-filtered consumer(s) live in this query (${labels.join('; ')})`
      + ` but it carries only ${filters} filter(s) — one was dropped`);
  }
});

t('the statement extractor really is per-statement — a neighbouring filter cannot satisfy it', () => {
  // Proves the fix above. Two adjacent queries, only the first filtered: asking about the
  // second must NOT see the first's filter. Under the old ±1300-char window it would have.
  const fake = 'a(`SELECT 1 WHERE ' + '${notScoredSql()}' + ' AND x`); b(`SELECT 2 AS marker_here`);';
  const idx = fake.indexOf('marker_here');
  const stmt = sqlStatementAround(fake, idx);
  assert.ok(stmt && stmt.includes('marker_here'), 'must find the statement the marker is in');
  assert.ok(!/notScoredSql\(/.test(stmt), 'and must NOT reach into the neighbouring statement');
});

t('the file-view score and the one-line triage headline both filter', () => {
  const src = read('src/routes/underwriting.js');
  // The file view computes its score in JS from a COUNT..FILTER query rather than the SQL CASE,
  // so it is checked by its own two known call sites instead of the weight fingerprint.
  assert.ok(count(src, FILTER) >= 2,
    'both the risk-score aggregate and the topFinding query must carry the filter');
  assert.ok(/oldest_fatal_days[\s\S]{0,400}?notScoredSql\(\)/.test(src),
    'the risk-score aggregate must be the filtered one');
  assert.ok(/notScoredSql\(\)\}\s*\n\s*ORDER BY CASE severity WHEN 'fatal' THEN 0/.test(src),
    'topFinding must filter before ordering, or an empty file slot can headline the file');
});

t('the digest officer-discovery join filters too — it decides WHO gets emailed', () => {
  const src = read('src/lib/notification-digests.js');
  // This one has no scoring weights at all; it only picks recipients, so the fingerprint check
  // above cannot see it. An unfiltered join here emails officers whose files are clean.
  assert.ok(/FROM staff_users u[\s\S]{0,600}?notScoredSql\('s'\)/.test(src),
    'the LO-digest officer discovery query must exclude advisory-only sources');
});

t('the re-read sweep cannot re-email a dismissed fatal through the cure branch', () => {
  // cure.js emits flood_policy_missing at severity 'fatal', and record() dedupes only on OPEN
  // rows — so without this thread the sweep re-notifies exactly the findings a human dismissed.
  assert.ok(/persistProof\(client, \{[\s\S]{0,1600}?suppressNotify,/.test(read('src/lib/underwriting/store.js')),
    'store.saveAnalysis must thread suppressNotify into cure.persistProof');
  assert.ok(/async function persistProof\([^)]*suppressNotify/.test(read('src/lib/underwriting/cure.js')),
    'cure.persistProof must accept suppressNotify');
  assert.ok(/fromCureNewFinding\(\{[\s\S]{0,200}?suppressNotify,/.test(read('src/lib/underwriting/cure.js')),
    'cure.persistProof must forward suppressNotify into the suggestion payload');
  assert.ok(/function fromCureNewFinding\([^)]*suppressNotify[\s\S]{0,200}?suppressNotify,/.test(read('src/lib/underwriting/ai-suggestions.js')),
    'fromCureNewFinding must carry suppressNotify through to record()');
});

console.log(`\n${n} checks passed.`);
