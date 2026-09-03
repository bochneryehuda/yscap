'use strict';
/**
 * LONG-TERM — "THESE TWO NAMES ARE THE SAME INVESTOR", said by a person.
 *
 * Owner-directed 2026-08-30: *"we need to be able to link a investor from lender
 * price and loannex by if the name is a little different the system should still
 * understand that it's the same investor… Those investors are spelled
 * differently and have different names, but we need to be able to link it and
 * say, 'This investor and this investor are the same.' Now we want to follow
 * settings where we can choose where we want to take the information of this
 * investor."*
 *
 * ── WHAT WAS ACTUALLY BROKEN ────────────────────────────────────────────────
 * Identity was decided by a HAND-MAINTAINED CODE REGISTRY (`encompass/investors.js`,
 * 42 companies and ~150 recorded spellings) and by nothing else. Measured by the
 * combined audit on 2026-08-30:
 *
 *   • A spelling the registry does not carry resolves to NOTHING, and
 *     `merge.js` SKIPS a row it cannot name — so that investor's whole board
 *     disappears and the only fix is a code change. Three of seven realistic
 *     probes were dropped that way, including **"A & D Mortgage - Delegated"**,
 *     a second channel of an investor already on the board.
 *   • Four of the nine live LoanNEX names join by the registry's LAST-RESORT
 *     PREFIX HEURISTIC rather than by a recorded fact — right today, and nothing
 *     on any screen says it was a guess.
 *
 * ── THE SHAPE, AND WHY ──────────────────────────────────────────────────────
 * This is an OVERLAY on the one resolver, never a second one. `resolveWithLinks`
 * asks the human's map first and the code registry second, and both answers come
 * back through the SAME `{ key, label, match }` shape every caller already reads.
 * There is no second definition of "who is this investor" to drift.
 *
 * FIVE RULES THIS MODULE EXISTS TO HOLD:
 *
 *  1. **A PERSON'S DECISION BEATS A GUESS.** A stored link wins over every
 *     registry match including `exact` — the registry is a list somebody
 *     maintained once; the link is somebody looking at this board today.
 *
 *  2. **A LINK MAY ONLY POINT AT AN INVESTOR THAT EXISTS.** Everything
 *     downstream — the client-safe white label, the audience block, the routing
 *     — is keyed on the canonical investor. A link to an unknown key is REFUSED
 *     with a reason rather than stored and silently ignored, which would look
 *     like it had worked.
 *
 *  3. **A SUGGESTION IS NEVER APPLIED.** `suggestFor` proposes; only a person
 *     links. This is the `borrower_profile_links` discipline: an over-eager
 *     automatic join puts one investor's pricing under another's name, and the
 *     name is the thing a client may see.
 *
 *  4. **HOW IT MATCHED TRAVELS WITH THE ANSWER.** `match` distinguishes a
 *     person's `link` from the registry's `exact` / `normal` / `prefix`, so a
 *     screen can say "this one we guessed — confirm it" instead of presenting
 *     every join as equally settled.
 *
 *  5. **IT NEVER THROWS AND NEVER WIDENS.** An unreadable map behaves as no map,
 *     which is exactly today's behaviour — so a broken setting can only ever
 *     cost the links, never the board.
 *
 * PURE — no database, no network, no config. The stored map is passed in.
 *
 * ── THE INVESTORS ADDED BY HAND (2026-09-02) ────────────────────────────────
 * "An investor that exists" now means the EFFECTIVE roster — the registry plus
 * the investors a super admin added on the settings screen
 * (`pricing/investor-roster.js`). Every reader here takes that map as an
 * OPTIONAL trailing argument and stays pure; a link may point at a hand-added
 * investor exactly as it may point at a registry one, and the pick-list a
 * screen draws is the effective list. Called without the map, every function
 * answers exactly as it did.
 *
 * SEPARATION: LT-only.
 */

const investors = require('../encompass/investors');
const effective = require('./investor-roster');

/** The settings key the stored map lives under. One name, used by every caller. */
const SETTING_KEY = 'pricing.investorLinks';

/** Which vendors a link may be recorded against. */
const SOURCES = ['lenderprice', 'loannex'];

/**
 * The lookup form of a typed name.
 *
 * DELIBERATELY the registry's OWN normalizer, not a second one: two spellings
 * that the registry already considers one string must not become two different
 * link entries, or a person would link a name and watch a near-identical
 * spelling still fall through.
 */
function linkKeyOf(name) {
  const raw = name == null ? '' : String(name).trim();
  if (!raw) return null;
  // ⛔ THE REGISTRY'S OWN `normalize`, called DIRECTLY. An earlier cut reached for
  // it under `_internals` and fell through to a private fallback when it was not
  // there — which is precisely the second normalizer this comment forbids, and it
  // silently made "Acra Lending" and "Acra Lending LLC" two different link
  // entries. Caught by KEY-2. There is no fallback now: if the registry ever
  // stops exporting it, this must fail loudly rather than quietly disagree.
  const n = investors.normalize(raw);
  return n || null;
}

