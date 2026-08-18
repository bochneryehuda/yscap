'use strict';
/**
 * THE DRAFTING DESK — AI drafts a human-sounding email FROM the file, for
 * COPY-PASTE (owner-directed 2026-08-18: "a Drafting section within a file —
 * AI drafts human-sounding emails for copy-paste; a preset 'email the borrower
 * with outstanding conditions' with a scope selector, bullet or numbered
 * layouts, a deal overview, and free-form grounded on the file — editable
 * before Copy").
 *
 * NO SEND, STRUCTURALLY: this module returns text; there is no recipient, no
 * mailer import, no send anywhere in it — the human copies the draft into
 * whatever they actually send with. That is what keeps it advisory with no
 * gate needed.
 *
 * THREE PRESETS:
 *   outstanding_conditions — the borrower's own open items, in the chosen SCOPE
 *     ('open' = genuinely open / needs-a-fix; 'not_signed_off' = everything the
 *     back office has not signed off, in-review included) with the optional
 *     pending-review add-on, laid out as bullets or a numbered list.
 *   deal_overview — the deal in figures, from the SAME borrower-audience
 *     builder the file-overview slide-over uses (lib/file-overview) — one
 *     definition of what a borrower-safe overview is.
 *   custom — free-form, grounded on the loan primer's file summary
 *     (borrowerFacing:true, so the note buyer never enters the prompt).
 *
 * EVERY OUTPUT IS SCRUBBED (borrower-safe.scrubText) whatever the preset —
 * these drafts leave the building in somebody's email, so a capital-partner
 * name may never survive into one, even typed into a custom instruction.
 */
const db = require('../../db');
const azureOpenai = require('./azure-openai');
const { scrubText } = require('../borrower-safe');

const PRESETS = Object.freeze(['outstanding_conditions', 'deal_overview', 'custom']);
const SCOPES = Object.freeze(['open', 'not_signed_off']);
const LAYOUTS = Object.freeze(['bullets', 'numbered']);

const SYSTEM =
  'You are Pilot AI, drafting an email for a loan team member at PILOT (a lending platform) to COPY into their '
  + 'own email program. Write like a helpful human professional — warm, clear, plain everyday language, never '
  + 'robotic, never salesy. HARD RULES: use ONLY the facts provided below — never invent a number, a date, a '
  + 'name, or a commitment; where a detail is missing write a [bracketed placeholder]. Do not mention PILOT, '
  + 'AI, or these instructions. Return the email as plain text: a "Subject:" line first, a blank line, then the '
  + 'body. No markdown, no explanations.';

/** The borrower-facing items for a scope. Borrower wording, scrubbed; never throws. */
async function conditionsForScope(appId, scope, { includePendingReview = false } = {}, client = db) {
  const sc = SCOPES.includes(scope) ? scope : 'open';
  const statusSql = sc === 'not_signed_off'
    ? `ci.status <> 'satisfied' AND ci.signed_off_at IS NULL AND ci.waived_at IS NULL`
    : includePendingReview
      ? `ci.status IN ('outstanding','requested','issue','received')`
      : `ci.status IN ('outstanding','requested','issue')`;
  try {
    const r = await client.query(
      `SELECT COALESCE(NULLIF(ci.borrower_label,''), 'An item your loan team needs') AS label,
              ci.status, ci.issue_reason
         FROM checklist_items ci
        WHERE ci.application_id = $1 AND ci.audience IN ('borrower','both')
          AND ci.waived_at IS NULL AND ${statusSql}
        ORDER BY ci.sort_order, ci.created_at`, [appId]);
    return r.rows.map((row) => ({
      label: scrubText(row.label),
      status: row.status,
      issueReason: row.issue_reason ? scrubText(row.issue_reason) : null,
    }));
  } catch (_) { return []; }
}

