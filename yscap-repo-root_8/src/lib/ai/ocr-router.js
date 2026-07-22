'use strict';
/**
 * OCR router — pick the best available OCR engine for a document, with automatic
 * fallback (owner-directed 2026-07-21). The router keeps the return shape
 * identical to a single-engine `read()` call — { ok, text, pageCount, pages,
 * engine, engineSequence } — so every existing caller (underwriting engine,
 * classifier, second-look) can consume the result as if there were still one
 * OCR provider.
 *
 * Strategy (kept intentionally simple — the "mesh" ambition grows later):
 *   1. PRIMARY = Azure Document Intelligence (prebuilt-layout). It's proven on
 *      this corpus and returns page-level metadata.
 *   2. If Azure returns ok:false OR the text it returned is suspiciously short
 *      for a multi-page document (a scanned PDF where Azure's OCR silently
 *      produced no readable content), try Google Document AI as the CHALLENGER.
 *   3. If Google is unavailable or also fails, return the primary's result
 *      (with its error) unchanged.
 *
 * `engineSequence` records every engine that was actually TRIED (in order) so a
 * caller can log "read by Azure, rescued by Google" for the finding evidence
 * trail. `engine` names the WINNER (the engine whose result is being returned).
 *
 * Pure orchestration — no HTTP of its own. Delegates to the two per-engine
 * modules. Never throws; never blocks.
 */
const azure = require('./docint');
const google = require('./docai-google');
const mistral = require('./docai-mistral');
const matrix = require('./routing-matrix');

// Map a routing-matrix engine name → the per-engine module + the winner label
// the router reports. 'native_pdf' / 'appraisal_xml' are UPSTREAM deterministic
// sources (unpdf native text / a MISMO parser) the router itself doesn't read —
// when the plan names one, the router still runs the plan's OCR challenger as a
// cross-check and reports the special handling so the caller prefers the source.
const ENGINE_MODULE = { azure, google, mistral };
const ENGINE_LABEL = { azure: 'azure-docint', google: 'google-docai', mistral: 'mistral-ocr' };

// A rescue is worth trying when the primary returned NO text at all, or so
// little text that we suspect its OCR failed to segment the page (a scanned
// PDF where Azure returned only the file's title metadata). Threshold is
// deliberately conservative — a real one-line receipt reads under this and
// should NOT trigger a rescue, but a 5-page scanned document that came back
// with 20 characters clearly did fail. `bytesHint` (if the caller passed the
// buffer size) helps calibrate: any document over ~100 KB that reads as
// under 100 chars is almost certainly a bad OCR pass.
function primaryLooksEmpty(result, bytesHint) {
  if (!result || !result.ok) return true;
  const text = String(result.text || '');
  if (!text.trim()) return true;
  const chars = text.trim().length;
  // Trivially-short text is always suspicious (a real document reads more than a
  // dozen characters).
  if (chars < 10) return true;
  // A meaningfully-large document (>= 250 KB — most single-page scans are under
  // 200 KB, so this deliberately excludes small receipts) that produced under
  // 100 characters almost certainly failed OCR (Azure returned the file's title
  // metadata or a blank page). Rescue.
  if (bytesHint != null && bytesHint >= 250 * 1024 && chars < 100) return true;
  return false;
}

/**
 * Read a document with the best available engine, falling back on failure.
 * @param {{ buffer?: Buffer, base64?: string, mimeType?: string, forceEngine?: string }} args
 *   forceEngine: 'azure' | 'google' — skip the router, use exactly this engine
 * @returns {Promise<{ok, text?, pageCount?, pages?, reason?, engine, engineSequence:string[]}>}
 */
