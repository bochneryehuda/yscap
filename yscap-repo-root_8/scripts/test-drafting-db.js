#!/usr/bin/env node
'use strict';
/* THE DRAFTING DESK (owner-directed 2026-08-18) — against a real database, with
 * the model stubbed so the PROMPT and the OUTPUT handling are what is proven:
 *
 *   A. conditionsForScope: borrower-facing items only, per scope — 'open'
 *      (outstanding/requested/issue), the pending-review add-on ('received'),
 *      'not_signed_off' (everything the back office has not signed off) — with
 *      staff-only items structurally invisible and partner names scrubbed.
 *   B. request validation.
 *   C. draft(): the grounding handed to the model carries the borrower items
 *      and NEVER a staff-only label or a capital-partner name; an empty scope
 *      refuses WITHOUT calling the model; the Subject/body split; the OUTPUT
 *      scrub (a partner name the model echoes never survives).
 *   D. NO SEND, structurally: the module imports no mailer and the route sends
 *      nothing — a source guard.
 *
 * DB-gated: needs DATABASE_URL; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-drafting-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');
const D = require('../src/lib/ai/drafting');
const azure = require('../src/lib/ai/azure-openai');

(async () => {
  const sfx = crypto.randomBytes(4).toString('hex');
  let borId, appId;
  const realAvailable = azure.available, realComplete = azure.complete;
  try {
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Draft','Reader',$1) RETURNING id`, [`draft-bo-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id,status,ys_loan_number,property_address,loan_type)
       VALUES ($1,'underwriting','YSCAP-DRAFT-1','{"oneLine":"3 Draft Drive"}','Purchase') RETURNING id`, [borId])).rows[0].id;
    const mk = (label, audience, status, extra = '') => db.query(
      `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,status${extra ? ',' + extra : ''})
       VALUES ('application',$1,$2,$3,$4,'document',true,$5${extra ? ',now()' : ''})`,
      [appId, label, audience === 'staff' ? null : label, audience, status]);
    await mk('Two months of bank statements', 'borrower', 'outstanding');
    await mk('Photo ID', 'both', 'issue');
    await mk('Operating agreement', 'borrower', 'received');
    await mk('BlueLake investor memo', 'borrower', 'outstanding');      // partner name in a borrower label — must scrub
    await mk('Internal fraud check', 'staff', 'outstanding');           // staff-only — never visible
    await mk('Appraisal ordered', 'borrower', 'satisfied');
    await db.query(`UPDATE checklist_items SET signed_off_at=now() WHERE application_id=$1 AND label='Appraisal ordered'`, [appId]);
    await mk('Waived thing', 'borrower', 'outstanding');
    await db.query(`UPDATE checklist_items SET waived_at=now() WHERE application_id=$1 AND label='Waived thing'`, [appId]);

    // ---- A. scopes -------------------------------------------------------------------------
    const open = await D.conditionsForScope(appId, 'open');
    ok('A1 open = outstanding + needs-a-fix, borrower-facing only',
      open.length === 3 && open.some((x) => x.label === 'Two months of bank statements')
      && open.some((x) => x.label === 'Photo ID' && x.status === 'issue')
      && !open.some((x) => /fraud/i.test(x.label)) && !open.some((x) => x.label === 'Operating agreement'));
    ok('A2 a partner name in a borrower label is scrubbed',
      open.some((x) => /Gold Standard/i.test(x.label)) && !open.some((x) => /blue\s*lake/i.test(x.label)));
    const openPlus = await D.conditionsForScope(appId, 'open', { includePendingReview: true });
    ok('A3 the pending-review add-on brings in received items',
      openPlus.length === 4 && openPlus.some((x) => x.label === 'Operating agreement' && x.status === 'received'));
    const nso = await D.conditionsForScope(appId, 'not_signed_off');
    ok('A4 not-signed-off includes in-review, excludes signed-off + waived',
      nso.length === 4 && nso.some((x) => x.label === 'Operating agreement')
      && !nso.some((x) => x.label === 'Appraisal ordered') && !nso.some((x) => x.label === 'Waived thing'));

    // ---- B. validation ---------------------------------------------------------------------
    ok('B1 an unknown preset refuses', /outstanding conditions|deal overview|custom/.test(D.requestProblem({ preset: 'poem' })));
    ok('B2 a bad scope refuses', /scope/i.test(D.requestProblem({ preset: 'outstanding_conditions', scope: 'everything' })));
    ok('B3 a bad layout refuses', /bullets or a numbered/i.test(D.requestProblem({ preset: 'outstanding_conditions', layout: 'prose' })));
    ok('B4 custom with no instruction refuses', /what the email should do/i.test(D.requestProblem({ preset: 'custom' })));

    // ---- C. draft() with the model stubbed -------------------------------------------------
    let sent = null;
    azure.available = () => true;
    azure.complete = async (args) => { sent = args; return { ok: true, text: 'Subject: What we still need\n\nHi — BlueLake asked us to collect:\n- your bank statements\nThanks!' }; };
    const out = await D.draft(appId, { preset: 'outstanding_conditions', scope: 'open', layout: 'numbered' });
    ok('C1 the draft answers subject + body, and the model\'s partner-name echo is scrubbed out',
      out.ok === true && out.subject === 'What we still need' && !/blue\s*lake/i.test(out.body) && /bank statements/.test(out.body));
    ok('C2 the grounding carries the borrower items and the layout',
      !!sent && /Two months of bank statements/.test(sent.userContent) && /NUMBERED list/.test(sent.userContent));
    ok('C3 the grounding NEVER carries a staff-only label or a partner name',
      !!sent && !/fraud/i.test(sent.userContent) && !/blue\s*lake/i.test(sent.userContent));
    ok('C4 the system prompt forbids invention and demands placeholders',
      /never invent a number/.test(sent.system) && /\[bracketed placeholder\]/.test(sent.system));

    // An empty scope refuses WITHOUT calling the model.
    sent = null;
    const emptyApp = (await db.query(
      `INSERT INTO applications (borrower_id,status,property_address,loan_type) VALUES ($1,'underwriting','{"oneLine":"9 Empty Ct"}','Purchase') RETURNING id`, [borId])).rows[0].id;
    const nothing = await D.draft(emptyApp, { preset: 'outstanding_conditions', scope: 'open' });
    ok('C5 an empty scope refuses in plain words, without a model call',
      nothing.ok === false && /Nothing is outstanding/.test(nothing.reason) && sent === null);
    await db.query(`DELETE FROM applications WHERE id=$1`, [emptyApp]);

    // The deal-overview preset grounds on the borrower-audience overview builder.
    await db.query(
      `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
       VALUES ($1,'standard','{}'::jsonb,$2,true)`,
      [appId, JSON.stringify({ noteRate: 10, sizing: { totalLoan: 360000, initialAdvance: 248000 } })]);
    sent = null;
    const ov = await D.draft(appId, { preset: 'deal_overview' });
    ok('C6 the deal overview grounds on the borrower-safe figures',
      ov.ok === true && !!sent && /Total loan: \$360,000/.test(sent.userContent) && /3 Draft Drive/.test(sent.userContent));

    // ---- D. no send, structurally ----------------------------------------------------------
    // BOTH halves of the drafting desk (drafting.js + the 2.0 detail layer it
    // requires) — a mailer slipped into either would defeat the no-send rule.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/lib/ai/drafting.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, '..', 'src/lib/ai/drafting-detail.js'), 'utf8');
    ok('D1 the drafting modules import no mailer OR notify module and never send',
      // The require test covers ANY notify alias (notifyStaff/notifyAdmins/a
      // future one) — a verb list alone was foolable (audit 2026-08-18 #6).
      !/require\(['"][^'"]*(email|notify)/.test(src) && !/sendMail|notifyBorrower|notifyApp|notifyStaff|notifyAdmins/.test(src));
    const staffSrc = fs.readFileSync(path.join(__dirname, '..', 'src/routes/staff.js'), 'utf8');
    const routeBlock = (staffSrc.match(/router\.post\('\/applications\/:id\/drafting'[\s\S]{0,600}/) || [''])[0];
    ok('D2 the route returns the draft and sends nothing', !!routeBlock && !/sendMail|notify/.test(routeBlock));

    // ---- E. the per-file AI spend cap (audit 2026-08-18 finding 1) -------------------------
    const meter = require('../src/lib/ai/cost-meter');
    const realAllow = meter.allowSpend;
    try {
      meter.allowSpend = async () => false;
      const capped = await D.draft(appId, { preset: 'deal_overview' });
      ok('E1 a file over its AI spending cap is refused with a plain reason',
        capped.ok === false && /spending cap/.test(capped.reason));
    } finally { meter.allowSpend = realAllow; }

    // ---- F. DRAFTING 2.0 (owner-directed 2026-08-18 evening) -------------------------------
    // F1/F2: DETAIL mode weaves the Condition Center's OWN figures into the
    // prompt — the liquidity breakdown off the assets condition's stamped
    // tool_payload (the same rows Max Cash to Close reads) and the
    // registered-vs-verified experience gap from track-record-todo.
    const assetsTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_p3_assets'`)).rows[0];
    ok('F0 the rtl_p3_assets template exists (the detail layer keys on it)', !!assetsTpl);
    await db.query(
      `INSERT INTO checklist_items (scope,application_id,template_id,label,borrower_label,audience,item_kind,is_required,status,tool_payload)
       VALUES ('application',$1,$2,'Assets & bank statements','Bank statements — proof of funds','borrower','document',true,'outstanding',$3)`,
      [appId, assetsTpl.id, JSON.stringify({ liquidity: {
        required: 100000, cashToClose: 61000, reserveRequirement: 30000,
        reserveBasis: '3 months of payments', closingBuffer: 4000, closingBufferWaived: false,
      } })]);
    await db.query(
      `UPDATE product_registrations SET inputs='{"expFlips":3,"expHolds":2,"expGround":0}'::jsonb
        WHERE application_id=$1 AND is_current`, [appId]);
    await db.query(
      `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,status,tool_key)
       VALUES ('application',$1,'Track record','Track record & experience','borrower','task',true,'outstanding','track_record')`, [appId]);
    // NOTHING ARRIVES VERIFIED (db/485): the trigger resets is_verified on
    // INSERT, so verify the line the way a reviewer does — a second UPDATE
    // touching no material column.
    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id,property_address,deal_type,sale_date)
       VALUES ($1,'{"oneLine":"12 Verified Way"}'::jsonb,'flip', (now() - interval '6 months')::date) RETURNING id`, [borId])).rows[0].id;
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`, [trId]);
    sent = null;
    const det = await D.draft(appId, { preset: 'outstanding_conditions', scope: 'open', detail: true });
    ok('F1 DETAIL mode carries the liquidity breakdown — total, cash to close, reserves, buffer',
      det.ok === true && !!sent
      && /\$100,000/.test(sent.userContent) && /\$61,000/.test(sent.userContent)
      && /\$30,000/.test(sent.userContent) && /\$4,000/.test(sent.userContent)
      && /two \(2\) most recent months/i.test(sent.userContent));
    ok('F1b …and the owner\'s "send a little extra" guidance rides in the task',
      !!sent && /LITTLE MORE than the minimum/i.test(sent.userContent));
    ok('F2 DETAIL mode states registered vs verified vs still-missing experience',
      !!sent && /3 fix-and-flips, 2 fix-and-holds/.test(sent.userContent)
      && /Verified on the track record so far: 1 fix-and-flip/.test(sent.userContent)
      && /Still missing: 2 more flips, 2 more holds/.test(sent.userContent));
    // F3: the owner chose OFF BY DEFAULT — without the toggle, no figures.
    sent = null;
    const plain = await D.draft(appId, { preset: 'outstanding_conditions', scope: 'open' });
    ok('F3 without the detail toggle the draft stays concise (no breakdown, no gap)',
      plain.ok === true && !!sent
      && !/\$61,000/.test(sent.userContent) && !/Still missing: 2 more flips/.test(sent.userContent));
    // F4: itemIds narrows the list to exactly the ticked conditions.
    const pickId = (await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND borrower_label='Photo ID'`, [appId])).rows[0].id;
    sent = null;
    const pickedOut = await D.draft(appId, { preset: 'outstanding_conditions', scope: 'open', itemIds: [pickId] });
    ok('F4 picking items narrows the draft to exactly those conditions',
      pickedOut.ok === true && !!sent && /Photo ID/.test(sent.userContent)
      && !/Bank statements — proof of funds/.test(sent.userContent));
    ok('F4b a junk item id is refused in plain words',
      /not a real condition/.test(D.requestProblem({ preset: 'outstanding_conditions', itemIds: ['nope'] })));
    // F5: tone + length riders; junk refused.
    sent = null;
    await D.draft(appId, { preset: 'outstanding_conditions', scope: 'open', tone: 'firm', length: 'short' });
    ok('F5 tone + length ride in the task', !!sent && /courteous but firm/.test(sent.userContent) && /Keep it SHORT/.test(sent.userContent));
    ok('F5b a junk tone refuses', /tone/i.test(D.requestProblem({ preset: 'deal_overview', tone: 'sassy' })));
    ok('F5c a junk length refuses', /length/i.test(D.requestProblem({ preset: 'deal_overview', length: 'epic' })));
    // F6: sign-as rides as a fact, scrubbed.
    sent = null;
    await D.draft(appId, { preset: 'deal_overview', signAs: 'Chaim at BlueLake Desk' });
    ok('F6 the sign-off name rides as a fact, partner-scrubbed',
      !!sent && /Sign the email as: Chaim at/.test(sent.userContent) && !/blue\s*lake/i.test(sent.userContent));
    // F7: revise — same grounding + the previous draft, scrubbed on the way IN.
    sent = null;
    const rev = await D.draft(appId, {
      preset: 'outstanding_conditions', scope: 'open',
      feedback: 'Make it shorter and lead with the bank statements.',
      previousSubject: 'What we need', previousBody: 'Hi — BlueLake needs your bank statements.',
    });
    ok('F7 revise carries the feedback + the previous draft on the SAME file grounding',
      rev.ok === true && !!sent && /Revise the email draft below/.test(sent.userContent)
      && /THE CURRENT DRAFT/.test(sent.userContent) && /Items still needed:/.test(sent.userContent));
    ok('F7b the pasted-back draft is scrubbed on the way IN', !!sent && !/blue\s*lake/i.test(sent.userContent));
    ok('F7c feedback with no previous draft refuses',
      /no previous draft/.test(D.requestProblem({ preset: 'deal_overview', feedback: 'shorter' })));
    // F8/F9: the SOW budget block states the REAL saved totals (audit finding 1:
    // the first cut passed no payload, so checkSowBudget read a $0.00 line-item
    // total and fabricated a full-budget gap on every file — matched SOWs
    // included). A mismatched saved SOW states both true figures; a MATCHED one
    // produces no block at all.
    await db.query(`UPDATE applications SET rehab_budget=126000 WHERE id=$1`, [appId]);
    await db.query(
      `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,status,tool_key,tool_payload)
       VALUES ('application',$1,'Rehab budget','Scope of Work','borrower','task',true,'issue','rehab_budget',$2)`,
      [appId, JSON.stringify({ state: { target: 126000 }, total: 100000 })]);
    sent = null;
    await D.draft(appId, { preset: 'outstanding_conditions', scope: 'open', detail: true });
    ok('F8 the SOW block states the REAL saved totals, never a fabricated $0',
      !!sent && /\$126,000/.test(sent.userContent) && /\$100,000/.test(sent.userContent)
      && !/\$0\.00/.test(sent.userContent));
    await db.query(
      `UPDATE checklist_items SET tool_payload=$2 WHERE application_id=$1 AND tool_key='rehab_budget'`,
      [appId, JSON.stringify({ state: { target: 126000 }, total: 126000 })]);
    sent = null;
    await D.draft(appId, { preset: 'outstanding_conditions', scope: 'open', detail: true });
    ok('F9 a MATCHED Scope of Work produces no budget block at all',
      !!sent && !/What needs to happen/.test(sent.userContent) && !/line-item total/.test(sent.userContent));
  } finally {
    azure.available = realAvailable; azure.complete = realComplete;
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
    } catch (_) { /* best-effort */ }
  }

  console.log(`test-drafting-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
