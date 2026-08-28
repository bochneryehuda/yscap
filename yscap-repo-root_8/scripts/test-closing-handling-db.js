'use strict';
/**
 * WHO HANDLES THE CLOSING — the three-way switch, over a real Postgres and real
 * HTTP (owner-directed 2026-08-28). Skips with no DATABASE_URL.
 *
 * What this pins:
 *   A. THE RESOLVER'S PRECEDENCE — file override → note-buyer default (prefix-
 *      matched over real spellings) → company default → attorney. The seeds
 *      (Templeview + RCN = lender-direct) are in the database and match a real
 *      ClickUp-style spelling.
 *   B. THE CAPABILITY TRUTH TABLE — what each handling enables/disables, and
 *      that every disabled option carries a REASON ("if an option is disabled,
 *      it should always say why"), naming the buyer on lender-direct.
 *   C. THE NEW-YORK TITLE CUT — a NY title follow-up never asks title for the
 *      CPL, the wiring instructions or the preliminary settlement statement;
 *      a New-Jersey one still asks for all five. Whatever the handling is.
 *   D. THE GATES BITE ON THE REAL ROUTES — the attorney closing prep refuses
 *      on an internal or lender-direct file with the capability rule's own
 *      sentence; the settlement-agent order refuses everywhere but an
 *      internal-handled NY file, and SENDS there (stubbed provider), writing a
 *      real 'settlement' file_orders row, asking for the three named items
 *      with the mortgagee clause + loan number.
 *   E. FLIPPING A FILE TO INTERNAL SEEDS THE ITEMIZED TITLE SLOTS — a slot per
 *      requested item, with the NY cut applied, idempotently.
 *   F. THE ADMIN SETTINGS ENDPOINTS round-trip (company + buyer rows).
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-closing-handling-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const db = require('../src/db');
const ch = require('../src/lib/closing-handling');
const orders = require('../src/lib/orders');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `chs-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ada Admin','admin',true) RETURNING id`,
    [`${uniq}-admin@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Clo','Sing',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const mkApp = async ({ state = 'NY', lender = null } = {}) => (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number, lender, property_address, loan_type, usps_imported_at)
     VALUES ($1,'underwriting',$2,$3,$4,'Purchase',now()) RETURNING id`,
    [borrower, `YS${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`, lender,
      JSON.stringify({ oneLine: `1 Close Ct, City, ${state} 11111`, street: '1 Close Ct', city: 'City', state, zip: '11111' })])).rows[0].id;

  const jwt = signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0, sid: 'test' });
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };

  // Make sure a leftover company default from an earlier run can't skew A.
  await ch.setCompanyDefault(null, admin);

  // ── A. THE RESOLVER'S PRECEDENCE ───────────────────────────────────────────
  {
    const plain = await mkApp({ lender: 'Fidelis Investors LLC' });
    let r = await ch.resolve(plain);
    ok(r.handling === 'attorney' && r.source === 'default', 'no setting anywhere → attorney, the standing default');

    const rcn = await mkApp({ lender: 'RCN Capital, LLC' });
    r = await ch.resolve(rcn);
    ok(r.handling === 'lender_direct' && r.source === 'note_buyer',
      'the seeded RCN default catches the real spelling "RCN Capital, LLC" (prefix match)');
    const tv = await mkApp({ lender: 'TempleView Capital Fund I' });
    r = await ch.resolve(tv);
    ok(r.handling === 'lender_direct' && r.source === 'note_buyer', 'the seeded Templeview default catches its long spelling');

    await ch.setCompanyDefault('internal', admin);
    r = await ch.resolve(plain);
    ok(r.handling === 'internal' && r.source === 'company', 'a company default covers a buyer with no row of their own');
    r = await ch.resolve(rcn);
    ok(r.handling === 'lender_direct' && r.source === 'note_buyer', '…but a buyer row still beats the company default');

    await db.query(`UPDATE applications SET closing_handling='attorney' WHERE id=$1`, [rcn]);
    r = await ch.resolve(rcn);
    ok(r.handling === 'attorney' && r.source === 'file', 'the FILE override beats everything');
    await db.query(`UPDATE applications SET closing_handling=NULL WHERE id=$1`, [rcn]);
    await ch.setCompanyDefault(null, admin);
  }

  // ── B. THE CAPABILITY TRUTH TABLE ──────────────────────────────────────────
  {
    const attorney = ch.capabilities({ handling: 'attorney', isNY: true, noteBuyer: 'X' });
    ok(attorney.attorneyPrep.enabled === true, 'attorney: the closing prep is live');
    ok(attorney.settlementAgent.enabled === false && attorney.settlementAgent.dormant === true
      && /Not in use yet/.test(attorney.settlementAgent.reason),
      'attorney: the settlement order is a PREPPED DRAFT, and says so');
    ok(attorney.titleSlots === 'single', 'attorney: the title condition keeps its single slot');

    const internalNY = ch.capabilities({ handling: 'internal', isNY: true, propertyState: 'NY' });
    ok(internalNY.attorneyPrep.enabled === false && /IN HOUSE/.test(internalNY.attorneyPrep.reason),
      'internal: the attorney prep is off, with the reason');
    ok(internalNY.settlementAgent.enabled === true, 'internal + NY: the settlement order is LIVE');
    ok(internalNY.titleSlots === 'itemized', 'internal: the title condition is itemized');

    const internalNJ = ch.capabilities({ handling: 'internal', isNY: false, propertyState: 'NJ' });
    ok(internalNJ.settlementAgent.enabled === false && /New York workflow/.test(internalNJ.settlementAgent.reason)
      && /NJ/.test(internalNJ.settlementAgent.reason),
      'internal outside NY: the settlement order is off, and the reason names the state');

    const ld = ch.capabilities({ handling: 'lender_direct', isNY: true, noteBuyer: 'RCN Capital' });
    ok(!ld.attorneyPrep.enabled && /RCN Capital/.test(ld.attorneyPrep.reason) && /lender-direct/.test(ld.attorneyPrep.reason),
      'lender-direct: the attorney prep is off and the reason NAMES THE BUYER');
    ok(!ld.settlementAgent.enabled && /RCN Capital/.test(ld.settlementAgent.reason),
      'lender-direct: the settlement order is off, same reason');
  }

  // ── C. THE NEW-YORK TITLE CUT ──────────────────────────────────────────────
  {
    ok(JSON.stringify(ch.titleWants('NY')) === JSON.stringify(['Title Commitment', 'Tax Certificate']),
      'NY title asks: commitment + tax cert only — no CPL, no wiring, no settlement statement');
    ok(ch.titleWants('NJ').length === 5, 'outside NY the full five-item list stands');
    // Through the REAL email builder.
    const vend = { email: `${uniq}-title@x.test`, company_name: 'T Co' };
    const mkData = (state) => ({
      appId: '11111111-1111-1111-1111-111111111111', loanNumber: 'YS1', hasLoanNumber: true,
      propertyLine: '1 Close Ct', propertyState: state, transactionType: 'Purchase',
      borrowerName: 'B', borrowerEmail: 'b@x.test', dob: '', entityName: '', loanAmount: '$1',
      officer: null, processor: null, helpers: [], lender: null,
      vendors: { title: vend, insurance: null, settlement: null },
    });
    const ny = orders.buildOrderEmail('title', mkData('NY'), { followup: true });
    ok(!/CPL/.test(ny.text) && !/Wiring Instructions/.test(ny.text) && !/Preliminary Settlement/.test(ny.text),
      'the NY title follow-up never asks title for the settlement items');
    ok(/Title Commitment/.test(ny.text) && /Tax Certificate/.test(ny.text), '…and still asks for what title DOES do in NY');
    const nj = orders.buildOrderEmail('title', mkData('NJ'), { followup: true });
    ok(/CPL/.test(nj.text) && /Wiring Instructions/.test(nj.text), 'a New-Jersey follow-up still asks for everything');
  }

  // ── D. THE GATES ON THE REAL ROUTES ────────────────────────────────────────
  const email = require('../src/lib/email');
  const withStub = async (fn) => {
    const real = email.sendMail; const outbox = [];
    email.sendMail = async (opts) => { outbox.push(opts); return { ok: true, id: `m${outbox.length}` }; };
    try { return { out: await fn(), outbox }; } finally { email.sendMail = real; }
  };
  {
    // Attorney prep refused on a lender-direct file, with the buyer named.
    const rcnApp = await mkApp({ lender: 'RCN Capital, LLC' });
    const r = await call('POST', `/api/staff/applications/${rcnApp}/closing-prep/place`, {});
    ok(r.status === 422 && r.body.code === 'closing_handling' && /RCN Capital/.test(r.body.error),
      'the attorney prep refuses on a lender-direct file, naming the buyer');

    // Settlement refused while the handling is attorney (dormant), and outside NY.
    const nyApp = await mkApp({});
    let sr = await call('POST', `/api/staff/applications/${nyApp}/orders/settlement/place`, {});
    ok(sr.status === 422 && /Not in use yet/.test(sr.body.error), 'the settlement order is dormant under attorney handling — refused with the draft note');
    await call('POST', `/api/staff/applications/${nyApp}/closing-handling`, { handling: 'internal' });
    const njApp = await mkApp({ state: 'NJ' });
    await call('POST', `/api/staff/applications/${njApp}/closing-handling`, { handling: 'internal' });
    sr = await call('POST', `/api/staff/applications/${njApp}/orders/settlement/place`, {});
    ok(sr.status === 422 && /New York workflow/.test(sr.body.error), 'an internal NJ file still cannot order a settlement agent');

    // No vendor yet → a plain contact refusal.
    sr = await call('POST', `/api/staff/applications/${nyApp}/orders/settlement/place`, {});
    ok(sr.status === 400 && sr.body.code === 'contact', 'an internal NY file without the contact is told to add it');

    // With the contact: it SENDS, asks for the three items, carries the clause.
    const sc = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,'settlement_agent','Settle Co','Sal Settle',$2) RETURNING id`,
      [borrower, `${uniq}-settle@x.test`])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                    VALUES ($1,$2,'settlement_agent')`, [nyApp, sc]);
    const { out, outbox } = await withStub(() => call('POST', `/api/staff/applications/${nyApp}/orders/settlement/place`, {}));
    ok(out.status === 200 && out.body.ok, 'the settlement-agent order SENDS on an internal NY file');
    ok(outbox.length === 1 && outbox[0].to.includes(`${uniq}-settle@x.test`), 'to the settlement agent on file');
    const text = outbox[0].text;
    ok(/Errors & Omissions insurance/.test(text) && /Preliminary settlement statement/.test(text) && /Wiring instructions/.test(text),
      'the order asks for exactly the three items the owner named');
    ok(/YS Capital Group/.test(text) && /Loan #: YS/.test(text), 'the mortgagee clause + loan number ride, like every vendor order');
    const row = (await db.query(`SELECT * FROM file_orders WHERE application_id=$1 AND order_type='settlement'`, [nyApp])).rows[0];
    ok(row && row.status === 'ordered', 'a real settlement file_orders row is recorded');
    // Second click without force → refused (the exactly-once core is inherited).
    const dup = await call('POST', `/api/staff/applications/${nyApp}/orders/settlement/place`, {});
    ok(dup.status === 409, 'a second engagement without force is refused');
  }

  // ── E. INTERNAL SEEDS THE ITEMIZED TITLE SLOTS ─────────────────────────────
  {
    const tplId = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_title'`)).rows[0];
    ok(!!tplId, 'the title condition template exists');
    const nyApp2 = await mkApp({});
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, is_required, status)
       VALUES ($1,'application',$2,'Title work','staff','document',true,'outstanding')`, [tplId.id, nyApp2]);
    const set = await call('POST', `/api/staff/applications/${nyApp2}/closing-handling`, { handling: 'internal' });
    ok(set.status === 200 && set.body.slotsSeeded === 2,
      `flipping a NY file to internal seeds the itemized title slots — with the NY cut applied (got ${set.body.slotsSeeded})`);
    const again = await call('POST', `/api/staff/applications/${nyApp2}/closing-handling`, { handling: 'internal' });
    ok(again.status === 200 && again.body.slotsSeeded === 0, 're-flipping seeds nothing twice (the slot door dedupes)');
    const slots = (await db.query(
      `SELECT extra_slots FROM checklist_items WHERE application_id=$1`, [nyApp2])).rows[0].extra_slots;
    ok(Array.isArray(slots) && slots.map((x) => x.label).join(',') === 'Title Commitment,Tax Certificate',
      'the seeded slots are exactly the NY title asks');

    const njApp2 = await mkApp({ state: 'NJ' });
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, is_required, status)
       VALUES ($1,'application',$2,'Title work','staff','document',true,'outstanding')`, [tplId.id, njApp2]);
    const setNj = await call('POST', `/api/staff/applications/${njApp2}/closing-handling`, { handling: 'internal' });
    ok(setNj.body.slotsSeeded === 5, `a New-Jersey internal file seeds all five title slots (got ${setNj.body.slotsSeeded})`);
  }

  // ── F. THE ADMIN SETTINGS ENDPOINTS ────────────────────────────────────────
  {
    const g = await call('GET', '/api/admin/integrations/closing-handling');
    ok(g.status === 200 && g.body.buyers.some((b) => b.key === 'rcn' && b.handling === 'lender_direct'),
      'the settings page reads the seeded buyer defaults');
    const put = await call('PUT', '/api/admin/integrations/closing-handling',
      { buyers: [{ buyer: 'Some New Buyer, LLC', handling: 'internal' }] });
    ok(put.status === 200 && put.body.buyers.some((b) => b.key === 'somenewbuyerllc' && b.handling === 'internal'),
      'a buyer default saves under the normalized key');
    await call('PUT', '/api/admin/integrations/closing-handling', { buyers: [{ buyer: 'Some New Buyer, LLC', handling: null }] });
    const g2 = await call('GET', '/api/admin/integrations/closing-handling');
    ok(!g2.body.buyers.some((b) => b.key === 'somenewbuyerllc'), 'clearing a buyer row removes it');
    const bad = await call('PUT', '/api/admin/integrations/closing-handling', { company: 'yolo' });
    ok(bad.status === 400, 'an unknown handling is refused');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll closing-handling checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
