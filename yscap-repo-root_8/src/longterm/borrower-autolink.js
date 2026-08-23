'use strict';
/**
 * BORROWER AUTO-LINK — the obvious matches confirm themselves.
 *
 * Owner-directed 2026-08-23: *"If it's just a difference between last name and
 * first name or a middle name difference, this should automatically link ... You
 * can also use the borrower's email address to help link."* The admin screen was
 * asking a human to press Confirm four hundred times on rows where the email
 * already matched exactly one profile and the name was the same person spelled
 * the way Encompass spells people ("Bluming, Yisroel" / "Yisroel Bluming").
 *
 * WHAT QUALIFIES, and nothing else does:
 *   · the email matched EXACTLY ONE profile (the matcher already refused
 *     placeholders, shared mailboxes and multi-profile addresses), AND
 *   · `nameLooksLike` says the two names are the same person — order-blind,
 *     middle-name-tolerant, punctuation-stripped. That function IS the owner's
 *     rule, verbatim, and it is shared with the screen so the two can never
 *     disagree about what "obviously the same" means.
 *
 * Everything else stays a SUGGESTION for a human: same email but a genuinely
 *   different name, two names on one address, two profiles on one address, a
 *   placeholder mailbox. And a decision a human already made — confirmed OR
 *   rejected — is never touched: the matcher excludes decided addresses before
 *   this pass ever sees them.
 *
 * EVERY confirmation goes through `confirmLink` — the same door the admin's
 * button uses — so every guard in it re-runs here (the multi-name 409 included)
 * and the trail records the method as 'auto': an auto-link is distinguishable
 * from a human's forever, and `unlink` undoes it the ordinary way.
 */

const db = require('./db');
const borrowerMatch = require('./borrower-match');
const borrowerLinks = require('./borrower-links');
const settingsStore = require('./settings/store');

/** Same OFF grammar as every other long-term switch. */
function enabled() {
  const raw = String(process.env.LT_BORROWER_AUTOLINK_ENABLED == null ? '' : process.env.LT_BORROWER_AUTOLINK_ENABLED).trim();
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}

/** One pass. Returns the run-log shape. Never throws for a per-row refusal. */
async function autoLinkPass(deps = {}) {
  if (!enabled()) return { ok: true, reason: 'auto-linking is switched off (LT_BORROWER_AUTOLINK_ENABLED=0)', discovered: 0, read: 0 };
  const dbc = deps.db || db;
  const links = deps.links || borrowerLinks;
  const match = deps.match || borrowerMatch;
  const loadSettings = deps.loadSettings || (async () => (await settingsStore.load().catch(() => ({ settings: {} }))).settings);

  const settings = await loadSettings();
  const { rows: loans } = await dbc.query(
    `SELECT id, loan_number, borrower_email, borrower_name, borrower_id
       FROM lt_loans`);
  const emails = [...new Set(loans.map((l) => l.borrower_email).filter(Boolean))];
  const { rows: profiles } = emails.length
    ? await dbc.query(
      `SELECT id, email, NULLIF(full_name, '') AS full_name
         FROM borrowers WHERE lower(email) = ANY($1::text[])`, [emails])
    : { rows: [] };
  const existing = await links.loadLinks();
  const out = match.matchBorrowers(loans, profiles, { existing, settings });

  // THE LINE THAT IS THE WHOLE FEATURE: only a suggestion whose name test passed.
  const eligible = (out.suggestions || []).filter((s) => s.nameAgrees === true);
  const heldForHuman = (out.suggestions || []).length - eligible.length;

  let confirmed = 0; let refused = 0;
  const problems = [];
  for (const s of eligible) {
    /* eslint-disable no-await-in-loop */ // serial writes, each tiny
    try {
      await links.confirmLink(s.email, s.borrowerId, null, { method: 'auto', settings });
      confirmed += 1;
    } catch (e) {
      // A refusal from the door's own guards is an ANSWER (the multi-name 409
      // among them) — counted and carried, never a crash and never retried into.
      refused += 1;
      problems.push({ email: s.email, reason: String((e && e.message) || e).slice(0, 200) });
    }
  }
  return {
    ok: true,
    discovered: (out.suggestions || []).length,
    read: confirmed,
    failed: refused,
    skipped: heldForHuman,
    problems: problems.slice(0, 20),
  };
}

module.exports = { enabled, autoLinkPass };
