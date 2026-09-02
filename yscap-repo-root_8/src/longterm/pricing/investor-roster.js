'use strict';
/**
 * LONG-TERM — THE EFFECTIVE INVESTOR ROSTER: the code registry PLUS the investors a
 * super admin has added by hand, read as ONE list through ONE resolver.
 *
 * ── THE OWNER'S ASK (2026-09-02) ──────────────────────────────────────────
 * *"for certain new investors, I don't have a way to add it and add a white-label
 * name for it. I have a new investor, ClearEdge Lending, from LoanX, and I don't
 * know how to add it. That's why it doesn't populate."*
 *
 * ── WHAT WAS BROKEN, MEASURED ─────────────────────────────────────────────
 * Every reader of "which investors exist" — the settings roster, the link
 * pick-list, the merge, the routing, the white-label sheet, the audience scrub —
 * read `encompass/investors.js` directly, a hand-maintained CODE registry. An
 * investor the registry did not carry resolved to nothing, `merge.js` kept its
 * rows OFF the priced board (correctly: a name nobody can white-label may never
 * reach a client), the settings door refused a row for it (`unknown_investor`),
 * the links door refused a link to it, and the only fix was a deploy.
 *
 * ── THE SHAPE, AND WHY ────────────────────────────────────────────────────
 * This is an OVERLAY on the one registry, never a second registry. A custom
 * investor lives in the settings store (`pricing.customInvestors`), keyed like a
 * registry investor, with a label, an optional white label and its recorded
 * spellings. `effectiveList` / `effectiveByKey` / `effectiveResolve` answer the
 * three questions every reader asks, over BOTH sources, in the SAME `{ key,
 * label, match }` shape `investors.resolve` already answers in — so nothing
 * downstream learns a second vocabulary.
 *
 * ⛔ THE CUSTOM MAP IS AN ARGUMENT, NEVER A MODULE-LEVEL READ. Every reader in
 * `pricing/` is pure and stays pure: the route loads the map once per request
 * (`roster-context.js`) and hands it down. A module that reached into the store
 * on its own would be a second loader, and the copy that drifted is the one
 * somebody would price a loan on.
 *
 * ⛔ ONE NORMALIZER. Custom aliases resolve through the registry's OWN
 * `normalize` — the same function `investor-links.linkKeyOf` was made to call
 * directly after a private fallback silently made two link entries out of one
 * spelling. There is no second normalizer here.
 *
 * ⛔ A PERSON'S RECORDED SPELLING BEATS A REGISTRY GUESS. Custom aliases are
 * consulted BEFORE the registry, for the reason `investor-links` states for a
 * link: the registry is a list somebody maintained once, and the alias is
 * somebody looking at this vendor's board today. It is safe to do so because a
 * custom alias may never EQUAL a registry spelling (exact or once normalized) —
 * the write door refuses it — so the only registry match it can pre-empt is the
 * last-resort prefix heuristic, which is a guess by the registry's own account.
 *
 * ⛔ THE WHITE LABEL IS CONSUMER-SAFE BY CONSTRUCTION, at the door: it may not
 * equal any recorded investor spelling (registry, sheet or another custom
 * investor) and it must survive the audience scrub UNCHANGED with the very map
 * it is part of applied — the same property `test-lt-investor-programs-pure.js`
 * §F proves for the owner's sheet. A white label the scrubber would redact is a
 * broken name, and it is refused rather than stored.
 *
 * READ tolerantly, WRITE strictly. `readCustom` never throws and drops only what
 * it cannot use, NAMING each drop — a broken setting costs one investor, never
 * the board. `validateCustom` refuses the WHOLE map with every problem named,
 * exactly as the links and settings doors do, so a person fixes the one row that
 * is wrong rather than finding half a map stored.
 *
 * PURE: no network, no database, no RTL import.
 */

const investors = require('../encompass/investors');

/** The settings key the custom map lives under. One name, used by every caller. */
const SETTING_KEY = 'pricing.customInvestors';

