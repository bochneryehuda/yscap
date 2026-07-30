'use strict';
/**
 * STAFF SAVED SCENARIOS — the rules, the slug parity, and the real HTTP doors.
 *
 * Owner-directed 2026-07-30: a staffer prices a deal in an Investor Suite tool,
 * names it, and picks it up later. A scenario is that staffer's PRIVATE scratchpad —
 * not attached to a loan file, unable to register or price one.
 *
 * The pure half needs nothing. The DB half boots the real server and drives the real
 * routes with real staff tokens, because the whole point of this table is that one
 * staffer can never reach another's work — and that is a property of the SQL, not of
 * a helper somebody could forget to call.
 *
 * Run: node scripts/test-suite-scenarios-db.js
 */
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'src', 'lib', 'suite-scenarios.js'));

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* ===================================================================== *
 * 1. THE RULES (pure)
 * ===================================================================== */
console.log('--- the rules ---');
assert(S.TOOL_SLUGS.length === 11, `eleven suite tools are savable (got ${S.TOOL_SLUGS.length})`);
assert(S.validateSave({ toolSlug: 'nope', name: 'x', state: {} }).error === 'unknown_tool',
  'a slug that is not a suite tool is refused');
assert(S.validateSave({ toolSlug: 'term-sheet', name: '   ', state: {} }).error === 'name_required',
  'a blank name is refused — the list is unusable without one');
assert(S.validateSave({ toolSlug: 'term-sheet', name: 'x', state: [] }).error === 'state_required',
  'an ARRAY is refused: neither accessor ever returns one, and it would fail on the way back out');
assert(S.validateSave({ toolSlug: 'term-sheet', name: 'x', state: 'str' }).error === 'state_required',
  'a string state is refused');
assert(S.validateSave({ toolSlug: 'term-sheet', name: 'x', state: {}, stateKind: 'zzz' }).error === 'bad_state_kind',
  'an unrecognized state kind is refused rather than stored and puzzled over later');
{
  const ok = S.validateSave({ toolSlug: 'term-sheet', name: '  12   Oak  St  ', state: { v: { a: '1' } } });
  assert(ok.ok && ok.value.name === '12 Oak St', `the name is tidied, not rejected (got ${JSON.stringify(ok.value.name)})`);
  assert(ok.value.stateKind === 'suite', 'the shared collector is the default kind');
}
assert(S.validateSave({ toolSlug: 'term-sheet', name: 'x'.repeat(400), state: {} }).value.name.length === S.NAME_MAX,
  `an over-long name is clipped to ${S.NAME_MAX}, not refused`);
{
  const huge = { v: {} };
  for (let i = 0; i < 40000; i++) huge.v['f' + i] = 'xxxxxxxxxx';
  assert(S.validateSave({ toolSlug: 'term-sheet', name: 'big', state: huge }).error === 'state_too_large',
    'a runaway state is refused so one scenario cannot fill the table');
}
{
  const circular = {}; circular.self = circular;
  assert(S.stateTooBig(circular) === true, 'an unserializable state fails CLOSED (refused, not stored)');
}

/* ===================================================================== *
 * 2. SLUG PARITY WITH THE SCREEN — the drift that would silently lose work.
 * A slug the screen offers but the server refuses = a Save button that 400s.
 * A slug the server allows but the screen dropped = rows nothing can reopen.
 * ===================================================================== */
console.log('\n--- slug parity with the Investor Suite screen ---');
{
  const screen = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'screens', 'StaffInvestorSuite.jsx'), 'utf8');
  const block = screen.slice(screen.indexOf('const GROUPS'), screen.indexOf('const TOOL_BASE'));
  const onScreen = [...block.matchAll(/slug:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert(onScreen.length > 0, `the screen's tool list was read (${onScreen.length} tools)`);
  const missingOnServer = onScreen.filter((s) => !S.TOOL_SLUGS.includes(s));
  const missingOnScreen = S.TOOL_SLUGS.filter((s) => !onScreen.includes(s));
  assert(missingOnServer.length === 0, `every tool the screen offers can be saved (missing: ${missingOnServer.join(', ') || 'none'})`);
  assert(missingOnScreen.length === 0, `the server allows no slug the screen dropped (orphans: ${missingOnScreen.join(', ') || 'none'})`);
}

/* The two tools whose data the generic collector would silently drop must still
   expose their own accessor — if one ever stops, its scenarios lose their rows. */
console.log('\n--- the two own-state tools still expose their accessors ---');
for (const [slug, global] of [['rehab-budget', 'RB'], ['track-record', 'TR']]) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'v2', 'tools', `${slug}.js`), 'utf8');
  /* The two do NOT name the reader the same way — Rehab Budget publishes
     getState(), Track Record publishes snap()/_state(). The adapter probes all
     three, so the contract to hold is "a reader AND setState", not one name. */
  const reader = ['getState', 'snap', '_state'].find((fn) => new RegExp(`${fn}\\s*[:(]`).test(src));
  assert(new RegExp(`window\\.${global}\\s*=`).test(src) && !!reader && /setState/.test(src),
    `${slug} still exposes window.${global} with a reader (${reader || 'NONE'}) and setState — its rows ride on it`);
  assert(S.OWN_STATE_TOOLS.includes(slug), `${slug} is recorded as an own-state tool`);
}

