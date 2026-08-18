#!/usr/bin/env node
'use strict';
/**
 * §2.1 / TASK #31 — BLANK-FIELD PARITY AGAINST THE CAPTURED FRONTEND REQUESTS (pure, offline).
 *
 * THE RISK THIS EXISTS FOR. Where the vendor's own web app leaves a field BLANK and we send a value —
 * or the reverse — Lender Price does not error. It prices a slightly different loan than the one we
 * asked about, answers HTTP 200, and every parity number measured against that answer is measuring the
 * wrong deal. It is the highest-consequence class of difference in this integration precisely because
 * nothing goes red.
 *
 * A blank has THREE wire forms and they are not interchangeable to a strict service: the key ABSENT,
 * the key present carrying `null`, and the key present carrying an empty literal (`""`). This suite
 * pins ours against theirs.
 *
 * THE GROUND TRUTH is `docs/longterm/ppe-research/anchors/req-0{1..7}.json` — seven real `searchRaw`
 * request bodies lifted from the owner's HAR of the vendor's own website, every one HTTP 200 with real
 * pricing (`docs/longterm/ppe-research/PARITY-BASELINE.md` §1 records the program/option/lender counts
 * for req-01 and req-07). Nothing here is inferred from the vendor's JavaScript; every expectation is
 * read out of a body their site actually sent.
 *
 * READ THE CAPTURES IN TWO GROUPS OR THE MEASUREMENT IS WRONG — this is the trap that made the earlier
 * "31 structural differences" count look worse than it is:
 *
 *   · req-01 and req-07 carry `cachedDisqualified: false`. They are KICKOFFS — a real pricing search.
 *     This is the body shape we post for every quote, so this is the like-for-like comparison.
 *   · req-02 … req-06 carry `cachedDisqualified: true`. They are POLLS of req-01's computation, and
 *     the frontend's own poll differs from its own kickoff in 14 leaves (it drops nine keys it had
 *     just sent as `null` and adds `disqualifiedResultsByProduct`). Diffing our KICKOFF against their
 *     POLL reports those 14 as our defects. They are not.
 *
 * WHAT THE SUITE ASSERTS
 *   A. Our kickoff for req-07's own deal is BYTE-EXACT against req-07 — zero differing leaves.
 *   B. Our kickoff for req-01's own deal differs in exactly the three fields on which the two captures
 *      DISAGREE WITH EACH OTHER, each recorded with its evidence. No unexplained difference is
 *      tolerated, in either direction.
 *   C. THE RULE: the blank form of a field is DERIVED from the captures, not chosen by a developer —
 *      section C computes each path's blank form from the anchors themselves and checks the builder
 *      against it, so this file cannot drift away from the evidence it cites.
 *   D. `SCENARIO_OWNED` is the ONE place a blank form is decided: with a foundation carrying junk in
 *      every owned path and a caller stating nothing, every path lands on its registry neutral.
 *   E. Clearing to the frontend's blank still closes the prior-session leak (`""` overwrites a stale
 *      street exactly as deletion did — there was never a trade-off to make).
 *   F. The disqualify POLL divergence is PINNED, not fixed: see the note at section F.
 *
 * PROVEN TO FAIL (mutation-tested; controls green either side of each mutation):
 *   1. `property.address.street` neutral `''` → `DELETE`  ⇒ A, C and the leak row for street fail.
 *   2. `criteria.appraisedValue` re-forced to `null` in buildSearch ⇒ A, B, C and D fail.
 *   3. `criteria.appraisedValue` removed from `SCENARIO_OWNED` ⇒ 13 rows fail, and the one that names
 *      the actual bug is C-2, which reports `ours=400000` — the captured foundation's OWN appraised
 *      value riding onto a scenario that states none. A-1 stays GREEN through that mutation (req-07's
 *      scenario supplies the number, so the leak is invisible there), which is exactly why sections D
 *      and E exist beside the capture diff rather than instead of it.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const sm = require('../src/longterm/lenderprice/search-model');
const lp = require('../src/longterm/lenderprice/client');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const ANCHOR_DIR = path.join(__dirname, '..', 'docs', 'longterm', 'ppe-research', 'anchors');
const ANCHORS = {};
for (const f of fs.readdirSync(ANCHOR_DIR).filter((f) => f.endsWith('.json')).sort()) {
  ANCHORS[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(ANCHOR_DIR, f), 'utf8'));
}
const KICKOFFS = Object.keys(ANCHORS).filter((k) => ANCHORS[k].cachedDisqualified === false);
const POLLS = Object.keys(ANCHORS).filter((k) => ANCHORS[k].cachedDisqualified === true);

// A sentinel distinct from every JSON value, so "the key is absent" is a first-class answer rather
// than being confused with a transmitted null.
const ABSENT = Symbol('absent');

// Flatten to leaf paths. An empty array/object is itself a leaf (it is a transmitted shape, not a
// missing one), so `[]` can never be mistaken for absence.
function leaves(o, pre, out) {
  out = out || {}; pre = pre || '';
  if (o === null || typeof o !== 'object') { out[pre] = o; return out; }
  if (Array.isArray(o)) {
    if (o.length === 0) { out[pre] = '[]'; return out; }
    o.forEach((v, i) => leaves(v, pre + '[' + i + ']', out)); return out;
  }
  const ks = Object.keys(o);
  if (ks.length === 0) { out[pre] = '{}'; return out; }
  for (const k of ks) leaves(o[k], pre ? pre + '.' + k : k, out);
  return out;
}
function at(map, k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : ABSENT; }
function show(v) { return v === ABSENT ? 'ABSENT' : JSON.stringify(v); }
function diffLeaves(theirs, ours) {
  const T = leaves(theirs), O = leaves(ours);
  const keys = [...new Set([...Object.keys(T), ...Object.keys(O)])].sort();
  const out = [];
  for (const k of keys) {
    const tv = at(T, k), ov = at(O, k);
    if (show(tv) !== show(ov)) out.push({ path: k, theirs: tv, ours: ov });
  }
  return out;
}

// Read a capture's own deal back OUT of it, so the two sides describe the SAME loan rather than a
// similar one. Anything not read here is a field the scenario does not state — which is exactly the
// blank-handling this suite is about, so the omissions are deliberate.
function scenarioOf(front) {
  const c = front.criteria, a = front.property.address, d = front.dynamicPropertiesMap || {};
  const prepay = /(\d+)/.exec(String((d.PrepayTerm || {}).value || ''));
  return {
    purpose: c.loanPurpose === 'Purchase' ? 'Purchase' : c.loanPurpose === 'CashoutRefinance' ? 'Cash out' : 'Refinance',
    value: c.purchasePrice, loan: c.loanAmount, fico: c.fico, dscr: c.dscr,
    appraisedValue: c.appraisedValue,
    state: a.state, zip: a.zip, countyFps: a.county, county: a.countyName, city: a.city,
    propertyType: front.property.propertyType, units: front.property.numberOfUnit,
    attachmentType: front.property.attachmentType,
    io: !!c.interestOnly, termYears: c.loanYear, lockDays: (front.brokerCriteria || {}).dayLocks,
    prepayMonths: prepay ? Number(prepay[1]) : undefined,
    borrowerType: (d.GLOBAL_BorrowerType || {}).value,
    incomeDocType: (d.IncomeDocType || {}).value,
  };
}
function buildFor(name) {
  const v = sm.validateScenario(scenarioOf(ANCHORS[name]));
  if (!v || v.ok !== true) throw new Error(name + ' refused by validateScenario: ' + (v && v.error));
  return v.request;
}

console.log('§2.1/TASK-31 blank-field parity against the captured frontend requests');
console.log('  captures: ' + Object.keys(ANCHORS).length + '  kickoffs: ' + KICKOFFS.join(',') + '  polls: ' + POLLS.join(','));

// ---- 0. the corpus is what this suite claims it is ------------------------------------------------
console.log('\n0. the ground truth');
ok(Object.keys(ANCHORS).length === 7, 'GT-1 seven captured frontend request bodies are present');
ok(KICKOFFS.length === 2 && KICKOFFS.join(',') === 'req-01,req-07',
  'GT-2 exactly TWO are kickoffs (cachedDisqualified:false) — the only shape comparable to a quote');
ok(POLLS.length === 5, 'GT-3 the other five are disqualify POLLS and are compared separately');
ok(diffLeaves(ANCHORS['req-01'], ANCHORS['req-02']).length === 14,
  'GT-4 the frontend\'s OWN poll differs from its OWN kickoff in 14 leaves — so a kickoff-vs-poll diff measures their normalization, not our defects');

// ---- A. byte-exact parity on the capture our foundation is built from -----------------------------
console.log('\nA. our kickoff vs req-07 — the strongest claim available: byte-exact');
{
  const d = diffLeaves(ANCHORS['req-07'], buildFor('req-07'));
  for (const x of d) console.log('       unexpected: ' + x.path + '  frontend=' + show(x.theirs) + '  ours=' + show(x.ours));
  ok(d.length === 0, 'A-1 our built kickoff for req-07\'s own deal is IDENTICAL to req-07, leaf for leaf (0 differences)');
}

// ---- B. req-01, and the three fields on which the two captures contradict EACH OTHER --------------
//
// These are NOT "we differ from the frontend". They are "the frontend does two different things", so
// there is no single behaviour to match and guessing one would be inventing a rule. Each row records
// what each capture actually carries. They are pinned so that a future capture which settles one of
// them makes this suite go red and forces the question to be answered rather than quietly re-guessed.
const CONTRADICTED = [
  { path: 'companyId',
    reason: 'req-01 sends null; req-07 sends the real company id (which is what our captured foundation carries). ' +
            'Note client.js passes `companyId` into buildSearch and buildSearch IGNORES it — a collected-then-discarded field.' },
  { path: 'criteria.nonWarrantableProject',
    reason: 'req-01 (SingleFamily) omits the key; req-07 (2-4 unit) sends false. Neither is a condo, so the two captures ' +
            'disagree with no visible cause. We send the value derived from the property type, which matches req-07.' },
  { path: 'dynamicPropertiesMap.GLOBAL_Section184.value',
    reason: 'req-01 sends the STRING "false"; req-07 sends null. Section 184 is a HUD program irrelevant to a DSCR ' +
            'investor loan. We carry the foundation\'s null, which matches req-07.' },
];
console.log('\nB. our kickoff vs req-01 — every difference is a capture-vs-capture contradiction');
{
  const d = diffLeaves(ANCHORS['req-01'], buildFor('req-01'));
  const known = new Set(CONTRADICTED.map((c) => c.path));
  const unexplained = d.filter((x) => !known.has(x.path));
  for (const x of unexplained) console.log('       unexplained: ' + x.path + '  frontend=' + show(x.theirs) + '  ours=' + show(x.ours));
  ok(unexplained.length === 0, 'B-1 no UNEXPLAINED difference against req-01 (every one is a recorded contradiction)');
  ok(d.length === CONTRADICTED.length,
    'B-2 all ' + CONTRADICTED.length + ' recorded contradictions still reproduce — a capture that settles one makes this fail on purpose');
  for (const c of CONTRADICTED) {
    const a1 = at(leaves(ANCHORS['req-01']), c.path), a7 = at(leaves(ANCHORS['req-07']), c.path);
    ok(show(a1) !== show(a7), 'B-3 ' + c.path + ': the captures really do disagree (req-01=' + show(a1) + ', req-07=' + show(a7) + ')');
  }
}

// ---- C. THE RULE — the blank form is DERIVED from the captures, never chosen ----------------------
//
// For each path, look at what every capture carries. Values that are ABSENT / null / "" are BLANK
// forms; anything else is a value somebody typed. If every capture that is blank agrees on HOW it is
// blank, that single form IS the frontend's blank form for that field, and the builder must produce it
// when the caller states nothing. Deriving it here rather than typing it in is what stops this suite
// and `SCENARIO_OWNED` from drifting apart from the evidence.
function blankFormsFor(pathKey, captures) {
  const forms = new Set();
  let sawValue = false;
  for (const name of captures) {
    const v = at(leaves(ANCHORS[name]), pathKey);
    if (v === ABSENT || v === null || v === '') forms.add(show(v)); else sawValue = true;
  }
  return { forms: [...forms], sawValue };
}
console.log('\nC. the blank form is derived from the captures and the builder matches it');
{
  // A scenario that states nothing beyond what a quote must carry — so every path below is BLANK from
  // the caller's side and the builder alone decides its wire form.
  const bare = sm.validateScenario({ purpose: 'Refinance', zip: '11211', value: 500000, loan: 400000, fico: 760 });
  ok(bare.ok === true, 'C-0 a minimal quote scenario is accepted (nothing below is measuring a refusal)');
  const built = leaves(bare.request);

  const DERIVED = ['property.address.street', 'property.address.streetCont', 'property.address.zipExt', 'criteria.appraisedValue'];
  for (const p of DERIVED) {
    const { forms } = blankFormsFor(p, KICKOFFS);
    ok(forms.length === 1, 'C-1 ' + p + ': the kickoff captures agree on ONE blank form (' + forms.join(' / ') + ')');
    if (forms.length === 1) {
      ok(show(at(built, p)) === forms[0],
        'C-2 ' + p + ': we send the frontend\'s blank form ' + forms[0] + ' (ours=' + show(at(built, p)) + ')');
    }
  }
  // The specific regressions this replaced, stated in plain terms so a failure names the bug.
  ok(at(built, 'property.address.street') === '' && at(built, 'property.address.streetCont') === '' && at(built, 'property.address.zipExt') === '',
    'C-3 street / streetCont / zipExt are the empty string — all SEVEN captures send "", we used to omit the keys');
  ok(at(built, 'criteria.appraisedValue') === ABSENT,
    'C-4 an unstated appraised value is ABSENT — req-01 omits the key; we used to transmit null');
  // …and the other half of that rule: a value the caller DOES state still rides.
  const stated = sm.validateScenario({ purpose: 'Refinance', zip: '11211', value: 500000, loan: 400000, fico: 760, appraisedValue: 460000 });
  ok(stated.ok === true && stated.request.criteria.appraisedValue === 460000,
    'C-5 a SUPPLIED appraised value is still transmitted — the rule removes a default, not the field');
  // …and it is never manufactured from the price, on any purpose (the 2026-08-16 no-mirroring rule).
  for (const purpose of ['Purchase', 'Refinance', 'Cash out']) {
    const sc = { purpose, zip: '11211', value: 500000, loan: 400000, fico: 760 };
    if (purpose === 'Cash out') sc.cashoutAmount = 50000;
    const r = sm.validateScenario(sc);
    ok(r.ok === true && !Object.prototype.hasOwnProperty.call(r.request.criteria, 'appraisedValue'),
      'C-6 ' + purpose + ': the purchase/estimated price is never mirrored into the appraised value');
  }
}

// ---- D. SCENARIO_OWNED is the ONE place a blank form is decided -----------------------------------
//
// The failure this catches is the one that produced the appraised-value defect: a field whose blank
// form is written inline in buildSearch instead of stated in the registry. Feed a foundation carrying
// junk in every owned path, state nothing, and every path must land on its registry neutral. A field
// that is missing from the registry keeps the junk and this section says so.
console.log('\nD. the registry decides every scenario-owned blank, and nothing else does');
{
  const { SCENARIO_OWNED, SCENARIO_OWNED_DELETE } = sm._internals;
  const dirty = JSON.parse(JSON.stringify(sm.BASE));
  const put = (obj, p, v) => {
    const parts = p.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = v;
  };
  // A prior session's junk in EVERY owned path, deliberately of a type that would survive the merge.
  const JUNK = { number: 424242, string: 'STALE-FROM-A-PRIOR-SESSION', boolean: true };
  for (const e of SCENARIO_OWNED) {
    const isDyn = e.path.startsWith('dynamicPropertiesMap.');
    if (isDyn) put(dirty, e.path, { fieldId: e.path.split('.').pop(), value: 'STALE' });
    else if (typeof e.neutral === 'number') put(dirty, e.path, JUNK.number);
    else if (typeof e.neutral === 'boolean') put(dirty, e.path, JUNK.boolean);
    else put(dirty, e.path, JUNK.string);
  }
  // State nothing but the bare minimum a quote needs — so no owned field is re-applied by the caller.
  const built = sm.buildSearch({ purpose: 'Refinance', zip: '11211', state: 'NY', countyFps: '36047', value: 500000, loan: 400000, fico: 760 }, { base: dirty });
  const L = leaves(built);
  let landed = 0, missed = [];
  for (const e of SCENARIO_OWNED) {
    // Paths the caller DID state above (value/loan/ltv/fico + the address parts) are re-applied by
    // design; the registry's job for them is only that the STALE value is gone, which E proves.
    const restated = ['criteria.purchasePrice', 'criteria.loanAmount', 'criteria.ltv', 'criteria.fico', 'criteria.dscr',
      'property.address.zip', 'property.address.state', 'property.address.county', 'property.address.censustract',
      'property.address.countyName', 'property.address.city'];
    if (restated.includes(e.path)) continue;
    const want = e.neutral === SCENARIO_OWNED_DELETE ? ABSENT : e.neutral;
    const got = at(L, e.path);
    if (show(got) === show(want)) landed++; else missed.push(e.path + ' want=' + show(want) + ' got=' + show(got));
  }
  for (const m of missed) console.log('       ' + m);
  ok(missed.length === 0, 'D-1 every unstated scenario-owned path landed on its REGISTRY neutral (' + landed + ' checked)');
  ok(SCENARIO_OWNED.some((e) => e.path === 'criteria.appraisedValue'),
    'D-2 criteria.appraisedValue is IN the registry — its blank form is no longer written inline in buildSearch');
  ok(SCENARIO_OWNED.filter((e) => e.path.startsWith('property.address.') && e.neutral === '').length === 3,
    'D-3 the three address text lines state the empty string as their neutral, in the registry, not in a call site');
}

// ---- E. matching the frontend's blank did NOT reopen the prior-session leak -----------------------
//
// The old reasoning treated absence and parity as a trade-off. They are not: an empty string
// overwrites a stale value exactly as deletion does. This proves it rather than asserting it.
console.log('\nE. the prior-session leak stays closed under the new blank forms');
{
  const dirty = JSON.parse(JSON.stringify(sm.BASE));
  dirty.property.address.street = '9 Beverly Hills Dr';
  dirty.property.address.streetCont = 'Suite 900';
  dirty.property.address.zipExt = '9210';
  dirty.criteria.appraisedValue = 9999999;
  const built = sm.buildSearch({ purpose: 'Refinance', zip: '11211', state: 'NY', countyFps: '36047', value: 500000, loan: 400000, fico: 760 }, { base: dirty });
  const a = built.property.address;
  ok(a.street === '' && a.streetCont === '' && a.zipExt === '',
    'E-1 a prior session\'s street / line 2 / ZIP+4 are gone — replaced by the frontend\'s own blank ""');
  ok(!Object.prototype.hasOwnProperty.call(built.criteria, 'appraisedValue'),
    'E-2 a prior session\'s appraised value is gone — and its absence is the frontend\'s blank form, so parity and leak-safety agree');
  ok(JSON.stringify(built).indexOf('Beverly Hills') === -1 && JSON.stringify(built).indexOf('9999999') === -1,
    'E-3 nothing from the dirty foundation survives anywhere in the transmitted body');
}

// ---- F. the disqualify POLL divergence is PINNED, not fixed ---------------------------------------
//
// Our poll re-posts the stored kickoff body with cachedDisqualified flipped + the upstream requestId.
// The frontend's poll is normalized differently (it drops nine of its own nulls and adds
// `disqualifiedResultsByProduct: false`). We deliberately do NOT copy that, because the vendor plainly
// does not cache-key on the whole body — if it did, the frontend's own 14-leaf-different poll could not
// read back the computation its kickoff started, and it demonstrably does; correlation is by requestId.
// Reshaping a working async handshake on that inference, without a live re-measure, would risk the
// ineligible-reasons read on every deal to gain byte parity on a body whose response we only read.
// So the divergence is pinned HERE: if it changes, this fails and somebody has to say why.
console.log('\nF. the disqualify poll divergence is pinned (deliberately unfixed — see the note above)');
{
  const kick = buildFor('req-01');
  const ourPoll = lp._internals.applyPollDelta(kick, ANCHORS['req-02'].requestId);
  const d = diffLeaves(ANCHORS['req-02'], ourPoll);
  const paths = d.map((x) => x.path).sort();
  ok(ourPoll.cachedDisqualified === true, 'F-1 our poll body flips cachedDisqualified');
  ok(ourPoll.requestId === ANCHORS['req-02'].requestId,
    'F-2 our poll echoes the upstream requestId — the correlation the vendor actually keys on');
  ok(!paths.includes('property.address.street') && !paths.includes('criteria.appraisedValue'),
    'F-3 the blank forms fixed for the kickoff are fixed on the poll too (they ride the same body)');
  ok(d.length === 15, 'F-4 exactly 15 leaves differ on the poll — pinned, with the reason recorded in client.js applyPollDelta');
  const dropped = paths.filter((p) => show(at(leaves(ANCHORS['req-02']), p)) === 'ABSENT');
  ok(dropped.length === 12, 'F-5 twelve of them are keys the frontend\'s POLL simply does not carry');
  // …and of those, the ones it had itself sent as `null` on its own kickoff moments earlier. That is
  // a re-serialization on their side, not a statement about the deal — which is the whole reason this
  // is pinned rather than copied.
  const K1 = leaves(ANCHORS['req-01']);
  const theirOwnNullDrops = dropped.filter((p) => at(K1, p) === null);
  ok(theirOwnNullDrops.length === 11,
    'F-6 eleven of those twelve are keys their OWN kickoff sent as null — their normalization, not our value');
}

console.log('\n' + (fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail) + ' (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail === 0 ? 0 : 1);