async function read(args = {}) {
  const sequence = [];
  const bytesHint = args.buffer ? args.buffer.length : (args.base64 ? Math.floor((args.base64.length * 3) / 4) : null);

  // Document-aware routing (P1) — OPT-IN and backward-compatible: only when a
  // caller passes a document family (docType) or explicit routeFeatures. No
  // existing caller passes those, so the default fallback chain below is
  // byte-identical to before. forceEngine still wins outright.
  if (!args.forceEngine && (args.docType || args.routeFeatures)) {
    return readRouted(args, bytesHint);
  }

  if (args.forceEngine === 'google') {
    sequence.push('google');
    const r = await google.read(args);
    return { ...r, engine: 'google-docai', engineSequence: sequence };
  }
  if (args.forceEngine === 'azure') {
    sequence.push('azure');
    const r = await azure.read(args);
    return { ...r, engine: 'azure-docint', engineSequence: sequence };
  }
  if (args.forceEngine === 'mistral') {
    sequence.push('mistral');
    const r = await mistral.read(args);
    return { ...r, engine: 'mistral-ocr', engineSequence: sequence };
  }

  // Default: Azure primary, Google fallback.
  sequence.push('azure');
  const primary = await azure.read(args);
  if (!primaryLooksEmpty(primary, bytesHint)) {
    return { ...primary, engine: 'azure-docint', engineSequence: sequence };
  }
  // Primary is empty / failed — try Google if it's configured.
  if (!google.configured()) {
    // No challenger available — return the primary's result (which the caller
    // will already handle as an error / empty read).
    return { ...primary, engine: 'azure-docint', engineSequence: sequence, primaryReason: primary.reason };
  }
  sequence.push('google');
  const rescued = await google.read(args);
  // Return the rescue whenever Google produced ANY real text — the primary already
  // failed, so ANY text is better than nothing. We deliberately do NOT apply the
  // "primaryLooksEmpty" heuristic to the rescue (a low-content but valid read —
  // e.g. a check with just a signature line — is still a win over an empty read).
  if (rescued.ok && String(rescued.text || '').trim().length > 0) {
    return {
      ...rescued,
      engine: 'google-docai',
      engineSequence: sequence,
      rescuedFrom: 'azure-docint',
      primaryReason: primary.reason || 'primary engine returned an empty read',
    };
  }
  // Google also failed — try Mistral as the THIRD independent engine
  // (owner-directed 2026-07-21). Different failure modes than either Azure
  // or Google, so it's a genuine third perspective for hard documents
  // (dense tables, signatures, multi-column layouts).
  if (!mistral.configured()) {
    return {
      ...primary,
      engine: 'azure-docint',
      engineSequence: sequence,
      primaryReason: primary.reason,
      challengerReason: rescued.reason || null,
    };
  }
  sequence.push('mistral');
  const thirdRescue = await mistral.read(args);
  if (thirdRescue.ok && String(thirdRescue.text || '').trim().length > 0) {
    return {
      ...thirdRescue,
      engine: 'mistral-ocr',
      engineSequence: sequence,
      rescuedFrom: 'azure-docint',
      primaryReason: primary.reason || 'primary engine returned an empty read',
      challengerReason: rescued.reason || 'challenger returned an empty read',
    };
  }
  // Every engine failed / empty — return the primary's error with all reasons noted.
  return {
    ...primary,
    engine: 'azure-docint',
    engineSequence: sequence,
    primaryReason: primary.reason,
    challengerReason: rescued.reason || null,
    thirdReason: thirdRescue.reason || null,
  };
}

// Read with exactly one named OCR engine. Returns the engine's result with the
// router's winner label attached. Unknown / unavailable engine → a clean failure.
async function engineRead(engine, args) {
  const mod = ENGINE_MODULE[engine];
  if (!mod) return { ok: false, reason: `unknown engine ${engine}` };
  if (!mod.configured()) return { ok: false, reason: `${engine} not configured` };
  const r = await mod.read(args);
  return { ...r, engine: ENGINE_LABEL[engine] };
}

/**
 * Document-aware read (P1). Consults the routing matrix for a PLAN, reads with
 * the plan's OCR primary (falling back through the plan's fallbacks on an empty
 * read, exactly as the flat chain does), and — for a numeric-critical document
 * — ALSO runs the mandatory challenger and reconciles the material numbers. The
 * plan + any numeric disagreement ride back on the result as `routePlan` /
 * `reconciliation`; the winning text is still the single authoritative `text`,
 * so every existing consumer reads it unchanged. Advisory: it never blocks — a
 * disagreement is surfaced for a human, never auto-acted.
 */
