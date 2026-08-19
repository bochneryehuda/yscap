'use strict';
/**
 * THE ARENA COPILOT — the AI helper inside the game, and nowhere else.
 *
 * WHAT THE OWNER ASKED FOR: an assistant looped into every step of setting a
 * spin up — "you should be able to tell him what you want the next spin to be
 * and he should be able to preset you the template exactly how this spin should
 * look"; ideas on demand ("let's say we want to give some personal related
 * gifts for this spin, we write this and he starts saying: business laptop,
 * business tablet, marketing budget for $1,000 …"); help with subject lines and
 * the wording of a spin; and a small helper for an ordinary person writing
 * their entry — "they should also have this small AI chat to rewrite while
 * they're writing, it should be more professional".
 *
 * ── FIVE RULES, AND THEY ARE THE POINT ─────────────────────────────────────
 *
 * 1. IT NEVER PUBLISHES ANYTHING. Every call here returns a DRAFT that lands in
 *    a form a human then reads, edits and submits through the ordinary path.
 *    There is no endpoint where the model's output becomes live by itself.
 *    That single decision is what makes prompt injection a non-event here: the
 *    worst a poisoned instruction can do is put silly text in a box somebody is
 *    already looking at. (OWASP ranks prompt injection first among LLM risks
 *    precisely because most systems do NOT have this property.)
 *
 * 2. IT NEVER SEES A BORROWER. Not a name, not a loan number, not a file. This
 *    module takes ONLY what a staffer typed and the game's own vocabulary. It
 *    imports no borrower module, reads no loan table, and is given no way to.
 *    A regulator's view of AI in lending is that existing consumer-protection
 *    law applies in full and there is no AI carve-out — so the safe design is
 *    for the game's assistant to be structurally incapable of touching the
 *    lending side, rather than merely instructed not to.
 *    `scripts/test-arena-copilot-pure.js` fails the build if this file ever
 *    imports something that could.
 *
 * 3. IT IS ALWAYS OPTIONAL. Every screen that offers it works completely
 *    without it. If the key is missing, the model is slow, or the call fails,
 *    the answer is a plain "the helper is not available right now" and the
 *    person types it themselves. On a live sales day, an AI call that hangs
 *    must never be able to stop a spin going out.
 *
 * 4. EVERYTHING IT WRITES IS LABELLED. Every response carries `aiGenerated:
 *    true` and the wording the screens show. Nothing it produces is ever
 *    presented as though a person wrote it.
 *
 * 5. ONE DOOR. Every feature goes through `ask()` — one rate limit, one budget
 *    check, one timeout, one audit line. There is no second place that calls
 *    the model.
 *
 * ── WHICH MODEL ────────────────────────────────────────────────────────────
 * Whatever this company has deployed in Azure OpenAI (`AZURE_OPENAI_DEPLOYMENT`).
 * The owner asked for "ChatGPT 5.5"; `gpt-5.5` is a real model and so is the
 * newer 5.6 family, but which of them is reachable depends on the Azure region
 * and subscription, and that is an operations decision, not a line of code. So
 * this module names no model: it uses the configured deployment and reports
 * that name back, so the screen can say exactly what actually answered. Nothing
 * here has to change to move to a newer one.
 */

const openai = require('../ai/azure-openai');
const cfg = require('../../config');

// ── budget and pace ────────────────────────────────────────────────────────
// In-memory, because this app runs as one web process (see lib/events.js). Said
// plainly rather than implied: with more than one process these become
// per-process, which for a helper's pace limit is a cost worth naming and not
// worth new infrastructure for. The hard daily cap is the one that matters, and
// it is deliberately generous enough that a normal day never touches it and
// tight enough that a stuck loop cannot run up a bill overnight.
const PER_MINUTE = 12;
const PER_DAY = 300;
const seen = new Map();       // staffId -> { minute: [ts], day: n, dayStamp }

function pace(staffId) {
  const now = Date.now();
  const key = String(staffId || 'anon');
  const day = new Date(now).toISOString().slice(0, 10);
  let s = seen.get(key);
  if (!s || s.dayStamp !== day) { s = { minute: [], day: 0, dayStamp: day }; seen.set(key, s); }
  s.minute = s.minute.filter((t) => now - t < 60000);
  if (s.minute.length >= PER_MINUTE) {
    return { ok: false, reason: 'You are asking the helper faster than it can think. Give it a few seconds.' };
  }
  if (s.day >= PER_DAY) {
    return { ok: false, reason: 'The helper has done its share for today. Everything still works without it.' };
  }
  s.minute.push(now);
  s.day += 1;
  return { ok: true };
}

