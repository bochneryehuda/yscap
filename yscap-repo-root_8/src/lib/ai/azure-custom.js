'use strict';
/**
 * Azure Document Intelligence — CUSTOM Classification + CUSTOM Neural Extraction.
 * Sibling of docint.js (OCR read); uses the SAME Azure resource / endpoint / key —
 * only the model id changes. Owner-directed 2026-07-22, closes the "combined-PDF"
 * package-splitting gap: borrowers upload one 50-page mixed PDF containing several
 * documents; the classifier returns per-page-range document-type labels + confidence,
 * and each split-out range then goes through the matching Custom Neural extractor to
 * pull structured fields (holder name, coverage $, LLC members, etc.) with confidences
 * and bounding boxes for the "highlighted section on the page" finding UI.
 *
 * Zero SDK deps — plain fetch, matching the rest of the AI plane.
 *
 * Env (in Render):
 *   AZURE_DOCINT_ENDPOINT     shared with docint.js
 *   AZURE_DOCINT_KEY          shared with docint.js
 *   AZURE_DOCINT_API_VERSION  default 2024-11-30 (v4.0 GA)
 *   AZURE_DOCINT_CLASSIFIER_ID              trained project name (e.g. 'pilot-doc-splitter')
 *   AZURE_DOCINT_EXTRACT_BANK_STATEMENT     per-type extractor project ids
 *   AZURE_DOCINT_EXTRACT_INSURANCE
 *   AZURE_DOCINT_EXTRACT_OPERATING_AGREEMENT
 *   AZURE_DOCINT_EXTRACT_DRIVERS_LICENSE
 *   AZURE_DOCINT_EXTRACT_SETTLEMENT
 *   AZURE_DOCINT_EXTRACT_PURCHASE_CONTRACT
 *
 * Everything is best-effort — a missing model id / unconfigured resource returns
 * { ok:false, reason } and NEVER throws. Runs behind the same resilience breaker as
 * docint.js.
 */
const cfg = require('../../config');
const { runWithRetry, classifyStatus, retryAfterMs, breakerFor } = require('./resilience');
const langfuse = require('./langfuse');

const MAX_BYTES = 50 * 1024 * 1024;
const POLL_MS = 1500;
const MAX_POLL_MS = 120000;   // custom-neural extraction takes longer than OCR
const SUBMIT_DEADLINE_MS = 60000;

// Canonical PILOT document type keys — the classifier's trained labels MUST match one of
// these exactly (case-insensitive), so downstream code always speaks the same vocabulary.
const DOC_TYPES = {
  bank_statement:      'bank_statement',
  insurance:           'insurance',
  operating_agreement: 'operating_agreement',
  drivers_license:     'drivers_license',
  settlement:          'settlement',
  purchase_contract:   'purchase_contract',
  photo_id:            'drivers_license',    // legacy alias
  hoi:                 'insurance',           // homeowner's insurance dec page alias
};

function normalizeType(label) {
  if (!label) return null;
  const k = String(label).trim().toLowerCase().replace(/[ -]+/g, '_');
  return DOC_TYPES[k] || null;
}

function baseConfigured() {
  return !!(cfg.docint && cfg.docint.endpoint && cfg.docint.key);
}

function classifierConfigured() {
  return baseConfigured() && !!(cfg.azureCustom && cfg.azureCustom.classifierId);
}

function extractorFor(docType) {
  if (!baseConfigured() || !cfg.azureCustom) return null;
  switch (normalizeType(docType)) {
    case 'bank_statement':      return cfg.azureCustom.extractorBankStatement || null;
    case 'insurance':           return cfg.azureCustom.extractorInsurance || null;
    case 'operating_agreement': return cfg.azureCustom.extractorOperatingAgmt || null;
    case 'drivers_license':     return cfg.azureCustom.extractorDriversLicense || null;
    case 'settlement':          return cfg.azureCustom.extractorSettlement || null;
    case 'purchase_contract':   return cfg.azureCustom.extractorPurchaseContract || null;
    default: return null;
  }
}

function extractorConfigured(docType) { return !!extractorFor(docType); }

function analyzeUrl(modelId) {
  const base = String(cfg.docint.endpoint || '').replace(/\/+$/, '');
  const ver = (cfg.docint.apiVersion || '2024-11-30');
  return `${base}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze?_overload=analyzeDocument&api-version=${ver}`;
}

