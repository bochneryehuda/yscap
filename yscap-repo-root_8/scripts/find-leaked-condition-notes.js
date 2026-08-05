#!/usr/bin/env node
/**
 * Find (and, with --apply, clean up) LEAKED internal condition notes
 * (owner-reported 2026-08-05).
 *
 * The current code stores an internal note on the PER-FILE checklist_items row and
 * writes it `WHERE id = <that file's item id>` — so going forward a note can only
 * ever land on the one file it was typed on (locked by
 * test-condition-note-per-file-db.js). This tool is for CLEANING UP any notes that
 * an earlier version may have copied across files before that was true: the owner
 * asked to "remove that internal note ... it automatically added to all the files."
 *
 * The leak signature: the SAME human-typed note text (not an '[auto]' engine note)
 * sitting VERBATIM on the same condition TEMPLATE across TWO OR MORE different
 * files. A note a human genuinely wrote for one file is virtually never character-
 * for-character identical to one on another file, so this is a safe signal.
 *
 *   node scripts/find-leaked-condition-notes.js            # DRY RUN — report only
 *   node scripts/find-leaked-condition-notes.js --apply    # clear the leaked copies,
 *                                                           # KEEPING the most recently
 *                                                           # updated file's copy
 *   node scripts/find-leaked-condition-notes.js --apply --clear-all
 *                                                           # clear EVERY copy in a leaked group
 *   node scripts/find-leaked-condition-notes.js --min 3    # only groups on >= 3 files
 *
 * DRY RUN is the default; nothing is ever changed without --apply. Requires
 * DATABASE_URL. Read-only-safe: it only ever NULLs checklist_items.notes, and only
 * for notes that are duplicated across files.
 */
'use strict';
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first (this reads/repairs the live conditions).'); process.exit(1); }
const db = require('../src/db');

const APPLY = process.argv.includes('--apply');
const CLEAR_ALL = process.argv.includes('--clear-all');
const minIdx = process.argv.indexOf('--min');
const MIN_FILES = minIdx >= 0 ? Math.max(2, parseInt(process.argv[minIdx + 1], 10) || 2) : 2;

(async () => {
  // Group human notes by (template, exact note text) across DIFFERENT files.
  const groups = (await db.query(
    `SELECT ci.template_id,
            COALESCE(t.code, '(no template)') AS template_code,
            COALESCE(t.label, ci.label)       AS template_label,
            ci.notes                          AS note_text,
            count(DISTINCT ci.application_id) AS files,
            array_agg(ci.id ORDER BY ci.updated_at DESC NULLS LAST) AS item_ids
       FROM checklist_items ci
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.notes IS NOT NULL
        AND btrim(ci.notes) <> ''
        AND ci.notes NOT LIKE '[auto]%'      -- '[auto]' notes are engine-written, per-file by design
        AND ci.application_id IS NOT NULL
        AND ci.template_id IS NOT NULL
      GROUP BY ci.template_id, template_code, template_label, ci.notes
     HAVING count(DISTINCT ci.application_id) >= $1
      ORDER BY count(DISTINCT ci.application_id) DESC`, [MIN_FILES])).rows;

  if (!groups.length) {
    console.log(`No leaked notes found (no human note is duplicated verbatim across >= ${MIN_FILES} files).`);
    console.log('The note storage is per-file, so this is the expected result on a healthy database.');
    process.exit(0);
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${groups.length} leaked note group(s) (same note on >= ${MIN_FILES} files):\n`);
  let cleared = 0;
  for (const g of groups) {
    const ids = g.item_ids; // newest-updated first
    const keep = CLEAR_ALL ? null : ids[0];
    const toClear = CLEAR_ALL ? ids : ids.slice(1);
    console.log(`• [${g.template_code}] "${g.template_label}" — on ${g.files} files`);
    console.log(`    note: ${JSON.stringify(String(g.note_text).slice(0, 120))}${String(g.note_text).length > 120 ? '…' : ''}`);
    console.log(`    ${CLEAR_ALL ? 'clear ALL' : `keep 1 (most recent), clear ${toClear.length}`} copy(ies)`);
    if (APPLY && toClear.length) {
      const r = await db.query(`UPDATE checklist_items SET notes = NULL, updated_at = now() WHERE id = ANY($1::uuid[])`, [toClear]);
      cleared += r.rowCount;
    }
  }
  console.log('');
  if (APPLY) console.log(`Done — cleared ${cleared} leaked note copy(ies)${CLEAR_ALL ? '' : ', kept 1 per group'}.`);
  else console.log('Dry run only. Re-run with --apply to clear the leaked copies (add --clear-all to clear every copy).');

  // ── SHARED INSTRUCTIONS that carry a LINK (report only) ──────────────────────
  // The per-file NOTE is per-file. The one field that DOES show on every file with
  // a condition is the condition's INSTRUCTIONS (the template `hint`, edited in the
  // Condition Studio and labeled "Staff instructions — shows on every file"). A
  // "credit card link" typed there appears on every file of that type — which is
  // exactly the owner's report. A link in an instruction can be legitimate, so this
  // is REPORT ONLY: it lists them so a human can remove the wrong one in the Studio.
  const LINK = `(https?://|www\\.|\\.com|\\.net|\\.org|/pay|card)`;
  const tHints = (await db.query(
    `SELECT code, label, hint FROM checklist_templates
      WHERE hint IS NOT NULL AND hint ~* $1 ORDER BY label`, [LINK])).rows;
  if (tHints.length) {
    console.log(`\nCondition INSTRUCTIONS that contain a link (shown on every file of that type — check these in the Condition Studio):`);
    for (const t of tHints) console.log(`  • [${t.code || '—'}] "${t.label}" → ${JSON.stringify(String(t.hint).slice(0, 140))}`);
    console.log('  Remove the wrong one in Admin → Condition Studio (the "Staff instructions" box).');
  } else {
    console.log('\nNo condition INSTRUCTIONS contain a link — nothing leaked into the shared instructions.');
  }

  process.exit(0);
})().catch((e) => { console.error('ERROR', e && e.message); process.exit(1); });