async function readRouted(args, bytesHint) {
  const sequence = [];
  const features = args.routeFeatures || {
    docType: args.docType,
    mimeType: args.mimeType,
    bytes: bytesHint,
    availability: { azure: azure.configured(), google: google.configured(), mistral: mistral.configured() },
  };
  if (features.availability == null) {
    features.availability = { azure: azure.configured(), google: google.configured(), mistral: mistral.configured() };
  }
  const plan = matrix.planRoute(features);

  // The plan's primary may be an upstream deterministic source (native_pdf /
  // appraisal_xml) the router doesn't read — in that case the OCR job is the
  // plan's challenger (the cross-check engine). Build the ordered list of OCR
  // engines to actually try: [ocrPrimary, ...fallbacks], de-duplicated.
  const isOcr = (e) => e === 'azure' || e === 'google' || e === 'mistral';
  const ocrPrimary = isOcr(plan.primary) ? plan.primary : (plan.challenger && isOcr(plan.challenger) ? plan.challenger : (plan.fallbacks || [])[0]);
  const tryOrder = [];
  for (const e of [ocrPrimary, ...(plan.fallbacks || []), plan.challenger].filter(Boolean)) {
    if (isOcr(e) && !tryOrder.includes(e)) tryOrder.push(e);
  }
  if (!tryOrder.length) tryOrder.push('azure');

  // Read through the ordered engines until one produces a usable read.
  let winner = null;
  for (const engine of tryOrder) {
    sequence.push(engine);
    const r = await engineRead(engine, args);
    if (r.ok && !primaryLooksEmpty(r, bytesHint)) { winner = r; break; }
    if (!winner && r.ok && String(r.text || '').trim()) winner = r; // keep the best non-empty as a floor
  }
  if (!winner) {
    // Nothing usable — return the first engine's failure with the plan attached.
    const first = await engineRead(tryOrder[0], args);
    return { ...first, engine: ENGINE_LABEL[tryOrder[0]] || 'azure-docint', engineSequence: sequence, routePlan: plan };
  }

  const result = { ...winner, engineSequence: sequence, routePlan: plan };

  // Weak-page identification — which pages read below the plan's confidence floor
  // and are worth a targeted re-read by the challenger. Attached advisorily; the
  // full re-OCR-and-splice of just these pages is a follow-up. Only meaningful
  // when the engine surfaced per-page confidence (Azure prebuilt-layout does).
  if (plan.reread && plan.reread.enabled && Array.isArray(winner.pages)) {
    const weak = matrix.weakPages(winner.pages, plan.reread.confidenceFloor);
    if (weak.length) result.weakPages = weak;
  }

  // Mandatory challenger for numeric-critical documents — a SECOND independent
  // read whose material numbers are reconciled against the winner's. Pick a
  // usable engine that is NOT the winner and has not already been read.
  if (plan.numericCritical && plan.specialHandling.includes('mandatory_challenger')) {
    const winnerEngine = Object.keys(ENGINE_LABEL).find((k) => ENGINE_LABEL[k] === winner.engine);
    const preferred = (plan.challenger && isOcr(plan.challenger) && plan.challenger !== winnerEngine) ? plan.challenger : null;
    const challenger = preferred || tryOrder.find((e) => e !== winnerEngine && !sequence.includes(e))
      || (plan.fallbacks || []).find((e) => isOcr(e) && e !== winnerEngine);
    if (challenger && challenger !== winnerEngine && !sequence.includes(challenger)) {
      sequence.push(challenger);
      const chRes = await engineRead(challenger, args);
      if (chRes && chRes.ok && String(chRes.text || '').trim()) {
        result.reconciliation = {
          ...matrix.reconcileNumbers(winner.text, chRes.text),
          winner: winner.engine,
          challenger: ENGINE_LABEL[challenger],
        };
      }
    }
  }
  return result;
}

/** True when ANY engine is configured (at least one usable). */
function configured() { return azure.configured() || google.configured() || mistral.configured(); }

/** Health probe — returns which engines are ready. */
async function ping() {
  const [a, g, m] = await Promise.all([
    azure.configured() ? azure.ping() : Promise.resolve({ ok: false, reason: 'not configured' }),
    google.configured() ? google.ping() : Promise.resolve({ ok: false, reason: 'not configured' }),
    mistral.configured() ? mistral.ping() : Promise.resolve({ ok: false, reason: 'not configured' }),
  ]);
  return { ok: a.ok || g.ok || m.ok, azure: a, google: g, mistral: m };
}

module.exports = { read, readRouted, planRoute: matrix.planRoute, weakPages: matrix.weakPages, ping, configured, _internals: { primaryLooksEmpty, engineRead } };
