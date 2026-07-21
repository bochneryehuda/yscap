'use strict';
/**
 * Draw money model — retainage/holdback + lien-waiver release gating (research doc §19).
 * PURE, integer cents, never-guessed. Retainage is a fixed % held from each approved draw until
 * completion; the lien-waiver gate refuses to release a draw while a REQUIRED waiver is still
 * outstanding (the #1 real-world cause of draw delays). Both are OFF by default (0% / gate off).
 */

const N = (x) => Number(x || 0) || 0;

/**
 * Split an approved draw into fee, retainage held, and the borrower's net release.
 *   net_release = approved − fee − retainage_held ;  retainage_held = round(approved × pct/100)
 * Guards: amounts are non-negative integer cents; pct clamped to [0,100]; a fee that would drive
 * the net negative is reported (never silently). Returns the breakdown + any violation.
 */
function computeRelease({ approvedCents, feeCents = 0, retainagePct = 0 } = {}) {
  const approved = Math.max(0, Math.round(N(approvedCents)));
  const fee = Math.max(0, Math.round(N(feeCents)));
  const pct = Math.min(100, Math.max(0, N(retainagePct)));
  const retainage_held_cents = Math.round(approved * (pct / 100));
  const net_release_cents = approved - fee - retainage_held_cents;
  return {
    gross_cents: approved,
    fee_cents: fee,
    retainage_pct: pct,
    retainage_held_cents,
    net_release_cents,
    ok: net_release_cents >= 0,
    violation: net_release_cents < 0 ? `fee ${usd(fee)} + retainage ${usd(retainage_held_cents)} exceed the ${usd(approved)} approved — net release would be negative` : null,
  };
}

const usd = (c) => '$' + (N(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Lien-waiver release gate. When gating is ON, a draw may only be RELEASED once every waiver
 * marked 'required' for it is 'received' or 'waived'. Returns { ok, missing:[…] }. Never guesses —
 * a waiver with no explicit received/waived status blocks the release and is named.
 *   waivers: [{ status, tier, party_name, kind }]
 */
function waiverGate(waivers, { enabled = false } = {}) {
  if (!enabled) return { ok: true, missing: [] };
  // Block on any waiver that is NOT explicitly satisfied. "Satisfied" = received / waived / na ONLY —
  // a null / blank / 'required' / unknown status BLOCKS (never guess a waiver is fine just because its
  // status is missing). Previously only 'required' blocked, so a stray null/unknown status would have
  // slipped a release through; this closes that.
  const SATISFIED = new Set(['received', 'waived', 'na']);
  const missing = (waivers || []).filter((w) => !SATISFIED.has(w && w.status))
    .map((w) => `${w.tier || 'party'}${w.party_name ? ' ' + w.party_name : ''} (${w.kind || 'conditional'})`);
  return { ok: missing.length === 0, missing };
}

// Resolve the corrected APPROVED amount (cents) when staff decide a disputed draw line (owner-directed
// 2026-07-21). On approve, staff may type an EXACT negotiated figure; if they don't, the borrower's requested
// amount is used. The result can NEVER exceed what the borrower requested for that line, and never go negative.
// Returns null on a plain reject / an approve with no typed or desired amount (leave the line's amount as-is).
function disputeApprovedCents({ decision, requestedCents, typedCents, desiredCents } = {}) {
  if (decision !== 'approved') return null;
  const req = Math.max(0, Math.round(N(requestedCents)));
  const hasTyped = typedCents != null && typedCents !== '' && Number.isFinite(Number(typedCents));
  if (hasTyped) {
    const v = Math.max(0, Math.round(Number(typedCents)));
    return req > 0 ? Math.min(v, req) : v; // never approve more than requested
  }
  if (desiredCents != null && Number.isFinite(Number(desiredCents))) {
    const d = Math.max(0, Math.round(Number(desiredCents)));
    return req > 0 ? Math.min(d, req) : d;
  }
  return null;
}

module.exports = { computeRelease, waiverGate, disputeApprovedCents };
