/**
 * PREVIOUS FILES ARE NOT DISTURBED BY THE LOAN-FILE REDESIGN.
 *
 * Owner-directed 2026-07-27: "make sure the documents that were uploaded to the
 * conditions stay uploaded to the condition so you can still see them, still
 * preview them, the conditions stay signed off and everything stays on the
 * previous files — but the redesign should still go on the previous files too."
 *
 * The redesign (docs/LOAN-FILE-SIMPLICITY-BLUEPRINT.md phases 1-4) is almost
 * entirely rendering: new words, new dot colours, a front-door card, and a
 * summary line per shut section. Exactly ONE piece of it writes to stored data —
 * db/340, which moves an AI-created condition out of the red "issue" bucket it
 * was wrongly born into. This test pins what that migration may and may not do,
 * against a database carrying a realistic older file.
 *
 * It also pins the OTHER half of the owner's ask: the redesign must still reach
 * those files. It does, structurally — checklist_items.status is CHECK-
 * constrained to exactly the five values the new vocabulary covers
 * (db/schema.sql), so no row that has ever existed can fall outside it. That is
 * asserted here against the LIVE constraint rather than trusted.
 *
 * DB-gated: skips without DATABASE_URL, like every other *-db.js suite.
 */
const { Client } = require('pg');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const U = (c) => c.query('SELECT gen_random_uuid() AS id').then(r => r.rows[0].id);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP test-previous-files-untouched-db (no DATABASE_URL)');
    process.exit(0);
  }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const tag = 'prevfiles-' + Date.now();
  try {
    await c.query('BEGIN');

    // ---- an older file, the way one actually looks -----------------------
    const borrowerId = await U(c);
    await c.query(
      `INSERT INTO borrowers (id, first_name, last_name, email)
       VALUES ($1,'Prev','File',$2)`, [borrowerId, `${tag}@example.test`]);
    const appId = await U(c);
    await c.query(
      `INSERT INTO applications (id, borrower_id, status) VALUES ($1,$2,'processing')`,
      [appId, borrowerId]);

    // Five conditions covering every case the migration has to tell apart.
    const mk = async (label, status, extra = {}) => {
      const id = await U(c);
      await c.query(
        `INSERT INTO checklist_items
           (id, scope, application_id, label, status, item_kind, audience,
            created_by_kind, notes, reviewed_at, signed_off_at, waived_at)
         VALUES ($1,'application',$2,$3,$4,'document','both',$5,$6,$7,$8,$9)`,
        [id, appId, label, status,
          extra.createdByKind || 'staff', extra.notes || null,
          extra.reviewedAt || null, extra.signedOffAt || null, extra.waivedAt || null]);
      return id;
    };
    const AI = { createdByKind: 'system', notes: '[from AI suggestion] needs a payoff letter' };

    const signedOff = await mk('Insurance binder', 'satisfied', { signedOffAt: 'now()' });
    const realReject = await mk('Bank statements', 'issue');           // a document really was rejected
    const aiRed = await mk('Payoff letter', 'issue', AI);              // THE row the migration fixes
    const aiWorked = await mk('Payoff letter (reviewed)', 'issue', { ...AI, reviewedAt: 'now()' });
    const humanRed = await mk('Title commitment', 'issue');            // a human put it in the red bucket
    // The two cases the migration's narrowest guards exist for. Both are
    // AI-created and otherwise look exactly like the row it fixes — the ONLY
    // thing keeping them safe is a guard, so they are what proves a guard works.
    // A row can be born red by the bug AND later legitimately EARN red.
    const aiRedRejected = await mk('Payoff letter (doc rejected)', 'issue', AI);
    const aiRedSigned = await mk('Payoff letter (signed off)', 'issue', { ...AI, signedOffAt: 'now()' });

    // Documents attached to conditions — the thing the owner is protecting.
    const mkDoc = async (itemId, filename, reviewStatus) => {
      const id = await U(c);
      await c.query(
        `INSERT INTO documents
           (id, checklist_item_id, application_id, borrower_id, filename,
            content_type, size_bytes, storage_provider, storage_ref, review_status)
         VALUES ($1,$2,$3,$4,$5,'application/pdf',12345,'local',$6,$7)`,
        [id, itemId, appId, borrowerId, filename, `ref/${tag}/${filename}`, reviewStatus]);
      return id;
    };
    const docSigned = await mkDoc(signedOff, 'binder.pdf', 'accepted');
    const docReject = await mkDoc(realReject, 'statements.pdf', 'rejected');
    const docOnAiRed = await mkDoc(aiRed, 'payoff-attempt.pdf', 'pending');
    const docAiRejected = await mkDoc(aiRedRejected, 'payoff-bad.pdf', 'rejected');

    // ---- snapshot everything the owner cares about, BEFORE ---------------
    const snap = async () => {
      const items = (await c.query(
        `SELECT id, status, reviewed_at, signed_off_at, waived_at
           FROM checklist_items WHERE application_id=$1 ORDER BY label`, [appId])).rows;
      const docs = (await c.query(
        `SELECT id, checklist_item_id, filename, storage_ref, review_status, is_current
           FROM documents WHERE application_id=$1 ORDER BY filename`, [appId])).rows;
      return { items, docs };
    };
    const before = await snap();

    // ---- re-run the migration exactly as boot does -----------------------
    // (It is idempotent and runs on every deploy, so this is the real thing an
    //  existing file goes through — not an approximation of it.)
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '340_ai_condition_not_red.sql'), 'utf8');
    await c.query(sql);

    const after = await snap();

    // ---- DOCUMENTS: nothing may move --------------------------------------
    ok(after.docs.length === before.docs.length && after.docs.length === 4,
      'every uploaded document is still there — none added, none removed');
    ok(JSON.stringify(after.docs) === JSON.stringify(before.docs),
      'every document is byte-for-byte unchanged: still on its condition, same file, same stored copy, still previewable');
    const stillLinked = after.docs.filter(d => d.checklist_item_id).length;
    ok(stillLinked === 4, 'every document is still attached to the condition it was uploaded to');
    ok(after.docs.find(d => d.id === docSigned).checklist_item_id === signedOff
      && after.docs.find(d => d.id === docReject).checklist_item_id === realReject
      && after.docs.find(d => d.id === docOnAiRed).checklist_item_id === aiRed
      && after.docs.find(d => d.id === docAiRejected).checklist_item_id === aiRedRejected,
      'each document is still on the SAME condition (not shuffled between them)');

    // ---- SIGN-OFFS and human work: nothing may move -----------------------
    const byId = (rows) => Object.fromEntries(rows.map(r => [r.id, r]));
    const b = byId(before.items), a = byId(after.items);
    ok(a[signedOff].status === 'satisfied' && a[signedOff].signed_off_at
      && String(a[signedOff].signed_off_at) === String(b[signedOff].signed_off_at),
      'a signed-off condition stays signed off, with the same sign-off on it');
    for (const id of Object.keys(b)) {
      ok(String(a[id].signed_off_at) === String(b[id].signed_off_at)
        && String(a[id].reviewed_at) === String(b[id].reviewed_at)
        && String(a[id].waived_at) === String(b[id].waived_at),
        `no sign-off / review / waiver was altered on ${b[id].id === aiRed ? 'the AI condition' : 'an existing condition'}`);
    }

    // ---- STATUS: exactly one row, and only the provable one ---------------
    const changed = Object.keys(b).filter(id => a[id].status !== b[id].status);
    ok(changed.length === 1 && changed[0] === aiRed,
      'exactly ONE condition changed — the AI-created one that was wrongly born red');
    ok(a[aiRed].status === 'outstanding', 'it moved to the ordinary "not started" state');
    ok(a[realReject].status === 'issue',
      'a condition whose document was genuinely REJECTED stays in the needs-attention bucket');
    ok(a[aiWorked].status === 'issue', 'an AI condition a human already reviewed is left exactly as it is');
    ok(a[humanRed].status === 'issue', 'a condition a human put in the needs-attention bucket is left alone');
    ok(a[aiRedRejected].status === 'issue',
      'an AI condition that LATER earned its red — a document on it was rejected — keeps it (a real rejection is never cleared)');
    ok(a[aiRedSigned].status === 'issue',
      'an AI condition that was signed off is left exactly as the person who signed it left it');

    // ---- idempotent: a second deploy changes nothing more -----------------
    await c.query(sql);
    const third = await snap();
    ok(JSON.stringify(third) === JSON.stringify(after),
      're-running it (every deploy does) changes nothing further');

    // ---- the redesign REACHES these files ---------------------------------
    // The new words/colours cover exactly the five stored values, and the
    // database refuses any sixth — so no older row can render blank or wrong.
    const con = (await c.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'checklist_items'::regclass
          AND pg_get_constraintdef(oid) ILIKE '%status%'`)).rows.map(r => r.def).join(' ');
    const five = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
    ok(five.every(s => con.includes(`'${s}'`)),
      'the database still constrains a condition to the five states the new wording covers');
    const rows = (await c.query(
      `SELECT DISTINCT status FROM checklist_items WHERE application_id=$1`, [appId])).rows;
    ok(rows.every(r => five.includes(r.status)),
      'every condition on the file reads as one of those five — so the new wording and colours apply to it');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* already unwound */ }
    console.log('FAIL threw: ' + (e && e.message));
    failures++;
  } finally {
    await c.end();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
