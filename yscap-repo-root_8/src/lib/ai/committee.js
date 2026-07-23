'use strict';
/**
 * Multi-model Reasoning Committee — Sovereign 3/4 (owner-directed 2026-07-21).
 *
 * Instead of one model producing every finding on its own, MATERIAL findings
 * (fatals + high-impact warnings) are reviewed by a COMMITTEE of specialist
 * agents plus an ADJUDICATOR. Each specialist has a narrow prompt + a specific
 * lens (identity, entity, credit, fraud, appraisal, title, insurance). The
 * adjudicator combines their opinions and produces:
 *   * adjudicated_severity ('fatal' | 'warning' | 'informational' | 'dismiss')
 *   * majority_conclusion (short paragraph)
 *   * dissenting_opinions[] (specialists that disagreed with the majority)
 *   * confidence (0-1)
 *
 * Two forms of independence:
 *   1. DIFFERENT PROMPTS. Each specialist speaks from a different lens, with
 *      an assertive "try to REFUTE this finding" bias built into the prompt —
 *      the goal is adversarial verification, not a chorus. The current build
 *      routes every specialist through the same Azure OpenAI deployment; a
 *      second model provider slots in via SPECIALISTS[k].model when a key is
 *      available (a stub for Claude/Gemini/etc. is included).
 *   2. STRUCTURED OUTPUT. Each specialist returns a strict JSON verdict, so
 *      the adjudicator's combine step is pure code (not another LLM call).
 *
 * Pure module: no HTTP of its own except through the shared azureOpenai.
 * Best-effort — a specialist that fails is a null vote, never a throw.
 */
const azureOpenai = require('./azure-openai');
const langfuse = require('./langfuse');
const { routeFinding } = require('./committee-routing');
const providers = require('./committee-providers');

// Severity ordering — used by the never-weaken guard so an UNCOVERED finding can
// never be moved BELOW its original severity by off-lens specialists (#213).
const SEV_RANK = Object.freeze({ dismiss: 0, informational: 1, warning: 2, fatal: 3 });
function sevRank(s) { return SEV_RANK[s] != null ? SEV_RANK[s] : 1; }

// -------------------------------------------------------------------------
// SPECIALISTS — narrow-prompt reviewers, each with an adversarial bias.
// A finding presented to the committee is refuted by every specialist whose
// lens applies; a specialist whose lens DOES NOT apply returns 'abstain'.
// -------------------------------------------------------------------------
const BASE_INSTRUCTIONS = `You are a specialist reviewer on a mortgage underwriting committee.
Your job is to independently verify or REFUTE the proposed finding you are given.
Default to REFUTING when uncertain — the committee's value is catching false positives.
Return ONLY a strict JSON object matching the schema. No prose. No markdown.
The schema is:
  {
    "verdict": "confirm" | "refute" | "modify" | "abstain",
    "confidence": 0..1,
    "severity_recommendation": "fatal" | "warning" | "informational" | "dismiss",
    "reason": "one plain-language sentence explaining your vote",
    "requires_evidence": [ "what additional evidence would settle this, if any" ]
  }
verdict=confirm  — the finding is real and the proposed severity is right
verdict=refute   — the finding is a false positive OR the wrong severity — say why
verdict=modify   — the finding is real but the severity should change (name the new severity)
verdict=abstain  — this specialist's lens does not apply to this finding`;

