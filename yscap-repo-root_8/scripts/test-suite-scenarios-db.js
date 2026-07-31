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

/* A SOCIAL NEVER ENTERS THIS TABLE (pre-merge audit, 2026-07-30).
   The Loan Application tool's b1Ssn..b4Ssn are ordinary id'd inputs with no
   data-noshare, so the shared collector picks them up — and this feature would have
   written them to jsonb in clear text, which is the exact thing redact.js exists to
   stop everywhere else in this system. The scrub reuses redact.js's own pattern. */
console.log('\n--- a Social Security number can never be stored in a scenario ---');
{
  const REAL_SSN_FIELDS = ['b1Ssn', 'b2Ssn', 'b3Ssn', 'b4Ssn'];
  const v = { };
  for (const f of REAL_SSN_FIELDS) v[f] = '123-45-6789';
  v.b1Dob = '1980-01-01'; v.eEin = '12-3456789'; v.price = '400000';
  const out = S.validateSave({ toolSlug: 'loan-application', name: 'x', state: { v } });
  assert(out.ok, 'the save is still accepted — the scenario is kept, only the number is dropped');
  for (const f of REAL_SSN_FIELDS) {
    assert(out.value.state.v[f] === undefined, `${f} — the REAL Loan Application field id — is stripped`);
  }
  assert(out.value.removed.length === REAL_SSN_FIELDS.length,
    `the strip is reported, never silent (removed ${JSON.stringify(out.value.removed)})`);
  assert(out.value.state.v.price === '400000', 'everything that is not a social is untouched');
  assert(JSON.stringify({ v }).includes('123-45-6789'),
    'the CALLER\'s object is not mutated — the scrub returns a copy');
}
{
  // nested and inside arrays, because a tool state is not always one flat level
  const out = S.validateSave({ toolSlug: 'loan-application', name: 'x',
    state: { v: { ok: '1' }, rows: [{ b1Ssn: '111-22-3333', addr: '12 Oak' }], deep: { deeper: { ssn: '9' } } } });
  assert(JSON.stringify(out.value.state).includes('111-22-3333') === false, 'a social inside an ARRAY row is stripped');
  assert(out.value.state.deep.deeper.ssn === undefined, 'a social nested three levels down is stripped');
  assert(out.value.state.rows[0].addr === '12 Oak', 'the rest of the row survives');
}
{
  // the CLIENT strips too, so the number never travels. The two patterns must agree
  // on the real field names or one side would ship what the other refuses.
  const client = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'lib', 'tool-scenario-state.js'), 'utf8');
  const m = /const SSN_KEY = (\/.*\/i);/.exec(client);
  assert(!!m, 'the client carries its own copy of the social pattern');
  const clientRe = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), 'i');
  const serverRe = require('../src/lib/redact').SSN_KEY;
  for (const f of ['b1Ssn', 'b4Ssn', 'ssn', 'borrower_ssn', 'socialSecurityNumber']) {
    assert(clientRe.test(f) && serverRe.test(f), `client and server both treat "${f}" as a social`);
  }
  for (const f of ['price', 'assn', 'lessonPlan', 'b1Dob']) {
    assert(!clientRe.test(f) && !serverRe.test(f), `neither side over-matches "${f}"`);
  }
}

/* THE SANITY CHECK OWN_STATE_TOOLS WAS DOCUMENTED AS DOING — it was described and
   never implemented (pre-merge audit). A 'suite' blob for one of these two tools
   means the client's own-state read failed and it fell back, so the line items /
   project rows are already gone. Storing that hands the staffer a "Saved" that has
   silently lost their work; refusing costs them one retry. */
console.log('\n--- an own-state tool refuses a flat-collector blob ---');
for (const slug of S.OWN_STATE_TOOLS) {
  const bad = S.validateSave({ toolSlug: slug, name: 'x', state: { v: { a: '1' } }, stateKind: 'suite' });
  assert(bad.error === 'tool_not_ready', `${slug} refuses a 'suite' blob rather than storing a hollow scenario`);
  assert(/loading/i.test(bad.detail || ''), `${slug}'s refusal tells the staffer what to do about it`);
  const good = S.validateSave({ toolSlug: slug, name: 'x', state: { items: [] }, stateKind: 'own' });
  assert(good.ok, `${slug} still accepts its OWN shape`);
}
assert(S.validateSave({ toolSlug: 'term-sheet', name: 'x', state: {}, stateKind: 'suite' }).ok,
  'the other nine tools are unaffected — the shared collector is correct for them');

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
  /* A PASSWORD IS NEVER PART OF A STATE. The admin zone is unlocked by typing into
     #tsAdminPw, which carries data-noshare like every other admin field — so the
     moment the includeNoShare opt-in was added for saved scenarios it would have
     swept the ADMIN PASSWORD into the blob and written it to the database in clear
     text. The skip is checked BEFORE the opt-in so no caller can ever ask for it. */
  assert(/if \(inp\.type === "password"\) return;/.test(suite),
    'a password input is skipped unconditionally, before the opt-in is even considered');
  {
    const pwSkip = suite.indexOf('inp.type === "password"');
    const optIn = suite.indexOf('!keepPrivate && inp.hasAttribute');
    assert(pwSkip > 0 && optIn > 0 && pwSkip < optIn,
      'the password skip comes BEFORE the opt-in, so includeNoShare can never reach it');
  }
  const shareCalls = [...suite.matchAll(/encodeState\(collectState\(([^)]*)\)\)/g)].map((m) => m[1].trim());
  assert(shareCalls.length >= 2 && shareCalls.every((a) => a === ''),
    `every share/URL path calls collectState with NO argument, so links never carry admin knobs (found ${shareCalls.length})`);
}

