'use strict';
/**
 * THE DRAFTING DESK — AI drafts a human-sounding email FROM the file, for
 * COPY-PASTE (owner-directed 2026-08-18: "a Drafting section within a file —
 * AI drafts human-sounding emails for copy-paste; a preset 'email the borrower
 * with outstanding conditions' with a scope selector, bullet or numbered
 * layouts, a deal overview, and free-form grounded on the file — editable
 * before Copy").
 *
 * UPGRADED same day (owner-directed 2026-08-18 evening: "it should write
 * everything with more thought to it … break down the liquidity requirement,
 * cash to close, and reserves … 'if you have a little bit extra, send a
 * little bit extra' … your file is registered with this and this amount of
 * fix-and-hold … Maybe it shouldn't be on by default. Maybe it should just
 * be an option to make the entire section, the entire draft, more detailed
 * … give much more options"):
 *   · DETAIL mode (opt-in, default OFF exactly as the owner suggested) —
 *     drafting-detail.js renders per-condition FACT BLOCKS from the SAME
 *     modules the Condition Center reads (asset-ledger, track-record-todo,
 *     rehab-budget, the payoff columns), plus each condition's own
 *     borrower-facing hint, so the draft states the real figures.
 *   · TONE (professional / friendly / firm / plain) and LENGTH
 *     (short / standard / thorough).
 *   · ITEM PICKING — itemIds narrows the outstanding-conditions preset to
 *     the exact conditions the sender ticked.
 *   · SIGN-AS — the sender's own sign-off name rides as a fact.
 *   · REVISE — feedback + the previous draft regenerate a corrected draft
 *     on the SAME grounding (never on the model's memory).
 *
 * NO SEND, STRUCTURALLY: this module returns text; there is no recipient, no
 * mailer import, no send anywhere in it — the human copies the draft into
 * whatever they actually send with. That is what keeps it advisory with no
 * gate needed.
 *
 * EVERY OUTPUT IS SCRUBBED (borrower-safe.scrubText) whatever the preset —
 * these drafts leave the building in somebody's email, so a capital-partner
 * name may never survive into one, even typed into a custom instruction or
 * pasted back through the revise box.
 */
const db = require('../../db');
const azureOpenai = require('./azure-openai');
const { scrubText } = require('../borrower-safe');

