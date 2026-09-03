#!/usr/bin/env node
'use strict';
/**
 * Class Valuation callback (webhook) registration — the operator's tool.
 *
 * Class pushes order events to us; we register ONE URL with them once, and they call
 * it with HTTP Basic credentials WE chose. Their self-registration guide (2026-09-03)
 * fixes the contract this tool encodes:
 *
 *   • POST /intg/callbacks/addAll registers all 15 event types against one URL in one
 *     call; a URL already registered only gains the missing events.
 *   • GET  /intg/callbacks lists every registration — and returns the password in
 *     PLAINTEXT to any token holder in our organization. So the password must be a
 *     high-entropy value used for nothing else, and this tool NEVER prints it.
 *   • There is NO update operation. Rotating the password or moving the URL is
 *     delete-and-recreate — see docs/CLASS-CALLBACKS-RUNBOOK.md.
 *   • The URL is matched EXACTLY: `.../callbacks` and `.../callbacks/` are two
 *     destinations and each gets a full set → duplicate deliveries on live orders.
 *
 * It runs INSIDE the deployed service (a Render one-off job, `npm run class:callbacks
 * -- <command>`), which is where the Class credentials and the callback password
 * already live — nothing secret ever passes through a terminal or a chat.
 *
 * Commands
 *   list               show what Class holds, what our database recorded, masked
 *   verify             exit 0 only when our URL is fully registered with our
 *                      current credentials and no trailing-slash twin exists
 *   register           preflight, then addAll for our URL; then verify
 *   selftest           prove the public receiver: 401 without credentials, 200 with,
 *                      a retry collapses, the stored row is cleaned up
 *   delete <id>        delete ONE registration by Class's id (used by rotate)
 *   rotate --confirm   delete every registration for our URL, then register again
 *                      with the CURRENT password (the runbook's step 3)
 *
 * Every write is gated by the same CLASS_ENABLED / CLASS_OUTBOUND_ENABLED / DRYRUN
 * switches as every other write to Class (the client refuses otherwise).
 */

const EVENT_COUNT_EXPECTED = 15;

// ---------------------------------------------------------------------------
// PURE HELPERS (unit-tested in scripts/test-class-callbacks-cli-pure.js)
// ---------------------------------------------------------------------------

// The guide's example password and the obvious non-secrets. A placeholder that
// reaches Class is readable by every token holder in the organization forever.
const PLACEHOLDERS = ['<strong_generated_secret>', 'changeme', 'change-me', 'password', 'secret', 'test', 'example', 'class_webhook'];

function strength(pw) {
  const s = String(pw || '');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  const placeholder = !s || s.startsWith('<') || PLACEHOLDERS.includes(s.toLowerCase());
  // 24+ characters from at least two classes ≈ 128 bits from a real generator; a
  // 43-char base64 string (32 random bytes) clears it comfortably.
  const ok = !placeholder && s.length >= 24 && classes >= 2;
  return { length: s.length, classes, placeholder, ok };
}

// ONE canonical form: no trailing slash, no whitespace. Registering both forms is the
// duplicate-delivery trap the guide warns about.
function canonicalUrl(url) {
  const u = String(url || '').trim();
  return u.replace(/\/+$/, '');
}

function urlProblem(url) {
  const u = canonicalUrl(url);
  if (!u) return 'CLASS_CALLBACK_URL is not set';
  if (!/^https:\/\//i.test(u)) return 'CLASS_CALLBACK_URL must be https (their requirement: HTTPS and publicly reachable)';
  if (u !== String(url || '').trim()) return 'CLASS_CALLBACK_URL carries a trailing slash — pick the form without it (they match the URL exactly)';
  try { const p = new URL(u); if (!p.hostname.includes('.')) return 'CLASS_CALLBACK_URL is not a public hostname'; } catch (_) { return 'CLASS_CALLBACK_URL is not a valid URL'; }
  return null;
}

// Everything that must be true BEFORE a registration is attempted. Registration
// takes effect immediately against live orders, so a bad value here is not a
// warning — it is refused.
function preflight({ enabled, callbackReady, callbackUrl, callbackUser, callbackPassword }) {
  const problems = [];
  if (!enabled) problems.push('CLASS_ENABLED is off — the integration master switch');
  if (!callbackReady) problems.push('the receiver is not configured (CLASS_CALLBACK_URL + CLASS_CALLBACK_USER + CLASS_CALLBACK_PASSWORD)');
  const up = urlProblem(callbackUrl);
  if (up) problems.push(up);
  if (!String(callbackUser || '').trim()) problems.push('CLASS_CALLBACK_USER is empty');
  if (/[:\s]/.test(String(callbackUser || ''))) problems.push('CLASS_CALLBACK_USER may not contain a colon or whitespace (HTTP Basic splits on the first colon)');
  const st = strength(callbackPassword);
  if (st.placeholder) problems.push('CLASS_CALLBACK_PASSWORD is a placeholder — generate a high-entropy value used only for this integration');
  else if (!st.ok) problems.push(`CLASS_CALLBACK_PASSWORD is too weak (${st.length} chars, ${st.classes} character classes) — 24+ characters from a real generator`);
  return { ok: problems.length === 0, problems };
}

// Their list reply is documented as an array but the envelope is not guaranteed.
function parseList(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const k of ['data', 'callbacks', 'result', 'items', 'registeredCallbacks']) if (Array.isArray(body[k])) return body[k];
  }
  return [];
}

