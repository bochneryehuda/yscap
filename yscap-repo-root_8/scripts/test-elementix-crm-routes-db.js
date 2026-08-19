'use strict';
/**
 * scripts/test-elementix-crm-routes-db.js — the CRM desk over REAL HTTP.
 *
 * A route test, not a library test: the library suites already prove the skip
 * trace and the profile builder. What can only be wrong at this layer is WHO
 * gets through the door and WHAT comes back out of it — and the expensive
 * mistake here is not a wrong number, it is an outside company spending our
 * Elementix credits.
 *
 * REAL POSTGRES, REAL EXPRESS, STUBBED VENDOR. A test must never call Elementix
 * and must never spend a credit.
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

const PID = '66666666-6666-4666-8666-666666666666';
const PID2 = '77777777-7777-4777-8777-777777777777';

(async () => {
  if (!process.env.DATABASE_URL) { console.log('· test-elementix-crm-routes-db: no DATABASE_URL — skipped'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');

  // The stub goes in BEFORE the server, and every response below is the shape
  // the live connector really answers with (captured 2026-08-18).
  const crmTools = require(R + '/src/lib/elementix/crm-tools');
  let unlocked = new Set();
  let searchLimit = null;        // what the vendor says it was willing to send
  let statusDown = false;        // the vendor cannot be asked at all
  const seen = [];
  crmTools.call = async (tool, args, opts) => {
    seen.push({ tool, args, staffId: opts && opts.staffId });
    switch (tool) {
      case 'search':
        return { ok: true, data: {
          results: [{ id: PID, name: 'MOTY BRISK', state: 'NJ', entityType: 'PERSON', _url: 'https://app.elementix.com/person/x' }],
          ...(searchLimit == null ? {} : { resultLimit: searchLimit }),
        } };
      case 'get_contact_status':
        if (statusDown) return { ok: false, reason: 'unavailable', detail: 'Elementix could not be reached.' };
        return { ok: true, data: { unlocked: unlocked.has(args.personId) } };
      case 'submit_contact_enrichment':
        if (!opts || !opts.paidActor) return { ok: false, reason: 'paid_tool_refused', detail: 'no actor' };
        unlocked.add(args.personId);
        return { ok: true, data: { status: 'complete' } };
      case 'get_contact_info':
        return { ok: true, data: { phones: [{ value: '732-555-0101', label: 'Mobile' }], emails: [{ value: 'moty@example.com' }] } };
      case 'get_person':
        return { ok: true, data: { person: { id: args.id, name: 'MOTY BRISK', state: 'NJ', mortgageCount: 349, deedCount: 602, ownershipRecordCount: 829, preforeclosureCount: 3, satisfactionCount: 0, ownershipCount: 222, currentExposure: '197839792.86' } } };
      case 'get_person_lender_network':
        return { ok: true, data: { person: { id: args.id }, lenderConnections: [{ id: 'l1', name: 'CoreVest Finance', totalVolume: 1 }] } };
      case 'get_person_entities':
        if (args.scope === 'count') return { ok: true, data: { totalCount: 295 } };
        return { ok: true, data: { data: [{ id: 'e1', name: 'JC SWB EQUITIES ONE LLC' }] } };
      case 'get_person_cross_state':
        return { ok: true, data: { data: [{ id: PID2, name: 'MOTY BRISK', state: 'FL' }] } };
      default:
        return { ok: true, data: { data: [{ id: `${tool}-1` }] } };
    }
  };
  const crm = require(R + '/src/lib/elementix/crm');
  crm._internals.POLL_DELAY_MS = 1;

  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@elx.test`;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role: role || 'loan_officer', tv: 0 });

  // An external staff row MUST carry a firm — staff_users_external_firm_check
  // makes an unscoped outside identity structurally unwritable, which is the
  // TPO work's own invariant and worth leaning on rather than working around.
  const mkStaff = async (name, role, extra = {}) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id, token_version)
     VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`,
    [mail(name), name, role, extra.active !== false, !!extra.external, extra.firmId || null])).rows[0].id;

  try {
    console.log('\nELEMENTIX CRM DESK — real HTTP, real Postgres, stubbed vendor\n');
    await db.query(`DELETE FROM elementix_skip_traces WHERE person_id = ANY($1)`, [[PID, PID2]]);
    await db.query(`DELETE FROM elementix_contacts WHERE person_id = ANY($1)`, [[PID, PID2]]);
    await db.query(`UPDATE leads SET elementix_person_id = NULL WHERE elementix_person_id = $1`,
      ['0badf00d-dead-4bee-8fee-000000000002']);
    await db.query(`DELETE FROM leads WHERE elementix_person_id = ANY($1)`, [[PID, PID2]]);
    await db.query(`DELETE FROM elementix_person_sections WHERE person_id = ANY($1)`, [[PID, PID2]]);
    await db.query(`DELETE FROM elementix_person_aliases WHERE person_id = ANY($1) OR alias_person_id = ANY($1)`, [[PID, PID2]]);
    await db.query(`UPDATE elementix_persons SET primary_person_id = NULL WHERE person_id = ANY($1)`, [[PID, PID2]]);
    await db.query(`DELETE FROM elementix_persons WHERE person_id = ANY($1)`, [[PID, PID2]]);

    const officer = await mkStaff('Elx Officer', 'loan_officer');
    const officer2 = await mkStaff('Elx Officer Two', 'loan_officer');
    const admin = await mkStaff('Elx Admin', 'admin');
    const firm = (await db.query(
      `INSERT INTO tpo_firms (name, status) VALUES ($1,'active') RETURNING id`, [`Elx Brokerage ${sfx}`])).rows[0].id;
    const broker = await mkStaff('Elx Broker', 'tpo_officer', { external: true, firmId: firm });
    const gone = await mkStaff('Elx Retired', 'loan_officer', { active: false });
    const T = tok(officer), T2 = tok(officer2), TA = tok(admin, 'admin');

    // -----------------------------------------------------------------------
    console.log('1. Who gets through the door');
    // -----------------------------------------------------------------------
    let r = await call(server, 'GET', '/api/elementix/usage', null);
    ok(r.status === 401, 'nobody at all is refused (401)');

    r = await call(server, 'GET', '/api/elementix/usage', tok(officer, 'loan_officer'));
    ok(r.status === 200, 'an internal loan officer is let in — the owner wants every officer using this');

    // THE ONE THAT MATTERS.
    r = await call(server, 'GET', '/api/elementix/usage', tok(broker));
    ok(r.status === 403, 'an EXTERNAL staff row (a TPO broker) is refused — an outside company never spends our credits');
    r = await call(server, 'POST', '/api/elementix/people/' + PID + '/skip-trace', tok(broker), { reason: 'trying it on' });
    ok(r.status === 403, 'and refused on the money door specifically, not just the harmless one');

    r = await call(server, 'GET', '/api/elementix/usage', tok(gone));
    // 401 rather than 403: the auth layer catches a deactivated account before
    // this router is reached, and says so by name (account_deactivated). Either
    // answer keeps them out; asserting the real one keeps the test honest.
    ok(r.status === 401, 'a deactivated member of staff is refused at the door');

    r = await call(server, 'GET', '/api/elementix/connections', T);
    ok(r.status === 403, 'the roster of everyone’s connections is not open to every officer');
    r = await call(server, 'GET', '/api/elementix/connections', TA);
    ok(r.status === 200 && Array.isArray(r.body.connections) && Array.isArray(r.body.notConnected),
      'an admin sees the roster, and who has not connected yet');

    // -----------------------------------------------------------------------
    console.log('\n2. The allowance is on screen before anybody spends');
    // -----------------------------------------------------------------------
    r = await call(server, 'GET', '/api/elementix/usage', T);
    ok(r.status === 200 && typeof r.body.paidCap === 'number' && typeof r.body.maxPerHour === 'number',
      'the hourly and monthly ceilings are reported');
    ok(r.body.platformCeilingPerHour === 1000,
      'and so is the 1,000-an-hour ceiling the whole office shares');

    // -----------------------------------------------------------------------
    console.log('\n3. Finding somebody');
    // -----------------------------------------------------------------------
    r = await call(server, 'GET', '/api/elementix/search?q=mo', T);
    ok(r.status === 400, 'two letters is not a search');
    r = await call(server, 'GET', '/api/elementix/search?q=Moty%20Brisk&state=NJ', T);
    ok(r.status === 200 && r.body.results.length === 1 && r.body.results[0].personId === PID, 'a name finds the person');
    ok(r.body.results[0].inPilot === false && r.body.results[0].hasContact === false,
      'and says we do not hold them yet, so nobody buys a contact twice');

    // -----------------------------------------------------------------------
    console.log('\n4. The skip trace');
    // -----------------------------------------------------------------------
    r = await call(server, 'POST', `/api/elementix/people/${PID}/skip-trace`, T, {});
    ok(r.status === 400 && /why/i.test(r.body.error), 'a credit is not spent without a reason typed against it');

    // The LIBRARY refuses a BLANK reason; this line is what refuses one too
    // short to mean anything. That distinction is the whole point of asserting
    // it here — and the second check is what makes the first one prove
    // something, because a refusal that still bought the contact is no refusal.
    const spentBefore = seen.filter((c) => c.tool === 'submit_contact_enrichment').length;
    r = await call(server, 'POST', `/api/elementix/people/${PID}/skip-trace`, T, { reason: 'hm' });
    ok(r.status === 400, 'nor on a reason too short to mean anything a month later');
    ok(seen.filter((c) => c.tool === 'submit_contact_enrichment').length === spentBefore,
      'and nothing was bought while it was being refused');

    r = await call(server, 'POST', `/api/elementix/people/${PID}/skip-trace`, T, { reason: 'Calling about a bridge loan', name: 'MOTY BRISK', state: 'NJ' });
    ok(r.status === 200 && r.body.ok === true && r.body.leadId, 'with a reason it unlocks and makes a lead');

    const lead = await db.query(`SELECT id, officer_id, lead_source, name FROM leads WHERE elementix_person_id = $1`, [PID]);
    ok(lead.rows.length === 1 && lead.rows[0].officer_id === officer,
      'the lead is assigned to the officer who pressed the button');
    ok(lead.rows[0].lead_source === 'elementix_skip_trace', 'and is marked as coming from Elementix');

    const aud = await db.query(
      `SELECT detail FROM audit_log WHERE action = 'elementix_skip_trace' AND actor_id = $1 ORDER BY created_at DESC LIMIT 1`, [officer]);
    ok(aud.rows.length === 1 && aud.rows[0].detail.why === 'Calling about a bridge loan',
      'the reason is on the record beside the spend');

    /* THE PRICE, NEVER THE NUMBERS. This route is deliberately unscoped — an
       officer must be able to ask what the next click costs about somebody they
       have not attached to anything yet — so it may only ever answer the COUNT.
       Returning the stored row whole handed any internal officer the phone
       numbers of another officer's borrower, two hops from a name, with no audit
       row behind it. The numbers come from the scoped door, asserted below. */
    r = await call(server, 'GET', `/api/elementix/people/${PID}/contact`, T);
    ok(r.status === 200 && r.body.free === true && r.body.stored && r.body.stored.phoneCount === 1,
      'the cost check says the next click is free, and says how much we hold');
    ok(r.body.stored.phones === undefined && r.body.stored.emails === undefined
       && !JSON.stringify(r.body).includes('9736680701'),
      'and it never carries the contact detail itself — that is what the scoped door is for');

    // A second officer gets their OWN lead, and buys nothing.
    const before = seen.filter((c) => c.tool === 'submit_contact_enrichment').length;
    r = await call(server, 'POST', `/api/elementix/people/${PID}/skip-trace`, T2, { reason: 'Same person, different officer' });
    ok(r.status === 200, 'a second officer may look the same person up');
    ok(seen.filter((c) => c.tool === 'submit_contact_enrichment').length === before,
      'and is NOT charged again — the person is already unlocked');
    const leads2 = await db.query(`SELECT officer_id FROM leads WHERE elementix_person_id = $1 ORDER BY created_at`, [PID]);
    ok(leads2.rows.length === 2 && leads2.rows[1].officer_id === officer2,
      'each officer gets the lead in their OWN pipeline');

    // -----------------------------------------------------------------------
    console.log('\n5. The profile');
    // -----------------------------------------------------------------------
    r = await call(server, 'GET', `/api/elementix/people/${PID}/profile`, T);
    ok(r.status === 200 && r.body.sections.overview.status === 'not_loaded',
      'before anyone asks for it, the profile says it has not been read — not that it is empty');

    r = await call(server, 'POST', `/api/elementix/people/${PID}/profile/build`, T, {});
    ok(r.status === 200 && r.body.ok === true && r.body.profile, 'Run a search builds it and hands back the profile');
    ok(r.body.profile.summary.counts.mortgages === 349 && r.body.profile.summary.counts.entities === 295,
      'with the vendor’s own headline numbers on it');
    ok(r.body.profile.sections.lender_network.rows.length === 1, 'and the lenders came through');

    r = await call(server, 'GET', `/api/elementix/people/${PID}/aliases`, T);
    ok(r.status === 200 && r.body.candidates.length === 1 && r.body.candidates[0].personId === PID2,
      'the other state is offered as a candidate, not merged');

    r = await call(server, 'POST', `/api/elementix/people/${PID}/aliases/${PID2}`, T, { confirm: true });
    ok(r.status === 200 && r.body.confirmed === true, 'an officer can say it is the same person');
    r = await call(server, 'GET', `/api/elementix/people/${PID}/profile`, T);
    ok(r.status === 200 && r.body.family.length === 2, 'and the profile becomes one profile over two states');

    // -----------------------------------------------------------------------
    console.log('\n6. Linking a person to what we already hold');
    // -----------------------------------------------------------------------
    const leadId = lead.rows[0].id;
    r = await call(server, 'POST', '/api/elementix/link', T, { kind: 'lead', recordId: leadId, personId: PID2 });
    ok(r.status === 200 && r.body.personId === PID,
      'a link somebody already made is not quietly replaced by a later guess');
    r = await call(server, 'POST', '/api/elementix/link', T, { kind: 'lead', recordId: leadId, personId: PID2, replace: true });
    ok(r.status === 200 && r.body.personId === PID2, 'saying replace explicitly does change it');
    await call(server, 'POST', '/api/elementix/link', T, { kind: 'lead', recordId: leadId, personId: PID, replace: true });

    r = await call(server, 'GET', `/api/elementix/for/lead/${leadId}`, T);
    ok(r.status === 200 && r.body.linked === true && r.body.profile && r.body.profile.summary.counts.mortgages === 349,
      'opening the lead brings its Elementix profile with it');

    r = await call(server, 'GET', '/api/elementix/for/borrower/' + leadId, T);
    ok(r.status === 404, 'a lead id is not a borrower id');

    /* THE THROTTLE IS KEYED ON THE PERSON, AND IT FAILS OPEN WITH NO KEY.
       `keyedRateLimit` lets a request through when its key resolves to nothing —
       correct, because refusing a request it cannot identify would be worse —
       which means the whole per-officer limit disappears the day somebody mounts
       it above `requireAuth`, silently, with every behavioural test still green.
       The order is the invariant, so the order is what is asserted. */
    {
      const src = require('fs').readFileSync(
        require('path').join(__dirname, '../src/routes/elementix-crm.js'), 'utf8');
      const auth = src.indexOf('router.use(requireAuth');
      const limit = src.indexOf('router.use(keyedRateLimit');
      ok(auth > -1 && limit > -1 && auth < limit,
        'the per-officer throttle is mounted AFTER requireAuth — without an actor it would not throttle at all');
    }

    // -----------------------------------------------------------------------
    console.log('\n7. A record belongs to somebody, and it is not everybody');
    // -----------------------------------------------------------------------
    // Being signed in as internal staff opens the DOOR of this desk; it is not
    // permission to reach into any lead or borrower in the company by typing an
    // id. Without a per-record check, one officer could overwrite the Elementix
    // person another officer attached to their own lead, and anybody could read
    // a borrower's whole merged profile — every property, loan and company.
    r = await call(server, 'GET', `/api/elementix/for/lead/${leadId}`, T2);
    ok(r.status === 403, 'another officer cannot read the Elementix profile hanging off somebody else\'s lead');
    r = await call(server, 'POST', '/api/elementix/link', T2, { kind: 'lead', recordId: leadId, personId: PID2, replace: true });
    ok(r.status === 403, 'and cannot overwrite the person attached to it');
    const stillMine = await db.query(`SELECT elementix_person_id FROM leads WHERE id = $1`, [leadId]);
    ok(stillMine.rows[0].elementix_person_id === PID, 'the refusal wrote nothing');

    r = await call(server, 'GET', `/api/elementix/for/lead/${leadId}`, TA);
    ok(r.status === 200, 'an admin, who already sees every file, still sees it');

    const bMine = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email, primary_officer_id)
       VALUES ('Elx','Borrower',$1::citext,$2) RETURNING id`, [mail('elxb'), officer])).rows[0].id;
    r = await call(server, 'GET', `/api/elementix/for/borrower/${bMine}`, T);
    ok(r.status === 200 && r.body.linked === false, 'the officer who owns the borrower reaches their record');
    r = await call(server, 'GET', `/api/elementix/for/borrower/${bMine}`, T2);
    ok(r.status === 403, 'an officer with no relationship to that borrower is refused');
    r = await call(server, 'GET', '/api/elementix/for/borrower/11111111-1111-4111-8111-111111111111', T);
    ok(r.status === 404, 'and a record that does not exist says so, rather than "not yours"');

    /* THE PROFILE DOORS ARE SCOPED TOO — and this is the pair that was open.
       `/for` refusing means nothing while `/people/:id/profile` will hand the
       same merged record to anybody, and `/profile/build` is the most expensive
       button on the plane: forty calls out of the allowance the whole company
       shares, fired at a person the caller has no relationship with. "Seen"
       therefore has to mean "seen BY YOU", through the same shared fragments. */
    /* A person only THIS officer has a relationship with. PID will not do — the
       second officer looked that one up themselves earlier and has their own
       lead on them, which is a real relationship and must keep working. */
    const PID_MINE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await db.query(`DELETE FROM leads WHERE elementix_person_id = $1`, [PID_MINE]);
    await db.query(`DELETE FROM elementix_persons WHERE person_id = $1`, [PID_MINE]);
    await db.query(
      `INSERT INTO elementix_persons (person_id, display_name, primary_state)
       VALUES ($1,'Mine Only','NJ') ON CONFLICT (person_id) DO NOTHING`, [PID_MINE]);
    await db.query(
      `INSERT INTO leads (tool, name, officer_id, source, status, elementix_person_id)
       VALUES ('elementix','Mine Only',$1::uuid,'elementix','new',$2)`, [officer, PID_MINE]);

    r = await call(server, 'GET', `/api/elementix/people/${PID_MINE}/profile`, T);
    ok(r.status === 200, 'the officer whose lead carries the person reads their profile');
    r = await call(server, 'GET', `/api/elementix/people/${PID_MINE}/profile`, T2);
    ok(r.status === 404, 'an officer with no relationship to that record cannot read the profile');
    const callsBefore = Number((await db.query(
      `SELECT count(*)::int AS n FROM elementix_calls WHERE staff_id = $1`, [officer2])).rows[0].n);
    r = await call(server, 'POST', `/api/elementix/people/${PID_MINE}/profile/build`, T2, { force: true });
    ok(r.status === 404, 'and cannot spend the company\'s allowance building it');
    const callsAfter = Number((await db.query(
      `SELECT count(*)::int AS n FROM elementix_calls WHERE staff_id = $1`, [officer2])).rows[0].n);
    ok(callsAfter === callsBefore, 'the refusal made no vendor call at all');
    r = await call(server, 'GET', `/api/elementix/people/${PID}/profile`, T2);
    ok(r.status === 200, 'but an officer who looked the person up themselves still reads theirs');
    r = await call(server, 'GET', `/api/elementix/people/${PID_MINE}/profile`, TA);
    ok(r.status === 200, 'an admin who sees every file still reads it');

    // -----------------------------------------------------------------------
    console.log('\n8. Does the next click cost money?');
    // -----------------------------------------------------------------------
    // The screen must not have to work this out from the shape of the row it
    // gets back — it asks, and the answer is a plain boolean.
    r = await call(server, 'GET', `/api/elementix/people/${PID}/contact`, T);
    ok(r.status === 200 && r.body.free === true && r.body.freeReason === 'already_stored',
      'a person whose details we already hold is free, answered from our own database');
    ok(r.body.stored && r.body.stored.person_id === PID,
      'and the stored row names the person it is about');
    const askedBefore = seen.filter((c) => c.tool === 'get_contact_status').length;
    await call(server, 'GET', `/api/elementix/people/${PID}/contact`, T);
    ok(seen.filter((c) => c.tool === 'get_contact_status').length === askedBefore,
      'and Elementix is not asked at all — a contact we own is proof we already paid');

    statusDown = true;
    r = await call(server, 'GET', `/api/elementix/people/${PID2}/contact`, T);
    statusDown = false;
    ok(r.status === 200 && r.body.statusKnown === false && r.body.free === false
       && r.body.statusProblem && /reach/i.test(r.body.statusProblem.detail),
      'a vendor that cannot be asked is SAID so, never answered as a confident "nobody has unlocked them"');

    searchLimit = 1;
    r = await call(server, 'GET', '/api/elementix/search?q=Moty%20Brisk', T);
    ok(r.status === 200 && r.body.truncated === true && r.body.resultLimit === 1,
      'a full page is reported as a cut-off list, from the vendor\'s OWN stated limit');
    searchLimit = 20;
    r = await call(server, 'GET', '/api/elementix/search?q=Moty%20Brisk', T);
    ok(r.status === 200 && r.body.truncated === false, 'and a short page is not');
    searchLimit = null;
    r = await call(server, 'GET', '/api/elementix/search?q=Moty%20Brisk', T);
    ok(r.status === 200 && r.body.truncated === false && r.body.resultLimit === null,
      'with no stated limit nothing is claimed either way — never a hand-typed 20');

    // -----------------------------------------------------------------------
    console.log('\n9. Two records that exist, or nothing happens');
    // -----------------------------------------------------------------------
    // A sentinel no other suite uses — the profile suite already owns the 9999…
    // range, and a person another test legitimately created would make this
    // guard PASS its gate for the wrong reason.
    const GHOST = '0badf00d-dead-4bee-8fee-000000000001';
    await db.query(`DELETE FROM elementix_person_aliases WHERE alias_person_id = $1`, [GHOST]);
    await db.query(`DELETE FROM elementix_persons WHERE person_id = $1`, [GHOST]);
    r = await call(server, 'POST', `/api/elementix/people/${PID}/aliases/${GHOST}`, T, { confirm: true });
    ok(r.status === 404, 'a person PILOT has never seen cannot be joined onto a real one');
    const ghost = await db.query(`SELECT 1 FROM elementix_persons WHERE person_id = $1`, [GHOST]);
    ok(ghost.rowCount === 0, 'and no phantom record was created by asking');

    // -----------------------------------------------------------------------
    console.log('\n10. The expensive doors refuse a person nobody has seen');
    // -----------------------------------------------------------------------
    // "Add them to my leads" cannot spend a credit, so a locked person costs
    // nothing DIRECTLY — but it records the trace as pending, and the settle
    // pass then polls that person every couple of minutes for 48 hours out of
    // an allowance the whole organisation shares.
    const LOCKED = '0badf00d-dead-4bee-8fee-000000000002';
    // A LINK NOW COUNTS AS "PILOT has seen them", so the sentinel has to start
    // genuinely unseen — including on a lead a previous run left pointing at it.
    await db.query(`UPDATE leads SET elementix_person_id = NULL WHERE elementix_person_id = $1`, [LOCKED]);
    await db.query(`UPDATE borrowers SET elementix_person_id = NULL WHERE elementix_person_id = $1`, [LOCKED]);
    await db.query(`DELETE FROM elementix_skip_traces WHERE person_id = $1`, [LOCKED]);
    await db.query(`DELETE FROM elementix_person_sections WHERE person_id = $1`, [LOCKED]);
    await db.query(`DELETE FROM elementix_persons WHERE person_id = $1`, [LOCKED]);
    r = await call(server, 'POST', `/api/elementix/people/${LOCKED}/lead`, T, {});
    ok(r.status === 409 && /look/i.test(r.body.error),
      'adding a lead for somebody nobody has unlocked is refused, and says which button does it');
    const seeded = await db.query(
      `SELECT count(*)::int n FROM elementix_skip_traces WHERE person_id = $1`, [LOCKED]);
    ok(seeded.rows[0].n === 0, 'and nothing was queued for the settle pass to poll for two days');

    // Building a profile is the most expensive button here — up to forty calls.
    r = await call(server, 'POST', `/api/elementix/people/${LOCKED}/profile/build`, T, {});
    ok(r.status === 404, 'and a profile is not built for an id PILOT has never seen');
    const phantom = await db.query(`SELECT 1 FROM elementix_persons WHERE person_id = $1`, [LOCKED]);
    ok(phantom.rowCount === 0, 'no nameless phantom person was created by asking');

    // The real flow still works: attach first, then build.
    r = await call(server, 'POST', '/api/elementix/link', T, { kind: 'lead', recordId: leadId, personId: LOCKED, name: 'Attached First', state: 'NJ', replace: true });
    ok(r.status === 200, 'attaching a person from a search result works as before');
    r = await call(server, 'POST', `/api/elementix/people/${LOCKED}/profile/build`, T, {});
    ok(r.status === 200, '…and the profile builds once they are attached — the real order of events');

    // A LINK IS PROOF ON ITS OWN. `leads.elementix_person_id` carries no foreign
    // key, so a link can outlive the header row it points at — and the button
    // must not dead-end on a record somebody is looking straight at.
    await db.query(`DELETE FROM elementix_person_sections WHERE person_id = $1`, [LOCKED]);
    await db.query(`DELETE FROM elementix_persons WHERE person_id = $1`, [LOCKED]);
    r = await call(server, 'POST', `/api/elementix/people/${LOCKED}/profile/build`, T, {});
    ok(r.status === 200, 'a person attached to a lead can be read even with no header row of their own');
    await call(server, 'POST', '/api/elementix/link', T, { kind: 'lead', recordId: leadId, personId: PID, replace: true });

    // -----------------------------------------------------------------------
    console.log('\n11. The desk says the import is running by itself');
    // -----------------------------------------------------------------------
    // "Still to do: 800" with nothing else on the screen reads as stuck. An
    // owner who has just switched the automatic import on needs to SEE it
    // working, and the cadence has to be the timer's own rather than a number
    // retyped on the screen.
    r = await call(server, 'GET', '/api/elementix/backfill', TA);
    ok(r.status === 200 && r.body.auto && r.body.auto.on === true,
      'the desk is told the automatic import is on');
    const syncMod = require(R + '/src/sync/elementix-crm-sync');
    ok(r.body.auto.perPass === syncMod._internals.WORK_BATCH
       && r.body.auto.everyMinutes === Math.max(1, Math.round(syncMod._internals.WORK_INTERVAL_MS / 60000)),
      '…with the cadence the timer actually uses, not a number typed onto the screen');
    r = await call(server, 'GET', '/api/elementix/backfill', T);
    ok(r.status === 403, 'and the import desk stays behind manage_team');

    // -----------------------------------------------------------------------
    console.log('\n12. Every way to reach them, not the two a lead has room for');
    // -----------------------------------------------------------------------
    // The owner asked twice for "all the phone numbers and their names, all
    // details". A `leads` row has `phone` and `phone_alt` — TWO — and a skip
    // trace routinely buys five, so the rest sat in the database with no screen
    // showing them. The section mounted on the lead AND the borrower carries
    // them now, with the vendor's own words kept rather than translated.
    const many = crm.normalizeContact({ job: { result: {
      phone: [
        { type: 'MOBILE', value: '9736680701', carrier: 'NEW CINGULAR WIRELESS', location: 'SUCCASUNNA, NJ', confidence: 0.9 },
        { type: 'FIXED', value: '9735641002', carrier: 'PEERLESS NETWORK', location: 'MILLBURN, NJ', confidence: 0.7 },
        { type: 'MOBILE', value: '9175551234', carrier: 'VERIZON', confidence: 0.55 },
        { type: 'FIXED', value: '7325559876', carrier: 'COMCAST', confidence: 0.4 },
        { type: 'MOBILE', value: '8485550000', carrier: 'T-MOBILE', confidence: 0.35 } ],
      email: [{ value: 'moty@example.com', result: 'deliverable' }, { value: 'm.b@adar-capital.com', result: 'risky' }],
      summary: 'A real estate investor.', company_name: 'Adar Capital', company_domain: 'adar-capital.com',
    } } });
    ok(many.phones.length === 5, 'the reader keeps every number the vendor sent');
    await crm.storeContact({ personId: PID, contact: many, staffId: officer, source: 'pilot_skip_trace',
      raw: { job: { result: { summary: 'A real estate investor.', company_name: 'Adar Capital', company_domain: 'adar-capital.com' } } } });

    r = await call(server, 'GET', `/api/elementix/for/lead/${leadId}`, T);
    const got = r.body.contact;
    ok(r.status === 200 && got && got.phones.length === 5,
      'and the lead is handed all five, not the two its own columns hold');
    ok(got.phones[0].label === 'MOBILE' && got.phones[0].carrier === 'NEW CINGULAR WIRELESS'
       && got.phones[0].confidence === 0.9,
      'each one keeps the vendor’s own label, carrier and confidence — an officer rings the likeliest first');
    ok(got.emails.length === 2 && got.emails.some((e) => e.status === 'risky'),
      'and the emails carry the vendor’s verdict, so a risky one does not look as good as a live one');
    ok(got.profile && got.profile.company === 'Adar Capital',
      'the company and summary are derived on read, so the screen and the reader can never drift');
    ok(got.unlockedByEmail !== undefined && got.refreshedAt,
      'with who looked them up and when, which is the CRM question a month later');

    // -----------------------------------------------------------------------
    console.log('\n13. Every spend is attributable afterwards');
    // -----------------------------------------------------------------------
    // The audit write sits inside a catch that must never break the action, so
    // nothing would say if it silently stopped landing — and "every spend is
    // attributable" is a stated safety property of this whole plane.
    const trail = await db.query(
      `SELECT action, actor_id, entity_type, entity_id, detail
         FROM audit_log
        WHERE entity_type = 'elementix' AND actor_id = $1::uuid
        ORDER BY created_at`, [officer]);
    const acts = trail.rows.map((x) => x.action);
    ok(acts.includes('elementix_skip_trace'), 'the paid lookup is on the file’s audit trail');
    ok(acts.includes('elementix_link_set'), 'so is attaching a person to a record');
    const spend = trail.rows.find((x) => x.action === 'elementix_skip_trace');
    ok(spend && spend.entity_id && spend.detail && typeof spend.detail.why === 'string' && spend.detail.why.length > 3,
      'and the spend records who, about whom, and the reason they typed');

    // -----------------------------------------------------------------------
    console.log('\n14. Every call named the officer who made it');
    // -----------------------------------------------------------------------
    ok(seen.length > 0 && seen.every((c) => !!c.staffId),
      `${seen.length} vendor calls, every one carrying the officer behind it`);

    await db.query(`DELETE FROM borrowers WHERE id = $1`, [bMine]);

    await db.query(`DELETE FROM leads WHERE elementix_person_id = ANY($1)`, [[PID, PID2]]);
    console.log(`\n${pass} checks passed, ${fail} failed.\n`);
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) { /* nothing to close */ }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack); process.exit(1); });
