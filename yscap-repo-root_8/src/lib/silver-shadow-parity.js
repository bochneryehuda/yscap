'use strict';
/**
 * SILVER SHADOW-EXCEL PARITY MONITOR (owner-directed 2026-07-30).
 *
 * "Keep the excel sheet in the back end running on actual scenarios that
 *  people are actually putting in — if you see any mismatch of what you are
 *  giving and what the Excel sheet is showing you should raise that concern —
 *  ineligible coming up eligible, or pricing lower or higher than it needs to
 *  be — maybe as a manual review — not something that should change anything
 *  of the static thing."
 *
 * WATCH-ONLY. This module re-checks every live Silver quote/registration
 * against scripts/fixtures/emcap-pricing-tool-v1.json — the validated
 * transcription of the note buyer's pricing workbook (the same fixture the
 * 204,000-scenario matrix in scripts/test-silver-workbook-matrix.js ties out
 * against). It NEVER blocks, changes, delays or fails a quote:
 *   - called after the response is already sent (setImmediate at the routes);
 *   - any internal error fails OPEN ({ ok:true, skipped:'error' });
 *   - a mismatch records ONE advisory ai_suggestions row (severity 'warning',
 *     never fatal — no email storm) for a human to review manually.
 * Kill switch: SILVER_SHADOW_PARITY=0 disables the monitor (default ON).
 *
 * INDEPENDENCE. The expected cell is derived from the FIXTURE's OWN band
 * labels and tier-grid rows — a compact reimplementation of the INDEPENDENT
 * RESOLVER in scripts/test-silver-workbook-matrix.js (band-edge parsing, tier
 * thresholds, term bucketing, 9-part key assembly, knife-edge tolerance). It
 * never reads the engine's internal RATE_BLOCKS/TG tables. The frozen engine
 * (web/tools/silver-program.js — the exact copy src/lib/pricing.js prices on)
 * is only RE-RUN to reproduce the raw structure of the quote being checked
 * (market / size band / achieved ratios / effective caps), because the
 * normalized quote the routes hold has floored dollars and no rate key; the
 * matrix proved those structural echoes correct against independently
 * generated scenarios. Nothing in the engine is modified.
 *
 * KNIFE-EDGE TOLERANCE (mirrors the matrix runner's exact semantics — without
 * it ~0.9% of real files would false-flag): a loan sized exactly ON a cap that
 * coincides with a band boundary can carry float noise (0.925 + 2e-16), so:
 *   (a) a PRICED rate is accepted when it is a real workbook rate of the same
 *       market|size|product|purpose|term|tier family, the achieved LTC/AR
 *       ratio (snapped to the 1e-9 lattice) sits within 1e-6 of a band edge,
 *       and the rate is never BELOW the exact-decimal cell (an UNDER-priced
 *       rate is ALWAYS a mismatch — that direction has no tolerance);
 *   (b) a MANUAL "no priced grid cell" verdict is accepted when the ratio is
 *       on a band edge and the engine's own raw-float band is genuinely
 *       unpriced while the exact-decimal side has a cell (conservative:
 *       manual review, never a wrong rate).
 *
 * SCOPE (deliberate): the monitor watches the PRICING-GRID surface — cell
 * existence, the buy/note rate tie-up, tier caps, the tier-row gate (e.g. the
 * workbook has no tier-3 F&F refi program). Hard-gate refusals that never
 * reach sizing (geography, property type, value-add, DSCR, term gates) are
 * shared transcriptions already proven by the 204k matrix in CI; with no sized
 * structure there is no cell to compare, so those return ok with a note.
 * Admin-exception scenarios (rate/leverage overrides, forcePrice) are skipped:
 * the workbook would not price a deliberate override, so flagging it is noise.
 */

const path = require('path');

const MIN_LOAN = 100000;
const SMALL_MAX = 2500000;
const DEFAULT_MARKUP = 0.005;
const MARKUP_MAX = 0.01;

