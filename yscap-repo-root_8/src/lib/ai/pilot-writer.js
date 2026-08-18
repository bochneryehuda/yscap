'use strict';
/**
 * PILOT AI — the writing assistant on every composer (owner-directed 2026-08-18:
 * a branded "Pilot AI" rewrite assistant wherever text is typed — rewrite in a
 * tone, "help me write", fix grammar and spelling — with the result REPLACING
 * into the composer only when the human chooses it).
 *
 * ADVISORY ONLY, STRUCTURALLY: this module returns TEXT to a screen. It sends
 * nothing, saves nothing, clears nothing, and has no database write anywhere —
 * the human reads the suggestion and decides. That is what keeps it inside the
 * "AI never acts" doctrine with no gate needed.
 *
 * THREE MODES, one contract each:
 *   fix      — spelling/grammar/punctuation ONLY; wording, meaning, order and
 *              formatting stay THEIRS. The prompt forbids rephrasing.
 *   rewrite  — the same message said better, in a chosen TONE
 *              (professional | friendly | firm | shorter | plain).
 *   draft    — "help me write": the user says what the message should do, the
 *              assistant drafts it. Grounded on NOTHING but the instruction —
 *              it must never invent a fact, a figure, or a name.
 *
 * The Azure OpenAI seam (lib/ai/azure-openai.complete) carries the env gate,
 * retries, tracing and the cost meter; this module never throws — every path
 * answers { ok, text?, reason? }.
 */
const azureOpenai = require('./azure-openai');

const MODES = Object.freeze(['fix', 'rewrite', 'draft']);
const TONES = Object.freeze({
  professional: 'professional and courteous',
  friendly: 'warm and friendly',
  firm: 'polite but firm and direct',
  shorter: 'as brief as possible while keeping every point',
  plain: 'plain, simple everyday language',
});
const MAX_INPUT = 6000;

const BASE_RULES =
  'You are Pilot AI, the writing assistant inside PILOT, a lending platform. '
  + 'You write on behalf of the person typing, in their voice — first person, natural, human. '
  + 'HARD RULES: never invent a fact, a number, a date, a name, or a commitment that is not in the input. '
  + 'Never add a greeting or signature unless the input has one. Keep any URLs, amounts and names exactly as written. '
  + 'Return ONLY the finished text — no preamble, no quotes around it, no explanations, no markdown fences.';

function requestProblem(b = {}) {
  const mode = String(b.mode || '');
  if (!MODES.includes(mode)) return 'Pick what to do: fix, rewrite, or draft.';
  if (mode === 'draft') {
    const ins = String(b.instruction == null ? '' : b.instruction).trim();
    if (!ins) return 'Say what the message should do (e.g. "ask the title company for the updated commitment").';
    if (ins.length > 2000) return 'Keep the instruction under 2,000 characters.';
  } else {
    const text = String(b.text == null ? '' : b.text).trim();
    if (!text) return 'There is nothing typed yet — write a sentence or two first.';
    if (text.length > MAX_INPUT) return `Keep it under ${MAX_INPUT.toLocaleString('en-US')} characters — split a longer message.`;
  }
  if (b.mode === 'rewrite' && b.tone != null && !Object.prototype.hasOwnProperty.call(TONES, String(b.tone))) {
    return 'Pick one of the offered tones.';
  }
  return '';
}

function systemFor(mode, tone) {
  if (mode === 'fix') {
    return BASE_RULES + ' TASK: fix ONLY spelling, grammar and punctuation. Do NOT rephrase, shorten, '
      + 'reorder or "improve" anything — the wording stays exactly theirs, mistakes aside. '
      + 'If there is nothing to fix, return the input unchanged.';
  }
  if (mode === 'rewrite') {
    const t = TONES[tone] || TONES.professional;
    return BASE_RULES + ` TASK: rewrite the message to say the same things better — tone: ${t}. `
      + 'Every point in the input survives; nothing new is added.';
  }
  return BASE_RULES + ' TASK: draft the message the instruction asks for. Where a needed detail is not '
    + 'given (a date, an amount, a name), write a [bracketed placeholder] rather than inventing one.';
}

/**
 * The one call. Returns { ok:true, text } or { ok:false, reason } — never throws.
 * opts.scrub — a function applied to the OUTPUT before it is returned (the
 * borrower/TPO doors pass the borrower-safe scrub, so a capital-partner name
 * can never ride back even if the user typed one in).
 */
async function assist(b = {}, opts = {}) {
  try {
    const problem = requestProblem(b);
    if (problem) return { ok: false, reason: problem };
    if (!azureOpenai.available()) return { ok: false, reason: 'Pilot AI is not turned on for this system yet.' };
    const mode = String(b.mode);
    const userContent = mode === 'draft'
      ? `Write this message:\n${String(b.instruction).trim()}${String(b.text || '').trim() ? `\n\nWhat is typed so far (build on it):\n${String(b.text).trim().slice(0, MAX_INPUT)}` : ''}`
      : String(b.text).trim();
    const res = await azureOpenai.complete({
      system: systemFor(mode, b.tone),
      userContent,
      maxTokens: 1200,
      traceMeta: { name: 'pilot-writer', opName: `pilot_writer_${mode}`, staffId: opts.staffId, tags: ['pilot-writer'] },
    });
    if (!res.ok || !String(res.text || '').trim()) {
      return { ok: false, reason: res.reason || 'Pilot AI could not answer just now — try again.' };
    }
    let text = String(res.text).trim();
    if (typeof opts.scrub === 'function') { try { text = opts.scrub(text); } catch (_) { /* the raw text is never returned on a scrub failure */ return { ok: false, reason: 'Pilot AI could not answer just now — try again.' }; } }
    return { ok: true, text };
  } catch (_) {
    return { ok: false, reason: 'Pilot AI could not answer just now — try again.' };
  }
}

module.exports = { MODES, TONES, MAX_INPUT, requestProblem, systemFor, assist };
