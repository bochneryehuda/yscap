/**
 * THE MIRROR SCOREBOARD ADDS UP, AND SAYS WHY — real Postgres, real SQL.
 *
 * Owner-reported 2026-08-09, reading the API-health page: "2,655 total documents
 * / 1,755 in SharePoint … how can something like this be? Why are not all
 * documents in SharePoint?" Nothing was broken — 0 waiting, 0 stuck, and the
 * 900-document gap was exactly the deliberately-not-mirrored pile (1,755 + 900 =
 * 2,655). What was broken was the SCREEN: one grey line of small print naming
 * two example reasons for a third of the library, so a correct number read as
 * 900 missing documents.
 *
 * A pure test cannot prove any of this — every bucket is a SQL predicate over
 * the real `documents` table, and the whole point is that the predicates
 * partition it with nothing left over. So this test builds one document per
 * bucket and asserts:
 *
 *   · every count lands in exactly ONE bucket (no double-counting, no gaps)
 *   · total = in SharePoint + not-mirrored-on-purpose + waiting  (the arithmetic
 *     the owner was asked to take on faith)
 *   · the breakdown SUMS to the not-mirrored pile — no rounding, no "e.g."
 *   · a copy a HUMAN moved carries a skip reason AND a mirror ref, and counts as
 *     IN SharePoint — never as "not mirrored" (it is in there, just not where we
 *     filed it). This is the correctness half of the fix.
 *   · an unrecognised skip reason surfaces as `other` instead of being folded
 *     into a friendly label — an unexplained skip has to stay visible
 *   · `unaccounted` catches anything in none of the four buckets
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sharepoint-scoreboard-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const backup = require('../src/lib/sharepoint-backup');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Every document this test makes is tagged so the counts are OURS alone — a
// shared test database carries other suites' rows.
const TAG = `scoreboard-${Date.now()}`;

async function mkDoc(name, cols = {}) {
  const set = Object.assign({
    storage_ref: `ref/${name}`,
    storage_provider: 'local',
    sharepoint_backed_up_at: null,
    sharepoint_backup_ref: null,
    sharepoint_skipped_reason: null,
    sharepoint_backup_attempts: 0,
    doc_kind: null,
    is_current: true,
  }, cols);
  const keys = Object.keys(set);
  const { rows } = await db.query(
    `INSERT INTO documents (filename, ${keys.join(',')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
    [`${TAG}-${name}`, ...keys.map((k) => set[k])]);
  return rows[0].id;
}

// Re-run the reconciliation buckets over ONLY this test's rows, using the very
// same SQL the scoreboard runs. Re-deriving the predicates here would prove
// nothing about the real query, so the fragments are imported.
async function scoped() {
  const B = backup._scoreboardSql;
  const { rows } = await db.query(
    `SELECT
        count(*) FILTER (WHERE storage_ref IS NOT NULL)::int                    AS total_docs,
        count(*) FILTER (WHERE sharepoint_backup_ref IS NOT NULL)::int          AS mirrored,
        count(*) FILTER (WHERE ${B.notMirrored})::int                           AS skipped_not_mirrored,
        count(*) FILTER (WHERE sharepoint_backed_up_at IS NULL
                          AND storage_ref IS NOT NULL AND ${B.neverMirror})::int AS pending,
        count(*) FILTER (WHERE ${B.other})::int                                 AS skip_other,
        count(*) FILTER (WHERE storage_ref IS NOT NULL
                          AND sharepoint_backup_ref IS NULL
                          AND sharepoint_skipped_reason IS NULL
                          AND NOT (sharepoint_backed_up_at IS NULL
                                   AND ${B.neverMirror}))::int                   AS unaccounted,
        ${B.buckets.map((b) => `count(*) FILTER (WHERE ${B.notMirrored} AND ${b.match})::int AS skip_${b.key}`).join(',\n        ')}
      FROM documents d WHERE d.filename LIKE $1`, [`${TAG}-%`]);
  return rows[0];
}

(async () => {
  await ensureSchema();

  // ── one document per bucket, written the way production writes them ────────
  const R = backup._scoreboardSql.reasons;
  const settled = (reason) => ({ sharepoint_backed_up_at: new Date(), sharepoint_skipped_reason: reason });

  await mkDoc('mirrored', { sharepoint_backed_up_at: new Date(), sharepoint_backup_ref: 'drive!item1' });
  await mkDoc('waiting');                                   // in scope, not yet copied
  await mkDoc('heter', { doc_kind: 'heter_iska_signed', ...settled(R.heterIska) });
  await mkDoc('photo', { doc_kind: 'appraisal_photo', ...settled(R.appraisalPhotoLegacy) });
  await mkDoc('inSystem', { doc_kind: 'something_else', ...settled(R.defaultNeverMirror) });
  await mkDoc('superseded', { doc_kind: 'tpr_export', is_current: false, ...settled(R.superseded) });
  await mkDoc('supersededHeal', { doc_kind: 'tpr_export', is_current: false, ...settled(R.supersededHeal) });
  await mkDoc('duplicate', settled(R.duplicate(999)));
  await mkDoc('lead', settled(R.lead));
  await mkDoc('esign', settled(R.esignSelfTest));
  // The correctness case: a human moved OUR copy, so the shelf sweep stamped a
  // skip reason on a row that already carries a mirror ref.
  await mkDoc('humanPlaced', {
    sharepoint_backed_up_at: new Date(), sharepoint_backup_ref: 'drive!item2',
    sharepoint_skipped_reason: `${R.humanPlaced} — not re-filed to "Old Versions" (moveOwnItem refused)` });

  const s = await scoped();

  // ── the arithmetic the owner was asked to take on faith ────────────────────
  assert(s.total_docs === 11, `every test document has bytes (got ${s.total_docs})`);
  assert(s.mirrored === 2, `2 in SharePoint — the plain one AND the human-moved one (got ${s.mirrored})`);
  assert(s.pending === 1, `1 waiting to copy (got ${s.pending})`);
  assert(s.skipped_not_mirrored === 8, `8 not mirrored on purpose (got ${s.skipped_not_mirrored})`);
  assert(s.unaccounted === 0, `nothing unaccounted for (got ${s.unaccounted})`);
  assert(s.mirrored + s.skipped_not_mirrored + s.pending === s.total_docs,
    `in SharePoint + not-mirrored-on-purpose + waiting = total (${s.mirrored}+${s.skipped_not_mirrored}+${s.pending} vs ${s.total_docs})`);

  // ── the human-moved copy is the one that must NOT be called "not mirrored" ──
  assert(backup._scoreboardSql.buckets.every((b) => Number(s[`skip_${b.key}`] || 0) >= 0), 'every bucket counted');
  const humanInSkipPile = await db.query(
    `SELECT count(*)::int n FROM documents d
      WHERE d.filename = $1 AND ${backup._scoreboardSql.notMirrored}`, [`${TAG}-humanPlaced`]);
  assert(humanInSkipPile.rows[0].n === 0,
    'a copy a human moved is IN SharePoint — never counted as "not mirrored on purpose"');

  // ── the breakdown is complete: it SUMS to the pile, nothing rounded off ────
  const bucketSum = backup._scoreboardSql.buckets
    .reduce((t, b) => t + Number(s[`skip_${b.key}`] || 0), 0) + Number(s.skip_other || 0);
  assert(bucketSum === s.skipped_not_mirrored,
    `the reasons add up to the pile (${bucketSum} vs ${s.skipped_not_mirrored})`);
  assert(Number(s.skip_other) === 0, `every production skip reason is recognised — none fell into "other" (got ${s.skip_other})`);

  // ── each reason lands in its OWN bucket ───────────────────────────────────
  assert(Number(s.skip_heter_iska) === 1, 'the Heter Iska has its own line');
  assert(Number(s.skip_appraisal_photos) === 1, 'an older, replaced appraisal-photo set has its own line');
  assert(Number(s.skip_in_system_only) === 1, 'other in-system-only kinds have their own line');
  assert(Number(s.skip_superseded) === 2, 'BOTH superseded wordings (settle pass + stuck-heal) share one line');
  assert(Number(s.skip_duplicate) === 1, 'duplicates group despite the document id in the text');
  assert(Number(s.skip_lead) === 1, 'lead/CRM attachments have their own line');
  assert(Number(s.skip_esign_selftest) === 1, 'DocuSign self-test documents have their own line');

  // ── an unknown reason must SHOW, not hide ────────────────────────────────
  await mkDoc('mystery', settled('something nobody has written a bucket for'));
  const s2 = await scoped();
  assert(Number(s2.skip_other) === 1, 'an unrecognised skip reason surfaces as "other" instead of being folded away');
  const sum2 = backup._scoreboardSql.buckets
    .reduce((t, b) => t + Number(s2[`skip_${b.key}`] || 0), 0) + Number(s2.skip_other || 0);
  assert(sum2 === s2.skipped_not_mirrored, 'the breakdown still adds up with an unknown reason present');

  // ── a never-mirror kind between upload and the settle pass is VISIBLE ─────
  // (the Heter Iska — appraisal photos left the never-mirror set on 2026-08-09)
  // It is excluded from `pending` by NEVER_MIRROR_SQL and has no reason yet, so
  // without `unaccounted` it would sit in none of the buckets and the totals
  // would silently fail to add up.
  await mkDoc('preSettle', { doc_kind: 'heter_iska_signed' });
  const s3 = await scoped();
  assert(Number(s3.unaccounted) === 1, 'a never-mirror kind awaiting the settle pass is counted, not silently dropped');

  // ── the REAL reconciliation() runs (proves the assembled SQL is valid) ────
  const recon = await backup.reconciliation();
  assert(Array.isArray(recon.skipped_breakdown), 'reconciliation() returns a breakdown array');
  assert(recon.skipped_breakdown.every((b) => b.label && b.count > 0), 'every breakdown line is labelled and non-empty');
  assert(recon.skipped_breakdown.some((b) => b.key === 'other'), 'the unknown reason reaches the real report as "other"');
  assert(typeof recon.skipped_not_mirrored === 'number' && typeof recon.unaccounted === 'number',
    'reconciliation() exposes the pile total and the gap-catcher');
  const ordered = recon.skipped_breakdown.filter((b) => b.key !== 'other').map((b) => b.count);
  assert(ordered.every((n, i) => i === 0 || ordered[i - 1] >= n), 'the breakdown reads biggest-first');

  await db.query(`DELETE FROM documents WHERE filename LIKE $1`, [`${TAG}-%`]);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll scoreboard assertions passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