/** A key looks like a registry key: lower-case letters, digits, underscores. */
const KEY_RE = /^[a-z0-9_]+$/;
const MAX_KEY = 64;
const MAX_LABEL = 120;
const MAX_WHITE_LABEL = 60;
const MAX_ALIASES = 40;
const MAX_CUSTOM = 200;
/** A one-letter alias would redact a letter out of every client sentence. */
const MIN_ALIAS = 2;

/** A shared, frozen "no custom investors" — so callers may compare identity. */
/**
 * The shared "no custom investors" map, handed out by every path that has none.
 *
 * ⛔ WHAT THIS GUARD IS, EXACTLY — the honest version, after a previous comment
 * here claimed more than the code did. A Map's contents live in an internal slot
 * that no JavaScript can seal: `Object.freeze` does not touch them, and
 * `Map.prototype.set.call(EMPTY, …)` reaches them whatever this file does. What
 * IS prevented is every way a caller would actually do it by accident —
 * `EMPTY.set(…)` throws, and the freeze stops the throwing methods being quietly
 * replaced. It is a guard against a mistake, not a boundary against a determined
 * caller, and `test-lt-custom-investors-pure.js` asserts precisely that much
 * rather than a stronger claim that would rot into a lie.
 */
const EMPTY = new Map();
for (const m of ['set', 'delete', 'clear']) {
  EMPTY[m] = () => { throw new Error(`investor-roster: the shared EMPTY roster is read-only (${m})`); };
}
Object.freeze(EMPTY);

// ── The registry's own spellings, indexed once ───────────────────────────────
// Lower-cased exact spellings (labels + aliases) and their normalized forms. A
// custom alias that equals either would make one name mean two companies.
let REGISTRY_SPELLINGS = null;
let REGISTRY_NORMALS = null;
function registrySpellings() {
  if (REGISTRY_SPELLINGS) return REGISTRY_SPELLINGS;
  REGISTRY_SPELLINGS = new Set();
  REGISTRY_NORMALS = new Set();
  for (const inv of investors.INVESTORS) {
    for (const raw of [inv.label].concat(inv.aliases || [])) {
      const s = String(raw || '').trim();
      if (!s) continue;
      REGISTRY_SPELLINGS.add(s.toLowerCase());
      const n = investors.normalize(s);
      if (n) REGISTRY_NORMALS.add(n);
    }
  }
  return REGISTRY_SPELLINGS;
}
function registryNormals() { registrySpellings(); return REGISTRY_NORMALS; }

// ── Small readers ────────────────────────────────────────────────────────────
function cleanText(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * A key derived from a label — the default a screen shows before a person
 * changes it. "ClearEdge Lending" → `clearedge_lending`; "A&D Mortgage" →
 * `a_and_d_mortgage`, which is how the registry itself spells that one.
 *
 * MIRRORED in the browser (`app-v2/src/longterm/customInvestors.js`) so the
 * screen can show the key as it is typed; `test-lt-custom-investors-pure.js`
 * runs both over one battery and fails the moment they disagree.
 */
function keyFromLabel(label) {
  return String(label == null ? '' : label)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY);
}

/**
 * Aliases as typed — an array, or one string split on commas, semicolons and
 * line breaks. Trimmed, whitespace collapsed, de-duplicated case-insensitively
 * with the FIRST spelling kept (a person's capitalisation is evidence). Also
 * mirrored in the browser and held to the same battery.
 */
function parseAliases(v) {
  const parts = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\n]/);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const s = cleanText(p, MAX_LABEL);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// ── The custom map, read ─────────────────────────────────────────────────────

/**
 * One custom investor as the readers see it. Same fields a registry entry
 * carries (`key`, `label`, `aliases`, `seen`) plus `custom: true` so a screen can
 * say "one you added" without a second lookup.
 */
function entryOf(key, label, whiteLabel, aliases, value) {
  return {
    key, label, whiteLabel, aliases, seen: 0, custom: true,
    addedBy: value && value.addedBy != null ? String(value.addedBy) : null,
    addedAt: value && value.addedAt != null ? String(value.addedAt) : null,
  };
}

