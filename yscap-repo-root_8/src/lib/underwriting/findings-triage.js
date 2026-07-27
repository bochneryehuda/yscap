'use strict';
/**
 * findings-triage — the AI worklist (owner-directed 2026-07-27, the "what else" list).
 *
 * The finding-review gate judges each finding in isolation and the risk score is fixed weights;
 * neither tells a human "look at THESE first." This reads ALL the still-showing findings for a file
 * at once, against the whole loan file, and ranks them into a worklist: which are the real story
 * (primary), which are secondary, and which are low-signal noise — each with a one-line reason. The
 * ranking is DISPLAY-ONLY: it re-orders the list and adds a "priority" chip; it never changes a
 * finding's severity-of-record, the clear-to-close gate, or any number. Advisory.
 *
 * SAFE by construction (same rails as finding-ai-review): OFF-switch FINDINGS_TRIAGE_ENABLED=0 (ON by
 * default, gated by Azure being configured + the per-file cost cap); best-effort — every entry point
 * is guarded and NEVER throws; memoized by a hash of the finding SET so it re-runs only when the set
 * of findings actually changes (a fully-triaged file costs nothing on re-view). Consulting the human
 * ledger is unnecessary here — it only ranks findings that are ALREADY being shown.
 */

const crypto = require('crypto');
const azureOpenai = require('../ai/azure-openai');
const costMeter = require('../ai/cost-meter');
const primer = require('./loan-primer');
const { claimOf } = require('./finding-claims');

function enabled() {
  return String(process.env.FINDINGS_TRIAGE_ENABLED || '') !== '0';
}

const OCR_CHAR_LIMIT = Math.max(4000, parseInt(process.env.FINDINGS_TRIAGE_OCR_LIMIT || '20000', 10) || 20000);
const MAX_TOKENS = Math.max(400, parseInt(process.env.FINDINGS_TRIAGE_MAX_TOKENS || '1500', 10) || 1500);
// Don't ask the model to rank an unbounded list; bound the prompt. A file with more findings than
// this still triages the first N (by severity) — the rest simply carry no ranking (shown as usual).
const MAX_FINDINGS = Math.max(4, parseInt(process.env.FINDINGS_TRIAGE_MAX || '30', 10) || 30);

const BUCKETS = ['primary', 'secondary', 'noise'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ranked: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },     // the finding's number in the list we sent
          bucket: { type: 'string', enum: BUCKETS },
          why: { type: 'string' },
        },
        required: ['index', 'bucket', 'why'],
      },
    },
  },
  required: ['ranked'],
};

const SYSTEM = `You are a senior mortgage underwriter triaging an automated system's findings on ONE loan file. You are given the whole loan file and a numbered list of findings PILOT raised. Put them in the order a human should work them — most important FIRST — and sort each into a bucket:
 - "primary" = the real story; act on these first.
 - "secondary" = worth handling but not the headline.
 - "noise" = low-signal / likely not worth the underwriter's time (a formatting nit, a value that's fine in context, a duplicate-feeling item).
Return the findings in PRIORITY ORDER (first = look here first), each with its index (from the list), its bucket, and a ONE-line plain-language reason. Judge importance against the WHOLE deal (an assignment vs a straight purchase, the leverage, the program). Do not invent findings; only rank the ones given. Include EVERY finding exactly once.`;

// Order-independent hash of the SET of findings (their claim keys) — a change to the set (a finding
// appears or clears) forces a re-triage; a mere re-view does not.
function setHashOf(findings) {
  const keys = (findings || []).map((f) => claimOf(f) || (f && f.code) || '').filter(Boolean).sort();
  return crypto.createHash('sha256').update(keys.join('|')).digest('hex').slice(0, 16);
}

async function readMemory(client, appId) {
  const out = new Map();
  if (!client || !appId) return out;
  try {
    const { rows } = await client.query(`SELECT * FROM finding_triage WHERE application_id=$1`, [appId]);
    for (const r of rows) out.set(r.claim_key, r);
  } catch (_) { /* unreadable → empty (fail-open) */ }
  return out;
}

function describeForPrompt(findings) {
  return findings.map((f, i) => {
    const parts = [`[${i + 1}] (${f.severity || 'info'})`, f.title || f.code || 'a finding'];
    if (f.code) parts.push(`code=${f.code}`);
    return parts.join(' — ');
  }).join('\n');
}

/**
 * THE BACKGROUND PASS. Re-triage a file's findings when the set changed; persist the ranking.
 * Bounded + cost-capped + best-effort; NEVER throws.
 * @returns {Promise<{ranked:number, skipped:string|null}>}
 */