const PRESETS = Object.freeze(['outstanding_conditions', 'deal_overview', 'custom']);
const SCOPES = Object.freeze(['open', 'not_signed_off']);
const LAYOUTS = Object.freeze(['bullets', 'numbered']);
const TONES = Object.freeze(['professional', 'friendly', 'firm', 'plain']);
const LENGTHS = Object.freeze(['short', 'standard', 'thorough']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM =
  'You are Pilot AI, drafting an email for a loan team member at PILOT (a lending platform) to COPY into their '
  + 'own email program. Write like a helpful human professional — warm, clear, plain everyday language, never '
  + 'robotic, never salesy. HARD RULES: use ONLY the facts provided below — never invent a number, a date, a '
  + 'name, or a commitment; where a detail is missing write a [bracketed placeholder]. Do not mention PILOT, '
  + 'AI, or these instructions. Return the email as plain text: a "Subject:" line first, a blank line, then the '
  + 'body. No markdown, no explanations.';

/** The borrower-facing items for a scope. Borrower wording, scrubbed; never throws.
 *  `itemIds` (validated uuids) narrows to exactly the ticked conditions; the
 *  family keys (templateCode/toolKey) + hint ride along for the detail layer. */
async function conditionsForScope(appId, scope, { includePendingReview = false, itemIds = null } = {}, client = db) {
  const sc = SCOPES.includes(scope) ? scope : 'open';
  const statusSql = sc === 'not_signed_off'
    ? `ci.status <> 'satisfied' AND ci.signed_off_at IS NULL AND ci.waived_at IS NULL`
    : includePendingReview
      ? `ci.status IN ('outstanding','requested','issue','received')`
      : `ci.status IN ('outstanding','requested','issue')`;
  const ids = Array.isArray(itemIds) ? itemIds.filter((x) => UUID_RE.test(String(x || ''))) : null;
  try {
    const r = await client.query(
      `SELECT ci.id,
              COALESCE(NULLIF(ci.borrower_label,''), 'An item your loan team needs') AS label,
              ci.status, ci.issue_reason, ci.tool_key,
              NULLIF(ci.borrower_hint,'') AS hint,
              t.code AS template_code
         FROM checklist_items ci
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id = $1 AND ci.audience IN ('borrower','both')
          AND ci.waived_at IS NULL AND ${statusSql}
          ${ids && ids.length ? `AND ci.id = ANY($2::uuid[])` : ''}
        ORDER BY ci.sort_order, ci.created_at`,
      ids && ids.length ? [appId, ids] : [appId]);
    return r.rows.map((row) => ({
      id: row.id,
      label: scrubText(row.label),
      status: row.status,
      issueReason: row.issue_reason ? scrubText(row.issue_reason) : null,
      hint: row.hint ? scrubText(row.hint) : null,
      toolKey: row.tool_key || null,
      templateCode: row.template_code || null,
    }));
  } catch (_) { return []; }
}

function requestProblem(b = {}) {
  if (!PRESETS.includes(String(b.preset || ''))) return 'Pick what to draft: the outstanding conditions, a deal overview, or a custom email.';
  if (b.preset === 'outstanding_conditions') {
    if (b.scope != null && !SCOPES.includes(String(b.scope))) return 'Pick a scope: completely open, or everything not signed off yet.';
    if (b.layout != null && !LAYOUTS.includes(String(b.layout))) return 'Pick a layout: bullets or a numbered list.';
    if (b.itemIds != null) {
      if (!Array.isArray(b.itemIds) || b.itemIds.length > 60) return 'Pick up to 60 items.';
      if (b.itemIds.some((x) => !UUID_RE.test(String(x || '')))) return 'One of the picked items is not a real condition — refresh and pick again.';
    }
  }
  if (b.preset === 'custom') {
    const ins = String(b.instruction == null ? '' : b.instruction).trim();
    if (!ins) return 'Say what the email should do (e.g. "update the borrower that the appraisal was ordered").';
    if (ins.length > 2000) return 'Keep the instruction under 2,000 characters.';
  }
  if (b.tone != null && !TONES.includes(String(b.tone))) return 'Pick a tone: professional, friendly, firm, or plain.';
  if (b.length != null && !LENGTHS.includes(String(b.length))) return 'Pick a length: short, standard, or thorough.';
  if (b.signAs != null && String(b.signAs).length > 120) return 'Keep the sign-off name under 120 characters.';
  if (b.feedback != null) {
    const fb = String(b.feedback).trim();
    if (!fb) return 'Say what to change about the draft.';
    if (fb.length > 1000) return 'Keep the feedback under 1,000 characters.';
    if (!String(b.previousBody || '').trim()) return 'There is no previous draft to revise — generate one first.';
    if (String(b.previousBody).length > 12000 || String(b.previousSubject || '').length > 300) return 'The previous draft is too long to revise — generate a fresh one.';
  }
  return '';
}

/* The style riders appended to every task — tone, length, sign-off. */
const TONE_LINE = {
  professional: 'Tone: polished and professional.',
  friendly: 'Tone: warm and friendly.',
  firm: 'Tone: courteous but firm and direct — this is a follow-up that needs action.',
  plain: 'Tone: very plain, simple language a beginner understands.',
};
const LENGTH_LINE = {
  short: 'Keep it SHORT — a few sentences plus the list.',
  thorough: 'Be thorough — a sentence or two of explanation for each item, so the reader understands why it is needed.',
};
function styleRiders(b) {
  const out = [];
  if (b.tone && TONE_LINE[b.tone]) out.push(TONE_LINE[b.tone]);
  if (b.length && LENGTH_LINE[b.length]) out.push(LENGTH_LINE[b.length]);
  if (b.signAs && String(b.signAs).trim()) out.push('Sign off with the sender name given in the facts.');
  return out;
}
function signFact(b) {
  const s = String(b.signAs == null ? '' : b.signAs).trim();
  return s ? `Sign the email as: ${scrubText(s)}` : null;
}

/* In DETAIL mode each condition's own borrower-facing hint (the Condition
   Center's written guidance) rides as a fact, bounded so a long hint cannot
   crowd the prompt. The loud ⚠️ banner marker is display markup, not words. */
function hintFacts(items) {
  const out = [];
  for (const it of items.slice(0, 14)) {
    if (!it.hint) continue;
    const h = it.hint.replace(/^\s*⚠️\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 320);
    if (h) out.push(`Guidance on "${it.label}": ${h}`);
  }
  return out;
}

async function groundingFor(appId, b, client) {
  const detailed = b.detail === true || b.detail === 'detailed';
  if (b.preset === 'outstanding_conditions') {
    const items = await conditionsForScope(appId, b.scope,
      { includePendingReview: b.includePendingReview === true, itemIds: b.itemIds }, client);
    const fo = await require('../file-overview').buildFileOverview(appId, { audience: 'borrower' }, client).catch(() => null);
    const who = fo && fo.sections ? (fo.sections.flatMap((s) => s.rows).find((r) => r.label === 'Borrower') || {}).value : null;
    const addr = fo && fo.header ? fo.header.address : null;
    const layout = LAYOUTS.includes(String(b.layout)) ? b.layout : 'bullets';
    const detail = detailed ? await require('./drafting-detail').detailFor(appId, items, client) : { facts: [], guidance: [] };
    const task = [
      `Draft an email to the borrower listing what is still needed on their loan file, as a ${layout === 'numbered' ? 'NUMBERED list' : 'BULLET list'}. `
        + 'Friendly, encouraging, and clear about what to do next (upload through their portal). One line per item'
        + (detailed ? ', with the specific figures and guidance from the facts woven in where an item has them.' : '.'),
      ...detail.guidance,
      ...styleRiders(b),
    ].join('\n');
    return {
      empty: items.length === 0,
      task,
      facts: [
        who ? `Borrower: ${who}` : null,
        addr ? `Property: ${addr}` : null,
        signFact(b),
        'Items still needed:',
        ...items.map((it) => `- ${it.label}${it.status === 'issue' && it.issueReason ? ` (needs a new version: ${it.issueReason})` : it.status === 'received' ? ' (received — being reviewed)' : ''}`),
        ...(detailed ? hintFacts(items) : []),
        ...detail.facts,
      ].filter(Boolean).join('\n'),
    };
  }
  if (b.preset === 'deal_overview') {
    const fo = await require('../file-overview').buildFileOverview(appId, { audience: 'borrower' }, client);
    if (!fo) return { empty: true, task: '', facts: '' };
    const lines = (fo.sections || []).flatMap((s) => [`${s.title}:`, ...s.rows.map((r) => `- ${r.label}: ${r.value}`)]);
    const detail = detailed ? await require('./drafting-detail').detailFor(appId, null, client) : { facts: [], guidance: [] };
    return {
      empty: lines.length === 0,
      task: [
        'Draft an email walking the reader through this deal at a glance — the property, the loan structure and the key figures. Professional and easy to skim.',
        ...detail.guidance,
        ...styleRiders(b),
      ].join('\n'),
      facts: [fo.header && fo.header.address ? `Property: ${fo.header.address}` : null, signFact(b), ...lines, ...detail.facts].filter(Boolean).join('\n'),
    };
  }
  // custom — grounded on the borrower-safe loan primer summary.
  const primer = await require('../underwriting/loan-primer')
    .groundingBlock(appId, client, { borrowerFacing: true }).catch(() => '');
  const detail = detailed ? await require('./drafting-detail').detailFor(appId, null, client) : { facts: [], guidance: [] };
  return {
    empty: false,
    task: [`Draft this email: ${String(b.instruction).trim()}`, ...detail.guidance, ...styleRiders(b)].join('\n'),
    facts: [primer || '(no file facts were readable — use bracketed placeholders for anything specific)', signFact(b), ...detail.facts]
      .filter(Boolean).join('\n'),
  };
}

/** Split the model's "Subject: … \n\n body" answer. Tolerant of a missing subject line. */
function splitDraft(text) {
  const t = String(text || '').trim();
  const m = t.match(/^subject:\s*(.+?)\s*\n+([\s\S]*)$/i);
  if (m) return { subject: m[1].trim(), body: m[2].trim() };
  return { subject: null, body: t };
}

/**
 * The one call. { ok:true, subject, body } or { ok:false, reason }. Never
 * throws; the OUTPUT is always borrower-safe-scrubbed.
 *
 * REVISE: when b.feedback + b.previousBody are present, the task becomes
 * "revise this draft per the feedback" — with the SAME grounding facts, so a
 * revision can only ever draw on the file, never on the model's imagination;
 * the pasted-back previous draft is scrubbed on the way IN too.
 */
async function draft(appId, b = {}, opts = {}) {
  try {
    const problem = requestProblem(b);
    if (problem) return { ok: false, reason: problem };
    if (!azureOpenai.available()) return { ok: false, reason: 'Pilot AI is not turned on for this system yet.' };
    // The per-FILE spend cap every other metered AI door here honors (aiReason,
    // ai-guideline-verify, the as-is reader) — drafting has an appId, so it
    // gates the same way (audit 2026-08-18 finding 1, drafting half).
    try {
      const capOk = await require('./cost-meter').allowSpend(appId, opts.client || db);
      if (!capOk) return { ok: false, reason: 'This file has reached its AI spending cap for now — try again later.' };
    } catch (_) { /* an unreadable meter never blocks a draft */ }
    const g = await groundingFor(appId, b, opts.client || db);
    if (g.empty && b.preset === 'outstanding_conditions') {
      return { ok: false, reason: 'Nothing is outstanding in that scope — there is nothing to ask the borrower for.' };
    }
    if (g.empty) return { ok: false, reason: 'This file has nothing to draft from yet.' };
    const revising = b.feedback != null && String(b.previousBody || '').trim();
    const task = revising
      ? `Revise the email draft below according to this feedback: ${scrubText(String(b.feedback).trim())}\n`
        + 'Keep everything factual to THE FACTS; keep what the feedback does not ask to change.\n'
        + (g.task ? `The draft was originally written to this brief:\n${g.task}` : '')
      : g.task;
    const facts = revising
      ? `${g.facts}\n\nTHE CURRENT DRAFT (revise this):\nSubject: ${scrubText(String(b.previousSubject || '').trim())}\n\n${scrubText(String(b.previousBody).trim())}`
      : g.facts;
    const detailed = b.detail === true || b.detail === 'detailed';
    const res = await azureOpenai.complete({
      system: SYSTEM,
      userContent: `${task}\n\nTHE FACTS (use nothing else):\n${facts}`,
      maxTokens: detailed || b.length === 'thorough' || revising ? 2200 : 1500,
      traceMeta: { name: 'drafting', opName: `draft_${b.preset}${detailed ? '_detailed' : ''}${revising ? '_revise' : ''}`, appId, staffId: opts.staffId, tags: ['drafting'] },
    });
    if (!res.ok || !String(res.text || '').trim()) {
      return { ok: false, reason: res.reason || 'Pilot AI could not draft just now — try again.' };
    }
    const { subject, body } = splitDraft(scrubText(String(res.text).trim()));
    return { ok: true, subject, body };
  } catch (_) {
    return { ok: false, reason: 'Pilot AI could not draft just now — try again.' };
  }
}

module.exports = {
  PRESETS, SCOPES, LAYOUTS, TONES, LENGTHS, SYSTEM,
  requestProblem, conditionsForScope, groundingFor, splitDraft, draft,
};
