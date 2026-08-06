'use strict';
/**
 * ai-narrative — the whole-file coherence reasoner (owner-directed 2026-07-27, the "what else" list).
 *
 * The cross-document check (ai-cross-doc.js) only catches PAIRWISE field contradictions between two
 * extractions. It cannot make the cross-domain judgment a senior underwriter makes: "does this deal
 * hold together as one story?" — e.g. the borrower claims heavy-rehab experience but the bank
 * statements show no contractor activity and the entity was formed last week. This reads the WHOLE
 * loan file (loan-primer grounding — economics, parties, chains, liquidity, experience, program) and
 * returns a short ranked list of coherence concerns.
 *
 * ADVISORY ONLY: it records `ai_suggestions` rows (kind 'info'/'finding') a human can look at; it
 * never creates/edits a condition, never blocks, never changes a number. It is grounded STRICTLY on
 * the primer with a "never invent a number or a fact" instruction. It is memoized by a hash of the
 * file state so it re-runs only when the file changed (not every view) — the cost posture of
 * ai-cross-doc. OFF-switch AI_NARRATIVE_ENABLED=0 (ON by default, gated by Azure + the per-file cost
 * cap). Best-effort — NEVER throws.
 */

const crypto = require('crypto');
const azureOpenai = require('../ai/azure-openai');
const costMeter = require('../ai/cost-meter');
const primer = require('./loan-primer');
const aiSug = require('./ai-suggestions');

const SOURCE = 'narrative_coherence';

function enabled() {
  return String(process.env.AI_NARRATIVE_ENABLED || '') !== '0';
}

const OCR_CHAR_LIMIT = Math.max(6000, parseInt(process.env.AI_NARRATIVE_OCR_LIMIT || '40000', 10) || 40000);
const MAX_TOKENS = Math.max(500, parseInt(process.env.AI_NARRATIVE_MAX_TOKENS || '1600', 10) || 1600);
const MAX_CONCERNS = 6;

const SEV = ['info', 'warning', 'fatal'];
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    holdsTogether: { type: 'boolean' },
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          concern: { type: 'string' },
          severity: { type: 'string', enum: SEV },
          why: { type: 'string' },
        },
        required: ['concern', 'severity', 'why'],
      },
    },
  },
  required: ['holdsTogether', 'concerns'],
};

const SYSTEM = `You are a senior mortgage underwriter reading a WHOLE loan file as a story. Your ONE question: does this deal hold together, and what is the single most important thing that does not add up? Look ACROSS domains — the price vs value vs loan, the borrower's claimed experience vs what the bank statements and entity age actually show, the parties in the chain of title vs the vesting entity, the program vs the deal shape. Report only GENUINE coherence concerns — a story that does not fit — not a restatement of individual field mismatches (those are found elsewhere). Ground STRICTLY on what you are given; NEVER invent a number, a party, or a fact that is not present. If the file holds together, return holdsTogether=true and an empty concerns list. Keep each concern to one clear sentence + a one-line why, most important first.`;

function concernKey(text) {
  return `${SOURCE}:${crypto.createHash('sha256').update(String(text || '').toLowerCase().trim()).digest('hex').slice(0, 16)}`;
}

// Withdraw the file's OPEN narrative suggestions (untouched rows only) before writing a fresh set,
// so a re-read against a changed file doesn't accumulate stale concerns.
async function retractOpen(client, appId, why) {
  try {
    const r = await client.query(
      `UPDATE ai_suggestions SET status='dismissed', status_reason=$3, updated_at=now()
        WHERE application_id=$1 AND source=$2 AND status='open' RETURNING id`,
      [appId, SOURCE, `Withdrawn automatically: ${why}`]);
    // Retire the `ai_fatal_finding` notification each retracted finding had (owner-reported
    // 2026-08-06): the finding self-heals here, but its notification lived on forever and
    // kept showing as an unread fatal. Best-effort — a notify-retire failure never reverses
    // the retraction.
    try {
      const ids = r.rows.map((x) => x.id);
      if (ids.length) await require('./ai-finding-notify').retireForSuggestions(client, appId, ids);
    } catch (_) { /* additive */ }
    return r.rowCount || 0;
  } catch (_) { return 0; }
}