/* ---------------- tiny coercers (no deps) ---------------- */
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function clean(s) { return String(s == null ? '' : s).trim(); }
function snap6(x) { return Math.round(x * 1e6) / 1e6; }
function snap9(r) { return Math.round(r * 1e9) / 1e9; }
function pctS(r) { return (Math.round(num(r) * 100000) / 1000) + '%'; }
function usd(n) { return '$' + Math.round(num(n)).toLocaleString('en-US'); }

/* ---------------- lazy singletons ---------------- */
let _fixture;            // parsed fixture JSON (loaded once)
let _resolver;           // built band classifiers etc. (built once)
let _engine;             // frozen silver engine (same copy pricing.js uses)
let _engineTried = false;
let _warned = false;

function loadFixture() {
  if (_fixture !== undefined) return _fixture;
  try {
    _fixture = require(path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'emcap-pricing-tool-v1.json'));
  } catch (_) { _fixture = null; }
  return _fixture;
}

function engine() {
  if (_engineTried) return _engine;
  _engineTried = true;
  try { _engine = require(path.join(__dirname, '..', '..', 'web', 'tools', 'silver-program.js')); }
  catch (_) { _engine = null; }
  return _engine;
}

/* ---------------- fixture-label parsing (matrix-runner derivation) ---------------- */
function parsePctBand(label) {
  let m = /^<(\d+(?:\.\d+)?)%$/.exec(label);
  if (m) return { label, max: snap6(parseFloat(m[1]) / 100) };
  m = /^(\d+(?:\.\d+)?)%-(\d+(?:\.\d+)?)%$/.exec(label);
  if (m) return { label, max: snap6(parseFloat(m[2]) / 100) };
  return null;
}
function parseFicoBand(label) {
  let m = /^FICO (\d+)\+$/.exec(label);
  if (m) return { label, min: +m[1], max: Infinity };
  m = /^FICO (\d+)-(\d+)$/.exec(label);
  if (m) return { label, min: +m[1], max: +m[2] };
  return null;
}

/**
 * Build the independent resolver ONCE from the fixture's own keys/labels.
 * Fixture-side integrity only — a drifted/unloadable fixture marks the
 * resolver invalid and every check fails OPEN (skipped). Engine drift is NOT
 * an init failure: that is exactly what the per-scenario checks must surface.
 */
function resolver() {
  if (_resolver !== undefined) return _resolver;
  try {
    const FIX = loadFixture();
    if (!FIX || !FIX.rates || !FIX.tierGrid) throw new Error('fixture unavailable');
    const keys = Object.keys(FIX.rates);
    if (keys.length !== 1555) throw new Error(`fixture has ${keys.length} rate cells, expected 1555`);
    if (Object.keys(FIX.tierGrid).length !== 18) throw new Error('fixture tierGrid is not 18 rows');
    const arSet = new Set(), ltcSet = new Set();
    const ficoByTier = { 1: new Set(), 2: new Set(), 3: new Set() };
    const familyRates = {};
    for (const k of keys) {
      const p = k.split('|');
      if (p.length !== 9) throw new Error(`rate key '${k}' is not 9-part`);
      arSet.add(p[6]); ltcSet.add(p[8]);
      const t = +p[5].slice(1);
      if (!ficoByTier[t]) throw new Error(`rate key '${k}' has a bad tier token`);
      ficoByTier[t].add(p[7]);
      const fam = p.slice(0, 6).join('|');
      (familyRates[fam] = familyRates[fam] || new Set()).add(Math.round(FIX.rates[k] * 1e6));
    }
    const AR = [...arSet].map(parsePctBand).sort((a, b) => a.max - b.max);
    const LTC = [...ltcSet].map(parsePctBand).sort((a, b) => a.max - b.max);
    const FICO = {
      1: [...ficoByTier[1]].map(parseFicoBand).sort((a, b) => b.min - a.min),
      2: [...ficoByTier[2]].map(parseFicoBand).sort((a, b) => b.min - a.min),
      3: [...ficoByTier[3]].map(parseFicoBand).sort((a, b) => b.min - a.min),
    };
    if (AR.some((b) => !b) || LTC.some((b) => !b) || [1, 2, 3].some((t) => FICO[t].some((b) => !b))) {
      throw new Error('unparseable band label in the fixture keys');
    }
    // Every band BOUNDARY number — uppers AND lowers ("<64.99%" and
    // "65.00%-70.00%" leave a gap, and tier caps sit exactly ON lower bounds).
    const edges = new Set();
    for (const label of [...arSet, ...ltcSet]) {
      let m = /^<(\d+(?:\.\d+)?)%$/.exec(label);
      if (m) edges.add(snap6(parseFloat(m[1]) / 100));
      m = /^(\d+(?:\.\d+)?)%-(\d+(?:\.\d+)?)%$/.exec(label);
      if (m) { edges.add(snap6(parseFloat(m[1]) / 100)); edges.add(snap6(parseFloat(m[2]) / 100)); }
    }
    _resolver = { ok: true, rates: FIX.rates, tierGrid: FIX.tierGrid, AR, LTC, FICO, EDGES: [...edges], familyRates };
  } catch (e) {
    _resolver = { ok: false, reason: (e && e.message) || 'resolver init failed' };
    if (!_warned) { _warned = true; try { console.warn('[silver-shadow-parity] resolver disabled:', _resolver.reason); } catch (_) {} }
  }
  return _resolver;
}

