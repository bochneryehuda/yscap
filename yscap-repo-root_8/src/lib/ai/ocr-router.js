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
  // Both empty / failed — return the primary result (which is what existing
  // code paths already know how to handle) with both reasons noted.
  return {
    ...primary,
    engine: 'azure-docint',
    engineSequence: sequence,
    primaryReason: primary.reason,
    challengerReason: rescued.reason || null,
  };
}

/** True when ANY engine is configured (at least one usable). */
function configured() { return azure.configured() || google.configured(); }

/** Health probe — returns which engines are ready. */
async function ping() {
  const [a, g] = await Promise.all([
    azure.configured() ? azure.ping() : Promise.resolve({ ok: false, reason: 'not configured' }),
    google.configured() ? google.ping() : Promise.resolve({ ok: false, reason: 'not configured' }),
  ]);
  return { ok: a.ok || g.ok, azure: a, google: g };
}

module.exports = { read, ping, configured, _internals: { primaryLooksEmpty } };
