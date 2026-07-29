/**
 * THE TWO PHASE-5 GATES SAY THEY COME FROM THE INVESTOR (db/367).
 *
 * Owner-directed 2026-07-29: "Final review requested / CTC — Clear to Close
 * received … this is stuff that needs to come from the investor."
 *
 * What this pins, and why each part is worth a test:
 *
 *  1. THE LIVE TEMPLATE ROWS carry the new wording — read out of the database,
 *     not out of the migration file. If a later migration or a re-seed ever
 *     overwrites them, this is the assertion that catches it.
 *
 *  2. PREVIOUS FILES are re-worded too. checklist_items.label/.hint are COPIED
 *     from the template at creation, so a template-only rename leaves every
 *     existing file reading the old words. The test builds a file carrying the
 *     OLD text, runs ensureSchema() (a deploy boot), and asserts it moved.
 *
 *  3. A HAND-EDITED label/hint is NEVER overwritten. Every statement in db/367
 *     is guarded on the exact old text; a row somebody has since reworded must
 *     survive a deploy untouched.
 *
 *  4. It is IDEMPOTENT — a second boot changes nothing (the migration re-runs on
 *     every boot, so "matches nothing once applied" is the whole contract).
 *
 *  5. The gate itself is untouched: same codes, still is_gate/is_milestone,
 *     still staff-only. This was a wording change, and a wording change that
 *     quietly moved a clear-to-close gate would be a real incident.
 *
 * DB-gated: skips without DATABASE_URL, like every other *-db.js suite.
 */
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const OLD = {
  rtl_f_review: { label: 'Final review requested', hint: 'Last approval step before CTC' },
  rtl_f_ctc: { label: 'CTC — Clear to Close received', hint: null },
};
const NEW = {
  rtl_f_review: {
    label: 'Investor final review',
    hint: 'The investor reviews the full file. Clear this when their approval comes back — not when we send it. Last step before their CTC.',
  },
  rtl_f_ctc: {
    label: 'Investor Clear to Close (CTC)',
    hint: 'The Clear to Close is issued BY the investor. Clear this only when their written CTC is on the file — PILOT never issues one.',
  },
};
const CODES = Object.keys(NEW);

if (!process.env.DATABASE_URL) {
  console.log('SKIP db-backed investor-condition-wording tests (no DATABASE_URL)');
  console.log('\nALL PASS (skipped)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');

/** Attach an item straight from its template, then force it to the wording a
 *  file created before db/367 would be carrying. */
async function attachWithText(appId, code, label, hint) {
  const r = await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, application_id, label, audience, item_kind, role_scope,
        phase, hint, is_gate, is_milestone, sort_order, status, created_by_kind)
     SELECT t.id, t.scope, $1, $2, t.audience, t.item_kind, COALESCE(t.role_scope,'any'),
            t.phase, $3, COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,100), 'outstanding', 'system'
       FROM checklist_templates t WHERE t.code = $4
     RETURNING id`,
    [appId, label, hint, code]);
  return r.rows[0].id;
}

const itemById = async (id) => (await db.query(
  `SELECT label, hint FROM checklist_items WHERE id = $1`, [id])).rows[0];

(async () => {
  await ensureSchema();
  let borrowerId, appId;
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

  try {
    // -- (1) the live templates -------------------------------------------
    const tpl = {};
    for (const r of (await db.query(
      `SELECT code, label, hint, audience, is_gate, is_milestone, is_active
         FROM checklist_templates WHERE code = ANY($1)`, [CODES])).rows) tpl[r.code] = r;

    for (const code of CODES) {
      ok(!!tpl[code], `${code} still exists as a template`);
      if (!tpl[code]) continue;
      ok(tpl[code].label === NEW[code].label,
        `${code} reads "${NEW[code].label}" (got "${tpl[code].label}")`);
      ok(tpl[code].hint === NEW[code].hint, `${code}'s hint says the answer comes from the investor`);
      // (5) the gate is untouched.
      ok(tpl[code].audience === 'staff', `${code} is still staff-only — no borrower ever sees it`);
      ok(tpl[code].is_gate === true && tpl[code].is_milestone === true,
        `${code} is still a clear-to-close gate and a milestone`);
      ok(tpl[code].is_active === true, `${code} is still active`);
    }
    ok(/investor/i.test(NEW.rtl_f_review.label) && /investor/i.test(NEW.rtl_f_ctc.label),
      'both labels name the investor, so the two outside-party steps read as a pair');

    // -- (2)(3) previous files -------------------------------------------
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Investor','Wording',$1) RETURNING id`,
      [`iw-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type) VALUES ($1,'processing','Fix & Flip') RETURNING id`,
      [borrowerId])).rows[0].id;

    const stale = {};
    for (const code of CODES) stale[code] = await attachWithText(appId, code, OLD[code].label, OLD[code].hint);
    // A row a human has since reworded on this file — must survive the boot.
    const HAND_LABEL = 'Final review requested — chase Tuesday';
    const HAND_HINT = 'Ask the investor before Thursday';
    const handEdited = await attachWithText(appId, 'rtl_f_review', HAND_LABEL, HAND_HINT);

    await ensureSchema();                       // a deploy boot

    for (const code of CODES) {
      const row = await itemById(stale[code]);
      ok(row.label === NEW[code].label, `an existing file's ${code} row was re-worded on the next boot`);
      ok(row.hint === NEW[code].hint, `an existing file's ${code} hint was re-worded on the next boot`);
    }
    {
      const row = await itemById(handEdited);
      ok(row.label === HAND_LABEL && row.hint === HAND_HINT,
        'a label and hint someone edited by hand are left exactly as they were');
    }

    // Nothing anywhere still carries the retired wording.
    const leftovers = (await db.query(
      `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE t.code = ANY($1) AND ci.label = ANY($2)`,
      [CODES, CODES.map(c => OLD[c].label)])).rows[0].n;
    ok(leftovers === 0, `no file is left reading the old labels (${leftovers} found)`);

    // -- (4) idempotent ----------------------------------------------------
    // Scoped to the rows db/367 can touch — the boot also runs 360-odd other
    // migrations, and db/095 seeds the rest of the RTL checklist onto a new
    // file, so the whole application's row set is legitimately not stable.
    const ids = [...Object.values(stale), handEdited];
    const snapshot = async () => JSON.stringify((await db.query(
      `SELECT id, label, hint, updated_at FROM checklist_items WHERE id = ANY($1) ORDER BY id`,
      [ids])).rows);
    const tplSnapshot = async () => JSON.stringify((await db.query(
      `SELECT code, label, hint, updated_at FROM checklist_templates WHERE code = ANY($1) ORDER BY code`,
      [CODES])).rows);
    const beforeItems = await snapshot();
    const beforeTpl = await tplSnapshot();
    await ensureSchema();                       // another deploy boot
    ok(await snapshot() === beforeItems,
      're-running the migration leaves every already-worded item byte-identical');
    ok(await tplSnapshot() === beforeTpl,
      're-running the migration leaves the templates byte-identical');
  } finally {
    if (appId) await db.query(`DELETE FROM applications WHERE id = $1`, [appId]);
    if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id = $1`, [borrowerId]);
    await db.pool.end().catch(() => {});
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
