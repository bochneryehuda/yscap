'use strict';
/**
 * FIDELIS flood-certificate exclusion + flood-zone ADVISORY (owner-directed 2026-07-27).
 *
 * The governing sentence: "if it's a flood zone you should FORCE this condition on, but as
 * long as you don't have evidence that it's a flood zone you should IGNORE this condition."
 * So on a Fidelis file the FLOOD ZONE is the decider, not the capital partner.
 *
 * Proves the three halves of that:
 *   (A) THE EXCLUSION — with NO flood-zone evidence, db/335's rule keeps the internal flood
 *       cert (rtl_cond_flood) OFF a Fidelis file under every branch that used to force it on
 *       (Gold, Manual), for every Fidelis label spelling, and retracts one already sitting
 *       there; a PROVEN flood zone FORCES it on, Fidelis included. Blue Lake / CorrFirst /
 *       Gold / a blank note buyer are unchanged.
 *   (B) THE ADVISORY — the backstop for the two states the engine cannot fix itself: a flood
 *       zone with NO condition on the file (one-click "create the condition"), and a flood
 *       zone with the condition present but still OPTIONAL. It stays silent / withdraws
 *       itself in every case where neither is true (no appraisal, a non-A/V zone, a REQUIRED
 *       condition already on the file, a settled one, the note buyer changed away, a human
 *       already decided, a frozen file).
 *   (C) THE BACK-DATE — a flood cert a human already touched on a Fidelis file with no flood
 *       zone is made OPTIONAL by db/335 §3 and really can be signed off through the real
 *       endpoint with NOTHING attached; on a file that IS in a flood zone §4 forces it back
 *       to REQUIRED and the endpoint refuses an empty sign-off.
 *
 * The pure assertions always run. The rest requires DATABASE_URL with migrations applied and
 * skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-fidelis-flood-advisory-db.js
 */

const reg = require('../src/lib/conditions/field-registry');
const rules = require('../src/lib/conditions/rules');
const adv = require('../src/lib/underwriting/fidelis-flood-advisory');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---------------------------------------------------------------- PURE ------
// Every Fidelis spelling resolves, and nothing else does. This is the whole reason the
// exclusion is keyed on a boolean instead of `note_buyer <> 'fidelis'`: the owner's own
// ClickUp label ("Fidelis Investors LLC") normalizes to `fidelisinvestorsllc`, so an enum
// comparison against 'fidelis' would have silently missed every one of their files.
// PREFIX matching (owner-reported 2026-07-27). The enumerated alias list this replaced
// missed real labels one character off — "Fidelis Investor LLC", singular — and those
// files kept a flood certificate they should not have had. A list can only cover the
// spellings someone thought of; there is no bound on how a human types a company name.
for (const label of ['Fidelis', 'fidelis', 'FIDELIS', 'Fidelis Investors', 'Fidelis Investors LLC',
                     'fidelis investors llc', 'FIDELIS INVESTORS, LLC', ' Fidelis  Investors  LLC ',
                     'Fidelis Investor LLC', 'Fidelis Investments LLC', 'Fidelis Capital Partners',
                     'Fidelis Investors, L.L.C.', 'FidelisInvestors']) {
  assert(reg.isFidelisNoteBuyer(label) === true, `isFidelisNoteBuyer("${label}") = true`);
}
// The near-miss that MUST NOT match: Fidelity National is a title insurer, not our
// capital partner. It diverges at the 6th character (fidelit… vs fidelis…).
for (const label of ['Blue Lake', 'CorrFirst', 'EMCAP', 'Fidelity National', 'Fidelity National Title',
                     'Fidelity', '', null, undefined, 'BlueLake Capital', 'Fid', 'Delis Fidelis']) {
  assert(reg.isFidelisNoteBuyer(label) === false, `isFidelisNoteBuyer(${JSON.stringify(label)}) = false`);
}
// The shared normalizer must stay EXACT — a fuzzy normNoteBuyer would let "BlueLake Capital"
// export the Blue Lake data tape (tapes/buyer-rule.js exportGate).
assert(reg.normNoteBuyer('Fidelis Investors LLC') === 'fidelisinvestorsllc',
  'normNoteBuyer is still exact (Fidelis Investors LLC -> fidelisinvestorsllc, NOT fidelis)');
assert(reg.normNoteBuyer('BlueLake Capital') === 'bluelakecapital',
  'normNoteBuyer still does NOT suffix-fuzzy-match (BlueLake Capital stays its own key)');

assert(!!reg.BY_KEY.note_buyer_is_fidelis && reg.BY_KEY.note_buyer_is_fidelis.type === 'boolean',
  'note_buyer_is_fidelis is a registered BOOLEAN rule field');
assert((rules.OPERATORS_BY_TYPE.boolean || []).includes('is_false'),
  'the boolean type supports is_false (the operator db/335 rule uses)');

// SFHA test — A*/V* is a Special Flood Hazard Area, anything else is not.
for (const z of ['A', 'AE', 'AO', 'A99', 'V', 'VE', ' ae ', 'v']) assert(adv.isSfhaZone(z) === true, `isSfhaZone("${z}") = true`);
for (const z of ['X', 'C', 'D', 'B', '', null, undefined]) assert(adv.isSfhaZone(z) === false, `isSfhaZone(${JSON.stringify(z)}) = false`);