function rowUrl(r) { return String((r && (r.callbackUrl || r.CallbackUrl || r.url)) || '').trim(); }
function rowEvent(r) { return String((r && (r.eventName || r.EventName || r.event)) || '').trim(); }
function rowId(r) { return r && (r.id != null ? r.id : r.Id != null ? r.Id : r.callbackId); }
function rowAuthMode(r) { return String((r && (r.authMode || r.AuthMode)) || '').trim(); }
function rowUser(r) { return String((r && (r.userName || r.UserName || r.username)) || ''); }
function rowPassword(r) { return String((r && (r.password || r.Password)) || ''); }

/**
 * Judge what Class holds against what we intend. `password` and `user` are compared
 * and NEVER returned — the report carries booleans only.
 */
function analyzeRegistrations(rows, { url, user, password, events }) {
  const canon = canonicalUrl(url);
  const twin = canon + '/';
  const want = new Set(events || []);
  const ours = [];
  const twins = [];
  const others = [];
  for (const r of rows || []) {
    const u = rowUrl(r);
    if (u === canon) ours.push(r);
    else if (u === twin || canonicalUrl(u) === canon) twins.push(r);
    else others.push(r);
  }
  const have = new Set(ours.map(rowEvent).filter(Boolean));
  const missing = [...want].filter((e) => !have.has(e));
  const unexpected = [...have].filter((e) => !want.has(e));
  const authModeWrong = ours.filter((r) => rowAuthMode(r) && rowAuthMode(r).toLowerCase() !== 'basicauth').map(rowEvent);
  const stalePassword = ours.filter((r) => rowPassword(r) && rowPassword(r) !== String(password || '')).map(rowEvent);
  const staleUser = ours.filter((r) => rowUser(r) && rowUser(r) !== String(user || '')).map(rowEvent);
  const complete = ours.length > 0 && missing.length === 0 && authModeWrong.length === 0 && stalePassword.length === 0 && staleUser.length === 0 && twins.length === 0;
  return {
    url: canon,
    registered: ours.length,
    ids: ours.map((r) => ({ id: rowId(r), eventName: rowEvent(r) })),
    missing, unexpected, authModeWrong, stalePassword, staleUser,
    twins: twins.map((r) => ({ id: rowId(r), eventName: rowEvent(r), callbackUrl: rowUrl(r) })),
    others: others.map((r) => ({ id: rowId(r), eventName: rowEvent(r), callbackUrl: rowUrl(r) })),
    complete,
  };
}

// The masked line for one registration — no username, no password, ever.
function maskRow(r, { user, password }) {
  return {
    id: rowId(r), eventName: rowEvent(r), callbackUrl: rowUrl(r), authMode: rowAuthMode(r),
    userMatches: rowUser(r) ? rowUser(r) === String(user || '') : null,
    passwordMatches: rowPassword(r) ? rowPassword(r) === String(password || '') : null,
  };
}

module.exports = { strength, canonicalUrl, urlProblem, preflight, parseList, analyzeRegistrations, maskRow, EVENT_COUNT_EXPECTED, PLACEHOLDERS };

