/* DB integration test for the 2026-07-19 fixes:
 *   1. never-attempted stray net  (backup.neverAttemptedStrays / forceAttemptDoc)
 *   2. persistent SLO-alert dedup (backup.claimSloAlert / clearSloAlert)
 * Requires a throwaway Postgres in DATABASE_URL. No network/Graph.
 * Run: DATABASE_URL=... node scripts/test-sp-strays-slo-db.js
 */
process.env.SHAREPOINT_BACKUP_ENABLED = process.env.SHAREPOINT_BACKUP_ENABLED || '1';
process.env.MS_TENANT_ID = process.env.MS_TENANT_ID || 't';
process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'c';
process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 's';
process.env.SHAREPOINT_SLO_ALERT_COOLDOWN_MIN = '60';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const backup = require('../src/lib/sharepoint-backup');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

(async () => {
  await ensureSchema();

  // ---- seed a borrower + application so a doc can have a real scope ----------
  const b = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Test','Borrower','t@example.com') RETURNING id`)).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b])).rows[0].id;

  const mkDoc = async (over = {}) => {
    const cols = {
      filename: 'EOI.pdf', content_type: 'application/pdf', doc_kind: 'insurance',
      storage_ref: 'ab/eoi.pdf', storage_provider: 'local', size_bytes: 10,
      application_id: app, borrower_id: b, is_current: true,
      created_at: "now() - interval '35 hours'",
      sharepoint_backup_attempts: 0, ...over,
    };
    // created_at is a raw SQL expression; everything else is a bound param.
    const created = cols.created_at; delete cols.created_at;
    const keys = Object.keys(cols);
    const vals = keys.map((_, i) => `$${i + 1}`);
    const q = `INSERT INTO documents (${keys.join(',')}, created_at)
               VALUES (${vals.join(',')}, ${created}) RETURNING id`;
    return (await db.query(q, keys.map((k) => cols[k]))).rows[0].id;
  };

  // === TEST 1: never-attempted stray net ====================================
  // A well-formed local doc, un-mirrored, attempts=0, error NULL, 35h old.
  const strayLocal = await mkDoc();
  // A doc on a NON-local provider — the class that is invisible to BOTH
  // pendingBatch and stuckDocuments (they filter storage_provider='local').
  const strayS3 = await mkDoc({ storage_provider: 's3', filename: 'other.pdf' });
  // A superseded regen snapshot — must NOT be picked up by the stray net
  // (it settles WITHOUT uploading; force-attempting it would be wrong).
  const phantom = await mkDoc({ doc_kind: 'track_record_html', is_current: false, filename: 'snap.html' });
  // A too-fresh doc (created 10s ago) — inside the grace window, not yet a stray.
  const fresh = await mkDoc({ created_at: "now() - interval '10 seconds'", filename: 'fresh.pdf' });
  // An already-attempted doc (attempts=1, has an error) — not "never attempted".
  const attempted = await mkDoc({ sharepoint_backup_attempts: 1, sharepoint_backup_error: 'boom', filename: 'tried.pdf' });

  const strays = await backup.neverAttemptedStrays(50);
  const strayIds = strays.map((s) => String(s.id));
  ok('stray net FINDS the well-formed never-attempted local doc', strayIds.includes(String(strayLocal)));
  ok('stray net FINDS the non-local-provider doc (otherwise fully invisible)', strayIds.includes(String(strayS3)));
  ok('stray net does NOT pick up a superseded regen snapshot (it settles instead)', !strayIds.includes(String(phantom)));
  ok('stray net does NOT pick up a too-fresh doc (inside the grace window)', !strayIds.includes(String(fresh)));
  ok('stray net does NOT pick up an already-attempted doc', !strayIds.includes(String(attempted)));

  // explainExclusion on the real rows returned by the selector.
  const s3row = strays.find((s) => String(s.id) === String(strayS3));
  ok("explainExclusion names storage_provider='s3' for the invisible doc",
    /storage_provider='s3'/.test(backup.explainExclusion(s3row)));
  const localrow = strays.find((s) => String(s.id) === String(strayLocal));
  ok('explainExclusion falls back to drain/lease-health for a clean local row',
    /drain\/lease health/.test(backup.explainExclusion(localrow)));

  // forceAttemptDoc must MOVE a stray out of "not yet attempted": it either
  // mirrors (not possible here — no live Graph) or records a REAL error so the
  // doc gets attempts>=1 + a non-null error and drops out of the stray set.
  await backup.forceAttemptDoc(strayLocal);
  const after = (await db.query(
    `SELECT sharepoint_backup_attempts AS a, sharepoint_backup_error AS e FROM documents WHERE id=$1`,
    [strayLocal])).rows[0];
  ok('forceAttemptDoc advanced attempts past 0 (no longer "not yet attempted")', Number(after.a) >= 1);
  ok('forceAttemptDoc recorded a REAL error (visible on the card, not blank)', !!after.e);
  const strays2 = await backup.neverAttemptedStrays(50);
  ok('the forced doc is no longer in the never-attempted set', !strays2.map((s) => String(s.id)).includes(String(strayLocal)));

  // A real runOnce sweep must make the invisible non-local doc VISIBLE: its
  // forced attempt fails (no local bytes to read → no Graph touched), and
  // because it's non-'local' the stray sweep cards it in Sync review rather than
  // leaving it buried at attempts=1. (All local docs here also fail their read,
  // but that's fine — we only assert the non-local doc gets a card.)
  await backup.runOnce({ limit: 50 });
  const cardRows = (await db.query(
    `SELECT count(*)::int AS n FROM sync_review_queue WHERE task_id = $1`,
    [`spdoc:${strayS3}`])).rows[0].n;
  ok('a non-local stray becomes VISIBLE — a Sync review card is created for it', cardRows >= 1);
  const s3after = (await db.query(
    `SELECT sharepoint_backup_attempts AS a, sharepoint_backup_error AS e FROM documents WHERE id=$1`,
    [strayS3])).rows[0];
  ok('the non-local stray was actually attempted (attempts>=1, real error recorded)',
    Number(s3after.a) >= 1 && !!s3after.e);

  // === TEST 1c: stall-guard supersede check ==================================
  // A drain pass carries a generation token (seq). If a stall guard spawned a
  // newer pass, the old (superseded) pass must stop immediately instead of
  // uploading concurrently. _runSeq is 0 in this runOnce-only test, so a pass
  // with a stale seq (999999) trips the guard and touches NOTHING; seq=0 (a
  // non-drain caller) is never treated as superseded and proceeds normally.
  const supDoc = await mkDoc({ filename: 'supersede-probe.pdf' });
  await backup.runOnce({ limit: 50, seq: 999999 });
  const supAfter = (await db.query(
    `SELECT sharepoint_backup_attempts AS a FROM documents WHERE id=$1`, [supDoc])).rows[0];
  ok('a superseded pass (stale seq) attempts NOTHING — no concurrent double-drain',
    Number(supAfter.a) === 0);
  await backup.runOnce({ limit: 50, seq: 0 });
  const supAfter2 = (await db.query(
    `SELECT sharepoint_backup_attempts AS a FROM documents WHERE id=$1`, [supDoc])).rows[0];
  ok('the current pass (seq=0) DOES attempt it (guard only stops superseded passes)',
    Number(supAfter2.a) >= 1);

  // === TEST 2: persistent SLO-alert dedup ===================================
  await backup.clearSloAlert();
  const sig = backup.sloSignature([{ id: strayS3 }, { id: phantom }]);
  ok('first claim for a fresh episode WINS (alert is sent)', (await backup.claimSloAlert(sig)) === true);
  ok('second claim for the SAME episode LOSES (no duplicate email on restart)', (await backup.claimSloAlert(sig)) === false);
  ok('a THIRD claim (another restart/instance) still LOSES within the cooldown', (await backup.claimSloAlert(sig)) === false);
  const sig2 = backup.sloSignature([{ id: strayS3 }, { id: phantom }, { id: strayLocal }]);
  ok('a DIFFERENT stuck set (new problem) WINS immediately — a real new alert', (await backup.claimSloAlert(sig2)) === true);
  ok('the new set then LOSES on repeat (deduped too)', (await backup.claimSloAlert(sig2)) === false);
  // Recovery clears the cooldown so the next breach alerts at once.
  await backup.clearSloAlert();
  ok('after recovery (clearSloAlert), the same episode WINS again', (await backup.claimSloAlert(sig)) === true);
  // Expiry path: force the row to appear expired → next claim wins.
  await db.query(`UPDATE sync_locks SET expires_at = now() - interval '1 minute' WHERE lock_key='sp-slo-alert'`);
  ok('an EXPIRED cooldown lets the same episode alert again', (await backup.claimSloAlert(sig)) === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
