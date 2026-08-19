'use strict';
/**
 * LT PPE — REPLAY A PAID LENDER PRICE RUN FROM ITS OWN CAPTURE (§2.120).
 *
 * WHY. Every paid agreement run writes its raw vendor payloads to disk (`lenderprice/capture.js` — the
 * owner's own instruction: *"save all the data that is coming back, compress the data somewhere in the
 * logs"*). Measured live: 335 MB of vendor JSON compressed to 8.5 MB. And **nothing ever read it back.**
 * So the evidence behind §2.111, §2.113 and §2.114 existed only as numbers quoted in a document, and the
 * moment a container is reclaimed the ability to re-check them goes with it. A comparator fixed
 * tomorrow cannot be re-run against the answers Lender Price actually gave today.
 *
 * This is the read side. It turns a capture directory into the SAME `{ full, disqualified }` leg the
 * live run uses, so `runRatesheetAgreement` can be re-run over a past run for nothing — which is what
 * makes a fix to the crosswalk, the reconciler or the report provable against real vendor answers
 * instead of a fixture written from memory.
 *
 * ⛔ FIVE RULES. Each is here because of a way this goes wrong, and the last one was MEASURED rather
 * than reasoned — the design it replaced was wrong.
 *
 * 1. **REPLAY THROUGH THE LIVE PARSERS, NEVER A STORED RESULT.** The capture holds the RAW vendor
 *    envelope, and this hands it to the caller's own `client.parseFull` / `client.parseDisqualified`.
 *    Replaying a stored PARSED answer would prove what the parser did on the day of capture and would
 *    go on agreeing with itself forever — the §2.107 lossy-replay mistake, which is why that replay was
 *    discarded and §2.110's (which stores exactly the rows the report consumes) was kept.
 *
 * 2. **A SCENARIO WITH NO CAPTURE THROWS.** It must never come back as an empty answer: an empty ladder
 *    reads as "Lender Price offers nothing", which is a verdict, and inventing a verdict out of a
 *    missing file is the single most expensive thing this file could do.
 *
 * 3. **A MISSING DISQUALIFY TREE IS `ready:false`, NOT AN EMPTY ONE.** That is the same shape the LIVE
 *    leg produces when the vendor's asynchronous refusal poll times out, and the harness already reads
 *    it as "we never asked" rather than "Lender Price refused nothing" (§2.147/`--no-disqualify`). An
 *    empty READY tree would silently turn every scenario into a both-priced comparison.
 *
 * 4. **THE JOIN KEY IS THE REQUEST, NOT THE LABEL.** Two DIFFERENT battery scenarios can build a
 *    byte-identical request — measured, 32 of 305 (§2.95) — and a label is editable text. So the key is
 *    what `buildSearch` would send.
 *
 * 5. **THE KEY IS BUILT FROM THE CAPTURE'S OWN PROJECTION, AND THE VENDOR'S `searchKey` IS A CHECK,
 *    NOT THE KEY.** This is the correction. The capture records `meta.searchKey` — the client's own
 *    request identity (`searchKeyFor`, the sha256 of the body the run actually sent), which looks like
 *    the perfect join key. It is not usable as one, and the reason is measurable: the live body carries
 *    the LIVE foundation (the company id, the live default search, the live special-mortgage-option
 *    ids) that a FREE, OFFLINE replay does not have, so a body rebuilt here hashes differently. Checked
 *    against the three real capture directories on disk: **0 of 12 stored searchKeys reproduced.** So
 *    the key is `buildSearch(projection)` — computed by the SAME code on both sides, where `projection`
 *    is `captureScenarioMeta`, the client's OWN allowlist, imported rather than copied so it cannot
 *    drift from what the capture writes.
 *
 *    That projection is a SUBSET of the scenario, so two scenarios differing only outside the allowlist
 *    would land on one key. That is not assumed away — it is DETECTED: each key carries the set of
 *    stored `searchKey`s filed under it, and a key holding more than one is AMBIGUOUS. The replay
 *    REFUSES an ambiguous key rather than handing back one of two different vendor answers. Measured on
 *    the real captures: 28 rows → 18 keys, zero ambiguous, every price paired with its refusal tree.
 *
 * PURE-ISH: no network, no database, no clock. `fs`/`zlib`, the request builder, the projection and the
 * client are all injected, so the module is testable against a real capture on disk or a stub. LT-only.
 * No RTL imports.
 */

