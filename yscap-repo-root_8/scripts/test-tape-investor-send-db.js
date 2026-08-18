#!/usr/bin/env node
'use strict';
/* "SEND TO INVESTOR" — the data tape leaves by EMAIL, manually (owner-directed
 * 2026-08-18), against a real database, the real HTTP route, and a STUBBED
 * MAILER asserting on the WIRE PAYLOAD (a passing send against the noop
 * provider proves nothing — the repo's standing rule):
 *
 *   A. the subject is the owner's exact shape ("New file for review - {loan} -
 *      {address}"), degrading cleanly when a piece is missing.
 *   B. the body figures: purchase vs refinance denominator, the three labelled
 *      leverage ratios, unknowns OMITTED (never $0 guesses), and NO ORIGINATION
 *      FEE anywhere — the owner named it as excluded.
 *   C. recipient validation: empty refused, junk refused with the address named,
 *      a pasted "Name <addr>" unwrapped, duplicates collapsed.
 *   D. the send over HTTP: one email, the team Cc'd visibly, Reply-To = the
 *      file's own inbox, EXACTLY ONE attachment (the Excel tape), the typed
 *      address SAVED per investor and offered on the next compose.
 *   E. the gates: an empty To refuses BEFORE anything runs; a wrong-buyer file
 *      is refused by the same buyer rule as the download, with NOTHING sent;
 *      a role without export_data_tapes gets 403.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-tape-investor-send-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const IS = require('../src/lib/tapes/investor-send');
const mailer = require('../src/lib/email');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  // ---- A + B + C: pure --------------------------------------------------------------------
  ok('A1 the subject is the owner\'s exact shape',
    IS.subjectFor({ ys_loan_number: 'YSCAP123', property_address: { oneLine: '10 Fidelis Way, Newark, NJ 07104' } })
      === 'New file for review - YSCAP123 - 10 Fidelis Way, Newark, NJ 07104');
  ok('A2 a missing loan number drops its segment (no dangling dash)',
    IS.subjectFor({ property_address: { oneLine: '10 Fidelis Way' } }) === 'New file for review - 10 Fidelis Way');
  ok('A3 a parts-only address composes', /Newark, NJ 07104$/.test(IS.subjectFor({ property_address: { line1: '10 Way', city: 'Newark', state: 'NJ', zip: '07104' } })));

  const QUOTE = { noteRate: 0.105, sizing: { totalLoan: 360000, initialAdvance: 248000, rehabHoldback: 80000, financedReserve: 32000, acqLtvPct: 0.8, arvPct: 0.8, oopRehab: 0 } };
  {
    const rows = IS.dealFigures({ loan_type: 'Purchase', purchase_price: 300000, as_is_value: 310000, rehab_budget: 80000 }, QUOTE);
    const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    ok('B1 a purchase leads with the purchase price', by['Purchase price'] === '$300,000');
    ok('B2 the loan structure figures ride', by['Loan amount'] === '$360,000' && by['Construction holdback'] === '$80,000'
      && by['Interest reserve (financed)'] === '$32,000' && by['Interest rate'] === '10.50%');
    ok('B3 the three ratios are labelled with their formulas',
      by['Initial LTV (initial advance ÷ acquisition value)'] === '80%' && by['ARV LTV (total loan ÷ after-repair value)'] === '80%'
      && /Effective LTV/.test(rows.map((r) => r.label).join('|')));
    ok('B4 effective LTV = total loan ÷ as-is', by['Effective LTV (total loan ÷ as-is value)'] === `${Math.round((360000 / 310000) * 10000) / 100}%`);
    ok('B5 NO origination fee, ever', !rows.some((r) => /originat/i.test(r.label) || /originat/i.test(String(r.value))));
    // A GROUND-UP's loan routinely exceeds the lot's as-is value — the ratio must
    // print as a real 400%, never "4%" (audit 98b8fac #1: the percent-form knee
    // silently divided every ratio past 150% by 100 in an email to an investor).
    {
      const gu = IS.dealFigures({ loan_type: 'Ground Up Construction', purchase_price: 100000, as_is_value: 100000 },
        { noteRate: 0.11, sizing: { totalLoan: 400000, initialAdvance: 80000, rehabHoldback: 300000, financedReserve: 20000 } });
      const gv = Object.fromEntries(gu.map((r) => [r.label, r.value]));
      ok('B8 a leverage ratio past 150% prints as itself, never divided by 100',
        gv['Effective LTV (total loan ÷ as-is value)'] === '400%');
    }
  }
  {
    const rows = IS.dealFigures({ loan_type: 'Refinance - Cash-Out', as_is_value: 400000 }, QUOTE);
    ok('B6 a refinance leads with the as-is value, never a purchase price',
      rows.some((r) => r.label === 'As-is value' && r.value === '$400,000') && !rows.some((r) => r.label === 'Purchase price'));
  }
  {
    const rows = IS.dealFigures({ loan_type: 'Purchase' }, null);
    ok('B7 an unregistered file OMITS the unknowable figures rather than guessing $0',
      !rows.some((r) => /Loan amount|Interest rate|LTV/i.test(r.label)));
  }
  ok('C1 an empty list refuses', /at least one/i.test(IS.cleanRecipients([]).problem));
  ok('C2 junk refuses naming the address', /not a valid email/.test(IS.cleanRecipients(['nope']).problem));
  ok('C3 a pasted "Name <addr>" unwraps + dedupes',
    JSON.stringify(IS.cleanRecipients(['Jane Doe <JANE@x.com>', 'jane@x.com']).emails) === '["jane@x.com"]');

  // ---- D + E: the wire --------------------------------------------------------------------
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = Date.now().toString(36);
  let superId, uwId, loId, procId, borId, fidApp, blApp;
  const outbox = [];
  const realSend = mailer.sendMail;
  try {
    const mkStaff = async (role, name) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`, [`tis-${name}-${sfx}@test.local`, `TIS ${name}`, role])).rows[0].id;
    superId = await mkStaff('super_admin', 'super');
    uwId = await mkStaff('underwriter', 'uw');
    loId = await mkStaff('loan_officer', 'lo');
    procId = await mkStaff('processor', 'proc');
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const uwTok = C.signJwt({ sub: uwId, kind: 'staff', role: 'underwriter', tv: 0 });
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Tape','Sender',$1,740) RETURNING id`, [`tis-bo-${sfx}@test.local`])).rows[0].id;
    const mkApp = async (lender, program) => {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id,loan_officer_id,processor_id,status,ys_loan_number,lender,property_address,loan_type,property_type,units,purchase_price,as_is_value,arv,rehab_budget,loan_amount,rate_pct,term)
         VALUES ($1,$2,$3,'funded',$4,$5,'{"oneLine":"10 Tape Way, Newark, NJ 07104"}','Purchase','Single Family',1,300000,310000,450000,80000,360000,10.5,'12 months') RETURNING id`,
        [borId, loId, procId, `YSCAP-TIS-${sfx}-${lender.slice(0, 2)}`, lender])).rows[0].id;
      await db.query(
        `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
         VALUES ($1,$2,'{}'::jsonb,$3,true)`, [id, program, JSON.stringify(QUOTE)]);
      return id;
    };
    fidApp = await mkApp('Fidelis', 'standard');
    blApp = await mkApp('Blue Lake', 'gold');

    mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };

    // E1: empty To refuses before anything runs.
    const empty = await call(server, 'POST', `/api/staff/applications/${fidApp}/tape-send/fidelis`, tok, { to: [] });
    ok('E1 an empty To answers 400 and sends nothing', empty.status === 400 && outbox.length === 0);

    // D: the real send.
    const sent = await call(server, 'POST', `/api/staff/applications/${fidApp}/tape-send/fidelis`, tok,
      { to: ['Desk <capital@fidelis-test.com>'], note: 'Ground-up ready for review.' });
    ok('D1 the send answers ok with the recipients', sent.status === 200 && sent.body && sent.body.ok === true
      && JSON.stringify(sent.body.to) === '["capital@fidelis-test.com"]');
    ok('D2 exactly ONE email left', outbox.length === 1);
    const m = outbox[0] || {};
    ok('D3 subject is the owner\'s exact shape',
      m.subject === `New file for review - YSCAP-TIS-${sfx}-Fi - 10 Tape Way, Newark, NJ 07104`);
    ok('D4 the team rides as a VISIBLE Cc (LO + processor)',
      Array.isArray(m.cc) && m.cc.includes(`tis-lo-${sfx}@test.local`) && m.cc.includes(`tis-proc-${sfx}@test.local`));
    ok('D5 replies thread into the file (Reply-To = the file\'s own inbox)',
      m.replyTo === `file+${fidApp}@${process.env.CHAT_REPLY_DOMAIN}`);
    ok('D6 EXACTLY one attachment — the Excel tape, with real bytes',
      Array.isArray(m.attachments) && m.attachments.length === 1
      && /\.xlsx$/i.test(m.attachments[0].filename)
      && typeof m.attachments[0].content === 'string' && m.attachments[0].content.length > 10000);
    ok('D7 the body carries the figures and the note, and never the origination fee',
      typeof m.text === 'string' && /Loan amount: \$360,000/.test(m.text) && /Ground-up ready for review\./.test(m.text)
      && !/originat/i.test(m.text) && (!m.html || !/originat/i.test(m.html)));
    ok('D8 the body is a STRING, never a rendered object', typeof m.text === 'string' && (m.html == null || typeof m.html === 'string'));

    // D9: the typed address was SAVED under the investor and is offered next time.
    const saved = (await db.query(
      `SELECT 1 FROM investor_delivery_contacts WHERE label_norm='fidelis' AND lower(email)='capital@fidelis-test.com' AND active LIMIT 1`)).rows[0];
    ok('D9 the address is saved per investor', !!saved);
    const pre = await call(server, 'GET', `/api/staff/applications/${fidApp}/tape-send`, tok);
    ok('D10 the next compose offers it pre-listed',
      pre.status === 200 && (pre.body.contacts || []).some((c) => c.email === 'capital@fidelis-test.com')
      && pre.body.replyTo === `file+${fidApp}@${process.env.CHAT_REPLY_DOMAIN}`);

    // E2: the wrong-buyer file is refused by the SAME buyer rule as the download — nothing sent.
    const before = outbox.length;
    const wrong = await call(server, 'POST', `/api/staff/applications/${blApp}/tape-send/fidelis`, uwTok, { to: ['capital@fidelis-test.com'] });
    ok('E2 a Blue Lake file cannot email the Fidelis tape (buyer_mismatch, nothing sent)',
      wrong.status === 409 && wrong.body && wrong.body.error === 'buyer_mismatch' && outbox.length === before);

    // E3: no export permission → 403.
    const denied = await call(server, 'POST', `/api/staff/applications/${fidApp}/tape-send/fidelis`, loTok, { to: ['capital@fidelis-test.com'] });
    ok('E3 a loan officer without export_data_tapes is refused', denied.status === 403 && outbox.length === before);
  } finally {
    mailer.sendMail = realSend;
    try {
      await db.query(`DELETE FROM investor_delivery_contacts WHERE lower(email)='capital@fidelis-test.com'`);
      await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[fidApp, blApp].filter(Boolean)]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[superId, uwId, loId, procId].filter(Boolean)]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-tape-investor-send-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
