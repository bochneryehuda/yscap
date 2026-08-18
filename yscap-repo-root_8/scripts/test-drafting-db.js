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
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/lib/ai/drafting.js'), 'utf8');
    ok('D1 the drafting module imports no mailer OR notify module and never sends',
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
