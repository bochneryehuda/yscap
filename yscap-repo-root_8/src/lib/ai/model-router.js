'use strict';
/**
 * P1 — AI MODEL-selection matrix (deterministic core, ADVISORY).
 *
 * The document-side of routing lives in routing-matrix.js (which OCR engine).
 * This is the MODEL side: given an underwriting TASK it decides which AI
 * provider + model should do it, and whether a high-risk task needs a mandatory
 * SECOND OPINION from an INDEPENDENT provider (so a fatal call isn't trusted to
 * one model's blind spots). The owner's gap: "the system knows which specialist
 * PROMPT should review an issue, but not which AI PROVIDER/MODEL is best for
 * each task," and "five committee specialists may share the same underlying
 * model weaknesses."
 *
 * It selects on: task type (numeric reconciliation vs narrative reasoning vs
 * visual reading vs classification vs adjudication), risk level, content
 * modality (text vs image), document family, provider availability, and prior
 * provider performance on the task.
 *
 * TODAY only Azure OpenAI is configured, so it is the primary for every task;
 * the matrix already NAMES the independent challenger (Anthropic Claude / Google
 * Gemini) each high-risk task should get, and marks it `available:false` until a
 * key exists — so the committee gains real provider independence the moment a
 * second provider is wired, with no logic change here. Pure + advisory: it
 * returns a plan, calls no model, changes no decision.
 */