/** Is the helper usable at all right now? */
function available() { return openai.available(); }

/** What the screens show next to anything this file produced. */
const AI_LABEL = 'Written by the AI helper — read it before you use it.';

/**
 * THE ONE DOOR. Everything below calls this and nothing else calls the model.
 *
 * Never throws. Returns `{ ok, data | reason }`. A refusal, a timeout, a
 * missing key and a mangled answer are four different sentences, because
 * "something went wrong" teaches people to distrust the whole feature.
 */
async function ask({ system, user, schema, staffId, opName, maxTokens = 900, timeoutMs = 20000 }) {
  if (!available()) {
    return { ok: false, reason: 'The AI helper is not switched on for this company yet. Type it in yourself — everything works without it.' };
  }
  const paced = pace(staffId);
  if (!paced.ok) return { ok: false, reason: paced.reason };

  // The STABLE part of the prompt goes first and the person's own words last.
  // That is the ordering that lets the provider cache the unchanging prefix,
  // which is the single biggest lever on what this costs.
  const res = await openai.complete({
    system,
    userContent: String(user || '').slice(0, 6000),
    maxTokens,
    timeoutMs,
    responseFormat: schema
      ? { type: 'json_schema', json_schema: { name: opName || 'arena', strict: true, schema } }
      : undefined,
    traceMeta: { name: 'arena-copilot', opName, staffId, tags: ['arena'] },
  });

  if (!res.ok) {
    // Classified, because the fix is different for each.
    const r = String(res.reason || '');
    if (/content filter|refus/i.test(r)) return { ok: false, reason: 'The helper would not answer that one. Try asking it a different way.' };
    if (/timed out|timeout|deadline/i.test(r)) return { ok: false, reason: 'The helper took too long. Type it in yourself, or try again in a moment.' };
    if (/not configured/i.test(r)) return { ok: false, reason: 'The AI helper is not switched on for this company yet.' };
    return { ok: false, reason: `The helper could not answer just now (${r || 'no reason given'}).` };
  }

  if (!schema) return { ok: true, text: res.text, aiGenerated: true, label: AI_LABEL, model: modelName() };

  let data;
  try { data = JSON.parse(res.text); }
  catch (_) {
    return { ok: false, reason: 'The helper answered in a shape we could not read. Try again, or type it in yourself.' };
  }
  return { ok: true, data, aiGenerated: true, label: AI_LABEL, model: modelName() };
}

const modelName = () => (cfg.azureOpenai && cfg.azureOpenai.deployment) || null;

// ── the shared voice ───────────────────────────────────────────────────────
// One system prompt, extended per job. Stable text first so it caches.
const HOUSE = [
  'You help run an internal, staff-only game at a mortgage lender. It is a fun sales-day',
  'competition for the loan officers: wheels are spun, people win prizes.',
  '',
  'HARD RULES you must follow in every answer:',
  '- This is INTERNAL and STAFF ONLY. Never write anything addressed to a borrower, a client,',
  '  a broker or any customer. Never write marketing copy aimed at consumers.',
  '- Never invent a rate, a fee, a loan term, an approval, or anything that reads as a lending',
  '  promise. This is a game, not a product.',
  '- Never name a real borrower, a real loan, or any personal detail. You are not given any and',
  '  must not invent any.',
  '- Keep it warm, short and plain. Real working language, not corporate filler. No emoji unless',
  '  you are asked for them.',
  '- If the request does not make sense for a staff game, say so plainly in the fields you are',
  '  given rather than making something up.',
].join('\n');

// ── (a) build a whole spin from a sentence ─────────────────────────────────

const SPIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    subtitle: { type: ['string', 'null'] },
    suggestedGameKey: { type: ['string', 'null'] },
    wheels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, what: { type: 'string' } },
        required: ['title', 'what'],
      },
    },
    personalCapUsd: { type: ['number', 'null'] },
    businessCapUsd: { type: ['number', 'null'] },
    qualifiers: { type: 'array', items: { type: 'string' } },
    emailSubject: { type: 'string' },
    announcement: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['title', 'subtitle', 'suggestedGameKey', 'wheels', 'personalCapUsd',
    'businessCapUsd', 'qualifiers', 'emailSubject', 'announcement', 'notes'],
};

