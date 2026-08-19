'use strict';
/**
 * scripts/test-lead-phone-marks-db.js — THE LEAD'S PHONE BOOK, over REAL HTTP.
 *
 * Owner-directed 2026-08-19 (RTL lead CRM, connected to Elementix): "when I
 * want to log a call, I should choose which phone number from the phone
 * numbers that they have in the system … all the options from all the phone
 * numbers that you're importing from Elementix. I should be able to mark any
 * of the numbers that are not working, but it should NOT be removed … even a
 * non-answered call, I should be able to put in that this number is working
 * and this is going to the right person."
 *
 * WHAT THIS PROVES, the load-bearing bits first:
 *   1. THE UNION — the picker offers the lead's own numbers PLUS every number
 *      the Elementix unlock holds, deduped by the plane's one phone identity
 *      (phoneKey), the vendor's own words riding along.
 *   2. NEVER REMOVED — a number marked not working is STILL in the book,
 *      wearing its mark. The mutation that silently drops it must fail here.
 *   3. THE VERDICT RIDES THE CALL LOG — one request logs the call, names the
 *      number, and records working + right person, with NO duplicate system
 *      row (the call row is the record). Outcome-independent by design.
 *   4. MEMBERSHIP — a number the lead does not have can neither be logged
 *      against nor marked (400, nothing written).
 *   5. PARTIAL MERGE — a later mark touching only one field keeps the other.
 *   6. THE DOORS — another officer's lead is 403; an external (TPO) staff row
 *      is refused by the Elementix door itself; an unlinked lead still works
 *      with just its own numbers.
 *
 * REAL POSTGRES, REAL EXPRESS. Skips politely with no DATABASE_URL.
 */