async function reviewTriage({ client, appId, findings, db } = {}) {
  const empty = { ranked: 0, skipped: null };
  try {
    if (!enabled()) return { ...empty, skipped: 'disabled' };
    if (!azureOpenai.available()) return { ...empty, skipped: 'ai_unavailable' };
    if (!client || !appId || !Array.isArray(findings) || findings.length < 2) return { ...empty, skipped: 'nothing_to_do' };

    // Rank the highest-severity findings first if we have to cap.
    const SEV = { fatal: 0, warning: 1, info: 2 };
    const ordered = findings.filter((f) => f && (f.code || f.title))
      .slice().sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3)).slice(0, MAX_FINDINGS);
    if (ordered.length < 2) return { ...empty, skipped: 'nothing_to_do' };

    const setHash = setHashOf(ordered);
    const mem = await readMemory(client, appId);
    // If every current finding already has a ranking made against THIS same set, nothing to do.
    const allFresh = ordered.every((f) => { const r = mem.get(claimOf(f) || ''); return r && r.set_hash === setHash; });
    if (allFresh) return { ...empty, skipped: 'all_fresh' };

    const allowed = await costMeter.allowSpend(appId, client).catch(() => true);
    if (!allowed) return { ...empty, skipped: 'cost_cap' };

    let grounding = '';
    try { grounding = await primer.groundingBlock(appId, db || client); } catch (_) { grounding = ''; }
    const instructions = `Findings to triage (rank most-important first, one bucket + one-line reason each):\n${describeForPrompt(ordered)}\n\nBelow is the whole loan file.`;
    const res = await azureOpenai.extract({
      system: SYSTEM, instructions, schema: SCHEMA,
      ocrText: grounding, ocrCharLimit: OCR_CHAR_LIMIT, maxTokens: MAX_TOKENS,
      traceMeta: { opName: 'findings-triage' },
    });
    if (!res || !res.ok || !res.data || !Array.isArray(res.data.ranked)) return { ...empty, skipped: 'no_result' };

    // Persist: rank = position in the returned priority order.
    let rank = 0; let ranked = 0;
    const seen = new Set();
    for (const item of res.data.ranked) {
      const idx = Number(item && item.index);
      if (!Number.isInteger(idx) || idx < 1 || idx > ordered.length) continue;
      const f = ordered[idx - 1];
      const key = claimOf(f) || null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rank += 1;
      const bucket = BUCKETS.includes(item.bucket) ? item.bucket : 'secondary';
      const why = item.why ? String(item.why).slice(0, 400) : null;
      try {
        await client.query(
          `INSERT INTO finding_triage (application_id, claim_key, bucket, rank, why, set_hash, model)
           VALUES ($1,$2,$3,$4,$5,$6,'azure-openai')
           ON CONFLICT (application_id, claim_key) DO UPDATE SET
             bucket=EXCLUDED.bucket, rank=EXCLUDED.rank, why=EXCLUDED.why, set_hash=EXCLUDED.set_hash, updated_at=now()`,
          [appId, key, bucket, rank, why, setHash]);
        ranked += 1;
      } catch (_) { /* best-effort per row */ }
    }
    return { ranked, skipped: null };
  } catch (_) {
    return { ...empty, skipped: 'error' };
  }
}

/**
 * THE DISPLAY PASS (synchronous, no GPT). Annotate each finding with its triage ranking and return
 * the findings re-ordered by priority (findings with a ranking first, in rank order; then anything
 * un-ranked, in the order given). Best-effort; never throws — on any error, the input order is kept.
 */
function applyTriage(findings, memory) {
  try {
    const mem = memory instanceof Map ? memory : new Map();
    if (!Array.isArray(findings) || !mem.size) return findings || [];
    const annotated = findings.map((f) => {
      if (!f) return f;
      const r = mem.get(claimOf(f) || '');
      if (!r) return f;
      return Object.assign({}, f, { aiTriage: { bucket: r.bucket, rank: r.rank, why: r.why } });
    });
    // Stable sort: ranked findings first (by rank asc), then un-ranked in original order.
    return annotated.map((f, i) => ({ f, i }))
      .sort((a, b) => {
        const ra = a.f && a.f.aiTriage && a.f.aiTriage.rank; const rb = b.f && b.f.aiTriage && b.f.aiTriage.rank;
        if (ra != null && rb != null) return ra - rb || a.i - b.i;
        if (ra != null) return -1;
        if (rb != null) return 1;
        return a.i - b.i;
      })
      .map((x) => x.f);
  } catch (_) {
    return findings || [];
  }
}

module.exports = { enabled, setHashOf, reviewTriage, applyTriage, readMemory, _internals: { describeForPrompt, SCHEMA, MAX_FINDINGS } };
