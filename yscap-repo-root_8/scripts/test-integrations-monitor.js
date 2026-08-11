'use strict';
/**
 * Tests for the API Health down-alert monitor (src/lib/integrations/monitor.js).
 *
 * The three rules the owner asked for on 2026-08-09 ("the admins are getting bombarded
 * … it's down, and after a few minutes it's back up") each have their own section, and
 * every assertion below was written against a defect that was actually reproduced:
 *   1. NOTHING is said until a service has been unreachable for the full window, so a
 *      blip that heals inside it sends no "down" AND no "back up" either.
 *   2. ONE email per sweep, covering every service — never one email per service.
 *   3. Super admins are mailed, every admin still SEES it in PILOT, and the hand-typed
 *      NOTIFY_ADMINS shared inbox — the one recipient list that could carry a loan
 *      officer's address — is skipped outright.
 * The decision + composition logic is pure (no DB); an end-to-end pass is DB-gated.
 */
const assert = require('assert');
const monitor = require('../src/lib/integrations/monitor');

// ---- PURE: nothing is announced until a service has been down for the full window ----
{
  const T0 = '2026-07-21T12:00:00.000Z';           // the first failed check
  const T3 = '2026-07-21T12:03:00.000Z';
  const T29 = '2026-07-21T12:29:00.000Z';
  const T30 = '2026-07-21T12:30:00.000Z';
  const WINDOW = { alertAfterMs: 30 * 60000 };
  const ev = (prev, results, now = T0) => monitor.evaluateTransitions(prev, results, now, WINDOW);
  const down = (detail = 'HTTP 401') => [{ key: 'clickup', name: 'ClickUp', state: 'unreachable', detail }];
  const up = () => [{ key: 'clickup', name: 'ClickUp', state: 'live', detail: 'Reached ClickUp.' }];

  // The default window IS the owner's 30 minutes — the number is not left to a call site.
  assert.strictEqual(monitor._internals.ALERT_AFTER_MS, 30 * 60000, 'the default silent window is 30 minutes');

  /* THE FIX FOR THE BOMBARDMENT. The first failed check starts a clock and says NOTHING.
     The old code emailed right here, which is why "this is now down" arrived several
     times a day for services that were reachable again minutes later. */
  let r = ev({ clickup: { state: 'live', notified_down: false } }, down());
  assert.strictEqual(r.alerts.length, 0, 'the first failed check is silent');
  assert.strictEqual(r.next.clickup.downSince, T0, 'but the clock starts');
  assert.strictEqual(r.next.clickup.notifiedDown, false, 'and nothing is recorded as announced');

  /* Still inside the window → still silent, and the clock is NEVER restarted — a service
     flapping around the boundary would otherwise reset itself forever and a genuine
     outage would never be reported at all. */
  r = ev({ clickup: { state: 'unreachable', notified_down: false, down_since: T0 } }, down(), T29);
  assert.strictEqual(r.alerts.length, 0, '29 minutes in is still silent');
  assert.strictEqual(r.next.clickup.downSince, T0, 'a later failure does not restart the clock');

  // Past the window → ONE alert, carrying how long it has actually been down.
  r = ev({ clickup: { state: 'unreachable', notified_down: false, down_since: T0 } }, down(), T30);
  assert.deepStrictEqual(r.alerts.map((a) => [a.key, a.kind]), [['clickup', 'down']], '30 minutes down alerts');
  assert.strictEqual(r.alerts[0].downMs, 30 * 60000, 'the alert carries the real duration');
  assert.strictEqual(r.next.clickup.notifiedDown, true, 'and only now is it recorded as announced');

  // …and only once, however long it then stays down.
  r = ev({ clickup: { state: 'unreachable', notified_down: true, down_since: T0 } }, down(), '2026-07-22T12:00:00.000Z');
  assert.strictEqual(r.alerts.length, 0, 'a service already announced never re-alerts');
  assert.strictEqual(r.next.clickup.downSince, T0, 'down_since is preserved while it stays down');

  /* THE BLIP the owner reported: down, then reachable again inside the window. NOTHING is
     sent — not a "down", and therefore not a "back up" either. A recovery notice for an
     outage nobody was told about is pure noise, and mailing BOTH halves of a three-minute
     wobble is the complaint in its purest form. */
  r = ev({ clickup: { state: 'unreachable', notified_down: false, down_since: T0 } }, up(), T3);
  assert.strictEqual(r.alerts.length, 0, 'a blip that heals inside the window says NOTHING');
  assert.strictEqual(r.next.clickup.downSince, null, 'and its clock is cleared');

  // A service we DID announce, now reachable → one 'recovered' alert with the duration.
  r = ev({ clickup: { state: 'unreachable', notified_down: true, down_since: T0 } }, up(), T30);
  assert.deepStrictEqual(r.alerts.map((a) => [a.key, a.kind]), [['clickup', 'recovered']], 'an announced outage reports its recovery');
  assert.strictEqual(r.alerts[0].downMs, 30 * 60000, 'the recovery says how long it was out');
  assert.strictEqual(r.next.clickup.notifiedDown, false);
  assert.strictEqual(r.next.clickup.downSince, null);

  // Intentional states NEVER alert, whatever the clock says.
  for (const st of ['not_configured', 'disabled', 'framework', 'planned', 'configured', 'live']) {
    const q = ev({ x: { state: 'configured', notified_down: false } }, [{ key: 'x', name: 'X', state: st }]);
    assert.strictEqual(q.alerts.length, 0, `${st} never alerts`);
  }
  // Down → switched off AFTER it was announced is a recovery, not a repeat down…
  r = monitor.evaluateTransitions({ sitewire: { state: 'unreachable', notified_down: true } },
    [{ key: 'sitewire', name: 'Sitewire', state: 'disabled' }], T30, WINDOW);
  assert.deepStrictEqual(r.alerts.map((a) => a.kind), ['recovered'], 'down→disabled clears the alert (recovered)');
  // …and switched off DURING the silent window says nothing at all — nobody was ever told.
  r = monitor.evaluateTransitions({ sitewire: { state: 'unreachable', notified_down: false, down_since: T0 } },
    [{ key: 'sitewire', name: 'Sitewire', state: 'disabled' }], T29, WINDOW);
  assert.strictEqual(r.alerts.length, 0, 'switched off inside the window is silent');

  /* A zero window is the OLD behaviour and still works, so the silence is a POLICY on top
     of the transition logic rather than a rewrite of it (and it is what an operator gets
     from INTEGRATIONS_MONITOR_ALERT_AFTER_MIN=0). */
  r = monitor.evaluateTransitions({}, down(), T0, { alertAfterMs: 0 });
  assert.deepStrictEqual(r.alerts.map((a) => a.kind), ['down'], 'a 0-minute window alerts on the first failed check');

  /* THE CLOCK IS ALWAYS STAMPED, even when the caller supplies no timestamp. A null start
     would be persisted and re-read next tick as "the outage began just now", so the window
     could never elapse and a permanently down service would stay silent forever. */
  r = monitor.evaluateTransitions({}, down(), null, WINDOW);
  assert.ok(r.next.clickup.downSince, 'a caller with no clock still stamps down_since');
  assert.ok(Math.abs(Date.parse(r.next.clickup.downSince) - Date.now()) < 5000, 'and stamps it to now');
  console.log('  ok - pure transitions: silent window / announced once / a blip says nothing');
}