// A raw object handed straight to a reader is read once and remembered by
// identity, so a route that loads the map once and passes it to ten readers
// does not parse it ten times. The read now runs the scrub over each client-safe
// name, which is another reason not to repeat it per reader.
const READ_CACHE = new WeakMap();

/**
 * Read a stored map into the form the readers use.
 *
 * NEVER THROWS, and NEVER WIDENS: anything unusable is dropped and NAMED in
 * `problems`. A colliding alias costs that alias; a colliding LABEL costs the
 * whole entry, because an entry whose own name equals a registry spelling would
 * pull that registry investor's rows under a stranger's key.
 *
 * Collisions are checked here as well as at the write door because the registry
 * can gain a spelling AFTER a map was stored, and a map that was clean the day it
 * was written must not start hijacking a registry investor the day after.
 */
function readCustom(raw) {
  // MEMOISED BY THE STORED OBJECT'S IDENTITY. The read now runs the audience
  // scrub over each client-safe name, which is the right check in the wrong
  // place if it happens per reader per request: the settings store hands out the
  // same object for the life of its cache entry, so one read serves them all and
  // a save — which produces a new object — is read afresh.
  const cacheable = raw !== null && raw !== undefined && typeof raw === 'object';
  // ⛔ THE MEMO AND THE BLOCK NOW AGREE ABOUT WHAT "THE SAME MAP" MEANS.
  // This was keyed on the object REFERENCE while `audience.useCustomInvestors`
  // re-checked by `JSON.stringify`: mutate a stored object in place and the
  // block would report `changed: true` while still holding the old roster,
  // because the memo answered from the reference. Two notions of identity that
  // disagree is a bug waiting for its first in-place write. The reference is
  // still the fast path — it is what makes this a memo — but the JSON decides.
  let json = null;
  if (cacheable) {
    const seen = READ_CACHE.get(raw);
    try { json = JSON.stringify(raw); } catch { json = null; }
    if (seen && json !== null && seen.json === json) return seen.out;
  }
  const out = readCustomUncached(raw);
  if (cacheable && json !== null) READ_CACHE.set(raw, { json, out });
  return out;
}

