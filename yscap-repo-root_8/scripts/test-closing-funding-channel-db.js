/* HOW THIS LOAN FUNDS — the closing section's delegate ↔ table-funding card,
 * against a REAL database (owner-directed 2026-08-18: "there's no clear path on
 * the file now in pilot to change it from a delegate file to a table funding
 * file … somewhere on the closing section … so it should match with Encompass").
 *
 * What only a real database can prove:
 *   A. THE COLUMNS AND THE JSONB READS ARE REAL. readFundingChannel's SELECT
 *      (the `_fieldValues` map, the customFields[] fallback and its
 *      jsonb_typeof guard) runs inside getClosingWorkspace's safe(), so a
 *      phantom column or a jsonb shape error would be swallowed into a
 *      permanent, confident `fundingChannel: null` — the repo's #1 bug class.
 *   B. The comparison over real rows: agree / disagree / nothing-to-compare,
 *      judged only when BOTH sides carry a readable value.
 *   C. The workspace payload actually CARRIES the block (the safe() wiring and
 *      the payload key, not just the helper).
 *
 * Plus the UI-wiring source guards for the two 2026-08-18 owner items — the
 *      gate's inline closing-date field and the funding-channel card — so a
 *      refactor cannot silently unwire either button from its server door.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-closing-funding-channel-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-closing-funding-channel-db (no DATABASE_URL)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');
const closing = require('../src/lib/closing');

(async () => {
  const mkFile = async (opts) => {
    const o = opts || {};
    const email = 'fc' + crypto.randomBytes(6).toString('hex') + '@example.com';
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Funding','Channel',$1) RETURNING id`, [email])).rows[0].id;
    const app = (await db.query(
      `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address,loan_amount,encompass_extra)
       VALUES($1,'approved',$2,$3,'{"oneLine":"9 Channel Ct","city":"Scranton","state":"PA","zip":"18505"}',400000,$4)
       RETURNING id`,
      [bor, 'FC' + crypto.randomBytes(4).toString('hex'), o.lender || 'Fidelis Investors LLC',
        o.extra == null ? null : JSON.stringify(o.extra)])).rows[0].id;
    if (o.warehouse !== undefined) {
      await db.query(
        `INSERT INTO closing_workflow(application_id, warehouse, table_funded)
         VALUES($1,$2,$3) ON CONFLICT (application_id) DO UPDATE SET warehouse=$2, table_funded=$3`,
        [app, o.warehouse, o.warehouse === closing.TABLE_FUNDING]);
    }
    return app;
  };
  const fcOf = async (appId) => {
    const ws = await closing.getClosingWorkspace(appId);
    return ws && ws.fundingChannel;
  };

  // ── A/B/C: the comparison over real rows, through the WHOLE workspace ──────
  // 1. Encompass says table funding, warehouse not picked yet → nothing to compare.
  let app = await mkFile({ extra: { _fieldValues: { 'CX.TABLEFUNDER': 'Table Funding' } } });
  let fc = await fcOf(app);
  ok('1. workspace carries the fundingChannel block', !!fc);
  eq('1. encompass normalized', fc && fc.encompassChannel, 'table_funding');
  eq('1. encompass raw wording kept', fc && fc.encompassRaw, 'Table Funding');
  eq('1. ours null while the warehouse is unset', fc && fc.ours, null);
  eq('1. agreement not judged one-sided', fc && fc.agrees, null);

  // 2. The closer picks the Table Funding line → the two agree.
  await db.query(
    `INSERT INTO closing_workflow(application_id, warehouse, table_funded) VALUES($1,$2,true)
     ON CONFLICT (application_id) DO UPDATE SET warehouse=$2, table_funded=true`, [app, closing.TABLE_FUNDING]);
  fc = await fcOf(app);
  eq('2. ours = table funding off the warehouse', fc && fc.ours, 'table_funding');
  eq('2. agrees', fc && fc.agrees, true);
  eq('2. Fidelis may table fund', fc && fc.mayTableFund, true);

  // 3. A real warehouse line = delegate → disagreement with Encompass's table funding.
  await db.query(`UPDATE closing_workflow SET warehouse='Stride Bank', table_funded=false WHERE application_id=$1`, [app]);
  fc = await fcOf(app);
  eq('3. ours = direct off a real line', fc && fc.ours, 'direct');
  eq('3. warehouse named', fc && fc.warehouse, 'Stride Bank');
  eq('3. disagrees', fc && fc.agrees, false);

  // 4. Encompass blank → reported as itself, never a mismatch.
  app = await mkFile({ warehouse: 'Stride Bank', extra: null });
  fc = await fcOf(app);
  eq('4. blank encompass raw', fc && fc.encompassRaw, null);
  eq('4. blank encompass channel', fc && fc.encompassChannel, null);
  eq('4. no agreement judged', fc && fc.agrees, null);

  // 5. The customFields[] fallback (a pull made before the by-number map).
  app = await mkFile({ warehouse: 'Stride Bank', extra: { customFields: [{ fieldName: 'CX.TABLEFUNDER', value: 'Direct RTL / Delegate' }] } });
  fc = await fcOf(app);
  eq('5. customFields fallback read', fc && fc.encompassRaw, 'Direct RTL / Delegate');
  eq('5. normalized direct', fc && fc.encompassChannel, 'direct');
  eq('5. agrees on delegate', fc && fc.agrees, true);

  // 6. customFields stored as an OBJECT — the jsonb_typeof guard: no throw, no value.
  app = await mkFile({ warehouse: 'Stride Bank', extra: { customFields: { fieldName: 'CX.TABLEFUNDER', value: 'Table Funding' } } });
  fc = await fcOf(app);
  ok('6. object-shaped customFields does not blank the block', !!fc);
  eq('6. unreadable shape reads as blank', fc && fc.encompassRaw, null);

  // 7. A spelling the shared map does not carry → shown as itself, no verdict.
  app = await mkFile({ warehouse: closing.TABLE_FUNDING, extra: { _fieldValues: { 'CX.TABLEFUNDER': 'Bananas Channel' } } });
  fc = await fcOf(app);
  eq('7. unrecognized raw kept for display', fc && fc.encompassRaw, 'Bananas Channel');
  eq('7. unrecognized normalizes to null', fc && fc.encompassChannel, null);
  eq('7. no agreement judged on an unrecognized value', fc && fc.agrees, null);

  // 8. The buyer's advisory rule rides along (informational only).
  app = await mkFile({ lender: 'Blue Lake Capital', warehouse: closing.TABLE_FUNDING, extra: null });
  fc = await fcOf(app);
  eq('8. direct-only buyer flagged', fc && fc.mayTableFund, false);
  eq('8. buyer key', fc && fc.buyer, 'bluelake');

  // ── UI-wiring source guards (owner 2026-08-18, both items) ─────────────────
  const esign = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'components', 'EsignFileSection.jsx'), 'utf8');
  ok('gate: inline closing-date editor exists', /function InlineClosingDate\(/.test(esign));
  ok('gate: it writes through the ONE closing-date door', /staffSetClosingDate\(appId,\s*\{\s*expectedClosing/.test(esign));
  ok('gate: it is wired to the expected_closing blocker row', /o\.code === 'expected_closing'/.test(esign));

  const panel = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'components', 'ClosingPanel.jsx'), 'utf8');
  ok('closing: the funding-channel card renders', /<FundingChannelCard/.test(panel) && /function FundingChannelCard\(/.test(panel));
  ok('closing: it writes the ONE warehouse field, never a second flag', /closingUpdate\(appId,\s*\{\s*warehouse:/.test(panel) && !/tableFunded\s*:/.test(panel));
  ok('closing: the table-funding write uses the server-sent line name', /ws\.tableFundingWarehouse/.test(panel));

  console.log(`\ntest-closing-funding-channel-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