/**
 * Read a stored map into the form the resolver uses, dropping anything unusable.
 *
 * NEVER THROWS. A map that cannot be read at all yields an empty one, which is
 * today's behaviour — a broken setting costs the links, never the board.
 */
function readLinks(raw, custom) {
  const out = new Map();
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { links: out, problems };
  for (const [name, value] of Object.entries(raw)) {
    const k = linkKeyOf(name);
    if (!k) { problems.push({ name, problem: 'unreadable_name' }); continue; }
    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : { key: value };
    const key = entry.key == null ? '' : String(entry.key).trim();
    if (!key) { problems.push({ name, problem: 'no_investor' }); continue; }
    // RULE 2 — a link may only point at an investor that exists: in the
    // registry, or among the investors somebody added by hand.
    if (!effective.effectiveByKey(key, custom)) { problems.push({ name, key, problem: 'unknown_investor' }); continue; }
    out.set(k, {
      key,
      // Kept for the screen so a person can see what they typed, not the
      // normalized form the lookup uses.
      name: String(name),
      source: SOURCES.includes(entry.source) ? entry.source : null,
      linkedBy: entry.linkedBy == null ? null : String(entry.linkedBy),
      linkedAt: entry.linkedAt == null ? null : String(entry.linkedAt),
    });
  }
  return { links: out, problems };
}

/**
 * Who this name is — the human's map first, the code registry second.
 *
 * The returned shape is byte-compatible with `investors.resolve`, plus `linked`
 * so a caller can tell a decision from a lookup without parsing `match`.
 */
function resolveWithLinks(name, links, custom) {
  const raw = name == null ? null : String(name);
  const map = links instanceof Map ? links : (readLinks(links, custom).links);
  const k = linkKeyOf(raw);
  if (k && map.has(k)) {
    const hit = map.get(k);
    const inv = effective.effectiveByKey(hit.key, custom);
    // RULE 1 — a person's decision beats every registry match, `exact` included.
    if (inv) return { raw, key: inv.key, label: inv.label, match: 'link', linked: true, custom: !!inv.custom };
  }
  const r = effective.effectiveResolve(raw, custom);
  return { raw, key: r.key, label: r.label, match: r.match, linked: false, custom: !!r.custom };
}

/**
 * A join that was GUESSED rather than recorded.
 *
 * `prefix` is the registry's own documented last resort ("a recorded key that is
 * a clean prefix/extension of this token"). It is usually right and it is still
 * a guess, so a screen that shows every join as settled is over-claiming.
 */
function isGuess(match) { return match === 'prefix'; }

/**
 * The letters of a name, and nothing else.
 *
 * ⛔ DELIBERATELY NOT the registry's normalizer, and this is the one place the two
 * jobs genuinely differ. LOOKUP must use the registry's form or a link would mean
 * one thing here and another there — that drift is a real bug this module already
 * shipped once. SUGGESTING is the opposite problem: the registry strips the very
 * words that carry the resemblance ("mortgage", "funding", "capital", "lending"),
 * so "A & D Mortgage - Delegated" collapses to `addelegated` and "A&D Mortgage
 * LLC" to `ad`, and nothing looks like anything. A proposal is allowed to look at
 * more than the lookup does; it cannot act on what it sees.
 */
