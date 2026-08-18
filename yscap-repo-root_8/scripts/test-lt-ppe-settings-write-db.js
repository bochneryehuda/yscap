#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the SETTINGS WRITE DOOR.  /api/lt/ppe/settings
 *
 * WHAT THIS EXISTS TO PROVE. Measured on 2026-08-18 against the branch tip: nothing in
 * `src/` called `store.setSetting` or `store.clearSetting` (the only callers anywhere were
 * two test scripts), and the router published `GET /api/lt/ppe/settings` with no write
 * route of any kind. Every parity tolerance, the rounding mode, the price floor and the
 * per-investor margin/holdback were therefore read-only in practice and could only be
 * changed by editing the database by hand. This suite is the proof that the door now
 * exists, refuses the right things, and records what it does.
 *
 * IT SPEAKS REAL HTTP, over a REAL Postgres, ON PURPOSE. Calling the handlers directly
 * would prove the handler and say nothing about the MIDDLEWARE CHAIN — and "the admin gate
 * is on the route" is exactly the kind of claim that is true in a comment and false in the
 * router. So the real Express router is mounted behind a stub authenticator and every
 * assertion below goes through `fetch`.
 *
 * AND EVERY WRITE IS RE-READ FROM THE SERVER. A 200 from the write is never taken as proof
 * that anything was saved — "returned 200 but didn't save" is this repository's most
 * frequently recurring bug class, so each landing is confirmed by a SEPARATE GET.
 *
 * ISOLATION. The company slot is a real, shared row set (`readScope` fixes it to 'company'
 * and there is no test scope to redirect to), so this suite SNAPSHOTS every company-scoped
 * override before it starts and restores it in a `finally`, and it deletes only the audit
 * rows for the keys and scopes it touched. The investor slot uses a code unique to this
 * process.
 *
 * LT-only. No RTL imports. Reads `staff_users` (authorized: `sql-read staff_users`).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

let failures = 0;
let checks = 0;
function ok(c, l) { checks++; console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; }
function section(t) { console.log(`\n${t}`); }

const settings = require('../src/longterm/ppe/settings');
const admin = require('../src/longterm/ppe/settings-admin');
const store = require('../src/longterm/ppe/store');

// A setting that is company-wide, and one that is per-investor. Both are read from the
// registry rather than assumed, so a registry change makes this suite fail loudly rather
// than silently test nothing.
const COMPANY_KEY = 'validation.price_tolerance_milli';
const INVESTOR_KEY = 'pricing.margin_milli';