async function attemptSubmit(url, b64) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': cfg.docint.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Source: b64 }),
      signal: ac.signal,
    });
  } finally { clearTimeout(timer); }
  if (r.status === 202) {
    const operationUrl = r.headers.get('operation-location');
    if (!operationUrl) return { ok: false, reason: 'no result location', retryable: false, breakerFault: false, outcome: 'bad_request' };
    return { ok: true, operationUrl };
  }
  const j = await r.json().catch(() => ({}));
  const cls = classifyStatus(r.status);
  return { ok: false,
    reason: `custom model rejected (HTTP ${r.status}${j.error && j.error.message ? ': ' + j.error.message : ''})`,
    retryable: cls.retryable, breakerFault: cls.breakerFault,
    outcome: cls.outcome, retryAfterMs: retryAfterMs(r.headers), status: r.status };
}

async function pollResult(operationUrl, deadline) {
  let nextWait = POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(nextWait, Math.max(0, deadline - Date.now()))));
    nextWait = POLL_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    let r;
    try {
      r = await fetch(operationUrl, { headers: { 'Ocp-Apim-Subscription-Key': cfg.docint.key }, signal: ac.signal });
    } catch (_) { clearTimeout(timer); continue; } finally { clearTimeout(timer); }
    if (r.status === 429 || r.status >= 500) {
      const ra = retryAfterMs(r.headers); if (ra != null) nextWait = Math.max(POLL_MS, ra);
      continue;
    }
    if (!r.ok) return { ok: false, reason: `poll failed HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    const status = (j.status || '').toLowerCase();
    if (status === 'succeeded') return { ok: true, result: j.analyzeResult || {} };
    if (status === 'failed') {
      const msg = (j.error && j.error.message) || 'custom model failed to analyze';
      return { ok: false, reason: msg };
    }
  }
  return { ok: false, reason: 'custom model timed out' };
}

// ---- Public: classify a (possibly combined) document into per-page-range types ----

/**
 * Split a package via the classifier. Returns per-detected-type page ranges + confidence.
 * @param {{buffer?:Buffer, base64?:string, appId?:string, documentId?:string, trace?:object}} args
 * @returns {Promise<{ok:boolean, reason?:string, segments?:Array<{docType:string,rawLabel:string,confidence:number,pages:Array<number>}>, raw?:object}>}
 */
async function classify({ buffer, base64, appId, documentId, trace } = {}) {
  if (!classifierConfigured()) return { ok: false, reason: 'the package splitter is not trained yet (train the pilot-doc-splitter classifier in Azure Document Intelligence Studio)' };
  const b64 = base64 || (buffer ? buffer.toString('base64') : null);
  if (!b64) return { ok: false, reason: 'no document bytes were provided' };
  const size = buffer ? buffer.length : Math.floor((b64.length * 3) / 4);
  if (size > MAX_BYTES) return { ok: false, reason: 'document is too large for the splitter' };

  const t = trace || langfuse.trace({
    name: 'azure-custom:classify', appId, documentId, tags: ['azure-custom', 'classify'],
  });
  const g = t.generation({
    name: 'classify', model: `azure-docint:${cfg.azureCustom.classifierId}`,
    input: { sizeBytes: size, classifierId: cfg.azureCustom.classifierId },
  });

  const submit = await runWithRetry(() => attemptSubmit(analyzeUrl(cfg.azureCustom.classifierId), b64), {
    breaker: breakerFor('azure-docint-custom'), deadlineMs: SUBMIT_DEADLINE_MS, label: 'the splitter',
  });
  if (!submit.ok) { g.end({ level: 'ERROR', statusMessage: submit.reason }); return { ok: false, reason: submit.reason }; }
  const poll = await pollResult(submit.operationUrl, Date.now() + MAX_POLL_MS);
  if (!poll.ok) { g.end({ level: 'ERROR', statusMessage: poll.reason }); return { ok: false, reason: poll.reason }; }

  // Custom classification result: analyzeResult.documents[] each with docType, confidence,
  // boundingRegions: [{ pageNumber }]. Group by normalized doc type.
  const docs = Array.isArray(poll.result.documents) ? poll.result.documents : [];
  const segments = docs.map(d => {
    const rawLabel = d && d.docType || null;
    const docType = normalizeType(rawLabel);
    const confidence = Number.isFinite(d && d.confidence) ? d.confidence : 0;
    const pages = Array.isArray(d && d.boundingRegions)
      ? Array.from(new Set(d.boundingRegions.map(r => r && r.pageNumber).filter(Number.isFinite))).sort((a, b) => a - b)
      : [];
    return { docType, rawLabel, confidence, pages };
  }).filter(s => s.pages.length > 0);

  g.end({ output: { segmentCount: segments.length, types: segments.map(s => s.docType || s.rawLabel) }, confidence: segments.reduce((a, s) => a + s.confidence, 0) / (segments.length || 1) });
  if (!trace) t.end({ output: { segmentCount: segments.length } });
  return { ok: true, segments, raw: poll.result };
}

// ---- Public: extract structured fields per document type via Custom Neural ----

/**
 * Extract fields from a document (or a page range within a package) using the per-type
 * custom neural extractor.
 * @param {{docType:string, buffer?:Buffer, base64?:string, pages?:string, appId?:string, documentId?:string, trace?:object}} args
 *   pages: an optional Azure "pages" param like '1-3' scoping the extraction inside a bigger PDF.
 * @returns {Promise<{ok:boolean, reason?:string, fields?:Record<string,{value:*,confidence:number,boundingRegions?:Array}>, raw?:object}>}
 */
async function extract({ docType, buffer, base64, pages, appId, documentId, trace } = {}) {
  const modelId = extractorFor(docType);
  if (!modelId) return { ok: false, reason: `no custom extractor trained for ${docType}` };
  const b64 = base64 || (buffer ? buffer.toString('base64') : null);
  if (!b64) return { ok: false, reason: 'no document bytes were provided' };
  const size = buffer ? buffer.length : Math.floor((b64.length * 3) / 4);
  if (size > MAX_BYTES) return { ok: false, reason: 'document is too large for the extractor' };

  const t = trace || langfuse.trace({
    name: `azure-custom:extract:${docType}`, appId, documentId, tags: ['azure-custom', 'extract', docType],
  });
  const g = t.generation({
    name: `extract:${docType}`, model: `azure-docint:${modelId}`,
    input: { docType, sizeBytes: size, pages: pages || null },
  });

  let url = analyzeUrl(modelId);
  if (pages) url += `&pages=${encodeURIComponent(pages)}`;
  const submit = await runWithRetry(() => attemptSubmit(url, b64), {
    breaker: breakerFor('azure-docint-custom'), deadlineMs: SUBMIT_DEADLINE_MS, label: 'the extractor',
  });
  if (!submit.ok) { g.end({ level: 'ERROR', statusMessage: submit.reason }); return { ok: false, reason: submit.reason }; }
  const poll = await pollResult(submit.operationUrl, Date.now() + MAX_POLL_MS);
  if (!poll.ok) { g.end({ level: 'ERROR', statusMessage: poll.reason }); return { ok: false, reason: poll.reason }; }

  // Custom neural result: analyzeResult.documents[0].fields is a map of { name → { valueString|
  // valueDate|valueNumber|content, confidence, boundingRegions }}. Flatten to a stable shape.
  const doc = Array.isArray(poll.result.documents) && poll.result.documents[0];
  const rawFields = (doc && doc.fields) || {};
  const fields = {};
  for (const [name, f] of Object.entries(rawFields)) {
    if (!f || typeof f !== 'object') continue;
    fields[name] = {
      value: f.valueString ?? f.valueDate ?? f.valueTime ?? f.valueNumber ?? f.valueInteger ?? f.valueSelectionMark ?? f.valueSignature ?? f.content ?? null,
      type: f.type || null,
      confidence: Number.isFinite(f.confidence) ? f.confidence : null,
      boundingRegions: Array.isArray(f.boundingRegions) ? f.boundingRegions : null,
      spans: Array.isArray(f.spans) ? f.spans : null,
    };
  }

  const meanConf = Object.values(fields).map(f => f.confidence).filter(Number.isFinite);
  const avg = meanConf.length ? meanConf.reduce((a, b) => a + b, 0) / meanConf.length : null;
  g.end({ output: { fieldCount: Object.keys(fields).length, docConfidence: doc && doc.confidence }, confidence: avg });
  if (!trace) t.end({ output: { fieldCount: Object.keys(fields).length } });
  return { ok: true, docType: normalizeType(docType), fields, docConfidence: doc && doc.confidence, raw: poll.result };
}

async function ping() {
  if (!classifierConfigured()) return { ok: false, reason: 'no classifier id set' };
  const base = String(cfg.docint.endpoint || '').replace(/\/+$/, '');
  const ver = cfg.docint.apiVersion || '2024-11-30';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(`${base}/documentintelligence/documentModels/${encodeURIComponent(cfg.azureCustom.classifierId)}?api-version=${ver}`, {
      headers: { 'Ocp-Apim-Subscription-Key': cfg.docint.key }, signal: ac.signal,
    });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: `bad key (HTTP ${r.status})` };
    if (r.status === 404) return { ok: false, reason: 'classifier not found — has it been trained + published?' };
    return { ok: false, reason: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}

module.exports = {
  DOC_TYPES, normalizeType, classifierConfigured, extractorConfigured, extractorFor,
  classify, extract, ping, _internals: { analyzeUrl, attemptSubmit, pollResult },
};