// The battery's own bookkeeping keys ride inside the capture's allowlist (`_label`, `_group`) but are
// NOT part of the request; leaving them in would make two scenarios that send the same body look
// different purely because they are labelled differently — the §2.95 de-duplication, undone.
function stripInternal(sc) {
  const o = { ...(sc || {}) };
  delete o._label; delete o._group; delete o._ineligible;
  return o;
}

function defaultProject() {
  return require('../lenderprice/client')._internals.captureScenarioMeta;
}

/**
 * Does this capture directory predate the §2.120 widening of what a capture records?
 *
 * WHY THIS EXISTS, and why there is deliberately NO legacy fallback. Before §2.120 the capture's
 * allowlist dropped FOURTEEN facts that reach the vendor request, so a row written then cannot be
 * matched to a LIVE scenario: the live one builds a request naming a county, a prepay term, an escrow
 * waiver — and the stored row cannot. MEASURED on the three real capture directories: their own stored
 * rows still resolve 8/8, 2/2 and 8/8, and the LIVE battery scenarios of the very same labels resolve
 * 0/8, 0/2 and 0/8.
 *
 * A fallback that re-keyed on the old narrow projection was considered and REFUSED: two different live
 * scenarios can collapse onto one narrow key (measured — 6 keys, one of them covering 15 scenarios), so
 * such a fallback would hand one loan's vendor answer to another, and it could only be made safe by
 * knowing the whole scenario set in advance. Answering with the wrong evidence is exactly what this
 * module exists to prevent. So an old capture is REPORTED, not rescued — "this capture cannot be
 * matched to a live scenario" is a different sentence from "this scenario was never captured", and a
 * caller must be told which one it is looking at.
 */
function looksPreWidening(rows) {
  const client = require('../lenderprice/client')._internals;
  const widened = client.CAPTURE_SCENARIO_KEYS.filter((k) => !client.CAPTURE_SCENARIO_KEYS_PRE_2120.includes(k));
  let seen = 0;
  let withWidened = 0;
  for (const r of rows) {
    const sc = r && r.meta && r.meta.scenario;
    if (!sc || typeof sc !== 'object') continue;
    seen += 1;
    if (widened.some((k) => sc[k] !== undefined)) withWidened += 1;
  }
  return seen > 0 && withWidened === 0;
}
function defaultBuildSearch() {
  return require('../lenderprice/search-model').buildSearch;
}

/**
 * The request identity of a scenario: what `buildSearch` would send for the facts the capture keeps.
 * Returns null when the scenario cannot build a request — an unbuildable scenario is never merged with
 * anything and never matched to a capture.
 */
function requestKey(scenario, opts = {}) {
  const buildSearch = opts.buildSearch || defaultBuildSearch();
  const project = opts.project || defaultProject();
  if (typeof buildSearch !== 'function') throw new Error('requestKey needs the request builder');
  try {
    return JSON.stringify(buildSearch(stripInternal(project(scenario))));
  } catch (_) { return null; }
}

// One index row per captured payload. A malformed line is SKIPPED and COUNTED, never allowed to kill
// the read: a capture directory is written by a long paid run and a truncated last line is ordinary.
function readIndexRows(dir, fs) {
  const path = `${String(dir).replace(/\/+$/, '')}/index.jsonl`;
  let text;
  try { text = fs.readFileSync(path, 'utf8'); } catch (e) {
    throw new Error(`replay: cannot read ${path}: ${(e && e.message) || e}`);
  }
  const rows = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch (_) { malformed += 1; }
  }
  return { rows, malformed };
}

