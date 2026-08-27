'use strict';
/**
 * LONG-TERM — the WHITE-LABEL PROGRAM NAMES for the Pricing Engine's investors
 * (owner-directed 2026-08-27).
 *
 * THE OWNER'S RULE, in his own words: *"Every investor gets a name. On our
 * checklist, on our dropdown, it is going to have the investor's name -
 * white-labeled name, but on the consumer side we're going to build it. You
 * should remember never to display the investor's name. You are only going to
 * display the white-label name."* And on multiple programs: *"certain investors
 * have more than one program … usually display it as -1-2 for different
 * programs. We should be able to check in the back which program each of them
 * is in, so we can know what was priced."*
 *
 * WHAT THIS MODULE IS. One table — canonical investor key → white-label name —
 * plus the resolution and decoration around it. It is deliberately keyed on the
 * CANONICAL keys of `src/longterm/encompass/investors.js`, the one investor
 * identity in this codebase (151 recorded spellings resolve to ~40 companies
 * there): a second identity table here would drift from the first, and the one
 * that drifts is the one that leaks. Every spelling Lender Price uses was
 * captured by running scenarios against the LIVE system on 2026-08-27 and is
 * recorded as an alias THERE, which also puts each name under the
 * never-reaches-a-client scrub (`audience.js`) automatically.
 *
 * WHAT A WHITE-LABEL NAME IS FOR. The Pricing Engine itself is STAFF-ONLY and
 * stays so — staff see the real names, with the white-label name BESIDE them.
 * The white-label name is the consumer-safe identity for the borrower-facing
 * build the owner has planned; it is defined here, now, so every surface reads
 * ONE sheet and so the pure test can PROVE each name passes the audience scrub
 * untouched (a white-label name the scrubber would redact is a broken name).
 *
 * FAIL CLOSED. An investor with no white-label name has NO consumer label —
 * `null`, never the investor's own name and never a guess. Amwest, for
 * instance, quotes in Lender Price today and is not on the owner's sheet: it is
 * reported as UNMAPPED so the owner can name it, and until then a consumer
 * surface has nothing it may print for it.
 *
 * THE -N SUFFIX IS DETERMINISTIC WITHIN AN ANSWER, and which real program each
 * consumer label means is always carried BESIDE it, never inferred: the
 * vendor's own program names under one investor are sorted and numbered, so
 * "Pearl-2" on one board is the same real program everywhere ON THAT BOARD, and
 * the mapping rides the response ("check in the back which program each of
 * them is in"). A single-program investor is the bare name — "Pearl", no
 * suffix. A GLOBAL numbering would be a hand-kept list that rots the day the
 * vendor renames a program, which is exactly what rule-4 forbids.
 *
 * PURE: no database, no network. `decorate` reads a parsed Lender Price answer
 * and returns a new annotated copy — it never mutates the parse.
 */

const investors = require('../encompass/investors');

// ── The owner's white-label sheet, 2026-08-27, verbatim ──────────────────────
// Keyed on the canonical registry key; the comment names the investor as the
// owner wrote it, so the sheet can be checked line by line against the message.
const PROGRAM_NAMES = {
  eresi: 'Platinum',              // Eresi
  a_and_d: 'Emerald',             // A&D mortgage
  champions: 'Crown',             // Champions
  loan_store: 'Topaz',            // The Loan Store
  newrez: 'Onyx',                 // NewRez
  deephaven: 'Diamond',           // Deephaven
  verus: 'Pearl',                 // Verus
  phh: 'Opal',                    // Onity / phh
  american_heritage: 'Liberty',   // American Heritage lending
  oaktree: 'Sapphire',            // Oak Tree Funding
  nqm: 'Ruby',                    // NQM Funding
  corrfirst: 'Prime',             // CorrFirst
  acra: 'Amber',                  // Acra Lending
  lakeview: 'Bluewater',          // Lakeview / Bayview
  onslow_bay: 'Harbor',           // Annaly / onslow bay
  amerihome: 'Granite',           // AmeriHome
  loanstream: 'Silver',           // LoanStream
  foundation: 'Stone',            // Foundation Mortgage
  arc_home: 'Quartz',             // Arc Home LLC
  pennymac: 'Gold',               // Pennymac
  ellington: 'Eclipse',           // Ellington
  redwood_trust: 'Sequoia',       // Redwood Trust
  sgcg: 'Sterling',               // SGCG
  adams_nymt: 'Empire',           // adams NYMT
};

/** The white-label name for a canonical key, or null. Never a guess. */
function whiteLabelOf(key) {
  return Object.prototype.hasOwnProperty.call(PROGRAM_NAMES, String(key))
    ? PROGRAM_NAMES[String(key)] : null;
}

/**
 * Which canonical investor a Lender Price row belongs to.
 *
 * The vendor carries TWO name fields — the LENDER ("Onslow") and the INVESTOR
 * ("Onslow Bay Financial LLC") — and either can be the recognisable one, so
 * both are asked, investor first (it is the fuller name). Unresolved is
 * `key: null`, and the caller must not guess.
 */
