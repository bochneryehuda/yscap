'use strict';
/**
 * THE LEAD DESK'S EXCEL EXPORT (owner-directed 2026-08-28: "make leads
 * exportable to excel … all the fields, if it's an Elementix file: phone
 * numbers, follow-up data, stuff like that") — real Postgres, real HTTP.
 *
 * What this pins, each a way the export could lie:
 *   1. IT IS A REAL .xlsx (the OOXML zip magic, the declared content type) —
 *      not a CSV wearing an Excel name.
 *   2. THE SCOPE IS THE FLOOR: a loan officer's export carries their book +
 *      the shared desk, never another officer's lead.
 *   3. ALL THE FIELDS RIDE — the follow-up date, the stage, the owner, the
 *      amounts — and EVERY PHONE NUMBER: the lead's own plus the numbers the
 *      Elementix unlock holds, with the officer's working/right-person
 *      verdicts, through the batched CRM-plane delegate.
 *   4. The desk's filters narrow the export exactly as they narrow the screen
 *      (stage; open-by-default vs scope=all).
 *   5. A formula-injection payload in a lead name is neutralized (the shared
 *      builder's safeCell), so an exported desk can never execute in Excel.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-leads-export-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';

const db = require('../src/db');
const { signJwt } = require('../src/lib/crypto');
const { unzip } = require('../src/lib/zip');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `lex-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mkStaff = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [`${uniq}-${name}@example.test`, name, role])).rows[0].id;
  const officer = await mkStaff('loan_officer', 'lo');
  const rival = await mkStaff('loan_officer', 'rival');

  // An Elementix unlock whose contact carries extra numbers (the person row
  // first — the contact row references it).
  const personId = `${uniq}-person`;
  await db.query(`INSERT INTO elementix_persons (person_id, display_name) VALUES ($1,'Elly Elementix')`, [personId]);
  await db.query(
    `INSERT INTO elementix_contacts (person_id, phones) VALUES ($1, $2::jsonb)`,
    [personId, JSON.stringify([{ value: '7185551234', label: 'Mobile' }, '9175559999'])]);

  const mkLead = async (name, extra = {}) => (await db.query(
    `INSERT INTO leads (tool, source, name, first_name, last_name, email, phone, status, officer_id,
                        next_follow_up, loan_amount, program, elementix_person_id)
     VALUES ('manual','manual',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [name, extra.first || name, extra.last || 'Lead', `${uniq}-${Math.random().toString(36).slice(2, 8)}@x.test`,
      extra.phone || null, extra.status || 'new', 'officerId' in extra ? extra.officerId : officer,
      extra.followUp || null, extra.amount || null, extra.program || null, extra.personId || null])).rows[0].id;

  const mine = await mkLead('Minnie Mine', { phone: '5165550000', followUp: '2026-09-01', amount: 250000, program: 'Fix & Flip' });
  const elx = await mkLead('Elly Elementix', { personId, phone: '7185551234' });
  await db.query(`INSERT INTO lead_phone_marks (lead_id, phone_key, status, right_person, marked_by)
                  VALUES ($1,'9175559999','working',true,$2)`, [elx, officer]);
  await mkLead('Rick Rival', { officerId: rival });
  await mkLead('Archie Archived', { status: 'archived' });
  await mkLead('=cmd|injection', { first: '=cmd|injection', last: '' });

  const jwt = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const fetchExport = async (qs = '') => {
    const r = await fetch(`${base}/api/staff/leads/export${qs}`, { headers: { Authorization: `Bearer ${jwt}` } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') || '', cd: r.headers.get('content-disposition') || '', buf };
  };
  // The whole sheet's text, read out of the real OOXML part.
  const sheetText = (buf) => {
    const files = unzip(buf);
    const sheet = files.find((f) => /worksheets\/sheet1\.xml$/i.test(f.name));
    return sheet ? sheet.data.toString('utf8') : '';
  };

  {
    const r = await fetchExport();
    ok(r.status === 200, 'the export answers');
    ok(r.buf.slice(0, 2).toString() === 'PK', 'it is a REAL .xlsx (OOXML zip magic), not a CSV');
    ok(/spreadsheetml/.test(r.type), 'the content type says Excel');
    ok(/pilot-leads-\d{4}-\d{2}-\d{2}\.xlsx/.test(r.cd), 'the filename is dated');
    const xml = sheetText(r.buf);
    ok(/Minnie Mine/.test(xml), 'the officer’s own lead is in the sheet');
    ok(!/Rick Rival/.test(xml), 'another officer’s lead is NOT — the scope is the floor');
    ok(!/Archie Archived/.test(xml), 'the default export is the OPEN book (closed leads stay out)');
    ok(/2026-09-01/.test(xml), 'the follow-up date rides');
    ok(/250000/.test(xml) && /Fix &amp; Flip/.test(xml), 'the amounts and program ride');
    ok(/Next follow-up/.test(xml) && /All phone numbers/.test(xml), 'the headers name the fields');
    // The Elementix numbers, with the verdicts.
    ok(/\(718\) 555-1234|7185551234/.test(xml), 'the lead’s own number rides');
    ok(/9999/.test(xml) && /Elementix/.test(xml), 'the Elementix-held number rides, labeled as Elementix');
    ok(/working, right person/.test(xml), 'the officer’s verdict on a number rides with it');
    // Formula injection neutralized.
    ok(!/<is><t[^>]*>=cmd/.test(xml), 'a formula-injection lead name is neutralized (leading quote), never live');
  }

  {
    const all = await fetchExport('?scope=all');
    ok(/Archie Archived/.test(sheetText(all.buf)), '?scope=all brings the closed leads along');
    const staged = await fetchExport('?stage=archived');
    const xml = sheetText(staged.buf);
    ok(/Archie Archived/.test(xml) && !/Minnie Mine/.test(xml), 'a stage filter narrows the export to that stage');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll lead-export checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
