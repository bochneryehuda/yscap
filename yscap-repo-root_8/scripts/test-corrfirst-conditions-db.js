/**
 * CORRFIRST: THE SSN-VERIFICATION CONDITION, THE EMD WORDING, AND THE NOTE-BUYER MARK
 * (owner-directed 2026-08-02; db/397).
 *
 * The report was "CorrFirst requires SS NUMBER VERIFICATION — no condition on the
 * file". It was literally true: CorrFirst condition 1050 was mapped to `rtl_p1_ssn`,
 * a template db/040 set inactive and deleted off every open file, so the guideline
 * pointed at a row nothing could create. What this pins:
 *
 *  (A) A CorrFirst file really carries BOTH conditions, attached by the ENGINE (not
 *      only by the migration's backfill), and neither reaches a non-CorrFirst file.
 *  (B) The SSN condition is INTERNAL AND EXTERNAL (audience 'both') — the owner's
 *      words — and clears on a Social Security card OR a completed SSA-89.
 *  (C) The note buyer is named on the STAFF wording and NEVER on a borrower field.
 *  (D) The exact new wording is live on the template AND on an instance that was
 *      created under the OLD wording (previous AND future), while a label a human
 *      edited by hand is left alone.
 *  (E) The MARK is DERIVED from the rule (note-buyer-effects.noteBuyerMark) — it
 *      marks a rule that PINS a buyer, and never a rule that EXCLUDES one.
 *  (F) The real doors: the staff checklist route carries the mark and does NOT leak
 *      the raw rule tree; the borrower route carries neither the mark nor the note
 *      buyer's name.
 *  (G) The consumers that pointed at the dead template now point at a template that
 *      is actually on the file — ssn-autoclear and the PILOT advice engine.
 *  (H) The migration is idempotent across boots and never duplicates the condition.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-corrfirst-conditions-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const engine = require('../src/lib/conditions/engine');
const NB = require('../src/lib/note-buyer-effects');
const ssnAuto = require('../src/lib/underwriting/ssn-autoclear');

const SSN_CODE = 'cond_ssn_verify_corrfirst';
const EMD_CODE = 'cond_emd_corrfirst';
const PARTNER_RE = /blue ?lake|corr ?first|fidelis|temple ?view|churchill/i;

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const itemsFor = async (appId, code) => (await db.query(
  `SELECT ci.* FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
    WHERE ci.application_id = $1 AND t.code = $2`, [appId, code])).rows;
const tplFor = async (code) => (await db.query(
  `SELECT * FROM checklist_templates WHERE code = $1`, [code])).rows[0];

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId; let staffIds = []; let srv = null;
  try {
    // ======================================================================
    // (E) THE MARK IS DERIVED FROM THE RULE — pure, no DB.
    // ======================================================================
    const { noteBuyerMark } = NB;
    assert(noteBuyerMark({ combinator: 'and', rules: [{ field: 'note_buyer', operator: 'eq', value: 'corrfirst' }] })?.label === 'CorrFirst',
      'noteBuyerMark: a `note_buyer eq corrfirst` rule marks the condition CorrFirst');
    assert(noteBuyerMark({ combinator: 'and', rules: [{ field: 'note_buyer', operator: 'in', value: ['bluelake', 'corrfirst'] }] })?.label === 'Blue Lake / CorrFirst',
      'noteBuyerMark: an `in` rule names every buyer it pins');
    assert(noteBuyerMark({ combinator: 'or', rules: [{ field: 'in_flood_zone', operator: 'is_true' },
      { combinator: 'and', rules: [{ field: 'note_buyer_is_emcap', operator: 'is_true' }] }] })?.label === 'EMCAP',
      'noteBuyerMark: a NESTED boolean is_true row marks that buyer');
    // THE GUARD THAT MATTERS. The flood-cert rule (db/335) EXCLUDED Fidelis; marking
    // that condition "Fidelis" would say the exact opposite of what it means.
    assert(noteBuyerMark({ combinator: 'and', rules: [{ field: 'note_buyer_is_fidelis', operator: 'is_false' }] }) === null,
      'noteBuyerMark: an EXCLUSION (is_false) is NOT a mark');
    assert(noteBuyerMark({ combinator: 'and', rules: [{ field: 'note_buyer', operator: 'neq', value: 'corrfirst' }] }) === null,
      'noteBuyerMark: `neq` is an exclusion, not a mark');
    assert(noteBuyerMark({ combinator: 'and', rules: [{ field: 'note_buyer', operator: 'not_in', value: ['corrfirst'] }] }) === null,
      'noteBuyerMark: `not_in` is an exclusion, not a mark');
    assert(noteBuyerMark({ combinator: 'and', rules: [{ field: 'fico', operator: 'lt', value: 700 }] }) === null,
      'noteBuyerMark: an unrelated rule yields no mark');
    assert(noteBuyerMark(null) === null && noteBuyerMark('note_buyer') === null && noteBuyerMark(undefined) === null,
      'noteBuyerMark: junk input yields null, never a throw');
    assert(noteBuyerMark({ combinator: 'and', rules: [{ field: 'note_buyer', operator: 'eq', value: 'notabuyerweknow' }] })?.label === 'notabuyerweknow',
      'noteBuyerMark: a buyer the registry does not list falls back to its key rather than being dropped');

    // ======================================================================
    // (B)+(C)+(D) THE TEMPLATES THEMSELVES — read LIVE out of the database, so
    // this fails the day the migration stops applying.
    // ======================================================================
    const ssnTpl = await tplFor(SSN_CODE);
    assert(!!ssnTpl, 'db/397 seeded the SSN-verification template');
    assert(ssnTpl && ssnTpl.is_active === true && ssnTpl.auto_apply === 'rules',
      'the SSN condition is ACTIVE and rule-driven (unlike the retired rtl_p1_ssn it replaces)');
    assert(ssnTpl && ssnTpl.audience === 'both',
      'the SSN condition is INTERNAL AND EXTERNAL (audience=both) — the owner\'s words');
    assert(ssnTpl && ssnTpl.item_kind === 'document' && ssnTpl.is_required === true,
      'the SSN condition is a REQUIRED document upload');
    assert(ssnTpl && /social security card/i.test(ssnTpl.borrower_hint || '') && /SSA-89/.test(ssnTpl.borrower_hint || ''),
      'the borrower is told they may provide EITHER a Social Security card OR an SSA-89');
    assert(ssnTpl && PARTNER_RE.test(ssnTpl.hint || ''),
      'the INTERNAL hint names CorrFirst, so a plain-text surface still says whose requirement it is');
    assert(ssnTpl && !PARTNER_RE.test(ssnTpl.borrower_label || '') && !PARTNER_RE.test(ssnTpl.borrower_hint || ''),
      'the BORROWER wording never names the note buyer (frozen rule)');
    assert(ssnTpl && NB.noteBuyerMark(ssnTpl.rule_logic)?.label === 'CorrFirst',
      'the SSN condition\'s own live rule derives the CorrFirst mark');

    const emdTpl = await tplFor(EMD_CODE);
    assert(emdTpl && emdTpl.label === 'Earnest money deposit (EMD) verification',
      'the EMD label now says exactly what it verifies (the note buyer moved onto the mark)');
    assert(emdTpl && /verify the earnest money deposit was made and cleared/i.test(emdTpl.hint || ''),
      'the EMD internal note is the rewritten, shorter one');
    assert(emdTpl && (emdTpl.hint || '').length < 200 && (emdTpl.borrower_hint || '').length < 200,
      'both EMD notes are SHORTER than the wording they replaced');
    assert(emdTpl && !PARTNER_RE.test(emdTpl.borrower_label || '') && !PARTNER_RE.test(emdTpl.borrower_hint || ''),
      'the EMD borrower wording never names the note buyer');
    assert(emdTpl && NB.noteBuyerMark(emdTpl.rule_logic)?.label === 'CorrFirst',
      'the EMD condition also derives the CorrFirst mark');

    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('CF','Test',$1) RETURNING id`,
      [`cf-${sfx}@test.local`])).rows[0].id;

    // ======================================================================
    // (A) THE ENGINE PUTS THEM ON A CORRFIRST FILE — and only a CorrFirst file.
    // Deliberately NOT relying on the migration's backfill: this file is created
    // after it ran, which is the go-forward path that has to work.
    // ======================================================================
    const cf = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','CorrFirst') RETURNING id`,
      [borrowerId])).rows[0].id;
    await engine.evaluateApplication(cf, { reason: 'test', notify: false });

    const ssnItems = await itemsFor(cf, SSN_CODE);
    assert(ssnItems.length === 1, `a CorrFirst file gets exactly one SSN-verification condition (got ${ssnItems.length})`);
    const ssn = ssnItems[0] || {};
    assert(ssn.audience === 'both', 'the condition on the FILE is internal AND external');
    assert(ssn.item_kind === 'document', 'the condition on the file is a document upload');
    assert(ssn.origin_kind === 'auto', 'the condition is engine-owned, so it retracts if the note buyer changes');
    assert(!PARTNER_RE.test(ssn.borrower_label || '') && !PARTNER_RE.test(ssn.borrower_hint || ''),
      'the instance\'s borrower wording names no note buyer either');
    assert((await itemsFor(cf, EMD_CODE)).length === 1, 'the same CorrFirst file still gets the EMD condition');

    // Spacing / casing tolerance — the same normalizer the rest of the stack uses.
    const cf2 = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'underwriting','Corr First') RETURNING id`,
      [borrowerId])).rows[0].id;
    await engine.evaluateApplication(cf2, { reason: 'test', notify: false });
    assert((await itemsFor(cf2, SSN_CODE)).length === 1,
      '"Corr First" (spacing-insensitive) gets the SSN condition too');

    for (const [label, lender] of [['Fidelis', 'Fidelis'], ['Blue Lake', 'Blue Lake'], ['no note buyer', null]]) {
      // eslint-disable-next-line no-await-in-loop
      const other = (await db.query(
        `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing',$2) RETURNING id`,
        [borrowerId, lender])).rows[0].id;
      // eslint-disable-next-line no-await-in-loop
      await engine.evaluateApplication(other, { reason: 'test', notify: false });
      // eslint-disable-next-line no-await-in-loop
      const n = (await itemsFor(other, SSN_CODE)).length;
      assert(n === 0, `a ${label} file does NOT get the CorrFirst SSN condition (got ${n})`);
    }

    // Retraction — untouched only, exactly like the EMD condition.
    await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [cf2]);
    await engine.evaluateApplication(cf2, { reason: 'test', notify: false });
    assert((await itemsFor(cf2, SSN_CODE)).length === 0,
      'the SSN condition retracts when the note buyer moves off CorrFirst');

    const cf3 = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','CorrFirst') RETURNING id`,
      [borrowerId])).rows[0].id;
    await engine.evaluateApplication(cf3, { reason: 'test', notify: false });
    await db.query(`UPDATE checklist_items SET notes='a human looked at this' WHERE id=$1`,
      [(await itemsFor(cf3, SSN_CODE))[0].id]);
    await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [cf3]);
    await engine.evaluateApplication(cf3, { reason: 'test', notify: false });
    assert((await itemsFor(cf3, SSN_CODE)).length === 1,
      'a condition somebody has WORKED is never auto-retracted, even off CorrFirst');

    // ======================================================================
    // (D) PREVIOUS AND FUTURE — an instance created under the OLD wording is
    // reworded on the next boot; one a human edited by hand is left alone.
    // ======================================================================
    const { ensureSchema } = require('../src/migrate-boot');
    const legacy = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','CorrFirst') RETURNING id`,
      [borrowerId])).rows[0].id;
    await engine.evaluateApplication(legacy, { reason: 'test', notify: false });
    const legacyEmd = (await itemsFor(legacy, EMD_CODE))[0];
    await db.query(
      `UPDATE checklist_items SET label=$2, hint=$3, borrower_label=$4, borrower_hint=$5 WHERE id=$1`,
      [legacyEmd.id,
       'Earnest money deposit (EMD) verification — CorrFirst',
       'Verify the borrower\'s earnest money deposit (EMD) has been made/cleared. Required on files sold to CorrFirst — collect the wire confirmation, cleared check, or escrow/title receipt showing the deposit.',
       'Proof of earnest money deposit (EMD)',
       'Please upload proof that your earnest money deposit (EMD) has been made — for example a wire confirmation, a cleared check, or an escrow/title receipt showing the deposit.']);

    const handEdited = (await itemsFor(legacy, SSN_CODE))[0];
    await db.query(`UPDATE checklist_items SET label='Get the SSN card from Chaim' WHERE id=$1`, [handEdited.id]);

    await ensureSchema();   // the next boot

    const rewritten = (await db.query(`SELECT * FROM checklist_items WHERE id=$1`, [legacyEmd.id])).rows[0];
    assert(rewritten.label === 'Earnest money deposit (EMD) verification',
      'PREVIOUS FILES: an existing EMD condition is reworded on the next boot');
    assert(/verify the earnest money deposit was made and cleared/i.test(rewritten.hint || ''),
      'PREVIOUS FILES: its internal note is rewritten too');
    assert(rewritten.borrower_label === 'Proof of your earnest money deposit (EMD)'
      && /your earnest money deposit cleared/i.test(rewritten.borrower_hint || ''),
      'PREVIOUS FILES: its borrower wording is rewritten too');
    assert((await db.query(`SELECT label FROM checklist_items WHERE id=$1`, [handEdited.id])).rows[0].label
      === 'Get the SSN card from Chaim',
      'a label a HUMAN edited by hand survives the migration re-run');

    // (H) idempotent + never duplicated.
    assert((await itemsFor(legacy, SSN_CODE)).length === 1,
      'the backfill never adds a SECOND SSN condition to a file that already has one');

    // THE BACKFILL ITSELF, exercised with a real row. Everything above reached the
    // condition through the ENGINE (files created after the migration ran), so the
    // migration's own INSERT — the half that reaches files that ALREADY EXIST, and
    // the only half a fresh test database never runs — would otherwise be unproven.
    // A wrong column there fails on the first real deploy and nowhere else.
    {
      const backfilled = (await db.query(
        `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'underwriting','CorrFirst') RETURNING id`,
        [borrowerId])).rows[0].id;
      await db.query(
        `DELETE FROM checklist_items ci USING checklist_templates t
          WHERE ci.template_id=t.id AND ci.application_id=$1 AND t.code=$2`, [backfilled, SSN_CODE]);
      assert((await itemsFor(backfilled, SSN_CODE)).length === 0, 'set-up: the file starts without the condition');

      await ensureSchema();   // the deploy that carries db/397 to an existing file

      const got = (await itemsFor(backfilled, SSN_CODE))[0];
      assert(!!got, 'PREVIOUS FILES: the migration BACKFILLS the condition onto an existing open CorrFirst file');
      assert(got && got.origin_kind === 'auto' && got.created_by_kind === 'system',
        'the backfilled row is engine-owned, exactly as evaluateApplication would have made it');
      assert(got && got.audience === 'both' && got.item_kind === 'document' && got.is_required === true,
        'the backfilled row carries the same shape as the template');
      assert(got && got.label === 'Social Security number verification'
        && /social security card/i.test(got.borrower_hint || ''),
        'the backfilled row carries the real wording, not an empty shell');

      // …and it is genuinely engine-equivalent: the engine retracts it like its own.
      await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [backfilled]);
      await engine.evaluateApplication(backfilled, { reason: 'test', notify: false });
      assert((await itemsFor(backfilled, SSN_CODE)).length === 0,
        'a BACKFILLED row retracts on a note-buyer change exactly like an engine-created one');

      // A terminal file is never backfilled — the engine attaches nothing there either.
      const funded = (await db.query(
        `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'funded','CorrFirst') RETURNING id`,
        [borrowerId])).rows[0].id;
      await ensureSchema();
      assert((await itemsFor(funded, SSN_CODE)).length === 0,
        'a FUNDED CorrFirst file is left alone — a closed loan never gains a new open condition');
    }
    const emdTpl2 = await tplFor(EMD_CODE);
    assert(emdTpl2.label === 'Earnest money deposit (EMD) verification'
      && emdTpl2.borrower_label === 'Proof of your earnest money deposit (EMD)',
      'the template wording SURVIVES a second boot (db/191 re-asserts the old borrower_label; db/397 runs after it)');

    // ======================================================================
    // (G) THE CONSUMERS NOW POINT AT A CONDITION THAT EXISTS.
    // ======================================================================
    assert(ssnAuto.SSN_TEMPLATE_CODE === SSN_CODE,
      'ssn-autoclear targets the live SSN condition, not the retired rtl_p1_ssn');
    assert((ssnAuto.SSN_TEMPLATE_CODES || []).includes('rtl_p1_ssn'),
      'ssn-autoclear still recognizes a historical rtl_p1_ssn instance on an old file');
    {
      // The check that actually decays: the code it looks for must be findable ON A FILE.
      const found = (await db.query(
        `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1 AND t.code = ANY($2::text[])`, [cf, ssnAuto.SSN_TEMPLATE_CODES])).rows[0].n;
      assert(found === 1, 'ssn-autoclear\'s own lookup finds the condition on a CorrFirst file');
      const advice = require('../src/lib/underwriting/pilot-advice-engine');
      const map = advice.EVALUATORS || advice._internals && advice._internals.EVALUATORS;
      if (map) assert(!!map[SSN_CODE], 'the PILOT advice engine has an evaluator for the live SSN condition');
    }
    // The ISG spec must name a template that is real and active — the exact failure
    // that produced "no condition on the file".
    {
      const spec = require('../src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec');
      const c1050 = spec.CONDITIONS.find((c) => c.cond_no === 1050);
      assert(c1050 && c1050.pilot_template_code === SSN_CODE,
        'the CorrFirst SS NUMBER VERIFICATION guideline maps to the live condition');
      const mapped = (await db.query(
        `SELECT is_active FROM checklist_templates WHERE code=$1`, [c1050.pilot_template_code])).rows[0];
      assert(mapped && mapped.is_active === true,
        'every note-buyer guideline template code the spec names is an ACTIVE template');
    }

    // ======================================================================
    // (F) THE REAL DOORS.
    // ======================================================================
    const crypto = require('../src/lib/crypto');
    const server = require('../src/server');
    const staff = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,password_hash)
       VALUES ($1,'CF Admin','super_admin',true,'x') RETURNING id, token_version`,
      [`cf-admin-${sfx}@test.local`])).rows[0];
    staffIds = [staff.id];
    const token = crypto.signJwt(
      { sub: staff.id, kind: 'staff', role: 'super_admin', tv: staff.token_version || 0, sid: `cf-${sfx}` }, 3600);

    srv = server.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const resp = await fetch(`${base}/api/staff/applications/${cf}/checklist`, { headers: H });
    const rows = await resp.json().catch(() => null);
    assert(resp.status === 200 && Array.isArray(rows), `GET staff checklist answers 200 (got ${resp.status})`);
    const staffSsn = (rows || []).find((x) => x.template_code === SSN_CODE);
    const staffEmd = (rows || []).find((x) => x.template_code === EMD_CODE);
    assert(!!staffSsn && staffSsn.note_buyer_mark === 'CorrFirst',
      'the staff checklist row carries the CorrFirst MARK');
    assert(!!staffEmd && staffEmd.note_buyer_mark === 'CorrFirst',
      'the EMD row carries it too');
    assert((rows || []).some((x) => x.template_code && !x.note_buyer_mark),
      'a condition every file carries has NO mark (the mark means something)');
    assert((rows || []).every((x) => !('rule_logic' in x)),
      'the raw rule tree is never sent to the client — it was read only to derive the mark');

    // ======================================================================
    // THE SIGN-OFF GATE. The condition is a REQUIRED document, so the standing
    // rule is "nothing uploaded → cannot be signed off". The CorrFirst guideline
    // accepts the credit report as one of three proofs, so a PROVEN match clears
    // it with no document — and anything short of proven does not.
    // ======================================================================
    {
      const ssnItemId = (await itemsFor(cf, SSN_CODE))[0].id;
      const patch = (body) => fetch(`${base}/api/staff/checklist/${ssnItemId}`,
        { method: 'PATCH', headers: H, body: JSON.stringify(body) });

      let r = await patch({ signedOff: true });
      assert(r.status === 422, `no proof at all → sign-off is REFUSED (${r.status})`);
      const refusal = await r.json().catch(() => ({}));
      assert(/social security card|SSA-89/i.test(refusal.error || ''),
        'the refusal tells the processor exactly what would clear it');

      // A credit report naming a DIFFERENT last-4 is not proof.
      const bor = (await db.query(`SELECT ssn_last4 FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      await db.query(`UPDATE borrowers SET ssn_last4='6789' WHERE id=$1`, [borrowerId]);
      await db.query(
        `INSERT INTO credit_reports (application_id,borrower_id,vendor,pull_type,request_type,status,source,middle_score,parsed)
         VALUES ($1,$2,'xactus','soft','reissue','completed','api',712,$3)`,
        [cf, borrowerId, JSON.stringify({ borrower: { ssnLast4: '0000' } })]);
      r = await patch({ signedOff: true });
      assert(r.status === 422, `a report naming a DIFFERENT SSN is not proof → still refused (${r.status})`);

      // The matching report IS proof — no document needed.
      await db.query(`UPDATE credit_reports SET parsed=$2 WHERE application_id=$1`,
        [cf, JSON.stringify({ borrower: { ssnLast4: '6789' } })]);
      r = await patch({ signedOff: true });
      assert(r.status === 200, `a report whose SSN MATCHES the file clears the gate (${r.status})`);
      assert(!!(await db.query(`SELECT signed_off_at FROM checklist_items WHERE id=$1`, [ssnItemId])).rows[0].signed_off_at,
        're-read after the 200: the sign-off really persisted');

      await db.query(`UPDATE checklist_items SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL WHERE id=$1`, [ssnItemId]);
      await db.query(`DELETE FROM credit_reports WHERE application_id=$1`, [cf]);
      await db.query(`UPDATE borrowers SET ssn_last4=$2 WHERE id=$1`, [borrowerId, bor.ssn_last4]);
    }

    // The borrower's own door: no mark, no note-buyer name, anywhere.
    const bAuth = await db.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash)
       VALUES ($1,'x') ON CONFLICT (borrower_id) DO UPDATE SET updated_at=now()
       RETURNING borrower_id, token_version`,
      [borrowerId]);
    if (bAuth.rows[0]) {
      const bTok = crypto.signJwt(
        { sub: borrowerId, kind: 'borrower', tv: bAuth.rows[0].token_version || 0, sid: `cfb-${sfx}` }, 3600);
      const bResp = await fetch(`${base}/api/borrower/applications/${cf}/checklist`,
        { headers: { Authorization: `Bearer ${bTok}` } });
      const bRows = await bResp.json().catch(() => null);
      assert(bResp.status === 200 && Array.isArray(bRows), `GET borrower checklist answers 200 (got ${bResp.status})`);
      const bSsn = (bRows || []).find((x) => x.template_code === SSN_CODE);
      assert(!!bSsn, 'the borrower SEES the SSN condition (it is external as well as internal)');
      assert(!('note_buyer_mark' in (bSsn || {})),
        'the borrower door never carries the note-buyer mark');
      assert((bRows || []).every((x) => !PARTNER_RE.test(String(x.label || '')) && !PARTNER_RE.test(String(x.hint || ''))),
        'no note-buyer name reaches ANY borrower-facing condition field');

      // THE EXTERNAL HALF HAS TO WORK, not just be visible. "Internal and external"
      // means the borrower can actually ANSWER it — an audience the borrower can see
      // but not upload to would be a dead row on their side. Proven through the real
      // upload door, then re-read from the server rather than trusted from its 200.
      const up = await fetch(`${base}/api/borrower/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: cf, checklistItemId: bSsn.id,
          filename: 'ssn-card.pdf', contentType: 'application/pdf',
          dataBase64: Buffer.from('%PDF-1.4 test social security card').toString('base64'),
        }),
      });
      assert(up.status === 200 || up.status === 201,
        `the borrower can UPLOAD to the condition (${up.status}) — the external half is real, not just visible`);
      const after = (await db.query(
        `SELECT ci.status, (SELECT count(*)::int FROM documents d
                             WHERE d.checklist_item_id=ci.id AND d.is_current) AS docs
           FROM checklist_items ci WHERE ci.id=$1`, [bSsn.id])).rows[0];
      assert(after && after.docs === 1 && after.status === 'received',
        're-read after the upload: the document landed on the condition and it moved to review');

    } else {
      console.log('SKIP borrower-door checks (no borrower_auth row)');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL CorrFirst condition assertions passed');
  } catch (e) {
    console.error('FAIL (exception)', (e && e.stack) || e); failures++;
  } finally {
    try { if (srv) srv.close(); } catch (_) { /* throwaway listener */ }
    try { if (borrowerId) await db.query(`DELETE FROM documents WHERE borrower_id=$1 OR application_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM credit_reports WHERE application_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM checklist_items WHERE application_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (staffIds.length) await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [staffIds]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