/**
 * Build the lookup: request key → { price, disqualify, searchKeys, ambiguous }.
 *
 * LAST WRITE WINS on a repeated key, deliberately: a capture directory can hold two runs of the same
 * scenario (a retry, or two runs written into one directory) and the later answer is the one that run
 * saw. `searchKeys` is what makes that safe — repeats of the SAME request share one stored searchKey,
 * while two DIFFERENT requests colliding on one projection show up as two, and rule 5 refuses the key.
 */
function indexCaptures(dir, opts = {}) {
  const fs = opts.fs || require('fs');
  const keyOpts = { buildSearch: opts.buildSearch || defaultBuildSearch(), project: opts.project || defaultProject() };
  const { rows, malformed } = readIndexRows(dir, fs);
  const byKey = new Map();
  let unkeyable = 0;
  for (const r of rows) {
    const sc = r && r.meta && r.meta.scenario;
    const key = sc ? requestKey(sc, keyOpts) : null;
    if (!key) { unkeyable += 1; continue; }
    const slot = byKey.get(key)
      || { price: null, disqualify: null, searchKeys: new Set(), labels: new Set(), evicted: new Set() };
    if (r.kind === 'price' || r.kind === 'disqualify') {
      // LAST WRITE WINS, but only among rows we can actually READ. A capture directory can hold two
      // runs of one scenario and the later answer is the one that run saw — yet a later row whose bytes
      // the budget has since evicted is not an answer at all, and an older surviving payload for the
      // SAME REQUEST is a real vendor answer we still hold. So the newest PRESENT row wins, and the
      // fact that a newer one was dropped is recorded rather than lost.
      if (payloadPresent(dir, r, fs)) slot[r.kind] = r;
      else slot.evicted.add(r.kind);
    }
    if (r.meta && r.meta.searchKey) slot.searchKeys.add(r.meta.searchKey);
    if (sc && sc._label) slot.labels.add(sc._label);
    byKey.set(key, slot);
  }
  let ambiguous = 0;
  let evictedKeys = 0;
  for (const slot of byKey.values()) {
    slot.ambiguous = slot.searchKeys.size > 1;
    if (slot.ambiguous) ambiguous += 1;
    // A key whose PRICE bytes are gone with nothing surviving to fall back on. Counted apart from a
    // key that merely lost a newer duplicate — one cannot answer, the other still can.
    slot.priceEvicted = !slot.price && slot.evicted.has('price');
    if (slot.priceEvicted) evictedKeys += 1;
  }
  return { byKey, rows, malformed, unkeyable, ambiguous, evictedKeys, preWidening: looksPreWidening(rows) };
}

/**
 * Are the BYTES of this captured payload still on disk?
 *
 * ⛔ THE INDEX IS NOT THE EVIDENCE. `capture.js enforceBudget()` bounds a capture directory by
 * unlinking payloads OLDEST FIRST once it passes `LP_CAPTURE_MAX_MB`, and it deliberately never
 * touches `index.jsonl` — its own words: "the index is the record that a payload once existed, which
 * stays true after the bytes are evicted." So on exactly the long paid runs worth replaying, the index
 * carries rows whose payloads are gone. Counting index rows as coverage reports a capture as complete
 * that cannot answer, and the run then dies part-way on a raw ENOENT. `capture.readIndex` already gets
 * this right (`present: fs.existsSync(...)`); this is the reader doing the same.
 *
 * Cheapest available check, degrading rather than refusing: `existsSync`, then `statSync`, then an
 * actual read. The fallbacks matter because `fs` is INJECTED — a caller (or a test) may hand in a
 * partial object, and a presence test that silently answered "yes" for a stub would re-open exactly the
 * hole this closes.
 */
function payloadPresent(dir, row, fs) {
  if (!row || !row.file) return false;
  const full = `${String(dir).replace(/\/+$/, '')}/${row.file}`;
  try {
    if (typeof fs.existsSync === 'function') return !!fs.existsSync(full);
    if (typeof fs.statSync === 'function') { fs.statSync(full); return true; }
    fs.readFileSync(full);
    return true;
  } catch (_) { return false; }
}

