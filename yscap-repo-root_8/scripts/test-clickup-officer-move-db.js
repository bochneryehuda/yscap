/* ASSIGNING AN OFFICER MOVES THE CARD OUT OF LEAD CAPTURE — against a REAL database,
 * with ClickUp STUBBED (nothing leaves this machine).
 *
 * Owner-directed 2026-08-21, and the owner asked for the research first: *"Do a lot of
 * research on how to make sure to do that and not mess up other stuff."* So what this proves
 * is mostly the NOT-messing-up half — every case where the right answer is to do nothing.
 *
 *   1. the owner's case end to end — a Lead Capture card whose file gains an officer lands in
 *      that officer's folder, in the SAME list a brand-new card would have been created in,
 *      carrying its custom fields;
 *   2. the caches follow the card (both of them — the inbound side reads them to work out
 *      whose file this is);
 *   3. every refusal: no card, no officer, an officer the registry cannot place, a card that
 *      is NOT in Lead Capture, and a card already home;
 *   4. REASSIGNMENT IS NOT AUTOMATED — a card already in an officer's folder is left alone
 *      even when the file's officer is somebody else now;
 *   5. the status rules against the REAL status sets — mapped when it must be, and REFUSED
 *      (with nothing sent) when it cannot be carried across without changing meaning;
 *   6. the switches: outbound off and dry run both send nothing;
 *   7. read-after-write — a card that lands in the WRONG folder is reported AND does not get
 *      our caches rewritten to say it moved;
 *   8. the back-book sweep, and that it never touches a card a human already filed by hand.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-clickup-officer-move-db.js
 */
'use strict';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

if (!process.env.DATABASE_URL) { console.log('SKIP test-clickup-officer-move-db (no DATABASE_URL)'); process.exit(0); }

process.env.CLICKUP_SYNC_ENABLED = '1';
process.env.CLICKUP_OUTBOUND_ENABLED = '1';

const path = require('path');
const db = require('../src/db');

// ── STUB ClickUp BEFORE anything requires it ────────────────────────────────
// The whole point is that no request leaves this machine; the stub also RECORDS every call
// so "nothing was sent" is a thing the test can actually assert rather than assume.
const clientPath = require.resolve('../src/clickup/client');
const sent = [];
const stub = {
  _task: null,
  _afterTask: null,
  _lists: {},
  _statuses: {},
  getTask: async (id) => { sent.push(['getTask', id]); return stub._afterTask && sent.filter((c) => c[0] === 'move').length ? stub._afterTask : stub._task; },
  getFolderLists: async (folderId) => { sent.push(['getFolderLists', folderId]); return { lists: stub._lists[String(folderId)] || [] }; },
  getList: async (listId) => { sent.push(['getList', listId]); return { id: listId, statuses: stub._statuses[String(listId)] || [] }; },
  moveTaskHomeList: async (team, taskId, listId, body) => { sent.push(['move', taskId, listId, body]); return { ok: true }; },
};
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };

const routing = require('../src/clickup/routing');
const M = require('../src/clickup/officer-move');

const LEAD = routing.LEAD_CAPTURE_FOLDER;
// A real officer from the live registry, and the folder + list a create would use.
const OFFICER_NAME = 'Joshua Freidlander';
const OFF_FOLDER = routing.LOAN_OFFICERS[OFFICER_NAME].pipeline;
const OFF_LIST = '901111045437';
const LEAD_LIST = '901114063752';

const S = (names) => names.map((n, i) => ({ id: `sc_${i}_${n.replace(/\W/g, '')}`, status: n }));
const OFFICER_STATUSES = S(['starting', 'assigned to processor', 'in underwriting',
  'delegated ctc submission', 'ctc (4-email)', 'closed (6-email funded)', 'declined']);
// Deliberately narrow: no landing for `approved` at all, so the refusal can be exercised.
const NARROW_STATUSES = S(['starting', 'in underwriting']);

