'use strict';
/**
 * R5.41 — Admin-question generator (Prompt F) + dedupe (deterministic core, ADVISORY).
 *
 * When the AI is genuinely blocked between two plausible readings of the same
 * evidence, it escalates ONE narrow question to a super-admin. R5.40
 * (admin-question.js) validates + shapes that question; this module GENERATES
 * it from a blocked-decision context and — critically — DEDUPES it, so the same
 * super-admin is never asked the same question twice (across a re-run of the
 * same file, or across sibling files that hit the identical fork).
 *
 * Two parts, mirroring postmortem.js (deterministic scaffold + LLM prompt):
 *  - generate(ctx): a deterministic, VALIDATED question built from the candidate
 *    readings + their evidence — ships value with no LLM.
 *  - promptFor(ctx): the Prompt F system+user messages for LLM refinement of the
 *    wording, constrained to output a narrow, evidence-grounded question only.
 * Plus dedupeKeyFor() / dedupe() — a stable key per blocked fork + a batch/open
 * filter so a duplicate question is suppressed, never re-asked.
 *
 * Pure: no DB, no AI call here (the caller runs the LLM with promptFor()).
 * Advisory: it PROPOSES a question a human answers; it never answers itself,
 * never creates a rule, never changes a decision.
 */

const adminQuestion = require('./admin-question');

function normKey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/**
 * dedupeKeyFor(ctx) → a stable string identifying THIS blocked fork, so the same
 * question maps to the same key regardless of wording. An explicit ctx.dedupeKey
 * always wins. Otherwise: blockedComponent + normalized subject + the SORTED set
 * of option keys (the fork's shape) — two files hitting the same component with
 * the same options collide by design (ask once).
 */
function dedupeKeyFor(ctx) {
  const c = ctx || {};
  if (typeof c.dedupeKey === 'string' && c.dedupeKey.trim() !== '') return c.dedupeKey.trim();
  const comp = normKey(c.blockedComponent);
  const subj = normKey(c.subject);
  const optKeys = (Array.isArray(c.readings) ? c.readings : [])
    .map((o) => normKey(o && o.key)).filter(Boolean).sort();
  return `${comp}|${subj}|${optKeys.join(',')}`;
}

// Pick the recommended option key: an explicit recommendedOption, else the
// reading flagged recommended, else the single highest-confidence reading (only
// when it is a STRICT max — a tie recommends nothing, forcing a human choice).
function pickRecommended(ctx) {
  const readings = Array.isArray(ctx.readings) ? ctx.readings : [];
  if (typeof ctx.recommendedOption === 'string' && ctx.recommendedOption.trim() !== '') return ctx.recommendedOption.trim();
  const flagged = readings.find((r) => r && r.recommended === true);
  if (flagged && flagged.key) return flagged.key;
  const withConf = readings.filter((r) => r && r.key != null && Number.isFinite(Number(r.confidence)));
  if (withConf.length < 1) return null;
  let best = withConf[0], tie = false;
  for (let i = 1; i < withConf.length; i++) {
    const cn = Number(withConf[i].confidence), bn = Number(best.confidence);
    if (cn > bn) { best = withConf[i]; tie = false; }
    else if (cn === bn) tie = true;
  }
  return tie ? null : best.key;
}

/**
 * generate(ctx) → { ok, question?, errors?, dedupeKey }.
 *   ctx: { blockedComponent, subject?, readings:[{ key, label, effect?, confidence?,
 *          recommended? }], evidenceSpanIds:[], questionText?, recommendedRationale?,
 *          answerScope?, questionType? }
 * Builds a deterministic, VALIDATED admin-question (via admin-question.build) from
 * the candidate readings. Returns { ok:false, errors } instead of throwing when the
 * context can't make a safe question (fewer than 2 readings, no evidence, etc.),
 * so a caller degrades gracefully rather than crashing.
 */
