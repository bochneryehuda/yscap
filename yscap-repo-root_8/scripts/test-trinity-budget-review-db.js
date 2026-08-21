'use strict';
/**
 * THE TRINITY BUDGET REVIEW (form 159) — the pre-closing feasibility read, and the gate in front
 * of it. Owner-directed 2026-08-21.
 *
 * *"Right before you order, it should be gated that you need to have: the scope of work completed /
 * the contractor information completed / … it linked with our contractor information that we have /
 * the full budget so they can review it properly. You also need to have the appraisal back before
 * you're ordering this, and the appraisal PDF document should be sent along together with the
 * order."*
 *
 * WHY EVERY ONE OF THESE IS A REFUSAL RATHER THAN A WARNING. Trinity reads what we send them, and
 * we pay for the read. An order placed off a half-finished file buys a confident answer about the
 * wrong project — so a gate that merely warned would be worse than none. Each check therefore also
 * FAILS CLOSED: anything PILOT cannot read blocks, and this suite proves that with a database that
 * refuses to answer.
 *
 * DB-gated: skips cleanly with no DATABASE_URL. Nothing is ever sent to Trinity — no credentials
 * exist here and the order path is not called.
 * Run: DATABASE_URL=… node scripts/test-trinity-budget-review-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-trinity-budget-review-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const db = require('../src/db');
const BR = require('../src/trinity/budget-review');
const mapper = require('../src/trinity/mapper');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };
const TAG = 'tbr' + crypto.randomBytes(4).toString('hex');
const blocked = (g, re) => (g.blockers || []).some((b) => re.test(b));

/* A REAL Scope-of-Work payload, in the shape the tool actually saves — `state.items` keyed by line
   with `on` + `each`, which is what `sitewire/mapper.explodeSow` reads. Writing a plausible-looking
   `{lines:[…]}` instead produced an EMPTY explosion and a gate that refused for a reason that had
   nothing to do with the file, which is precisely the sort of fixture that proves nothing. */
const SOW_PAYLOAD = {
  total: 250000,
  state: {
    target: 250000, units: 1,
    items: {
      foundation: { on: true, each: 150000 },
      framing: { on: true, each: 100000 },
    },
  },
};