/* ===================================================================== *
 * 3. THE REAL DOORS (DB + HTTP)
 * ===================================================================== */
(async () => {
  /* THE ADAPTER MUST REFUSE, NOT DEGRADE (pre-merge audit, 2026-07-30).
     The first cut wrapped the own-state read in a catch that fell through to the
     shared collector. A Rehab Budget whose reader threw would then have been saved
     as a 'suite' blob with the line items GONE, and the screen still said "Saved" —
     the precise silent loss the kind field exists to prevent. Exercised for real
     against fake tool windows, not asserted from the source text. */
  console.log('\n--- the state adapter refuses a tool it cannot read properly ---');
  try {
    const mod = await import('../app-v2/src/lib/tool-scenario-state.js');
    const suiteWin = { YS: { collectState: () => ({ v: { a: '1' } }) } };
    const healthy = { RB: { getState: () => ({ items: [{ name: 'White oak' }] }), setState() {} }, YS: suiteWin.YS };
    const throwing = { RB: { getState: () => { throw new Error('boom'); }, setState() {} }, YS: suiteWin.YS };
    const nullish = { TR: { snap: () => null, setState() {} }, YS: suiteWin.YS };

    const a = mod.readToolState(healthy);
    assert(a && a.kind === 'own' && a.state.items[0].name === 'White oak',
      'a healthy own-state tool is read through its own accessor');
    const b = mod.readToolState(throwing);
    assert(b === null, 'a THROWING own-state reader returns null — it never degrades to the flat collector');
    const c = mod.readToolState(nullish);
    assert(c === null, 'an own-state reader that hands back nothing also refuses');
    const d = mod.readToolState(suiteWin);
    assert(d && d.kind === 'suite', 'a tool with no own accessor still uses the shared collector');

    // and the social never leaves the browser either
    const withSsn = { YS: { collectState: () => ({ v: { b1Ssn: '123-45-6789', price: '400000' } }) } };
    const e = mod.readToolState(withSsn);
    assert(e.state.v.b1Ssn === undefined && e.state.v.price === '400000',
      'the client drops the social before it is ever sent');
    assert(mod.toolHasOwnState(healthy) === true && mod.toolHasOwnState(suiteWin) === false,
      'toolHasOwnState agrees with the reader about which tools carry their own state');

    /* THE SIDE THAT DROPS THE NUMBER IS THE SIDE THAT REPORTS IT (re-audit
       2026-07-30). The bar used to read only the SERVER's `omittedSensitive` — but
       the client strips FIRST, so on every real save from the screen the server saw
       no social, answered false, and the promised "you'll re-enter those" message
       could never appear (proven in a real browser: a Loan Application with two
       socials saved with a bare "Saved."). The reader now reports what IT dropped. */
    assert(e.omittedSensitive === true,
      'the reader REPORTS the strip, so the bar can tell the staffer why the box will be empty');
    const clean = mod.readToolState({ YS: { collectState: () => ({ v: { price: '400000' } }) } });
    assert(clean.omittedSensitive === false, 'a scenario with no social does not claim one was removed');
    const ownSsn = mod.readToolState({ RB: { getState: () => ({ items: [], b1Ssn: 'x' }), setState() {} } });
    assert(ownSsn.omittedSensitive === true, 'an OWN-state read reports its strip too');
    const bar = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'components', 'ToolScenarioBar.jsx'), 'utf8');
    assert(/read\s*&&\s*read\.omittedSensitive/.test(bar),
      'and the bar actually consults the READER, not only the server response');
  } catch (e) {
    assert(false, `the adapter could not be exercised: ${e && e.message}`);
  }

/* THE FRAME HANDLE IS PINNED TO A GENERATION, NOT ONLY A SLUG (re-audit 2026-07-30).
   The slug pin closes "open tool A, open tool B, save before B boots". It does NOT
   close "open tool A, go back, open tool A AGAIN" — the slug matches, so the pin
   handed back the PREVIOUS, torn-down window. Measured in a real browser: the row
   that landed in Postgres carried the FIRST frame's line items. Asserted from the
   source because the behaviour needs a browser; the browser proof is in the audit. */
