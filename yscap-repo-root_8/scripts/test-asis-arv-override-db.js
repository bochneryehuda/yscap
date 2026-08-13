'use strict';
/**
 * AS-IS / ARV super-admin OVERRIDE of the term-sheet-sent freeze — end to end against a
 * real Postgres (owner-directed 2026-08, "Save ARV, keep the loan").
 *
 * On a term-sheet-frozen file a super_admin may RECORD the new as-is value + ARV whether or
 * not re-pricing at them would move the loan — keeping the loan amount, the registration and
 * the sent term sheet EXACTLY as they are. The load-bearing proof is that the db/486 trigger
 * — which reopens Products & Pricing + the signed-term-sheet condition + marks the
 * registration stale on ANY as_is/arv write — is UNDONE by the override's re-assert, so BOTH
 * a neutral change AND a non-neutral change leave those conditions signed off and the loan
 * frozen. A CONTROL file shows the trigger genuinely reopens them on a plain write, so the
 * re-assert is doing real work.
 *
 * DB-gated: skips when DATABASE_URL is unset.
 */
if (!process.env.DATABASE_URL) { console.log('test-asis-arv-override-db: SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const pricing = require('../src/lib/pricing');
const fileLock = require('../src/lib/file-lock');
const asisArv = require('../src/lib/asis-arv-override');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `aao-${process.pid}-${Date.now()}`;

// Build a registered + term-sheet-frozen file. Purchase, as-is ABOVE the price so the
// cost basis is min(price, as-is)=price: raising as-is stays neutral, lowering it below the
// price shrinks the loan (non-neutral). Returns { appId, staffId, inputs, quote }.
async function mkRegisteredFrozen({ asIs = 200000, arv = 500000 } = {}) {
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ada Admin','super_admin',true) RETURNING id`,
    [`${uniq}-${Math.random().toString(36).slice(2, 8)}@x.test`])).rows[0].id;
  const bId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Bo','Rrower',$1,720) RETURNING id`,
    [`${uniq}-${Math.random().toString(36).slice(2, 8)}@x.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status, loan_type, program, term,
                               purchase_price, as_is_value, arv, rehab_budget, units, property_type,
                               requested_exp_flips)
     VALUES ($1,$2,$3,'underwriting','Purchase','Standard','12 Months',100000,$4,$5,50000,1,'sfr',5)
     RETURNING id`,
    [bId, `YSA${String(Math.random()).slice(-9)}`,
     JSON.stringify({ line1: '1 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' }), asIs, arv])).rows[0].id;

  // Price it EXACTLY as the register route does, and store the registration. FICO lives on
  // the borrower (loadFileForPricing joins it onto the app object it prices from), so seed
  // it onto the app object the same way before buildInputs reads app.fico.
  const app = (await db.query(`SELECT * FROM applications WHERE id=$1`, [appId])).rows[0];
  app.fico = 720;
  const inputs = pricing.buildInputs(app, { flips: 5, holds: 0, ground: 0 }, {});
  const quote = pricing.quoteProgram('standard', inputs);
  await db.query(
    `INSERT INTO product_registrations (application_id, is_current, program, product_label, quote, inputs,
                                        total_loan, note_rate, registered_by, stale)
     VALUES ($1,true,'standard','Standard Program',$2,$3,$4,$5,$6,false)`,
    [appId, JSON.stringify(quote), JSON.stringify(inputs),
     quote.sizing ? Math.round(quote.sizing.totalLoan || 0) : 0, quote.noteRate || 0, staffId]);

  // Term-sheet-FROZEN: a SENT term_sheet_package envelope.
  await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required, product_version, envelope_id)
     VALUES ($1,'term_sheet_package','sent',true,0,$2)`, [appId, `${uniq}-ENV-${Math.random().toString(36).slice(2, 8)}`]);

  // Signed-off Products & Pricing + signed-term-sheet conditions (the trigger reopens these).
  const ppTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_p1_product'`)).rows[0];
  await db.query(
    `INSERT INTO checklist_items (application_id, template_id, scope, label, tool_key, item_kind, status, signed_off_at, signed_off_by)
     VALUES ($1,$2,'application','Products & pricing','product_pricing','condition','satisfied',now(),$3)`,
    [appId, ppTpl ? ppTpl.id : null, staffId]);
  const stsTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_signedts'`)).rows[0];
  await db.query(
    `INSERT INTO checklist_items (application_id, template_id, scope, label, item_kind, status, signed_off_at, signed_off_by)
     VALUES ($1,$2,'application','Signed term sheet','document','satisfied',now(),$3)`,
    [appId, stsTpl ? stsTpl.id : null, staffId]);

  return { appId, staffId, inputs, quote };
}