/* ---------------- independent classifiers (fixture-derived) ---------------- */
function myArBand(R, r) { if (!(r > 0)) return null; for (const b of R.AR) if (r <= b.max) return b.label; return null; }
function myLtcBand(R, r) { if (!(r > 0)) return null; for (const b of R.LTC) if (r <= b.max) return b.label; return null; }
function myFicoBand(R, tier, fico) {
  if (!(fico > 0) || !R.FICO[tier]) return null;
  for (const b of R.FICO[tier]) if (fico >= b.min && fico <= b.max) return b.label;
  return null;   // e.g. tier-3 FICO 640-679: real workbook band, zero priced cells
}
function nearBandEdge(R, r) { for (const e of R.EDGES) if (Math.abs(r - e) < 1e-6) return true; return false; }

// Workbook Tier Grid experience thresholds (transcribed from the workbook —
// same table the matrix runner carries; cross-checked against the engine by
// the matrix in CI). GC-only experience caps the tier (T2 small / T3 large).
function myTier(sizeBand, n, gcOnly) {
  let t;
  if (sizeBand === 'L') t = n >= 5 ? 1 : (n >= 2 ? 2 : 3);
  else t = n >= 3 ? 1 : (n >= 1 ? 2 : 3);
  if (gcOnly) t = sizeBand === 'L' ? 3 : Math.max(t, 2);
  return t;
}
// Product token in the fixture/grid dialect (FF / GUC / BR) — transcription of
// the frozen normStrategy + prodToken pair, kept independent of the engine.
function myProdToken(strategy) {
  const s = clean(strategy).toLowerCase();
  if (s.indexOf('ground') > -1 || s.indexOf('construction') > -1 || s === 'nc') return 'GUC';
  if (s.indexOf('bridge') > -1 || s === 'br') return 'BR';
  return 'FF';
}
// Comparable-project count: ground-up deals count ground-up projects only.
function myProjectCount(prodTok, input) {
  const flips = Math.max(0, num(input.expFlips)), holds = Math.max(0, num(input.expHolds)), ground = Math.max(0, num(input.expGround));
  return prodTok === 'GUC' ? ground : flips + holds + ground;
}
function myTermToken(months) {
  const t = num(months) || 12;
  if (t <= 12) return '12';
  if (t <= 18) return '18';
  return '24';
}
function tgRow(R, prodTok, purp, tier) {
  const row = R.tierGrid[`${prodTok}|${purp}|T${tier}`];
  return (row && row.maxloan > 0) ? row : null;   // empty row = the workbook has no such program
}
function myKeyOf(R, mkt, sizeBand, prodTok, purp, termTok, tier, arRatio, fico, ltcRatio) {
  const arB = myArBand(R, arRatio), fB = myFicoBand(R, tier, fico), lB = myLtcBand(R, ltcRatio);
  if (!arB || !fB || !lB) return null;
  return [mkt, sizeBand, prodTok, purp, termTok, 'T' + tier, arB, fB, lB].join('|');
}
// The engine's OWN raw-float band key (via its pure helpers, '-' placeholders)
// — only used to prove a MANUAL no-cell verdict honest on a knife edge.
function engKeyOf(SVP, mkt, sizeBand, prodTok, purp, termTok, tier, arRatio, fico, ltcRatio) {
  const arB = SVP.arBand(arRatio), fB = SVP.ficoBand(tier, fico), lB = SVP.ltcBand(ltcRatio);
  return [mkt, sizeBand, prodTok, purp, termTok, 'T' + tier, arB || '-', fB || '-', lB || '-'].join('|');
}