function readPayload(dir, row, { fs, zlib }) {
  const file = `${String(dir).replace(/\/+$/, '')}/${row.file}`;
  const buf = fs.readFileSync(file);
  const json = /\.gz$/.test(row.file) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return JSON.parse(json);
}

/**
 * buildReplayLpLeg({ client, dir, buildSearch, project, fs, zlib, withDisqualify })
 *   → async (scenario) => { full, disqualified }   — the SAME shape `buildLpLeg` returns.
 *
 * `client` supplies `parseFull` / `parseDisqualified` ONLY; nothing here can reach the network, and the
 * leg is deliberately unable to fall back to a live call — a replay that silently went upstream would
 * spend money and stop being a replay.
 */
function buildReplayLpLeg(opts = {}) {
  const { client, dir } = opts;
  const fs = opts.fs || require('fs');
  const zlib = opts.zlib || require('zlib');
  const withDisqualify = opts.withDisqualify !== false;
  if (!client || typeof client.parseFull !== 'function') {
    throw new Error('buildReplayLpLeg: client must expose parseFull()');
  }
  if (!dir) throw new Error('buildReplayLpLeg: a capture directory is required');
  const keyOpts = { buildSearch: opts.buildSearch || defaultBuildSearch(), project: opts.project || defaultProject() };
  const { byKey, malformed, unkeyable, ambiguous, evictedKeys, preWidening } = indexCaptures(dir, { fs, ...keyOpts });

  const leg = async function replay(scenario) {
    const label = (scenario && scenario._label) || 'unlabelled scenario';
    const key = requestKey(scenario, keyOpts);
    const slot = key == null ? null : byKey.get(key);
    // RULE 2 — a missing capture is a THROW, never an empty answer that reads as a verdict.
    if (!slot || !slot.price) {
      // "We captured this and its bytes aged out of the budget" and "we never captured this" are
      // different facts, and only one of them is fixed by re-running the battery. Say which.
      if (slot && slot.priceEvicted) {
        throw new Error(`replay: the captured price for “${label}” has been EVICTED from ${dir}`
          + ' — the index still records it, but `capture.js enforceBudget()` removed the payload to stay'
          + ' under LP_CAPTURE_MAX_MB. The answer is gone; only a fresh paid run can replace it.');
      }
      throw new Error(`replay: no captured price for “${label}” in ${dir} — this run cannot answer for it`
        + (preWidening ? ' (this capture predates §2.120: its rows do not record every fact the request carries,'
          + ' so a live scenario cannot be matched to them — it is readable only from its own stored rows)' : ''));
    }
    // RULE 5 — two different vendor requests filed under one projection. Answering with either would be
    // a guess dressed as evidence, so the scenario is refused by name instead.
    if (slot.ambiguous) {
      throw new Error(`replay: “${label}” matches ${slot.searchKeys.size} DIFFERENT captured requests in ${dir}`
        + ` (${[...slot.labels].join(', ')}) — the capture cannot say which answer is this scenario's`);
    }
    const full = client.parseFull(readPayload(dir, slot.price, { fs, zlib }));
    // RULE 3 — no captured refusal tree is "we never asked", the shape a live timeout produces.
    let disqualified = { ready: false, lenders: [] };
    if (withDisqualify && slot.disqualify && typeof client.parseDisqualified === 'function') {
      disqualified = client.parseDisqualified(readPayload(dir, slot.disqualify, { fs, zlib })) || disqualified;
    }
    return { full, disqualified };
  };
  leg.captureDir = dir;
  leg.capturedKeys = byKey.size;
  leg.malformedIndexLines = malformed;
  leg.unkeyableRows = unkeyable;
  leg.ambiguousKeys = ambiguous;
  leg.preWidening = preWidening;
  leg.evictedKeys = evictedKeys;
  return leg;
}

/**
 * What a capture directory can and cannot answer for, BEFORE a replay is run — so a replay never
 * discovers half-way through that it is measuring a fraction of the battery and reports on the fraction
 * as though it were the whole (the §2.110 defect, in another costume).
 */