function readCustomUncached(raw) {
  const custom = new Map();
  const problems = [];
  if (raw === null || raw === undefined) return { custom, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ problem: 'not_a_map', message: 'The custom investors must be one entry per investor, keyed by the investor key.' });
    return { custom, problems };
  }
  const normals = registryNormals();
  /**
   * ⛔ THE SAME `taken` MAP THE DOOR USES, seeded the same way and grown the same
   * way as the entries are walked.
   *
   * It used to be the registry's spellings alone here, and everything (registry
   * spellings, the white-label SHEET's names, then each custom entry's own
   * spellings) at the door. Two consequences, both real: an alias equal to
   * another investor's client-safe name was refused on the way IN and kept on the
   * way OUT — where it then caused that OTHER investor's legitimate name to be
   * redacted for every borrower — and the same input produced a different problem
   * code on each side, so the "one shared routine" was shared for the scrub half
   * only. A rule enforced on one side of a store is not a rule.
   */
  const taken = takenNames();
  // Normalized forms already claimed by an earlier custom entry, so two custom
  // investors cannot both answer to one spelling.
  const claimed = new Map();
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = String(rawKey).trim();
    if (!KEY_RE.test(key) || key.length > MAX_KEY) { problems.push({ key, problem: 'bad_key', message: `"${key}" is not a usable key — lower-case letters, digits and underscores only.` }); continue; }
    if (investors.byKey(key)) { problems.push({ key, problem: 'registry_key', message: `"${key}" is already an investor in the registry, so it cannot be added by hand.` }); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push({ key, problem: 'not_an_object', message: `The entry for "${key}" must be an object.` }); continue; }
    const label = cleanText(value.label, MAX_LABEL);
    if (!label) { problems.push({ key, problem: 'no_label', message: `The investor "${key}" has no name.` }); continue; }
    /* ⛔ THE LABEL GOES THROUGH THE ALIAS CHECKS, exactly as it does at the door.
       It used to be checked SEPARATELY and first, which made the two sides
       disagree on the one shape nobody had tried: a label equal to another
       investor's white-label sheet name answered `label_is_registry_spelling`
       here and `alias_taken` at the door. The door has never had a separate label
       check — it runs `[label].concat(aliases)` through one loop — so the fix is
       to stop having one here rather than to add one there.

       And the old message was FALSE once this map was seeded with the sheet's
       names: it said "is already a recorded spelling of a registry investor"
       about a name that was actually another investor's CLIENT-SAFE name. These
       problems are served verbatim by `GET /custom-investors`, so an admin read
       that sentence. The description now comes from the map that knows. */
    const aliases = [];
    let labelUnusable = null;
    for (const a of [label].concat(parseAliases(value.aliases))) {
      const isLabel = a === label;
      if (aliases.some((x) => x.toLowerCase() === a.toLowerCase())) continue;
      const n = investors.normalize(a);
      let problem = null;
      if (a.length < MIN_ALIAS || !n) {
        problem = { key, alias: a, problem: 'alias_unusable', message: `"${a}" is too short to be a spelling of "${label}".` };
      } else if (taken.has(a.toLowerCase())) {
        problem = { key, alias: a, problem: 'alias_taken', message: `"${a}" is ${taken.get(a.toLowerCase())} — it cannot also mean "${label}".` };
      } else if (normals.has(n)) {
        problem = { key, alias: a, problem: 'alias_is_registry_spelling', message: `"${a}" reads as a registry investor once the company words are set aside — it cannot also mean "${label}".` };
      } else if (claimed.has(n) && claimed.get(n) !== key) {
        problem = { key, alias: a, problem: 'alias_claimed', message: `"${a}" already belongs to "${claimed.get(n)}".` };
      }
      if (problem) {
        // A spelling is dropped; the INVESTOR'S OWN NAME being unusable takes the
        // whole entry with it, because what is left is an investor with no name.
        problems.push(isLabel
          ? { ...problem, dropped: true, message: `${problem.message} That is this investor's own name, so "${key}" was left out.` }
          : { ...problem, dropped: true, message: `${problem.message} It was left off "${label}".` });
        if (isLabel) { labelUnusable = true; break; }
        continue;
      }
      claimed.set(n, key);
      taken.set(a.toLowerCase(), `a spelling of ${key}`);
      aliases.push(a);
    }
    if (labelUnusable) continue;
    if (!aliases.length) { problems.push({ key, problem: 'no_usable_alias', message: `"${label}" has no spelling left that can be matched.` }); continue; }
    const whiteLabel = cleanText(value.whiteLabel, MAX_WHITE_LABEL) || null;
    custom.set(key, entryOf(key, label, whiteLabel, aliases, value));
    if (custom.size >= MAX_CUSTOM) { problems.push({ problem: 'too_many', message: `Only the first ${MAX_CUSTOM} custom investors were read.` }); break; }
  }

  /* THE CLIENT-SAFE NAMES, held to the SAME standard the write door holds them
     to — see `whiteLabelProblem`. A bad one is DROPPED and named: the investor
     still prices and is still blocked from client surfaces by its real name; it
     simply has no name a client may be shown until somebody gives it one. Keeping
     it would put a name in front of a borrower that either reads as somebody
     else's investor or prints as "our capital partner".

     This runs after the loop because the scrub has to be asked about the roster
     AS IT WILL BE — an investor's own spellings are in force when the block reads
     a sentence about it. */
  for (const e of custom.values()) {
    if (!e.whiteLabel) continue;
    const bad = whiteLabelProblem(e.key, e.label, e.whiteLabel, taken, custom);
    if (bad) {
      problems.push({ ...bad, dropped: true, message: `${bad.message} It is not being used, so "${e.label}" has no name a client may see.` });
      e.whiteLabel = null;
      continue;
    }
    taken.set(e.whiteLabel.toLowerCase(), `the client-safe name of ${e.key}`);
  }

  return { custom, problems };
}

