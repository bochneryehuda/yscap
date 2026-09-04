#!/usr/bin/env node
/**
 * WHY EVERY INVESTOR SAID NO — on the Combined Pricing Engine, from BOTH rate sheets.
 *
 * ⛔ THE DEFECT THIS EXISTS FOR, AND IT WAS BIGGER THAN IT LOOKED. The byte-by-byte coverage engine
 * found that LoanNEX's ineligibility — investor → programme → screen → attribute WITH the threshold
 * it failed against — was fetchable (client, parser and HTTP route all built) and never reached the
 * screen. Tracing the wiring turned up the real fault: `LtPricer.askDisqualified` reads a search key
 * off the price answer and returns early without one, and `priceBoth` has never carried one at the
 * top level (the identities sat inside `provenance`, which is reveal-gated and which no browser code
 * reads). MEASURED before the fix: `priceBoth(...).searchKey` is undefined with reveal ON and OFF.
 * So the "not eligible" section on that board was DEAD FOR BOTH RATE SHEETS — not a working list
 * missing a vendor, but a list nothing ever asked for.
 *
 * Both vendor clients are stubbed before the route is required, so the whole path runs with no
 * network and no database; it is named `-db` because it drives the real Express router over HTTP.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const express = require(path.join(ROOT, 'node_modules/express'));

const nexClient = require(path.join(ROOT, 'src/longterm/loannex/client'));
const lpClient = require(path.join(ROOT, 'src/longterm/lenderprice/client'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/** The two vendors' own refusal shapes, in the form each client really returns. */
const LP_DQ = { lenders: [{ lender: 'Acra Lending', items: [{ program: 'DSCR 30 Yr', reasons: ['FICO below the minimum'] }] }] };
const NEX_FAILS = {
  source: 'loannex', lenderCount: 1, itemCount: 1, transactionId: 'NX-1',
  lenders: [{
    lender: 'NQM Funding', lenderId: 8201, organizationGuid: null,
    items: [{
      program: 'DSCR I/O', screen: 'FlexIQ', status: 'Fail',
      reasons: ["Ltv above this program's maximum of 75%"],
      failingAttributes: [{ type: 'Ltv', status: 'Fail', min: null, max: 0.75 }],
    }],
  }],
};

let lpMode = 'ready';
lpClient.price = async () => ({ ok: true, raw: { results: { qualifiedNonQMData: { type: 'CriteriaFromLineResultKey', keyLabel: 'P', childs: [] } } }, searchKey: 'LP-1', request: {}, provenance: null });
lpClient.pollDisqualifiedByKey = async () => {
  if (lpMode === 'waiting') return { ok: true, ready: false };
  if (lpMode === 'unknown') return { unknown: true };
  if (lpMode === 'boom') throw Object.assign(new Error('upstream down'), { code: 'lp_down' });
  return { ok: true, ready: true, parsed: LP_DQ };
};
lpClient.parseDisqualified = () => LP_DQ;

let nexMode = 'ready';
nexClient.price = async () => ({ board: { source: 'loannex', programs: [] }, transactionId: 'NX-1', portal: 'web' });
nexClient.fails = async () => {
  if (nexMode === 'boom') throw Object.assign(new Error('loannex down'), { code: 'nex_down' });
  return { disqualified: NEX_FAILS };
};

const combined = require(path.join(ROOT, 'src/longterm/routes/combined-pricer'));
const { priceBoth } = combined._internals;

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = { kind: 'staff', role: 'super_admin', id: 'u1' }; next(); });
app.use('/lt', combined.makeRouter({ superAdminOnly: false }));