(async () => {
  // =========================================================================
  // A — PURE. The target, the key checks, the batch plan. No database.
  // =========================================================================
  section('A. the pure rules — the slot, the keys, the batch');

  const tCompany = admin.parseTarget({ target: 'company' });
  ok(tCompany.ok && tCompany.kind === 'company' && tCompany.scope === 'company',
    'target "company" resolves to the global slot');

  const tInv = admin.parseTarget({ target: 'investor', investor: 'DHVN' });
  ok(tInv.ok && tInv.kind === 'investor' && tInv.scope === 'investor:DHVN' && tInv.investorCode === 'DHVN',
    'target "investor" resolves to scope investor:<code>');

  const tNone = admin.parseTarget({});
  ok(!tNone.ok && tNone.error === 'target_required',
    'a request that does not say WHICH slot is refused — never assumed to mean the global one');

  const tScope = admin.parseTarget({ target: 'company', scope: 'investor:DHVN' });
  ok(!tScope.ok && tScope.error === 'scope_not_accepted',
    'a hand-built scope string is refused outright — the prefix is attached in one place or nowhere');

  const tBoth = admin.parseTarget({ target: 'company', investor: 'DHVN' });
  ok(!tBoth.ok && tBoth.error === 'investor_with_company_target' && /DHVN/.test(tBoth.message),
    'naming an investor while asking for the GLOBAL slot is refused, not silently resolved either way');

  const tNoCode = admin.parseTarget({ target: 'investor' });
  ok(!tNoCode.ok && tNoCode.error === 'investor_required', 'target "investor" with no code is refused');

  ok(!admin.parseTarget({ target: 'investor', investor: 'a:b' }).ok
    && !admin.parseTarget({ target: 'investor', investor: 'a b' }).ok
    && !admin.parseTarget({ target: 'investor', investor: '' }).ok,
  'an investor code carrying a colon, a space, or nothing at all cannot become a scope');

  ok(!admin.parseTarget({ target: 'tenant' }).ok
    && admin.parseTarget({ target: 'tenant' }).error === 'unknown_target:tenant',
  'an unknown target is refused AND named');

  ok(store.investorScope('DHVN') === 'investor:DHVN'
    && store.investorScope('a:b') === null
    && store.investorScope('  ') === null,
  'store.investorScope is the one place the prefix is attached, and it validates the code');

  ok(store.investorCodeOfScope('investor:DHVN') === 'DHVN'
    && store.investorCodeOfScope('company') === null
    && store.investorCodeOfScope('investor:a b') === null,
  'investorCodeOfScope is the exact inverse and applies the same shape test');

  // the per-investor declaration is DERIVED from the registry, never a second list
  const scoped = settings.investorScopedKeys();
  ok(Array.isArray(scoped) && scoped.length > 0 && scoped.every((k) => settings.getDefinition(k)),
    `investorScopedKeys is derived from the registry (${scoped.join(', ')})`);
  ok(scoped.includes(INVESTOR_KEY) && !scoped.includes(COMPANY_KEY),
    'the margin is per-investor; the parity tolerance is not');
  ok(settings.isInvestorScoped(INVESTOR_KEY) === true
    && settings.isInvestorScoped(COMPANY_KEY) === false
    && settings.isInvestorScoped('nope.not.a.key') === false,
  'isInvestorScoped answers for a real key and refuses an unknown one');

  const unknownAtCompany = admin.checkKeyForTarget('company', 'nope.not.a.key');
  ok(unknownAtCompany && unknownAtCompany.error === 'unknown_setting:nope.not.a.key'
    && /nope\.not\.a\.key/.test(unknownAtCompany.message),
  'an unknown key is refused AND NAMED, at the company slot');

  const wrongSlot = admin.checkKeyForTarget('investor', COMPANY_KEY);
  ok(wrongSlot && wrongSlot.error === `not_per_investor:${COMPANY_KEY}` && wrongSlot.message.includes(INVESTOR_KEY),
    'a company-wide key at an investor slot is refused, named, and the answer lists what IS per-investor');

  ok(admin.checkKeyForTarget('investor', INVESTOR_KEY) === null
    && admin.checkKeyForTarget('company', INVESTOR_KEY) === null,
  'a per-investor key is accepted at BOTH slots — the company value is the pre-fill every investor inherits');

  // all-or-nothing
  const mixed = admin.planSet('company', { [COMPANY_KEY]: 5, 'nope.not.a.key': 1 });
  ok(!mixed.ok && mixed.refusals.length === 1 && mixed.refusals[0].key === 'nope.not.a.key'
    && !Object.prototype.hasOwnProperty.call(mixed, 'changes'),
  'a batch carrying ONE bad key is refused whole — no half-apply, and the good key is not smuggled through');

  const badType = admin.planSet('company', { [COMPANY_KEY]: 'quite a lot' });
  ok(!badType.ok && /not_a_number/.test(badType.refusals[0].error) && /must be a number/.test(badType.refusals[0].message),
    'a bad TYPE is refused with both the code and a sentence a person can act on');

  const overMax = admin.planSet('company', { [COMPANY_KEY]: 999999 });
  ok(!overMax.ok && /above_max/.test(overMax.refusals[0].error), 'a value past the registry maximum is refused');

  ok(!admin.planSet('company', {}).ok && !admin.planSet('company', null).ok && !admin.planSet('company', []).ok,
    'an empty / missing / array patch is refused rather than treated as "nothing to do, all good"');

  ok(!admin.planClear('investor', [COMPANY_KEY]).ok
    && admin.planClear('investor', [INVESTOR_KEY]).ok,
  'a clear is scope-checked exactly like a set');

  ok(admin.sameValue(250, 250) && !admin.sameValue(0, false) && admin.sameValue([1, 2], [1, 2]),
    'sameValue compares by MEANING and cannot fall for 0 == false');

  // =========================================================================
  // B — the real router, over real HTTP, against a real Postgres.
  // =========================================================================
  if (!process.env.DATABASE_URL) {
    console.log('\n(HTTP + DB half skipped — set DATABASE_URL to run it.)');
    console.log(`\n${failures ? `${failures} FAILED` : `all ${checks} passed (pure)`}`);
    process.exit(failures ? 1 : 0);
  }

  const db = require('../src/longterm/db');
  const express = require('express');

  // db/579 is idempotent; apply it so the suite runs on a database built before it landed.
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', '579_lt_ppe_setting_change_audit_trail.sql'), 'utf8'));

  const INV = `TESTW${process.pid}`;
  const INV_SCOPE = `investor:${INV}`;
  const TOUCHED_KEYS = [COMPANY_KEY, INVESTOR_KEY];

  // ---- snapshot the company slot so this suite cannot leave it changed ----
  const snapshot = (await db.query(
    'SELECT key, value, updated_by FROM lt_ppe_setting_value WHERE scope = $1 AND key = ANY($2::text[])',
    ['company', TOUCHED_KEYS])).rows;

  // ---- who is signing in ----
  const staff = (await db.query(
    `SELECT id, full_name, email, role FROM staff_users
      WHERE COALESCE(is_external,false) = false AND is_active = true
      ORDER BY CASE WHEN role IN ('super_admin','admin') THEN 0 ELSE 1 END`)).rows;
  const adminUser = staff.find((s) => s.role === 'super_admin' || s.role === 'admin') || null;
  const plainUser = staff.find((s) => s.role !== 'super_admin' && s.role !== 'admin') || null;

  // The stub authenticator builds `req.actor` exactly as `authenticate()` does — { id, kind,
  // role, sid } and NOTHING else. That shape is load-bearing: the route must look the actor's
  // NAME up rather than read a field this object has never carried (the #208 dead-read bug).
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    const id = req.headers['x-test-actor'];
    const role = req.headers['x-test-role'];
    if (id) req.actor = { id: String(id), kind: 'staff', role: String(role || ''), sid: 'test' };
    next();
  });
  app.use('/api/lt/ppe', require('../src/longterm/routes/ppe'));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/lt/ppe`;

  const asUser = (u) => (u ? { 'x-test-actor': u.id, 'x-test-role': u.role } : {});
  async function call(method, url, { user, body } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...asUser(user) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* a non-JSON body is itself the finding */ }
    return { status: res.status, body: json };
  }

  // Re-read ONE setting FROM THE SERVER. Never trusted from a write's own response.
  async function readFromServer(key, investor) {
    const r = await call('GET', `/settings${investor ? `?investor=${encodeURIComponent(investor)}` : ''}`, { user: adminUser });
    if (!r.body || !Array.isArray(r.body.settings)) return null;
    return r.body.settings.find((s) => s.key === key) || null;
  }
  async function auditFor(key, investor) {
    const q = [`key=${encodeURIComponent(key)}`];
    if (investor) q.push(`investor=${encodeURIComponent(investor)}`);
    const r = await call('GET', `/settings/audit?${q.join('&')}`, { user: adminUser });
    return r.body;
  }

  try {
    // start from a known state
    await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1 AND key = ANY($2::text[])', ['company', TOUCHED_KEYS]);
    await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1', [INV_SCOPE]);
    await db.query('DELETE FROM lt_ppe_setting_audit WHERE scope = $1 AND key = ANY($2::text[])', ['company', TOUCHED_KEYS]);
    await db.query('DELETE FROM lt_ppe_setting_audit WHERE scope = $1', [INV_SCOPE]);

    const CODED_DEFAULT = settings.getDefinition(COMPANY_KEY).default;

    section('B. the read says which values are DEFAULTS and which a human set');
    const before = await readFromServer(COMPANY_KEY);
    ok(before && before.value === CODED_DEFAULT && before.source === 'product_default'
      && before.isDefault === true && before.setHere === false,
    'with nothing stored, the setting reads as the SHIPPED DEFAULT and says nobody set it');
    ok(before && before.default === CODED_DEFAULT && before.type === 'number' && before.settable === true,
      'the read carries the registry description (type, the default, settable-here) so a screen needs no key list');

    section('C. the admin gate');
    if (!plainUser) {
      ok(false, 'no non-admin staff row in this database — the gate could not be exercised');
    } else {
      const refused = await call('POST', '/settings', { user: plainUser, body: { target: 'company', settings: { [COMPANY_KEY]: 7 } } });
      ok(refused.status === 403, `a non-admin (${plainUser.role}) is refused with 403`);
      const stillDefault = await readFromServer(COMPANY_KEY);
      ok(stillDefault && stillDefault.value === CODED_DEFAULT && stillDefault.setHere === false,
        'and NOTHING was written — re-read from the server, the setting is still the default');
    }
    const anon = await call('POST', '/settings', { body: { target: 'company', settings: { [COMPANY_KEY]: 7 } } });
    ok(anon.status === 403, 'a caller with no actor at all is refused too');

    if (!adminUser) {
      ok(false, 'no admin staff row in this database — the write half could not be exercised');
    } else {
      section('D. an admin sets a value, and it is re-read FROM THE SERVER');
      const set = await call('POST', '/settings', { user: adminUser, body: { target: 'company', settings: { [COMPANY_KEY]: 5 } } });
      ok(set.status === 200 && set.body.ok === true, 'the write answers 200');
      ok(set.body.applied && set.body.applied[0] && set.body.applied[0].changed === true
        && set.body.applied[0].from === CODED_DEFAULT && set.body.applied[0].value === 5,
      'the answer says what moved, from what to what');

      const landed = await readFromServer(COMPANY_KEY);
      ok(landed && landed.value === 5, 'a SEPARATE read confirms the value actually landed');
      ok(landed && landed.source === 'company' && landed.isDefault === false,
        'and it now reads as a human-set company value, not a default');
      ok(landed && landed.setHere === true && landed.setBy === adminUser.id && landed.setAt,
        'the read says WHO set it and WHEN — a different fact from "which layer won"');

      // The write's OWN answer is a fresh read of the database, not an echo of the request —
      // a screen re-renders from it, and a screen that redraws the values it just sent would
      // show a save that did not happen as a save that did.
      const echoed = (set.body.settings || []).find((s) => s.key === COMPANY_KEY);
      ok(echoed && echoed.value === landed.value && echoed.source === landed.source
        && echoed.setHere === landed.setHere && echoed.setBy === landed.setBy,
      'the write\'s own answer is the state re-read after the commit — it agrees with the separate GET');

      // A REPEAT of the same value is a non-event. This is a different branch from
      // "set it to the default while nothing is stored" (section I) and needs its own case:
      // here a row DOES exist and the value simply has not moved.
      const repeat = await call('POST', '/settings', { user: adminUser, body: { target: 'company', settings: { [COMPANY_KEY]: 5 } } });
      ok(repeat.status === 200 && repeat.body.applied[0].changed === false && repeat.body.applied[0].reason === 'unchanged',
        'sending a stored setting the value it already holds is reported as unchanged, not as a change');
      const repeatTrail = await auditFor(COMPANY_KEY);
      ok(repeatTrail.entries.length === 1,
        'and the trail still holds ONE row — a re-save that moved nothing is never recorded as a change');

      section('E. an unknown key is REFUSED AND NAMED, and nothing else in the batch lands');
      const unknown = await call('POST', '/settings', {
        user: adminUser,
        body: { target: 'company', settings: { [COMPANY_KEY]: 11, 'pricing.not_a_real_knob': 1 } },
      });
      ok(unknown.status === 400, 'an unknown key answers 400');
      ok(JSON.stringify(unknown.body).includes('pricing.not_a_real_knob'),
        'and the refusal NAMES the key — never a silent drop');
      const afterUnknown = await readFromServer(COMPANY_KEY);
      ok(afterUnknown && afterUnknown.value === 5,
        'the GOOD key in that same batch did not land either — the batch is all-or-nothing (re-read from the server)');

      section('F. a bad type and a bad range are refused, and nothing is written');
      const badT = await call('POST', '/settings', { user: adminUser, body: { target: 'company', settings: { [COMPANY_KEY]: 'lots' } } });
      ok(badT.status === 400 && /not_a_number/.test(JSON.stringify(badT.body)), 'a bad TYPE answers 400 naming the problem');
      const badR = await call('POST', '/settings', { user: adminUser, body: { target: 'company', settings: { [COMPANY_KEY]: 999999 } } });
      ok(badR.status === 400 && /above_max/.test(JSON.stringify(badR.body)), 'a value past the registry maximum answers 400');
      const afterBad = await readFromServer(COMPANY_KEY);
      ok(afterBad && afterBad.value === 5, 'and the stored value is untouched — re-read from the server');

      section('G. clearing means "fall back to the default"');
      const cleared = await call('POST', '/settings/clear', { user: adminUser, body: { target: 'company', keys: [COMPANY_KEY] } });
      ok(cleared.status === 200 && cleared.body.applied[0].changed === true
        && cleared.body.applied[0].from === 5 && cleared.body.applied[0].value === CODED_DEFAULT,
      'the clear answers 200 and says what it fell back to');
      const afterClear = await readFromServer(COMPANY_KEY);
      ok(afterClear && afterClear.value === CODED_DEFAULT, 'a separate read confirms the DEFAULT is back');
      ok(afterClear && afterClear.source === 'product_default' && afterClear.isDefault === true && afterClear.setHere === false,
        'and it reads as the shipped default again — not as a human-set value that happens to equal it');

      section('H. the audit trail — who, when, from what to what');
      const trail = await auditFor(COMPANY_KEY);
      ok(trail && trail.available === true && Array.isArray(trail.entries), 'the trail is readable');
      const setRow = (trail.entries || []).find((e) => e.action === 'set');
      const clearRow = (trail.entries || []).find((e) => e.action === 'clear');
      ok(setRow && setRow.from === CODED_DEFAULT && setRow.fromSource === 'product_default'
        && setRow.to === 5 && setRow.toSource === 'stored',
      'the SET is recorded: from the shipped default TO a human-set 5, both ends saying which');
      ok(clearRow && clearRow.from === 5 && clearRow.fromSource === 'stored'
        && clearRow.to === CODED_DEFAULT && clearRow.toSource === 'product_default',
      'the CLEAR is recorded: from the human value BACK to the default, recorded rather than derived');
      ok(setRow && setRow.byId === adminUser.id, 'the change is attributed to the real person');
      ok(setRow && setRow.by === (adminUser.full_name || adminUser.email),
        'and it carries their NAME, looked up rather than read off req.actor (which has never carried one)');
      ok(setRow && setRow.at, 'and WHEN it happened');
      ok(trail.entries.length === 2, 'exactly two rows — one per real change, no padding');

      section('I. a change that moves nothing writes no audit row');
      const noop = await call('POST', '/settings', { user: adminUser, body: { target: 'company', settings: { [COMPANY_KEY]: CODED_DEFAULT } } });
      ok(noop.status === 200 && noop.body.applied[0].changed === false && noop.body.applied[0].reason === 'already_default',
        'setting a key to the value it already resolves to is reported as unchanged');
      const trail2 = await auditFor(COMPANY_KEY);
      ok(trail2.entries.length === 2, 'and the trail is still two rows — a non-event is never recorded as a change');
      const noopClear = await call('POST', '/settings/clear', { user: adminUser, body: { target: 'company', keys: [COMPANY_KEY] } });
      ok(noopClear.status === 200 && noopClear.body.applied[0].changed === false && noopClear.body.applied[0].reason === 'not_set',
        'clearing a setting that is not set is a reported no-op');

      section('J. the per-investor slot is explicit and cannot be got wrong by accident');
      const wrongKey = await call('POST', '/settings', {
        user: adminUser, body: { target: 'investor', investor: INV, settings: { [COMPANY_KEY]: 3 } },
      });
      ok(wrongKey.status === 400 && JSON.stringify(wrongKey.body).includes(COMPANY_KEY),
        'a company-wide setting aimed at ONE investor is refused and the key is named');

      const contradiction = await call('POST', '/settings', {
        user: adminUser, body: { target: 'company', investor: INV, settings: { [INVESTOR_KEY]: 400 } },
      });
      ok(contradiction.status === 400 && contradiction.body.code === 'investor_with_company_target',
        'a request that NAMES an investor while aiming at the GLOBAL slot is refused — a per-investor value cannot land globally by accident');

      const rawScope = await call('POST', '/settings', {
        user: adminUser, body: { target: 'investor', investor: INV, scope: 'company', settings: { [INVESTOR_KEY]: 400 } },
      });
      ok(rawScope.status === 400 && rawScope.body.code === 'scope_not_accepted',
        'and a hand-built scope string is refused at the door');

      const badCode = await call('POST', '/settings', {
        user: adminUser, body: { target: 'investor', investor: 'bad code', settings: { [INVESTOR_KEY]: 400 } },
      });
      ok(badCode.status === 400 && /bad_investor_code/.test(badCode.body.code),
        'an unusable investor code is refused rather than turned into some other scope');

      section('K. the per-investor margin lands in the investor slot and NOWHERE else');
      const invSet = await call('POST', '/settings', {
        user: adminUser, body: { target: 'investor', investor: INV, settings: { [INVESTOR_KEY]: 400 } },
      });
      ok(invSet.status === 200, 'the per-investor write answers 200');

      const invRead = await readFromServer(INVESTOR_KEY, INV);
      ok(invRead && invRead.value === 400 && invRead.source === 'investor' && invRead.setHere === true,
        're-read from the server: the investor slot holds 400 and says the INVESTOR layer won');
      ok(invRead && invRead.companyValue === settings.getDefinition(INVESTOR_KEY).default,
        'and it reports what it falls back TO, so a screen can show both numbers');

      const globalRead = await readFromServer(INVESTOR_KEY);
      ok(globalRead && globalRead.value === settings.getDefinition(INVESTOR_KEY).default
        && globalRead.isDefault === true && globalRead.setHere === false,
      'the GLOBAL slot is untouched — the per-investor value did not leak into the company row');

      const globalRow = (await db.query(
        'SELECT 1 FROM lt_ppe_setting_value WHERE scope = $1 AND key = $2', ['company', INVESTOR_KEY])).rowCount;
      ok(globalRow === 0, 'confirmed straight from the table: no company-scope row was written');

      section('L. the engine that prices with it reads the same slot');
      const mh = await store.resolveMarginHoldbackForInvestor(db, INV, {});
      ok(mh && mh.marginMilli === 400 && mh.defaults.margin.source === 'tenant',
        'the margin/holdback resolver reads the investor override the door just wrote');
      const other = await store.resolveMarginHoldbackForInvestor(db, `NOSUCH${process.pid}`, {});
      ok(other && other.marginMilli === settings.getDefinition(INVESTOR_KEY).default,
        'and another investor still resolves to the company pre-fill');

      // a row for a key the registry does NOT declare per-investor must be ignored by the
      // resolver even when somebody puts it in the table by hand — the write door refuses it,
      // and the read side refuses it too, so the two ends agree by construction.
      await db.query(
        `INSERT INTO lt_ppe_setting_value (scope, key, value) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`,
        [INV_SCOPE, COMPANY_KEY, JSON.stringify(9)]);

      const rawLayer = await store.loadSettingOverrides(db, INV_SCOPE);
      ok(rawLayer[COMPANY_KEY] === 9 && rawLayer[INVESTOR_KEY] === 400,
        'the hand-written row really is in the table (so the next assertion is about the FILTER, not about an empty read)');
      const layer = await store.loadInvestorOverrides(db, INV);
      ok(!Object.prototype.hasOwnProperty.call(layer, COMPANY_KEY) && layer[INVESTOR_KEY] === 400,
        'the investor LAYER the engine reads drops it — the read side asks the same registry declaration the write door does');

      const stillOk = await store.resolveMarginHoldbackForInvestor(db, INV, {});
      ok(stillOk.marginMilli === 400,
        'so a hand-written investor row for a key the registry does not declare per-investor changes no price');
      const invSettings = await call('GET', `/settings?investor=${INV}`, { user: adminUser });
      const smuggled = (invSettings.body.settings || []).find((s) => s.key === COMPANY_KEY);
      ok(smuggled && smuggled.source !== 'investor' && smuggled.setHere === false && smuggled.settable === false,
        'and the screen shows it as a COMPANY value that is not settable here, never as this investor\'s own');
      ok(smuggled && smuggled.ignoredHere === true,
        'while SAYING out loud that a stored row for it exists at this slot and nothing reads it — never silently');
      await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1 AND key = $2', [INV_SCOPE, COMPANY_KEY]);

      section('M. the investor change is audited under the investor slot');
      const invTrail = await auditFor(INVESTOR_KEY, INV);
      ok(invTrail.available === true && invTrail.entries.length === 1
        && invTrail.entries[0].to === 400 && invTrail.entries[0].byId === adminUser.id,
      'the per-investor change is on the trail');
      ok(invTrail.target.scope === INV_SCOPE, 'and the trail is scoped to investor:<code>, not to the company');
      const companyTrail = await auditFor(INVESTOR_KEY);
      ok((companyTrail.entries || []).length === 0,
        'the company trail for that key is empty — the two slots keep separate histories');

      section('N. the audit read refuses an unknown key rather than answering an empty history');
      const badKeyAudit = await call('GET', '/settings/audit?key=nope.not.a.key', { user: adminUser });
      ok(badKeyAudit.status === 400 && /nope\.not\.a\.key/.test(JSON.stringify(badKeyAudit.body)),
        'an unknown key on the audit read is refused and named — an empty list would read as "nothing ever changed"');

      section('O. the audit read is open to any staff member');
      if (plainUser) {
        const r = await call('GET', '/settings/audit', { user: plainUser });
        ok(r.status === 200, 'a non-admin can READ the trail (knowing why a price moved is not a privilege)');
      }
      const canWriteAdmin = (await call('GET', '/settings', { user: adminUser })).body.canWrite;
      const canWritePlain = plainUser ? (await call('GET', '/settings', { user: plainUser })).body.canWrite : false;
      ok(canWriteAdmin === true && canWritePlain === false,
        'and the read tells a screen whether THIS person may write, so a control is never offered that the server would refuse');
    }
  } finally {
    // ---- put the company slot back exactly as it was ----
    try {
      await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1 AND key = ANY($2::text[])', ['company', TOUCHED_KEYS]);
      for (const row of snapshot) {
        await db.query(
          'INSERT INTO lt_ppe_setting_value (scope, key, value, updated_by) VALUES ($1,$2,$3::jsonb,$4)',
          ['company', row.key, JSON.stringify(row.value), row.updated_by]);
      }
      await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1', [INV_SCOPE]);
      await db.query('DELETE FROM lt_ppe_setting_audit WHERE scope = $1 AND key = ANY($2::text[])', ['company', TOUCHED_KEYS]);
      await db.query('DELETE FROM lt_ppe_setting_audit WHERE scope = $1', [INV_SCOPE]);
    } catch (e) {
      console.error('cleanup failed:', (e && e.message) || e);
    }
    await new Promise((r) => server.close(r));
    await db.pool.end();
  }

  console.log(`\n${failures ? `${failures} FAILED of ${checks}` : `all ${checks} passed`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