/* ---------------- markup resolution (exactly as quoteProgram resolves it) ---------------- */
function resolveMarkup(input) {
  const v = input && input.markupSilverPct;
  if (v != null && v !== '') { const n = Number(v); if (isFinite(n)) return n / 100; }
  try {
    const cd = require('./pricing-settings').current();
    if (cd && cd.markupSilverPct != null) { const n = Number(cd.markupSilverPct); if (isFinite(n)) return n / 100; }
  } catch (_) { /* settings unavailable → engine default */ }
  return null;
}
// setMarkup()/effMarkup() semantics of the frozen engine: null / negative /
// non-finite → the 0.5% default; anything else clamps to the 1.00pt cap.
function effMarkupOf(m) {
  if (typeof m === 'number' && isFinite(m) && m >= 0) return Math.min(m, MARKUP_MAX);
  return DEFAULT_MARKUP;
}

/* ---------------- kill switch ---------------- */
function enabled() { return process.env.SILVER_SHADOW_PARITY !== '0'; }

/* =====================================================================
 * shadowCheck(input, result, opts)
 *   input  — the engine input the quote ran on (src/lib/pricing.js
 *            buildInputs output; the same object quoteProgram evaluated).
 *   result — the engine evaluation as served (normalized quote or raw
 *            evaluation): status, noteRate, sizing, tierLabel, rateKey if
 *            present. The rate/status CLAIMS are checked from here.
 *   opts   — { markup, evOverride } (test hooks; evOverride replaces the
 *            engine replay so tolerance branches can be exercised directly).
 * Returns { ok:true, ... } | { ok:false, kind, detail, ... }.
 * kinds: eligibility_mismatch | rate_mismatch | cap_mismatch.
 * NEVER throws — any internal error returns { ok:true, skipped:'error' }.
 * ===================================================================== */
function shadowCheck(input, result, opts) {
  try {
    return shadowCheckInner(input, result, opts || {});
  } catch (_) {
    return { ok: true, skipped: 'error' };
  }
}