// ---------------------------------------------------------------------------
// THE COMMANDS (need the app: config, the Class client, the database)
// ---------------------------------------------------------------------------
if (require.main === module) {
  const path = require('path');
  const ROOT = path.resolve(__dirname, '..');
  const cfg = require(path.join(ROOT, 'src/config'));
  const client = require(path.join(ROOT, 'src/class/client'));
  const { EVENTS } = require(path.join(ROOT, 'src/class/callbacks'));
  const db = require(path.join(ROOT, 'src/db'));

  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const say = (tag, obj) => console.log(json ? JSON.stringify({ tag, ...obj }) : `[class-callbacks] ${tag} ${JSON.stringify(obj)}`);

  const c = cfg.class || {};
  const intent = () => ({ url: canonicalUrl(c.callbackUrl), user: c.callbackUser, password: c.callbackPassword, events: EVENTS });

  async function listRemote() {
    const body = await client.listCallbacks();
    return parseList(body);
  }

  async function recordRegistered(names, classIds) {
    for (const ev of names) {
      const id = classIds && classIds[ev] != null ? String(classIds[ev]) : null;
      await db.query(
        `INSERT INTO class_callback_registrations (event_name, callback_url, class_id, auth_mode, last_error)
         VALUES ($1,$2,$3,'BasicAuth',NULL)
         ON CONFLICT (event_name, callback_url) WHERE removed_at IS NULL
         DO UPDATE SET class_id = COALESCE(EXCLUDED.class_id, class_callback_registrations.class_id), last_error = NULL`,
        [String(ev).slice(0, 64), intent().url, id]).catch((e) => say('DBREG_ERR', { event: ev, message: e.message }));
    }
  }

  async function cmdList() {
    const st = client.configured();
    say('CFG', { enabled: st.enabled, callbackReady: st.callbackReady, environment: c.environment, url: intent().url,
      userLength: String(c.callbackUser || '').length, password: strength(c.callbackPassword), previousPasswordSet: !!c.callbackPasswordPrevious });
    const rows = await listRemote();
    say('REMOTE', { count: rows.length });
    for (const r of rows) say('REG', maskRow(r, intent()));
    const a = analyzeRegistrations(rows, intent());
    say('ANALYSIS', a);
    const dbrows = (await db.query(`SELECT event_name, callback_url, class_id, registered_at, removed_at, last_error FROM class_callback_registrations ORDER BY event_name`)).rows;
    say('DBREG', { count: dbrows.length, rows: dbrows });
    return a;
  }

  async function cmdVerify() {
    const rows = await listRemote();
    const a = analyzeRegistrations(rows, intent());
    say('VERIFY', { ...a, expectedEvents: EVENTS.length, expectedEventCount: EVENT_COUNT_EXPECTED });
    if (!a.complete) {
      say('VERIFY_FAIL', { why: [
        a.registered === 0 ? 'nothing registered for our URL' : null,
        a.missing.length ? `missing events: ${a.missing.join(', ')}` : null,
        a.stalePassword.length ? 'the registered password is not the current CLASS_CALLBACK_PASSWORD' : null,
        a.staleUser.length ? 'the registered username is not the current CLASS_CALLBACK_USER' : null,
        a.authModeWrong.length ? 'a registration is not BasicAuth' : null,
        a.twins.length ? 'a trailing-slash twin URL is registered — duplicate deliveries; delete it' : null,
      ].filter(Boolean) });
    }
    return a;
  }

  async function cmdRegister() {
    const st = client.configured();
    const pf = preflight({ enabled: st.enabled, callbackReady: st.callbackReady, callbackUrl: c.callbackUrl, callbackUser: c.callbackUser, callbackPassword: c.callbackPassword });
    say('PREFLIGHT', pf);
    if (!pf.ok) { process.exitCode = 2; return null; }
    const before = analyzeRegistrations(await listRemote(), intent());
    say('BEFORE', { registered: before.registered, missing: before.missing.length, twins: before.twins.length, stalePassword: before.stalePassword.length });
    if (before.twins.length) { say('REFUSED', { why: 'a trailing-slash twin is registered; delete it first (rotate handles this)' }); process.exitCode = 2; return null; }
    if (before.stalePassword.length || before.staleUser.length) { say('REFUSED', { why: 'existing registrations carry different credentials; addAll leaves them untouched — run rotate --confirm' }); process.exitCode = 2; return null; }
    if (before.complete) { say('ALREADY_COMPLETE', { registered: before.registered }); return before; }
    const out = await client.registerAllCallbacks({ callbackUrl: intent().url, userName: c.callbackUser, password: c.callbackPassword, authMode: 'BasicAuth' });
    if (out && out.__dryrun) { say('DRYRUN', { note: 'CLASS_DRYRUN is on — nothing was registered' }); return null; }
    const added = (out && (out.callbacksAdded || out.CallbacksAdded)) || {};
    const addedNames = Array.isArray(added) ? added.map(String) : Object.keys(added || {});
    const existing = parseList(out && (out.callbacksExisting || out.CallbacksExisting)).map(String);
    const couldNot = parseList(out && (out.callbacksCouldNotBeAdded || out.CallbacksCouldNotBeAdded));
    say('ADDALL', { success: out && out.success, added: addedNames, existing, couldNotBeAdded: couldNot, message: out && out.message });
    await recordRegistered(addedNames.concat(existing), Array.isArray(added) ? null : added);
    if (couldNot.length) { say('PARTIAL', { note: 'success:true with a non-empty couldNotBeAdded is a PARTIAL registration' }); process.exitCode = 2; }
    return cmdVerify();
  }

  async function cmdDelete(id) {
    if (!id) { say('USAGE', { note: 'delete <id>' }); process.exitCode = 2; return; }
    const out = await client.deleteCallback(String(id));
    if (out && out.__dryrun) { say('DRYRUN', { id }); return; }
    say('DELETED', { id, result: out });
    await db.query(`UPDATE class_callback_registrations SET removed_at = now() WHERE class_id = $1 AND removed_at IS NULL`, [String(id)]).catch(() => {});
  }

  async function cmdRotate() {
    if (!flags.has('--confirm')) { say('REFUSED', { why: 'rotate deletes every registration for our URL and re-creates it; pass --confirm' }); process.exitCode = 2; return; }
    const st = client.configured();
    const pf = preflight({ enabled: st.enabled, callbackReady: st.callbackReady, callbackUrl: c.callbackUrl, callbackUser: c.callbackUser, callbackPassword: c.callbackPassword });
    say('PREFLIGHT', pf);
    if (!pf.ok) { process.exitCode = 2; return; }
    const a = analyzeRegistrations(await listRemote(), intent());
    const doomed = a.ids.concat(a.twins);
    say('ROTATE', { deleting: doomed.length, twins: a.twins.length });
    for (const r of doomed) { if (r.id != null) await cmdDelete(r.id); }
    await db.query(`UPDATE class_callback_registrations SET removed_at = now() WHERE callback_url = $1 AND removed_at IS NULL`, [intent().url]).catch(() => {});
    await cmdRegister();
  }

  // Prove the PUBLIC receiver from the outside, with the real credentials, before
  // (or after) Class is pointed at it. Nothing here touches Class.
  async function cmdSelftest() {
    const url = intent().url;
    const up = urlProblem(c.callbackUrl);
    if (up) { say('SELFTEST_FAIL', { why: up }); process.exitCode = 2; return; }
    const orderId = `pilot-selftest-${Date.now()}`;
    const created = new Date().toISOString();
    const body = { eventName: 'StatusChanged', orderId, referenceNumber: null, sent: created, created, data: { StatusName: 'Active', Reason: 'PILOT callback self-test' } };
    const basic = 'Basic ' + Buffer.from(`${c.callbackUser}:${c.callbackPassword}`).toString('base64');
    const post = async (headers, b) => {
      const t0 = Date.now();
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(b) });
      return { status: r.status, ms: Date.now() - t0 };
    };
    const noAuth = await post({}, body);
    const wrong = await post({ Authorization: 'Basic ' + Buffer.from(`${c.callbackUser}:not-the-password`).toString('base64') }, body);
    const good = await post({ Authorization: basic }, body);
    const retry = await post({ Authorization: basic }, { ...body, sent: new Date().toISOString() });
    let stored = null;
    try { stored = (await db.query(`SELECT count(*)::int n FROM class_callback_events WHERE class_order_id = $1`, [orderId])).rows[0].n; } catch (e) { stored = `db read failed: ${e.message}`; }
    try { await db.query(`DELETE FROM class_callback_events WHERE class_order_id = $1`, [orderId]); } catch (_) {}
    const okAll = noAuth.status === 401 && wrong.status === 401 && good.status === 200 && retry.status === 200 && stored === 1 && good.ms < 30000;
    say(okAll ? 'SELFTEST_OK' : 'SELFTEST_FAIL', { url, noAuth, wrongPassword: wrong, withCredentials: good, retry, storedRowsForTheDelivery: stored, contract: '401 without credentials, 200 within 30 s with them, a retry collapses to one row' });
    if (!okAll) process.exitCode = 2;
  }

  (async () => {
    try {
      if (cmd === 'list') await cmdList();
      else if (cmd === 'verify') { const a = await cmdVerify(); if (!a.complete) process.exitCode = 2; }
      else if (cmd === 'register') await cmdRegister();
      else if (cmd === 'selftest') await cmdSelftest();
      else if (cmd === 'delete') await cmdDelete(argv[1]);
      else if (cmd === 'rotate') await cmdRotate();
      else { say('USAGE', { commands: ['list', 'verify', 'register', 'selftest', 'delete <id>', 'rotate --confirm'] }); process.exitCode = 2; }
    } catch (e) {
      say('ERROR', { message: e && e.message, code: e && e.code, status: e && e.status, body: e && e.body });
      process.exitCode = 1;
    } finally {
      await db.pool.end().catch(() => {});
    }
  })();
}