/**
 * WHAT MAKES A CLIENT-SAFE NAME UNUSABLE — in ONE place, run by BOTH the write
 * door and the read.
 *
 * ⛔ WHY BOTH. The door refused three things the read did not even look at: a
 * name already used as another investor's client-safe name, a name belonging to
 * a second hand-added investor, and — the one that matters — a name the audience
 * scrub would rewrite. So a value that got in before a rule existed, or was
 * written into the table by hand, was refused on the way IN and kept on the way
 * OUT. Measured by the audit: a white label of "<a registry investor> Group"
 * was refused at the door, kept on read with no problem reported, and reached a
 * borrower as "our capital partner Group". A rule enforced on one side of a
 * store is not a rule.
 *
 * Answers a problem object, or null when the name is usable. `taken` maps a
 * lower-cased name to a description of who already owns it; `roster` is the
 * candidate map the scrub is run against (its own investors have to be in force
 * for the question to mean anything).
 */
function whiteLabelProblem(key, label, whiteLabel, taken, rosterMap) {
  if (!whiteLabel) return null;
  const owner = taken.get(whiteLabel.toLowerCase());
  if (owner) {
    return {
      key,
      problem: 'white_label_taken',
      message: `The client-safe name "${whiteLabel}" is ${owner}. A client may never see an investor's name, and two investors may never show a client one name.`,
    };
  }
  // THE ROUND TRIP. Not "is this name on a list" — "would a client actually read
  // it". A name the scrub rewrites prints as "our capital partner", which is the
  // one outcome a client-safe name exists to prevent.
  const aud = require('../audience');
  const sentence = `Your ${whiteLabel} quote is ready to review.`;
  for (const who of ['borrower', 'tpo']) {
    if (aud.scrubInvestorNames(sentence, who, { custom: rosterMap }) !== sentence) {
      return {
        key,
        problem: 'white_label_would_be_redacted',
        message: `The client-safe name "${whiteLabel}" on "${label}" would be blanked out by the investor-name block, so a client would never read it.`,
      };
    }
  }
  return null;
}

/**
 * Every name that already means somebody: the registry's recorded spellings and
 * the white-label sheet's own names. The custom entries' spellings are added by
 * the caller as it goes, because they are only known while it walks them.
 */
function takenNames() {
  const taken = new Map();
  for (const spelling of registrySpellings()) taken.set(spelling, 'a recorded spelling of a registry investor');
  const sheet = require('../lenderprice/investor-programs');
  for (const [k, v] of Object.entries(sheet.PROGRAM_NAMES)) {
    taken.set(String(v).toLowerCase(), `the client-safe name of ${k}`);
  }
  return taken;
}

/** Whatever a caller passed — a Map, a stored object, or nothing — as a Map. */
function asCustom(custom) {
  if (custom instanceof Map) return custom;
  if (custom === null || custom === undefined) return EMPTY;
  if (typeof custom !== 'object') return EMPTY;
  return readCustom(custom).custom;
}

// ── The effective roster ─────────────────────────────────────────────────────

/**
 * Every investor — the registry (most-seen first, as its own `list()` orders
 * it) followed by the custom investors in label order. Registry entries are the
 * registry's own objects, untouched; a screen tells the two apart by `custom`.
 */