(async () => {
  const mk = async ({ program = 'Ground-up Construction', rehab = 'Ground-up' } = {}) => {
    // A PHONE, because Trinity requires one so the inspector can reach the borrower — the gate
    // now reports that too (it builds the payload in the dry), so a borrower without one is
    // correctly not orderable and this fixture would otherwise be testing the wrong thing.
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email,cell_phone) VALUES('Bud','Review',$1,'512-555-0111') RETURNING id`,
      [`b.${TAG}.${crypto.randomBytes(3).toString('hex')}@example.com`])).rows[0].id;
    return (await db.query(
      `INSERT INTO applications(borrower_id,status,ys_loan_number,program,rehab_type,loan_type,
                                property_address,loan_amount,rehab_budget)
       VALUES($1,'underwriting',$2,$3,$4,'Purchase',
              '{"oneLine":"9 Plan St","street":"9 Plan St","city":"Austin","state":"TX","zip":"78701"}',
              400000,250000) RETURNING id`,
      [bor, 'TBR' + crypto.randomBytes(4).toString('hex'), program, rehab])).rows[0].id;
  };

  // ======================================================================
  // A. WHO MAY ORDER ONE — the owner's "only for ground-ups and heavy rehabs"
  // ======================================================================
  {
    const s = (strategy, heavy) => BR.suitabilityFor({ strategy, heavyRehab: heavy });
    ok('A1 a ground-up may order one, and it is the expected product there',
      s('Ground-up Construction', true).allowed && s('Ground-up Construction', true).expected);
    ok('A2 a heavy rehab may order one — but CASE BY CASE, which is said rather than flattened',
      s('Fix & Flip', true).allowed && s('Fix & Flip', true).expected === false);
    ok('A3 an ordinary flip may NOT — there is no construction plan to read',
      !s('Fix & Flip', false).allowed);
    ok('A4 …nor a bridge', !s('Bridge / Stabilized', false).allowed);
    ok('A5 a refusal says WHY, so the desk is never left guessing', /only for a ground-up/.test(s('Fix & Flip', false).note));

    // It must judge the SAME way the feasibility FEE does, off the frozen engine's own classifier —
    // the file we CHARGE the ground-up fee and the file that may ORDER the ground-up review can
    // never be different files.
    const F = require('../src/lib/feasibility-fee');
    let disagree = 0;
    for (const st of ['Ground-up Construction', 'Fix & Flip', 'Bridge / Stabilized', 'New Construction', 'Fix & Hold (BRRRR)']) {
      for (const h of [true, false]) {
        if (BR.suitabilityFor({ strategy: st, heavyRehab: h }).kind !== F.feasibilityKind({ strategy: st, heavyRehab: h })) disagree++;
      }
    }
    eq('A6 the review and the fee agree about what kind of deal every file is', disagree, 0);

    /* A6 COMPARES RAW STRINGS, AND THAT IS NOT ENOUGH — it would pass even while the two read the
       file DIFFERENTLY, which is exactly what happened: the review read `applications.program`
       raw while the fee reads it through `pricing.engineStrategy`, so the portal's own
       "Fix & Flip w/ Construction" label (it contains the word "construction") made an ordinary
       flip look like a GROUND-UP to one of them and not the other. So this asks both about REAL
       FILES, end to end, which is the only version of the question that can catch that class. */
    const P = require('../src/lib/pricing');
    let realDisagree = 0;
    for (const [program, rehab] of [
      ['Ground-up Construction', 'Ground-up'],
      ['Fix & Flip', 'Heavy rehab'],
      ['Fix & Flip', 'Light rehab'],
      ['Fix & Flip w/ Construction', 'Light rehab'],   // THE trap label
      ['Fix & Flip w/ Construction', 'Heavy rehab'],
      ['Bridge / Stabilized', ''],
      ['Fix & Hold (BRRRR)', 'Heavy rehab'],
    ]) {
      const id = await mk({ program, rehab });
      const row = (await db.query(`SELECT * FROM applications WHERE id=$1`, [id])).rows[0];
      const reviewKind = BR.suitabilityFor(await BR.inputForFile(id)).kind;
      const feeKind = F.feasibilityKind(P.buildInputs(row, { flips: 0, holds: 0, ground: 0 }, {}));
      if (reviewKind !== feeKind) {
        realDisagree++;
        console.log(`   …the review and the fee disagree on a REAL file (${program} / ${rehab}): review=${reviewKind} fee=${feeKind}`);
      }
    }
    eq('A7 …and they still agree when each reads a REAL FILE its own way', realDisagree, 0);
  }

  // ======================================================================
  // B. THE GATE REFUSES, one reason at a time, and reports them ALL at once
  // ======================================================================
  {
    const app = await mk();
    const g = await BR.reviewGate(app);
    ok('B1 a bare ground-up file cannot order one', !g.ready);
    ok('B2 …because the scope of work is not filled in', blocked(g, /Scope of Work/i));
    ok('B3 …and there is no contractor', blocked(g, /contractor/i));
    ok('B4 …and the appraisal is not back', blocked(g, /appraisal/i));
    ok('B5 EVERY blocker is reported in one go, never one at a time',
      (g.blockers || []).length >= 3);

    // A deal that may not order one says THAT and nothing else — listing four other blockers would
    // imply the order becomes possible once they are cleared.
    const flip = await mk({ program: 'Fix & Flip', rehab: 'Light rehab' });
    const g2 = await BR.reviewGate(flip);
    eq('B6 an ineligible deal reports exactly one reason — its own', (g2.blockers || []).length, 1);
    ok('B7 …and that reason is the deal kind', /only for a ground-up/.test(g2.blockers[0]));
  }

  // ======================================================================
  // C. THE CONTRACTOR — Trinity's own required fields, and OUR record
  // ======================================================================
  {
    const app = await mk();
    const mkContractor = async (over = {}) => {
      const c = (await db.query(
        `INSERT INTO service_contacts(contact_type, company_name, contact_name, email, phone)
         VALUES('contractor',$1,$2,$3,$4) RETURNING id`,
        [over.company === undefined ? 'BuildCo' : over.company,
          over.name === undefined ? 'Pat Builder' : over.name,
          over.email === undefined ? `gc.${TAG}@example.com` : over.email,
          over.phone === undefined ? '512-555-0134' : over.phone])).rows[0].id;
      await db.query(
        `INSERT INTO application_service_contacts(application_id, service_contact_id, contact_type) VALUES($1,$2,'contractor')`,
        [app, c]);
      return c;
    };

    await mkContractor({ email: null });
    let r = await BR.contractorReady(app);
    ok('C1 a contractor with no email is refused — Trinity requires it', !r.ok && /email/i.test(r.why));

    await db.query(`DELETE FROM application_service_contacts WHERE application_id=$1`, [app]);
    await mkContractor({ phone: null });
    r = await BR.contractorReady(app);
    ok('C2 …and one with no phone number, so the reviewer can reach them', !r.ok && /phone/i.test(r.why));

    await db.query(`DELETE FROM application_service_contacts WHERE application_id=$1`, [app]);
    await mkContractor({ company: null });
    r = await BR.contractorReady(app);
    ok('C3 …and one with no company name', !r.ok && /company/i.test(r.why));

    await db.query(`DELETE FROM application_service_contacts WHERE application_id=$1`, [app]);
    const good = await mkContractor();
    r = await BR.contractorReady(app);
    ok('C4 a complete contractor passes', r.ok);
    eq('C5 …and it is OUR record that is linked, not a typed-in contact', String(r.contractorId), String(good));
  }

  // ======================================================================
  // D. THE APPRAISAL — back AND with a PDF, which are two different things
  // ======================================================================
  {
    const app = await mk();
    let r = await BR.appraisalReady(app);
    ok('D1 no appraisal at all is refused', !r.ok && /not back yet/i.test(r.why));

    const ap = (await db.query(
      `INSERT INTO appraisals(application_id, as_is_value, appraised_value, superseded, imported_at)
       VALUES($1, 300000, 520000, false, now()) RETURNING id`, [app])).rows[0].id;
    r = await BR.appraisalReady(app);
    ok('D2 an appraisal with NO report is still refused — the PDF has to go with the order',
      !r.ok && /no appraisal PDF/i.test(r.why));

    await db.query(
      `INSERT INTO documents(application_id, filename, doc_kind, is_current, review_status, storage_ref, content_type)
       VALUES($1,'appraisal-report.pdf','appraisal_pdf',true,'accepted','x','application/pdf')`, [app]);
    r = await BR.appraisalReady(app);
    ok('D3 with the report on file it passes', r.ok);
    eq('D4 …and names the appraisal it will send the figures from', String(r.appraisalId), String(ap));
    ok('D5 …and the document it will attach', !!r.documentId);

    // A REJECTED report is not a report. The same standard every outbound package applies.
    await db.query(`UPDATE documents SET review_status='rejected' WHERE application_id=$1`, [app]);
    ok('D6 a rejected report does not count', !(await BR.appraisalReady(app)).ok);
  }

  // ======================================================================
  // E. FAIL CLOSED — an unreadable file never becomes an orderable one
  // ======================================================================
  {
    const angry = { query: async () => { throw new Error('database is down'); } };
    const app = await mk();
    ok('E1 an unreadable contractor record blocks', !(await BR.contractorReady(app, angry)).ok);
    ok('E2 an unreadable appraisal blocks', !(await BR.appraisalReady(app, angry)).ok);
    ok('E3 an unreadable scope of work blocks', !(await BR.scopeReady(app, angry)).ok);
    const g = await BR.reviewGate(app, { input: { strategy: 'Ground-up Construction', heavyRehab: true }, client: angry });
    ok('E4 …and the whole gate refuses rather than throwing', g && g.ready === false);
  }

  // ======================================================================
  // F. THE PAYLOAD — a review asks for NO money, and that is the one rule
  //    that differs from a draw
  // ======================================================================
  {
    const base = {
      companyId: 39400, projectNumber: 'TBR-1', projectCustomerKey: 'p1', orderCustomerKey: 'o1',
      address: { street: '9 Plan St', city: 'Austin', state: 'TX', zip: '78701' },
      borrower: { name: 'Bud Review', email: 'b@example.com', phone: '512-555-0100' },
      contractor: { name: 'Pat Builder', companyName: 'BuildCo', email: 'gc@example.com', phone: '512-555-0134' },
      analyst: { name: 'Draw Coordinator' },
      // The WHOLE budget, nothing requested — which is what a review is.
      lines: [
        { name: 'Foundation', budgeted_cents: 5000000, requested_cents: 0, sow_line_key: 'found' },
        { name: 'Framing', budgeted_cents: 8000000, requested_cents: 0, sow_line_key: 'frame' },
      ],
    };
    const draw = mapper.buildOrderPayload({ ...base });
    ok('F1 as a DRAW, a budget with nothing requested is refused — a draw asks for money',
      (draw.problems || []).some((p) => /amount requested/i.test(p)));

    const review = mapper.buildOrderPayload({ ...base, kind: 'budget_review' });
    eq('F2 as a REVIEW it is accepted — asking for nothing is the point', review.problems, []);
    eq('F3 …and the whole scope goes over, line for line', (review.payload.order.lineItems || []).length, 2);
    ok('F4 …with nothing marked as requested', (review.payload.order.lineItems || []).every((l) => l.isRequested === false));
    ok('F5 …and each line carries its cost, which is what Trinity reads',
      (review.payload.order.lineItems || []).every((l) => Number(l.itemCost) > 0));

    // The contractor rules are Trinity's own and are NOT relaxed for a review.
    const noGc = mapper.buildOrderPayload({ ...base, kind: 'budget_review', contractor: { name: '', companyName: '', email: '' } });
    ok('F6 a review with no contractor is still refused — their schema requires all three',
      (noGc.problems || []).length >= 3);

    // The appraisal figures ride on the property, which is what the review is measured against.
    const withAppr = mapper.buildOrderPayload({ ...base, kind: 'budget_review', appraisal: { valueCents: 52000000, datePerformed: '2026-08-01', performedBy: 'Acme Appraisal' } });
    eq('F7 the appraised value rides on the property block', withAppr.payload.property.appraisal.value, 520000);
    eq('F8 …with who performed it and when', withAppr.payload.property.appraisal.performedBy, 'Acme Appraisal');

    // A DRAW is byte-identical to before this kind existed — the default must not have moved.
    const drawWithMoney = { ...base, lines: [{ name: 'Foundation', budgeted_cents: 5000000, requested_cents: 2000000, sow_line_key: 'found' }] };
    const a = mapper.buildOrderPayload({ ...drawWithMoney });
    const b = mapper.buildOrderPayload({ ...drawWithMoney, kind: 'draw' });
    eq('F9 an ordinary draw is unchanged by the new argument', JSON.stringify(a), JSON.stringify(b));
  }

  // ======================================================================
  // G. IT IS NOT A DRAW — the owner's "separate workflow other than the drawer"
  // ======================================================================
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/trinity/budget-review.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [what, re] of [
      ['sitewire draws', /sitewire_draws/],
      ['portal draw requests', /portal_draw_requests/],
      ['draw findings', /draw_findings/],
      ['the money ledger', /draw_disbursements/],
    ]) ok(`G1 the review never touches ${what}`, !re.test(src));
  }

  // ======================================================================
  // H. ORDERING ONE — the safety is the draw path's, line for line, because the
  //    failure modes are identical and they were learned the hard way there
  // ======================================================================
  {
    const tclient = require('../src/trinity/client');
    // A COMPLETE, ORDERABLE FILE.
    const app = await mk();
    await db.query(
      `INSERT INTO appraisals(application_id, as_is_value, appraised_value, superseded, imported_at)
       VALUES($1, 300000, 900000, false, now())`, [app]);
    await db.query(
      `INSERT INTO documents(application_id, filename, doc_kind, is_current, review_status, storage_ref, content_type)
       VALUES($1,'appraisal-report.pdf','appraisal_pdf',true,'accepted','x','application/pdf')`, [app]);
    const gc = (await db.query(
      `INSERT INTO service_contacts(contact_type, company_name, contact_name, email, phone)
       VALUES('contractor','BuildCo','Pat Builder',$1,'512-555-0134') RETURNING id`,
      [`gc2.${TAG}@example.com`])).rows[0].id;
    await db.query(
      `INSERT INTO application_service_contacts(application_id, service_contact_id, contact_type)
       VALUES($1,$2,'contractor')`, [app, gc]);

    // The gate still refuses — the scope of work is not filled in, which is the honest state of
    // this fixture and exactly what the gate is for.
    let g = await BR.reviewGate(app);
    ok('H1 a file with the appraisal and the contractor but no scope still cannot order',
      !g.ready && blocked(g, /Scope of Work/i));
    ok('H2 …and the appraisal and contractor blockers are GONE, so the list is not just always-full',
      !blocked(g, /contractor/i) && !blocked(g, /appraisal/i));

    /* THE GATE ALSO REPORTS WHAT TRINITY'S OWN SCHEMA WOULD REFUSE. Without this the desk is told
       the file is ready, presses the button, and gets a DIFFERENT refusal a moment later — which
       is what happened in this very suite before it was fixed ("the borrower's phone number is
       missing", from the payload builder, on a file the gate had just called ready). */
    {
      const noPhone = await mk();
      await db.query(`UPDATE borrowers SET cell_phone=NULL WHERE id=(SELECT borrower_id FROM applications WHERE id=$1)`, [noPhone]);
      await db.query(
        `INSERT INTO appraisals(application_id, as_is_value, appraised_value, superseded, imported_at)
         VALUES($1, 300000, 900000, false, now())`, [noPhone]);
      await db.query(
        `INSERT INTO documents(application_id, filename, doc_kind, is_current, review_status, storage_ref, content_type)
         VALUES($1,'appraisal-report.pdf','appraisal_pdf',true,'accepted','x','application/pdf')`, [noPhone]);
      const c2 = (await db.query(
        `INSERT INTO service_contacts(contact_type, company_name, contact_name, email, phone)
         VALUES('contractor','BuildCo','Pat Builder',$1,'512-555-0134') RETURNING id`,
        [`gc3.${TAG}@example.com`])).rows[0].id;
      await db.query(
        `INSERT INTO application_service_contacts(application_id, service_contact_id, contact_type)
         VALUES($1,$2,'contractor')`, [noPhone, c2]);
      const t2 = (await db.query(`SELECT id FROM checklist_templates WHERE tool_key='rehab_budget' LIMIT 1`)).rows[0];
      if (t2) {
        await db.query(
          `INSERT INTO checklist_items(application_id, template_id, label, status, tool_key, tool_payload, scope)
           VALUES($1,$2,'Scope of Work','outstanding','rehab_budget',$3::jsonb,'application')`,
          [noPhone, t2.id, JSON.stringify(SOW_PAYLOAD)]);
        const gp = await BR.reviewGate(noPhone);
        ok('H2b a file Trinity would refuse is NOT reported as ready, whatever our own four checks say',
          !gp.ready && (gp.blockers || []).some((b) => /Trinity also needs/.test(b)));
      }
    }

    const req = await BR.requestReview(app);
    ok('H3 requesting one is refused while the gate is refusing', !req.ok && req.blocked);

    // Fill the scope in so the gate opens. `checkSowBudget` compares the tool's own totals to the
    // file's rehab budget to the cent — the same gate the Scope-of-Work CONDITION signs off on.
    const tmpl = (await db.query(`SELECT id FROM checklist_templates WHERE tool_key='rehab_budget' LIMIT 1`)).rows[0];
    if (tmpl) {
      await db.query(
        `INSERT INTO checklist_items(application_id, template_id, label, status, tool_key, tool_payload, scope)
         VALUES($1,$2,'Scope of Work','outstanding','rehab_budget',$3::jsonb,'application')`,
        [app, tmpl.id, JSON.stringify(SOW_PAYLOAD)]);
      g = await BR.reviewGate(app);
      if (!g.ready) console.log('   …gate still blocking:', JSON.stringify(g.blockers));
      ok('H4 with the scope filled in to the cent, the gate opens', g.ready === true);
    }

    // THE SWITCHES. With Trinity off, nothing is sent — and it says so rather than failing.
    const r2 = await BR.requestReview(app);
    if (r2.ok) {
      const placed = await BR.placeReviewOrder(app, r2.review.id);
      ok('H5 with the Trinity connection off, nothing is sent and it says why',
        placed && (placed.skipped === 'off' || placed.skipped === 'not_configured' || placed.skipped === 'outbound_off'));

      // THE FORM. A wrong form orders and pays for a DIFFERENT product, so it is named explicitly
      // and never left to the configuration that governs the draw.
      let sentForm = null;
      const realCreate = tclient.createOrder;
      const realAvail = tclient.available, realEnabled = tclient.enabled, realOut = tclient.outboundEnabled;
      const realCompany = tclient.companyId, realDoc = tclient.addDocument;
      tclient.available = () => true; tclient.enabled = () => true; tclient.outboundEnabled = () => true;
      tclient.companyId = async () => 39400;
      tclient.addDocument = async () => ({ id: 1 });
      tclient.createOrder = async (payload, opts) => {
        sentForm = opts && opts.form;
        return { id: 555, order: { id: 777, lineItems: payload.order.lineItems } };
      };
      try {
        const out = await BR.placeReviewOrder(app, r2.review.id);
        if (!(out && out.ok)) console.log('   …placeReviewOrder said:', JSON.stringify(out));
        ok('H6 the order goes through', out && out.ok === true);
        eq('H7 …on form 159, named explicitly rather than inherited from the draw form', sentForm, 159);
        eq('H8 …and Trinity\'s order id is recorded the instant it exists', String(out.trinityOrderId), '777');
        const row = (await db.query(`SELECT * FROM trinity_budget_reviews WHERE id=$1`, [r2.review.id])).rows[0];
        eq('H9 …the review is marked ordered', row.status, 'ordered');
        ok('H10 …and it records WHICH appraisal and WHICH PDF went with it', !!row.appraisal_id && !!row.appraisal_document_id);

        // EXACTLY ONCE. A second press must adopt, never post again.
        let calls = 0;
        tclient.createOrder = async () => { calls++; return { id: 1, order: { id: 2 } }; };
        const again = await BR.placeReviewOrder(app, r2.review.id);
        ok('H11 pressing it again never posts a second paid order', calls === 0 && again.already === true);
      } finally {
        tclient.createOrder = realCreate; tclient.available = realAvail; tclient.enabled = realEnabled;
        tclient.outboundEnabled = realOut; tclient.companyId = realCompany; tclient.addDocument = realDoc;
      }
    }

    // ONE LIVE REVIEW PER FILE — the database's rule, not a check somebody remembers.
    let threw = null;
    try {
      await db.query(
        `INSERT INTO trinity_budget_reviews(application_id, customer_key) VALUES($1,$2)`,
        [app, `tbr-second-${TAG}`]);
    } catch (e) { threw = e; }
    ok('H12 the database refuses a second live review on one file', !!threw);
  }

  console.log(fail ? `test-trinity-budget-review-db: ${pass} passed, ${fail} FAILED` : `test-trinity-budget-review-db: all ${pass} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-trinity-budget-review-db threw:', e); process.exit(1); });