/**
 * "Make a spin for whoever books the most appointments before lunch, prize up
 * to $500" -> a filled-in draft of the new-spin form.
 *
 * The game keys are passed IN rather than imported, so this module stays
 * ignorant of the catalog and the catalog stays the one definition.
 */
async function draftSpin({ text, gameKeys = [], staffId }) {
  const system = [
    HOUSE, '',
    'JOB: turn what the organiser typed into a draft of the "new spin" form. It is a DRAFT — a',
    'human reads and edits every field before anything happens, so prefer a sensible complete',
    'answer over asking questions.',
    '',
    'Fields:',
    '- title: short and punchy, what the room will see. Under 60 characters.',
    '- subtitle: one line underneath, or null.',
    `- suggestedGameKey: the closest match from this list, or null: ${gameKeys.join(', ')}`,
    '- wheels: one entry per wheel, in the order they should be spun. `title` is what the wheel',
    '  is called on screen ("Who wins", "What they win"); `what` says in plain words what goes',
    '  on it. One wheel is fine. Never more than four.',
    '- personalCapUsd / businessCapUsd: the most somebody may ask for, in dollars, or null to',
    '  leave the company default. Never suggest above 2000.',
    '- qualifiers: only if the spin is about what somebody DID — the list of things that could',
    '  win. Empty array otherwise.',
    '- emailSubject: the subject line of the email announcing it. Under 60 characters, no',
    '  ALL CAPS, no exclamation-mark pileups.',
    '- announcement: two or three sentences telling the team what this is and what to do.',
    '- notes: anything the organiser should double-check before they press go.',
  ].join('\n');
  return ask({ system, user: text, schema: SPIN_SCHEMA, staffId, opName: 'draft-spin', maxTokens: 1400 });
}

// ── (b) ideas on demand ────────────────────────────────────────────────────

const IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' },
          valueUsd: { type: ['number', 'null'] },
          kind: { type: 'string' },
        },
        required: ['label', 'detail', 'valueUsd', 'kind'],
      },
    },
  },
  required: ['ideas'],
};

/**
 * PRIZE IDEAS. The owner's own example of what good looks like: "business
 * laptop, business tablet, business marketing budget for $1,000 that you can
 * spend for marketing, a blog video with bloggers up to $1,000, a full page in
 * a magazine, a voice ad, a video ad" — and, for the small end, "notepads, an
 * electric board that you can write and delete on your desk".
 *
 * `avoid` carries what has already been suggested, so "more ideas" gives new
 * ones rather than the same five reworded.
 */
async function prizeIdeas({ text, kind = 'personal', capUsd, avoid = [], staffId }) {
  const cap = Number(capUsd) > 0 ? Math.round(Number(capUsd)) : (kind === 'business' ? 1000 : 500);
  const system = [
    HOUSE, '',
    'JOB: suggest prizes a loan officer would actually be pleased to win.',
    '',
    `These are ${kind === 'business' ? 'FOR THEIR BUSINESS — things that help them write more loans'
      : kind === 'desk' ? 'THINGS FOR THEIR DESK — small, useful, and used every day'
        : 'PERSONAL — for them, not for work'}.`,
    `Nothing above $${cap}. Give a realistic price for each; if it has no cash value (a perk, an`,
    'afternoon off, first pick of the parking spots) use null and say so in the detail.',
    '',
    'Nine ideas. Concrete and specific — "a marketing budget you can spend how you like" beats',
    '"marketing". Vary them: do not give nine versions of one idea.',
    'kind must be exactly one of: personal, business, perk, desk.',
    avoid.length ? `Already suggested, do not repeat: ${avoid.slice(0, 40).join('; ')}` : '',
  ].filter(Boolean).join('\n');
  return ask({ system, user: text || `Ideas for ${kind} prizes under $${cap}.`, schema: IDEAS_SCHEMA, staffId, opName: 'prize-ideas' });
}

const CHALLENGE_IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          prompt: { type: 'string' },
          proofType: { type: 'string' },
          awardMode: { type: 'string' },
          tier: { type: 'number' },
        },
        required: ['title', 'prompt', 'proofType', 'awardMode', 'tier'],
      },
    },
  },
  required: ['ideas'],
};

