'use strict';
/**
 * #216 — AI / OCR STACK health (configuration proof).
 *
 * A single, honest answer to "is every part of the underwriting AI actually
 * turned on, and which model/version is it running?" — every reasoning provider,
 * every OCR engine, the custom classifier + neural extractors, and the tracer.
 * This complements the broad integrations health-registry (which covers DocuSign /
 * ClickUp / SharePoint / etc.); this one is the AI MODEL layer specifically, with
 * the model version each component uses.
 *
 * SECURITY: reports ONLY booleans + model/deployment NAMES — NEVER a key or secret
 * value. NEVER THROWS: a bad probe degrades to inactive with a note.
 */
const cfg = require('../../config');

// Each component: how to tell if it's active + which model/version it runs. The
// probes call the client's own available()/configured() predicate (sync, no
// network) and read the model name from config with the same default the client
// uses. Lazy-require the clients so this module loads even if one is mid-refactor.
const COMPONENTS = Object.freeze([
  {
    key: 'azure_openai', name: 'Azure OpenAI (GPT-5)', group: 'reasoning',
    role: 'Primary reasoning + field extraction', provider: 'Microsoft Azure',
    probe: () => {
      const c = require('./azure-openai');
      return { active: c.available(), model: (cfg.azureOpenai && cfg.azureOpenai.deployment) || null };
    },
  },
  {
    key: 'anthropic', name: 'Anthropic Claude', group: 'reasoning',
    role: 'Independent second opinion for the review committee (#215)', provider: 'Anthropic',
    probe: () => {
      const c = require('./anthropic');
      return { active: c.available(), model: (cfg.anthropic && cfg.anthropic.model) || null };
    },
  },
  {
    key: 'azure_docint', name: 'Azure Document Intelligence', group: 'ocr',
    role: 'Primary OCR (page → text)', provider: 'Microsoft Azure',
    probe: () => {
      const c = require('./docint');
      return { active: c.configured(), model: (cfg.docint && cfg.docint.model) || 'prebuilt-read' };
    },
  },
  {
    key: 'google_docai', name: 'Google Document AI', group: 'ocr',
    role: 'Second OCR engine (auto-fallback)', provider: 'Google Cloud',
    probe: () => {
      const c = require('./docai-google');
      return { active: c.configured(), model: 'Enterprise Document OCR' };
    },
  },
  {
    key: 'mistral_ocr', name: 'Mistral OCR', group: 'ocr',
    role: 'Third OCR engine (auto-fallback)', provider: 'Mistral',
    probe: () => {
      const c = require('./docai-mistral');
      return { active: c.configured(), model: (cfg.mistralOcr && cfg.mistralOcr.model) || 'mistral-ocr-latest' };
    },
  },
  {
    key: 'azure_custom_classifier', name: 'Custom document classifier', group: 'classifier',
    role: 'Trained document-type classifier', provider: 'Azure Document Intelligence',
    probe: () => {
      const c = require('./azure-custom');
      return { active: c.classifierConfigured(), model: (cfg.azureCustom && cfg.azureCustom.classifierId) || null };
    },
  },
  {
    key: 'azure_custom_extractors', name: 'Neural field extractors', group: 'extractor',
    role: 'Trained per-doc-type field extractors', provider: 'Azure Document Intelligence',
    probe: () => {
      const c = require('./azure-custom');
      // DOC_TYPES is an OBJECT (key → canonical type, with aliases like photo_id →
      // drivers_license); enumerate the DISTINCT canonical types via deduped values.
      const types = c.DOC_TYPES && typeof c.DOC_TYPES === 'object'
        ? [...new Set(Object.values(c.DOC_TYPES))] : [];
      const configured = types.filter((t) => { try { return c.extractorConfigured(t); } catch (_e) { return false; } });
      return { active: configured.length > 0, model: configured.length ? `${configured.length} type(s): ${configured.join(', ')}` : null };
    },
  },
  {
    key: 'langfuse', name: 'Langfuse tracing', group: 'observability',
    role: 'Records every AI call for audit + debugging', provider: 'Langfuse',
    probe: () => {
      const c = require('./langfuse');
      return { active: c.enabled(), model: null };
    },
  },
]);

/**
 * report() → [{ key, name, group, role, provider, active, model, note }]  (NEVER THROWS)
 * `active` = is the component configured/on. `model` = the model/version NAME
 * (never a secret). A probe that errors is reported inactive with a note.
 */
function report() {
  return COMPONENTS.map((c) => {
    let active = false; let model = null; let note = null;
    try {
      const r = c.probe() || {};
      active = !!r.active;
      model = r.model != null ? String(r.model) : null;
    } catch (e) {
      active = false; note = `probe error: ${(e && e.message) || 'unknown'}`;
    }
    return { key: c.key, name: c.name, group: c.group, role: c.role, provider: c.provider, active, model, note };
  });
}

/**
 * summary(rep?) → { total, active, inactive, byGroup:{group:{total,active}},
 *   reasoningProviders, multiModel }  (NEVER THROWS)
 *   multiModel: ≥2 reasoning providers active → the committee is genuinely multi-model.
 */
function summary(rep) {
  try {
    const list = Array.isArray(rep) ? rep : report();
    const byGroup = {};
    let active = 0;
    for (const r of list) {
      const g = r.group || 'other';
      byGroup[g] = byGroup[g] || { total: 0, active: 0 };
      byGroup[g].total += 1;
      if (r.active) { byGroup[g].active += 1; active += 1; }
    }
    const reasoningProviders = list.filter((r) => r.group === 'reasoning' && r.active).length;
    return {
      total: list.length, active, inactive: list.length - active,
      byGroup, reasoningProviders, multiModel: reasoningProviders >= 2,
    };
  } catch (_e) {
    return { total: 0, active: 0, inactive: 0, byGroup: {}, reasoningProviders: 0, multiModel: false };
  }
}

module.exports = { COMPONENTS, report, summary };