function shadowCheckInner(input, result, opts) {
  if (!input || typeof input !== 'object' || !result || typeof result !== 'object') {
    return { ok: true, skipped: 'bad_input' };
  }
  const R = resolver();
  if (!R.ok) return { ok: true, skipped: 'resolver_invalid' };
  const SVP = engine();
  if (!SVP) return { ok: true, skipped: 'engine_unavailable' };

  // The claims being verified — what our system actually served.
  const status = clean(result.status).toUpperCase();
  if (['ELIGIBLE', 'MANUAL', 'INELIGIBLE'].indexOf(status) < 0) return { ok: true, skipped: 'no_status' };
  const noteRate = num(result.noteRate);

  const fico = Math.max(0, Math.round(num(input.fico)));
  if (!(fico > 0)) return { ok: true, skipped: 'no_fico' };   // provisional pricing (engine prices at FICO 700+ pending a score) — no workbook cell to hold it to

  // A deliberate admin exception (manual rate/leverage override, force-price)
  // is not a workbook scenario — the sheet would never price it. Watch-only
  // means we skip, not flag, these.
  if (num(input.ovrRate) > 0 || num(input.ovrLTC) > 0 || num(input.ovrAcqLTV) > 0 ||
      num(input.ovrARLTV) > 0 || input.forcePrice === true || input.manualPricing === true) {
    return { ok: true, skipped: 'admin_override' };
  }

  // Effective markup, resolved exactly as the quote resolved it.
  const m = (opts.markup !== undefined) ? opts.markup : resolveMarkup(input);
  const eff = effMarkupOf(m);

  // Replay the frozen engine on the same inputs for the RAW structure
  // (market / size band / unfloored sizing / effective caps). Deterministic —
  // this is the run the served quote came from.
  let ev = opts.evOverride || null;
  if (!ev) {
    try {
      if (m != null) SVP.setMarkup(m);
      ev = SVP.evaluate(input);
    } finally {
      try { SVP.setMarkup(null); } catch (_) { /* markup reset is best-effort */ }
    }
  }
  if (!ev || typeof ev !== 'object') return { ok: true, skipped: 'error' };

  // ---- independent structure derivation (fixture-side) ----
  const purp = clean(input.loanType) === 'Refinance' ? 'R' : 'P';
  const prodTok = myProdToken(input.strategy);
  const termTok = myTermToken(input.term);
  const sz = ev.sizing || {};
  const total = num(sz.totalLoan);
  const sizeBand = ev.sizeBand === 'L' ? 'L' : 'S';
  const market = ev.market === 'NYC' ? 'NYC' : 'STD';
  const stated = num(input.loanAmount);
  const gcOnly = input.gcOnlyExperience === true;
  const tier = myTier(sizeBand, myProjectCount(prodTok, input), gcOnly);

  const bad = (kind, detail, extra) => Object.assign({ ok: false, kind, detail }, extra || {});

  // Structural echoes: the matrix proved these identities over 204k scenarios,
  // so a live disagreement is genuine drift — surface it, never skip it.
  if (ev.product && ev.product !== prodTok) {
    return bad('eligibility_mismatch',
      `Our system classified this deal as product "${ev.product}" but the strategy "${clean(input.strategy)}" maps to "${prodTok}" in the pricing workbook — the deal may be priced on the wrong product grid.`);
  }
  if (ev.tier != null && num(ev.tier) !== tier) {
    return bad('eligibility_mismatch',
      `Our system priced this deal as Tier ${ev.tier}, but the workbook's experience thresholds put ${myProjectCount(prodTok, input)} comparable project(s) on a ${sizeBand === 'L' ? 'large' : 'small'}-band loan at Tier ${tier} — the deal may be priced on the wrong tier.`);
  }
  // Size-band sanity: a band that disagrees with the loan size prices the
  // wrong dollar-band grid.
  if (stated > 0) {
    const expBand = stated > SMALL_MAX ? 'L' : 'S';
    if (sizeBand !== expBand) {
      return bad('eligibility_mismatch',
        `A stated ${usd(stated)} loan belongs in the workbook's ${expBand === 'L' ? '$2.5M-$4.5M' : '$100k-$2.5M'} band, but it was priced in the ${sizeBand} band.`);
    }
  } else if ((sizeBand === 'L' && !(total > SMALL_MAX)) || (sizeBand === 'S' && total > SMALL_MAX + 1)) {
    return bad('eligibility_mismatch',
      `The sized loan ${usd(total)} does not belong in the workbook's ${sizeBand === 'L' ? '$2.5M-$4.5M' : '$100k-$2.5M'} band it was priced in.`);
  }

  // ---- tier-grid row gate: the workbook has no such program at all ----
  const row = tgRow(R, prodTok, purp, tier);
  if (!row) {
    if (status !== 'INELIGIBLE' || noteRate > 0 || total > 0) {
      return bad('eligibility_mismatch',
        `The pricing workbook has NO ${prodTok === 'GUC' ? 'ground-up' : prodTok === 'BR' ? 'bridge' : 'fix & flip / fix & hold'} ${purp === 'R' ? 'refinance' : 'purchase'} program for Tier ${tier} (the tier-grid row is empty), but our system returned ${status}${noteRate > 0 ? ` with a ${pctS(noteRate)} rate` : ''}. The workbook would refuse this deal.`,
        { cellKey: `${prodTok}|${purp}|T${tier}` });
    }
    return { ok: true, note: 'no_tier_row_and_refused' };
  }

  // Hard-gate refusals that never reached sizing (geography, property type,
  // value-add, DSCR, term gates, stated-loan bounds) are shared transcriptions
  // of the workbook's own rules, proven by the 204k matrix in CI. With no
  // sized structure there is no cell to compare against.
  if (status === 'INELIGIBLE') return { ok: true, note: 'refused_by_shared_gate' };

  // ---- ELIGIBLE contract vs the workbook floor ----
  if (status === 'ELIGIBLE') {
    if (!(total > 0)) {
      return bad('eligibility_mismatch', 'Our system returned ELIGIBLE without a sized loan — the workbook cannot price a $0 structure.');
    }
    if (!(noteRate > 0)) {
      return bad('eligibility_mismatch', 'Our system returned ELIGIBLE without a note rate — every eligible workbook cell carries a rate.');
    }
    if (total < MIN_LOAN - 1) {
      return bad('eligibility_mismatch', `Our system returned ELIGIBLE at ${usd(total)} — below the workbook's $100,000 minimum loan size.`);
    }
  }

  // ---- THE WORKBOOK TIE-OUT: rate cell (exact-decimal bands, matrix semantics) ----
  let edge = null;
  if (total > 0 && ev.caps) {
    const isBR = prodTok === 'BR';
    const aiv = Math.max(0, num(input.asIsValue));
    const arv = Math.max(0, num(input.arv));
    const arDenom = isBR ? (arv || aiv) : arv;
    const arRatio = arDenom > 0 ? total / arDenom : 0;
    const ltc = num(sz.ltcPct);
    const myKey = myKeyOf(R, market, sizeBand, prodTok, purp, termTok, tier, snap9(arRatio), fico, snap9(ltc));
    const fixRate = myKey != null ? R.rates[myKey] : undefined;
    const onEdge = nearBandEdge(R, snap9(ltc)) || nearBandEdge(R, snap9(arRatio));

    if (noteRate > 0) {
      const buy = noteRate - eff;
      const exact = myKey && fixRate != null && Math.abs(noteRate - (fixRate + eff)) < 1e-9;
      if (!exact) {
        // Knife-edge (frozen-engine artifact, matrix-verified): a real
        // same-family workbook rate, on a band edge, never BELOW the exact cell.
        const famKey = [market, sizeBand, prodTok, purp, termTok, 'T' + tier].join('|');
        const famSet = R.familyRates[famKey];
        const notLower = fixRate == null || buy > fixRate - 1e-9;
        if (famSet && famSet.has(Math.round(buy * 1e6)) && onEdge && notLower) {
          edge = 'rate_lagged';   // tolerated — conservative direction only
        } else if (fixRate != null) {
          const dir = buy < fixRate - 1e-9 ? 'LOWER than' : 'HIGHER than';
          return bad('rate_mismatch',
            `Our system quoted a ${pctS(noteRate)} note rate (${pctS(buy)} before the ${pctS(eff)} markup), which is ${dir} the workbook's rate for this exact cell: ${myKey} = ${pctS(fixRate)} (${pctS(fixRate + eff)} with the markup).`,
            { cellKey: myKey, engine: { noteRate, buyRate: buy, status }, workbook: { rate: fixRate, noteRate: fixRate + eff } });
        } else {
          return bad('eligibility_mismatch',
            `Our system priced this scenario at ${pctS(noteRate)}, but the workbook has NO priced cell for this profile (${myKey || 'the achieved leverage/FICO bands are outside every priced band'}) — the workbook would not buy this structure.`,
            { cellKey: myKey, engine: { noteRate, status } });
        }
      }
    } else {
      // Sized but UNPRICED (engine says "No priced grid cell" → manual review).
      if (myKey && fixRate != null) {
        // Mirror knife-edge: honest per the engine's own raw floats — the raw
        // band went one step up into an unpriced band while the exact-decimal
        // side prices. Manual review is the conservative direction — tolerated.
        const engKey = engKeyOf(SVP, market, sizeBand, prodTok, purp, termTok, tier, arRatio, fico, ltc);
        const engUnpriced = engKey.indexOf('-') > -1 || R.rates[engKey] == null;
        if (onEdge && engUnpriced && status === 'MANUAL') {
          edge = 'edge_manual';
        } else {
          return bad('eligibility_mismatch',
            `The workbook prices this exact scenario (cell ${myKey} = ${pctS(fixRate)}), but our system refused to price it (${status}${status === 'MANUAL' ? ' — routed to manual review with no rate' : ''}).`,
            { cellKey: myKey, engine: { status, noteRate: 0 }, workbook: { rate: fixRate } });
        }
      } else if (status === 'ELIGIBLE') {
        return bad('eligibility_mismatch', 'Our system returned ELIGIBLE with no priced workbook cell for the structure.');
      }
      // both sides agree: no priced cell → manual review is correct
    }
  } else if (noteRate > 0) {
    return bad('eligibility_mismatch', 'Our system returned a note rate without a sized loan structure — the workbook prices only sized structures.');
  }

  // ---- caps vs the workbook tier grid ----
  if (ev.caps) {
    const c = ev.caps;
    const gridCapped = (ev.reasons || []).some((r) => /Leverage is capped at /.test((r && r.msg) || ''));
    if (num(c.minFico) !== row.minfico) {
      return bad('cap_mismatch', `Our system used a ${c.minFico} minimum FICO for this tier; the workbook tier grid says ${row.minfico}.`, { cellKey: `${prodTok}|${purp}|T${tier}` });
    }
    if (num(c.maxAcqLTV) !== row.maxacq) {
      return bad('cap_mismatch', `Our system capped acquisition LTV at ${pctS(c.maxAcqLTV)}; the workbook tier grid says ${pctS(row.maxacq)}.`, { cellKey: `${prodTok}|${purp}|T${tier}` });
    }
    if (num(c.maxARLTV) !== row.maxar) {
      return bad('cap_mismatch', `Our system capped after-repair LTV at ${pctS(c.maxARLTV)}; the workbook tier grid says ${pctS(row.maxar)}.`, { cellKey: `${prodTok}|${purp}|T${tier}` });
    }
    const expLtc = Math.min(row.maxltc, num(input.targetLTC) > 0 ? num(input.targetLTC) : Infinity);
    if (!gridCapped) {
      if (Math.abs(num(c.maxLTC) - expLtc) > 1e-12) {
        return bad('cap_mismatch', `Our system capped loan-to-cost at ${pctS(c.maxLTC)}; the workbook says ${pctS(expLtc)} for this tier${num(input.targetLTC) > 0 ? ' (with the requested de-leverage)' : ''}.`, { cellKey: `${prodTok}|${purp}|T${tier}` });
      }
    } else if (!(num(c.maxLTC) < expLtc + 1e-12)) {
      return bad('cap_mismatch', `The grid step-down RAISED the loan-to-cost cap to ${pctS(c.maxLTC)} above the workbook's ${pctS(expLtc)} — a step-down may only lower it.`, { cellKey: `${prodTok}|${purp}|T${tier}` });
    }
    const okLoanA = num(c.maxLoan) === row.maxloan;
    const okLoanB = num(c.maxLoan) === Math.min(row.maxloan, SMALL_MAX) && sizeBand === 'S';
    if (!okLoanA && !okLoanB) {
      return bad('cap_mismatch', `Our system used a ${usd(c.maxLoan)} maximum loan for this tier; the workbook says ${usd(row.maxloan)}${sizeBand === 'S' ? ` (capped at ${usd(Math.min(row.maxloan, SMALL_MAX))} in the small band)` : ''}.`, { cellKey: `${prodTok}|${purp}|T${tier}` });
    }
    if (status === 'ELIGIBLE' && total > row.maxloan + 1) {
      return bad('cap_mismatch', `The sized ${usd(total)} loan exceeds the workbook's ${usd(row.maxloan)} tier maximum.`, { cellKey: `${prodTok}|${purp}|T${tier}` });
    }
  }

  return edge ? { ok: true, edge } : { ok: true };
}