/**
 * Run the narrative pass for one file. Memoized by the file-state hash. Best-effort; NEVER throws.
 * @returns {Promise<{raised:number, retracted:number, skipped:string|null}>}
 */
async function analyzeFile(client, appId, db) {
  const out = { raised: 0, retracted: 0, skipped: null };
  try {
    if (!enabled()) return { ...out, skipped: 'disabled' };
    if (!azureOpenai.available()) return { ...out, skipped: 'ai_unavailable' };
    if (!client || !appId) return { ...out, skipped: 'nothing_to_do' };

    let grounding = '';
    try { grounding = await primer.groundingBlock(appId, db || client); } catch (_) { grounding = ''; }
    if (!grounding) return { ...out, skipped: 'no_grounding' };
    const hash = crypto.createHash('sha256').update(grounding).digest('hex').slice(0, 16);

    // Memoize on an audit_log stamp (so a NO-CONCERN file is memoized too — an ai_suggestions row
    // only exists when there's a concern). If the last narrative run for this file was against THIS
    // exact file state, skip. Fails toward running (never toward a stale skip) on a read error.
    try {
      const last = await client.query(
        `SELECT detail FROM audit_log WHERE action='ai_narrative_run' AND entity_type='application' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [appId]);
      const d = last.rows[0] && last.rows[0].detail;
      const prevHash = d && (typeof d === 'string' ? (() => { try { return JSON.parse(d).groundingHash; } catch (_) { return null; } })() : d.groundingHash);
      if (prevHash && prevHash === hash) return { ...out, skipped: 'fresh' };
    } catch (_) { /* fall through and run */ }

    const allowed = await costMeter.allowSpend(appId, client).catch(() => true);
    if (!allowed) return { ...out, skipped: 'cost_cap' };

    const res = await azureOpenai.extract({
      system: SYSTEM,
      instructions: 'Read the whole loan file below and report only genuine coherence concerns (a story that does not fit).',
      schema: SCHEMA, ocrText: grounding, ocrCharLimit: OCR_CHAR_LIMIT, maxTokens: MAX_TOKENS,
      traceMeta: { opName: 'ai-narrative' },
    });
    if (!res || !res.ok || !res.data) return { ...out, skipped: 'no_result' };

    // The file state changed (we got here past the memo) → clear the prior open set first.
    out.retracted = await retractOpen(client, appId, 'the loan file changed — re-read');

    const concerns = Array.isArray(res.data.concerns) ? res.data.concerns.slice(0, MAX_CONCERNS) : [];
    for (const c of concerns) {
      const text = c && c.concern ? String(c.concern).slice(0, 300) : '';
      if (!text) continue;
      const severity = SEV.includes(c.severity) ? c.severity : 'info';
      const rec = await aiSug.record(client, {
        applicationId: appId,
        source: SOURCE,
        kind: severity === 'info' ? 'info' : 'finding',
        severity,
        title: text,
        body: `${c.why ? String(c.why).slice(0, 400) : ''}\n\nThis is PILOT reading the whole file as a story — a cross-check no single-document rule makes. Advisory only; a human decides whether it matters.`.trim(),
        evidence: { groundingHash: hash, kind: 'narrative_coherence' },
        dedupeKey: concernKey(text),
      });
      if (rec && rec.id) out.raised += 1;
    }
    // Stamp this run's file-state hash so the memo short-circuits next time — including a
    // no-concern run (which wrote no ai_suggestions row). Best-effort.
    try {
      await client.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system','ai_narrative_run','application',$1,$2::jsonb)`,
        [appId, JSON.stringify({ groundingHash: hash, concerns: out.raised })]);
    } catch (_) { /* stamp is best-effort — a miss just re-runs next view */ }
    return out;
  } catch (_) {
    return { ...out, skipped: 'error' };
  }
}

module.exports = { enabled, analyzeFile, _internals: { concernKey, SCHEMA, SOURCE, retractOpen } };
