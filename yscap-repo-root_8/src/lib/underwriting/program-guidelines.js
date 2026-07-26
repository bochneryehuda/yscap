'use strict';
/**
 * AUS PROGRAM GUIDELINES — the underwriting engine's single, plain-language statement of "which
 * program is this file registered under, and what are that program's governing thresholds?"
 * (owner-directed 2026-07-21, Item 11 — "connect underwriting to each program's guidelines … it
 * must realize which program a file is registered under and underwrite AGAINST that program's
 * guidelines like an AUS").
 *
 * This module does NOT invent or duplicate any guideline number. It READS the program facts that
 * already live in their canonical homes and composes them into ONE snapshot the desk can see:
 *   - the beneficial-owner (KYC) verification threshold + treatment — from entity-chain.js
 *     (PROGRAM_OWNER_RULES / ownerRuleFor), the same map the beneficial-owner check enforces;
 *   - the required months of bank statements — from liquidity.js (bankStatementMonths), the same
 *     rule the assets condition is worded from;
 *   - the SOW contingency requirement (Gold) — a fact, matched to rehab-budget.js's rule.
 * The frozen pricing engines (standard-program.js / gold-standard.js / pricing.js) remain the
 * source of the leverage CAPS + sized economics; those are read per-file off the registration's
 * `quote` (file-view.js) and are NOT re-derived here. So this stays a READER of guidelines, never a
 * second copy of them — changing a threshold in its canonical home changes this snapshot too.
 *
 * Pure: no DB, no network. The caller resolves the registered program (registration first,
 * application second — see the route) and the manual-program asset months, and passes them in.
 */

const { ownerRuleFor } = require('./entity-chain');
const { bankStatementMonths } = require('../liquidity');
const { SOW_CONTINGENCY_PCT } = require('../rehab-budget');

// The canonical program keys the AUS recognizes. Anything else (an unregistered file, a free-text
// application strategy) resolves to `null` — an unknown program, where we state only the baseline
// (KYC 25% fallback) and never assert a program-specific requirement we can't justify.
const PROGRAM_KEYS = { standard: 'Standard', gold: 'Gold Standard', manual: 'Manual' };

function canonProgram(program) {
  const p = String(program || '').toLowerCase().trim();
  if (p === 'gold' || /gold/.test(p)) return 'gold';
  if (p === 'standard' || /standard/.test(p)) return 'standard';
  if (p === 'manual' || /manual/.test(p)) return 'manual';
  return null;
}

/**
 * Compose the program guideline snapshot for a file.
 * @param {string|null} program  the REGISTERED program key ('gold'|'standard'|'manual') or null
 * @param {{assetMonths?:number, sowContingencyRequired?:boolean}} [opts]
 *   assetMonths — manual-program stated liquidity months (ignored for Gold/Standard);
 *   sowContingencyRequired — the AUTHORITATIVE requirement resolved by the caller from
 *   rehab-budget.sowContingencyRequired (Gold OR a Blue Lake note buyer). When omitted, the
 *   snapshot falls back to the program arm only (Gold), which under-reports a Blue Lake Standard
 *   file — so the route passes the real value to keep the snapshot in step with the SOW gate.
 * @returns {{
 *   program: string|null, label: string|null, registered: boolean,
 *   ownerThresholdPct: number, ownerTreatment: string,
 *   bankStatementMonths: number, sowContingencyRequired: boolean, notes: string[]
 * }}
 */
function programGuidelineSnapshot(program, opts = {}) {
  const key = canonProgram(program);
  const label = key ? PROGRAM_KEYS[key] : null;
  const rule = ownerRuleFor(key);                          // {pct, label, treatment} — canonical KYC map
  const months = bankStatementMonths(key, opts.assetMonths); // canonical program month count
  // The 5%-of-construction SOW contingency is required when rehab-budget.sowContingencyRequired is
  // true (Gold OR a Blue Lake note buyer). Prefer the authoritative value the caller resolved;
  // absent it, fall back to the program arm (Gold) — the note-buyer arm is still enforced
  // independently by the SOW gate, this only affects what the snapshot DISPLAYS.
  // ONLY a strict boolean overrides the default: rehab-budget.sowContingencyRequired returns an
  // OBJECT { required, ... }, so a caller that forgets to read `.required` and passes the whole
  // object must NOT force this true (a truthy object would) — a non-boolean falls back to the
  // program arm. Belt-and-suspenders with the route reading `.required`.
  const sowContingencyRequired = typeof opts.sowContingencyRequired === 'boolean'
    ? opts.sowContingencyRequired : (key === 'gold');

  const notes = [];
  if (key) {
    notes.push(`Beneficial owners of ${rule.pct}% or more must be ${rule.treatment}.`);
    notes.push(`Requires ${months} month${months === 1 ? '' : 's'} of bank statements (proof of funds).`);
  } else {
    notes.push('No product registered yet — underwritten to the baseline until a program is registered.');
    notes.push(`Beneficial owners of ${rule.pct}% or more must be identified (KYC baseline).`);
  }
  // The SOW contingency note is about the loan's SOW requirement, not the program registration, so
  // it shows whenever the requirement is on (a Blue Lake Standard file included). 5% is sourced from
  // rehab-budget's canonical SOW_CONTINGENCY_PCT — never a second hardcoded copy of that number.
  if (sowContingencyRequired) {
    notes.push(`Scope of Work must carry at least a ${SOW_CONTINGENCY_PCT}% construction contingency.`);
  }

  return {
    program: key,
    label,
    registered: !!key,
    ownerThresholdPct: rule.pct,
    ownerTreatment: rule.treatment,
    bankStatementMonths: months,
    sowContingencyRequired,
    notes,
  };
}

module.exports = { programGuidelineSnapshot, canonProgram, _internals: { PROGRAM_KEYS } };