function replayCoverage(opts = {}) {
  const { dir, scenarios } = opts;
  const fs = opts.fs || require('fs');
  const keyOpts = { buildSearch: opts.buildSearch || defaultBuildSearch(), project: opts.project || defaultProject() };
  const { byKey, malformed, unkeyable, ambiguous, evictedKeys, preWidening } = indexCaptures(dir, { fs, ...keyOpts });
  const list = Array.isArray(scenarios) ? scenarios : [];
  const out = {
    scenarios: list.length,
    capturedKeys: byKey.size,
    priced: 0,
    withDisqualify: 0,
    missingPrice: [],
    evicted: [],
    missingDisqualify: [],
    ambiguousScenarios: [],
    unbuildable: [],
    malformedIndexLines: malformed,
    unkeyableRows: unkeyable,
    ambiguousKeys: ambiguous,
    evictedKeys,
    preWidening,
  };
  for (let i = 0; i < list.length; i += 1) {
    const sc = list[i];
    const label = (sc && sc._label) || `#${i}`;
    const key = requestKey(sc, keyOpts);
    if (key == null) { out.unbuildable.push(label); continue; }
    const slot = byKey.get(key);
    if (!slot || !slot.price) {
      if (slot && slot.priceEvicted) out.evicted.push(label); else out.missingPrice.push(label);
      continue;
    }
    if (slot.ambiguous) { out.ambiguousScenarios.push(label); continue; }
    out.priced += 1;
    if (slot.disqualify) out.withDisqualify += 1; else out.missingDisqualify.push(label);
  }
  out.complete = out.missingPrice.length === 0 && out.evicted.length === 0
    && out.unbuildable.length === 0 && out.ambiguousScenarios.length === 0;
  return out;
}

/** The coverage in plain lines, so a caller never composes its own wording. */
function describeCoverage(cov) {
  const lines = [];
  lines.push(`capture covers ${cov.priced} of ${cov.scenarios} scenario(s)`
    + ` (${cov.withDisqualify} with a refusal tree, ${cov.capturedKeys} distinct request(s) on disk)`);
  if (cov.missingPrice.length) {
    lines.push(`NOT captured — a replay cannot answer for ${cov.missingPrice.length}: ${cov.missingPrice.slice(0, 6).join(', ')}`
      + (cov.missingPrice.length > 6 ? `, and ${cov.missingPrice.length - 6} more` : ''));
  }
  if (cov.evicted.length) {
    lines.push(`captured but EVICTED — the payload aged out of the capture budget for ${cov.evicted.length}:`
      + ` ${cov.evicted.slice(0, 6).join(', ')}${cov.evicted.length > 6 ? `, and ${cov.evicted.length - 6} more` : ''}`
      + ' (the index still records them; only a fresh paid run can replace the answer)');
  }
  if (cov.missingDisqualify.length) {
    lines.push(`captured WITHOUT a refusal tree (${cov.missingDisqualify.length}) — those scenarios replay as`
      + ' "we never asked", never as "Lender Price refused nothing"');
  }
  if (cov.ambiguousScenarios.length) {
    lines.push(`REFUSED as ambiguous (${cov.ambiguousScenarios.length}) — more than one captured request`
      + ` shares their recorded facts: ${cov.ambiguousScenarios.slice(0, 6).join(', ')}`);
  }
  if (cov.preWidening && cov.missingPrice.length) {
    lines.push('this capture PREDATES §2.120 — its rows do not record every fact the request carries, so a live'
      + ' scenario cannot be matched to them; it is readable only from its own stored rows');
  }
  if (cov.unbuildable.length) lines.push(`could not build a request for ${cov.unbuildable.length}: ${cov.unbuildable.join(', ')}`);
  if (cov.malformedIndexLines) lines.push(`${cov.malformedIndexLines} malformed index line(s) skipped`);
  if (cov.unkeyableRows) lines.push(`${cov.unkeyableRows} captured row(s) carry no usable scenario`);
  return lines;
}

module.exports = {
  buildReplayLpLeg, replayCoverage, describeCoverage, requestKey,
  _internals: { stripInternal, indexCaptures, readIndexRows, readPayload, defaultProject, defaultBuildSearch },
};
