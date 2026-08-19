#!/usr/bin/env node
'use strict';
/**
 * LT PPE — REPLAYING A PAID RUN FROM ITS OWN CAPTURE (§2.120).
 *
 * Every paid agreement run writes the RAW vendor payloads to disk (`lenderprice/capture.js`, the
 * owner's own instruction). Measured live: 335 MB of vendor JSON compressed to 8.5 MB. And until this
 * item, NOTHING EVER READ IT BACK — a grep for `replay` across `src/longterm/ppe/*.js`,
 * `src/longterm/lenderprice/*.js` and `scripts/test-lt-lp-*.js` returned no output. So the evidence
 * behind §2.111, §2.113 and §2.114 existed only as numbers quoted in a document, and the ability to
 * re-check them died with the container.
 *
 * `lp-replay.js` is the read side. This suite drives it against a REAL capture on disk.
 *
 * ⛔ WHAT THE FIXTURE IS, PLAINLY — because a fixture that is quietly synthetic makes every number
 * below worthless.
 *   • `scripts/fixtures/lp-replay/payloads/*.json.gz` — the TWO PRICE payloads are UNTOUCHED vendor
 *     bytes, copied verbatim out of a paid run's capture directory (19,302 and 19,616 gz bytes;
 *     413,451 and 436,697 raw). They are parsed here by the LIVE `client.parseFull`.
 *   • The ONE DISQUALIFY payload is REAL vendor structure, PRUNED to at most 2 childs and 2 leafs per
 *     node. The untouched capture of that same tree is 173,632,512 raw / 4,226,394 gz bytes, which
 *     this repository should not carry. The pruning is recorded in the fixture's own index row, and
 *     it changes SIZE, never SHAPE — the tree is walked by the LIVE `client.parseDisqualified` and
 *     still yields real lenders, real programs and real refusal reasons.
 *   • Nothing here is hand-typed. There is no invented vendor payload in this suite.
 *
 * ⛔ AND WHAT THE CAPTURES ON DISK CANNOT DO, stated because it bounds every claim §2.120 makes:
 * every scenario in every capture directory available is one our OWN sheet declines, so a capture
 * cannot yet produce a both-priced comparison. The replay is the mechanism; the priced evidence is a
 * later paid run, now selectable for free by §2.115's priced probe.
 *
 *   node scripts/test-lt-ppe-lp-replay.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const replay = require('../src/longterm/ppe/lp-replay');
const client = require('../src/longterm/lenderprice/client');
const { buildSearch } = require('../src/longterm/lenderprice/search-model');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// A mutation that CRASHES the suite is not proof — it prints a short stack and exits, which reads
// exactly like a pass. Every call that is only supposed to throw in ONE named case goes through these,
// so an unexpected throw becomes a null the assertions below report by name.
async function attempt(fn) { try { return await fn(); } catch (e) { console.log(`  (threw: ${String(e && e.message || e).slice(0, 110)})`); return null; } }
function attemptSync(fn) { try { return fn(); } catch (e) { console.log(`  (threw: ${String(e && e.message || e).slice(0, 110)})`); return null; } }
const legOf = (opts) => attemptSync(() => replay.buildReplayLpLeg(opts));

const DIR = path.join(__dirname, 'fixtures', 'lp-replay');
const indexRows = fs.readFileSync(path.join(DIR, 'index.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const priceRows = indexRows.filter((r) => r.kind === 'price');
const scenarios = priceRows.map((r) => r.meta.scenario);
const WITH_DQ = 'fico 640 ltv 80 dscr 0.9';   // the scenario whose refusal tree is in the fixture
const NO_DQ = 'fico 600';                      // captured, priced, never asked for a refusal tree

console.log('LT PPE — replay a paid run from its own capture (§2.120) — offline\n');

(async () => {

// ---- A. THE FIXTURE IS WHAT THIS FILE SAYS IT IS -------------------------------------------------
// Asserted rather than described, because every number below is only worth what the fixture is worth.
{
  ok(priceRows.length === 2, `A1 the fixture carries 2 captured price payloads — got ${priceRows.length}`);
  const dq = indexRows.filter((r) => r.kind === 'disqualify');
  ok(dq.length === 1, `A2 …and 1 captured refusal tree — got ${dq.length}`);
  // The price payloads must be byte-identical to what the capture sink wrote: the file NAME is the
  // sha256 of the bytes, so re-hashing proves nothing was edited on the way into the repository.
  const crypto = require('crypto');
  for (const r of priceRows) {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(DIR, r.file)));
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    ok(sha === r.sha, `A3 price payload "${r.meta.scenario._label}" is UNTOUCHED — its bytes still hash to their own filename`);
    ok(raw.length === r.rawBytes, `A4 …and its recorded raw size (${r.rawBytes}) is the real one`);
  }
  const dqRow = dq[0];
  ok(/PRUNED/.test(String(dqRow.meta.note || '')),
    'A5 the refusal tree names itself as pruned in its own index row — a trimmed fixture may never pass as untouched');
  ok(dqRow.rawBytes < 1e6 && /173,632,512/.test(String(dqRow.meta.note)),
    `A6 …and states the untouched size it stands in for (kept ${dqRow.rawBytes} raw bytes)`);
}

// ---- B. THE REPLAY GOES THROUGH THE LIVE PARSERS (RULE 1) ----------------------------------------
// The §2.107 mistake was replaying a stored PARSED result, which proves what the parser did on the day
// of capture and then agrees with itself forever. What is on disk here is the RAW vendor envelope.
{
  const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, priceRows[0].file))).toString('utf8'));
  ok(stored && typeof stored === 'object' && stored.results && typeof stored.results === 'object',
    'B1 what is stored is the RAW vendor envelope (it still has `results`), not a parsed ladder');
  ok(!('programCount' in stored) && !('rateSheets' in stored),
    'B2 …and carries none of the parser’s own output keys — there is no stored verdict to replay');

  const leg = legOf({ client, dir: DIR });
  const out = leg ? await attempt(() => leg(scenarios.find((s) => s._label === WITH_DQ))) : null;
  ok(out && out.full && typeof out.full === 'object', 'B3 the leg returns a parsed `full`');
  ok(out && typeof out.full.programCount === 'number' && typeof out.full.optionCount === 'number',
    `B4 …produced by the LIVE parseFull just now — ${out ? out.full.programCount : '?'} programs, ${out ? out.full.optionCount : '?'} options`);
  ok(!!out && out.full.optionCount > 0, 'B5 …and it is a real answer, not an empty one');

  // The proof that it went through the live parser rather than a copy: parse the same bytes by hand
  // and compare. If the module ever started returning something stored, these would diverge.
  const byHand = client.parseFull(stored === null ? null : JSON.parse(zlib.gunzipSync(
    fs.readFileSync(path.join(DIR, indexRows.find((r) => r.kind === 'price' && r.meta.scenario._label === WITH_DQ).file))).toString('utf8')));
  ok(!!out && byHand.optionCount === out.full.optionCount && byHand.programCount === out.full.programCount,
    'B6 …and it matches parseFull run by hand over the same bytes — the replay is the parser, not a cache');
}

// ---- C. A SCENARIO WITH NO CAPTURE THROWS (RULE 2) -----------------------------------------------
// An empty ladder reads as "Lender Price offers nothing", which is a VERDICT. Inventing one out of a
// missing file is the most expensive thing this module could do.
{
  const leg = replay.buildReplayLpLeg({ client, dir: DIR });
  const never = { ...scenarios[0], fico: 711, _label: 'never captured' };
  let threw = null;
  try { await leg(never); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'C1 a scenario with no captured price THROWS — never an empty answer');
  ok(/never captured/.test(String(threw && threw.message)),
    'C2 …and the message NAMES the scenario, so a run says which one it cannot answer for');
  ok(/cannot answer/.test(String(threw && threw.message)),
    'C3 …in words that say the run cannot answer, not that Lender Price refused');
}

// ---- D. A MISSING REFUSAL TREE IS "WE NEVER ASKED" (RULE 3) --------------------------------------
// An empty READY tree would silently turn every such scenario into a both-priced comparison — the
// exact class §2.147 closed on the live leg with `--no-disqualify`.
{
  const leg = legOf({ client, dir: DIR });
  const withDq = leg ? await attempt(() => leg(scenarios.find((s) => s._label === WITH_DQ))) : null;
  const noDq = leg ? await attempt(() => leg(scenarios.find((s) => s._label === NO_DQ))) : null;
  if (!withDq || !noDq) { ok(false, 'D0 both captured scenarios replay — the leg threw on one of them'); }

  ok(!!noDq && noDq.disqualified && noDq.disqualified.ready === false,
    'D1 a scenario captured WITHOUT a refusal tree replays as ready:false — "we never asked"');
  ok(!!noDq && Array.isArray(noDq.disqualified.lenders) && noDq.disqualified.lenders.length === 0,
    'D2 …with no lenders, which is the same shape the LIVE leg produces on a disqualify timeout');

  ok(!!withDq && withDq.disqualified.ready === true,
    'D3 the scenario that DOES have one replays as ready:true — the two are distinguishable');
  ok(!!withDq && withDq.disqualified.lenderCount > 0 && withDq.disqualified.itemCount > 0,
    `D4 …and carries real refusals: ${withDq ? withDq.disqualified.lenderCount : '?'} lenders, ${withDq ? withDq.disqualified.itemCount : '?'} items`);
  ok(!!withDq && withDq.disqualified.reasonCount > 0,
    `D5 …with the vendor's own stated reasons on them (${withDq ? withDq.disqualified.reasonCount : '?'})`);
  // The distinction is the WHOLE point: ready:false and an empty ready tree must never look alike.
  ok(!!noDq && !!withDq && noDq.disqualified.ready !== withDq.disqualified.ready,
    'D6 "we never asked" and "we asked and here is the answer" are different states, not both empty');

  // `withDisqualify:false` is the rungs-only pass, and it must produce the SAME never-asked shape
  // rather than an empty ready one.
  const rungsOnly = legOf({ client, dir: DIR, withDisqualify: false });
  const off = rungsOnly ? await attempt(() => rungsOnly(scenarios.find((s) => s._label === WITH_DQ))) : null;
  ok(!!off && off.disqualified.ready === false && off.full.optionCount > 0,
    'D7 a rungs-only replay still prices, and its refusal tree is honestly "never asked"');
}

// ---- E. THE JOIN KEY IS THE REQUEST, NOT THE LABEL (RULE 4) --------------------------------------
// 32 of 305 battery scenarios build a byte-identical request (§2.95). A label is editable text.
{
  const sc = scenarios.find((s) => s._label === WITH_DQ);
  const renamed = { ...sc, _label: 'a completely different name', _group: 'elsewhere' };
  const leg = legOf({ client, dir: DIR });
  const a = leg ? await attempt(() => leg(sc)) : null;
  const b = leg ? await attempt(() => leg(renamed)) : null;
  ok(!!a && !!b && a.full.optionCount === b.full.optionCount && a.full.programCount === b.full.programCount,
    'E1 renaming a scenario finds the SAME capture — the key is what would be SENT, not what it is called');

  const keyA = replay.requestKey(sc);
  const keyB = replay.requestKey(renamed);
  ok(keyA === keyB, 'E2 …because the bookkeeping keys are stripped before the request is built');

  // And a real change to a PRICED FACT must move the key, or two different loans would share an answer.
  const different = { ...sc, loan: (Number(sc.loan) || 400000) + 25000 };
  ok(replay.requestKey(different) !== keyA,
    'E3 changing the loan amount DOES move the key — a different request is a different answer');

  // The key must come from the SAME builder the runner de-duplicates on; a private copy would drift.
  const direct = JSON.stringify(buildSearch(client._internals.captureScenarioMeta({ ...sc, _label: undefined, _group: undefined })));
  ok(direct === keyA, 'E4 …and the key IS `buildSearch` over the capture’s own projection, not a second definition');

  // AND IT MUST PROJECT FIRST. A LIVE scenario carries more than the capture kept — the real battery
  // scenarios carry facts (`countyFps`, `city`, `prepayMonths`, …) alongside whatever a caller put on
  // the object. Keying on the whole scenario would build a request the capture's own row can never
  // reproduce, so a captured scenario would come back as "no capture" and rule 2 would throw on one
  // that IS on disk. The fixture's rows are already projections, so this is only visible with a
  // scenario shaped like a live one.
  const live = { ...sc, someCallerPutThisHere: 'x', _seq: 12 };
  const legLive = legOf({ client, dir: DIR });
  const fromLive = legLive ? await attempt(() => legLive(live)) : null;
  ok(!!fromLive && !!a && fromLive.full.optionCount === a.full.optionCount,
    'E5 a scenario carrying facts the capture never recorded STILL finds its capture — the key projects first');
  ok(replay.requestKey(live) === keyA, 'E6 …because those extra facts are projected away before the request is built');
}

// ---- F. THE VENDOR'S OWN searchKey IS A CHECK, NOT THE KEY (RULE 5) ------------------------------
// This is the correction that MEASUREMENT forced. The capture records `meta.searchKey` — the client's
// own request identity — which looks like the perfect join key and is not usable as one: the live body
// carries the LIVE foundation (company id, live default search, live SMO ids) that a free offline
// replay does not have.
{
  const { searchKeyFor } = client._internals;
  let reproduced = 0;
  for (const r of priceRows) {
    const rebuilt = searchKeyFor(buildSearch(client._internals.captureScenarioMeta(r.meta.scenario)));
    if (rebuilt === r.meta.searchKey) reproduced += 1;
  }
  ok(priceRows.every((r) => r.meta.searchKey),
    'F1 every captured price row DOES record the vendor request identity the run used');
  ok(reproduced === 0,
    `F2 …and NONE of them can be reproduced offline (${reproduced} of ${priceRows.length}) — which is why it is not the key`);

  // It is used as a COLLISION DETECTOR instead. Two DIFFERENT stored searchKeys under one replay key
  // means two different real requests share one projection, and the replay must refuse rather than
  // hand back an arbitrary one of the two.
  const idx = attemptSync(() => replay._internals.indexCaptures(DIR, {}));
  ok(!!idx && idx.ambiguous === 0, `F3 on the real capture no key is ambiguous — ${idx ? idx.byKey.size : '?'} distinct requests, 0 collisions`);
  for (const slot of (idx ? idx.byKey.values() : [])) {
    ok(slot.searchKeys.size <= 1, 'F4 …each replay key carries at most one stored vendor request identity');
  }

  // Force the collision and prove it is REFUSED, not answered. Two rows, same scenario facts, two
  // different stored searchKeys — exactly what a projection collision would look like on disk.
  const rows = indexRows.filter((r) => r.kind === 'price');
  const forged = [
    JSON.stringify({ ...rows[0], meta: { ...rows[0].meta, searchKey: 'aaaa' } }),
    JSON.stringify({ ...rows[0], meta: { ...rows[0].meta, searchKey: 'bbbb' } }),
  ].join('\n') + '\n';
  const fakeFs = {
    readFileSync: (p, enc) => (String(p).endsWith('index.jsonl') ? forged : fs.readFileSync(p, enc)),
  };
  const legAmb = legOf({ client, dir: DIR, fs: fakeFs, zlib });
  ok(!!legAmb && legAmb.ambiguousKeys === 1, 'F5 two different vendor requests under one projection are DETECTED as ambiguous');
  let threw = null;
  try { if (legAmb) await legAmb(rows[0].meta.scenario); } catch (e) { threw = e; }
  ok(threw instanceof Error && /DIFFERENT captured requests/.test(threw.message),
    'F6 …and the scenario is REFUSED by name rather than answered with one of the two');

  const cov = attemptSync(() => replay.replayCoverage({ dir: DIR, scenarios: [rows[0].meta.scenario], fs: fakeFs }));
  ok(!!cov && cov.ambiguousScenarios.length === 1 && cov.priced === 0,
    'F7 …and coverage reports it as ambiguous rather than counting it as covered');
  ok(!!cov && cov.complete === false, 'F8 …so a replay over it is never reported as complete');
  ok(!!cov && replay.describeCoverage(cov).join(' ').includes('REFUSED as ambiguous'),
    'F9 …and it is NAMED in the plain-language description, never dropped in silence');
}

// ---- G. COVERAGE IS KNOWN BEFORE THE REPLAY RUNS -------------------------------------------------
// So a replay never discovers half-way through that it is measuring a fraction of the battery and
// reports on the fraction as though it were the whole (§2.110, in another costume).
{
  const cov = replay.replayCoverage({ dir: DIR, scenarios });
  ok(cov.scenarios === 2 && cov.priced === 2, `G1 both captured scenarios are covered (${cov.priced} of ${cov.scenarios})`);
  ok(cov.withDisqualify === 1, `G2 …and exactly one of them has a refusal tree — ${cov.withDisqualify}`);
  ok(cov.missingDisqualify.includes(NO_DQ), 'G3 …the other is NAMED as having none, not silently counted as refusing nothing');
  ok(cov.complete === true, 'G4 …and with every price present the coverage reports complete');

  const extra = { ...scenarios[0], fico: 711, _label: 'not in this capture' };
  const partial = replay.replayCoverage({ dir: DIR, scenarios: scenarios.concat([extra]) });
  ok(partial.priced === 2 && partial.missingPrice.length === 1,
    'G5 a scenario the capture cannot answer for is counted as MISSING, not skipped');
  ok(partial.missingPrice[0] === 'not in this capture', 'G6 …and named');
  ok(partial.complete === false, 'G7 …so the run is never reported as covering the whole battery');
  const lines = replay.describeCoverage(partial).join('\n');
  ok(/NOT captured/.test(lines) && /not in this capture/.test(lines),
    'G8 …and the plain-language description says so out loud');
}

// ---- H. THE READ SURVIVES A DAMAGED INDEX, AND SAYS SO -------------------------------------------
// A capture directory is written by a long paid run; a truncated last line is ordinary and must never
// take the whole replay down. But it must never pass unmentioned either.
{
  const good = fs.readFileSync(path.join(DIR, 'index.jsonl'), 'utf8');
  const torn = good + '{"kind":"price","file":"payloads/x.json.gz","meta":{"scen';
  const noScenario = torn + '\n' + JSON.stringify({ kind: 'price', file: 'payloads/y.json.gz', meta: {} }) + '\n';
  const fakeFs = { readFileSync: (p, enc) => (String(p).endsWith('index.jsonl') ? noScenario : fs.readFileSync(p, enc)) };

  const cov = attemptSync(() => replay.replayCoverage({ dir: DIR, scenarios, fs: fakeFs }));
  ok(!!cov && cov.priced === 2, 'H1 a torn last line does not stop the read — both real captures still resolve');
  ok(!!cov && cov.malformedIndexLines === 1, `H2 …and the damage is COUNTED (${cov ? cov.malformedIndexLines : 'it threw'}), not swallowed`);
  ok(!!cov && cov.unkeyableRows === 1, `H3 …as is a row carrying no usable scenario (${cov ? cov.unkeyableRows : 'it threw'})`);
  const lines = cov ? replay.describeCoverage(cov).join('\n') : '';
  ok(/malformed index line/.test(lines) && /no usable scenario/.test(lines),
    'H4 …and both are stated in the plain-language description');

  // A directory with no index at all is a THROW, not an empty answer that reads as "nothing captured".
  let threw = null;
  try { replay.replayCoverage({ dir: path.join(DIR, 'does-not-exist'), scenarios }); } catch (e) { threw = e; }
  ok(threw instanceof Error && /cannot read/.test(threw.message),
    'H5 an unreadable capture directory throws — never an empty coverage that reads as "nothing to answer for"');
}

// ---- I. THE LEG CANNOT REACH THE NETWORK ---------------------------------------------------------
// A replay that silently went upstream would spend money and stop being a replay.
{
  const leg = replay.buildReplayLpLeg({ client, dir: DIR });
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'lp-replay.js'), 'utf8');
  ok(!/\bfetch\s*\(/.test(src) && !/require\(['"](https?|node-fetch)['"]\)/.test(src),
    'I1 the module contains no HTTP call at all');
  ok(!/client\.(price|priceDisqualified|searchRaw)\b/.test(src),
    'I2 …and never calls the client’s paid entry points — only its parsers');
  // A client with ONLY parsers must be enough to build the leg.
  const parsersOnly = { parseFull: client.parseFull, parseDisqualified: client.parseDisqualified };
  const legParsers = legOf({ client: parsersOnly, dir: DIR });
  const out = legParsers ? await attempt(() => legParsers(scenarios.find((s) => s._label === WITH_DQ))) : null;
  ok(!!out && out.full.optionCount > 0 && out.disqualified.ready === true,
    'I3 …and a client exposing NOTHING but parseFull/parseDisqualified replays a full scenario');

  let threw = null;
  try { replay.buildReplayLpLeg({ client: {}, dir: DIR }); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'I4 a client with no parseFull is refused at construction, not at the first scenario');
  threw = null;
  try { replay.buildReplayLpLeg({ client, dir: '' }); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'I5 …and so is a missing capture directory');
  ok(leg.captureDir === DIR && leg.capturedKeys === 2,
    'I6 the leg reports what it is standing on — its directory and how many requests it can answer');
}

// ---- J. THE SHAPE IS THE LIVE LEG'S SHAPE --------------------------------------------------------
// `runRatesheetAgreement` consumes `{ full, disqualified }`. A replay that returned anything else would
// be a second integration to keep in step.
{
  const legs = require('../src/longterm/ppe/lp-agreement-legs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'lp-agreement-legs.js'), 'utf8');
  ok(/return\s*\{\s*full,\s*disqualified\s*\}/.test(src),
    'J1 the LIVE leg returns exactly { full, disqualified } — read out of its own source');
  const leg = legOf({ client, dir: DIR });
  const out = leg ? await attempt(() => leg(scenarios[0])) : null;
  const keys = out ? Object.keys(out).sort().join(',') : '(the leg threw)';
  ok(!!out && keys === 'disqualified,full', `J2 …and so does the replay leg — got {${keys}}`);
  ok(typeof legs.buildLpLeg === 'function', 'J3 (the live leg is still the thing being matched)');
}

// ---- K. A CAPTURE THAT PREDATES THE WIDENING SAYS SO ---------------------------------------------
// §2.120 widened what a capture RECORDS, because fourteen facts were reaching the vendor request and
// not being written down. Consequence, measured on the three real capture directories: their own stored
// rows still resolve (8/8, 2/2, 8/8) while the LIVE battery scenarios of the same labels resolve 0/8,
// 0/2 and 0/8. That is a real limit and it must READ as one — "this capture cannot be matched to a live
// scenario" is a different sentence from "this scenario was never captured", and a caller staring at
// zero coverage needs to be told which.
{
  const idx = attemptSync(() => replay._internals.indexCaptures(DIR, {}));
  ok(!!idx && idx.preWidening === true,
    'K1 the fixture was captured BEFORE the widening, and the reader recognises that from the rows themselves');

  // …and recognising it must not stop it working: its own stored rows still resolve completely.
  const own = replay.replayCoverage({ dir: DIR, scenarios });
  ok(own.priced === 2 && own.complete === true,
    'K2 …and an old capture is still fully readable from its own stored rows — recognition is not refusal');
  ok(!replay.describeCoverage(own).join(' ').includes('PREDATES'),
    'K3 …so nothing is said about it while everything resolves');

  // The sentence appears only when a scenario actually misses.
  const missing = { ...scenarios[0], fico: 711, _label: 'a live scenario' };
  const cov = replay.replayCoverage({ dir: DIR, scenarios: scenarios.concat([missing]) });
  const lines = replay.describeCoverage(cov).join('\n');
  ok(cov.preWidening === true && /PREDATES/.test(lines),
    'K4 the moment something cannot be matched, the reason is NAMED rather than left as a bare zero');
  ok(/readable only from its own stored rows/.test(lines),
    'K5 …in words that say what the capture CAN still answer, not only what it cannot');

  // And the throw carries it too — the leg is where a run actually meets this.
  const leg = legOf({ client, dir: DIR });
  let threw = null;
  try { if (leg) await leg(missing); } catch (e) { threw = e; }
  ok(threw instanceof Error && /predates/.test(threw.message),
    'K6 …and so does the error a replay run would actually see');

  // A capture written AFTER the widening must NOT be labelled old. Proven by handing the reader a row
  // whose scenario carries one of the widened facts.
  const rows = indexRows.map((r) => (r.kind === 'price'
    ? { ...r, meta: { ...r.meta, scenario: { ...r.meta.scenario, prepayMonths: 60 } } } : r));
  const fakeFs = {
    readFileSync: (pth, enc) => (String(pth).endsWith('index.jsonl')
      ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : fs.readFileSync(pth, enc)),
  };
  const modern = attemptSync(() => replay._internals.indexCaptures(DIR, { fs: fakeFs }));
  ok(!!modern && modern.preWidening === false,
    'K7 a capture that DOES record the widened facts is not mislabelled as an old one');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack || e); process.exit(1); });

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied on its own to src/longterm/ppe/lp-replay.js, control green either side,
 * and each verified to have APPLIED (md5 before/after) before the result was believed.
 *   M1  rule 2: a missing capture returns { full:{}, disqualified:{ready:false} } instead of throwing
 *                                                                    → C1/C2/C3 fail
 *   M2  rule 3: a missing refusal tree returns { ready:true, lenders:[] } → D1/D2/D6 fail
 *   M3  rule 4: key on `scenario._label` instead of the request       → E1/E2/E4 fail
 *   M4  rule 5: drop the ambiguity guard (answer with the last write)  → F5/F6/F7/F8/F9 fail
 *   M5  rule 1: cache the parsed result on the slot and return it      → B6 fails (it stops being the parser)
 *   M6  readIndexRows: rethrow on a malformed line                     → H1/H2 fail (one torn line kills the read)
 *   M7  readIndexRows: swallow a missing index and return no rows      → H5 fails (silence reads as "nothing captured")
 *   M8  coverage: count an ambiguous scenario as priced                → F7/F8 fail
 *   M9  requestKey: use the FULL scenario, not the capture projection  → E4 fails. NOTE: after the
 *                                                                        §2.120 widening this is
 *                                                                        BEHAVIOURALLY EQUIVALENT for
 *                                                                        a battery scenario (the
 *                                                                        allowlist now covers every
 *                                                                        request-affecting fact), so
 *                                                                        only E4 bites — recorded
 *                                                                        rather than dressed up as a
 *                                                                        stronger result than it is.
 *   M10 looksPreWidening: always return false                          → K1/K4/K6 fail (a bare zero
 *                                                                        with no reason)
 *   M11 looksPreWidening: always return true                           → K3/K7 fail (an old-capture
 *                                                                        warning on a modern one)
 * ------------------------------------------------------------------------------------------- */
