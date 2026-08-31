#!/usr/bin/env node
'use strict';
/**
 * The LEAKED-NOTE cleanup (db/476, owner-reported 2026-08-05). The owner clicked
 * "+ Add an internal note" on one file's condition and it appeared on every file
 * with that condition. Going forward the note is stored per-file (proven by
 * test-condition-note-per-file-db.js); this proves the CLEANUP that removes the
 * leftover leaked copies:
 *   - the SAME human note on >= 3 files across >= 2 borrowers (the leak signature)
 *     is cleared from every one of those files,
 *   - a genuine unique per-file note is kept,
 *   - a note a processor repeated on ONE borrower's files (one borrower) is kept,
 *   - the cleared text is preserved in audit_log, and
 *   - re-running changes nothing (idempotent).
 *
 * DB-gated: needs DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-note-cleanup-db (no DATABASE_URL)'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

let pass = 0, fail = 0;
const eq = (name, got, exp) => { if (got === exp) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

(async () => {
  // AN APPLICATION-SCOPED TEMPLATE, NOT WHICHEVER ONE COMES BACK FIRST. This
  // suite is about NOTES and does not care which condition carries them — but
  // the row it stages is `scope='application'`, and an unordered `LIMIT 1`
  // returns `gov_id`, which lives on the PERSON (scope 'borrower_profile'). That
  // put a profile condition's template on a loan file, which db/655 now refuses
  // outright: a condition set never crosses. The fixture was staging a row the
  // product should never have allowed, and asking for the right scope is the
  // repair — never loosening the guard that found it.
  const tmpl = (await db.query(
    `SELECT id FROM checklist_templates WHERE scope='application' AND is_active ORDER BY sort_order, code LIMIT 1`)).rows[0].id;
  const stamp = Date.now();
  const LEAK = `credit card link https://pay.example.com/${stamp}`;
  const UNIQUE = `a genuine per-file note ${stamp}`;
  const SOLO = `waiting on borrower ${stamp}`;

  // The leak: same note on 3 files across 3 different borrowers.
  for (let i = 0; i < 3; i++) {
    const b = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Leak',$1,$2) RETURNING id`,
      [String(i), `leak${i}.${stamp}@ex.com`])).rows[0].id;
    const a = (await db.query(`INSERT INTO applications(borrower_id,status) VALUES($1,'file_intake') RETURNING id`, [b])).rows[0].id;
    await db.query(`INSERT INTO checklist_items(template_id,scope,application_id,label,audience,item_kind,status,notes)
                    VALUES($1,'application',$2,'Cond','staff','document','outstanding',$3)`, [tmpl, a, LEAK]);
  }
  // A genuine unique per-file note — must survive.
  {
    const b = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Keep','Me',$1) RETURNING id`, [`keep.${stamp}@ex.com`])).rows[0].id;
    const a = (await db.query(`INSERT INTO applications(borrower_id,status) VALUES($1,'file_intake') RETURNING id`, [b])).rows[0].id;
    await db.query(`INSERT INTO checklist_items(template_id,scope,application_id,label,audience,item_kind,status,notes)
                    VALUES($1,'application',$2,'Cond','staff','document','outstanding',$3)`, [tmpl, a, UNIQUE]);
  }
  // A processor's repeated note on ONE borrower's 3 files (one borrower) — must survive.
  {
    const b = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Solo','Rep',$1) RETURNING id`, [`solo.${stamp}@ex.com`])).rows[0].id;
    for (let i = 0; i < 3; i++) {
      const a = (await db.query(`INSERT INTO applications(borrower_id,status) VALUES($1,'file_intake') RETURNING id`, [b])).rows[0].id;
      await db.query(`INSERT INTO checklist_items(template_id,scope,application_id,label,audience,item_kind,status,notes)
                      VALUES($1,'application',$2,'Cond','staff','document','outstanding',$3)`, [tmpl, a, SOLO]);
    }
  }

  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '476_clean_leaked_condition_notes.sql'), 'utf8');
  await db.query(sql);

  eq('A1 the leaked note is cleared from every file', (await db.query(`SELECT count(*)::int n FROM checklist_items WHERE notes=$1`, [LEAK])).rows[0].n, 0);
  eq('A2 a genuine per-file note is kept', (await db.query(`SELECT count(*)::int n FROM checklist_items WHERE notes=$1`, [UNIQUE])).rows[0].n, 1);
  eq('A3 a single-borrower repeat is kept (one borrower is not a leak)', (await db.query(`SELECT count(*)::int n FROM checklist_items WHERE notes=$1`, [SOLO])).rows[0].n, 3);
  const audited = (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action='condition_note_leak_cleaned' AND detail->>'note'=$1`, [LEAK])).rows[0].n;
  eq('A4 the cleared text is preserved in audit_log (3 files)', audited, 3);

  await db.query(sql);   // idempotent
  const audited2 = (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action='condition_note_leak_cleaned' AND detail->>'note'=$1`, [LEAK])).rows[0].n;
  eq('A5 re-running the cleanup changes nothing (idempotent)', audited2, 3);

  console.log(`test-condition-note-cleanup-db: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