const SC = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3 };

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  const post = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  console.log('\n── THE BOARD HANDS BACK A WAY TO ASK ──');
  {
    const out = await priceBoth(SC, { marginHoldback: null, routes: {}, links: {} });
    ok(out.ineligibility && out.ineligibility.pollKey === 'LP-1' && out.ineligibility.treeId === 'NX-1',
      `ASK-1 the combined answer carries BOTH search identities (${JSON.stringify(out.ineligibility)}) — without this the screen returns early and nothing is ever asked`);
    const rev = await priceBoth(SC, { marginHoldback: null, routes: {}, links: {}, revealSource: true });
    ok(rev.ineligibility && rev.ineligibility.pollKey && rev.ineligibility.treeId,
      'ASK-2 …on the revealed board too, so an admin is not the only one who can see the list');
    const txt = JSON.stringify(out.ineligibility);
    ok(!/loannex|lenderprice|lender ?price/i.test(txt),
      `ASK-3 …and the handle NAMES NO VENDOR (${txt}) — the same rule the explain handle already keeps`);
  }

  console.log('\n── BOTH RATE SHEETS, ONE LIST ──');
  {
    lpMode = 'ready'; nexMode = 'ready';
    const r = await post('/lt/combined/disqualify', { pollKey: 'LP-1', treeId: 'NX-1' });
    const d = (r.body && r.body.disqualified) || {};
    const names = (d.lenders || []).map((l) => l.lender).sort();
    ok(r.status === 200 && r.body.ready === true, `LIST-1 the door answers ready (${r.status})`);
    ok(names.length === 2 && names.includes('Acra Lending') && names.includes('NQM Funding'),
      `LIST-2 BOTH rate sheets' refusals are in one list (${names.join(', ')})`);
    const nqm = (d.lenders || []).find((l) => l.lender === 'NQM Funding') || {};
    ok(nqm.whiteLabel === 'Ruby' && nqm.investorKey === 'nqm',
      `LIST-3 …carrying the client-safe name the board uses (${nqm.whiteLabel}) — one system, not two lists`);
    const reason = ((nqm.items || [])[0] || {}).reasons || [];
    ok(reason.some((x) => /maximum of 75%/.test(x)),
      `LIST-4 …and LoanNEX's reason survives WITH its threshold ("${reason[0]}") — the owner's own question`);
    ok(!/loannex|lenderprice/i.test(JSON.stringify(r.body)),
      'LIST-5 …and the ordinary list names no vendor');
  }

  console.log('\n── AN ADMIN WHO ASKS SEES WHICH SHEET REFUSED ──');
  {
    const r = await post('/lt/combined/disqualify', { pollKey: 'LP-1', treeId: 'NX-1', revealSource: true });
    const srcs = ((r.body.disqualified || {}).lenders || []).map((l) => l.source).sort();
    ok(srcs.includes('lenderprice') && srcs.includes('loannex'),
      `REV-1 the revealed list says which sheet each refusal came from (${srcs.join(', ')})`);
  }

  console.log('\n── HALF AN ANSWER IS SAID TO BE HALF AN ANSWER ──');
  {
    lpMode = 'waiting'; nexMode = 'ready';
    const r = await post('/lt/combined/disqualify', { pollKey: 'LP-1', treeId: 'NX-1' });
    ok(r.body.ready === true && r.body.pending.length === 1,
      `HALF-1 one sheet still computing: the refusals we HAVE are shown and the other is named as pending (${JSON.stringify(r.body.pending)}) — never "still computing" over a list that already holds real answers`);
    ok(((r.body.disqualified || {}).lenders || []).length === 1,
      'HALF-2 …and only the sheet that answered is in the list');
    ok(!/loannex|lenderprice/i.test(JSON.stringify(r.body.pending)),
      'HALF-3 …with the pending half named by mechanism, not by vendor');

    lpMode = 'boom'; nexMode = 'ready';
    const r2 = await post('/lt/combined/disqualify', { pollKey: 'LP-1', treeId: 'NX-1' });
    ok(r2.body.ready === true && r2.body.failed.length === 1 && ((r2.body.disqualified || {}).lenders || []).length === 1,
      'HALF-4 one sheet FAILING never takes the other down, and the failure is carried rather than shown as an empty list');

    lpMode = 'ready'; nexMode = 'boom';
    const r3 = await post('/lt/combined/disqualify', { pollKey: 'LP-1', treeId: 'NX-1' });
    ok(r3.body.ready === true && r3.body.failed.length === 1,
      'HALF-5 …in the other direction too');

    lpMode = 'unknown'; nexMode = 'ready';
    const r4 = await post('/lt/combined/disqualify', { pollKey: 'LP-1', treeId: 'NX-1' });
    ok((r4.body.failed[0] || {}).reason === 'unknown_search_key' && /price the loan again/i.test((r4.body.failed[0] || {}).message || ''),
      'HALF-6 an expired search says what to DO about it, not just that it failed');
  }

  console.log('\n── ONE INVESTOR, ONE ENTRY ──');
  {
    lpMode = 'ready'; nexMode = 'ready';
    const both = { lenders: [{ lender: 'NQM Funding', items: [{ program: 'A', reasons: ['x'] }] }] };
    const prev = lpClient.pollDisqualifiedByKey;
    lpClient.pollDisqualifiedByKey = async () => ({ ok: true, ready: true, parsed: both });
    const r = await post('/lt/combined/disqualify', { pollKey: 'LP-1', treeId: 'NX-1' });
    const ls = (r.body.disqualified || {}).lenders || [];
    ok(ls.length === 1 && ls[0].items.length === 2,
      `MERGE-1 an investor BOTH sheets refused appears ONCE with both reasons (${ls.length} entries, ${ls[0] ? ls[0].items.length : 0} items) — the board joins by investor and this must too`);
    lpClient.pollDisqualifiedByKey = prev;
  }

  console.log('\n── THE DOOR REFUSES A REQUEST IT CANNOT ACT ON ──');
  {
    const r = await post('/lt/combined/disqualify', {});
    ok(r.status === 400 && r.body.error === 'missing_handle',
      `GUARD-1 no handle is a plain refusal, never an empty list that reads as "nobody was refused" (${r.status})`);
  }

  console.log('\n── THE SCREEN ACTUALLY ASKS (a back end nobody reaches is not a feature) ──');
  {
    /**
     * ⛔ NO UNIT TEST CAN SEE THIS, AND ITS ABSENCE IS EXACTLY HOW THE SECTION SHIPPED DEAD: every
     * piece — client, parser, route — worked in isolation while the screen asked for none of it.
     */
    const fs = require('fs');
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const pricer = strip(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8'));
    const engines = strip(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/pricerEngine.js'), 'utf8'));
    const api = strip(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/api.js'), 'utf8'));

    ok(/const handle = \(opts && opts\.handle\) \|\| \(engine\.disqualifyHandle/.test(pricer),
      'WIRE-1 the screen asks the ENGINE for the handle instead of reading a Lender Price key off the answer');
    ok(/await engine\.disqualify\(handle,/.test(pricer),
      'WIRE-2 …and asks through the engine, so a second engine can answer differently without forking the screen');
    ok(!/ltApi\.dscrDisqualifications\(/.test(pricer),
      'WIRE-3 …with no direct vendor call left in the screen at all');
    ok(/const dqHandle = engine\.disqualifyHandle/.test(pricer) && /askDisqualified\(\{ auto: true, handle: dqHandle \}\)/.test(pricer),
      'WIRE-4 the automatic first ask is gated on the HANDLE, not on `r.searchKey` — the exact early return that made this dead');
    ok(/askDisqualified\(\{ auto: true, handle \}\)/.test(pricer),
      'WIRE-5 …and the bounded retry re-sends the handle, never the identity string it is keyed on');

    /* ⛔ WIRE-6 SAID THE GENERAL ENGINE'S CALL WAS BYTE-IDENTICAL, AND THAT INVARIANT WAS
       DELIBERATELY ENDED ON 2026-09-03 — it is not a stale spelling, it is a rule that no longer
       holds and must not be restored. It was written when the two-sheet join was combined-only,
       so "the general board is untouched" was exactly the right thing to protect. But the
       general route had LoanNEX's transaction id in hand and dropped it, so on a board five
       investors are quoted from LoanNEX on, that board's not-eligible list could never say why
       any of them said no. It now asks the SAME join at its OWN path.

       WHAT REPLACES IT IS THE PART THAT STILL MATTERS, and it is a real hazard rather than a
       restatement: the general board is NOT super-admin-only and the combined door IS (every
       `/dscr/combined/*` route answers 404 to everybody else), so routing the general board
       through the combined door would take the ineligible list away from every ordinary officer
       — silently, since a 404 there reads as "nothing to show". */
    ok(/disqualify: \(h\) => ltApi\.dscrIneligible\(/.test(engines),
      'WIRE-6 the GENERAL engine asks the joined door, so its board can say why a LoanNEX investor said no');
    const genDecl = engines.slice(engines.indexOf("key: 'general'"), engines.indexOf("key: 'combined'"));
    ok(!/combinedDisqualifications/.test(genDecl),
      'WIRE-6a …at its OWN path, never the combined engine\'s — that one is super-admin-only, and a 404 there would read as "nobody was refused"');
    ok(/res\.searchKey/.test(genDecl),
      'WIRE-6b …and it still falls back to the older handle, so a page held across a deploy keeps its ineligible tab');
    ok(/ltApi\.combinedDisqualifications\(/.test(engines),
      'WIRE-7 the COMBINED engine asks both rate sheets through the one door');
    ok(/combinedDisqualifications: \(handle\) => ltPost\(lt\('\/dscr\/combined\/disqualify'\)/.test(api),
      'WIRE-8 …and that door exists on the browser client');
  }

  server.close();
  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