function resolveRow(row) {
  const r = row || {};
  for (const raw of [r.investor, r.lender]) {
    if (raw == null || String(raw).trim() === '') continue;
    const hit = investors.resolve(raw);
    if (hit.key) return { key: hit.key, label: hit.label, match: hit.match };
  }
  return { key: null, label: null, match: 'none' };
}

/**
 * The FULL white-label roster — every investor on the owner's sheet, whether or
 * not it is quoting in Lender Price today. This is what the pre-search dropdown
 * offers: the owner's rule is that an investor not yet live ("CorrFirst is not
 * available yet in Lender Price") is still on the list, so it is simply there
 * the day it comes online. There is deliberately NO hand-kept live/coming-soon
 * flag — which investors actually populated is a fact about EACH ANSWER, and
 * the post-results roster reports it per answer instead.
 *
 * Sorted by white-label name, because that is the consumer-friendly identity
 * the dropdown leads with.
 */
function fullRoster() {
  return Object.entries(PROGRAM_NAMES)
    .map(([key, whiteLabel]) => {
      const inv = investors.byKey(key);
      return { key, whiteLabel, investorLabel: (inv && inv.label) || key };
    })
    .sort((a, b) => a.whiteLabel.localeCompare(b.whiteLabel));
}

/**
 * Annotate a parsed Lender Price answer's programs with the investor identity
 * and the white-label + consumer program labels, and report the roster of
 * investors PRESENT in this answer.
 *
 * Returns `{ programs, roster, unmapped }`:
 *   programs — a new array; each entry is the original program plus
 *              `investorKey` (canonical key or null), `whiteLabel` (or null)
 *              and `consumerLabel` ("Pearl" / "Pearl-2" / null — null whenever
 *              there is no white-label name, NEVER the investor's own name).
 *   roster   — [{ key, whiteLabel, investorLabel, programCount,
 *                 programs: [{ consumerLabel, program }] }] for every MAPPED
 *              investor present, sorted by whiteLabel. `programs` is the
 *              back-office answer to "which real program is Pearl-2?".
 *   unmapped — [{ lender, investor, key }] — rows that resolved to no
 *              white-label name (a resolved investor missing from the owner's
 *              sheet, like Amwest, or a name the registry does not know). Named
 *              so nothing is silently dropped and the owner can name them.
 *
 * Never throws; a non-array yields empty everything.
 */
function decorate(programs) {
  const list = Array.isArray(programs) ? programs : [];
  const annotated = list.map((p) => {
    const { key } = resolveRow(p);
    return { ...p, investorKey: key, whiteLabel: whiteLabelOf(key), consumerLabel: null };
  });

  // Distinct real program names per mapped investor, sorted, numbered.
  const byKey = new Map();
  for (const p of annotated) {
    if (!p.investorKey || !p.whiteLabel) continue;
    if (!byKey.has(p.investorKey)) byKey.set(p.investorKey, new Set());
    byKey.get(p.investorKey).add(String(p.program || ''));
  }
  const labelOf = new Map(); // `${key} ${program}` -> consumerLabel
  for (const [key, names] of byKey) {
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    sorted.forEach((name, i) => {
      labelOf.set(`${key} ${name}`,
        sorted.length > 1 ? `${whiteLabelOf(key)}-${i + 1}` : whiteLabelOf(key));
    });
  }
  for (const p of annotated) {
    if (!p.investorKey || !p.whiteLabel) continue;
    p.consumerLabel = labelOf.get(`${p.investorKey} ${String(p.program || '')}`) || p.whiteLabel;
  }

  const roster = [...byKey.keys()].map((key) => {
    const inv = investors.byKey(key);
    const names = [...byKey.get(key)].sort((a, b) => a.localeCompare(b));
    return {
      key,
      whiteLabel: whiteLabelOf(key),
      investorLabel: (inv && inv.label) || key,
      programCount: names.length,
      programs: names.map((name) => ({
        consumerLabel: labelOf.get(`${key} ${name}`) || whiteLabelOf(key),
        program: name,
      })),
    };
  }).sort((a, b) => a.whiteLabel.localeCompare(b.whiteLabel));

  // Every distinct unmapped identity, once, with what we know about it.
  const unseen = new Map();
  for (const p of annotated) {
    if (p.whiteLabel) continue;
    const k = `${p.lender || ''} ${p.investor || ''}`;
    if (!unseen.has(k)) unseen.set(k, { lender: p.lender || null, investor: p.investor || null, key: p.investorKey });
  }

  return { programs: annotated, roster, unmapped: [...unseen.values()] };
}

/**
 * Annotate the INELIGIBLE side's lender groups the same way, so the one
 * investor filter can drive both boards. Returns a NEW array; each group gains
 * `investorKey` and `whiteLabel`. Never throws.
 */
function decorateDisqualifiedLenders(lenders) {
  const list = Array.isArray(lenders) ? lenders : [];
  return list.map((g) => {
    const { key } = resolveRow(g);
    return { ...g, investorKey: key, whiteLabel: whiteLabelOf(key) };
  });
}

module.exports = {
  PROGRAM_NAMES, whiteLabelOf, resolveRow, fullRoster, decorate, decorateDisqualifiedLenders,
};