function effectiveList(custom) {
  const map = asCustom(custom);
  const extra = [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  return investors.list().concat(extra);
}

/** One investor by key, from either source. Null when nobody has that key. */
function effectiveByKey(key, custom) {
  const k = String(key == null ? '' : key);
  if (!k) return null;
  const reg = investors.byKey(k);
  if (reg) return reg;
  const map = asCustom(custom);
  return map.get(k) || null;
}

// Per-map lookup indexes, built once per Map and remembered by identity.
const INDEX_CACHE = new WeakMap();
function indexOf(map) {
  const hit = INDEX_CACHE.get(map);
  if (hit) return hit;
  const exact = new Map();
  const normal = new Map();
  for (const e of map.values()) {
    for (const a of e.aliases) {
      const lower = a.toLowerCase();
      if (!exact.has(lower)) exact.set(lower, e);
      const n = investors.normalize(a);
      if (n && !normal.has(n)) normal.set(n, e);
    }
  }
  const idx = { exact, normal };
  INDEX_CACHE.set(map, idx);
  return idx;
}

/**
 * Resolve any typed investor string across BOTH sources.
 *
 * The shape is `investors.resolve`'s own — `{ raw, key, label, match }` — plus
 * `custom` so a caller can tell an investor somebody added from a registry one
 * without parsing `match`. `match` is `custom` for a hand-added spelling and
 * the registry's own `exact` / `normal` / `prefix` / `none` / `non-value`
 * otherwise. A custom match is a recorded fact, never a guess.
 */
function effectiveResolve(name, custom) {
  const raw = name;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { raw, key: null, label: null, match: 'none', custom: false };
  }
  const map = asCustom(custom);
  if (map.size) {
    const idx = indexOf(map);
    const lower = String(raw).toLowerCase().trim();
    let hit = idx.exact.get(lower);
    if (!hit) {
      const n = investors.normalize(raw);
      if (n) hit = idx.normal.get(n);
    }
    if (hit) return { raw, key: hit.key, label: hit.label, match: 'custom', custom: true };
  }
  const r = investors.resolve(raw);
  return { raw, key: r.key, label: r.label, match: r.match, custom: false };
}

// ── The write door ───────────────────────────────────────────────────────────

/**
 * Check a whole map before it is saved. Returns the CLEAN map (the stored
 * shape) and every problem, or refuses WHOLE — never half-repaired.
 *
 * What is refused, and why each is a refusal rather than a repair:
 *   • a key that is not `[a-z0-9_]+`, or that is a registry key      — identity
 *   • no label, or no alias once the label is counted                — identity
 *   • an alias equal to a recorded registry spelling, exact or once
 *     normalized, or claimed by another custom investor              — one name
 *     would mean two companies
 *   • an alias or label equal to a white label (sheet or custom)     — the scrub
 *     would then redact that client-safe name everywhere
 *   • a white label equal to ANY recorded spelling, or to another
 *     white label, or that the scrub does not leave untouched        — a name a
 *     client may never see, or one that prints as "our capital partner"
 *
 * The scrub check runs with the CANDIDATE map applied, so a white label that
 * collides with its own investor's aliases is caught here rather than on a
 * borrower's screen.
 */