console.log('\n--- the frame handle cannot survive a reopen of the same tool ---');
{
  const screen = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'screens', 'StaffInvestorSuite.jsx'), 'utf8');
  assert(/const genRef = useRef\(0\)/.test(screen), 'the screen keeps a generation counter for the frame handle');
  assert(/held\.gen === genRef\.current/.test(screen), 'and winFor refuses a handle from an older generation');
  assert(/genRef\.current \+= 1/.test(screen), 'the generation is bumped when the open tool changes');
  const stray = screen.match(/setOpen\(/g) || [];
  assert(stray.length === 1,
    `setOpen is called in exactly ONE place (showTool) so no path can change tools without invalidating the handle (found ${stray.length})`);
  assert(/onReady=\{\(win\) => \{ winRef\.current = \{ gen,/.test(screen),
    'onReady stamps the generation captured at RENDER time, so a late onReady from the old frame is ignored');
}

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

    /* ---- NO SOCIAL REACHES THE TABLE, through EITHER door ----
       The client strips too, but the server is the guarantee: this posts the number
       straight at the API the way a hand-rolled request would, then reads it back
       out of POSTGRES rather than trusting the response. */
    {
      const SSN = '123-45-6789';
      const withSsn = await call('POST', '/api/staff/tool-scenarios', aTok, {
        toolSlug: 'loan-application', name: 'Kamara app',
        state: { v: { b1Ssn: SSN, b2Ssn: SSN, b1Dob: '1980-01-01', price: '400000' } },
      });
      assert(withSsn.status === 201, `a loan-application scenario still saves (${withSsn.status})`);
      assert(withSsn.body.omittedSensitive === true,
        'the response SAYS a social was dropped, so the screen can tell the staffer');
      const laId = withSsn.body.scenario.id;
      const raw = await db.query('SELECT state::text AS s FROM staff_tool_scenarios WHERE id = $1', [laId]);
      assert(!raw.rows[0].s.includes(SSN), 'the number is NOT in the stored jsonb — read straight from Postgres');
      assert(!raw.rows[0].s.includes('b1Ssn') && !raw.rows[0].s.includes('b2Ssn'), 'neither social FIELD survives');
      assert(raw.rows[0].s.includes('400000'), 'the rest of the application is stored exactly as sent');

      // the UPDATE door is the second way in and must not be the unguarded one
      const put = await call('PUT', `/api/staff/tool-scenarios/${laId}`, aTok,
        { state: { v: { b3Ssn: SSN, price: '500000' } } });
      assert(put.status === 200 && put.body.omittedSensitive === true, `the rename/update door scrubs too (${put.status})`);
      const raw2 = await db.query('SELECT state::text AS s FROM staff_tool_scenarios WHERE id = $1', [laId]);
      assert(!raw2.rows[0].s.includes(SSN) && raw2.rows[0].s.includes('500000'),
        'an UPDATE cannot smuggle a social in either');

      // a clean save does not claim a strip happened
      const clean = await call('POST', '/api/staff/tool-scenarios', aTok,
        { toolSlug: 'qualifier-pro', name: 'Clean', state: { v: { fico: '720' } } });
      assert(clean.body.omittedSensitive === false, 'a scenario with no social does not claim one was removed');
    }

    /* ---- an own-state tool cannot store a hollow scenario ---- */
    {
      const hollow = await call('POST', '/api/staff/tool-scenarios', aTok,
        { toolSlug: 'rehab-budget', name: 'Hollow', state: { v: { a: '1' } }, stateKind: 'suite' });
      assert(hollow.status === 400 && hollow.body.error === 'tool_not_ready',
        `the door refuses a flat blob for Rehab Budget (${hollow.status} ${hollow.body && hollow.body.error})`);
      const real = await call('POST', '/api/staff/tool-scenarios', aTok,
        { toolSlug: 'rehab-budget', name: 'Real', state: { items: [{ name: 'White oak', amt: 100 }] }, stateKind: 'own' });
      assert(real.status === 201, 'its own shape still saves');
      const back = await call('GET', `/api/staff/tool-scenarios/${real.body.scenario.id}`, aTok);
      assert(back.body.scenario.state.items[0].name === 'White oak' && back.body.scenario.stateKind === 'own',
        'and the line items come back with the kind that produced them');
    }

    /* ---- the badge count comes from the database, not the capped page ---- */
    {
      const listed = await call('GET', '/api/staff/tool-scenarios', aTok);
      assert(listed.body.truncated === false, 'a normal list reports that nothing was cut');
      const dbCount = await db.query(
        `SELECT COUNT(*)::int AS n FROM staff_tool_scenarios WHERE staff_user_id = $1 AND tool_slug = 'term-sheet'`,
        [alice.id]);
      assert(listed.body.counts['term-sheet'] === dbCount.rows[0].n,
        `the badge equals the real row count (${listed.body.counts['term-sheet']} vs ${dbCount.rows[0].n})`);
    }

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
