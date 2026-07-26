/* DB integration test for the 2026-07-19 fixes:
 *   1. never-attempted stray net  (backup.neverAttemptedStrays / forceAttemptDoc)
 *   2. persistent SLO-alert dedup (backup.claimSloAlert / clearSloAlert)
 * Requires a throwaway Postgres in DATABASE_URL. No network/Graph.
 * Run: DATABASE_URL=... node scripts/test-sp-strays-slo-db.js
 */
// Requires DATABASE_URL with a reachable Postgres. Skips cleanly otherwise (CI has no DB).
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-strays-slo-db (no DATABASE_URL)'); process.exit(0); }

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

  // Idempotent setup: this suite runs in `npm test`, which may re-run against a
  // persistent DB — clear any prior fixtures (anchored on the fixed email) so the
  // fixed-email borrower insert never collides on a second run.
  const prior = (await db.query(`SELECT id FROM borrowers WHERE email='t@example.com'`)).rows.map((r) => r.id);
  if (prior.length) {
    await db.query(`DELETE FROM sync_review_queue WHERE task_id IN (
        SELECT 'spdoc:'||d.id FROM documents d WHERE d.borrower_id = ANY($1)
        UNION SELECT 'app:'||a.id FROM applications a WHERE a.borrower_id = ANY($1))`, [prior]);
    await db.query(`DELETE FROM documents WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM applications WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [prior]);
  }

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

  // === TEST 3: worker-liveness heartbeat + dead-man's-switch watchdog ========
  // The #1 fix from the 2026-07-20 freeze: watch the WORKER, not just backlog.
  await backup.clearAlert('sp-liveness-alert');
  await db.query(`DELETE FROM sync_locks WHERE lock_key='sp-drain-heartbeat'`);
  ok('heartbeatStaleSec is null before any pass has completed', (await backup.heartbeatStaleSec()) === null);
  await backup.recordHeartbeat({ scanned: 0 });
  const freshAge = await backup.heartbeatStaleSec();
  ok('a completed pass stamps a FRESH heartbeat (age ~0)', freshAge != null && freshAge < 30);
  const reconFresh = await backup.reconciliation();
  ok('reconciliation exposes worker liveness and is NOT stalled when fresh',
    reconFresh.worker && reconFresh.worker.stalled === false && reconFresh.worker.lastPassAgeSec != null);
  // Simulate a freeze: age the heartbeat far past the grace window.
  const grace = backup.heartbeatGraceSec();
  await db.query(`UPDATE sync_locks SET expires_at = now() - make_interval(secs => $1) WHERE lock_key='sp-drain-heartbeat'`, [grace * 3]);
  const staleAge = await backup.heartbeatStaleSec();
  ok('a frozen worker shows a STALE heartbeat (age > grace)', staleAge != null && staleAge > grace);
  const reconStalled = await backup.reconciliation();
  ok('reconciliation marks the worker STALLED when the heartbeat is old', reconStalled.worker.stalled === true);
  ok('reconciliation.healthy is FALSE when the worker is stalled (the freeze lesson)', reconStalled.healthy === false);
  // Watchdog past 2× grace self-heals AND alerts once (persistent dedup).
  await backup.clearAlert('sp-liveness-alert');
  await backup.checkDrainLiveness();
  const livAlert = (await db.query(`SELECT count(*)::int n FROM sync_locks WHERE lock_key='sp-liveness-alert'`)).rows[0].n;
  ok('the liveness watchdog raised the stall alert (deduped, distinct from backlog)', livAlert >= 1);
  // Worsening outage (heartbeat now even older) must NOT re-page within the
  // cooldown — a stable signature, not an escalating per-bucket one.
  await db.query(`UPDATE sync_locks SET expires_at = now() - make_interval(secs => $1) WHERE lock_key='sp-drain-heartbeat'`, [grace * 6]);
  const holderBefore = (await db.query(`SELECT holder FROM sync_locks WHERE lock_key='sp-liveness-alert'`)).rows[0].holder;
  await backup.checkDrainLiveness();   // still within cooldown → must NOT re-raise
  const livRows2 = (await db.query(`SELECT holder FROM sync_locks WHERE lock_key='sp-liveness-alert'`)).rows;
  ok('a WORSENING outage does not re-page within cooldown (once-per-episode)',
    livRows2.length === 1 && livRows2[0].holder === holderBefore);
  // Recovery: a fresh heartbeat + a watchdog pass auto-clears the alert.
  await db.query(`UPDATE sync_locks SET expires_at = now() + make_interval(secs => $1) WHERE lock_key='sp-drain-heartbeat'`, [grace]);
  await backup.checkDrainLiveness();
  const livAlert3 = (await db.query(`SELECT count(*)::int n FROM sync_locks WHERE lock_key='sp-liveness-alert'`)).rows[0].n;
  ok('recovery auto-clears the liveness alert (silent again)', livAlert3 === 0);

  // === TEST 3: SLO alert BOMBARDMENT fix — per-document dedup (round-2 audit F1) =
  // A stuck doc alerts ONCE; repeat polls of the same set stay quiet; a genuinely
  // NEW stuck doc alerts; a doc resolving/reshuffling never re-alerts.
  const notify = require('../src/lib/notify');
  const realNotifyAdmins = notify.notifyAdmins;
  let alertEmails = 0;
  notify.notifyAdmins = async () => { alertEmails += 1; };   // stub the email fan-out
  process.env.SHAREPOINT_SLO_ALERT_COOLDOWN_MIN = '60';
  await backup.clearSloAlert();
  await db.query(`UPDATE documents SET sharepoint_slo_alerted_at = NULL`);
  const stuck1 = await mkDoc({ filename: 'Review DOV.pdf', storage_ref: 'zz/nope1.pdf',
    sharepoint_backup_attempts: 9, sharepoint_backup_error: '[permanent] test', created_at: "now() - interval '8 hours'" });
  await backup.checkBacklogSlo();
  ok('a stuck doc triggers ONE alert email', alertEmails === 1);
  await backup.checkBacklogSlo();
  ok('repeat poll of the SAME stuck set sends NO new email (bombardment fixed)', alertEmails === 1);
  const stuck2 = await mkDoc({ filename: '825 BISHOP EOI.pdf', storage_ref: 'zz/nope2.pdf',
    sharepoint_backup_attempts: 9, sharepoint_backup_error: '[permanent] test', created_at: "now() - interval '8 hours'" });
  await backup.checkBacklogSlo();
  ok('a genuinely NEW stuck doc triggers a fresh alert', alertEmails === 2);
  await backup.checkBacklogSlo();
  ok('another repeat poll stays quiet', alertEmails === 2);
  await db.query(`UPDATE documents SET sharepoint_backed_up_at = now() WHERE id = $1`, [stuck1]);
  await backup.checkBacklogSlo();
  ok('a doc resolving/reshuffling does NOT re-alert (the churn that caused the flood)', alertEmails === 2);

  // === TEST 4: never-mirror docs are NOT counted as backlog (round-2 audit F2) ===
  const heter = await mkDoc({ filename: 'HeterIska.pdf', doc_kind: 'heter_iska_signed', storage_ref: 'zz/heter.pdf',
    sharepoint_backup_attempts: 9, created_at: "now() - interval '30 hours'" });
  const stuckList = await backup.stuckDocuments(200);
  ok('a never-mirror (heter iska) doc is NOT listed as stuck', !stuckList.some((d) => d.id === heter));
  const apPhoto = await mkDoc({ filename: 'appraisal-photo-1.png', doc_kind: 'appraisal_photo', storage_ref: 'zz/ph.png',
    created_at: "now() - interval '30 hours'" });
  const stuckList2 = await backup.stuckDocuments(200);
  ok('an appraisal-photo doc is NOT listed as stuck (never-mirror kind)', !stuckList2.some((d) => d.id === apPhoto));
  notify.notifyAdmins = realNotifyAdmins;   // restore

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