function letterFormOf(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** How many leading characters two strings share. */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Investors this name might mean, best first — a PROPOSAL, never applied.
 *
 * Two readings, because one is not enough: the registry's own normalized form
 * catches "the same company said two ways", and the raw letters catch "these
 * start with the same words", which is what a second channel or a renamed
 * division actually looks like.
 *
 * Nothing here mutates anything, and an EMPTY LIST IS A GOOD ANSWER — refusing to
 * guess is the point. The thresholds below exist to keep it that way: a shared
 * opening of fewer than four characters is a coincidence, not a resemblance.
 */
const MIN_SHARED = 4;      // "cha" of Champions and Change is not a resemblance
const MIN_RATIO = 0.4;     // …and neither is a long name sharing a short opening

function suggestFor(name, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 5;
  const n = linkKeyOf(name);
  const letters = letterFormOf(name);
  if (!n && !letters) return [];
  const scored = [];
  // `opts.custom` — the hand-added investors are proposed like any other.
  for (const inv of effective.effectiveList(opts.custom)) {
    const forms = [inv.label, ...(inv.aliases || [])];
    let best = 0;
    let why = null;
    for (const f of forms) {
      const fn = linkKeyOf(f);
      const fl = letterFormOf(f);
      if (fn && n && fn === n) { best = 100; why = 'the same name once punctuation and company words are set aside'; break; }
      if (!fl || !letters) continue;
      const shared = commonPrefix(letters, fl);
      const ratio = shared / Math.min(letters.length, fl.length);
      if (shared >= MIN_SHARED && ratio >= MIN_RATIO) {
        const score = Math.min(95, 45 + Math.round(ratio * 50));
        if (score > best) { best = score; why = 'both names begin the same way'; }
      } else if (fl.length >= 5 && letters.length >= 5 && (letters.includes(fl) || fl.includes(letters))) {
        const score = 40 + Math.round((Math.min(fl.length, letters.length) / Math.max(fl.length, letters.length)) * 20);
        if (score > best) { best = score; why = 'one name contains the other'; }
      }
    }
    if (best > 0) scored.push({ key: inv.key, label: inv.label, score: best, why });
  }
  scored.sort((a, b) => b.score - a.score || String(a.label).localeCompare(String(b.label)));
  return scored.slice(0, limit);
}

/**
 * Check a whole map before it is saved. Returns the CLEAN map and every problem.
 *
 * REFUSES RATHER THAN REPAIRS: a link the caller meant is not something to
 * quietly drop half of, so the route answers 422 with the list and the person
 * sees exactly which row is wrong.
 */
function validateLinks(raw, custom) {
  if (raw == null) return { ok: true, links: {}, problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, links: null, problems: [{ problem: 'not_a_map', message: 'Send one entry per vendor spelling.' }] };
  }
  const { links, problems } = readLinks(raw, custom);
  const clean = {};
  for (const [, v] of links) {
    clean[v.name] = { key: v.key, source: v.source, linkedBy: v.linkedBy, linkedAt: v.linkedAt };
  }
  const worded = problems.map((p) => ({
    ...p,
    message: p.problem === 'unknown_investor'
      ? `"${p.name}" points at an investor this system does not know (${p.key}) — it is not in the registry and not one added by hand. Pick one from the list, or add the investor first.`
      : p.problem === 'no_investor'
        ? `"${p.name}" has no investor chosen — say which investor it is, or remove the row.`
        : 'That spelling could not be read as a name.',
  }));
  // RULE: refused WHOLE, never half-repaired. Handing back the rows that happened
  // to be readable invites a caller to save them, and a person who was told their
  // map was rejected would find half of it stored anyway.
  return worded.length === 0
    ? { ok: true, links: clean, problems: [] }
    : { ok: false, links: null, problems: worded };
}

/**
 * The side-by-side the settings screen draws: one row per investor, what each
 * program calls them, and how the two were joined.
 *
 * `namesBySource` is what the two boards ACTUALLY returned, so this describes the
 * real answer rather than the registry's idea of it. A spelling that resolves to
 * nothing gets its own row with suggestions attached — that row is the whole
 * point, because today such a name is dropped and nobody can act on it.
 */
/**
 * THE NAMES A BOARD ACTUALLY CARRIED, in the vendor's own spelling — the input `pairing`
 * takes. Lifted here from `combined-pricer.js`, where it was private, so the GENERAL engine
 * can answer the same question without a second copy: two engines each deriving "which names
 * did this sheet return" their own way is how one screen comes to offer a link the other
 * cannot see.
 *
 * The INVESTOR field is preferred over the LENDER field because it is the fuller name
 * (LoanNEX carries both), and that is the spelling a person is being asked to link.
 */
function namesFromBoard(board) {
  const out = [];
  for (const p of (board && board.programs) || []) {
    const n = p.investor || p.lender;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function pairing(namesBySource, links, custom) {
  const map = links instanceof Map ? links : readLinks(links, custom).links;
  const byKey = new Map();
  const unlinked = [];
  for (const source of SOURCES) {
    for (const name of (namesBySource && namesBySource[source]) || []) {
      const r = resolveWithLinks(name, map, custom);
      if (!r.key) {
        unlinked.push({ source, name, suggestions: suggestFor(name, { custom }) });
        continue;
      }
      if (!byKey.has(r.key)) {
        byKey.set(r.key, { key: r.key, investor: r.label, names: { lenderprice: [], loannex: [] } });
      }
      byKey.get(r.key).names[source].push({ name, match: r.match, linked: r.linked, guessed: isGuess(r.match) });
    }
  }
  const rows = [...byKey.values()].map((r) => ({
    ...r,
    // The owner's own question, answered per row: is this investor quoted by
    // both programs, so that "take it from this one" is even a choice?
    inBoth: r.names.lenderprice.length > 0 && r.names.loannex.length > 0,
    // Loud on purpose: a row joined only by the prefix heuristic is asking a
    // person to confirm it, and a screen that does not say so is over-claiming.
    needsConfirming: [...r.names.lenderprice, ...r.names.loannex].some((n) => n.guessed),
  }));
  rows.sort((a, b) => (b.inBoth - a.inBoth)
    || String(a.investor || '').localeCompare(String(b.investor || '')));
  return { rows, unlinked, linkCount: map.size };
}

module.exports = { namesFromBoard,
  SETTING_KEY, SOURCES,
  linkKeyOf, readLinks, resolveWithLinks, isGuess, suggestFor, validateLinks, pairing,
};
