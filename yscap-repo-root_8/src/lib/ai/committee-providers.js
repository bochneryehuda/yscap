'use strict';
/**
 * #215 — committee PROVIDER assignment (real multi-model independence).
 *
 * The review committee is only genuinely independent if its specialists don't all
 * run on the SAME model. This module decides which provider each specialist uses:
 *   • Primary provider: Azure OpenAI (always available when the AI stack is on).
 *   • Second provider: Anthropic Claude, used only when ANTHROPIC_API_KEY is set.
 *
 * When NO second provider is configured (today's default), every specialist is
 * assigned the primary — so the committee is byte-identical to before this change.
 * When a second provider IS available, roughly half the panel is routed to it
 * (deterministic by index) so a finding is verified by two independent models.
 *
 * PURE assignment core (testable with no keys). The client resolver lazy-requires
 * the provider modules so this stays unit-testable.
 */

const PRIMARY = 'azure_openai';
const SECOND = 'anthropic';

/**
 * assignProviders(keys, { secondAvailable }) → { key: providerName }  (PURE, NEVER THROWS)
 * Deterministic: with a second provider, odd-indexed specialists go to it, so the
 * panel is a stable mix of both models; without one, all go to the primary.
 */
function assignProviders(keys, opts = {}) {
  const out = {};
  try {
    const list = Array.isArray(keys) ? keys : [];
    const secondAvailable = !!(opts && opts.secondAvailable);
    list.forEach((k, i) => {
      out[k] = secondAvailable && (i % 2 === 1) ? SECOND : PRIMARY;
    });
  } catch (_e) { /* fall through — empty map */ }
  return out;
}

// Lazy client resolver — returns the provider module (each exposes available()+complete()).
function clientFor(name) {
  if (name === SECOND) return require('./anthropic');
  return require('./azure-openai');
}

// Is the second (independent) provider live right now?
function secondAvailable() {
  try { return require('./anthropic').available(); } catch (_e) { return false; }
}

// Resolve real per-key assignments using live availability (thin wrapper over the pure core).
function resolveAssignments(keys) {
  return assignProviders(keys, { secondAvailable: secondAvailable() });
}

module.exports = { PRIMARY, SECOND, assignProviders, clientFor, secondAvailable, resolveAssignments };
