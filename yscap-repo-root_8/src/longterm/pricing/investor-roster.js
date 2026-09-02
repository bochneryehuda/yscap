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
const EMPTY = new Map();

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
  const custom = new Map();
  const problems = [];
  if (raw === null || raw === undefined) return { custom, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ problem: 'not_a_map', message: 'The custom investors must be one entry per investor, keyed by the investor key.' });
    return { custom, problems };
  }
  const exact = registrySpellings();
  const normals = registryNormals();
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
    if (exact.has(label.toLowerCase()) || normals.has(investors.normalize(label))) {
      problems.push({ key, problem: 'label_is_registry_spelling', message: `"${label}" is already a recorded spelling of a registry investor, so "${key}" was left out.` });
      continue;
    }
    const aliases = [];
    for (const a of [label].concat(parseAliases(value.aliases))) {
      if (aliases.some((x) => x.toLowerCase() === a.toLowerCase())) continue;
      const n = investors.normalize(a);
      if (a.length < MIN_ALIAS || !n) { problems.push({ key, alias: a, problem: 'alias_unusable', message: `"${a}" is too short to be a spelling of "${label}".` }); continue; }
      if (exact.has(a.toLowerCase()) || normals.has(n)) { problems.push({ key, alias: a, problem: 'alias_is_registry_spelling', message: `"${a}" is a recorded spelling of a registry investor and was left off "${label}".` }); continue; }
      if (claimed.has(n) && claimed.get(n) !== key) { problems.push({ key, alias: a, problem: 'alias_claimed', message: `"${a}" already belongs to "${claimed.get(n)}" and was left off "${label}".` }); continue; }
      claimed.set(n, key);
      aliases.push(a);
    }
    if (!aliases.length) { problems.push({ key, problem: 'no_usable_alias', message: `"${label}" has no spelling left that can be matched.` }); continue; }
    let whiteLabel = cleanText(value.whiteLabel, MAX_WHITE_LABEL) || null;
    if (whiteLabel && exact.has(whiteLabel.toLowerCase())) {
      // The scrub would redact it off the very surface it exists for; better a
      // missing name, said out loud, than a name that prints as "our capital partner".
      problems.push({ key, problem: 'white_label_is_registry_spelling', message: `The client-safe name "${whiteLabel}" on "${label}" is a recorded investor spelling, so it is not being used.` });
      whiteLabel = null;
    }
    custom.set(key, entryOf(key, label, whiteLabel, aliases, value));
    if (custom.size >= MAX_CUSTOM) { problems.push({ problem: 'too_many', message: `Only the first ${MAX_CUSTOM} custom investors were read.` }); break; }
  }
  return { custom, problems };
}

// A raw object handed straight to a reader is read once and remembered by
// identity, so a route that loads the map once and passes it to ten readers
// does not parse it ten times.
const READ_CACHE = new WeakMap();

/** Whatever a caller passed — a Map, a stored object, or nothing — as a Map. */
function asCustom(custom) {
  if (custom instanceof Map) return custom;
  if (custom === null || custom === undefined) return EMPTY;
  if (typeof custom !== 'object') return EMPTY;
  const hit = READ_CACHE.get(custom);
  if (hit) return hit;
  const read = readCustom(custom).custom;
  READ_CACHE.set(custom, read);
  return read;
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
  const sheet = require('../lenderprice/investor-programs');
  const audience = require('../audience');

  const problems = [];
  const exact = registrySpellings();
  const normals = registryNormals();
  const sheetNames = new Map(Object.entries(sheet.PROGRAM_NAMES).map(([k, v]) => [String(v).toLowerCase(), k]));

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
  const takenSpelling = new Map(); // lower → what it is
  for (const s of exact) takenSpelling.set(s, 'a recorded spelling of a registry investor');
  for (const [s, k] of sheetNames) takenSpelling.set(s, `the client-safe name of ${k}`);
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
  for (const e of entries) {
    if (!e.whiteLabel) continue;
    const lower = e.whiteLabel.toLowerCase();
    const owner = takenSpelling.get(lower);
    if (owner) {
      problems.push({ key: e.key, problem: 'white_label_taken', message: `The client-safe name "${e.whiteLabel}" is ${owner}. A client may never see an investor's name, so pick a different one.` });
      continue;
    }
    takenSpelling.set(lower, `the client-safe name of ${e.key}`);
  }

  if (!problems.length) {
    // The scrub, with THIS map applied. A white label the scrubber changes is a
    // broken name — it would print as "our capital partner" on a client's screen.
    const candidate = new Map(entries.map((e) => [e.key, entryOf(e.key, e.label, e.whiteLabel, e.aliases, e.value)]));
    for (const e of entries) {
      if (!e.whiteLabel) continue;
      const sentence = `Your ${e.whiteLabel} quote is ready to review.`;
      for (const aud of ['borrower', 'tpo']) {
        if (audience.scrubInvestorNames(sentence, aud, { custom: candidate }) !== sentence) {
          problems.push({ key: e.key, problem: 'white_label_would_be_redacted', message: `The client-safe name "${e.whiteLabel}" would be blanked out by the investor-name block, so a client would never read it. Pick a name that is not an investor's.` });
          break;
        }
      }
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
  _internals: { registrySpellings, registryNormals, cleanText, MAX_KEY, MAX_LABEL, MAX_WHITE_LABEL, MAX_ALIASES, MAX_CUSTOM, MIN_ALIAS },
};
