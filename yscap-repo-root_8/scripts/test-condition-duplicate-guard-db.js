/**
 * ONE CONDITION PER TEMPLATE PER FILE (owner-reported 2026-08-02: "check if there is
 * more than one EMD condition on a file … maybe on certain files if there's any
 * potentials we can get more than 1 EMD condition").
 *
 * There were. `conditions/engine.js` suppressed duplicates by READING the file's
 * items, deciding a template had no instance, and THEN inserting — with nothing in
 * between and no unique constraint underneath. Two passes at the same instant both
 * read "not there" and both inserted. It is ordinary traffic: evaluateApplication
 * runs from the staff completeness save, the details PATCH, the borrower edit, the
 * ClickUp ingest, the file-view sync and the boot sweep, and the note buyer is
 * written from BOTH the portal and ClickUp — so "a staffer saves the note buyer
 * while that card's webhook lands" is the ordinary shape. It affected EVERY
 * rule-driven condition; EMD is just where it was noticed.
 *
 * What this pins:
 *  (A) THE RACE. Concurrent passes on one file produce ONE row per template — the
 *      case that FAILED before the per-file advisory lock (2 EMD + 2 SSN rows).
 *      Also under heavier contention, and the sequential control still passes.
 *  (B) THE CLEANUP is conservative: an UNTOUCHED duplicate is removed and audited;
 *      a duplicate whose second copy has been WORKED is LEFT ALONE rather than
 *      silently discarding somebody's work.
 *  (C) THE LOCK FAILS OPEN — evaluation still happens if the lock cannot be taken.
 *
 * NOTE: a partial unique index was built and then deliberately REMOVED — see
 * db/399's header. Every real insert path already enforces one-per-(file,
 * template) itself; what the index could not live with was the test suite's
 * habit of instantiating one template twice to obtain two independent fixtures.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-duplicate-guard-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const engine = require('../src/lib/conditions/engine');
const { ensureSchema } = require('../src/migrate-boot');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const countOf = async (appId, code) => (await db.query(
  `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2`, [appId, code])).rows[0].n;

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  const apps = [];
  const mkApp = async (lender = 'CorrFirst', status = 'processing') => {
    const id = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,$2,$3) RETURNING id`,
      [borrowerId, status, lender])).rows[0].id;
    apps.push(id); return id;
  };

  try {
    await ensureSchema();
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Dup','Guard',$1) RETURNING id`,
      [`dup-${sfx}@test.local`])).rows[0].id;

    // ================= (A) THE RACE =================
    {
      const app = await mkApp();
      await Promise.all([
        engine.evaluateApplication(app, { reason: 'race-a', notify: false }),
        engine.evaluateApplication(app, { reason: 'race-b', notify: false }),
      ]);
      assert(await countOf(app, 'cond_emd_corrfirst') === 1,
        'TWO CONCURRENT passes produce ONE EMD condition (this produced 2 before the lock)');
      assert(await countOf(app, 'cond_ssn_verify_corrfirst') === 1,
        'and ONE SSN condition (also 2 before the lock)');
    }
    {
      // Heavier contention — six at once, the shape of a webhook burst.
      const app = await mkApp();
      await Promise.all(Array.from({ length: 6 }, (_, i) =>
        engine.evaluateApplication(app, { reason: `burst-${i}`, notify: false })));
      assert(await countOf(app, 'cond_emd_corrfirst') === 1, 'SIX concurrent passes still produce ONE EMD condition');
      assert(await countOf(app, 'rtl_cond_flood') === 1, 'and one flood certificate — the whole rule-driven class, not just EMD');
    }
    {
      const app = await mkApp();
      await engine.evaluateApplication(app, { reason: 's1', notify: false });
      await engine.evaluateApplication(app, { reason: 's2', notify: false });
      assert(await countOf(app, 'cond_emd_corrfirst') === 1, 'the sequential control still produces exactly one (no regression)');
    }

    // ================= (B) THE CLEANUP =================
    {
      // Re-create the pre-fix state by hand — the duplicate the racing engine
      // could produce — then let the next boot's migration clean it up.
      const app = await mkApp();
      await engine.evaluateApplication(app, { reason: 'cleanup', notify: false });
      const emd = (await db.query(
        `SELECT ci.* FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1 AND t.code='cond_emd_corrfirst'`, [app])).rows[0];

      const dupUntouched = (await db.query(
        `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind,
                                      is_required, status, origin_kind)
         VALUES ($1,'application',$2,$3,'borrower','document',true,'outstanding','auto') RETURNING id`,
        [emd.template_id, app, emd.label])).rows[0].id;
      assert(await countOf(app, 'cond_emd_corrfirst') === 2, 'set-up: the file now has the duplicate the old code could create');

      // A SECOND file where BOTH copies have been worked — nothing here is safely
      // removable, so the cleanup must leave the pair for a human. (When only ONE
      // copy is worked the cleanup keeps THAT one and removes the untouched
      // sibling, which is the right answer and is covered by the case above.)
      const worked = await mkApp();
      await engine.evaluateApplication(worked, { reason: 'worked', notify: false });
      const wEmd = (await db.query(
        `SELECT ci.* FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1 AND t.code='cond_emd_corrfirst'`, [worked])).rows[0];
      await db.query(`UPDATE checklist_items SET notes='the team worked the original' WHERE id=$1`, [wEmd.id]);
      const dupWorked = (await db.query(
        `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind,
                                      is_required, status, origin_kind, notes)
         VALUES ($1,'application',$2,$3,'borrower','document',true,'received','auto','a human worked this copy too')
         RETURNING id`, [wEmd.template_id, worked, wEmd.label])).rows[0].id;

      await ensureSchema();   // the next boot runs db/399

      assert(await countOf(app, 'cond_emd_corrfirst') === 1,
        'the cleanup removes the UNTOUCHED duplicate');
      assert((await db.query(`SELECT 1 FROM checklist_items WHERE id=$1`, [dupUntouched])).rows.length === 0,
        'and it removed the DUPLICATE, not the original');
      assert((await db.query(`SELECT 1 FROM checklist_items WHERE id=$1`, [emd.id])).rows.length === 1,
        'the original survives');
      const audited = (await db.query(
        `SELECT 1 FROM audit_log WHERE action='condition_duplicate_removed' AND entity_id=$1 LIMIT 1`, [app])).rows.length;
      assert(audited === 1, 'the removal is audited on the file, not only in a log line');

      assert(await countOf(worked, 'cond_emd_corrfirst') === 2,
        'a duplicate where BOTH copies have been WORKED is LEFT ALONE — never silently discarded');
      assert((await db.query(`SELECT 1 FROM checklist_items WHERE id=$1`, [dupWorked])).rows.length === 1,
        'the worked copy is still there for a human to decide on');

      // …and because a worked duplicate remains, the guard could not be created this
      // boot. That must NOT have broken the boot — which it did not, since we got here.
      assert(true, 'a leftover worked-duplicate does NOT stop the migrations from completing');

    }

    // ================= (C) THE LOCK FAILS OPEN =================
    {
      const real = db.getClient;
      db.getClient = async () => { throw new Error('pool exhausted'); };
      let out = null;
      try {
        const app = await mkApp();
        out = await engine.evaluateApplication(app, { reason: 'nolock', notify: false });
        assert(await countOf(app, 'cond_emd_corrfirst') === 1,
          'if the lock cannot be taken the pass STILL runs — conditions never silently stop attaching');
      } finally { db.getClient = real; }
      assert(out && Array.isArray(out.added), 'and it returns its normal result');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL duplicate-guard assertions passed');
  } catch (e) {
    console.error('FAIL (exception)', (e && e.stack) || e); failures++;
  } finally {
    try { if (apps.length) await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1::uuid[])`, [apps]); } catch (_) {}
    try { if (apps.length) await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::uuid[])`, [apps]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