// -------------------------------------------------------------------------
// PROVIDERS — the model providers the platform can route to, with the task
// strengths each is preferred for. `azure_openai` is the only one configured
// today; the others are declared so the matrix can NAME an independent
// challenger now and light it up when a key arrives.
// -------------------------------------------------------------------------
const PROVIDERS = Object.freeze({
  azure_openai: { label: 'Azure OpenAI (GPT-5)', strengths: ['numeric', 'narrative', 'classification', 'vision', 'adjudication'], envKeys: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_DEPLOYMENT'] },
  anthropic:    { label: 'Anthropic Claude',      strengths: ['narrative', 'adjudication', 'numeric', 'classification'],        envKeys: ['ANTHROPIC_API_KEY'] },
  google_gemini:{ label: 'Google Gemini',         strengths: ['vision', 'numeric', 'classification'],                          envKeys: ['GEMINI_API_KEY'] },
});

// A default, provider-agnostic PRIORITY per task type — the order we'd PREFER
// providers in when more than one is available. The independent challenger for
// a high-risk task is the first AVAILABLE provider from a DIFFERENT vendor than
// the primary.
const TASK_PROFILES = Object.freeze({
  // Reconcile numbers between two reads / documents (bank balances, HUD figures).
  numeric_reconciliation: { priority: ['azure_openai', 'anthropic', 'google_gemini'], reasoning: 'high',   secondOpinionAtRisk: ['high', 'fatal'] },
  // Narrative / legal reasoning (operating agreement authority, contract precedence).
  narrative_reasoning:    { priority: ['anthropic', 'azure_openai', 'google_gemini'], reasoning: 'high',   secondOpinionAtRisk: ['fatal'] },
  // Visual reading (IDs, signatures, stamps, photos) — a vision-strong model.
  visual:                 { priority: ['google_gemini', 'azure_openai', 'anthropic'], reasoning: 'medium', secondOpinionAtRisk: ['fatal'] },
  // Field extraction to a schema — cheap + fast is fine.
  extraction:             { priority: ['azure_openai', 'google_gemini', 'anthropic'], reasoning: 'low',    secondOpinionAtRisk: [] },
  // Classify a document / packet page.
  classification:         { priority: ['azure_openai', 'google_gemini', 'anthropic'], reasoning: 'low',    secondOpinionAtRisk: [] },
  // Adjudicate a finding / committee verdict — worth a diverse second brain.
  adjudication:           { priority: ['anthropic', 'azure_openai', 'google_gemini'], reasoning: 'high',   secondOpinionAtRisk: ['high', 'fatal'] },
});
const DEFAULT_TASK = 'extraction';

// Which providers are configured right now. availability overrides via
// features.availability (a map of provider→bool); otherwise we read env.
function availableProviders(features) {
  const override = features && features.availability;
  const out = {};
  for (const p of Object.keys(PROVIDERS)) {
    if (override && Object.prototype.hasOwnProperty.call(override, p)) { out[p] = !!override[p]; continue; }
    // env-based: every declared key present + truthy.
    out[p] = PROVIDERS[p].envKeys.every((k) => !!process.env[k]);
  }
  return out;
}

// Rank the task's priority list, keeping only available providers, and
// factoring prior performance (a provider that's been failing this task is
// deprioritized but not removed).
function rankProviders(priority, available, performance, task) {
  const perf = (performance && performance[task]) || {};
  return priority
    .filter((p) => available[p])
    .map((p, i) => ({ p, i, good: perf[p] !== false }))
    .sort((a, b) => (a.good === b.good ? a.i - b.i : (a.good ? -1 : 1)))
    .map((x) => x.p);
}

/**
 * planModel(task) → the model plan for ONE task.
 * @param {{
 *   taskType?: string,        // key of TASK_PROFILES
 *   riskLevel?: string,       // 'low' | 'medium' | 'high' | 'fatal'
 *   modality?: string,        // 'text' | 'image' — nudges toward a vision-strong provider
 *   docFamily?: string,       // the document family (informational; carried through)
 *   availability?: object,    // provider→bool override (else env)
 *   providerPerformance?: object, // { [taskType]: { [provider]: boolean } }
 * }} task
 * @returns {{
 *   task: string, riskLevel: string,
 *   primary: { provider: string, label: string, available: boolean } | null,
 *   challenger: { provider: string, label: string, available: boolean } | null,
 *   secondOpinionRequired: boolean,
 *   reasoning: string,        // suggested reasoning effort
 *   providerOrder: string[],  // full ranked order of AVAILABLE providers
 *   notes: string[],
 * }}
 */
function planModel(task = {}) {
  const taskType = TASK_PROFILES[task.taskType] ? task.taskType : DEFAULT_TASK;
  const prof = TASK_PROFILES[taskType];
  const risk = String(task.riskLevel || 'medium').toLowerCase();
  const notes = [];

  // Image tasks bias toward a vision-strong provider regardless of the task's
  // default priority (a signature/photo read is a vision problem).
  let priority = prof.priority.slice();
  if (String(task.modality || '').toLowerCase() === 'image') {
    priority = ['google_gemini', 'azure_openai', 'anthropic'].filter((p, i, a) => a.indexOf(p) === i);
    notes.push('image content — biased toward a vision-strong provider');
  }

  const available = availableProviders(task);
  const ranked = rankProviders(priority, available, task.providerPerformance, taskType);

  // Primary = the top available provider. If NONE is available (misconfig),
  // still name the intended primary (available:false) so the caller knows.
  const primaryProvider = ranked[0] || priority[0];
  const primary = primaryProvider
    ? { provider: primaryProvider, label: PROVIDERS[primaryProvider].label, available: !!available[primaryProvider] }
    : null;

  // A high-risk task wants a SECOND OPINION from an INDEPENDENT vendor (a
  // different provider than the primary). Find the first ranked provider from a
  // different vendor; if none is available, name the intended one (available:false)
  // so a human knows the independent check is not yet possible.
  const secondOpinionRequired = prof.secondOpinionAtRisk.includes(risk);
  let challenger = null;
  if (secondOpinionRequired && primaryProvider) {
    const other = ranked.find((p) => p !== primaryProvider)
      || priority.find((p) => p !== primaryProvider);
    if (other) challenger = { provider: other, label: PROVIDERS[other].label, available: !!available[other] };
    if (challenger && !challenger.available) {
      notes.push(`a high-risk ${taskType} wants an independent second opinion from ${challenger.label}, but it is not configured yet — a single-provider result should be human-verified until a second provider is wired`);
    } else if (challenger) {
      notes.push(`high-risk ${taskType} — an independent second opinion from ${challenger.label} is run and reconciled`);
    }
  }

  return {
    task: taskType,
    riskLevel: risk,
    primary,
    challenger,
    secondOpinionRequired,
    reasoning: prof.reasoning,
    providerOrder: ranked,
    docFamily: task.docFamily || null,
    notes,
  };
}

module.exports = { planModel, PROVIDERS, TASK_PROFILES, _internals: { availableProviders, rankProviders } };