function validateCustom(raw) {
  if (raw === null || raw === undefined) return { ok: true, custom: {}, problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, custom: null, problems: [{ problem: 'not_a_map', message: 'Send one entry per investor, keyed by the investor key.' }] };
  }
  // Lazy on purpose: the sheet module and the audience module both read THIS
  // module at load, so requiring them at the top would be a cycle. Both are
  // needed only at the door, which is the one place they are asked for.

  const problems = [];
  const exact = registrySpellings();
  const normals = registryNormals();

  const entries = [];
  const keys = Object.keys(raw);
  if (keys.length > MAX_CUSTOM) problems.push({ problem: 'too_many', message: `At most ${MAX_CUSTOM} investors can be added by hand.` });
  for (const rawKey of keys) {
    const value = raw[rawKey];
    const key = String(rawKey).trim();
    if (!KEY_RE.test(key) || key.length > MAX_KEY) { problems.push({ key, problem: 'bad_key', message: `"${key}" is not a usable key — lower-case letters, digits and underscores only, up to ${MAX_KEY} characters.` }); continue; }
    if (investors.byKey(key)) { problems.push({ key, problem: 'registry_key', message: `"${key}" is already an investor in the registry — it does not need adding.` }); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push({ key, problem: 'not_an_object', message: `The entry for "${key}" must be an object with a label.` }); continue; }
    const label = cleanText(value.label, MAX_LABEL);
    if (!label) { problems.push({ key, problem: 'no_label', message: `Give "${key}" the investor's name.` }); continue; }
    const aliasesIn = parseAliases(value.aliases);
    if (aliasesIn.length > MAX_ALIASES) problems.push({ key, problem: 'too_many_aliases', message: `"${label}" lists more than ${MAX_ALIASES} spellings.` });
    const aliases = [];
    for (const a of [label].concat(aliasesIn)) {
      if (aliases.some((x) => x.toLowerCase() === a.toLowerCase())) continue;
      aliases.push(a);
    }
    const whiteLabel = cleanText(value.whiteLabel, MAX_WHITE_LABEL) || null;
    if (value.whiteLabel != null && String(value.whiteLabel).trim() && !whiteLabel) {
      problems.push({ key, problem: 'white_label_unreadable', message: `The client-safe name on "${label}" could not be read.` });
    }
    entries.push({ key, label, whiteLabel, aliases, value });
  }

  // Every spelling that already means somebody: registry spellings, sheet
  // white labels, and — as they are checked — the other custom entries.
  const takenSpelling = takenNames();
  const takenNormal = new Map();   // normalized → key
  for (const e of entries) {
    for (const a of e.aliases) {
      const lower = a.toLowerCase();
      const n = investors.normalize(a);
      if (a.length < MIN_ALIAS || !n) { problems.push({ key: e.key, alias: a, problem: 'alias_unusable', message: `"${a}" is too short to be matched as a spelling of "${e.label}".` }); continue; }
      if (takenSpelling.has(lower)) { problems.push({ key: e.key, alias: a, problem: 'alias_taken', message: `"${a}" is ${takenSpelling.get(lower)} — it cannot also mean "${e.label}".` }); continue; }
      if (normals.has(n)) { problems.push({ key: e.key, alias: a, problem: 'alias_is_registry_spelling', message: `"${a}" reads as a registry investor once the company words are set aside — it cannot also mean "${e.label}".` }); continue; }
      if (takenNormal.has(n) && takenNormal.get(n) !== e.key) { problems.push({ key: e.key, alias: a, problem: 'alias_claimed', message: `"${a}" already belongs to "${takenNormal.get(n)}".` }); continue; }
      takenNormal.set(n, e.key);
      takenSpelling.set(lower, `a spelling of ${e.key}`);
    }
  }
  /* THE CLIENT-SAFE NAMES, through the SAME routine the READ runs — one
     definition, so a value cannot be refused on the way in and kept on the way
     out. The difference between the two callers is what they DO about a bad one:
     the door refuses the whole map (the person is at a form and can fix it); the
     read drops the name and says so (nobody is there to ask). */
  {
    const candidate = new Map(entries.map((e) => [e.key, entryOf(e.key, e.label, e.whiteLabel, e.aliases, e.value)]));
    for (const e of entries) {
      const bad = whiteLabelProblem(e.key, e.label, e.whiteLabel, takenSpelling, candidate);
      if (bad) { problems.push({ ...bad, message: `${bad.message} Pick a different one.` }); continue; }
      if (e.whiteLabel) takenSpelling.set(e.whiteLabel.toLowerCase(), `the client-safe name of ${e.key}`);
    }
  }

  if (problems.length) return { ok: false, custom: null, problems };
  const clean = {};
  for (const e of entries) {
    clean[e.key] = {
      label: e.label,
      whiteLabel: e.whiteLabel,
      aliases: e.aliases,
      addedBy: e.value.addedBy == null ? null : String(e.value.addedBy),
      addedAt: e.value.addedAt == null ? null : String(e.value.addedAt),
    };
  }
  return { ok: true, custom: clean, problems: [] };
}

module.exports = {
  SETTING_KEY, KEY_RE, EMPTY,
  keyFromLabel, parseAliases,
  readCustom, asCustom,
  effectiveList, effectiveByKey, effectiveResolve,
  validateCustom,
  _internals: { registrySpellings, registryNormals, cleanText, whiteLabelProblem, takenNames, MAX_KEY, MAX_LABEL, MAX_WHITE_LABEL, MAX_ALIASES, MAX_CUSTOM, MIN_ALIAS },
};
