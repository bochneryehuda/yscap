#!/usr/bin/env node
'use strict';
/* CLOSING RECONCILIATION — FUNDING CHANNEL aligned across PILOT / ClickUp / Encompass, and
 * TABLE-FUNDED loans SKIP draws (owner-directed 2026-08, Task L):
 *   "align table-funding across Encompass (read cx.tablefunder), ClickUp (Wholesale/correspondent)
 *    and PILOT's own selector, all showing the same status before Reconcile. Table-funded → skip
 *    post-closing delivery + purchasing + draws."
 *
 * PURE (no DB): the 3-system alignment shape — agreement, sold-at-table, the direct-only rule,
 * the button decision, and the ClickUp "Wholesale/correspondent" spellings.
 * DB + HTTP: the skip-draws guard — a table-funded file refuses the coordinator's start-draw AND
 * the borrower's request-draw; a direct file is not blocked by the table-funded guard.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const closing = require('../src/lib/closing');
const FC = require('../src/lib/funding-channel');
const fcs = closing.fundingChannelStatus;
const app = (over) => ({ lender: 'Fidelis Investors LLC', channel: null, encompass_extra: null, ...over });
const enc = (v) => ({ _fieldValues: { 'CX.TABLEFUNDER': v } });

// ── PURE: the 3-system alignment ──────────────────────────────────────────────
{
  // 1. All three say table funded → agree, sold, button reconcile.
  const r = fcs(app({ channel: 'Table Funding', encompass_extra: enc('Table Funding') }), { warehouse: 'Table Funding' });
  ok('P1 PILOT reads table funded from the Table Funding warehouse', r.pilot.table_funded === true);
  ok('P1 ClickUp reads table funded', r.clickup.table_funded === true);
  ok('P1 Encompass reads table funded (CX.TABLEFUNDER)', r.encompass.table_funded === true);
  ok('P1 the three agree', r.agree === true);
  ok('P1 sold at closing → button reconcile', r.sold_at_table === true && r.button === 'reconcile');
  ok('P1 no rule violation on a table-fund-allowed buyer (Fidelis)', !r.rule);
}
{
  // 2. PILOT table + ClickUp direct → DISAGREE, still sold (PILOT), reconcile.
  const r = fcs(app({ channel: 'Delegate Correspondent' }), { warehouse: 'Table Funding' });
  ok('P2 ClickUp "Delegate Correspondent" reads direct', r.clickup.table_funded === false);
  ok('P2 PILOT table vs ClickUp direct → they disagree', r.agree === false);
  ok('P2 sold-at-table is PILOT OR Encompass — PILOT still says sold', r.sold_at_table === true);
}
{
  // 3. All direct → agree, NOT sold, button purchasing.
  const r = fcs(app({ lender: 'Blue Lake Capital', channel: 'Delegate Correspondent', encompass_extra: enc('Direct RTL / Delegate') }), { warehouse: 'Warehouse A' });
  ok('P3 a non-Table-Funding warehouse reads direct', r.pilot.table_funded === false);
  ok('P3 all three agree on direct', r.agree === true);
  ok('P3 not sold → button purchasing', r.sold_at_table === false && r.button === 'purchasing');
}
{
  // 4. A DIRECT-ONLY buyer (Blue Lake) whose Encompass says table funding → the hard rule fires.
  const r = fcs(app({ lender: 'Blue Lake Capital', encompass_extra: enc('Table Funding') }), { warehouse: null });
  ok('P4 Blue Lake may NOT table fund', r.may_table_fund === false);
  ok('P4 the direct-only rule fires as a violation', r.rule && r.rule.violation === true && /never table funded/i.test(r.rule.message));
}
{
  // 5. A half-filled file (only PILOT chosen) → fewer than two opinions, so "agree" (no false alarm).
  const r = fcs(app({ channel: null, encompass_extra: null }), { warehouse: 'Table Funding' });
  ok('P5 with only one system with an opinion, nothing to disagree about', r.agree === true);
  ok('P5 ClickUp + Encompass read unknown (null)', r.clickup.table_funded === null && r.encompass.table_funded === null);
}
{
  // 6. The ClickUp "Wholesale/correspondent" spellings normalize the same as Encompass.
  ok('P6 "Delegate Correspondent" → direct', FC.channelKey('Delegate Correspondent') === 'direct');
  ok('P6 "Correspondent W TPR" → direct', FC.channelKey('Correspondent W TPR') === 'direct');
  ok('P6 "Table Funding" → table_funding', FC.channelKey('Table Funding') === 'table_funding');
}

// ── DB + HTTP: the skip-draws guard ───────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log(`\n(skipping the DB/HTTP skip-draws section — no DATABASE_URL)`);
  console.log(`\n${fail ? 'FAIL' : 'PASS'} test-closing-funding-channel-db (pure only): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
process.env.RESEND_API_KEY = '';
if (!process.env.STORAGE_DIR) process.env.STORAGE_DIR = require('os').tmpdir() + '/pilot-closing-fc-test';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const srv = require('../src/server');

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
  const server = srv.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  try {
    const superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,password_hash,token_version) VALUES ($1,'Super','super_admin',true,'x',0) RETURNING id`, [`cfc-super-${sfx}@test.local`])).rows[0].id;
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });

    const mkFunded = async (tableFunded) => {
      const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Fund','Chan',$1) RETURNING id`, [`cfc-bo-${sfx}-${Math.random().toString(36).slice(2, 7)}@test.local`])).rows[0].id;
      const a = (await db.query(
        `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status, loan_type, program, term, lender)
         VALUES ($1,$2,'{"oneLine":"1 Close St, Lakewood, NJ 08701"}'::jsonb,'funded','Purchase','Standard','12 Months','Fidelis Investors LLC') RETURNING id`,
        [b, `YSC${String(Math.random()).slice(-9)}`])).rows[0].id;
      await db.query(
        `INSERT INTO closing_workflow (application_id, warehouse, table_funded) VALUES ($1,$2,$3)
         ON CONFLICT (application_id) DO UPDATE SET warehouse=$2, table_funded=$3`,
        [a, tableFunded ? 'Table Funding' : 'Warehouse A', tableFunded]);
      return { appId: a, borrowerId: b };
    };

    // A TABLE-FUNDED file refuses the coordinator's start-draw.
    {
      const { appId } = await mkFunded(true);
      const r = await call(server, 'POST', `/api/sitewire/files/${appId}/start-draw`, superTok, {});
      ok('D table-funded start-draw is refused (422 table_funded)', r.status === 422 && r.body && r.body.code === 'table_funded');
    }
    // A DIRECT file is NOT blocked by the table-funded guard (it may fail later for other reasons,
    // but never with the table_funded code).
    {
      const { appId } = await mkFunded(false);
      const r = await call(server, 'POST', `/api/sitewire/files/${appId}/start-draw`, superTok, {});
      ok('D a direct file is not blocked by the table-funded guard', !(r.status === 422 && r.body && r.body.code === 'table_funded'));
    }
    // A TABLE-FUNDED file refuses the borrower's request-draw.
    {
      const { appId, borrowerId } = await mkFunded(true);
      await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0) ON CONFLICT (borrower_id) DO NOTHING`, [borrowerId]);
      const borTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
      const r = await call(server, 'POST', `/api/borrower/applications/${appId}/request-draw`, borTok, {});
      ok('D table-funded borrower request-draw is refused (409, sold at closing)', r.status === 409 && /sold at closing/i.test((r.body && r.body.error) || ''));
      const still = (await db.query(`SELECT draw_setup_requested_at FROM applications WHERE id=$1`, [appId])).rows[0];
      ok('D the refused request did not birth the draw setup', still.draw_setup_requested_at === null);
    }

    console.log(`\n${fail ? 'FAIL' : 'PASS'} test-closing-funding-channel-db: ${pass} passed, ${fail} failed`);
  } catch (e) { console.error(e); fail++; }
  finally { server.close(); await db.pool.end().catch(() => {}); }
  process.exit(fail ? 1 : 0);
})();