/* The share contract must survive: a saved scenario opts IN to the admin knobs,
   but every SHARE path must still leave them out. */
console.log('\n--- the share-link guarantee is intact ---');
{
  const suite = fs.readFileSync(path.join(__dirname, '..', 'web', 'v2', 'suite.js'), 'utf8');
  assert(/function collectState\(opts\)/.test(suite), 'collectState takes an explicit opt-in');
  assert(/!keepPrivate && inp\.hasAttribute\("data-noshare"\)/.test(suite),
    'without the opt-in, data-noshare fields are still skipped');
  const shareCalls = [...suite.matchAll(/encodeState\(collectState\(([^)]*)\)\)/g)].map((m) => m[1].trim());
  assert(shareCalls.length >= 2 && shareCalls.every((a) => a === ''),
    `every share/URL path calls collectState with NO argument, so links never carry admin knobs (found ${shareCalls.length})`);
}

/* ===================================================================== *
 * 3. THE REAL DOORS (DB + HTTP)
 * ===================================================================== */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\nSKIP the HTTP half — no DATABASE_URL');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL suite-scenario assertions passed');
    process.exit(failures ? 1 : 0);
  }
  const db = require('../src/db');
  const crypto = require('../src/lib/crypto');
  const server = require('../src/server');
  let srv = null; const madeStaff = [];
  try {
    console.log('\n--- the real HTTP doors ---');
    const sfx = Math.random().toString(36).slice(2, 8);
    const mk = async (name, role) => {
      const r = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, password_hash)
              VALUES ($1,$2,$3,true,'x') RETURNING id, token_version`,
        [`scen-${sfx}-${name}@test.local`, name, role]);
      madeStaff.push(r.rows[0].id); return r.rows[0];
    };
    const alice = await mk('Alice', 'loan_officer');
    const bob = await mk('Bob', 'loan_officer');
    const tok = (u, role) => crypto.signJwt(
      { sub: u.id, kind: 'staff', role, tv: u.token_version || 0, sid: `scen-${sfx}-${u.id}` }, 3600);
    const aTok = tok(alice, 'loan_officer'), bTok = tok(bob, 'loan_officer');

    srv = server.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = async (m, p, token, body) => {
      const res = await fetch(base + p, {
        method: m,
        headers: Object.assign({ authorization: `Bearer ${token}` }, body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      let j = null; try { j = await res.json(); } catch (_) {}
      return { status: res.status, body: j };
    };

    // save
    const saved = await call('POST', '/api/staff/tool-scenarios', aTok,
      { toolSlug: 'term-sheet', name: '12 Oak St — 85% LTC', state: { v: { price: '400000', tsOrigStd: '2.0' } } });
    assert(saved.status === 201 && saved.body.scenario && saved.body.scenario.id, `a staffer saves a scenario (${saved.status})`);
    const id = saved.body.scenario && saved.body.scenario.id;
    assert(saved.body.scenario && saved.body.scenario.name === '12 Oak St — 85% LTC', 'it comes back with the name they gave');

    // the state round-trips EXACTLY — including the admin knob
    const got = await call('GET', `/api/staff/tool-scenarios/${id}`, aTok);
    assert(got.status === 200 && got.body.scenario.state.v.price === '400000', 'reopening returns the state that was saved');
    assert(got.body.scenario.state.v.tsOrigStd === '2.0',
      'the ADMIN ORIGINATION OVERRIDE survives — a scenario that reopened without it would show a different number than when it was saved');

    // the list shows it, without the heavy state
    const list = await call('GET', '/api/staff/tool-scenarios?tool=term-sheet', aTok);
    assert(list.status === 200 && list.body.scenarios.length === 1, 'it appears in that tool\'s list');
    assert(list.body.scenarios[0].state === undefined, 'the LIST omits the full state (fetched only when opened)');

    // per-tool counts for the grid badge
    await call('POST', '/api/staff/tool-scenarios', aTok, { toolSlug: 'flip-analyzer', name: 'Flip A', state: { v: { x: '1' } } });
    const all = await call('GET', '/api/staff/tool-scenarios', aTok);
    assert(all.body.counts['term-sheet'] === 1 && all.body.counts['flip-analyzer'] === 1,
      `the grid gets a per-tool count (${JSON.stringify(all.body.counts)})`);

    // re-using a name OVERWRITES rather than piling up rows nobody can tell apart
    const again = await call('POST', '/api/staff/tool-scenarios', aTok,
      { toolSlug: 'term-sheet', name: '12 Oak St — 85% LTC', state: { v: { price: '450000' } } });
    assert(again.status === 201 && again.body.scenario.id === id, 'saving the same name updates the same scenario');
    const after = await call('GET', `/api/staff/tool-scenarios/${id}`, aTok);
    assert(after.body.scenario.state.v.price === '450000', 'and it carries the newer state');
    const stillOne = await call('GET', '/api/staff/tool-scenarios?tool=term-sheet', aTok);
    assert(stillOne.body.scenarios.length === 1, 'no duplicate row was created');

    // the SAME name is fine on a different tool, and for a different staffer
    const otherTool = await call('POST', '/api/staff/tool-scenarios', aTok,
      { toolSlug: 'deal-analyzer', name: '12 Oak St — 85% LTC', state: { v: { y: '2' } } });
    assert(otherTool.status === 201, 'the same name may be reused on a DIFFERENT tool');

    // ---- PRIVACY: Bob can neither read, rename, nor delete Alice's scenario ----
    const bobList = await call('GET', '/api/staff/tool-scenarios', bTok);
    assert(bobList.status === 200 && bobList.body.scenarios.length === 0, 'another staffer sees none of it');
    const bobRead = await call('GET', `/api/staff/tool-scenarios/${id}`, bTok);
    assert(bobRead.status === 404, `another staffer READING it gets 404, not 403 (${bobRead.status}) — a 403 would confirm the id exists`);
    const bobWrite = await call('PUT', `/api/staff/tool-scenarios/${id}`, bTok, { name: 'stolen' });
    assert(bobWrite.status === 404, `another staffer cannot rename it (${bobWrite.status})`);
    const bobDel = await call('DELETE', `/api/staff/tool-scenarios/${id}`, bTok);
    assert(bobDel.status === 404, `another staffer cannot delete it (${bobDel.status})`);
    const intact = await call('GET', `/api/staff/tool-scenarios/${id}`, aTok);
    assert(intact.status === 200 && intact.body.scenario.state.v.price === '450000', 'and the owner\'s scenario is untouched by all of that');

    // rename without a state must not blank the work it names
    const renamed = await call('PUT', `/api/staff/tool-scenarios/${id}`, aTok, { name: 'Renamed only' });
    assert(renamed.status === 200 && renamed.body.scenario.name === 'Renamed only', 'a rename works');
    const keptState = await call('GET', `/api/staff/tool-scenarios/${id}`, aTok);
    assert(keptState.body.scenario.state.v.price === '450000', 'a pure rename does NOT blank the state');

    // garbage id is a 404, never a 500
    const junk = await call('GET', '/api/staff/tool-scenarios/not-a-uuid', aTok);
    assert(junk.status === 404, `a malformed id is a 404, not a crash (${junk.status})`);

    // a bad tool filter is refused
    const badTool = await call('GET', '/api/staff/tool-scenarios?tool=evil', aTok);
    assert(badTool.status === 400, `an unknown tool filter is refused (${badTool.status})`);

    // delete
    const del = await call('DELETE', `/api/staff/tool-scenarios/${id}`, aTok);
    assert(del.status === 200, 'the owner can delete it');
    assert((await call('GET', `/api/staff/tool-scenarios/${id}`, aTok)).status === 404, 'and then it is gone');

    // a scenario is a scratchpad: it carries no application
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='staff_tool_scenarios'`);
    const names = cols.rows.map((r) => r.column_name);
    assert(!names.includes('application_id'),
      'the table deliberately has NO application_id — a scenario can never be mistaken for a real file');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { await db.query(`DELETE FROM staff_tool_scenarios WHERE staff_user_id = ANY($1::uuid[])`, [madeStaff]); } catch (_) {}
    try { await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [madeStaff]); } catch (_) {}
    try { if (srv) srv.close(); } catch (_) {}
  }
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL suite-scenario assertions passed');
  process.exit(failures ? 1 : 0);
})();
