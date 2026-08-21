/**
 * A NOTE ON A CONDITION THAT THE BORROWER AND THE BROKER READ (db/604), against a
 * real Postgres and over real HTTP.
 *
 * Owner-reported 2026-08-21: "on the condition center, maybe we implemented it
 * already. Right now, I only see internal notes. We should also be able to put
 * external notes that should be visible for the borrowers and TpOS."
 *
 * The whole risk in this feature is ONE mistake — the two notes being confused, in
 * either direction — so that is what is measured, from all three surfaces at once,
 * with the internal note carrying a capital-partner name the entire time as a live
 * control. If the wiring were reversed, the borrower would be holding the word
 * "Fidelis" and the test would say so.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-external-note-db (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const EXT = require(R + '/src/lib/conditions/external-note');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@extnote.test`;

  // The internal note names a capital partner ON PURPOSE. It is the live control:
  // every "the borrower does not see the internal note" assertion below is also a
  // proof that this word did not reach them.
  const INTERNAL = 'Fidelis wants the reserve seasoned 60 days — do not tell the borrower the buyer.';
  const EXTERNAL = 'Please send the AUGUST statement — the one on file is July.';

  try {
    const hash = await C.hashPassword('ExtNotePass123!');
    const superId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Ext Note Super','super_admin',true,false,$2,0) RETURNING id`, [mail('super'), hash])).rows[0].id;
    const sTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });

    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ext','Note',$1) RETURNING id`, [mail('bo')])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [borId, hash]);
    const bTok = C.signJwt({ sub: borId, kind: 'borrower', tv: 0 });

    const appId = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,loan_type,property_address)
       VALUES ($1,$2,'underwriting','Purchase','{"oneLine":"9 Note Street"}') RETURNING id`, [borId, superId])).rows[0].id;

    const mkItem = async (label, audience) => (await db.query(
      `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,created_by_kind,created_by_id)
       VALUES ('application',$1,$2,$2,$3,'document',true,'staff',$4) RETURNING id`, [appId, label, audience, superId])).rows[0].id;
    const shared = await mkItem('Bank statements', 'both');
    const staffOnly = await mkItem('Underwriting worksheet', 'staff');

    /* ── A. the rule itself ──────────────────────────────────────────────── */
    console.log('\nA. what the module accepts and what it lets out');
    ok(EXT.clean('  hi  ') === 'hi' && EXT.clean('') === null && EXT.clean('   ') === null && EXT.clean(null) === null,
      'an empty note is NOTHING, never an empty string — "no note" and "a note that says nothing" must not be two states');
    ok(EXT.noteProblem('fine') === '' && EXT.noteProblem(null) === '' && EXT.noteProblem('') === '',
      'ordinary text is accepted, and clearing a note is always allowed');
    ok(/under/i.test(EXT.noteProblem('x'.repeat(EXT.EXTERNAL_NOTE_MAX + 1))), 'an oversized note is refused, in words');
    ok(EXT.forClient({ external_note: 'x' }, null) === null && EXT.forClient({ external_note: 'x' }, () => { throw new Error('no'); }) === null,
      'with no working scrubber it sends NOTHING — failing closed on a partner name is the whole point of the scrub');
    ok(EXT.forClient({ external_note: null }, (v) => v) === null, 'no note → nothing to send');
    {
      const out = EXT.forClient({ external_note: 'a', external_note_at: '2026-08-21T00:00:00Z', external_note_by: superId }, (v) => v);
      ok(out && out.note === 'a' && out.at, 'a note ships with WHEN…');
      ok(out && !('by' in out) && !('external_note_by' in out), '…and never with WHO — naming an underwriter to an outside party is a new exposure');
    }

    /* ── B. staff write both notes on one condition ──────────────────────── */
    console.log('\nB. two notes, one condition');
    const w1 = await call(server, 'PATCH', `/api/staff/checklist/${shared}`, sTok, { notes: INTERNAL, externalNote: EXTERNAL });
    ok(w1.status === 200, 'both notes save through the ONE condition door');
    const row = (await db.query(`SELECT notes, external_note, external_note_by, external_note_at FROM checklist_items WHERE id=$1`, [shared])).rows[0];
    ok(row.notes === INTERNAL && row.external_note === EXTERNAL, 'they land in DIFFERENT columns — the internal note cannot become visible by accident');
    ok(row.external_note_by === superId && !!row.external_note_at, 'the external note records who wrote it and when');
    const tooLong = await call(server, 'PATCH', `/api/staff/checklist/${shared}`, sTok, { externalNote: 'x'.repeat(EXT.EXTERNAL_NOTE_MAX + 5) });
    ok(tooLong.status === 400, 'an oversized note is refused at the door');
    ok((await db.query(`SELECT external_note FROM checklist_items WHERE id=$1`, [shared])).rows[0].external_note === EXTERNAL,
      '…and the refusal wrote nothing — the note that was there is still there');

    /* ── C. the staff screen sees both, with the author ──────────────────── */
    console.log('\nC. staff');
    const sList = await call(server, 'GET', `/api/staff/applications/${appId}/checklist`, sTok);
    const sItem = (sList.body.items || sList.body || []).find((x) => x.id === shared);
    ok(!!sItem && sItem.notes === INTERNAL, 'staff still see the internal note, unchanged');
    ok(!!sItem && sItem.external_note === EXTERNAL, 'staff see the external note too');
    ok(!!sItem && sItem.external_note_by_name === 'Ext Note Super' && !!sItem.external_note_at,
      '…with who wrote it and when, which is what tells them whose words are on a borrower screen');

    /* ── D. the borrower ─────────────────────────────────────────────────── */
    console.log('\nD. the borrower');
    const bList = await call(server, 'GET', `/api/borrower/applications/${appId}/checklist`, bTok);
    const bRows = Array.isArray(bList.body) ? bList.body : (bList.body.items || []);
    const bItem = bRows.find((x) => x.id === shared);
    ok(bList.status === 200 && !!bItem, 'the borrower can read their condition');
    ok(bItem && bItem.external_note && bItem.external_note.note === EXTERNAL,
      'and they SEE the note their loan team wrote for them — the whole ask');
    ok(bItem && bItem.external_note.at, '…dated, so they can tell whether it is current');
    ok(bItem && !('notes' in bItem), 'the INTERNAL note is not on the response at all');
    {
      const blob = JSON.stringify(bList.body);
      ok(!/Fidelis/i.test(blob), 'and the capital-partner name in it never reached them — the live control');
      ok(!/external_note_by/.test(blob), 'nor who wrote the external one');
    }
    // A STAFF MEMBER CAN TYPE A PARTNER NAME INTO THE EXTERNAL NOTE. It is free text
    // and they are human, so the note goes out through the same scrub every other
    // borrower-facing word does — this is defence (b) of the standing rule, and the
    // reason `forClient` refuses to ship anything without a working scrubber.
    await call(server, 'PATCH', `/api/staff/checklist/${shared}`, sTok,
      { externalNote: 'Fidelis is fine with the August statement — please send it.' });
    {
      const slip = await call(server, 'GET', `/api/borrower/applications/${appId}/checklist`, bTok);
      const it = (Array.isArray(slip.body) ? slip.body : (slip.body.items || [])).find((x) => x.id === shared);
      ok(it && it.external_note && /August statement/.test(it.external_note.note),
        'a note naming a capital partner still reaches the borrower…');
      ok(it && !/Fidelis/i.test(it.external_note.note),
        '…with the partner name scrubbed out of it, because a human typed it');
    }
    await call(server, 'PATCH', `/api/staff/checklist/${shared}`, sTok, { externalNote: EXTERNAL });

    // A staff-only condition is not theirs to read at all, note or no note.
    await call(server, 'PATCH', `/api/staff/checklist/${staffOnly}`, sTok, { externalNote: 'this one is on a staff condition' });
    ok(!bRows.some((x) => x.id === staffOnly), 'a STAFF-only condition is not on the borrower list…');
    {
      const again = await call(server, 'GET', `/api/borrower/applications/${appId}/checklist`, bTok);
      ok(!JSON.stringify(again.body).includes('this one is on a staff condition'),
        '…so a note written on one never reaches them either');
    }

    /* ── E. the TPO broker ───────────────────────────────────────────────── */
    console.log('\nE. the broker');
    const firm = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Ext Firm ${sfx}`])).rows[0].id;
    const broker = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Ext Broker','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brk'), firm, hash])).rows[0].id;
    const brkTok = C.signJwt({ sub: broker, kind: 'tpo', role: 'tpo_officer', tv: 0 });
    // Make this file the firm's, the way a broker-entered file is.
    await db.query(`UPDATE applications SET is_tpo=true, tpo_firm_id=$2, loan_officer_id=$3 WHERE id=$1`, [appId, firm, broker]);
    const tList = await call(server, 'GET', `/api/tpo/applications/${appId}/checklist`, brkTok);
    const tRows = (tList.body && tList.body.checklist) || [];
    const tItem = tRows.find((x) => x.id === shared);
    ok(tList.status === 200 && !!tItem, 'the broker can read the condition on their firm\'s file');
    ok(tItem && tItem.external_note && tItem.external_note.note === EXTERNAL,
      'and they see the SAME note the borrower does — one sentence, not two');
    {
      const blob = JSON.stringify(tList.body);
      ok(!/Fidelis/i.test(blob) && !/do not tell the borrower/i.test(blob), 'the internal note never reached the broker');
      ok(!/Ext Note Super/.test(blob), 'nor the name of the staff member who wrote the external one');
    }
    // The same free-text slip, measured on the broker's own door with a REAL token —
    // a check written before the token exists would pass against a 401 body and prove
    // nothing at all.
    await call(server, 'PATCH', `/api/staff/checklist/${shared}`, sTok,
      { externalNote: 'Fidelis is fine with the August statement — please send it.' });
    {
      const slip = await call(server, 'GET', `/api/tpo/applications/${appId}/checklist`, brkTok);
      const it = ((slip.body && slip.body.checklist) || []).find((x) => x.id === shared);
      ok(slip.status === 200 && it && it.external_note && /August statement/.test(it.external_note.note),
        'a note naming a capital partner still reaches the broker…');
      ok(it && !/Fidelis/i.test(it.external_note.note), '…with the partner name scrubbed out of it');
    }
    await call(server, 'PATCH', `/api/staff/checklist/${shared}`, sTok, { externalNote: EXTERNAL });

    /* ── F. taking it back down ──────────────────────────────────────────── */
    console.log('\nF. clearing it');
    const clr = await call(server, 'PATCH', `/api/staff/checklist/${shared}`, sTok, { externalNote: '' });
    ok(clr.status === 200, 'a note can be taken down');
    const after = (await db.query(`SELECT notes, external_note, external_note_by, external_note_at FROM checklist_items WHERE id=$1`, [shared])).rows[0];
    ok(after.external_note === null && after.external_note_by === null && after.external_note_at === null,
      '…and the stamps go with it, so nothing claims an author for a note that is gone');
    ok(after.notes === INTERNAL, 'and the internal note is untouched — the two are independent');
    {
      const b2 = await call(server, 'GET', `/api/borrower/applications/${appId}/checklist`, bTok);
      const it2 = (Array.isArray(b2.body) ? b2.body : (b2.body.items || [])).find((x) => x.id === shared);
      ok(it2 && !it2.external_note, 'the borrower stops seeing it immediately');
    }

    console.log(`\ntest-condition-external-note-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('FAILED:', e && (e.stack || e.message));
    fail++;
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  process.exit(fail ? 1 : 0);
})();
