'use strict';
/**
 * GROUND-UP CONSTRUCTION: the FEASIBILITY REPORT and the GC INFORMATION conditions
 * (owner-directed 2026-08-20; db/601).
 *
 * The owner asked for two more conditions in the construction section — the one that
 * already holds the construction budget, the Scope of Work and plans & permits — on
 * every ground-up construction file, previous files included. What this pins:
 *
 *  (A) The TEMPLATES themselves, read LIVE out of the database, so this fails the day
 *      db/601 stops applying (or db/285 wins the boot and leaves the feasibility
 *      condition library-only again).
 *  (B) ONE DEFINITION OF GROUND-UP: both templates carry the SAME rule tree, that tree
 *      is VALID against the field registry, and it reads a file as ground-up from the
 *      program OR the rehab type — the same three columns generateChecklist already
 *      reads for the ground-up plans & permits placeholder.
 *  (C) The ENGINE puts both on a ground-up file — attached by the engine itself, not
 *      only by a backfill — and on NO other file.
 *  (D) Retraction is untouched-only, and the ISG path still works: a feasibility
 *      condition a HUMAN attached to a heavy-rehab file is never auto-removed.
 *  (E) "Also go back to previous projects": the boot backfill reaches an existing open
 *      ground-up file, is silent, and is marker-guarded so it runs once, ever.
 *  (F) The two conditions land in the CONSTRUCTION group beside the Scope of Work —
 *      the section the owner named — and their documents file with the Scope of Work
 *      in the investor package and the SharePoint mirror, not in "Other Documents".
 *  (G) Borrower-safe: no capital-partner name on a borrower field, and the
 *      borrower-facing GC condition has real borrower wording (without it the engine
 *      silently downgrades it to staff-only and the borrower would never see it).
 *  (H) db/601 is idempotent, and it converges even though db/285 re-asserts the OLD
 *      definition on every boot.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-ground-up-construction-conditions-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-ground-up-construction-conditions-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const engine = require('../src/lib/conditions/engine');
const registry = require('../src/lib/conditions/field-registry');
const rules = require('../src/lib/conditions/rules');
const tpr = require('../src/lib/tpr-export');

const FEAS = 'rtl_cond_feasibility';
const GC = 'rtl_cond_gc_info';
const SOW = 'rtl_p3_sow1';
// The note-buyer / capital-partner names that may never reach a borrower field.
const PARTNER_RE = /blue ?lake|corr ?first|fidelis|temple ?view|churchill|\bRCN\b/i;
const BACKFILL_KEY = 'db601_ground_up_construction_conditions_v1';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const tplFor = async (code) => (await db.query(
  `SELECT * FROM checklist_templates WHERE code = $1`, [code])).rows[0];
const codesOn = async (appId) => (await db.query(
  `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
    WHERE ci.application_id = $1`, [appId])).rows.map((r) => r.code);
const itemFor = async (appId, code) => (await db.query(
  `SELECT ci.* FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
    WHERE ci.application_id = $1 AND t.code = $2`, [appId, code])).rows[0];

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  const madeApps = [];
  const newApp = async (cols) => {
    const keys = Object.keys(cols);
    const r = await db.query(
      `INSERT INTO applications (borrower_id, status, ${keys.join(',')})
       VALUES ($1,'processing',${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
      [borrowerId, ...keys.map((k) => cols[k])]);
    madeApps.push(r.rows[0].id);
    return r.rows[0].id;
  };

  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ground','Up',$1) RETURNING id`,
      [`groundup-${sfx}@test.local`])).rows[0].id;

    // ======================================================================
    // (A) THE TEMPLATES — read LIVE, so this fails if db/601 stops applying.
    // ======================================================================
    const feas = await tplFor(FEAS);
    const gc = await tplFor(GC);

    assert(!!feas, 'the feasibility template exists');
    assert(feas && feas.is_active === true && feas.auto_apply === 'rules',
      'the feasibility condition is ACTIVE and RULE-DRIVEN (it was library-only before db/601)');
    assert(feas && /^feasibility report/i.test(feas.label),
      `the feasibility condition leads with "Feasibility report" — the owner's own name for it (label: ${feas && feas.label})`);
    assert(feas && /heavy rehab/i.test(feas.label),
      'the label still says heavy rehab out loud, so a hand-attached heavy-rehab instance still reads true');

    assert(!!gc, 'db/601 seeded the GC information template');
    assert(gc && gc.is_active === true && gc.auto_apply === 'rules',
      'the GC information condition is ACTIVE and RULE-DRIVEN');
    assert(gc && gc.audience === 'both',
      'the GC information condition is INTERNAL AND EXTERNAL — the general contractor is the borrower\'s, so the borrower is who can answer');
    assert(gc && gc.item_kind === 'document', 'the GC information condition collects documents');
    assert(feas && gc && Number(gc.sort_order) === Number(feas.sort_order) + 1,
      'the GC condition sorts immediately after the feasibility report, so the two read together');

    // ======================================================================
    // (B) ONE DEFINITION OF GROUND-UP.
    // ======================================================================
    assert(feas && gc && JSON.stringify(feas.rule_logic) === JSON.stringify(gc.rule_logic),
      'both conditions carry the SAME rule tree — one definition of "ground-up", never two');

    const fields = await registry.fieldMap(db);
    const problems = rules.validateRule(feas && feas.rule_logic, { fields });
    assert(problems.length === 0,
      `the ground-up rule is VALID against the field registry${problems.length ? ' → ' + problems.join('; ') : ''}`);

    const evalGround = (ctx) => rules.evaluateRule(feas.rule_logic, ctx, fields);
    assert(evalGround({ program_strategy: 'ground_up', rehab_type: null }) === true,
      'the rule reads a ground-up PROGRAM as ground-up');
    assert(evalGround({ program_strategy: 'fix_flip', rehab_type: 'ground_up' }) === true,
      'the rule reads a ground-up REHAB TYPE as ground-up, even under a fix & flip program');
    assert(evalGround({ program_strategy: 'fix_flip', rehab_type: 'heavy' }) === false,
      'a heavy-rehab fix & flip is NOT read as ground-up');
    assert(evalGround({ program_strategy: null, rehab_type: null }) === false,
      'a file that states nothing is not GUESSED into ground-up');

    // ======================================================================
    // (C) THE ENGINE PUTS BOTH ON A GROUND-UP FILE — AND ON NO OTHER FILE.
    // ======================================================================
    const groundApp = await newApp({ program: 'Ground-Up Construction' });
    await engine.evaluateApplication(groundApp, { reason: 'test', notify: false });
    let codes = await codesOn(groundApp);
    assert(codes.includes(FEAS), 'a ground-up file carries the feasibility report, attached by the engine');
    assert(codes.includes(GC), 'a ground-up file carries the GC information condition, attached by the engine');

    const rehabApp = await newApp({ program: 'Fix & Flip w/ Construction', rehab_type: 'Ground-up' });
    await engine.evaluateApplication(rehabApp, { reason: 'test', notify: false });
    codes = await codesOn(rehabApp);
    assert(codes.includes(FEAS) && codes.includes(GC),
      'a file whose REHAB TYPE is ground-up carries both, whatever its program says');

    const flipApp = await newApp({ program: 'Fix & Flip w/ Construction', rehab_type: 'Heavy' });
    await engine.evaluateApplication(flipApp, { reason: 'test', notify: false });
    codes = await codesOn(flipApp);
    assert(!codes.includes(FEAS) && !codes.includes(GC),
      'a heavy-rehab fix & flip carries NEITHER — the conditions never reach a file that is not a ground-up build');

    const gcItem = await itemFor(groundApp, GC);
    assert(gcItem && gcItem.audience === 'both',
      'the GC condition is instantiated borrower-facing (the engine did not silently downgrade it for want of borrower wording)');
    assert(gcItem && gcItem.origin_kind === 'auto',
      'the engine owns the instances it created, so it can retract them cleanly');

    // ======================================================================
    // (D) RETRACTION IS UNTOUCHED-ONLY — AND A HAND-ATTACHED ONE IS SAFE.
    // ======================================================================
    await db.query(`UPDATE applications SET program='Fix & Flip w/ Construction' WHERE id=$1`, [groundApp]);
    await engine.evaluateApplication(groundApp, { reason: 'test', notify: false });
    codes = await codesOn(groundApp);
    assert(!codes.includes(FEAS) && !codes.includes(GC),
      'a file that stops being a ground-up build has both retracted while nobody has touched them');

    // The investor-guideline desk's coverage-gap fatal still attaches the feasibility
    // report BY HAND on a heavy-rehab file. That instance must survive every later
    // pass — the engine only ever retracts what it created itself.
    const heavyApp = await newApp({ program: 'Fix & Flip w/ Construction', rehab_type: 'Heavy' });
    await engine.instantiateTemplate(feas, { application_id: heavyApp },
      { createdByKind: 'staff', originKind: 'manual_library' });
    await engine.evaluateApplication(heavyApp, { reason: 'test', notify: false });
    assert((await codesOn(heavyApp)).includes(FEAS),
      'a feasibility condition a HUMAN attached to a heavy-rehab file is NEVER auto-retracted (the investor-guideline path still works)');

    // ======================================================================
    // (E) PREVIOUS PROJECTS — the boot backfill, and it runs once.
    // ======================================================================
    const oldApp = await newApp({ program: 'Ground-Up Construction' });
    // An existing file nobody has re-evaluated since db/601 landed.
    await db.query(
      `DELETE FROM checklist_items ci USING checklist_templates t
        WHERE ci.template_id = t.id AND ci.application_id = $1 AND t.code = ANY($2::text[])`,
      [oldApp, [FEAS, GC]]);
    assert(!(await codesOn(oldApp)).includes(FEAS), 'control: the existing file starts without the conditions');

    await db.query(`DELETE FROM data_migrations WHERE key = $1`, [BACKFILL_KEY]);
    const ran = await engine.backfillGroundUpConstructionConditionsOnce();
    assert(ran && !ran.skipped, 'the backfill runs when its marker is not set');
    codes = await codesOn(oldApp);
    assert(codes.includes(FEAS) && codes.includes(GC),
      'the backfill reaches a PREVIOUS open ground-up file and gives it both conditions');

    const notes = await db.query(
      `SELECT count(*)::int n FROM notifications WHERE application_id = $1`, [oldApp]);
    assert(notes.rows[0].n === 0,
      'the backfill is SILENT — filling in history must never fan a notification out to every existing build');

    const again = await engine.backfillGroundUpConstructionConditionsOnce();
    assert(again && again.skipped === true, 'the backfill is marker-guarded — it runs once, ever');

    // ======================================================================
    // (F) THE SECTION THE OWNER NAMED.
    // ======================================================================
    const { subjectOf, SUBJECT_LABEL, CODE_SUBJECT } =
      await import('../app-v2/src/lib/condition-subjects.js');
    assert(subjectOf({ template_code: SOW }) === 'construction',
      'control: the Scope of Work sits in the Construction group');
    assert(subjectOf({ template_code: FEAS }) === 'construction',
      'the feasibility report sits in the SAME section as the Scope of Work');
    assert(subjectOf({ template_code: GC }) === 'construction',
      'the GC information condition sits in the SAME section as the Scope of Work');
    assert(SUBJECT_LABEL.construction === 'Construction', 'that section is the one headed "Construction"');
    assert(!!CODE_SUBJECT[GC],
      'the new template code is mapped, so it can never fall through to the catch-all "Other" bucket');

    // ======================================================================
    // (G) WHERE THEIR DOCUMENTS FILE.
    // ======================================================================
    assert(tpr.categoryFor({ template_code: FEAS, item_label: feas.label, filename: 'feasibility.pdf' }) === 'Scope of Work',
      'a feasibility report files with the Scope of Work in the investor package and the SharePoint mirror');
    assert(tpr.categoryFor({ template_code: GC, item_label: gc.label, filename: 'gc-license.pdf' }) === 'Scope of Work',
      'the general contractor\'s paperwork files with the Scope of Work, not in "Other Documents"');

    // ======================================================================
    // (H) BORROWER-SAFE.
    // ======================================================================
    for (const t of [feas, gc]) {
      const bl = String(t.borrower_label || '');
      const bh = String(t.borrower_hint || '');
      assert(!PARTNER_RE.test(bl) && !PARTNER_RE.test(bh),
        `${t.code}: no capital-partner name reaches a borrower field`);
    }
    assert(gc && String(gc.borrower_label || '').trim().length > 0 && String(gc.borrower_hint || '').trim().length > 0,
      'the borrower-facing GC condition has real borrower wording (a blank one is silently applied staff-only)');
    assert(!feas.borrower_label,
      'the feasibility report stays staff-only — it is a third-party report we order, not a borrower upload');

    // ======================================================================
    // (I) IDEMPOTENT, AND IT WINS THE BOOT.
    // ======================================================================
    const sqlOf = (f) => fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8');
    const f285 = fs.readdirSync(path.join(__dirname, '..', 'db')).find((f) => /^285_/.test(f));
    const f601 = fs.readdirSync(path.join(__dirname, '..', 'db')).find((f) => /^601_/.test(f));
    assert(!!f285 && !!f601 && f601 > f285,
      'db/601 sorts AFTER db/285, so it replays LAST each boot and is the final word');
    // Replay the boot order: db/285 re-asserts the old definition, db/601 restores ours.
    await db.query(sqlOf(f285));
    const mid = await tplFor(FEAS);
    assert(mid.auto_apply === 'manual',
      'control: db/285 really does re-assert the library-only definition on every boot (which is why db/601 must run after it)');
    await db.query(sqlOf(f601));
    let after = await tplFor(FEAS);
    assert(after.auto_apply === 'rules' && after.label === feas.label,
      'db/601 restores the rule and the label after db/285 has replayed');
    await db.query(sqlOf(f601));
    after = await tplFor(FEAS);
    assert(after.auto_apply === 'rules' && after.label === feas.label,
      'db/601 is idempotent — a second run inside one boot changes nothing');
    const gcCount = (await db.query(
      `SELECT count(*)::int n FROM checklist_templates WHERE code = $1`, [GC])).rows[0].n;
    assert(gcCount === 1, 'replaying db/601 never seeds a second GC information template');

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try {
      if (madeApps.length) {
        await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1::uuid[])`, [madeApps]);
        await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [madeApps]);
      }
      if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id = $1`, [borrowerId]);
    } catch (_) { /* best-effort cleanup */ }
  }
  process.exit(failures ? 1 : 0);
})();
