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
 *
 * ── THE INVESTORS ADDED BY HAND (2026-09-02) ────────────────────────────────
 * A super admin can add an investor the registry does not carry, with a white
 * label of its own (`pricing.customInvestors`). Every function here takes that
 * map as an OPTIONAL trailing argument and reads identity through the one
 * effective roster (`pricing/investor-roster.js`): `whiteLabelOf(key, custom)`
 * answers the hand-added name for a custom key and the owner's sheet for a
 * registry one, and `effectiveWhiteLabel` lays the per-investor SETTING over
 * both — the single definition of "what may a client call this investor",
 * which the settings row, the merge, the saved groups and the roster door all
 * read. Called without the map, every function answers exactly as it did.
 */

const investors = require('../encompass/investors');
const roster = require('../pricing/investor-roster');

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
  // Added 2026-09-02 from the owner's updated sheet. ClearEdge was only ever a
  // hand-added investor before this; Button Finance has been in the registry all
  // along and stays PRE-FILLED OFF (owner-directed 2026-08-30) — a white-label
  // name is the label a row would carry IF it were shown, never a decision to
  // show it. Turning it on is still the enabled flag, and still the owner's call.
  clearedge: 'Crystal',           // ClearEdge Lending
  button_finance: 'Jade',         // Button Finance
};

/**
 * The RECORDED white-label name for a canonical key, or null. Never a guess.
 *
 * A registry key answers from the owner's sheet; a hand-added key answers the
 * name the person who added it typed (validated at the door to be consumer-safe
 * exactly as the sheet's names are). `custom` may be omitted, in which case
 * only the sheet is consulted — every caller that predates custom investors
 * behaves as it did.
 */
function whiteLabelOf(key, custom) {
  const k = String(key);
  if (custom !== undefined && custom !== null) {
    const inv = roster.effectiveByKey(k, custom);
    if (inv && inv.custom) return inv.whiteLabel || null;
  }
  return Object.prototype.hasOwnProperty.call(PROGRAM_NAMES, k) ? PROGRAM_NAMES[k] : null;
}

/**
 * THE ONE ANSWER TO "WHAT MAY A CLIENT CALL THIS INVESTOR": the per-investor
 * setting a person typed on the combined settings screen, else the recorded
 * name (`whiteLabelOf`), else null. `settings` is the READ map from
 * `investor-settings.readSettings` — a value that passed the settings door —
 * never the raw store. Read here by the settings row, the saved investor groups
 * and the roster door, so a name typed in settings for an investor with no
 * sheet entry (Button Finance, or one added by hand with no white label) is
 * honoured everywhere or nowhere, never dropped by one reader that only knew
 * the sheet.
 */
function effectiveWhiteLabel(key, custom, settings) {
  const saved = settings && settings[String(key)] ? settings[String(key)].whiteLabel : null;
  const wl = saved == null ? '' : String(saved).trim();
  return wl || whiteLabelOf(key, custom);
}

/**
 * Which canonical investor a Lender Price row belongs to.
 *
 * The vendor carries TWO name fields — the LENDER ("Onslow") and the INVESTOR
 * ("Onslow Bay Financial LLC") — and either can be the recognisable one, so
 * both are asked, investor first (it is the fuller name). Unresolved is
 * `key: null`, and the caller must not guess. Identity comes from the effective
 * roster, so a hand-added investor resolves here like a registry one.
 */
function resolveRow(row, custom) {
  const r = row || {};
  for (const raw of [r.investor, r.lender]) {
    if (raw == null || String(raw).trim() === '') continue;
    const hit = roster.effectiveResolve(raw, custom);
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
 *
 * With `custom` and `settings` handed in it is the roster of EVERY investor a
 * client may be shown — the sheet, the investors added by hand that carry a
 * white label, and any investor a person named on the settings screen — through
 * `effectiveWhiteLabel`, so this list and the settings rows can never disagree
 * about who has a client-safe name. Called bare, it is the sheet alone.
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
function decorate(programs, custom) {
  const list = Array.isArray(programs) ? programs : [];
  const annotated = list.map((p) => {
    const { key } = resolveRow(p, custom);
    return { ...p, investorKey: key, whiteLabel: whiteLabelOf(key, custom), consumerLabel: null };
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
        sorted.length > 1 ? `${whiteLabelOf(key, custom)}-${i + 1}` : whiteLabelOf(key, custom));
    });
  }
  for (const p of annotated) {
    if (!p.investorKey || !p.whiteLabel) continue;
    p.consumerLabel = labelOf.get(`${p.investorKey} ${String(p.program || '')}`) || p.whiteLabel;
  }

  const present = [...byKey.keys()].map((key) => {
    const inv = roster.effectiveByKey(key, custom);
    const names = [...byKey.get(key)].sort((a, b) => a.localeCompare(b));
    return {
      key,
      whiteLabel: whiteLabelOf(key, custom),
      investorLabel: (inv && inv.label) || key,
      programCount: names.length,
      programs: names.map((name) => ({
        consumerLabel: labelOf.get(`${key} ${name}`) || whiteLabelOf(key, custom),
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

  return { programs: annotated, roster: present, unmapped: [...unseen.values()] };
}

/**
 * Annotate the INELIGIBLE side's lender groups the same way, so the one
 * investor filter can drive both boards. Returns a NEW array; each group gains
 * `investorKey` and `whiteLabel`. Never throws.
 */
function decorateDisqualifiedLenders(lenders, custom) {
  const list = Array.isArray(lenders) ? lenders : [];
  return list.map((g) => {
    const { key } = resolveRow(g, custom);
    return { ...g, investorKey: key, whiteLabel: whiteLabelOf(key, custom) };
  });
}

module.exports = {
  PROGRAM_NAMES, whiteLabelOf, effectiveWhiteLabel, resolveRow, fullRoster, decorate, decorateDisqualifiedLenders,
};
