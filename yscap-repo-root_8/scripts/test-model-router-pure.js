'use strict';
/**
 * P1 — pure tests for the AI model-selection matrix. Proves the matrix picks a
 * provider per task, names an INDEPENDENT second-opinion provider for high-risk
 * tasks (and flags when that provider isn't configured yet), biases image tasks
 * toward a vision-strong model, honors availability + prior performance, and
 * never throws on unknown input. Advisory — a plan, never a model call.
 */
const assert = require('assert');
const mr = require('../src/lib/ai/model-router');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const ALL = { availability: { azure_openai: true, anthropic: true, google_gemini: true } };

// --- a high-risk numeric reconciliation gets a mandatory independent second opinion ---
let p = mr.planModel({ taskType: 'numeric_reconciliation', riskLevel: 'high', ...ALL });
assert.ok(p.primary && p.primary.provider === 'azure_openai', 'numeric → Azure OpenAI primary');
assert.strictEqual(p.secondOpinionRequired, true);
assert.ok(p.challenger && p.challenger.provider !== p.primary.provider, 'challenger is a DIFFERENT provider');
assert.ok(p.challenger.available, 'challenger available when configured');
ok('high-risk numeric reconciliation → primary + independent second opinion (different vendor)');

// --- when only Azure is configured, the second opinion is NAMED but flagged unavailable ---
p = mr.planModel({ taskType: 'numeric_reconciliation', riskLevel: 'fatal', availability: { azure_openai: true, anthropic: false, google_gemini: false } });
assert.ok(p.primary.provider === 'azure_openai' && p.primary.available);
assert.strictEqual(p.secondOpinionRequired, true);
assert.ok(p.challenger && !p.challenger.available, 'the independent challenger is named but not yet configured');
assert.ok(p.notes.some((n) => /human-verified|not configured/.test(n)), 'notes warn a single-provider result should be human-verified');
ok('only Azure configured → independent second opinion is named but flagged unavailable (human-verify)');

// --- a low-risk extraction needs no second opinion ---
p = mr.planModel({ taskType: 'extraction', riskLevel: 'low', ...ALL });
assert.strictEqual(p.secondOpinionRequired, false);
assert.strictEqual(p.challenger, null);
assert.strictEqual(p.reasoning, 'low', 'extraction runs at low reasoning effort');
ok('low-risk extraction → no second opinion, low reasoning effort');

// --- an image/visual task biases toward a vision-strong provider ---
p = mr.planModel({ taskType: 'visual', riskLevel: 'medium', modality: 'image', ...ALL });
assert.strictEqual(p.primary.provider, 'google_gemini', 'image → vision-strong provider first');
assert.ok(p.notes.some((n) => /vision-strong/.test(n)));
ok('an image task biases toward the vision-strong provider');

// --- narrative reasoning prefers Claude when available ---
p = mr.planModel({ taskType: 'narrative_reasoning', riskLevel: 'medium', ...ALL });
assert.strictEqual(p.primary.provider, 'anthropic', 'narrative → Claude preferred');
ok('narrative reasoning prefers the narrative-strong provider');

// --- availability: the preferred provider down → the next available one wins ---
p = mr.planModel({ taskType: 'narrative_reasoning', riskLevel: 'medium', availability: { azure_openai: true, anthropic: false, google_gemini: true } });
assert.notStrictEqual(p.primary.provider, 'anthropic', 'unavailable preferred provider is skipped');
assert.strictEqual(p.primary.provider, 'azure_openai');
ok('an unavailable preferred provider falls through to the next available one');

// --- prior performance deprioritizes a failing provider ---
p = mr.planModel({ taskType: 'adjudication', riskLevel: 'high', availability: { azure_openai: true, anthropic: true, google_gemini: true }, providerPerformance: { adjudication: { anthropic: false } } });
assert.notStrictEqual(p.primary.provider, 'anthropic', 'a provider failing this task is deprioritized');
ok('a provider that has been failing a task is deprioritized');

// --- unknown task type falls back to the safe default profile ---
p = mr.planModel({ taskType: 'something_unknown', riskLevel: 'high', ...ALL });
assert.strictEqual(p.task, 'extraction', 'unknown task → default extraction profile');
assert.ok(p.primary, 'still returns a usable primary');
ok('an unknown task type falls back to the default profile (never throws)');

// --- no config at all: still names the intended primary (available:false) ---
p = mr.planModel({ taskType: 'numeric_reconciliation', riskLevel: 'high', availability: { azure_openai: false, anthropic: false, google_gemini: false } });
assert.ok(p.primary && p.primary.available === false, 'names the intended primary even when nothing is configured');
ok('no provider configured → names the intended primary (available:false), never null-crashes');

console.log(`\nP1 model-router pure — ${passed} checks passed`);