// ---- PURE: ONE email per sweep, and exactly what it says ----
{
  const WINDOW = { alertAfterMs: 30 * 60000 };
  const A = (name, kind, downMs, detail) => ({ key: name.toLowerCase(), name, kind, downMs, detail: detail || '' });

  assert.strictEqual(monitor.composeAlert([], WINDOW), null, 'nothing to report → no email at all, not an empty one');

  // ONE service down.
  let m = monitor.composeAlert([A('ClickUp', 'down', 32 * 60000, 'HTTP 401')], WINDOW);
  assert.strictEqual(m.title, 'ClickUp has been down for 32 minutes', 'the subject names the service and how long');
  assert.ok(/PILOT has not been able to reach this service/.test(m.body), 'the body opens with the plain fact');
  assert.ok(/ClickUp — down for 32 minutes\. HTTP 401/.test(m.body), 'the line carries the reason we were given');
  // The sentence that makes this email worth opening — it is never a momentary wobble.
  assert.ok(/unreachable for more than 30 minutes/.test(m.body), 'the body states the rule it was sent under');
  assert.ok(/API Health/.test(m.body), 'and says where to go');

  /* SIX AT ONCE — the owner's actual complaint. A restart or a network wobble takes
     several services down in the same instant; that is ONE email listing all six, never
     six emails. */
  const names = ['ClickUp', 'Sitewire', 'SharePoint', 'Resend', 'DocuSign', 'Encompass'];
  m = monitor.composeAlert(names.map((n) => A(n, 'down', 45 * 60000)), WINDOW);
  assert.strictEqual(m.title, '6 services have been down for over 30 minutes', 'one subject for the whole sweep');
  for (const n of names) assert.ok(m.body.includes(n), `${n} is listed in the one email`);

  // Down AND recovered in the same sweep → still ONE email, both sections.
  m = monitor.composeAlert([A('ClickUp', 'down', 31 * 60000), A('Resend', 'recovered', 90 * 60000)], WINDOW);
  assert.strictEqual(m.title, 'ClickUp has been down for 31 minutes', 'a live outage leads the subject, not a recovery');
  assert.ok(/Back up again:/.test(m.body) && /Resend/.test(m.body), 'the recovery rides in the same email');

  // Recoveries only → the subject says so.
  assert.strictEqual(monitor.composeAlert([A('Resend', 'recovered', 90 * 60000)], WINDOW).title, 'Resend is back up');
  assert.strictEqual(
    monitor.composeAlert([A('Resend', 'recovered', 90 * 60000), A('ClickUp', 'recovered', null)], WINDOW).title,
    '2 services are back up');

  // Durations read the way a person would say them.
  const dur = (ms) => monitor.composeAlert([A('X', 'down', ms)], WINDOW).body.match(/down for ([^.\n]+)/)[1];
  assert.strictEqual(dur(60000), '1 minute');
  assert.strictEqual(dur(35 * 60000), '35 minutes');
  assert.strictEqual(dur(2 * 3600000), '2 hours');
  assert.strictEqual(dur(3 * 86400000), '3 days');
  console.log('  ok - composeAlert: one email per sweep, six outages in a single message');
}