// The advisory body names WHERE the flood zone was seen — the two sources the owner named.
assert(/FEMA flood map \(zone AE\)/.test(adv.whereFound({ sources: ['fema'], femaZone: 'AE' })),
  'whereFound names the FEMA flood map + zone');
assert(/appraisal report \(zone AO\)/.test(adv.whereFound({ sources: ['appraisal'], appraisalZone: 'AO' })),
  'whereFound names the appraisal report + zone');
assert(/FEMA flood map \(zone AE\) and the appraisal report \(zone AO\)/.test(
  adv.whereFound({ sources: ['fema', 'appraisal'], femaZone: 'AE', appraisalZone: 'AO' })),
  'whereFound names BOTH sources when both agree');

if (!process.env.DATABASE_URL) {
  console.log('SKIP db-backed fidelis-flood-advisory tests (no DATABASE_URL)');
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS (pure only)');
  process.exit(failures ? 1 : 0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const { ensureSchema } = require('../src/migrate-boot');
const engine = require('../src/lib/conditions/engine');

const FLOOD = 'rtl_cond_flood';

const floodCount = async (appId) => (await db.query(
  `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2`, [appId, FLOOD])).rows[0].n;

const floodItem = async (appId) => (await db.query(
  `SELECT ci.* FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2 LIMIT 1`, [appId, FLOOD])).rows[0];

const openAdvisories = async (appId) => (await db.query(
  `SELECT * FROM ai_suggestions
    WHERE application_id=$1 AND source=$2 AND status='open' ORDER BY created_at`,
  [appId, adv.SOURCE])).rows;

const allAdvisories = async (appId) => (await db.query(
  `SELECT * FROM ai_suggestions WHERE application_id=$1 AND source=$2 ORDER BY created_at`,
  [appId, adv.SOURCE])).rows;

async function setProgram(appId, program) {
  await db.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);
  await db.query(
    `INSERT INTO product_registrations (application_id, program, status, total_loan, inputs, quote, is_current)
     VALUES ($1,$2,'ELIGIBLE',175000,'{}'::jsonb,'{}'::jsonb,true)`, [appId, program]);
}

/** Attach a flood-cert item straight from its template (bypassing the rule) to set up a fixture. */
async function attachFlood(appId, over = {}) {
  const r = await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, application_id, label, audience, item_kind, role_scope, phase,
        status, is_required, origin_kind, notes)
     SELECT t.id, t.scope, $1, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, 'outstanding', COALESCE($2, true), $3, $4
       FROM checklist_templates t WHERE t.code=$5 RETURNING id`,
    [appId, over.is_required === undefined ? null : over.is_required,
     over.origin_kind || 'auto', over.notes || null, FLOOD]);
  return r.rows[0].id;
}

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  await ensureSchema();
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId, adminId, deciderId, server;
  const mkApp = async (lender, status = 'processing') => (await db.query(
    `INSERT INTO applications (borrower_id, status, loan_type, lender) VALUES ($1,$2,'Fix & Flip',$3) RETURNING id`,
    [borrowerId, status, lender])).rows[0].id;
  const sfha = async (appId, cols = { fema_flood_sfha: true }) => db.query(
    `INSERT INTO appraisals (application_id, superseded, fema_flood_sfha, fema_flood_zone, flood_zone)
     VALUES ($1,false,$2,$3,$4)`,
    [appId, cols.fema_flood_sfha === undefined ? null : cols.fema_flood_sfha,
     cols.fema_flood_zone || null, cols.flood_zone || null]);

  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Fidelis','Flood',$1) RETURNING id`,
      [`ff-${sfx}@test.local`])).rows[0].id;

    // ---------------------------------------------------------------------
    // (0) The LIVE template rule in the database — not a mirror of it — carries the
    //     Fidelis exclusion. If db/335 were ever reverted or overwritten by a later
    //     migration, this is the assertion that catches it.
    // ---------------------------------------------------------------------
    const tpl = (await db.query(
      `SELECT auto_apply, rule_logic, is_active FROM checklist_templates WHERE code=$1`, [FLOOD])).rows[0];
    assert(!!tpl && tpl.auto_apply === 'rules' && tpl.is_active === true, 'rtl_cond_flood is an active rule-driven template');
    assert(rules.validateRule(tpl.rule_logic).length === 0, 'the live flood rule VALIDATES against the field registry');
    const fields = await reg.fieldMap(db);
    const ev = (ctx) => rules.evaluateRule(tpl.rule_logic, Object.assign({ note_buyer_is_fidelis: false }, ctx), fields);
    assert(ev({ registered_program: 'gold' }) === true, 'live rule: Gold (no note buyer) still requires the flood cert');
    assert(ev({ registered_program: 'standard', in_flood_zone: true }) === true, 'live rule: a known flood zone still requires it');
    assert(ev({ registered_program: 'standard', note_buyer: 'bluelake' }) === true, 'live rule: Blue Lake still requires it');
    assert(ev({ registered_program: 'standard', note_buyer: 'corrfirst' }) === true, 'live rule: CorrFirst still requires it');
    assert(ev({ registered_program: 'gold', note_buyer_is_fidelis: true }) === false,
      'live rule: Fidelis + Gold + no flood-zone evidence => NO flood cert (ignored)');
    assert(ev({ registered_program: 'standard', note_buyer_is_fidelis: true }) === false,
      'live rule: Fidelis + Standard + no flood-zone evidence => NO flood cert (ignored)');
    // The governing sentence: a PROVEN flood zone forces it on, Fidelis included.
    assert(ev({ registered_program: 'standard', in_flood_zone: true, note_buyer_is_fidelis: true }) === true,
      'live rule: Fidelis + FLOOD ZONE => flood cert IS required (the flood zone forces it on)');
    assert(ev({ registered_program: 'gold', in_flood_zone: true, note_buyer_is_fidelis: true }) === true,
      'live rule: Fidelis + Gold + FLOOD ZONE => flood cert IS required');

    // ---------------------------------------------------------------------
    // (A) THE EXCLUSION, through the real engine.
    // ---------------------------------------------------------------------
    // The engine's rule context recognizes the owner's actual ClickUp label.
    const llcFile = await mkApp('Fidelis Investors LLC');
    const loaded = await engine.loadRuleContext(llcFile);
    assert(loaded && loaded.ctx.note_buyer === 'fidelisinvestorsllc', 'ctx.note_buyer keeps the exact normalized label');
    assert(loaded && loaded.ctx.note_buyer_is_fidelis === true, 'ctx.note_buyer_is_fidelis is TRUE for "Fidelis Investors LLC"');
    const blankFile = await mkApp(null);
    const blankCtx = await engine.loadRuleContext(blankFile);
    assert(blankCtx && blankCtx.ctx.note_buyer_is_fidelis === false,
      'ctx.note_buyer_is_fidelis is a concrete FALSE (never null) on a file with no note buyer');

    // With NO flood-zone evidence, a Fidelis file gets nothing — under every branch that
    // used to force the cert on.
    for (const [label, program] of [
      ['Fidelis', 'standard'],
      ['Fidelis Investors LLC', 'gold'],
      ['Fidelis Investors', 'manual'],
      ['Fidelis Investments LLC', 'gold'],
    ]) {
      const a = await mkApp(label);
      await setProgram(a, program);
      await engine.evaluateApplication(a, { reason: 'test', notify: false });
      assert((await floodCount(a)) === 0,
        `"${label}" + ${program} + no flood-zone evidence => NO flood cert condition`);
    }

    // …and a PROVEN flood zone FORCES it on, Fidelis included, REQUIRED — the governing
    // sentence. Each of the three evidence sources on its own is enough.
    for (const [label, program, cols, what] of [
      ['Fidelis Investors LLC', 'standard', { fema_flood_sfha: true }, 'the FEMA SFHA flag'],
      ['Fidelis Investors LLC', 'gold', { fema_flood_zone: 'AE' }, 'a FEMA-mapped AE zone'],
      ['Fidelis', 'standard', { flood_zone: 'VE' }, "the appraiser's stated VE zone"],
    ]) {
      const a = await mkApp(label);
      await setProgram(a, program);
      await sfha(a, cols);
      await engine.evaluateApplication(a, { reason: 'test', notify: false });
      assert((await floodCount(a)) === 1,
        `"${label}" + ${program} + ${what} => flood cert IS attached (the flood zone forces it on)`);
      const it = await floodItem(a);
      assert(it && it.is_required === true, `…and it is REQUIRED (${what})`);
      // Nothing left to advise — the engine already did the right thing.
      assert((await adv.syncFidelisFloodAdvisory(db, a)).reason === 'condition_present',
        `…and the advisory stays quiet (${what})`);
    }

    // A concrete NOT-in-a-flood-zone determination is not evidence → still ignored.
    const zoneXfile = await mkApp('Fidelis Investors LLC');
    await setProgram(zoneXfile, 'gold');
    await sfha(zoneXfile, { fema_flood_sfha: false, fema_flood_zone: 'X', flood_zone: 'X' });
    await engine.evaluateApplication(zoneXfile, { reason: 'test', notify: false });
    assert((await floodCount(zoneXfile)) === 0,
      'Fidelis + Gold + a determination saying zone X => still NO flood cert (X is not evidence of a flood zone)');

    // A flood zone appearing LATER attaches it (the appraisal-import path re-runs the engine).
    const later = await mkApp('Fidelis Investors LLC');
    await setProgram(later, 'gold');
    await engine.evaluateApplication(later, { reason: 'test', notify: false });
    assert((await floodCount(later)) === 0, 'Fidelis + Gold starts with no flood cert');
    await sfha(later, { fema_flood_sfha: true, fema_flood_zone: 'AO' });
    await engine.evaluateApplication(later, { reason: 'test', notify: false });
    assert((await floodCount(later)) === 1, 'a flood zone found LATER attaches the flood cert to the Fidelis file');
    // …and it retracts again if that appraisal is superseded and no evidence remains.
    await db.query(`UPDATE appraisals SET superseded=true WHERE application_id=$1`, [later]);
    await engine.evaluateApplication(later, { reason: 'test', notify: false });
    assert((await floodCount(later)) === 0, 'and retracts (untouched) once the flood-zone evidence is gone again');

    // No regression for anyone else.
    for (const [label, program, floodZone, want] of [
      ['Blue Lake', 'standard', false, 1],
      ['CorrFirst', 'standard', false, 1],
      [null, 'gold', false, 1],
      [null, 'manual', false, 1],
      ['EMCAP', 'standard', true, 1],
      ['EMCAP', 'standard', false, 0],
      [null, 'standard', false, 0],
      [null, 'standard', true, 1],
      ['Fidelity National', 'gold', false, 1],   // a look-alike name is NOT Fidelis
    ]) {
      const a = await mkApp(label);
      await setProgram(a, program);
      if (floodZone) await sfha(a);
      await engine.evaluateApplication(a, { reason: 'test', notify: false });
      assert((await floodCount(a)) === want,
        `${label || 'no note buyer'} + ${program}${floodZone ? ' + flood zone' : ''} => ${want} flood cert (unchanged)`);
    }

    // Retraction: a Gold file that legitimately HAS the cert loses it (untouched) the moment
    // the note buyer becomes Fidelis — this is the back-date path for live files.
    const flip = await mkApp(null);
    await setProgram(flip, 'gold');
    await engine.evaluateApplication(flip, { reason: 'test', notify: false });
    assert((await floodCount(flip)) === 1, 'Gold file starts with the flood cert');
    await db.query(`UPDATE applications SET lender='Fidelis Investors LLC' WHERE id=$1`, [flip]);
    await engine.evaluateApplication(flip, { reason: 'test', notify: false });
    assert((await floodCount(flip)) === 0, 'the flood cert RETRACTS (untouched) when the note buyer becomes Fidelis');
    // …and comes back if the file turns out not to be Fidelis after all.
    await db.query(`UPDATE applications SET lender='Blue Lake' WHERE id=$1`, [flip]);
    await engine.evaluateApplication(flip, { reason: 'test', notify: false });
    assert((await floodCount(flip)) === 1, 'and re-attaches when the note buyer moves off Fidelis');

    // A TOUCHED flood cert is never silently deleted — an underwriter waives it.
    const touched = await mkApp(null);
    await setProgram(touched, 'gold');
    await engine.evaluateApplication(touched, { reason: 'test', notify: false });
    await db.query(
      `UPDATE checklist_items SET notes='processor asked the title company for this'
        WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code=$2)`,
      [touched, FLOOD]);
    await db.query(`UPDATE applications SET lender='Fidelis Investors LLC' WHERE id=$1`, [touched]);
    await engine.evaluateApplication(touched, { reason: 'test', notify: false });
    assert((await floodCount(touched)) === 1, 'a TOUCHED flood cert is left standing on a Fidelis file (never silently deleted)');

    // ---------------------------------------------------------------------
    // (B) THE ADVISORY.
    // ---------------------------------------------------------------------
    // FEMA SFHA flag → raised, once, with the one-click action wired.
    const femaFile = await mkApp('Fidelis Investors LLC');
    await sfha(femaFile, { fema_flood_sfha: true, fema_flood_zone: 'AE' });
    let r = await adv.syncFidelisFloodAdvisory(db, femaFile);
    assert(r.reason === 'raised' && r.raised === 1, 'Fidelis + FEMA SFHA => advisory RAISED');
    let rows = await openAdvisories(femaFile);
    assert(rows.length === 1, 'exactly ONE open advisory row');
    const s = rows[0];
    assert(s.kind === 'condition', "advisory kind is 'condition' (the panel offers the create-condition action)");
    assert(s.severity === 'warning', 'advisory severity is WARNING, not fatal (no fatal-finding email blast)');
    assert(s.important === true, 'advisory is marked important (pinned to the top of the AI panel)');
    assert((s.proposed_action || {}).type === 'attach_condition', "proposed_action.type is 'attach_condition'");
    assert((s.proposed_action || {}).templateCode === FLOOD, 'proposed_action.templateCode is rtl_cond_flood (the decide route reads this)');
    assert(((s.proposed_action || {}).fields || {}).opensCondition === FLOOD,
      'proposed_action.fields.opensCondition is rtl_cond_flood (the app-v2 panel reads this)');
    assert(/flood zone/i.test(s.title) && /FEMA flood map \(zone AE\)/.test(s.body || ''),
      'advisory names the flood zone and where it was found');
    assert(!/fidelis/i.test(s.title) && !/fidelis/i.test(s.body || ''),
      'advisory wording says "this capital partner", never the note buyer name');
    // Re-running is a no-op refresh, never a second row.
    r = await adv.syncFidelisFloodAdvisory(db, femaFile);
    assert((await openAdvisories(femaFile)).length === 1, 're-running the advisory does NOT create a second row (dedupe)');
    // The advisory NEVER creates the condition itself (governing HARD RULE).
    assert((await floodCount(femaFile)) === 0, 'the advisory created NO condition on its own');

    // The appraiser's OWN stated zone is enough — no FEMA call involved.
    const apprFile = await mkApp('Fidelis');
    await sfha(apprFile, { fema_flood_sfha: null, flood_zone: 'AO' });
    r = await adv.syncFidelisFloodAdvisory(db, apprFile);
    assert(r.reason === 'raised', 'Fidelis + the APPRAISAL\'s stated A/V zone => advisory RAISED');
    assert(/appraisal report \(zone AO\)/.test((await openAdvisories(apprFile))[0].body || ''),
      'the advisory names the appraisal report as the source');

    // A FEMA-mapped A/V zone with the flag unset also counts.
    const femaZoneOnly = await mkApp('Fidelis Investors');
    await sfha(femaZoneOnly, { fema_flood_sfha: null, fema_flood_zone: 'VE' });
    assert((await adv.syncFidelisFloodAdvisory(db, femaZoneOnly)).reason === 'raised',
      'a FEMA-mapped V zone (flag unset) => advisory RAISED');

    // NEVER GUESSED: nothing to read, or a concrete not-in-a-flood-zone determination.
    const noAppr = await mkApp('Fidelis Investors LLC');
    assert((await adv.syncFidelisFloodAdvisory(db, noAppr)).reason === 'no_flood_zone',
      'NO appraisal => no advisory (a flood zone is never guessed)');
    const zoneX = await mkApp('Fidelis Investors LLC');
    await sfha(zoneX, { fema_flood_sfha: false, fema_flood_zone: 'X', flood_zone: 'X' });
    assert((await adv.syncFidelisFloodAdvisory(db, zoneX)).reason === 'no_flood_zone',
      'a concrete NOT-in-SFHA determination (zone X) => no advisory');
    assert((await allAdvisories(zoneX)).length === 0, 'and no row of any status was written');

    // Not a Fidelis file → not our advisory, and a leftover one is withdrawn.
    const bl = await mkApp('Blue Lake');
    await sfha(bl);
    assert((await adv.syncFidelisFloodAdvisory(db, bl)).reason === 'not_fidelis',
      'a Blue Lake file in a flood zone raises NO Fidelis advisory (it gets the real condition)');
    assert((await allAdvisories(bl)).length === 0, 'and writes no row at all');

    // Withdraws itself when the note buyer moves off Fidelis.
    await db.query(`UPDATE applications SET lender='Blue Lake' WHERE id=$1`, [femaFile]);
    r = await adv.syncFidelisFloodAdvisory(db, femaFile);
    assert(r.reason === 'not_fidelis' && r.retracted === 1, 'the advisory WITHDRAWS when the note buyer moves off Fidelis');
    let closed = (await allAdvisories(femaFile))[0];
    assert(closed.status === 'dismissed' && /no longer Fidelis/.test(closed.status_reason || ''),
      'the withdrawal records WHY it closed');

    // Withdraws itself when the flood signal goes away (a re-imported appraisal).
    const gone = await mkApp('Fidelis Investors LLC');
    await sfha(gone);
    await adv.syncFidelisFloodAdvisory(db, gone);
    assert((await openAdvisories(gone)).length === 1, 'advisory open while the flood zone is known');
    await db.query(`UPDATE appraisals SET superseded=true WHERE application_id=$1`, [gone]);
    r = await adv.syncFidelisFloodAdvisory(db, gone);
    assert(r.reason === 'no_flood_zone' && r.retracted === 1, 'the advisory WITHDRAWS when the flood zone is no longer on the current appraisal');

    // Withdraws itself once a REQUIRED flood condition IS on the file (nothing left to advise).
    const posted = await mkApp('Fidelis Investors LLC');
    await sfha(posted);
    await adv.syncFidelisFloodAdvisory(db, posted);
    assert((await openAdvisories(posted)).length === 1, 'advisory open before the condition is created');
    await attachFlood(posted, { origin_kind: 'manual_library', notes: 'opened from the advisory' });
    r = await adv.syncFidelisFloodAdvisory(db, posted);
    assert(r.reason === 'condition_present' && r.retracted === 1,
      'the advisory WITHDRAWS once a flood certificate condition is on the file');

    // A SETTLED flood cert (signed off / waived) never gets nagged about again.
    for (const [col, name] of [['signed_off_at', 'signed off'], ['waived_at', 'waived']]) {
      const settled = await mkApp('Fidelis Investors LLC');
      await sfha(settled);
      const sid = await attachFlood(settled, { is_required: false, notes: 'handled' });
      await db.query(`UPDATE checklist_items SET ${col}=now() WHERE id=$1`, [sid]);
      assert((await adv.syncFidelisFloodAdvisory(db, settled)).reason === 'condition_present',
        `a ${name} flood cert on a Fidelis file in a flood zone raises no advisory (settled work is never nagged)`);
    }

    // THE GAP THIS CLOSES: db/335 downgrades a touched flood cert to OPTIONAL while no flood
    // zone is known. If a flood zone turns up LATER, that optional condition could be signed
    // off with nothing attached and nobody told — so it gets its own advisory.
    const optOpen = await mkApp('Fidelis Investors LLC');
    const optItem = await attachFlood(optOpen, { is_required: false, notes: 'made optional earlier' });
    assert((await adv.syncFidelisFloodAdvisory(db, optOpen)).reason === 'no_flood_zone',
      'an OPTIONAL flood cert with no flood zone raises nothing (the normal Fidelis state)');
    await sfha(optOpen, { fema_flood_sfha: true, fema_flood_zone: 'AE' });
    r = await adv.syncFidelisFloodAdvisory(db, optOpen);
    assert(r.reason === 'raised_optional' && r.raised === 1,
      'a flood zone found while the flood cert sits OPTIONAL => advisory RAISED');
    rows = await openAdvisories(optOpen);
    assert(rows.length === 1 && rows[0].kind === 'info',
      "the optional-condition advisory is kind 'info' (no create button — a second condition is the wrong move)");
    assert(rows[0].checklist_item_id === optItem, 'it is attached to the optional condition itself');
    assert(/marked OPTIONAL/.test(rows[0].body || '') && /mark it required/.test(rows[0].body || ''),
      'it tells the processor exactly what to do');
    assert(!(rows[0].proposed_action || {}).templateCode,
      'and carries NO templateCode, so nothing can create a duplicate flood condition from it');
    // Marking it required resolves the advisory on its own.
    await db.query(`UPDATE checklist_items SET is_required=true WHERE id=$1`, [optItem]);
    r = await adv.syncFidelisFloodAdvisory(db, optOpen);
    assert(r.reason === 'condition_present' && r.retracted === 1,
      'marking the condition required WITHDRAWS the advisory');

    // …and PILOT's own per-condition advisory overlay must not badge an OPTIONAL flood cert
    // "not ready" — that contradicts what optional means, and it is the state db/335 leaves a
    // touched flood cert in on a Fidelis file. Same rule the title/insurance contacts use.
    const advice = require('../src/lib/underwriting/pilot-advice-engine');
    const pilotAdvice = async (itemId) => (await db.query(
      `SELECT pilot_advice FROM checklist_items WHERE id=$1`, [itemId])).rows[0].pilot_advice;
    const badge = await mkApp('Fidelis Investors LLC');
    const reqItem = await attachFlood(badge, { notes: 'required one' });
    await advice.runFileAdvice(db, badge);
    assert((await pilotAdvice(reqItem)) === 'not_ready',
      'PILOT still badges a REQUIRED flood cert with no determination read "not_ready"');
    await db.query(`UPDATE checklist_items SET is_required=false WHERE id=$1`, [reqItem]);
    await advice.runFileAdvice(db, badge);
    assert((await pilotAdvice(reqItem)) === null,
      'PILOT lays NO advice on an OPTIONAL flood cert (the badge is cleared, not left stale)');

    // A HUMAN'S DECISION IS FINAL — a dismissed advisory must never come back. Without this
    // guard aiSug.record would INSERT a fresh open row on the very next file view, forever.
    // The check lives in the shared aiSug.record chokepoint (db/333), and it keys on
    // decided_by_staff_id, so the dismissal has to carry a real staffer.
    deciderId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Flood Decider','underwriter',true,false,'x',0) RETURNING id`,
      [`ff-dec-${sfx}@test.local`])).rows[0].id;
    const dismissed = await mkApp('Fidelis Investors LLC');
    await sfha(dismissed);
    await adv.syncFidelisFloodAdvisory(db, dismissed);
    const dRow = (await openAdvisories(dismissed))[0];
    await db.query(
      `UPDATE ai_suggestions SET status='dismissed', status_reason='not needed',
              decided_at=now(), decided_by_staff_id=$2 WHERE id=$1`, [dRow.id, deciderId]);
    r = await adv.syncFidelisFloodAdvisory(db, dismissed);
    assert(r.reason === 'decided_by_human' && r.raised === 0, 'a DISMISSED advisory is never re-raised');
    assert((await allAdvisories(dismissed)).length === 1, 'and no duplicate row is inserted');

    // REGRESSION (found when main's durable-decision chokepoint landed): an AUTOMATIC
    // withdrawal must NOT read as a human decision. retract() closes the row as 'dismissed'
    // with NO decided_by_staff_id, so a module-local `status <> 'open'` check would have
    // silenced this file forever — a flood zone reappearing on a new appraisal would never be
    // announced again. The chokepoint keys on decided_by_staff_id, which is why the check now
    // lives there and not here.
    const revived = await mkApp('Fidelis Investors LLC');
    await sfha(revived, { flood_zone: 'AE' });
    assert((await adv.syncFidelisFloodAdvisory(db, revived)).reason === 'raised', 'advisory raised the first time');
    await db.query(`UPDATE appraisals SET superseded=true WHERE application_id=$1`, [revived]);
    r = await adv.syncFidelisFloodAdvisory(db, revived);
    assert(r.reason === 'no_flood_zone' && r.retracted === 1, 'auto-withdrawn when the flood zone goes');
    assert((await allAdvisories(revived))[0].decided_by_staff_id === null,
      'the automatic withdrawal records NO deciding staffer (that is what distinguishes it)');
    // A new appraisal shows a flood zone again → it MUST come back.
    await sfha(revived, { fema_flood_sfha: true, fema_flood_zone: 'AO' });
    r = await adv.syncFidelisFloodAdvisory(db, revived);
    assert(r.reason === 'raised' && r.raised === 1,
      'a flood zone reappearing after an AUTOMATIC withdrawal raises the advisory again');
    assert((await openAdvisories(revived)).length === 1, 'and exactly one open row exists');

    // A frozen file (funded / terminal) gets nothing.
    const funded = await mkApp('Fidelis Investors LLC', 'funded');
    await sfha(funded);
    assert((await adv.syncFidelisFloodAdvisory(db, funded)).reason === 'file_frozen',
      'a FUNDED file raises no advisory');
    assert((await allAdvisories(funded)).length === 0, 'and writes no row');

    // ---------------------------------------------------------------------
    // (C) THE BACK-DATE — db/335 §2/§3/§4 on files that already carry the condition, and
    //     "optional" really meaning signable with nothing attached.
    // ---------------------------------------------------------------------
    // Untouched, no flood zone → §2's DELETE removes it outright.
    const bdGone = await mkApp('Fidelis Investors LLC');
    await attachFlood(bdGone);
    // Untouched but IN a flood zone → §2 must NOT remove it (the flood zone forces it on).
    const bdGoneFz = await mkApp('Fidelis Investors LLC');
    await attachFlood(bdGoneFz);
    await sfha(bdGoneFz, { flood_zone: 'AE' });
    // Touched, no flood zone → §3 makes it optional.
    const bdOpt = await mkApp('Fidelis Investors LLC');
    const bdOptItem = await attachFlood(bdOpt, { notes: 'chased the title company on 7/14' });
    // Touched, IN a flood zone → §3 skips it, so it stays REQUIRED.
    const bdKeep = await mkApp('Fidelis Investors LLC');
    const bdKeepItem = await attachFlood(bdKeep, { notes: 'ordered the determination' });
    await sfha(bdKeep, { fema_flood_sfha: true, fema_flood_zone: 'AE' });
    // ALREADY OPTIONAL and IN a flood zone → §4 forces it back to REQUIRED. This is the
    // drift case: §3 downgraded it on an earlier deploy, then a flood zone turned up. The
    // engine can never fix it (duplicate suppression + it never rewrites is_required), so
    // without §4 a Fidelis file could sit in a flood zone with a signable-empty flood cert.
    const bdForce = await mkApp('Fidelis Investors LLC');
    const bdForceItem = await attachFlood(bdForce, {
      is_required: false,
      notes: 'note from the processor\n\n[auto] Optional on this file — this capital partner does not '
        + 'require a flood certificate as a standing condition, so it can be signed off with nothing '
        + 'attached. If the property turns out to be in a flood zone, this condition becomes required again.',
    });
    await sfha(bdForce, { flood_zone: 'A' });
    // A touched flood cert on a NON-Fidelis file must be untouched by all of this.
    const bdOther = await mkApp('Blue Lake');
    const bdOtherItem = await attachFlood(bdOther, { notes: 'ordered' });

    await ensureSchema();          // re-runs the idempotent migrations, exactly like a deploy

    assert((await floodCount(bdGone)) === 0, 'db/335 §2 REMOVES an untouched flood cert from an open Fidelis file with no flood zone');
    assert((await floodCount(bdGoneFz)) === 1, 'db/335 §2 does NOT remove it when the file IS in a flood zone');
    let it = await floodItem(bdOpt);
    assert(it && it.is_required === false, 'db/335 §3 makes a TOUCHED flood cert on a Fidelis file OPTIONAL');
    assert(/\[auto\] Optional on this file/.test(it.notes || '') && /chased the title company/.test(it.notes || ''),
      'the marker note is APPENDED — the human\'s own note is preserved');
    assert(!/fidelis/i.test(it.notes || ''), 'the note says "this capital partner", never the note-buyer name');
    it = await floodItem(bdKeep);
    assert(it && it.is_required === true, 'db/335 §3 skips a Fidelis file that IS in a flood zone — the cert stays REQUIRED');
    // §4 — the drift repair.
    it = await floodItem(bdForce);
    assert(it && it.is_required === true,
      'db/335 §4 FORCES an already-OPTIONAL flood cert back to REQUIRED on a Fidelis file in a flood zone');
    assert(/\[auto\] Required on this file/.test(it.notes || '') && /note from the processor/.test(it.notes || ''),
      '§4 appends its own marker and keeps the human\'s note');
    assert(!/\[auto\] Optional on this file/.test(it.notes || ''),
      '§4 strips the now-false "optional" marker so the two never contradict each other');
    it = await floodItem(bdOther);
    assert(it && it.is_required === true && !/\[auto\] Optional/.test(it.notes || ''),
      'a NON-Fidelis file\'s flood cert is untouched by the back-date');
    // Idempotent: a second boot must not re-append either marker.
    await ensureSchema();
    it = await floodItem(bdOpt);
    assert((it.notes.match(/\[auto\] Optional on this file/g) || []).length === 1,
      'the §3 back-date is idempotent (its marker note is not re-appended on the next boot)');
    it = await floodItem(bdForce);
    assert((it.notes.match(/\[auto\] Required on this file/g) || []).length === 1,
      'the §4 back-date is idempotent (its marker note is not re-appended on the next boot)');
    assert(it.is_required === true, 'and §4\'s item stays REQUIRED across boots (§3 never re-downgrades it)');

    // …and the real endpoint accepts the sign-off with NOTHING attached.
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Flood Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`ff-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    server = require('../src/server').listen(0);
    await new Promise((res) => server.once('listening', res));
    const signOff = (id) => call(server, 'PATCH', `/api/staff/checklist/${id}`, token, { signedOff: true });
    assert((await signOff(bdOptItem)).status === 200,
      'the now-OPTIONAL flood cert on a Fidelis file signs off with NOTHING attached');
    assert((await signOff(bdKeepItem)).status === 422,
      'the still-REQUIRED flood cert (real flood zone) is still blocked with nothing attached');
    assert((await signOff(bdForceItem)).status === 422,
      'the §4-re-required flood cert is blocked with nothing attached — the forcing is real, not cosmetic');
    assert((await signOff(bdOtherItem)).status === 422,
      'a non-Fidelis file\'s required flood cert is still blocked with nothing attached');

    // ---------------------------------------------------------------------
    // (D) THE OWNER'S REPORT, 2026-07-27: "Looking at a Fidelis file and I still see the
    //     flood certificate condition… and I cannot sign it off." Three scope bugs in the
    //     db/335 back-date, each reproduced against a real database before being fixed.
    //     db/336 widens the back-date; signOffGate gains a LIVE check so the fix does not
    //     depend on a deploy having run.
    // ---------------------------------------------------------------------
    // (D1) THE LIVE GATE. This is the case that had the team stuck: a file registered
    //      Gold gets the condition, the note buyer later becomes Fidelis, and the
    //      condition is left standing and REQUIRED — the engine retracts only UNTOUCHED
    //      items and never rewrites is_required on one that already exists. The gate must
    //      read the note buyer at SIGN-OFF time, so the flag being stale cannot block it.
    const liveCases = [
      ['Fidelis Investors LLC', 'requested', false, true, 200, "item 'requested' + is_required STILL true => signable empty"],
      ['Fidelis Investors LLC', 'received', false, true, 200, "item 'received' + is_required STILL true => signable empty"],
      ['Fidelis Investors LLC', 'issue', false, true, 200, "item 'issue' + is_required STILL true => signable empty"],
      ['Fidelis Investor LLC', 'outstanding', false, true, 200, 'a spelling the old alias list missed => signable empty'],
      ['Fidelis Capital Partners', 'outstanding', false, true, 200, 'any "Fidelis …" capital partner => signable empty'],
      ['Fidelis Investors LLC', 'outstanding', true, true, 422, 'BUT a real flood zone still blocks an empty sign-off'],
      ['Blue Lake', 'outstanding', false, true, 422, 'Blue Lake is unaffected — still blocked'],
      ['Fidelity National', 'outstanding', false, true, 422, 'Fidelity National (look-alike) is NOT Fidelis — still blocked'],
    ];
    for (const [lender, itemStatus, flood, required, want, what] of liveCases) {
      const a = await mkApp(lender);
      if (flood) await sfha(a);
      const id = (await db.query(
        `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind,
                                      role_scope, phase, status, is_required, origin_kind, notes)
         SELECT t.id, t.scope, $1, t.label, t.audience, t.item_kind, 'processor', t.phase, $2, $3,
                'auto', 'processor was chasing this'
           FROM checklist_templates t WHERE t.code=$4 RETURNING id`,
        [a, itemStatus, required, FLOOD])).rows[0].id;
      assert((await signOff(id)).status === want, `sign-off gate: ${what}`);
    }

    // (D2) THE WIDENED BACK-DATE. Every state db/335 skipped, seeded on GOLD-registered
    //      Fidelis files — Gold matters because db/207's cleanup spares Gold files, so
    //      only this migration can remove the condition there. Without db/336 each of
    //      these came back REQUIRED on every single deploy (db/177's backfill re-adds the
    //      cert to every non-withdrawn file on every boot, and nothing removed it again).
    const backdate = [];
    for (const st of ['file_intake', 'new', 'processing', 'clear_to_close', 'funded', 'declined'])
      backdate.push({ what: `application status '${st}'`, appStatus: st, itemStatus: 'outstanding', lender: 'Fidelis Investors LLC' });
    for (const st of ['requested', 'received', 'issue'])
      backdate.push({ what: `item status '${st}'`, appStatus: 'processing', itemStatus: st, lender: 'Fidelis Investors LLC' });
    for (const l of ['Fidelis Investor LLC', 'Fidelis Capital Partners', 'FIDELIS INVESTORS, L.L.C.'])
      backdate.push({ what: `note buyer "${l}"`, appStatus: 'processing', itemStatus: 'outstanding', lender: l });
    for (const c of backdate) {
      c.id = (await db.query(
        `INSERT INTO applications (borrower_id, status, loan_type, lender) VALUES ($1,$2,'Fix & Flip',$3) RETURNING id`,
        [borrowerId, c.appStatus, c.lender])).rows[0].id;
      await setProgram(c.id, 'gold');
      await db.query(
        `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind,
                                      role_scope, phase, status, is_required, origin_kind)
         SELECT t.id, t.scope, $1, t.label, t.audience, t.item_kind, 'processor', t.phase, $2, true, 'auto'
           FROM checklist_templates t WHERE t.code=$3`, [c.id, c.itemStatus, FLOOD]);
    }
    // A Gold+Fidelis file that IS in a flood zone must keep it, REQUIRED — the control.
    const keepFz = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, lender)
       VALUES ($1,'processing','Fix & Flip','Fidelis Investors LLC') RETURNING id`, [borrowerId])).rows[0].id;
    await setProgram(keepFz, 'gold');
    await sfha(keepFz, { fema_flood_sfha: true, fema_flood_zone: 'AE' });
    await attachFlood(keepFz, { notes: 'ordered the determination' });

    await ensureSchema();                       // a deploy boot

    for (const c of backdate) {
      const it = await floodItem(c.id);
      const ok = !it || it.is_required === false;   // removed, or at least signable empty
      assert(ok, `db/336 back-date clears the flood cert on a Gold+Fidelis file — ${c.what}`);
    }
    const kept = await floodItem(keepFz);
    assert(kept && kept.is_required === true,
      'db/336 leaves a Gold+Fidelis file that IS in a flood zone REQUIRED (the flood zone still wins)');

    // (D3) …and it stays clean across a SECOND boot. db/177's backfill re-adds the cert on
    //      every boot, so a one-shot cleanup would silently regress on the next deploy.
    await ensureSchema();
    let regressed = 0;
    for (const c of backdate) {
      const it = await floodItem(c.id);
      if (it && it.is_required !== false) regressed++;
    }
    assert(regressed === 0,
      'and it stays clear on the NEXT deploy too (db/177 re-adds the cert on every boot)');

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    try { if (deciderId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [deciderId]); } catch (_) {}
    try { if (server) server.close(); } catch (_) {}
    await db.pool.end().catch(() => {});
  }
  process.exit(failures ? 1 : 0);
})();
