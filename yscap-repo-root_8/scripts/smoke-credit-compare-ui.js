'use strict';
/*
 * RENDER SMOKE for the E6 "What changed since the last pull" panel.
 * A green build does NOT mean the page renders (an undeclared identifier builds
 * fine, then throws ReferenceError at render → ErrorBoundary). So we boot the
 * real server against a seeded DB, open the actual staff file screen, click
 * "View full report", and assert the new panel renders with NO ErrorBoundary
 * and NO page error. Requires the freshly-built web/v2/portal bundle.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5442/yscap_ui';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-secret-key-not-for-prod-000000';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'development';

const path = require('path');
const { chromium } = require(path.join('/opt/node22/lib/node_modules/playwright'));
const db = require('../src/db');
const C = require('../src/lib/crypto');

(async () => {
  await require('../src/migrate-boot').ensureSchema();
  const app = require('../src/server');
  const sfx = `${process.pid}-${Date.now()}`;

  const admin = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version) VALUES ($1,'Smoke Admin','admin',0) RETURNING id`, [`smoke.admin.${sfx}@t.test`])).rows[0].id;
  const prov = (await db.query(`SELECT id FROM credit_providers WHERE key='xactus'`)).rows[0].id;
  const bor = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Smoke','Borrower',$1,690) RETURNING id`, [`smoke.b.${sfx}@t.test`])).rows[0].id;
  const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, property_address) VALUES ($1,$2,$3::jsonb) RETURNING id`,
    [bor, admin, JSON.stringify({ line1: '100 Test St', city: 'New Haven', state: 'CT', zip: '06511' })])).rows[0].id;

  const fraudWrap = JSON.stringify({ severity: 'fatal', types: ['fraud_alert'], message: 'Fraud alert', findings: [{ type: 'fraud_alert', code: 'fraud_alert', severity: 'fatal', reportBorrowerId: 1, reconciled: false, message: 'Fraud alert on file' }] });
  const cmpOld = (await db.query(
    `INSERT INTO credit_reports (application_id,provider_id,ordered_by,status,request_type,representative_score,representative_bracket,underwriting_finding,created_at,completed_at)
     VALUES ($1,$2,$3,'imported','Individual',690,'680-699',$4::jsonb, now() - interval '5 minutes', now() - interval '5 minutes') RETURNING id`, [appId, prov, admin, fraudWrap])).rows[0].id;
  const cmpNew = (await db.query(
    `INSERT INTO credit_reports (application_id,provider_id,ordered_by,status,request_type,representative_score,representative_bracket,created_at,completed_at)
     VALUES ($1,$2,$3,'imported','Individual',720,'720-739', now(), now()) RETURNING id`, [appId, prov, admin])).rows[0].id;
  await db.query(`INSERT INTO credit_tradelines (credit_report_id, borrower_id, report_borrower_id, bureau, creditor_name, account_type, account_status_type, account_identifier_masked, unpaid_balance, credit_limit, is_collection, is_authorized_user, raw) VALUES ($1,$2,'1','Equifax','CHASE CARD','Revolving','Open','••••1234',2000,10000,false,false,'{}'::jsonb)`, [cmpOld, bor]);
  await db.query(`INSERT INTO credit_tradelines (credit_report_id, borrower_id, report_borrower_id, bureau, creditor_name, account_type, account_status_type, account_identifier_masked, unpaid_balance, credit_limit, is_collection, is_authorized_user, raw) VALUES ($1,$2,'1','Equifax','CHASE CARD','Revolving','Open','••••1234',1000,10000,false,false,'{}'::jsonb)`, [cmpNew, bor]);
  await db.query(`INSERT INTO credit_collections (credit_report_id, borrower_id, report_borrower_id, bureau, collection_agency_name, original_creditor_name, amount, raw) VALUES ($1,$2,'1','Equifax','OLD COLLECTOR','Verizon',500,'{}'::jsonb)`, [cmpOld, bor]);
  await db.query(`INSERT INTO credit_inquiries (credit_report_id, borrower_id, report_borrower_id, bureau, inquiry_date, inquiring_party_name, raw) VALUES ($1,$2,'1','Equifax','2026-07-01','RocketInq','{}'::jsonb)`, [cmpNew, bor]);

  const token = C.signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0 });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const pageErrors = [];
  const consoleErrors = [];
  await ctx.addInitScript((t) => { try { localStorage.setItem('ys_portal_token', t); } catch (e) {} }, token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  let result = { ok: false };
  try {
    await page.goto(`${base}/portal/#/internal/app/${appId}`, { waitUntil: 'domcontentloaded' });
    // Wait for the credit section to render + the report card's button.
    await page.getByRole('button', { name: 'View full report' }).first().waitFor({ timeout: 25000 });
    // E7: the order form's plain-language pull summary must render (2×2 capability).
    const panelText = await page.evaluate(() => document.body.innerText);
    const hasPullSummary = /Soft pull|Hard pull/.test(panelText);
    await page.getByRole('button', { name: 'View full report' }).first().click();
    // The modal heading + the NEW panel.
    await page.getByText('Full credit report').first().waitFor({ timeout: 15000 });
    await page.getByText('What changed since the last pull').first().waitFor({ timeout: 15000 });
    const bodyText = await page.evaluate(() => document.body.innerText);
    const crashed = /Something went wrong/i.test(bodyText);
    const hasScoreUp = /went up 30 points/i.test(bodyText);
    const hasClearedFraud = /Fraud alert cleared/i.test(bodyText);
    const hasClearedColl = /collection cleared/i.test(bodyText);
    await page.screenshot({ path: '/tmp/claude-0/-home-user-yscap/3bf10f82-a2e8-54fc-a9c0-2c87ec8ba5d3/scratchpad/credit-compare-ui.png', fullPage: false });
    result = { ok: !crashed && hasScoreUp && hasClearedFraud && hasPullSummary, crashed, hasScoreUp, hasClearedFraud, hasClearedColl, hasPullSummary };
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }

  console.log('SMOKE RESULT:', JSON.stringify(result, null, 2));
  console.log('pageErrors:', JSON.stringify(pageErrors));
  console.log('consoleErrors (first 5):', JSON.stringify(consoleErrors.slice(0, 5)));

  await browser.close();
  server.close();
  // cleanup
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]).catch(() => {});
  await db.query(`DELETE FROM credit_tradelines WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]).catch(() => {});
  await db.query(`DELETE FROM credit_collections WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]).catch(() => {});
  await db.query(`DELETE FROM credit_inquiries WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]).catch(() => {});
  await db.query(`DELETE FROM credit_reports WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [admin]).catch(() => {});
  process.exit(result.ok ? 0 : 1);
})().catch((e) => { console.error('SMOKE FATAL:', e); process.exit(2); });