/* ---- PURE: what the API Health page is told about the monitor itself ----
   The page renders "down for 3 days" and "nothing is watching between visits" from
   these two, so both are pinned here rather than left to the screen to re-derive. */
{
  const env = { ...process.env };
  const set = (on, mins) => {
    if (on == null) delete process.env.INTEGRATIONS_MONITOR_ENABLED; else process.env.INTEGRATIONS_MONITOR_ENABLED = on;
    if (mins == null) delete process.env.INTEGRATIONS_MONITOR_INTERVAL_MIN; else process.env.INTEGRATIONS_MONITOR_INTERVAL_MIN = mins;
  };
  try {
    // ON BY DEFAULT (owner-directed 2026-08-09, "turn on the down alerts"). An unset env var
    // means the alerts run; only an explicit '0' turns them off.
    set(null, null);
    assert.deepStrictEqual(monitor.describe(), {
      enabled: true, intervalMin: 15, switchKey: 'INTEGRATIONS_MONITOR_ENABLED',
      // The page prints these two, so they are part of the contract, not decoration:
      // "you are only told after 30 minutes" and "super admins are the ones emailed".
      alertAfterMin: 30, emailRoles: ['super_admin'],
    }, 'unset = ON, 15 min, 30-minute window, super admins mailed');
    assert.notStrictEqual(monitor.describe().emailRoles, monitor._internals.ALERT_EMAIL_ROLES,
      'the roles are copied, so a caller cannot mutate the module constant');
    set('0', '15');
    assert.strictEqual(monitor.describe().enabled, false, 'an explicit 0 turns the alerts off');
    set('1', '30');
    assert.deepStrictEqual(monitor.describe().enabled, true, 'an explicit 1 is still honoured');
    assert.strictEqual(monitor.describe().intervalMin, 30, 'the interval env value is honoured');
    // Anything under the 5-minute floor is clamped, and junk falls back — the page must
    // never print "checking every 0 minutes".
    set('1', '1');
    assert.strictEqual(monitor.describe().intervalMin, 5, 'interval is clamped to the 5-minute floor');
    set('1', 'nonsense');
    assert.strictEqual(monitor.describe().intervalMin, 15, 'unparseable interval falls back to 15');
    // Everything that is not the literal '0' leaves the alerts on — a typo must never
    // silently stop the only thing watching these services.
    for (const v of ['', 'true', 'yes', 'off']) { set(v, '15'); assert.strictEqual(monitor.describe().enabled, true, `"${v}" does not switch it off`); }
  } finally { process.env = env; }

  /* THE SWITCH, not the env var, is the authority — that is what makes the toggle on the
     API Health page work without a redeploy. The flag cache is a synchronous in-memory map,
     so an override can be set here with no database. */
  {
    const env2 = { ...process.env };
    const flags = require('../src/lib/flags');
    const switches = require('../src/lib/integrations/switches');
    try {
      delete process.env.INTEGRATIONS_MONITOR_ENABLED;           // env default = ON
      flags._internals.setOverrideForTest('INTEGRATIONS_MONITOR_ENABLED', false);
      assert.strictEqual(monitor.describe().enabled, false, 'an admin override to OFF beats the env default');
      assert.strictEqual(switches.effective('INTEGRATIONS_MONITOR_ENABLED').overridden, true, 'the page is told it is overridden');
      process.env.INTEGRATIONS_MONITOR_ENABLED = '0';            // env default = OFF
      flags._internals.setOverrideForTest('INTEGRATIONS_MONITOR_ENABLED', true);
      assert.strictEqual(monitor.describe().enabled, true, 'an admin override to ON beats an env default of off');
      flags._internals.clearOverrideForTest('INTEGRATIONS_MONITOR_ENABLED');
      assert.strictEqual(monitor.describe().enabled, false, 'clearing the override falls back to the env default');
    } finally { flags._internals.clearOverrideForTest('INTEGRATIONS_MONITOR_ENABLED'); process.env = env2; }
  }

  // It is the ONE platform-level switch: no card owns it, so the health registry's
  // per-integration filter must never attach it to one.
  {
    const switches = require('../src/lib/integrations/switches');
    const m = switches.BY_KEY.INTEGRATIONS_MONITOR_ENABLED;
    assert.ok(m, 'the monitor switch is in the allowlist, so the toggle/reset endpoints accept it');
    assert.strictEqual(m.integration, null, 'it belongs to no integration card');
    assert.strictEqual(!!m.dangerous, false, 'it sends nothing outward but our own admin email — no typed confirm');
    assert.strictEqual(!!m.resume, false, 'the timer re-reads it every tick, so it needs no restart to resume');
    const owned = switches.list().filter((s) => s.integration === null).map((s) => s.key);
    assert.deepStrictEqual(owned, ['INTEGRATIONS_MONITOR_ENABLED'], 'it is the only card-less switch');
  }

  // downSinceFor: the row supplies HOW LONG, the live probe decides WHETHER.
  const ROW = { down_since: '2026-07-18T09:00:00.000Z' };
  assert.strictEqual(monitor.downSinceFor('unreachable', ROW), ROW.down_since, 'still down → the stored since-when shows');
  // THE POINT OF THE FUNCTION: the monitor sweeps on a timer, so a service that recovered
  // five minutes ago still has yesterday's down_since in the table. Printing it beside a
  // green light is a page contradicting itself.
  for (const st of ['live', 'configured', 'disabled', 'not_configured', 'framework', 'planned']) {
    assert.strictEqual(monitor.downSinceFor(st, ROW), null, `a stale row is dropped once the probe says ${st}`);
  }
  assert.strictEqual(monitor.downSinceFor('unreachable', undefined), null, 'no row (monitor never ran) → null, never a guess');
  assert.strictEqual(monitor.downSinceFor('unreachable', { down_since: null }), null, 'a row with no timestamp → null');
  console.log('  ok - describe() + downSinceFor() (the two facts the API Health page renders)');
}

