/**
 * The NOTE-BUYER SLOT (owner-directed 2026-07-27: "we need a better slot … right now
 * I don't believe it's a clear path").
 *
 * `src/lib/note-buyer-effects.noteBuyerSlot(appId)` is the read-only half of the file's
 * Note buyer panel: it answers "what would switching this file to note buyer X do?"
 * BEFORE anything is written. Its whole value is that it is DERIVED — from the live
 * rule trees and the modules that enforce the rest — so this test pins the derivation,
 * not a restatement of it:
 *
 *   (A) it PREDICTS what the engine really does. Every prediction is checked against
 *       the engine ACTUALLY running on the same file: preview says "adds the EMD
 *       condition" → evaluateApplication attaches exactly that; preview says "drops
 *       the note-buyer-missing condition" → the engine really retracts it.
 *   (B) it only ever attributes note-buyer-DRIVEN conditions (a template whose rule
 *       mentions the note buyer), never something pending for its own reasons.
 *   (C) it respects the engine's untouched rule — a condition someone has worked is
 *       never previewed as dropping, because the engine would not remove it either.
 *   (D) the standing requirements come from the enforcing modules (5% SOW contingency,
 *       bank-statement months, data tape) and say which of them the NOTE BUYER carries.
 *   (E) it never lies about a frozen file: on a terminal status nothing is previewed.
 *   (F) a typed note buyer ClickUp has never heard of still gets a real preview.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-note-buyer-slot-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const engine = require('../src/lib/conditions/engine');
const NB = require('../src/lib/note-buyer-effects');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const codesOf = (list) => (list || []).map((x) => x.code).filter(Boolean).sort();
const liveCodes = async (appId) => (await db.query(
  `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
    WHERE ci.application_id = $1 AND t.code IS NOT NULL ORDER BY t.code`, [appId])).rows.map((r) => r.code);

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId; let staffIds = []; let srv = null;
  try {
    // ---- pure helpers -------------------------------------------------------
    const { mentionsNoteBuyer, isUntouched } = NB._internals;
    assert(mentionsNoteBuyer({ combinator: 'and', rules: [{ field: 'note_buyer', operator: 'eq', value: 'corrfirst' }] }),
      'mentionsNoteBuyer: a top-level note_buyer row counts');
    assert(mentionsNoteBuyer({ combinator: 'or', rules: [{ field: 'in_flood_zone', operator: 'is_true' },
      { combinator: 'and', rules: [{ field: 'note_buyer_is_fidelis', operator: 'is_false' }] }] }),
      'mentionsNoteBuyer: a NESTED note_buyer_is_fidelis row counts (the flood rule shape)');
    assert(!mentionsNoteBuyer({ combinator: 'and', rules: [{ field: 'fico', operator: 'lt', value: 700 }] }),
      'mentionsNoteBuyer: an unrelated rule does NOT count');
    assert(!mentionsNoteBuyer(null) && !mentionsNoteBuyer('note_buyer'),
      'mentionsNoteBuyer: junk input is false, never a throw');
    assert(isUntouched({ origin_kind: 'auto', status: 'outstanding' }) === true,
      'isUntouched: a fresh auto condition is untouched');
    assert(isUntouched({ origin_kind: 'auto', status: 'outstanding', has_docs: true }) === false,
      'isUntouched: a document on the item makes it touched');
    assert(isUntouched({ origin_kind: 'manual', status: 'outstanding' }) === false,
      'isUntouched: a hand-added condition is never engine-owned');

    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Slot','Test',$1) RETURNING id`,
      [`nbslot-${sfx}@test.local`])).rows[0].id;

    // ---- (A)+(B) the preview predicts what the engine really does -----------
    // A brand-new file with NO note buyer. The engine gives it the internal
    // "Note buyer missing" condition; switching to CorrFirst should be previewed as
    // ADDING the EMD condition and DROPPING the missing-note-buyer one.
    // A PURCHASE file (loan_type set): the EMD condition is purchase-only (db/475),
    // and this suite previews/attaches EMD when the note buyer switches to CorrFirst.
    const app = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'processing','Purchase') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(app, { reason: 'test', notify: false });
    assert((await liveCodes(app)).includes('cond_note_buyer_missing'),
      'setup: a file with no note buyer carries the "note buyer missing" condition');

    let slot = await NB.noteBuyerSlot(app, db, { candidate: 'CorrFirst' });
    assert(slot.current.label === null && slot.current.key === null, 'an unset note buyer reads as null, not a guess');
    assert(slot.options.some((o) => o.value === 'corrfirst'), 'the candidate is offered as an option');
    const cf = slot.effects.corrfirst;
    assert(!!cf && cf.previewed === true, 'CorrFirst is previewed on an open file');
    assert(codesOf(cf.conditions.adds).includes('cond_emd_corrfirst'),
      'preview: switching to CorrFirst ADDS the EMD condition');
    assert(codesOf(cf.conditions.drops).includes('cond_note_buyer_missing'),
      'preview: switching to CorrFirst DROPS the "note buyer missing" condition');

    // Now actually do it, and hold the preview to its word.
    const beforeCodes = await liveCodes(app);
    await db.query(`UPDATE applications SET lender='CorrFirst' WHERE id=$1`, [app]);
    const ev = await engine.evaluateApplication(app, { reason: 'test', notify: false });
    const afterCodes = await liveCodes(app);
    const reallyAdded = afterCodes.filter((c) => !beforeCodes.includes(c)).sort();
    const reallyRemoved = beforeCodes.filter((c) => !afterCodes.includes(c)).sort();
    assert(JSON.stringify(reallyAdded) === JSON.stringify(codesOf(cf.conditions.adds)),
      `the engine added EXACTLY what the preview promised (${JSON.stringify(reallyAdded)})`);
    assert(JSON.stringify(reallyRemoved) === JSON.stringify(codesOf(cf.conditions.drops)),
      `the engine removed EXACTLY what the preview promised (${JSON.stringify(reallyRemoved)})`);
    assert(ev.added.length > 0, 'the engine result the write path reports back is non-empty on a real change');

    // (B) nothing that is NOT note-buyer-driven is ever attributed to the switch.
    const driven = (await db.query(
      `SELECT code FROM checklist_templates WHERE is_active AND scope='application'
         AND auto_apply='rules' AND rule_logic::text LIKE '%note_buyer%' AND code IS NOT NULL`)).rows.map((r) => r.code);
    slot = await NB.noteBuyerSlot(app);
    const everyMentioned = Object.values(slot.effects).every((e) =>
      [...e.conditions.adds, ...e.conditions.drops].every((c) => !c.code || driven.includes(c.code)));
    assert(everyMentioned, 'every previewed condition belongs to a note-buyer-driven template');

    // ---- (C) a TOUCHED condition is never previewed as dropping -------------
    // The file is CorrFirst and carries the (untouched) EMD condition, so switching
    // away previews it as a drop. Put a note on it — now the engine would keep it,
    // and so must the preview.
    slot = await NB.noteBuyerSlot(app, db, { candidate: 'Fidelis' });
    const fidKey = Object.keys(slot.effects).find((k) => k.startsWith('fidelis'));
    assert(codesOf(slot.effects[fidKey].conditions.drops).includes('cond_emd_corrfirst'),
      'preview: switching away from CorrFirst drops the UNTOUCHED EMD condition');
    await db.query(
      `UPDATE checklist_items SET notes='a human worked this'
        WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code='cond_emd_corrfirst')`, [app]);
    slot = await NB.noteBuyerSlot(app, db, { candidate: 'Fidelis' });
    assert(!codesOf(slot.effects[fidKey].conditions.drops).includes('cond_emd_corrfirst'),
      'preview: a WORKED EMD condition is NOT promised as dropping (the engine keeps it)');
    // …and the engine agrees.
    await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [app]);
    await engine.evaluateApplication(app, { reason: 'test', notify: false });
    assert((await liveCodes(app)).includes('cond_emd_corrfirst'),
      'the engine really does keep the worked condition — the preview was right');

    // ---- (D) standing requirements, and WHOSE they are ----------------------
    const blFile = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','Blue Lake') RETURNING id`, [borrowerId])).rows[0].id;
    slot = await NB.noteBuyerSlot(blFile);
    const bl = slot.effects.bluelake;
    const req = (key) => (bl.requirements || []).find((r) => r.key === key);
    assert(!!req('sow_contingency') && req('sow_contingency').fromNoteBuyer === true,
      'Blue Lake carries the 5% Scope-of-Work contingency, attributed to the NOTE BUYER');
    assert(/5%/.test(req('sow_contingency').text), 'the contingency line states the 5%');
    assert(!!req('bank_statements') && /2 months/.test(req('bank_statements').text) && req('bank_statements').fromNoteBuyer === true,
      'Blue Lake raises bank statements to 2 months, attributed to the note buyer');
    assert(!!req('data_tape') && /Blue Lake/i.test(req('data_tape').text), 'Blue Lake names its data tape');

    const fid = slot.effects[Object.keys(slot.effects).find((k) => k.startsWith('fidelis'))];
    assert(fid && !(fid.requirements || []).some((r) => r.key === 'sow_contingency'),
      'Fidelis does NOT carry the 5% contingency');
    assert(fid && /1 month/.test(((fid.requirements || []).find((r) => r.key === 'bank_statements') || {}).text || ''),
      'Fidelis leaves bank statements at the program count (1 month)');

    // A GOLD-registered file requires the 5% for the PROGRAM's sake — the line must
    // say so rather than let a note-buyer switch read as removing the requirement.
    const gold = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','Fidelis') RETURNING id`, [borrowerId])).rows[0].id;
    await db.query(
      `INSERT INTO product_registrations (application_id,program,inputs,quote,is_current)
       VALUES ($1,'gold','{}'::jsonb,'{}'::jsonb,true)`, [gold]);
    slot = await NB.noteBuyerSlot(gold);
    const goldFid = slot.effects[Object.keys(slot.effects).find((k) => k.startsWith('fidelis'))];
    const goldSow = (goldFid.requirements || []).find((r) => r.key === 'sow_contingency');
    assert(!!goldSow && goldSow.fromNoteBuyer === false && /Gold/.test(goldSow.text),
      'on a Gold file the 5% is shown as the PROGRAM\'s requirement, not the note buyer\'s');

    // ---- (E) a frozen file is never promised a condition change -------------
    const funded = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'funded','CorrFirst') RETURNING id`, [borrowerId])).rows[0].id;
    slot = await NB.noteBuyerSlot(funded);
    assert(Object.values(slot.effects).every((e) => e.previewed === false),
      'a funded (frozen) file previews NO condition changes — the engine would attach nothing');
    assert(Object.values(slot.effects).every((e) => !e.conditions.adds.length && !e.conditions.drops.length),
      'a frozen file\'s preview lists no adds or drops');
    assert(!!slot.effects[slot.current.key], 'a frozen file still explains its CURRENT note buyer\'s requirements');

    // ---- (F) a typed name ClickUp never heard of still previews -------------
    slot = await NB.noteBuyerSlot(blFile, db, { candidate: 'Some Brand New Partner LLC' });
    const typed = slot.effects.somebrandnewpartnerllc;
    assert(!!typed && typed.previewed === true, 'a typed note buyer gets a real preview');
    assert(typed.label === 'Some Brand New Partner LLC', 'the typed name keeps its spelling for display');
    assert(codesOf(typed.conditions.drops).length >= 0 && !codesOf(typed.conditions.adds).includes('cond_emd_corrfirst'),
      'a typed unknown partner does not pick up CorrFirst\'s condition');

    // The file's own note buyer is ALWAYS offerable, even if ClickUp never heard of it.
    await db.query(`UPDATE applications SET lender='Off Menu Capital' WHERE id=$1`, [blFile]);
    slot = await NB.noteBuyerSlot(blFile);
    assert(slot.options.some((o) => o.label === 'Off Menu Capital'), 'the file\'s own note buyer is always in the options');
    assert(slot.current.key === 'offmenucapital', 'the current note buyer is reported by its normalized key');

    // ---- never throws -------------------------------------------------------
    const gone = await NB.noteBuyerSlot('00000000-0000-0000-0000-000000000000');
    assert(gone && gone.current.label === null && Object.keys(gone.effects).length === 0,
      'a missing file returns an empty slot instead of throwing');

    // ---- the real doors, over HTTP -----------------------------------------
    // The slot is only useful if the file screen can actually reach it, and the WRITE
    // path has to report honestly: saving re-checks the WHOLE file, so a change must
    // never be credited to the note buyer unless its own rule references one.
    const crypto = require('../src/lib/crypto');
    const server = require('../src/server');
    const staff = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,password_hash)
       VALUES ($1,'Slot HTTP','super_admin',true,'x') RETURNING id, token_version`,
      [`nbslot-admin-${sfx}@test.local`])).rows[0];
    const stranger = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,password_hash)
       VALUES ($1,'Not On File','loan_officer',true,'x') RETURNING id, token_version`,
      [`nbslot-lo-${sfx}@test.local`])).rows[0];
    staffIds = [staff.id, stranger.id];
    const httpApp = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'processing','Purchase') RETURNING id`, [borrowerId])).rows[0].id;
    const tokenFor = (u, role) => crypto.signJwt(
      { sub: u.id, kind: 'staff', role, tv: u.token_version || 0, sid: `slot-${sfx}-${role}` }, 3600);

    srv = server.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const H = { Authorization: `Bearer ${tokenFor(staff, 'super_admin')}`, 'Content-Type': 'application/json' };

    let resp = await fetch(`${base}/api/staff/applications/${httpApp}/note-buyer`, { headers: H });
    let body = await resp.json().catch(() => null);
    assert(resp.status === 200, `GET /note-buyer answers 200 (got ${resp.status})`);
    assert(!!body && Array.isArray(body.options) && body.options.length > 0, 'the route returns the pickable note buyers');
    assert(!!body && body.effects && Object.keys(body.effects).length > 0, 'the route returns per-option effects');

    resp = await fetch(`${base}/api/staff/applications/${httpApp}/note-buyer?candidate=${encodeURIComponent('Brand New Buyer')}`, { headers: H });
    body = await resp.json().catch(() => null);
    assert(resp.status === 200 && !!body.effects.brandnewbuyer, '?candidate= previews a name ClickUp does not offer');

    resp = await fetch(`${base}/api/staff/applications/${httpApp}/complete-fields`,
      { method: 'POST', headers: H, body: JSON.stringify({ lender: 'CorrFirst' }) });
    body = await resp.json().catch(() => null);
    assert(resp.status === 200, `POST complete-fields {lender} answers 200 (got ${resp.status})`);
    const changedAdds = (body && body.conditionsChanged && body.conditionsChanged.added) || [];
    assert(changedAdds.length > 0, `the write path reports what changed (${changedAdds.map((x) => x.label).join(', ')})`);
    assert(changedAdds.every((x) => typeof x.byNoteBuyer === 'boolean'), 'every reported change is tagged byNoteBuyer');
    assert(changedAdds.some((x) => x.byNoteBuyer && /earnest money/i.test(x.label)),
      'the EMD condition is tagged as caused BY the note buyer');
    assert(changedAdds.some((x) => !x.byNoteBuyer),
      'a condition the full re-check picked up for its OWN reasons is tagged as NOT the note buyer\'s doing');
    assert((await db.query(`SELECT lender FROM applications WHERE id=$1`, [httpApp])).rows[0].lender === 'CorrFirst',
      're-read after the 200: the note buyer really persisted');

    resp = await fetch(`${base}/api/staff/applications/${httpApp}/note-buyer`,
      { headers: { Authorization: `Bearer ${tokenFor(stranger, 'loan_officer')}` } });
    assert(resp.status === 403 || resp.status === 404,
      `a staffer who is not on the file cannot read its note-buyer slot (${resp.status})`);

  } catch (e) {
    console.error('FAIL (exception)', e && e.stack || e); failures++;
  } finally {
    try { if (srv) srv.close(); } catch (_) { /* the listener is throwaway */ }
    try {
      if (borrowerId) {
        await db.query(`DELETE FROM checklist_items WHERE application_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [borrowerId]);
        await db.query(`DELETE FROM product_registrations WHERE application_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [borrowerId]);
        await db.query(`DELETE FROM audit_log WHERE entity_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [borrowerId]);
        await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]);
        await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
      }
      if (staffIds.length) await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [staffIds]);
    } catch (_) { /* best-effort cleanup */ }
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll note-buyer slot checks passed.');
    process.exit(failures ? 1 : 0);
  }
})();