const SPECIALISTS = Object.freeze({
  identity: {
    name: 'Identity specialist',
    lens: 'borrower identity, name/DOB/ID consistency, expired IDs, synthetic identity',
    applies_to: ['borrower_name_mismatch','id_expired','photo_missing','background_subject_mismatch','background_entity_mismatch'],
    system: `${BASE_INSTRUCTIONS}
Your lens: BORROWER IDENTITY. Consider: name/DOB matches, ID expiration, photo, synthetic identity risk. Refute a finding that stems from a common variant of the same real person (nickname, middle initial, suffix). Consider a name mismatch REAL when the two names would not be plausibly the same person.`,
  },
  entity: {
    name: 'Entity specialist',
    lens: 'LLC formation, EIN, good standing, signing authority, ownership chain',
    applies_to: ['entity_name_mismatch','entity_not_screened','entity_good_standing','signing_authority','beneficial_owner'],
    system: `${BASE_INSTRUCTIONS}
Your lens: BORROWING ENTITY. Consider: entity name consistency (LLC vs L.L.C. vs Ltd. Liab. Co.), formation date, EIN presence, good standing, signing authority chain. Refute a finding that stems from an entity-name FORMATTING variant only. Consider an entity mismatch REAL when the actual owner or vesting party is different.`,
  },
  credit: {
    name: 'Credit specialist',
    lens: 'FICO, tradelines, derogatory items, undisclosed liabilities, mortgage history',
    applies_to: ['fico_below_min','undisclosed_debt','recent_derog','mortgage_late'],
    system: `${BASE_INSTRUCTIONS}
Your lens: BORROWER CREDIT. Consider: FICO vs program minimum, recent bankruptcies/foreclosures, undisclosed mortgages, tradeline consistency. Refute a finding based on a stale credit pull (>90 days) or a subject mismatch. Consider a program-minimum FICO breach REAL when the current FICO on file is unambiguously below cutoff.`,
  },
  fraud: {
    name: 'Fraud & sanctions specialist',
    lens: 'OFAC, fraud alerts, PEP, identity theft signals, straw borrower, document tampering',
    applies_to: ['ofac_confirmed_match','ofac_potential_match','background_fraud_alerts','background_pep','pdf_tampering'],
    system: `${BASE_INSTRUCTIONS}
Your lens: FRAUD & SANCTIONS. A CONFIRMED OFAC / SDN match is a HARD STOP — always confirm at fatal. A potential match is real (adjudicate). Fraud alerts (identity theft, mail-drop address, SSN issued after DOB) must be cleared. Refute a fraud finding that stems from a benign transcription (a middle-name difference between a screening service and the file). Never refute an OFAC hit.`,
  },
  appraisal: {
    name: 'Appraisal specialist',
    lens: 'property type, units, condition, value defensibility, comparables, ARV rationale',
    applies_to: ['property_type_mismatch','property_units_mismatch','arv_defensibility','value_variance','comp_grid'],
    system: `${BASE_INSTRUCTIONS}
Your lens: APPRAISAL / COLLATERAL. Consider: property type + units consistency, ARV vs comp support, condition impact, subject location. Refute a property-type finding stemming from a labeling variance (Detached vs SFR are the same physical type when units=1). Consider a units mismatch REAL (2-family shown on appraisal, 3-family on file) — that materially changes the loan.`,
  },
  title: {
    name: 'Title specialist',
    lens: 'vesting, chain of title, liens, exceptions, legal description',
    applies_to: ['vesting_mismatch','undisclosed_liens','legal_description','seller_of_record'],
    system: `${BASE_INSTRUCTIONS}
Your lens: TITLE. Consider: vesting party matches the borrowing entity, all liens can clear at closing, seller of record is the record owner, legal description matches. Refute a vesting finding when the entity name difference is a formatting variant. Consider an unclearable judgment / tax lien REAL.`,
  },
  insurance: {
    name: 'Insurance & flood specialist',
    lens: 'insured name, coverage amount, effective dates, mortgagee clause, flood policy when in zone',
    applies_to: ['insured_mismatch','coverage_below_loan','effective_date','mortgagee_missing','flood_policy_missing','flood_zone'],
    system: `${BASE_INSTRUCTIONS}
Your lens: INSURANCE & FLOOD. Consider: insured name matches vesting, coverage at least equal to the loan, policy effective through closing, mortgagee clause present, flood policy on file when property is in an A/V zone. Refute an insured-name finding that's a formatting variant. Consider a coverage-below-loan finding REAL.`,
  },
});