(async () => {
  /* ---- PURE (async): WHO the sweep is addressed to ----
     The recipient rule is the owner's "no loan officers should receive it", and it is
     carried entirely by the two options this function passes — so they are pinned here
     rather than left to be read off notifyAdmins by eye. */
  {
    const sent = [];
    const notify = { notifyAdmins: async (o) => { sent.push(o); return ['id']; } };
    const alerts = [
      { key: 'clickup', name: 'ClickUp', kind: 'down', downMs: 31 * 60000, detail: '' },
      { key: 'resend', name: 'Resend', kind: 'down', downMs: 31 * 60000, detail: '' },
    ];
    const msg = await monitor._internals.sendSweepAlert(alerts, notify);
    assert.strictEqual(sent.length, 1, 'TWO services down = ONE email, not two');
    assert.ok(msg && msg.title, 'the sender reports what it actually sent');
    const o = sent[0];
    assert.strictEqual(o.type, 'integration_alert');
    assert.strictEqual(o.title, msg.title, 'the email carries the composed subject');
    assert.strictEqual(o.link, '/portal/#/internal/api-health', 'it links to the page that can test the service');
    /* NO LOAN OFFICERS. notifyAdmins only ever fans out to admins + super admins, so the
       one list that could carry a loan officer's address is the hand-typed NOTIFY_ADMINS
       inbox — which this alert skips outright rather than trusting what is in it today. */
    assert.strictEqual(o.skipSharedInbox, true, 'the NOTIFY_ADMINS shared inbox is skipped');
    // Mail goes to super admins only; every admin still gets the in-app row.
    assert.deepStrictEqual(o.emailRoles, ['super_admin'], 'only super admins are mailed');
    assert.notStrictEqual(o.inAppOnly, true, 'the in-app rows are still written for every admin');

    sent.length = 0;
    assert.strictEqual(await monitor._internals.sendSweepAlert([], notify), null, 'an empty sweep composes nothing');
    assert.strictEqual(sent.length, 0, 'and sends nothing');
    console.log('  ok - one email per sweep, super admins only, shared inbox skipped');
  }

  if (!process.env.DATABASE_URL) {
    console.log('SKIP test-integrations-monitor DB half (no DATABASE_URL)');
    console.log('test-integrations-monitor: silent window + one-email-per-sweep + recipients pass');
    return;
  }
  const db = require('../src/db');
  await require('../src/migrate-boot').ensureSchema();

  // ---- DB: a full sweep, end to end, against the real state table ----
  const KEY = '__t_svc';
  await db.query('DELETE FROM integration_health_state WHERE key = $1', [KEY]);
  const calls = [];
  const notify = { notifyAdmins: async (o) => { calls.push(o); return ['x']; } };
  let state = 'unreachable';
  const health = { probeAll: async () => [{ key: KEY, name: 'Test Service', state, detail: 'd' }] };
  const row = async () => (await db.query(
    'SELECT state, notified_down, down_since FROM integration_health_state WHERE key = $1', [KEY])).rows[0];
  // Age the stored outage so the sweep sees a service that has been down long enough,
  // without waiting half an hour or reaching into the module's clock.
  const age = (min) => db.query(
    `UPDATE integration_health_state SET down_since = now() - ($2 || ' minutes')::interval WHERE key = $1`,
    [KEY, String(min)]);

  // 1. The first failed check is SILENT — this is the whole fix.
  let res = await monitor.runOnce({ health, notify });
  assert.strictEqual(res.alerts.length, 0, 'a fresh outage alerts nobody');
  assert.strictEqual(calls.length, 0, 'and emails nobody');
  let r = await row();
  assert.ok(r && r.state === 'unreachable' && r.notified_down === false, 'the clock is running, nothing announced');
  assert.ok(r.down_since, 'down_since is stamped on the first failed check');

  // 2. Still down forty minutes later → exactly ONE email.
  await age(40);
  await monitor.runOnce({ health, notify });
  assert.strictEqual(calls.length, 1, 'exactly one email once the window has passed');
  assert.ok(/has been down for/.test(calls[0].title), `the subject names the outage (got: ${calls[0].title})`);
  assert.strictEqual((await row()).notified_down, true, 'now recorded as announced');

  // 3. Still down → never a repeat.
  await monitor.runOnce({ health, notify });
  await monitor.runOnce({ health, notify });
  assert.strictEqual(calls.length, 1, 'a continuing outage never re-emails');

  // 4. Recovered → one "back up" email, and the row is cleared.
  state = 'live';
  await monitor.runOnce({ health, notify });
  assert.strictEqual(calls.length, 2, 'one recovery email');
  assert.ok(/back up/.test(calls[1].title), `the recovery subject says so (got: ${calls[1].title})`);
  r = await row();
  assert.ok(r.state === 'live' && r.notified_down === false, 'the row is cleared after recovery');

  // 5. THE BLIP, end to end: down then up inside the window → not one email, either half.
  state = 'unreachable';
  await monitor.runOnce({ health, notify });          // clock starts, silent
  state = 'live';
  await monitor.runOnce({ health, notify });          // healed well inside the window
  assert.strictEqual(calls.length, 2, 'a short outage produces no email at all');

  /* 6. A FAILED SEND IS NOT AN ANNOUNCEMENT. Without the roll-back, one two-second email
        failure would stamp the service "already announced" and a real outage would stay
        silent forever — the same class as the closing-chain dedupe that had to be fixed. */
  state = 'unreachable';
  await monitor.runOnce({ health, notify });          // clock starts
  await age(40);
  await monitor.runOnce({ health, notify: { notifyAdmins: async () => { throw new Error('smtp down'); } } });
  assert.strictEqual((await row()).notified_down, false, 'a failed send is not recorded as an announcement');
  const before = calls.length;
  await monitor.runOnce({ health, notify });
  assert.strictEqual(calls.length, before + 1, 'so the next sweep re-sends it');
  assert.strictEqual((await row()).notified_down, true, 'and only then is it recorded');
  await db.query('DELETE FROM integration_health_state WHERE key = $1', [KEY]);

  /* ---- DB: WHO ACTUALLY RECEIVES IT, through the real notify chokepoint ----
     Asserted on the WIRE PAYLOAD with the mailer stubbed. A send against the default
     'none' provider reports the same status whether or not it was suppressed, so it
     proves nothing about who was mailed. */
  {
    const crypto = require('crypto');
    const cfg = require('../src/config');
    const emailMod = require('../src/lib/email');
    const realNotify = require('../src/lib/notify');
    const sfx = crypto.randomBytes(4).toString('hex');
    const mk = async (role) => (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
      [`ah-${role}-${sfx}@test.local`, `Health ${role}`, role])).rows[0].id;
    const superId = await mk('super_admin');
    const adminId = await mk('admin');
    const loId = await mk('loan_officer');
    const ids = [superId, adminId, loId];
    const emailOf = (role) => `ah-${role}-${sfx}@test.local`;

    const sends = [];
    const realSend = emailMod.sendMail;
    const savedShared = cfg.notifyAdmins;
    emailMod.sendMail = async (o) => { sends.push(o); return { ok: true, id: 'stub' }; };
    // Put something in the shared inbox so "we skip it" is proved rather than vacuous.
    cfg.notifyAdmins = ['shared-inbox@test.local'];
    const wentTo = (addr) => sends.some((s) => [].concat(s.to || []).some((t) => String(t).includes(addr)));
    const rowsFor = async (id) => (await db.query(
      `SELECT id FROM notifications WHERE staff_id = $1 AND type = 'integration_alert'`, [id])).rows;

    try {
      await monitor._internals.sendSweepAlert(
        [{ key: KEY, name: 'Test Service', kind: 'down', downMs: 31 * 60000, detail: '' }], realNotify);
      await realNotify.drainEmails();

      // The super admin is emailed AND has the in-app row.
      assert.ok(wentTo(emailOf('super_admin')), 'the super admin is emailed');
      assert.strictEqual((await rowsFor(superId)).length, 1, 'and has the in-app row');
      // The admin KEEPS the in-app row and loses only the email — they still see the
      // outage in PILOT, they are simply not mailed about it.
      assert.strictEqual((await rowsFor(adminId)).length, 1, 'the admin still sees it in PILOT');
      assert.ok(!wentTo(emailOf('admin')), 'but the admin is not emailed');
      // A loan officer is reached neither way. notifyAdmins never selects them at all.
      assert.strictEqual((await rowsFor(loId)).length, 0, 'a loan officer gets no row');
      assert.ok(!wentTo(emailOf('loan_officer')), 'and no email');
      // …and the hand-typed shared inbox — the one list that could hold a loan officer's
      // address — is skipped.
      assert.ok(!wentTo('shared-inbox@test.local'), 'the NOTIFY_ADMINS shared inbox is skipped');

      /* CONTROL: the same fan-out WITHOUT the two options must reach the admin and the
         shared inbox — otherwise the assertions above would pass even if the narrowing
         were never applied (e.g. if the mailer stub were simply never called). */
      sends.length = 0;
      await realNotify.notifyAdmins({ type: 'integration_alert', title: 'control', body: 'control' });
      await realNotify.drainEmails();
      assert.ok(wentTo(emailOf('admin')), 'control: an ordinary admin fan-out DOES email the admin');
      assert.ok(wentTo('shared-inbox@test.local'), 'control: and DOES copy the shared inbox');
    } finally {
      emailMod.sendMail = realSend;
      cfg.notifyAdmins = savedShared;
      await db.query('DELETE FROM notifications WHERE staff_id = ANY($1)', [ids]).catch(() => {});
      // Fall back to deactivating if some other table still references them — an inactive
      // leftover is invisible to notifyAdmins, so it can never perturb another suite.
      await db.query('DELETE FROM staff_users WHERE id = ANY($1)', [ids])
        .catch(() => db.query('UPDATE staff_users SET is_active = false WHERE id = ANY($1)', [ids]).catch(() => {}));
    }
    console.log('  ok - DB recipients: super admin emailed, admin in-app only, no loan officer, no shared inbox');
  }

  console.log('test-integrations-monitor: silent window + one-email-per-sweep + recipients + DB sweep pass');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
