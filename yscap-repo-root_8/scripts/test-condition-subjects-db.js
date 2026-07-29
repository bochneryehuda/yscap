/**
 * WHAT A CONDITION IS ABOUT — the subject groups behind the one conditions list.
 *
 * Exercises app-v2/src/lib/condition-subjects.js (blueprint Move 4b). Two jobs:
 *
 *  1. PURE — placement rules. A template code is authoritative; a staff-typed
 *     condition falls back to its label; anything still unplaced lands in the
 *     visible "Other" bucket rather than being forced somewhere it may not
 *     belong. Grouping preserves the intended order and drops empty groups.
 *
 *  2. DB — the guarantee that actually decays. EVERY condition/document
 *     template seeded on a file must have a subject. Without this, adding a
 *     template next year silently drops it into "Other" and nobody notices,
 *     which is exactly how a taxonomy rots. This reads the LIVE
 *     checklist_templates table rather than a copied list, so it fails the day
 *     a new template lands unmapped.
 *
 * DB-gated: the pure half always runs; the live-template check skips without
 * DATABASE_URL, like every other *-db.js suite.
 */
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const { subjectOf, groupBySubject, SUBJECTS, CODE_SUBJECT } =
    await import('../app-v2/src/lib/condition-subjects.js');

  // ---- placement: the template code wins -------------------------------
  ok(subjectOf({ template_code: 'rtl_cond_title' }) === 'title', 'a title template lands in Title');
  ok(subjectOf({ template_code: 'rtl_llc_ein' }) === 'entity', 'an entity document lands in Entity & vesting');
  ok(subjectOf({ template_code: 'rtl_f_ctc' }) === 'closing', 'the clear-to-close gate lands in Closing');
  ok(subjectOf({ template_code: 'rtl_cond_flood' }) === 'insurance', 'the flood certificate sits with Insurance');
  ok(subjectOf({ template_code: 'rtl_cond_title', label: 'wire instructions' }) === 'title',
    'the code beats a label that would have said otherwise');

  // ---- placement: a tool-backed condition -------------------------------
  ok(subjectOf({ tool_key: 'rehab_budget' }) === 'construction', 'the scope-of-work tool lands in Construction');
  ok(subjectOf({ tool_key: 'product_pricing' }) === 'terms', 'products & pricing lands in Terms & signing');

  // ---- placement: a condition a human typed -----------------------------
  ok(subjectOf({ label: 'Updated homeowners insurance binder' }) === 'insurance', 'a typed insurance condition is placed');
  ok(subjectOf({ label: 'Payoff letter for the existing lien' }) === 'title', 'a typed payoff/lien condition is placed');
  ok(subjectOf({ label: 'Signed operating agreement for the new LLC' }) === 'entity', 'a typed entity condition is placed');
  ok(subjectOf({ label: 'Two months of bank statements' }) === 'assets', 'a typed assets condition is placed');
  ok(subjectOf({ title: 'Verify owner of record on REO #3' }) === 'title',
    'an underwriting-table row is placed from its title, not a code it does not have');

  // ---- never guess loudly ------------------------------------------------
  ok(subjectOf({ label: 'Call the borrower back on Tuesday' }) === 'other',
    'a condition matching nothing lands in the visible Other bucket, not a wrong group');
  ok(subjectOf({}) === 'other' && subjectOf(null) === 'other', 'an empty or missing row degrades to Other, never a crash');
  ok(subjectOf({ subject: 'title', label: 'anything' }) === 'title', 'a caller may pin a subject explicitly (the LLC row does)');
  ok(subjectOf({ subject: 'not-a-real-group', label: 'Insurance binder' }) === 'insurance',
    'a bogus pinned subject is ignored rather than trusted');

  // ---- grouping ----------------------------------------------------------
  {
    const rows = [
      { id: 1, template_code: 'rtl_cond_title', done: true },
      { id: 2, template_code: 'title_commitment', done: false },
      { id: 3, template_code: 'gov_id', done: true },
      { id: 4, label: 'Something nobody mapped', done: false },
    ];
    const g = groupBySubject(rows, r => r.done);
    const keys = g.map(x => x.key);
    ok(keys.length === 3, 'only groups that actually have rows are returned');
    ok(keys[0] === 'identity' && keys[1] === 'title' && keys[2] === 'other',
      'groups come back in the intended order, with Other last');
    const title = g.find(x => x.key === 'title');
    ok(title.total === 2 && title.done === 1, 'the group header counts match the rows beneath it');
    ok(g.every(x => x.rows.length === x.total), 'every group total equals the rows it carries');
    ok(groupBySubject([], () => true).length === 0 && groupBySubject(null, () => true).length === 0,
      'no rows means no groups, never a crash');
    ok(groupBySubject(rows).every(x => x.done === 0), 'with no done-test supplied, nothing is claimed done');
  }

  // ---- the guarantee that decays: every seeded template has a subject ----
  if (!process.env.DATABASE_URL) {
    console.log('SKIP live checklist_templates check (no DATABASE_URL)');
  } else {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const rows = (await c.query(
        `SELECT code FROM checklist_templates
          WHERE item_kind IN ('document','condition') AND code IS NOT NULL
          ORDER BY code`)).rows.map(r => r.code);
      ok(rows.length > 0, `the live template table was read (${rows.length} condition/document templates)`);
      const unmapped = rows.filter(code => !CODE_SUBJECT[code]);
      ok(unmapped.length === 0,
        unmapped.length
          ? `every seeded template has a subject — MISSING: ${unmapped.join(', ')} (add them to CODE_SUBJECT)`
          : 'every seeded condition/document template has a subject');
      const phantom = Object.keys(CODE_SUBJECT).filter(code => !rows.includes(code));
      ok(phantom.length === 0,
        phantom.length
          ? `CODE_SUBJECT names templates that no longer exist: ${phantom.join(', ')}`
          : 'CODE_SUBJECT names no template that does not exist');
      const groups = new Set(SUBJECTS.map(s => s.key));
      ok(Object.values(CODE_SUBJECT).every(v => groups.has(v)),
        'every mapped subject is a real group');
    } finally {
      await c.end();
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