/** CHALLENGE IDEAS — the things that pop up during the Mega Spin. */
async function challengeIdeas({ text, avoid = [], staffId }) {
  const system = [
    HOUSE, '',
    'JOB: suggest challenges that pop up on the sales floor during the day. A loan officer sees',
    'one on screen, does the thing, and earns chances in the end-of-day draw.',
    '',
    'What they actually do all day: dial, get people on the phone, book appointments, take',
    'applications, issue pre-approvals, lock loans, work their realtor partners, and go back',
    'through their own database.',
    '',
    'THE IMPORTANT LIMIT: this system records no call log, no dial count and no talk time.',
    'Nothing can be checked automatically. So every challenge has to be provable by a person —',
    'a screenshot, something they write, a teammate vouching, or a number they type that could',
    'be spot-checked.',
    'proofType must be exactly one of: upload, text, checkin, count, peer.',
    'awardMode must be exactly one of: everyone, first, first_n.',
    'tier is 1 (a couple of minutes) to 5 (the biggest thing all day).',
    '',
    'Nine ideas. Most should be awardMode "everyone" — a day where only the fastest three people',
    'ever win is a day everybody else stops trying. prompt is what appears on screen, one or two',
    'sentences, spoken to the person directly.',
    avoid.length ? `Already used, do not repeat: ${avoid.slice(0, 40).join('; ')}` : '',
  ].filter(Boolean).join('\n');
  return ask({ system, user: text || 'Ideas for challenges during a call blitz.', schema: CHALLENGE_IDEAS_SCHEMA, staffId, opName: 'challenge-ideas' });
}

// ── (c) rewrite what somebody typed ────────────────────────────────────────

const REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rewritten: { type: 'string' },
    whatChanged: { type: 'string' },
  },
  required: ['rewritten', 'whatChanged'],
};

/**
 * "Make what I wrote sound better."
 *
 * The rewrite is RETURNED, never applied. The screen shows it beside what they
 * typed with an accept and a reject, and their own words are kept until they
 * choose — losing what somebody wrote is the one unforgivable thing a writing
 * helper can do.
 */
async function rewrite({ text, purpose = 'entry', staffId }) {
  const what = {
    entry: 'a short note saying what prize they would like to win in a staff game',
    claim: 'a short note saying what they did to earn a place in a staff game draw, and how it can be checked',
    chat: 'a message in the team chat during the game',
    subject: 'the subject line of an email announcing a spin to the team',
    announcement: 'a short announcement to the team about a spin',
  }[purpose] || 'a short note in a staff game';
  const system = [
    HOUSE, '',
    `JOB: tidy up ${what}.`,
    '',
    'Keep their meaning exactly. Keep it roughly the same length or shorter. Keep it in their',
    'voice — this is a colleague, not a press release. Fix the spelling and the grammar, make it',
    'clear, and stop.',
    'Do NOT add facts, numbers, prices or promises they did not write.',
    'If what they wrote is already fine, return it unchanged and say so in whatChanged.',
    'whatChanged: one short sentence, plain words.',
  ].join('\n');
  return ask({ system, user: text, schema: REWRITE_SCHEMA, staffId, opName: 'rewrite', maxTokens: 700 });
}

/** SUBJECT LINES — a few to choose between, for the launch email. */
const SUBJECTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { subjects: { type: 'array', items: { type: 'string' } } },
  required: ['subjects'],
};

async function subjectLines({ text, staffId }) {
  const system = [
    HOUSE, '',
    'JOB: six subject lines for the email telling the team a spin is open.',
    'Under 60 characters each. Say what it is and when it closes if you were told. Different from',
    'each other in tone: one plain, one with a countdown, one playful. No ALL CAPS, no strings of',
    'exclamation marks, nothing that reads as spam.',
  ].join('\n');
  return ask({ system, user: text, schema: SUBJECTS_SCHEMA, staffId, opName: 'subjects', maxTokens: 400 });
}

module.exports = {
  available, ask, AI_LABEL, modelName,
  draftSpin, prizeIdeas, challengeIdeas, rewrite, subjectLines,
  SPIN_SCHEMA, IDEAS_SCHEMA, CHALLENGE_IDEAS_SCHEMA, REWRITE_SCHEMA, SUBJECTS_SCHEMA,
  PER_MINUTE, PER_DAY,
  _pace: pace,
};