const clear = () => { sent.length = 0; };
const moveCalls = () => sent.filter((c) => c[0] === 'move');

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let seq = 0;
  try {
    stub._lists[String(OFF_FOLDER)] = [{ id: OFF_LIST, name: 'List' }];
    stub._statuses[String(OFF_LIST)] = OFFICER_STATUSES;

    const officer = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,$2,'loan_officer',true,false,'x',0) RETURNING id`,
      [`om-off-${sfx}@yscapgroup.com`, OFFICER_NAME])).rows[0].id;
    // Deliberately a name the registry has NEVER heard of — a misspelling is never guessed past.
    const stranger = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Zoltan Nonexistent','loan_officer',true,false,'x',0) RETURNING id`,
      [`om-str-${sfx}@yscapgroup.com`])).rows[0].id;
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Move','Test',$1) RETURNING id`,
      [`om-bo-${sfx}@test.local`])).rows[0].id;

    const mkFile = async (over = {}) => {
      // The counter advances for EVERY file, including a card-less one — it also carries the
      // loan number's uniqueness, and incrementing it inside the taskId expression skipped it
      // on the `taskId: null` case and collided on uq_applications_ys_loan_number.
      const n = ++seq;
      const taskId = over.taskId === null ? null : (over.taskId || `tk-${sfx}-${n}`);
      const id = (await db.query(
        `INSERT INTO applications(borrower_id,status,ys_loan_number,loan_officer_id,loan_officer_name,
                                  clickup_pipeline_task_id,clickup_folder_id,property_address)
         VALUES($1,'processing',$2,$3,$4,$5,$6,'{"oneLine":"3 Move St","city":"Lakewood","state":"NJ","zip":"08701"}')
         RETURNING id`,
        [bor, `OM${sfx.slice(-6)}${String(n).padStart(3, '0')}`,
          'officerId' in over ? over.officerId : officer,
          'officerName' in over ? over.officerName : OFFICER_NAME,
          taskId, over.folderId === undefined ? LEAD : over.folderId])).rows[0].id;
      if (taskId) await db.query(
        `INSERT INTO clickup_task_index (task_id, application_id, folder_id) VALUES ($1,$2,$3)
         ON CONFLICT (task_id) DO UPDATE SET application_id=EXCLUDED.application_id, folder_id=EXCLUDED.folder_id`,
        [taskId, id, over.folderId === undefined ? LEAD : over.folderId]);
      return { id, taskId };
    };
    const card = (taskId, folderId, listId, status) => ({
      id: taskId, folder: { id: folderId }, list: { id: listId },
      status: { id: `sc_cur_${status.replace(/\W/g, '')}`, status },
      custom_fields: [{ id: require('../src/clickup/fields').SHARED.portalFileId, value: 'x' }],
    });

    // -------------------------------------------------- 1 + 2. the owner's case
    {
      const f = await mkFile();
      stub._task = card(f.taskId, LEAD, LEAD_LIST, 'starting');
      stub._afterTask = card(f.taskId, OFF_FOLDER, OFF_LIST, 'starting');
      clear();
      const r = await M.maybeMoveToOfficerFolder(f.id, { dbc: db });
      eq('1a the card moves', [r.moved, r.toFolder, r.toList], [true, String(OFF_FOLDER), String(OFF_LIST)]);
      eq('1b …exactly one move call was sent', moveCalls().length, 1);
      eq('1c …to the list a brand-new card would be created in', moveCalls()[0][2], OFF_LIST);
      eq('1d …carrying the custom fields, which ClickUp does NOT do on its own',
        moveCalls()[0][3].move_custom_fields, true);
      ok('1e …with no status mapping, because the status exists on both lists',
        !('status_mappings' in moveCalls()[0][3]));
      eq('1f …and it verified', r.verified, true);

      const app = (await db.query(`SELECT clickup_folder_id FROM applications WHERE id=$1`, [f.id])).rows[0];
      eq('2a the file’s folder cache follows the card', app.clickup_folder_id, String(OFF_FOLDER));
      const idx = (await db.query(`SELECT folder_id FROM clickup_task_index WHERE task_id=$1`, [f.taskId])).rows[0];
      eq('2b …and so does the crosswalk the inbound side reads', idx.folder_id, String(OFF_FOLDER));
      const a = (await db.query(
        `SELECT detail FROM audit_log WHERE entity_id=$1 AND action='clickup_officer_move'`, [f.id])).rows[0];
      ok('2c the move is on the record, naming who and how they were matched',
        !!a && a.detail.officer === OFFICER_NAME && !!a.detail.matchedBy);
    }

    // -------------------------------------------------- 3. the refusals
    {
      const f = await mkFile({ taskId: null });
      clear();
      eq('3a a file with no card has nothing to move', (await M.maybeMoveToOfficerFolder(f.id, { dbc: db })).reason, 'no_task');
      eq('3b …and nothing was sent', sent.length, 0);
    }
    {
      const f = await mkFile({ officerId: null, officerName: null });
      clear();
      eq('3c a file with no officer is still a genuine lead',
        (await M.maybeMoveToOfficerFolder(f.id, { dbc: db })).reason, 'no_officer');
      eq('3d …and nothing was sent', sent.length, 0);
    }
    {
      // The 2026-08-21 routing bug's shape: an officer the registry cannot place. Filing that
      // card ANYWHERE would be a guess, so it stays put and is reported.
      const f = await mkFile({ officerId: stranger, officerName: 'Zoltan Nonexistent' });
      clear();
      eq('3e an officer the registry cannot place is refused',
        (await M.maybeMoveToOfficerFolder(f.id, { dbc: db })).reason, 'officer_unrouted');
      eq('3f …and nothing was sent', moveCalls().length, 0);
    }
    {
      const f = await mkFile({ folderId: OFF_FOLDER });
      stub._task = card(f.taskId, OFF_FOLDER, OFF_LIST, 'starting');
      clear();
      eq('3g a card already home is a no-op',
        (await M.maybeMoveToOfficerFolder(f.id, { dbc: db })).reason, 'already_home');
      eq('3h …and nothing was sent', moveCalls().length, 0);
    }

    // -------------------------------------------------- 4. reassignment is NOT automated
    {
      // The file's officer is Joshua; the card physically lives in somebody ELSE's folder.
      // Pulling a live file out of the folder its owner keeps it in is a much bigger decision
      // than filing an unfiled one, and the owner did not ask for it.
      const other = routing.LOAN_OFFICERS['Esther Bochner'].pipeline;
      const f = await mkFile({ folderId: other });
      stub._task = card(f.taskId, other, '901108852595', 'starting');
      clear();
      const r = await M.maybeMoveToOfficerFolder(f.id, { dbc: db });
      eq('4a a card in ANOTHER officer’s folder is left alone', r.reason, 'not_in_lead_capture');
      eq('4b …and nothing was sent', moveCalls().length, 0);
      eq('4c …and our cached folder was not rewritten',
        (await db.query(`SELECT clickup_folder_id FROM applications WHERE id=$1`, [f.id])).rows[0].clickup_folder_id,
        String(other));
    }

    // -------------------------------------------------- 5. the status rules
    {
      // `approved` lives only on the Lead Capture list. It IS carryable — through the
      // word-preserving landing status — so the move happens WITH a mapping.
      const f = await mkFile();
      stub._task = card(f.taskId, LEAD, LEAD_LIST, 'approved');
      stub._afterTask = card(f.taskId, OFF_FOLDER, OFF_LIST, 'delegated ctc submission');
      clear();
      const r = await M.maybeMoveToOfficerFolder(f.id, { dbc: db });
      eq('5a a Lead-Capture-only status still moves', r.moved, true);
      const body = moveCalls()[0][3];
      eq('5b …carrying an explicit status mapping', body.status_mappings.length, 1);
      const dest = OFFICER_STATUSES.find((s) => s.id === body.status_mappings[0].destination_status_id);
      eq('5c …to the word-preserving landing status', dest.status, 'delegated ctc submission');
      eq('5d …and the borrower-facing word did not change, which is the whole point', r.verified, true);
    }
    {
      // Now a destination that cannot express it at all. Refuse — never guess a status.
      stub._statuses[String(OFF_LIST)] = NARROW_STATUSES;
      const f = await mkFile();
      stub._task = card(f.taskId, LEAD, LEAD_LIST, 'approved');
      clear();
      const r = await M.maybeMoveToOfficerFolder(f.id, { dbc: db });
      eq('5e a status that cannot be carried across REFUSES the whole move',
        r.reason, 'landing_status_missing_in_destination');
      eq('5f …and nothing was sent', moveCalls().length, 0);
      const a = (await db.query(
        `SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND action='clickup_officer_move_refused'`, [f.id])).rows[0].n;
      eq('5g …but it is never SILENT — the refusal is recorded', a, 1);
      stub._statuses[String(OFF_LIST)] = OFFICER_STATUSES;
    }

    // -------------------------------------------------- 6. the switches
    {
      const f = await mkFile();
      stub._task = card(f.taskId, LEAD, LEAD_LIST, 'starting');
      process.env.CLICKUP_OFFICER_MOVE_DISABLED = '1';
      clear();
      eq('6a the off-switch stops it dead', (await M.maybeMoveToOfficerFolder(f.id, { dbc: db })).reason, 'disabled');
      eq('6b …and nothing was sent', sent.length, 0);
      delete process.env.CLICKUP_OFFICER_MOVE_DISABLED;

      process.env.CLICKUP_DRYRUN = '1';
      delete require.cache[require.resolve('../src/config')];
      delete require.cache[require.resolve('../src/clickup/officer-move')];
      const M2 = require('../src/clickup/officer-move');
      clear();
      const r = await M2.maybeMoveToOfficerFolder(f.id, { dbc: db });
      eq('6c a dry run reports what it WOULD do', r.reason, 'dry_run');
      eq('6d …and sends nothing', moveCalls().length, 0);
      delete process.env.CLICKUP_DRYRUN;
      delete require.cache[require.resolve('../src/config')];
      delete require.cache[require.resolve('../src/clickup/officer-move')];
    }

    // -------------------------------------------------- 7. read-after-write
    {
      const M3 = require('../src/clickup/officer-move');
      const f = await mkFile();
      stub._task = card(f.taskId, LEAD, LEAD_LIST, 'starting');
      // The card comes back naming a DIFFERENT folder — the one case where writing the
      // destination into our cache would be a lie the sweep would then believe.
      stub._afterTask = card(f.taskId, '90115017331', '901108444174', 'starting');
      clear();
      const r = await M3.maybeMoveToOfficerFolder(f.id, { dbc: db });
      eq('7a a move that does not verify says so', [r.moved, r.verified], [true, false]);
      eq('7b …it is recorded, loudly',
        (await db.query(`SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND action='clickup_officer_move_unverified'`, [f.id])).rows[0].n, 1);
      eq('7c …and our cache is NOT rewritten to claim it moved',
        (await db.query(`SELECT clickup_folder_id FROM applications WHERE id=$1`, [f.id])).rows[0].clickup_folder_id, String(LEAD));
      stub._afterTask = null;
    }

    // -------------------------------------------------- 8. the back book
    {
      const M4 = require('../src/clickup/officer-move');
      const f = await mkFile();
      stub._task = card(f.taskId, LEAD, LEAD_LIST, 'starting');
      stub._afterTask = card(f.taskId, OFF_FOLDER, OFF_LIST, 'starting');
      clear();
      const r = await M4.sweepLeadCaptureOnce({ dbc: db, limit: 50 });
      ok('8a the sweep reaches cards already sitting in Lead Capture', r.scanned > 0 && r.moved > 0);
      eq('8b …and the card really did move',
        (await db.query(`SELECT clickup_folder_id FROM applications WHERE id=$1`, [f.id])).rows[0].clickup_folder_id,
        String(OFF_FOLDER));

      // A human filed one by hand while our cached column still said Lead Capture. The sweep
      // re-reads every card live, so it must leave that one exactly where the person put it.
      const h = await mkFile();
      stub._task = card(h.taskId, '90115017331', '901108444174', 'starting');
      stub._afterTask = null;
      clear();
      await M4.sweepLeadCaptureOnce({ dbc: db, limit: 50 });
      const moved = moveCalls().filter((c) => c[1] === h.taskId);
      eq('8c a card a human already filed by hand is never moved back', moved.length, 0);
    }
  } catch (e) {
    fail++; console.log('FAIL threw:', (e && e.stack) || e);
  } finally {
    await db.query(`DELETE FROM clickup_task_index WHERE task_id LIKE $1`, [`tk-${sfx}-%`]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE ys_loan_number LIKE $1`, [`OM${sfx.slice(-6)}%`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email = $1`, [`om-bo-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`om-%-${sfx}@yscapgroup.com`]).catch(() => {});
    console.log(`${pass} passed, ${fail} failed`);
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