function requestProblem(b = {}) {
  if (!PRESETS.includes(String(b.preset || ''))) return 'Pick what to draft: the outstanding conditions, a deal overview, or a custom email.';
  if (b.preset === 'outstanding_conditions') {
    if (b.scope != null && !SCOPES.includes(String(b.scope))) return 'Pick a scope: completely open, or everything not signed off yet.';
    if (b.layout != null && !LAYOUTS.includes(String(b.layout))) return 'Pick a layout: bullets or a numbered list.';
  }
  if (b.preset === 'custom') {
    const ins = String(b.instruction == null ? '' : b.instruction).trim();
    if (!ins) return 'Say what the email should do (e.g. "update the borrower that the appraisal was ordered").';
    if (ins.length > 2000) return 'Keep the instruction under 2,000 characters.';
  }
  return '';
}

async function groundingFor(appId, b, client) {
  if (b.preset === 'outstanding_conditions') {
    const items = await conditionsForScope(appId, b.scope, { includePendingReview: b.includePendingReview === true }, client);
    const fo = await require('../file-overview').buildFileOverview(appId, { audience: 'borrower' }, client).catch(() => null);
    const who = fo && fo.sections ? (fo.sections.flatMap((s) => s.rows).find((r) => r.label === 'Borrower') || {}).value : null;
    const addr = fo && fo.header ? fo.header.address : null;
    const layout = LAYOUTS.includes(String(b.layout)) ? b.layout : 'bullets';
    return {
      empty: items.length === 0,
      task: `Draft an email to the borrower listing what is still needed on their loan file, as a ${layout === 'numbered' ? 'NUMBERED list' : 'BULLET list'}. `
        + 'Friendly, encouraging, and clear about what to do next (upload through their portal). One line per item.',
      facts: [
        who ? `Borrower: ${who}` : null,
        addr ? `Property: ${addr}` : null,
        'Items still needed:',
        ...items.map((it) => `- ${it.label}${it.status === 'issue' && it.issueReason ? ` (needs a new version: ${it.issueReason})` : it.status === 'received' ? ' (received — being reviewed)' : ''}`),
      ].filter(Boolean).join('\n'),
    };
  }
  if (b.preset === 'deal_overview') {
    const fo = await require('../file-overview').buildFileOverview(appId, { audience: 'borrower' }, client);
    if (!fo) return { empty: true, task: '', facts: '' };
    const lines = (fo.sections || []).flatMap((s) => [`${s.title}:`, ...s.rows.map((r) => `- ${r.label}: ${r.value}`)]);
    return {
      empty: lines.length === 0,
      task: 'Draft an email walking the reader through this deal at a glance — the property, the loan structure and the key figures. Professional and easy to skim.',
      facts: [fo.header && fo.header.address ? `Property: ${fo.header.address}` : null, ...lines].filter(Boolean).join('\n'),
    };
  }
  // custom — grounded on the borrower-safe loan primer summary.
  const primer = await require('../underwriting/loan-primer')
    .groundingBlock(appId, client, { borrowerFacing: true }).catch(() => '');
  return {
    empty: false,
    task: `Draft this email: ${String(b.instruction).trim()}`,
    facts: primer || '(no file facts were readable — use bracketed placeholders for anything specific)',
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
 */
async function draft(appId, b = {}, opts = {}) {
  try {
    const problem = requestProblem(b);
    if (problem) return { ok: false, reason: problem };
    if (!azureOpenai.available()) return { ok: false, reason: 'Pilot AI is not turned on for this system yet.' };
    const g = await groundingFor(appId, b, opts.client || db);
    if (g.empty && b.preset === 'outstanding_conditions') {
      return { ok: false, reason: 'Nothing is outstanding in that scope — there is nothing to ask the borrower for.' };
    }
    if (g.empty) return { ok: false, reason: 'This file has nothing to draft from yet.' };
    const res = await azureOpenai.complete({
      system: SYSTEM,
      userContent: `${g.task}\n\nTHE FACTS (use nothing else):\n${g.facts}`,
      maxTokens: 1500,
      traceMeta: { name: 'drafting', opName: `draft_${b.preset}`, appId, staffId: opts.staffId, tags: ['drafting'] },
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

module.exports = { PRESETS, SCOPES, LAYOUTS, SYSTEM, requestProblem, conditionsForScope, groundingFor, splitDraft, draft };