function generate(ctx) {
  const c = ctx || {};
  const dedupeKey = dedupeKeyFor(c);
  const readings = Array.isArray(c.readings) ? c.readings : [];
  const options = readings
    .filter((r) => r && r.key != null && r.label != null)
    .map((r) => ({ key: String(r.key), label: String(r.label), effect: r.effect != null ? String(r.effect) : undefined }));
  const q = {
    question: typeof c.questionText === 'string' && c.questionText.trim() !== ''
      ? c.questionText.trim()
      : defaultQuestion(c),
    questionType: c.questionType || 'blocked_reading',
    blockedComponent: c.blockedComponent,
    options,
    evidenceSpanIds: Array.isArray(c.evidenceSpanIds) ? c.evidenceSpanIds : [],
    recommendedOption: pickRecommended(c),
    recommendedRationale: c.recommendedRationale || null,
    answerScope: c.answerScope || 'case_only',
    dedupeKey,
  };
  const v = adminQuestion.validate(q);
  if (!v.ok) return { ok: false, errors: v.errors, dedupeKey };
  return { ok: true, question: adminQuestion.build(q), dedupeKey };
}

function defaultQuestion(c) {
  const comp = c && c.blockedComponent ? String(c.blockedComponent) : 'this decision';
  const subj = c && c.subject ? ` for ${String(c.subject)}` : '';
  return `Which reading of ${comp}${subj} is correct? The evidence supports more than one, and the answer changes the decision.`;
}

/**
 * dedupe(generated, opts) → { fresh:[...], suppressed:[{ dedupeKey, reason }] }.
 *   generated: [{ ok, question?, dedupeKey }]  (outputs of generate(), in priority order)
 *   opts.openKeys: string[] | Set  — dedupe_keys of questions ALREADY OPEN for this
 *     super-admin (don't re-ask). Also dedupes WITHIN the batch (first wins).
 * An invalid generation (ok:false) is dropped from `fresh` (there is nothing safe
 * to ask) and reported under suppressed with reason 'invalid'.
 */
function dedupe(generated, opts = {}) {
  const list = Array.isArray(generated) ? generated : [];
  const open = new Set([...(opts.openKeys instanceof Set ? opts.openKeys : (Array.isArray(opts.openKeys) ? opts.openKeys : []))].map(String));
  const seen = new Set();
  const fresh = [];
  const suppressed = [];
  for (const g of list) {
    if (!g) continue;
    const key = g.dedupeKey != null ? String(g.dedupeKey) : null;
    if (!g.ok) { suppressed.push({ dedupeKey: key, reason: 'invalid' }); continue; }
    if (key && open.has(key)) { suppressed.push({ dedupeKey: key, reason: 'already_open' }); continue; }
    if (key && seen.has(key)) { suppressed.push({ dedupeKey: key, reason: 'duplicate_in_batch' }); continue; }
    if (key) seen.add(key);
    fresh.push(g);
  }
  return { fresh, suppressed };
}

const SYSTEM_PROMPT = `You generate ONE narrow question to escalate to a senior underwriter (super-admin) when the system is genuinely blocked between plausible readings of the SAME evidence. You do NOT answer it and you do NOT change any decision.

Rules:
1. Tie the question to exactly ONE blocked decision component.
2. Offer 2+ MUTUALLY EXCLUSIVE options, each answerable from the displayed evidence.
3. Every option must cite the evidence span id(s) that support it — never ask a question that cannot be answered from what is shown.
4. The default scope is THIS case only. No option may create a permanent or global rule; the strongest an option may do is REQUEST a rule proposal (which still passes evaluation gates).
5. Recommend an option ONLY when the evidence favors one; on a true tie, recommend nothing.
6. Keep it under 400 characters, specific, and free of jargon.
Output only the structured question (question, blockedComponent, options[], evidenceSpanIds[], recommendedOption?, recommendedRationale?, answerScope).`;

function promptFor(ctx) {
  const c = ctx || {};
  const user = {
    blocked_component: c.blockedComponent || null,
    subject: c.subject || null,
    candidate_readings: (Array.isArray(c.readings) ? c.readings : []).map((r) => ({
      key: r && r.key, label: r && r.label, effect: r && r.effect, confidence: r && r.confidence,
      evidence_span_ids: r && r.evidenceSpanIds,
    })),
    evidence_span_ids: Array.isArray(c.evidenceSpanIds) ? c.evidenceSpanIds : [],
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(user) };
}

module.exports = { generate, dedupe, dedupeKeyFor, promptFor, SYSTEM_PROMPT, _internals: { normKey, pickRecommended, defaultQuestion } };