const ppState = async (appId) => (await db.query(
  `SELECT status, signed_off_at FROM checklist_items WHERE application_id=$1 AND tool_key='product_pricing' LIMIT 1`, [appId])).rows[0];
const stsState = async (appId) => (await db.query(
  `SELECT ci.status, ci.signed_off_at FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code='rtl_cond_signedts' LIMIT 1`, [appId])).rows[0];
const regStale = async (appId) => (await db.query(
  `SELECT stale FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
const regTotal = async (appId) => (await db.query(
  `SELECT total_loan FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0].total_loan;
const appAsIsArv = async (appId) => (await db.query(`SELECT as_is_value, arv FROM applications WHERE id=$1`, [appId])).rows[0];

(async () => {
  const superA = { kind: 'staff', role: 'super_admin' };
  const adminA = { kind: 'staff', role: 'admin' };

  // Confirm the engine is available (else the whole feature is moot).
  {
    const t = await mkRegisteredFrozen();
    assert(t.quote && t.quote.sizing && t.quote.sizing.totalLoan > 0, 'a real Standard quote was produced + registered');

    // Prove the intended change is NEUTRAL and the other is NON-NEUTRAL, by finalNumbersKey.
    const key0 = fileLock.finalNumbersKey(t.quote, t.inputs.term);
    const neutralQuote = pricing.quoteProgram('standard', { ...t.inputs, asIsValue: 250000, arv: 600000 });
    const nonNeutralQuote = pricing.quoteProgram('standard', { ...t.inputs, asIsValue: 80000, arv: 600000 });
    assert(fileLock.finalNumbersKey(neutralQuote, t.inputs.term) === key0,
      'raising as-is ABOVE the price (250k) + a higher ARV is terms-neutral (loan unchanged)');
    assert(fileLock.finalNumbersKey(nonNeutralQuote, t.inputs.term) !== key0,
      'lowering as-is BELOW the price (80k) shrinks the cost basis → the loan moves (non-neutral)');
  }

  /* ── CONTROL: a PLAIN as-is write reopens the conditions (proves the trigger fires) ── */
  {
    const c = await mkRegisteredFrozen();
    assert((await ppState(c.appId)).status === 'satisfied', 'control: P&P starts satisfied');
    await db.query(`UPDATE applications SET as_is_value=250000, arv=600000 WHERE id=$1`, [c.appId]);
    const pp = await ppState(c.appId);
    assert(pp.status === 'received' && pp.signed_off_at === null,
      'control: a PLAIN as-is/arv write REOPENS Products & Pricing (db/486 trigger fires) — the re-assert has real work to do');
    assert((await regStale(c.appId)).stale === true, 'control: the plain write marks the registration stale');
  }

  /* ── TRIPWIRE: apply()'s capture set stays in lock-step with what the db/486 trigger
     reopens on an as-is/ARV-only write. apply() hardcodes { product_pricing,
     rtl_cond_signedts } as the rows to restore. If a future migration widens the trigger
     to reopen ANOTHER condition on an as-is/arv change (e.g. drops the loan_amount gate on
     the Heter Iska, or adds a new one), a neutral override would then SILENTLY leave that
     condition reopened — the re-assert would not know to restore it. This asserts the two
     never drift: the ONLY conditions the trigger reopens here are the ones apply() captures.
     If it fires, extend apply()'s capture query in src/lib/asis-arv-override.js to match. ── */
  {
    const t = await mkRegisteredFrozen();
    // Add two MORE cleared conditions the trigger must NOT reopen on an as-is/arv-only
    // change: the Heter Iska (loan_amount-gated, db/280/486 line 247 — THE condition the
    // audit flagged, since Theme B's Iska work sits next to this branch) and a generic
    // unrelated condition (proves the trigger is selective). The Scope of Work is
    // deliberately NOT added here — it is gated on a wholly separate `scope_changed`
    // branch and the db/069 budget guard refuses a satisfied SOW without a real total.
    const iskaTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_iska'`)).rows[0];
    await db.query(
      `INSERT INTO checklist_items (application_id, template_id, scope, label, item_kind, status, signed_off_at, signed_off_by)
       VALUES ($1,$2,'application','Heter Iska','document','satisfied',now(),$3)`,
      [t.appId, iskaTpl ? iskaTpl.id : null, t.staffId]);
    await db.query(
      `INSERT INTO checklist_items (application_id, scope, label, tool_key, item_kind, status, signed_off_at, signed_off_by)
       VALUES ($1,'application','Some other condition','info_field','condition','satisfied',now(),$2)`,
      [t.appId, t.staffId]);

    // Snapshot every cleared condition, do a PLAIN as-is/arv write (bypassing apply()'s
    // re-assert), then read which of them the trigger reopened.
    const before = (await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND status='satisfied' AND signed_off_at IS NOT NULL`,
      [t.appId])).rows.map((r) => r.id);
    await db.query(`UPDATE applications SET as_is_value=250000, arv=600000 WHERE id=$1`, [t.appId]);
    const reopened = (await db.query(
      `SELECT ci.tool_key, (SELECT code FROM checklist_templates ct WHERE ct.id=ci.template_id) AS code
         FROM checklist_items ci
        WHERE application_id=$1 AND id = ANY($2::uuid[])
          AND NOT (status='satisfied' AND signed_off_at IS NOT NULL)`,
      [t.appId, before])).rows;

    // apply()'s capture predicate — the rows it restores after the write (kept in sync
    // with the SELECT in src/lib/asis-arv-override.js apply()).
    const captured = (r) => r.tool_key === 'product_pricing' || r.code === 'rtl_cond_signedts';
    const stray = reopened.filter((r) => !captured(r)).map((r) => r.tool_key || r.code || '?');
    assert(stray.length === 0,
      `TRIPWIRE: on an as-is/arv-only write the db/486 trigger reopens ONLY apply()'s capture set — ` +
      `a stray reopen means the trigger widened and apply() in asis-arv-override.js must capture+restore it too ` +
      `(strays: ${stray.join(', ') || 'none'})`);
    assert(reopened.some((r) => r.tool_key === 'product_pricing') && reopened.some((r) => r.code === 'rtl_cond_signedts'),
      'TRIPWIRE: both captured conditions (product_pricing + signed-term-sheet) DID reopen — the trigger fired');
    assert(reopened.length === 2,
      `TRIPWIRE: exactly TWO conditions reopened — the Heter Iska and generic condition stayed signed off (got ${reopened.length})`);
  }

  /* ── the OVERRIDE: super_admin + neutral → APPLIES and keeps the term sheet valid ── */
  {
    const t = await mkRegisteredFrozen();
    const body = { asIsValue: 250000, arv: 600000, adminOverride: true, overrideReason: 'Appraisal came in; only as-is/ARV move.' };
    const decision = await asisArv.evaluate({ appId: t.appId, body, actor: superA });
    assert(decision.status === 'apply', `neutral super_admin override → evaluate says apply (got ${decision.status}: ${decision.message || ''})`);
    if (decision.status === 'apply') {
      await asisArv.apply({ appId: t.appId, changes: decision.changes });
      const v = await appAsIsArv(t.appId);
      assert(Number(v.as_is_value) === 250000 && Number(v.arv) === 600000, 'the override wrote the new as-is + ARV');
      const pp = await ppState(t.appId);
      assert(pp.status === 'satisfied' && pp.signed_off_at !== null,
        'AFTER the override, Products & Pricing is STILL satisfied + signed off (the re-assert undid the trigger)');
      const sts = await stsState(t.appId);
      assert(sts.status === 'satisfied' && sts.signed_off_at !== null,
        'AFTER the override, the signed-term-sheet condition is STILL satisfied + signed off');
      assert((await regStale(t.appId)).stale === false, 'AFTER the override, the registration is NOT stale (the sent term sheet still matches)');
    }
  }

  /* ── "SAVE ARV, KEEP THE LOAN": a NON-neutral override APPLIES and keeps the loan frozen
     (owner-directed 2026-08). Lowering as-is below the price WOULD shrink the loan on a
     re-register — but the override records it while re-asserting the pricing conditions and
     the registration, so loan_amount, the sent term sheet and its conditions never move. ── */
  {
    const t = await mkRegisteredFrozen();
    const regBefore = await regTotal(t.appId);
    const body = { asIsValue: 80000, arv: 600000, adminOverride: true, overrideReason: 'Appraised low; record the value, keep the loan.' };
    const decision = await asisArv.evaluate({ appId: t.appId, body, actor: superA });
    assert(decision.status === 'apply', `a NON-neutral super_admin override → evaluate says apply (got ${decision.status}: ${decision.message || ''})`);
    assert(decision.neutral === false, 'the override records the (advisory) verdict: this change was NOT terms-neutral');
    if (decision.status === 'apply') {
      await asisArv.apply({ appId: t.appId, changes: decision.changes });
      const v = await appAsIsArv(t.appId);
      assert(Number(v.as_is_value) === 80000 && Number(v.arv) === 600000, 'the NON-neutral override wrote the new as-is + ARV');
      const pp = await ppState(t.appId);
      assert(pp.status === 'satisfied' && pp.signed_off_at !== null,
        'even on a NON-neutral change, Products & Pricing is STILL satisfied + signed off (the loan is kept, not re-sized)');
      const sts = await stsState(t.appId);
      assert(sts.status === 'satisfied' && sts.signed_off_at !== null,
        'even on a NON-neutral change, the signed-term-sheet condition is STILL satisfied + signed off');
      assert((await regStale(t.appId)).stale === false, 'the registration is NOT stale — the sent term sheet is kept exactly as it is');
      assert(Number(regBefore) === Number(await regTotal(t.appId)), 'the registered loan amount did NOT move (the loan is kept)');
    }
  }

  /* ── refusals ── */
  {
    const t = await mkRegisteredFrozen();
    // a plain admin (not super_admin)
    const r2 = await asisArv.evaluate({ appId: t.appId, body: { asIsValue: 250000, adminOverride: true, overrideReason: 'x' }, actor: adminA });
    assert(r2.status === 'refused' && r2.code === 403, 'a plain admin is refused (403 — super_admin only)');

    // no reason
    const r3 = await asisArv.evaluate({ appId: t.appId, body: { asIsValue: 250000, adminOverride: true }, actor: superA });
    assert(r3.status === 'refused' && r3.code === 400 && /reason/i.test(r3.message), 'no reason → refused (400)');

    // a non-as-is/arv field rides along
    const r4 = await asisArv.evaluate({ appId: t.appId, body: { asIsValue: 250000, purchasePrice: 1, adminOverride: true, overrideReason: 'x' }, actor: superA });
    assert(r4.status === 'refused' && r4.code === 400 && /only the as-is value and the arv/i.test(r4.message),
      'any other field → refused (400 — override is as-is/ARV only)');
  }

  /* ── a STATUS freeze is never lifted by this override ── */
  {
    const t = await mkRegisteredFrozen();
    await db.query(`UPDATE applications SET status='clear_to_close' WHERE id=$1`, [t.appId]);
    const r = await asisArv.evaluate({ appId: t.appId, body: { asIsValue: 250000, adminOverride: true, overrideReason: 'x' }, actor: superA });
    assert(r.status === 'refused' && r.code === 409 && /locked/i.test(r.message),
      'a clear-to-close (status-frozen) file refuses the override — a super-admin UNLOCK is the path there');
  }

  /* ── a file that is NOT term-sheet-frozen → not_needed (ordinary save) ── */
  {
    const t = await mkRegisteredFrozen();
    await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [t.appId]);   // un-send → not frozen
    const r = await asisArv.evaluate({ appId: t.appId, body: { asIsValue: 250000, adminOverride: true, overrideReason: 'x' }, actor: superA });
    assert(r.status === 'not_needed', 'a file that is not term-sheet-frozen → not_needed (the ordinary save works)');
  }

  if (failures) { console.error(`\ntest-asis-arv-override-db: ${failures} FAILURE(S).`); process.exit(1); }
  console.log('\nAll as-is/ARV override DB checks passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