const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ FAIL: ${m}`); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('· test-lead-phone-marks-db: no DATABASE_URL — skipped'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');

  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const madeStaff = [];
  const madeLeads = [];
  const personId = `phonebook-person-${sfx}`;
  let firm = null;

  const phonesOf = async (server2, leadId, tok) => (await call(server2, 'GET', `/api/elementix/leads/${leadId}/phones`, tok));
  const rowOf = (resp, key) => ((resp.body && resp.body.phones) || []).find((p) => p.key === key) || null;

  try {
    console.log('\nLEAD PHONE BOOK + MARKS — real HTTP, real Postgres\n');

    // ── the cast ────────────────────────────────────────────────────────────
    const mkStaff = async (name, role, extra = {}) => (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id, token_version)
       VALUES ($1,$2,$3,true,$4,$5,0) RETURNING id`,
      [`${name}-${sfx}@phonebook.test`, `${name} ${sfx}`, role, !!extra.external, extra.firmId || null])).rows[0].id;
    const officer = await mkStaff('PhonebookOwner', 'loan_officer');
    const stranger = await mkStaff('PhonebookStranger', 'loan_officer');
    firm = (await db.query(`INSERT INTO tpo_firms (name, status) VALUES ($1,'active') RETURNING id`,
      [`Phonebook Brokerage ${sfx}`])).rows[0].id;
    const broker = await mkStaff('PhonebookBroker', 'tpo_officer', { external: true, firmId: firm });
    madeStaff.push(officer, stranger, broker);
    const T = C.signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0 });
    const TS = C.signJwt({ sub: stranger, kind: 'staff', role: 'loan_officer', tv: 0 });
    const TB = C.signJwt({ sub: broker, kind: 'staff', role: 'tpo_officer', tv: 0 });

    await db.query(`INSERT INTO elementix_persons (person_id, display_name) VALUES ($1,$2)
                    ON CONFLICT (person_id) DO NOTHING`, [personId, `Phonebook Person ${sfx}`]);
    // Three vendor numbers; the FIRST is the same number the lead row holds, so
    // the union must MERGE them into one row carrying the vendor's own words.
    await db.query(
      `INSERT INTO elementix_contacts (person_id, phones, emails, addresses, source)
       VALUES ($1,$2::jsonb,'[]'::jsonb,'[]'::jsonb,'imported')
       ON CONFLICT (person_id) DO UPDATE SET phones = EXCLUDED.phones`,
      [personId, JSON.stringify([
        { value: '(555) 111-2222', key: '5551112222', label: 'Mobile', carrier: 'Verizon', status: 'Deliverable', confidence: 0.85 },
        { value: '555-555-6666', key: '5555556666', label: 'Landline', carrier: 'AT&T', status: 'Deliverable', confidence: 0.7 },
        { value: '5557778888', key: '5557778888', label: 'VOIP', confidence: 0.4 },
      ])]);

    const leadId = (await db.query(
      `INSERT INTO leads (tool, source, name, first_name, last_name, status, officer_id, phone, phone_alt, elementix_person_id)
       VALUES ('manual','manual',$1,'Phonebook',$2,'new',$3::uuid,'(555) 111-2222','555 333 4444',$4) RETURNING id`,
      [`Phonebook Lead ${sfx}`, `Lead ${sfx}`, officer, personId])).rows[0].id;
    madeLeads.push(leadId);

    // -----------------------------------------------------------------------
    console.log('1. The union: own numbers + EVERY Elementix number, deduped');
    // -----------------------------------------------------------------------
    let r = await phonesOf(server, leadId, T);
    ok(r.status === 200 && r.body.linked === true, `GET phones answers 200, linked (got ${r.status})`);
    const keys = (r.body.phones || []).map((p) => p.key);
    ok(keys.length === 4 && keys[0] === '5551112222' && keys[1] === '5553334444',
      `4 unique numbers, lead's own first (got ${keys.join(', ')})`);
    ok(keys.includes('5555556666') && keys.includes('5557778888'), 'the Elementix-only numbers are all offered');
    const merged = rowOf(r, '5551112222');
    ok(merged && merged.sources.includes('lead') && merged.sources.includes('elementix') && merged.label === 'Mobile',
      `the shared number is ONE row from both sources, wearing the vendor's label (got ${merged && JSON.stringify(merged.sources)} / ${merged && merged.label})`);

    // -----------------------------------------------------------------------
    console.log('2. Marked not working — and NEVER removed');
    // -----------------------------------------------------------------------
    r = await call(server, 'POST', `/api/elementix/leads/${leadId}/phones/mark`, T, { phone: '555-777-8888', status: 'not_working' });
    ok(r.status === 200 && r.body.ok, `mark not_working answers ok (got ${r.status})`);
    r = await phonesOf(server, leadId, T);
    const deadRow = rowOf(r, '5557778888');
    ok((r.body.phones || []).length === 4, `the book STILL holds all 4 numbers — a dead number is never removed (got ${(r.body.phones || []).length})`);
    ok(deadRow && deadRow.mark && deadRow.mark.status === 'not_working' && /PhonebookOwner/.test(String(deadRow.mark.markedByName)),
      'the number wears its mark, with who made it');
    const sysRows = (await db.query(
      `SELECT subject FROM lead_activities WHERE lead_id=$1 AND activity_type='system' AND meta->>'phone_key'='5557778888'`, [leadId])).rows;
    ok(sysRows.length === 1 && /not working/i.test(sysRows[0].subject), 'a standalone mark writes ONE timeline row');

    // -----------------------------------------------------------------------
    console.log('3. The verdict rides the call log — even on an unanswered call');
    // -----------------------------------------------------------------------
    r = await call(server, 'POST', `/api/staff/leads/${leadId}/activities`, T,
      { type: 'call', body: 'Rang, no answer — voicemail names him.', direction: 'outbound',
        phone: '(555) 555-6666', markWorking: true, rightPerson: true });
    ok(r.status === 201, `the call logs (got ${r.status})`);
    const meta = r.body && r.body.activity && r.body.activity.meta;
    ok(meta && meta.phone_key === '5555556666' && meta.mark_status === 'working' && meta.right_person === true,
      `the call row records the number + the verdict (got ${JSON.stringify(meta)})`);
    r = await phonesOf(server, leadId, T);
    const goodRow = rowOf(r, '5555556666');
    ok(goodRow && goodRow.mark && goodRow.mark.status === 'working' && goodRow.mark.rightPerson === true,
      'the mark landed: working + right person, from an unanswered call');
    const dupSys = (await db.query(
      `SELECT count(*)::int AS n FROM lead_activities WHERE lead_id=$1 AND activity_type='system' AND meta->>'phone_key'='5555556666'`, [leadId])).rows[0].n;
    ok(dupSys === 0, 'no duplicate system row beside the call — the call row is the record');

    // -----------------------------------------------------------------------
    console.log('4. A partial mark merges — it cannot blank the other half');
    // -----------------------------------------------------------------------
    r = await call(server, 'POST', `/api/elementix/leads/${leadId}/phones/mark`, T, { phone: '5555556666', rightPerson: 'clear' });
    ok(r.status === 200 && r.body.mark.status === 'working' && r.body.mark.rightPerson === null,
      `clearing right-person alone keeps the working status (got ${JSON.stringify(r.body && r.body.mark)})`);

    // -----------------------------------------------------------------------
    console.log('5. Membership: a number the lead does not have is refused');
    // -----------------------------------------------------------------------
    const before = (await db.query(`SELECT count(*)::int AS n FROM lead_activities WHERE lead_id=$1`, [leadId])).rows[0].n;
    r = await call(server, 'POST', `/api/staff/leads/${leadId}/activities`, T,
      { type: 'call', body: 'dialed something else', phone: '9998887777', markWorking: true });
    ok(r.status === 400, `logging a call against a foreign number answers 400 (got ${r.status})`);
    const after = (await db.query(`SELECT count(*)::int AS n FROM lead_activities WHERE lead_id=$1`, [leadId])).rows[0].n;
    ok(after === before, 'and nothing was written');
    r = await call(server, 'POST', `/api/elementix/leads/${leadId}/phones/mark`, T, { phone: '9998887777', status: 'working' });
    ok(r.status === 400, `marking a foreign number answers 400 (got ${r.status})`);
    r = await call(server, 'POST', `/api/elementix/leads/${leadId}/phones/mark`, T, { phone: '5553334444', status: 'excellent' });
    ok(r.status === 400, `a made-up status answers 400 (got ${r.status})`);

    // -----------------------------------------------------------------------
    console.log('6. Clearing a mark keeps the number AND the row');
    // -----------------------------------------------------------------------
    r = await call(server, 'POST', `/api/elementix/leads/${leadId}/phones/mark`, T, { phone: '5557778888', status: 'clear', rightPerson: 'clear' });
    ok(r.status === 200 && r.body.mark.status === null, 'a mark clears to unmarked');
    r = await phonesOf(server, leadId, T);
    ok((r.body.phones || []).length === 4 && rowOf(r, '5557778888'), 'the number is still in the book after the clear');

    // -----------------------------------------------------------------------
    console.log('7. The doors');
    // -----------------------------------------------------------------------
    r = await phonesOf(server, leadId, TS);
    ok(r.status === 403, `another officer's lead: phone book refused (got ${r.status})`);
    r = await call(server, 'POST', `/api/elementix/leads/${leadId}/phones/mark`, TS, { phone: '5551112222', status: 'working' });
    ok(r.status === 403, `another officer's lead: mark refused (got ${r.status})`);
    r = await call(server, 'POST', `/api/staff/leads/${leadId}/activities`, TS, { type: 'call', body: 'x', phone: '5551112222' });
    ok(r.status === 403, `another officer's lead: call log refused (got ${r.status})`);
    r = await phonesOf(server, leadId, TB);
    ok(r.status === 403, `an external (TPO) staff row is refused by the Elementix door (got ${r.status})`);

    // -----------------------------------------------------------------------
    console.log('8. A lead with NO Elementix link still has its book');
    // -----------------------------------------------------------------------
    const plainId = (await db.query(
      `INSERT INTO leads (tool, source, name, status, officer_id, phone)
       VALUES ('manual','manual',$1,'new',$2::uuid,'(555) 999-0000') RETURNING id`,
      [`Plain Lead ${sfx}`, officer])).rows[0].id;
    madeLeads.push(plainId);
    r = await phonesOf(server, plainId, T);
    ok(r.status === 200 && r.body.linked === false && (r.body.phones || []).length === 1 && r.body.phones[0].key === '5559990000',
      `an unlinked lead lists its own number (got ${r.status}, ${(r.body.phones || []).length})`);
    r = await call(server, 'POST', `/api/elementix/leads/${plainId}/phones/mark`, T, { phone: '5559990000', status: 'working' });
    ok(r.status === 200, 'and its number can be marked');

    console.log(`\n${pass} checks passed, ${fail} failed.\n`);
  } finally {
    try {
      if (madeLeads.length) {
        await db.query(`DELETE FROM lead_activities WHERE lead_id = ANY($1::uuid[])`, [madeLeads]);
        await db.query(`DELETE FROM lead_phone_marks WHERE lead_id = ANY($1::uuid[])`, [madeLeads]);
        await db.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [madeLeads]);
      }
      await db.query(`DELETE FROM elementix_contacts WHERE person_id = $1`, [personId]);
      await db.query(`DELETE FROM elementix_persons WHERE person_id = $1`, [personId]);
      if (madeStaff.length) {
        await db.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [madeStaff]);
        await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [madeStaff]);
      }
      if (firm) await db.query(`DELETE FROM tpo_firms WHERE id = $1`, [firm]);
    } catch (e) { console.log('  · cleanup:', e.message); }
    server.close();
    try { await db.pool.end(); } catch (_) { /* nothing to close */ }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack); process.exit(1); });
