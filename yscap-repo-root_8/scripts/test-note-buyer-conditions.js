/**
 * Note-buyer-driven conditions (owner-directed 2026-07-20):
 *   (1) The note buyer (applications.lender) is a normalized rule field
 *       (normNoteBuyer) exposed to the Condition Center engine.
 *   (2) A borrower EXTERNAL "verify EMD deposit" condition (cond_emd_corrfirst)
 *       attaches ONLY when the note buyer is CorrFirst, and retracts (untouched)
 *       when the note buyer changes away. Its borrower wording never names the
 *       note buyer.
 *   (3) The 5% SOW-contingency requirement now also applies to a BLUE LAKE note
 *       buyer — sowContingencyRequired, the DB budget guard, and
 *       enforceSowContingency all honor it.
 *   (4) The internal flood-certificate condition (rtl_cond_flood) is required for
 *       a BLUE LAKE or CorrFirst note buyer (db/281) — staff-only, attached by the
 *       engine; a Fidelis / other note buyer does not get it from that rule.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-note-buyer-conditions (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const reg = require('../src/lib/conditions/field-registry');
const engine = require('../src/lib/conditions/engine');
const RB = require('../src/lib/rehab-budget');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const emdCount = async (appId) => (await db.query(
  `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code='cond_emd_corrfirst'`, [appId])).rows[0].n;

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  try {
    // (1) Normalization.
    assert(reg.normNoteBuyer('CorrFirst') === 'corrfirst', 'normNoteBuyer("CorrFirst")=corrfirst');
    assert(reg.normNoteBuyer('Corr First') === 'corrfirst', 'normNoteBuyer("Corr First")=corrfirst (spacing-insensitive)');
    assert(reg.normNoteBuyer('Blue Lake') === 'bluelake', 'normNoteBuyer("Blue Lake")=bluelake');
    assert(reg.normNoteBuyer('') === null, 'normNoteBuyer("")=null');
    assert(!!reg.BY_KEY.note_buyer, 'note_buyer is a registered rule field');

    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('NB','Test',$1) RETURNING id`,
      [`nb-${sfx}@test.local`])).rows[0].id;

    // (2) EMD condition attaches for CorrFirst only.
    const cf = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','CorrFirst') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(cf, { reason: 'test', notify: false });
    const emd = (await db.query(
      `SELECT ci.audience, ci.item_kind, ci.borrower_label, ci.origin_kind FROM checklist_items ci
         JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='cond_emd_corrfirst'`, [cf])).rows[0];
    assert(!!emd, 'CorrFirst file gets the EMD condition');
    assert(emd && emd.audience === 'borrower', 'EMD condition is a BORROWER (external) condition');
    assert(emd && emd.item_kind === 'document', 'EMD condition is a document upload');
    assert(emd && emd.origin_kind === 'auto', 'EMD condition is engine-owned (auto) so it can retract');
    assert(emd && /earnest money deposit/i.test(emd.borrower_label || '') && !/corr/i.test(emd.borrower_label || ''),
      'EMD borrower wording names the EMD but NOT the note buyer');

    const other = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','Fidelis') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(other, { reason: 'test', notify: false });
    assert((await emdCount(other)) === 0, 'a non-CorrFirst note buyer does NOT get the EMD condition');

    const none = (await db.query(
      `INSERT INTO applications (borrower_id,status) VALUES ($1,'processing') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(none, { reason: 'test', notify: false });
    assert((await emdCount(none)) === 0, 'a file with no note buyer does NOT get the EMD condition');

    // Retraction when the note buyer changes away (untouched item).
    await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [cf]);
    await engine.evaluateApplication(cf, { reason: 'test', notify: false });
    assert((await emdCount(cf)) === 0, 'EMD retracts when the note buyer changes away from CorrFirst');

    // (3) Contingency requirement by note buyer.
    const bl = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender,rehab_budget) VALUES ($1,'processing','Blue Lake',100000) RETURNING id`, [borrowerId])).rows[0].id;
    let req = await RB.sowContingencyRequired(bl);
    assert(req.required === true && req.reason === 'bluelake', 'Blue Lake note buyer REQUIRES the 5% contingency');
    req = await RB.sowContingencyRequired(other);
    assert(req.required === false, 'a Fidelis note buyer does NOT require the 5% contingency');

    // DB belt-and-suspenders guard: a Blue Lake budget condition cannot be
    // satisfied without a >= 5% contingency, and can once it has one.
    await db.query(
      `INSERT INTO product_registrations (application_id,program,inputs,quote,is_current)
       VALUES ($1,'Standard','{"rehabBudget":100000}'::jsonb,'{}'::jsonb,true)`, [bl]);
    const tpl = (await db.query(`SELECT id,label FROM checklist_templates WHERE tool_key='rehab_budget' LIMIT 1`)).rows[0];
    const noCont = JSON.stringify({ total: 100000, subtotal: 100000, contingency: 0, state: { target: 100000 } });
    const it = (await db.query(
      `INSERT INTO checklist_items (template_id,scope,application_id,label,status,item_kind,tool_key,tool_payload,is_required)
       VALUES ($1,'application',$2,$3,'received','task','rehab_budget',$4::jsonb,true) RETURNING id`,
      [tpl.id, bl, tpl.label, noCont])).rows[0].id;
    let blocked = false;
    try { await db.query(`UPDATE checklist_items SET status='satisfied' WHERE id=$1`, [it]); }
    catch (_) { blocked = true; }
    assert(blocked, 'DB guard BLOCKS satisfying a Blue Lake budget condition with no 5% contingency');
    const withCont = JSON.stringify({ total: 100000, subtotal: 95000, contingency: 5000, state: { target: 100000 } });
    await db.query(`UPDATE checklist_items SET tool_payload=$2::jsonb WHERE id=$1`, [it, withCont]);
    let allowed = false;
    try { await db.query(`UPDATE checklist_items SET status='satisfied' WHERE id=$1`, [it]); allowed = true; } catch (_) {}
    assert(allowed, 'DB guard ALLOWS satisfying once a >= 5% contingency is present');

    // enforceSowContingency reopens a signed-off Blue Lake condition that lacks
    // the 5%, and clears its [auto] reopen when the note buyer changes away.
    const bl2 = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','Blue Lake') RETURNING id`, [borrowerId])).rows[0].id;
    await db.query(
      `INSERT INTO checklist_items (template_id,scope,application_id,label,status,item_kind,tool_key,tool_payload,is_required,signed_off_at)
       VALUES ($1,'application',$2,$3,'received','task','rehab_budget',$4::jsonb,true, now())`,
      [tpl.id, bl2, tpl.label, JSON.stringify({ subtotal: 100000, contingency: 0 })]);
    await RB.enforceSowContingency(bl2);
    let row = (await db.query(`SELECT status, signed_off_at, notes FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' LIMIT 1`, [bl2])).rows[0];
    assert(row.status === 'issue' && row.signed_off_at == null && /contingency/i.test(row.notes || ''),
      'enforceSowContingency reopens a Blue Lake budget condition lacking the 5%');
    await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [bl2]);
    const r2 = await RB.enforceSowContingency(bl2);
    row = (await db.query(`SELECT status, notes FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' LIMIT 1`, [bl2])).rows[0];
    assert(r2.cleared === true && row.status === 'received' && row.notes == null,
      'changing the note buyer away clears the stale contingency reopen');

    // (4) Flood certificate INTERNAL condition (rtl_cond_flood, db/281): required
    //     for a Blue Lake OR CorrFirst note buyer, and staff-only. Not for others.
    const floodCount = async (appId) => (await db.query(
      `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_cond_flood'`, [appId])).rows[0].n;

    const flBlue = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','Blue Lake') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(flBlue, { reason: 'test', notify: false });
    assert((await floodCount(flBlue)) === 1, 'a Blue Lake file gets the internal flood-certificate condition');
    const flRow = (await db.query(
      `SELECT ci.audience FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_cond_flood'`, [flBlue])).rows[0];
    assert(flRow && flRow.audience === 'staff', 'the flood-certificate condition is INTERNAL (staff-only, never shown to the borrower)');

    const flCorr = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'underwriting','Corr First') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(flCorr, { reason: 'test', notify: false });
    assert((await floodCount(flCorr)) === 1, 'a CorrFirst file (spacing-insensitive) gets the internal flood-certificate condition');

    const flFid = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','Fidelis') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(flFid, { reason: 'test', notify: false });
    // Owner-directed 2026-07-30 (db/374): the flood cert is on EVERY file, Fidelis included.
    assert((await floodCount(flFid)) === 1, 'a Fidelis file ALSO gets the flood-certificate condition (every file, db/374)');

    /* THE EXACT-MATCH GUARD (owner-reported 2026-07-30).
       `normNoteBuyer` is deliberately EXACT — loosening it would let a look-alike
       name export the wrong note buyer's data tape — so the real ClickUp label
       "EMCAP Financial" normalizes to `emcapfinancial`, NOT `emcap`. Any branch
       that compares a normalized note buyer to the bare string 'emcap' therefore
       matches NO live file and is silently dead. That is exactly how the
       fix-and-hold estimated-rent requirement (staff.js applicationCompleteness)
       never fired once. `isEmcapNoteBuyer` (the prefix test) is the only correct
       way to ask, and every consumer now uses it. */
    assert(reg.isEmcapNoteBuyer('EMCAP Financial') && reg.isEmcapNoteBuyer('EMCAP')
      && reg.isEmcapNoteBuyer('emcap financial llc'),
      'isEmcapNoteBuyer matches every real EMCAP spelling, including the live "EMCAP Financial" label');
    assert(!reg.isEmcapNoteBuyer('Blue Lake') && !reg.isEmcapNoteBuyer('Fidelis Investors LLC')
      && !reg.isEmcapNoteBuyer('') && !reg.isEmcapNoteBuyer(null),
      'isEmcapNoteBuyer matches nothing else, and a blank note buyer is not EMCAP');
    assert(reg.normNoteBuyer('EMCAP Financial') !== 'emcap',
      'the live label does NOT normalize to the bare "emcap" — which is why an exact compare is always a dead branch');
    {
      /* Flag the exact bug SHAPE: a value taken straight from `normNoteBuyer`
         compared to the bare 'emcap'. Deliberately NOT "any 'emcap' string" —
         that flags rule metadata (`audience:'emcap'`), comments, and the
         legitimate canonical-key compare in investor-guideline-review.js, whose
         `normKey` FOLDS every EMCAP spelling onto 'emcap' via isEmcapNoteBuyer
         before comparing. A folding canonicalizer is correct; reading
         normNoteBuyer's raw output and testing it for 'emcap' is the dead branch. */
      const fs = require('fs'), path = require('path');
      const hits = [];
      const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); continue; }
          if (!/\.js$/.test(e.name)) continue;
          const txt = strip(fs.readFileSync(f, 'utf8'));
          // (a) inline:  normNoteBuyer(x) === 'emcap'
          if (/normNoteBuyer\([^)]*\)\s*(===|==|!==|!=)\s*['"]emcap['"]/.test(txt)) { hits.push(f + ' (inline)'); continue; }
          // (b) via a variable assigned DIRECTLY from normNoteBuyer
          const vars = [...txt.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*normNoteBuyer\(/g)].map((m) => m[1]);
          for (const v of new Set(vars)) {
            const re = new RegExp('\\b' + v + '\\s*(===|==|!==|!=)\\s*[\'"]emcap[\'"]');
            if (re.test(txt)) { hits.push(f + ' (' + v + ')'); break; }
          }
        }
      };
      walk(path.join(__dirname, '..', 'src'));
      assert(hits.length === 0,
        `no source file compares a note buyer to the bare 'emcap' — use isEmcapNoteBuyer (found: ${hits.join(', ') || 'none'})`);
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL note-buyer-conditions assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