/* =====================================================================
 * recordMismatch(appId, check, dbc) — best-effort advisory writer.
 * ONE ai_suggestions row per (file, kind) via the dedupe key: a repeat
 * mismatch refreshes the open row instead of duplicating; a row a human
 * already decided (dismissed/converted/noted) is never re-raised —
 * ai-suggestions.record() owns both rules (incl. the finding-decisions
 * ledger). SAVEPOINT-guarded when handed a transaction client so a failed
 * write can never poison the caller's transaction. NEVER throws.
 * ===================================================================== */
async function recordMismatch(appId, check, dbc) {
  try {
    if (!appId || !check || check.ok !== false || !check.kind) return { recorded: false };
    const aiSug = require('./underwriting/ai-suggestions');
    const kind = String(check.kind);
    const TITLES = {
      eligibility_mismatch: 'Silver pricing check: eligibility differs from the pricing workbook',
      rate_mismatch: 'Silver pricing check: the rate differs from the pricing workbook',
      cap_mismatch: 'Silver pricing check: leverage caps differ from the pricing workbook',
    };
    const payload = {
      applicationId: appId,
      source: 'silver_shadow_parity',
      kind: 'finding',
      severity: 'warning',          // advisory — never fatal, never an email storm
      important: true,
      title: TITLES[kind] || 'Silver pricing check: mismatch vs the pricing workbook',
      body: `${check.detail} ` +
        'This is an automatic background check of the live quote against the Silver program pricing sheet. ' +
        'It changed nothing and blocked nothing — please review the scenario manually and correct the quote or dismiss this note.',
      evidence: {
        code: `silver_shadow_${kind}`,
        cellKey: check.cellKey || null,
        engine: check.engine || null,
        workbook: check.workbook || null,
      },
      dedupeKey: `silver-shadow:${appId}:${kind}`,
    };
    // SAVEPOINT guard (no-op outside a transaction): a mid-transaction caller
    // must never have its transaction aborted by this best-effort write.
    let sp = false;
    if (dbc) { try { await dbc.query('SAVEPOINT silver_shadow'); sp = true; } catch (_) { /* not in a tx */ } }
    try {
      const r = await aiSug.record(dbc || null, payload);
      if (sp) await dbc.query('RELEASE SAVEPOINT silver_shadow').catch(() => {});
      return { recorded: true, id: r && r.id, deduped: !!(r && r.deduped), settled: !!(r && r.settled) };
    } catch (e) {
      if (sp) await dbc.query('ROLLBACK TO SAVEPOINT silver_shadow').catch(() => {});
      throw e;
    }
  } catch (_) {
    return { recorded: false, error: true };
  }
}

/* =====================================================================
 * monitorQuote(appId, input, result, opts) — the one call the routes make
 * (from a setImmediate, after the response is sent). Checks the kill
 * switch, runs the shadow check, records a mismatch. NEVER throws.
 * ===================================================================== */
async function monitorQuote(appId, input, result, opts) {
  try {
    if (!enabled()) return { ok: true, skipped: 'disabled' };
    const check = shadowCheck(input, result, opts);
    if (check && check.ok === false) {
      const record = await recordMismatch(appId, check, opts && opts.db);
      return Object.assign({}, check, { record });
    }
    return check;
  } catch (_) {
    return { ok: true, skipped: 'error' };
  }
}

module.exports = {
  enabled,
  shadowCheck,
  recordMismatch,
  monitorQuote,
  _internals: {
    resolver, loadFixture, engine,
    myArBand, myLtcBand, myFicoBand, myTier, myProdToken, myProjectCount,
    myTermToken, tgRow, myKeyOf, engKeyOf, nearBandEdge,
    resolveMarkup, effMarkupOf, snap6, snap9,
    MIN_LOAN, SMALL_MAX, DEFAULT_MARKUP, MARKUP_MAX,
  },
};