// -------------------------------------------------------------------------
// PROMPT — the finding is presented to each specialist as a compact packet.
// -------------------------------------------------------------------------
function findingPrompt(finding, context) {
  const parts = [];
  parts.push('# Proposed finding');
  parts.push(`Code: ${finding.code || ''}`);
  parts.push(`Severity: ${finding.severity || ''}`);
  parts.push(`Title: ${finding.title || ''}`);
  if (finding.docValue != null) parts.push(`What the document says: ${finding.docValue}`);
  if (finding.fileValue != null) parts.push(`What the loan file says: ${finding.fileValue}`);
  if (finding.howTo) parts.push(`Explanation: ${finding.howTo}`);
  if (finding.field) parts.push(`Field: ${finding.field}`);
  parts.push('');
  parts.push('# File context');
  if (context && context.borrowerName) parts.push(`Borrower: ${context.borrowerName}`);
  if (context && context.entityName)   parts.push(`Entity:   ${context.entityName}`);
  if (context && context.propertyAddress) parts.push(`Property: ${context.propertyAddress}`);
  if (context && context.program)      parts.push(`Program:  ${context.program}`);
  if (context && context.loanAmount)   parts.push(`Loan:     $${Number(context.loanAmount).toLocaleString('en-US')}`);
  parts.push('');
  parts.push('# Your task');
  parts.push('Independently review this finding through your specialist lens. Return the strict JSON verdict.');
  return parts.join('\n');
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict','confidence','severity_recommendation','reason'],
  properties: {
    verdict: { type: 'string', enum: ['confirm','refute','modify','abstain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    severity_recommendation: { type: 'string', enum: ['fatal','warning','informational','dismiss'] },
    reason: { type: 'string', minLength: 1, maxLength: 400 },
    requires_evidence: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 5 },
  },
};

async function askSpecialist(key, finding, context, trace, providerName) {
  const spec = SPECIALISTS[key];
  if (!spec) return { key, ok: false, reason: 'unknown specialist' };
  // #215 — resolve this specialist's PROVIDER. When a second independent provider
  // (Anthropic) is assigned but unavailable, fall back to the primary so the panel
  // still runs; when nothing is configured at all, report not-configured as before.
  let client = providerName ? providers.clientFor(providerName) : azureOpenai;
  let provider = providerName || providers.PRIMARY;
  if (!client.available()) {
    if (azureOpenai.available()) { client = azureOpenai; provider = providers.PRIMARY; }
    else return { key, ok: false, reason: 'analyzer not configured' };
  }
  const responseFormat = {
    type: 'json_schema',
    json_schema: { name: 'CommitteeVerdict', schema: VERDICT_SCHEMA, strict: true },
  };
  const r = await client.complete({
    system: spec.system,
    userContent: findingPrompt(finding, context),
    maxTokens: 600,
    responseFormat,
    timeoutMs: 45000,
    trace,
    traceMeta: { opName: `reviewer:${spec.lens}`, specialist: key, findingCode: finding && finding.code, provider },
  });
  if (!r.ok) return { key, ok: false, reason: r.reason || 'no response', provider };
  let verdict;
  try { verdict = JSON.parse(r.text); } catch (_) { return { key, ok: false, reason: 'model returned non-JSON', provider }; }
  return { key, ok: true, name: spec.name, lens: spec.lens, verdict };
}

// -------------------------------------------------------------------------
// ADJUDICATOR — pure logic. Combines specialist verdicts into a single
// committee opinion. No LLM call. Rules:
//   1. Any CONFIRM at 'fatal' → adjudicated 'fatal' (safety-first — a fatal
//      finding stands unless refuted with high confidence).
//   2. If >= half of NON-ABSTAINING specialists confirm → the finding is real
//      at the majority-recommended severity.
//   3. If >= 2/3 of non-abstaining specialists refute at high confidence
//      (>= 0.8) → 'dismiss' — BUT ONLY when the finding was actually COVERED
//      by a qualified specialist (opts.covered !== false). A finding that no
//      qualified specialist reviewed can never be auto-dismissed; it is HELD
//      for a human (#213 — the never-miss / abstain-on-uncertainty guard).
//   4. Otherwise → hold at the original severity, mark 'needs_review'.
//   Dissents are always preserved so the underwriter sees who disagreed.
//   Confirming a finding (keeping it) is always allowed — the coverage guard
//   only constrains DISMISSAL, the sole action that could drop a real issue.
// -------------------------------------------------------------------------
function adjudicate(finding, specialistResults, opts = {}) {
  // Default TRUE for back-compat: a caller that doesn't declare coverage is
  // trusted (the specialists it passed are assumed qualified). The live path
  // (review()) always passes the real coverage from routeFinding().
  const covered = !opts || opts.covered !== false;
  const votes = specialistResults.filter((r) => r.ok && r.verdict && r.verdict.verdict !== 'abstain');
  const total = votes.length;
  const confirms = votes.filter((v) => v.verdict.verdict === 'confirm');
  const refutes = votes.filter((v) => v.verdict.verdict === 'refute');
  const modifies = votes.filter((v) => v.verdict.verdict === 'modify');
  const abstained = specialistResults.filter((r) => r.ok && r.verdict && r.verdict.verdict === 'abstain').map((r) => r.key);
  const failed = specialistResults.filter((r) => !r.ok).map((r) => ({ specialist: r.key, reason: r.reason }));

  const originalSeverity = finding.severity || 'warning';
  let adjudicatedSeverity = originalSeverity;
  let action = 'hold';
  let confidence = 0.5;
  let reasoning;

  const anyFatalConfirm = confirms.some((v) => v.verdict.severity_recommendation === 'fatal');
  const highConfRefutes = refutes.filter((v) => Number(v.verdict.confidence || 0) >= 0.8);

  if (anyFatalConfirm) {
    adjudicatedSeverity = 'fatal';
    action = 'confirm';
    confidence = Math.max(...confirms.map((v) => Number(v.verdict.confidence || 0.5)));
    reasoning = `Confirmed as fatal by ${confirms.length}/${total} specialist(s) — including at least one who recommended the fatal severity.`;
  } else if (total > 0 && confirms.length * 2 >= total) {
    // Majority confirm → real, at the median-recommended severity.
    const sevs = confirms.map((v) => v.verdict.severity_recommendation).filter(Boolean);
    adjudicatedSeverity = sevs[Math.floor(sevs.length / 2)] || originalSeverity;
    action = 'confirm';
    confidence = confirms.length / total;
    reasoning = `Confirmed by ${confirms.length}/${total} specialist(s).`;
  } else if (covered && total > 0 && highConfRefutes.length * 3 >= total * 2) {
    // >= 2/3 high-confidence refute → dismiss — but ONLY when a qualified
    // specialist covered this finding (see the coverage guard above).
    action = 'dismiss';
    adjudicatedSeverity = 'dismiss';
    confidence = highConfRefutes.reduce((a, v) => a + Number(v.verdict.confidence || 0.8), 0) / highConfRefutes.length;
    reasoning = `Refuted by ${highConfRefutes.length}/${total} specialist(s) at high confidence.`;
  } else if (modifies.length > confirms.length && modifies.length > refutes.length) {
    // Plurality wants a modified severity.
    const sevs = modifies.map((v) => v.verdict.severity_recommendation).filter(Boolean);
    adjudicatedSeverity = sevs[Math.floor(sevs.length / 2)] || originalSeverity;
    action = 'modify';
    confidence = modifies.length / (total || 1);
    reasoning = `${modifies.length}/${total} specialist(s) recommended a different severity.`;
  } else {
    action = 'hold';
    confidence = total > 0 ? Math.max(0.3, confirms.length / total) : 0.3;
    if (!covered && highConfRefutes.length * 3 >= total * 2 && total > 0) {
      // Would have been dismissed, but no QUALIFIED specialist covered this
      // finding's domain — hold for a human rather than drop a possibly-real issue.
      reasoning = `No specialist whose lens covers this finding was available, so the ${highConfRefutes.length}/${total} refuting vote(s) cannot dismiss it. Holding the original severity for human review.`;
    } else {
      reasoning = total > 0
        ? `Split panel — ${confirms.length} confirm, ${refutes.length} refute, ${modifies.length} modify. Holding original severity; human review recommended.`
        : 'No specialist opinion available. Holding original severity.';
    }
  }

  // #213 NEVER-WEAKEN GUARD (belt-and-suspenders over the dismiss gate): an
  // UNCOVERED finding — one no qualified specialist reviewed — may never be moved
  // BELOW its original severity by off-lens specialists (a downgrade is the same
  // "buried by the wrong lens" miss as a dismiss, just softer). Upgrades (a stronger
  // severity) are always allowed. When uncovered and the panel wanted to weaken it,
  // hold at the original severity for a human instead.
  if (!covered && sevRank(adjudicatedSeverity) < sevRank(originalSeverity)) {
    adjudicatedSeverity = originalSeverity;
    action = 'hold';
    reasoning = 'No specialist whose lens covers this finding was available, so it cannot be downgraded or dismissed. Holding the original severity for human review.';
  }

  return {
    action,
    adjudicated_severity: adjudicatedSeverity,
    original_severity: originalSeverity,
    covered,
    confidence,
    reasoning,
    votes: specialistResults.map((r) => ({
      specialist: r.key,
      ok: !!r.ok,
      verdict: r.verdict || null,
      reason: r.ok ? null : r.reason,
    })),
    dissents: (action === 'confirm' ? refutes : (action === 'dismiss' ? confirms : []))
      .map((v) => ({ specialist: v.key, verdict: v.verdict.verdict, reason: v.verdict.reason, severity: v.verdict.severity_recommendation })),
    abstained,
    failed,
  };
}

// -------------------------------------------------------------------------
// REVIEW — run the committee on one finding. Auto-selects which specialists
// to consult based on the finding's code (via applies_to); an abstain from
// an off-lens specialist is still recorded so the reviewer sees the panel
// composition. Best-effort: specialists that error are recorded as failed
// but don't stop the panel.
// -------------------------------------------------------------------------
async function review(finding, context = {}, opts = {}) {
  // #213 — DOMAIN-based routing (code keywords + document source + field + the
  // specialist's own applies_to prefix), not a single code prefix. `covered` is
  // false when no qualified specialist's lens applies → the adjudicator HOLDS
  // (never dismisses) so a real finding in an unrouted domain is never dropped.
  let keys, covered;
  if (opts.all === true) {
    keys = Object.keys(SPECIALISTS);
    covered = true;
  } else {
    const route = routeFinding(finding, SPECIALISTS);
    keys = route.specialists;
    covered = route.covered;
  }
  const results = [];
  // ONE Langfuse trace per committee review — every specialist call nests under it.
  const trace = langfuse.trace({
    name: 'committee-review',
    appId: context.applicationId || context.appId,
    documentId: context.documentId,
    staffId: opts.staffId,
    tags: ['committee', finding && finding.code].filter(Boolean),
    input: { finding: { code: finding.code, title: finding.title, severity: finding.severity }, specialists: keys },
  });
  // #215 — assign each specialist a PROVIDER. With a second independent provider
  // (Anthropic) live, ~half the panel runs on it so a finding is verified by two
  // different models; with none, every specialist uses the primary (unchanged).
  const assignments = providers.resolveAssignments(keys);
  const multiModel = new Set(Object.values(assignments)).size > 1;
  // Parallel — each specialist is an independent HTTP call.
  const promises = keys.map((k) => askSpecialist(k, finding, context, trace, assignments[k]).catch((e) => ({ key: k, ok: false, reason: (e && e.message) || 'error' })));
  const settled = await Promise.all(promises);
  results.push(...settled);
  const opinion = adjudicate(finding, results, { covered });
  trace.end({ output: { action: opinion.action, adjudicated_severity: opinion.adjudicated_severity, confidence: opinion.confidence } });
  return {
    finding: { code: finding.code, id: finding.id, severity: finding.severity, title: finding.title },
    committee: opinion,
    providers: assignments,   // which model each specialist ran on
    multi_model: multiModel,  // true when the panel spanned ≥2 independent providers
    generated_at: new Date().toISOString(),
    committee_version: 'v1',
    trace_url: trace.url ? trace.url() : null,
  };
}

module.exports = { SPECIALISTS, review, adjudicate, _internals: { findingPrompt, askSpecialist } };
