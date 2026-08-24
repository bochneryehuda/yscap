'use strict';
/* PARKING THE TRUSTPOINT INTEGRATION (owner-directed 2026-08-24).
 *
 * The owner, after the phantom-release incident on YSCAP258134629: "park and disable, for
 * now, the entire TrustPoint integration and the TrustPoint screen from our Draw section …
 * It's not telling the truth." And, on what survives: "The only thing it should be when it
 * comes on a Blue Lake draw should be a task and email to our draw coordinator to put it
 * into TrustPoint. Then our draw coordinator is going to put in the details manually about
 * the release and about the approved amount from TrustPoint."
 *
 * So this suite has TWO jobs, and the second is the one that matters most:
 *   1. everything TrustPoint is OFF, and cannot be switched on by accident;
 *   2. the coordinator's task + email and their manual entry are UNTOUCHED. Parking that
 *      by mistake would take the Blue Lake draw workflow down altogether — a far worse
 *      outcome than the bug being parked.
 *
 * WHY PARKED DEFAULTS ON. `TRUSTPOINT_ENABLED` is resolved through `lib/flags`, where a row
 * in `integration_flags` OVERRIDES the environment. So setting the env var to 0 is not proof
 * the integration is off, and that override cannot be read without a staff login. Parking is
 * therefore unconditional and beats both. Section B is what pins that.
 *
 * PURE: no database. The HTTP sections mount the REAL routers with auth stubbed, because a
 * source grep cannot tell a gate that is wired from one that merely exists.
 * Run: node scripts/test-trustpoint-parked.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const eq = (name, got, exp) => {
  if (got === exp) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}\n         got: ${JSON.stringify(got)}\n    expected: ${JSON.stringify(exp)}`); }
};

// ---------------------------------------------------------------- A. the predicate
console.log('\nA. is it parked?');
{
  const { isParked } = require(R + '/src/trustpoint/parked');

  ok('unset → PARKED (the default is off, deliberately)', isParked({}) === true);
  ok('null → PARKED', isParked({ TRUSTPOINT_PARKED: null }) === true);

  // Every spelling an operator might reasonably type to mean "bring it back".
  for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off', ' 0 ', 'NO']) {
    ok(`${JSON.stringify(v)} → un-parked`, isParked({ TRUSTPOINT_PARKED: v }) === false);
  }
  // Anything else keeps it parked — the safe direction while the owner's position is that
  // this integration is not telling the truth. A typo must never revive it.
  for (const v of ['1', 'true', 'yes', 'on', '', 'maybe', 'flase', '00']) {
    ok(`${JSON.stringify(v)} → still PARKED (unrecognised never un-parks)`, isParked({ TRUSTPOINT_PARKED: v }) === true);
  }
}

// ---------------------------------------------------------------- B. it beats the switch
console.log('\nB. parked outranks the switch AND a stored override');
{
  const parked = require(R + '/src/trustpoint/parked');
  const flags = require(R + '/src/lib/flags');
  const switches = require(R + '/src/lib/integrations/switches');
  const client = require(R + '/src/trustpoint/client');

  const prevEnv = process.env.TRUSTPOINT_PARKED;
  const prevKey = process.env.TRUSTPOINT_API_KEY;
  process.env.TRUSTPOINT_API_KEY = 'test-key';   // so `available()` is true and cannot mask the result

  // The worst case for a parked integration: the switch says ON *and* somebody left a stored
  // override saying ON. Both must lose.
  flags._internals.setOverrideForTest('TRUSTPOINT_ENABLED', true);

  delete process.env.TRUSTPOINT_PARKED;                        // parked
  ok('parked: switches.on() is false even with an override set ON', switches.on('TRUSTPOINT_ENABLED') === false);
  ok('parked: client.enabled() is false', client.enabled() === false);
  eq('parked: the page reports it OFF, not "on"', switches.effective('TRUSTPOINT_ENABLED').on, false);
  ok('parked: the page SAYS it is parked', switches.effective('TRUSTPOINT_ENABLED').parked === true);
  ok('parked: and gives a reason a human can read', /parked/i.test(String(switches.effective('TRUSTPOINT_ENABLED').parkedReason || '')));

  // A CONTROL either side, or "false" proves nothing: un-parked, the switch decides again.
  process.env.TRUSTPOINT_PARKED = '0';
  ok('CONTROL un-parked: the stored override is honoured again', switches.on('TRUSTPOINT_ENABLED') === true);
  ok('CONTROL un-parked: the page stops claiming parked', switches.effective('TRUSTPOINT_ENABLED').parked === false);

  // Another integration must not be dragged into this.
  ok('Sitewire is untouched by TrustPoint parking', switches.effective('SITEWIRE_ENABLED').parked === false);

  if (prevEnv === undefined) delete process.env.TRUSTPOINT_PARKED; else process.env.TRUSTPOINT_PARKED = prevEnv;
  if (prevKey === undefined) delete process.env.TRUSTPOINT_API_KEY; else process.env.TRUSTPOINT_API_KEY = prevKey;
  flags._internals.clearOverrideForTest('TRUSTPOINT_ENABLED');
  void parked;
}

// ---------------------------------------------------------------- C. no figure reaches a reader
console.log('\nC. a TrustPoint figure never reaches an email while parked');
{
  const { _internals } = require(R + '/src/sitewire/draw-email-blocks');
  const row = {
    number: 1, requested_cents: 645000, approved_cents: 645000,
    to_disburse_cents: 620000, status: 'APPROVED', disbursed_at: null, fees: null,
  };
  const prev = process.env.TRUSTPOINT_PARKED;

  delete process.env.TRUSTPOINT_PARKED;
  eq('parked: moneyFromTrustpoint states nothing', _internals.moneyFromTrustpoint(row), null);

  // The control matters: without it, a function that always returned null would pass.
  process.env.TRUSTPOINT_PARKED = '0';
  const m = _internals.moneyFromTrustpoint(row);
  ok('CONTROL un-parked: it does state the draw again', m && Number(m.requested_cents) === 645000);

  if (prev === undefined) delete process.env.TRUSTPOINT_PARKED; else process.env.TRUSTPOINT_PARKED = prev;
}

// ---------------------------------------------------------------- D+E. the doors are shut
console.log('\nD+E. the webhook and the whole /api/trustpoint surface refuse');
{
  // Auth is stubbed so the PARKED gate is what is under test, not the login. The routers are
  // the REAL ones — a source grep cannot tell a wired gate from one that merely exists.
  const authPath = require.resolve(R + '/src/auth/index.js');
  const realAuth = require(authPath);
  require.cache[authPath].exports = Object.assign({}, realAuth, {
    requireAuth: (req, _res, next) => { req.actor = { kind: 'staff', id: 'test', role: 'super_admin', perms: {} }; next(); },
    requireStaff: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
  });

  const express = require('express');
  const app = express();
  app.use('/api/trustpoint/webhook', require(R + '/src/routes/trustpoint-webhook'));
  app.use('/api/trustpoint', require(R + '/src/routes/trustpoint'));

  const srv = http.createServer(app);
  const done = new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));

  (async () => {
    await done;
    const base = `http://127.0.0.1:${srv.address().port}`;
    const prev = process.env.TRUSTPOINT_PARKED;
    delete process.env.TRUSTPOINT_PARKED;   // parked

    const hook = await fetch(base + '/api/trustpoint/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'anything' },
      body: JSON.stringify({ event: 'draw.updated', data: { draw_id: '1' } }),
    });
    eq('parked: the webhook is GONE (410), so TrustPoint stops retrying', hook.status, 410);
    const hb = await hook.json().catch(() => ({}));
    eq('...and says why', hb.error, 'trustpoint_parked');

    // THE SCREEN. The panel loads this, does `.catch(() => setOv(null))` and renders nothing
    // on null — so this refusal is what removes the TrustPoint screen from the draw centre.
    const ov = await fetch(base + '/api/trustpoint/files/00000000-0000-0000-0000-000000000000/overview');
    eq('parked: /overview refuses, which hides the draw-centre screen', ov.status, 410);
    const ob = await ov.json().catch(() => ({}));
    ok('...and reports not-linked, the shape the panel already hides on', ob.linked === false);

    if (prev === undefined) delete process.env.TRUSTPOINT_PARKED; else process.env.TRUSTPOINT_PARKED = prev;
    require.cache[authPath].exports = realAuth;
    srv.close();

    finish();
  })().catch((e) => { console.error('D+E CRASHED:', e && e.stack || e); process.exit(1); });
}

// ---------------------------------------------------------------- F. what must SURVIVE
function finish() {
  console.log('\nF. the Blue Lake workflow the owner KEPT is untouched');
  {
    // The coordinator's "enter it in TrustPoint" task + email. If parking ever reached this,
    // Blue Lake draws would stop being worked at all — worse than the bug we are parking.
    const intake = fs.readFileSync(R + '/src/sitewire/trustpoint-intake.js', 'utf8');
    ok('the coordinator task path never loads the TrustPoint client',
      !/require\(['"]\.\.\/trustpoint\/client['"]\)/.test(intake));
    ok('...nor the parked gate — nothing here can switch it off',
      !/trustpoint\/parked/.test(intake));
    ok('...and it still opens the workflow hand-off', /submitItem\(/.test(intake));
    ok('...routed to the draw coordinator', /to[Rr]ole:\s*'draw_coordinator'/.test(intake));
    ok('...and still sends the desk email with the line-by-line table',
      /trustpointImport\(/.test(intake) && /draws@yscapgroup\.com/.test(intake));

    // It is driven off the SITEWIRE reconcile, which TrustPoint parking does not gate.
    const rec = fs.readFileSync(R + '/src/sitewire/reconcile.js', 'utf8');
    ok('and it is still fired from the Sitewire reconcile', /maybeOpenImportTask\(/.test(rec));

    // The coordinator's MANUAL entry — the approved amount per line, and the release — lives
    // on /api/sitewire, which is a different router entirely and is not parked.
    const sw = fs.readFileSync(R + '/src/routes/sitewire.js', 'utf8');
    ok('the manual per-line approve is still on the (unparked) sitewire router',
      /router\.post\('\/requests\/:reqId\/approve'/.test(sw));
    ok('the manual release entry is still there too',
      /router\.post\('\/disbursements'/.test(sw));
    ok('and neither was accidentally gated on parking', !/trustpoint\/parked/.test(sw));
  }

  // ------------------------------------------------------------ G. the page SAYS it is parked
  console.log('\nG. the API Health page shows a parked switch as parked, not as a live control');
  {
    // The server already answers `parked` + `parkedReason`; a screen that ignored them would
    // render "Off · overridden — the hosting default is on" beside a toggle an admin can click,
    // which flips the stored flag and changes nothing. That is the confident wrong answer this
    // whole page exists to prevent, so the RENDERING is pinned here too — a back end alone is
    // not the feature.
    //
    // COMMENTS ARE STRIPPED FIRST: the note explaining this change necessarily says "parked" a
    // dozen times, so a guard that read comments would pass on an explanation alone and would
    // then be "fixed" by deleting the explanation.
    const raw = fs.readFileSync(R + '/app-v2/src/screens/StaffApiHealth.jsx', 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    ok('the switch row reads the server\'s parked verdict', /const\s+parked\s*=\s*!!s\.parked/.test(code));
    ok('a parked switch cannot be toggled', /disabled=\{busy\s*\|\|\s*parked\}/.test(code));
    ok('...and it never renders as ON', /on=\{parked\s*\?\s*false\s*:\s*s\.on\}/.test(code));
    ok('the reason is shown, not just hinted', /s\.parkedReason/.test(code));
    // The "overridden — the hosting default is on" line is TRUE but misleading while parked:
    // it invites a reset that changes nothing. It is suppressed, and the Reset button with it.
    ok('the misleading override line is suppressed while parked', /!parked\s*&&\s*s\.overridden/.test(code));
  }

  console.log(`\ntest-trustpoint-parked: ${fail ? 'FAILED' : 'OK'} (${pass} assertions${fail ? `, ${fail} failed` : ''})`);
  process.exit(fail ? 1 : 0);
}

void assert;
