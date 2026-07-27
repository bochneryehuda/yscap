'use strict';
/**
 * PERSON NAME — the ONE place a human name is split, joined and compared.
 *
 * WHY THIS EXISTS (owner-directed 2026-07-27). PILOT stored a person as two
 * columns, `borrowers.first_name` + `borrowers.last_name`, and every one-line
 * name arriving from ClickUp was cut with `lastIndexOf(' ')` — so a middle name
 * silently became part of the FIRST name ("Avrohom Yitzchok" / "Klein") and a
 * generational suffix became the LAST name ("John Michael Smith" / "Jr"). The
 * two external systems disagree about the shape of a name:
 *   • ClickUp  — ONE "Borrower Name" text field holding the whole line.
 *   • Encompass — THREE separate fields, firstName / middleName / lastName
 *                 (+ suffixToName), which is also what MISMO and every closing
 *                 document want.
 * So the middle name had "no home in our schema" (it was literally documented
 * that way in `integrations/encompass-field-map.js`), and the Encompass identity
 * comparison joined first+last on both sides — meaning a file whose Encompass
 * copy is correctly split read as a NAME MISMATCH against our merged first name
 * and held the term sheet.
 *
 * This module is the structural fix: one splitter, one joiner, one comparer,
 * used by every surface (ClickUp in/out, Encompass compare + enrichment, MISMO,
 * the intake/apply forms, the staff + borrower edit screens, the boot backfill).
 *
 * THE OWNER'S RULE, exactly: "any name that has two words — split that in half."
 * Two words is therefore ALWAYS first + last at full confidence. Three or more
 * words is where judgement starts, so this module reports a CONFIDENCE with
 * every split and flags the uncertain ones for a human to confirm — it never
 * silently guesses and calls it fact.
 *
 * PURE: no DB, no network, no I/O. Unit-tested by scripts/test-person-name.js.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

// Courtesy / professional TITLES. Stripped from the front of a name so they can
// never become the first name. (They are not stored anywhere — a title is not
// part of a legal name and never appears on a closing document.)
const TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor',
  'rabbi', 'rav', 'rebbetzin', 'rev', 'reverend', 'father', 'pastor',
  'sir', 'dame', 'hon', 'honorable', 'judge', 'atty',
]);

// Generational + professional SUFFIXES, normalized token → canonical display.
// Deliberately conservative at the single-letter end: a bare "V" or "X" as the
// last token is far more likely to be an initial standing in for a surname than
// a regnal number, and mis-reading it would DELETE someone's surname.
const SUFFIXES = new Map([
  ['jr', 'Jr.'], ['jnr', 'Jr.'], ['sr', 'Sr.'], ['snr', 'Sr.'],
  ['ii', 'II'], ['iii', 'III'], ['iv', 'IV'], ['vi', 'VI'], ['vii', 'VII'],
  ['viii', 'VIII'], ['ix', 'IX'],
  ['2nd', 'II'], ['3rd', 'III'], ['4th', 'IV'],
  ['esq', 'Esq.'], ['md', 'MD'], ['phd', 'PhD'], ['dds', 'DDS'], ['dvm', 'DVM'],
  ['cpa', 'CPA'], ['jd', 'JD'], ['rn', 'RN'], ['do', 'DO'],
]);

// SURNAME PARTICLES — the little words that belong to the LAST name, not the
// middle name ("Ludwig van Beethoven", "Juan de la Cruz").
//
// STRONG: essentially never a given or middle name in any language we see, so
// they attach to the surname whatever their casing, at full confidence.
const STRONG_PARTICLES = new Set([
  'van', 'von', 'vander', 'vanden', 'vandal', 'della', 'delle', 'dello',
  'degli', 'dos', 'das', 'du', 'ter', 'ten', 'zu', 'af', 'op',
]);
// WEAK: real surname particles, but each is also a plausible given/middle name
// somewhere ("Ben", "Al", "Della"). They attach to the surname ONLY when the
// writer left them lowercase — the conventional signal that they are a particle
// — and the resulting split is flagged for a human to confirm.
const WEAK_PARTICLES = new Set([
  'de', 'del', 'di', 'da', 'la', 'le', 'el', 'al', 'bin', 'ibn', 'ben',
  'abu', 'san', 'santa', 'st', 'ste', 'y', 'e',
]);

// OUR OWN placeholders (the NOT NULL name columns need something at insert
// time) — never real data. Kept here so `clickup/transforms` and every other
// caller share ONE definition (transforms re-exports this).
const PLACEHOLDER_NAMES = new Set(['', 'unknown', 'co-borrower', 'coborrower', 'n/a', 'na', 'tbd', 'none', '-', '--', 'unknown unknown']);

// ── Small helpers ───────────────────────────────────────────────────────────

const str = (v) => String(v == null ? '' : v);
const squish = (v) => str(v).replace(/\s+/g, ' ').trim();
const lower = (v) => squish(v).toLowerCase();
// Strip punctuation used for comparison only ("O'Brien" ≡ "OBrien",
// "St. Clair" ≡ "St Clair"). Never used for storage.
const bare = (v) => lower(v).replace(/[^a-z0-9\s]/g, '');
const tokenKey = (v) => bare(v).replace(/\s+/g, '');

function isPlaceholderName(v) {
  return v == null || PLACEHOLDER_NAMES.has(lower(v));
}

// A single INITIAL — "A", "A.", "A-" — as written by a human.
function isInitial(v) {
  return /^[\p{L}]\.?$/u.test(squish(v));
}

function isSuffixToken(v) {
  return SUFFIXES.has(tokenKey(v));
}

function canonicalSuffix(v) {
  return SUFFIXES.get(tokenKey(v)) || squish(v);
}

function isTitleToken(v) {
  return TITLES.has(tokenKey(v));
}

// Is this token a surname particle, given how it was WRITTEN?
// Returns 'strong' | 'weak' | null.
function particleKind(rawToken) {
  const k = tokenKey(rawToken);
  if (STRONG_PARTICLES.has(k)) return 'strong';
  // A weak particle only counts when the writer left it lowercase — that is the
  // signal that separates "Juan de la Cruz" from "John De Smith" (where De is a
  // middle name someone capitalized deliberately).
  if (WEAK_PARTICLES.has(k) && squish(rawToken) === lower(rawToken)) return 'weak';
  return null;
}

// ── The splitter ────────────────────────────────────────────────────────────

const EMPTY = Object.freeze({ first: '', middle: '', last: '', suffix: '' });

function result(parts, confidence, reason, needsReview) {
  return {
    first: parts.first || '',
    middle: parts.middle || '',
    last: parts.last || '',
    suffix: parts.suffix || '',
    confidence,                 // 'high' | 'medium' | 'low'
    reason,                     // a plain-language machine key, see REASON_TEXT
    needsReview: !!needsReview,
  };
}

/**
 * splitFullName('Avrohom Yitzchok Klein') →
 *   { first:'Avrohom', middle:'Yitzchok', last:'Klein', suffix:'',
 *     confidence:'medium', reason:'three_words', needsReview:true }
 *
 * Never throws. A blank/placeholder input returns blanks with needsReview FALSE
 * (there is nothing for a human to look at), which is what keeps the review
 * prompt off the thousands of nameless shadow rows the sync creates.
 */
function splitFullName(full) {
  const s = squish(full);
  if (!s || isPlaceholderName(s)) return result(EMPTY, 'low', s ? 'placeholder' : 'empty', false);

  let tokens = s.split(' ');
  let suffix = '';

  // "Last, First Middle" — but "Smith, Jr." is a SUFFIX, not an inversion.
  const commaAt = s.indexOf(',');
  let commaForm = false;
  if (commaAt > 0 && s.indexOf(',') === s.lastIndexOf(',')) {
    const head = squish(s.slice(0, commaAt));
    const tail = squish(s.slice(commaAt + 1));
    const tailTokens = tail ? tail.split(' ') : [];
    if (head && tailTokens.length && tailTokens.every(isSuffixToken)) {
      suffix = tailTokens.map(canonicalSuffix).join(' ');
      tokens = head.split(' ');
    } else if (head && tail) {
      // Inverted: the part BEFORE the comma is the surname.
      tokens = tail.split(' ').concat(head.split(' '));
      commaForm = true;
    }
  }

  // Drop a leading courtesy title ("Rabbi Moshe Klein").
  while (tokens.length > 1 && isTitleToken(tokens[0])) tokens.shift();

  // Trailing suffixes ("John Smith Jr.", "Jane Doe MD", "John Smith Jr, MD").
  // Only ever taken while at least TWO name tokens would remain, so a two-word
  // name can never lose its surname to a suffix lookalike.
  const tail = [];
  while (tokens.length > 2 && isSuffixToken(tokens[tokens.length - 1])) {
    tail.unshift(canonicalSuffix(tokens.pop()));
  }
  if (tail.length) suffix = [tail.join(' '), suffix].filter(Boolean).join(' ');

  // Strip stray commas left inside tokens after the inversion handling.
  tokens = tokens.map((t) => t.replace(/,+$/, '')).filter(Boolean);

  const n = tokens.length;
  if (n === 0) return result({ suffix }, 'low', 'empty', false);

  // ONE word — we genuinely cannot tell whether it is a given name or a
  // surname, so it stays the first name and a human is asked.
  if (n === 1) {
    if (particleKind(tokens[0])) return result({ last: tokens[0], suffix }, 'low', 'only_one_word', true);
    return result({ first: tokens[0], suffix }, 'low', 'only_one_word', true);
  }

  // TWO words — the owner's rule, split in half, no question asked.
  if (n === 2) {
    if (particleKind(tokens[0])) {
      // "de Souza" — the whole thing is a surname; there is no given name here.
      return result({ last: tokens.join(' '), suffix }, 'low', 'surname_only', true);
    }
    return result({ first: tokens[0], last: tokens[1], suffix },
      commaForm ? 'medium' : 'high', commaForm ? 'comma_form' : 'two_words', commaForm);
  }

  // THREE OR MORE — walk back from the end over any surname particles, never
  // letting the surname swallow the first token.
  let start = n - 1;
  let sawWeakParticle = false;
  let sawStrongParticle = false;
  while (start - 1 >= 1) {
    const kind = particleKind(tokens[start - 1]);
    if (!kind) break;
    if (kind === 'weak') sawWeakParticle = true; else sawStrongParticle = true;
    start -= 1;
  }

  const first = tokens[0];
  const middle = tokens.slice(1, start).join(' ');
  const last = tokens.slice(start).join(' ');

  if (!middle) {
    // "Ludwig van Beethoven" — the particle absorbed everything between.
    if (sawStrongParticle && !sawWeakParticle) {
      return result({ first, last, suffix }, 'high', 'surname_particle', false);
    }
    if (sawWeakParticle) {
      return result({ first, last, suffix }, 'medium', 'surname_particle', true);
    }
    // n>=3 with no middle can only happen via particles; defensive fallback.
    return result({ first, last, suffix }, 'medium', 'three_words', true);
  }

  // A single middle INITIAL is the unambiguous case — "John A. Smith".
  if (n === 3 && isInitial(middle) && !sawWeakParticle && !sawStrongParticle) {
    return result({ first, middle, last, suffix }, 'high', 'middle_initial', false);
  }

  if (commaForm) return result({ first, middle, last, suffix }, 'low', 'comma_form', true);
  if (sawWeakParticle) return result({ first, middle, last, suffix }, 'low', 'surname_particle', true);
  if (n === 3) return result({ first, middle, last, suffix }, 'medium', 'three_words', true);
  return result({ first, middle, last, suffix }, 'low', 'four_or_more_words', true);
}

/**
 * splitStoredName({ first, last }) — re-split a name ALREADY stored in our two
 * columns, for the backfill and for any read that has to cope with a legacy row.
 *
 * DELIBERATELY CONSERVATIVE: it redistributes tokens WITHIN the stored first
 * name and never moves a token across the first/last boundary — because the
 * stored last name may well have been typed by a human on the application form,
 * and re-guessing it would be a downgrade. The two exceptions are the two shapes
 * the old `lastIndexOf(' ')` splitter provably produced:
 *   • the stored LAST name is a pure suffix ("John Michael Smith" / "Jr") — the
 *     real surname is the final token of the first name and "Jr" is a suffix;
 *   • the stored FIRST name ends in surname particles ("Ludwig van" /
 *     "Beethoven") — the particles belong to the surname.
 *
 * `changed` tells the caller whether anything actually moved, so a backfill can
 * skip a row it does not need to touch.
 */
function splitStoredName(stored) {
  const inFirst = squish(stored && stored.first);
  const inLast = squish(stored && stored.last);
  const inMiddle = squish(stored && stored.middle);
  const inSuffix = squish(stored && stored.suffix);

  const unchanged = (confidence, reason, needsReview) => Object.assign(
    result({ first: inFirst, middle: inMiddle, last: inLast, suffix: inSuffix }, confidence, reason, needsReview),
    { changed: false });

  // Nothing usable, or a placeholder → leave it exactly as it is.
  if (!inFirst || isPlaceholderName(inFirst)) return unchanged('low', 'placeholder', false);
  // A middle name is already recorded — a human or an integration has spoken.
  if (inMiddle) return unchanged('high', 'already_split', false);

  let tokens = inFirst.split(' ');
  let last = inLast;
  let suffix = inSuffix;

  while (tokens.length > 1 && isTitleToken(tokens[0])) tokens.shift();

  // The stored surname is really a suffix — recover the surname from the first
  // name. Needs at least two tokens left over, or we would erase the given name.
  if (last && isSuffixToken(last) && !isPlaceholderName(last) && tokens.length >= 2) {
    suffix = [canonicalSuffix(last), suffix].filter(Boolean).join(' ');
    last = tokens.pop();
  }

  // A trailing suffix sitting inside the first name ("John Michael Jr" / "Smith").
  while (tokens.length > 1 && isSuffixToken(tokens[tokens.length - 1])) {
    suffix = [canonicalSuffix(tokens.pop()), suffix].filter(Boolean).join(' ');
  }

  // Surname particles stranded at the end of the first name.
  let sawWeakParticle = false;
  let sawStrongParticle = false;
  while (tokens.length > 1 && particleKind(tokens[tokens.length - 1])) {
    const kind = particleKind(tokens[tokens.length - 1]);
    if (kind === 'weak') sawWeakParticle = true; else sawStrongParticle = true;
    last = [tokens.pop(), last].filter(Boolean).join(' ');
  }

  const first = tokens.shift() || '';
  const middle = tokens.join(' ');
  const changed = first !== inFirst || middle !== inMiddle || last !== inLast || suffix !== inSuffix;

  if (!changed) return unchanged('high', middle ? 'already_split' : 'nothing_to_split', false);

  // Confidence mirrors splitFullName's rules for the SAME shapes, so a name that
  // arrives from ClickUp and the same name healed out of storage are judged
  // identically (the pure test pins this).
  const words = 1 + (middle ? middle.split(' ').length : 0);
  let confidence = 'medium';
  let reason = 'three_words';
  let needsReview = true;
  if (!middle && sawStrongParticle && !sawWeakParticle) { confidence = 'high'; reason = 'surname_particle'; needsReview = false; }
  else if (!middle && (sawWeakParticle || sawStrongParticle)) { confidence = 'medium'; reason = 'surname_particle'; needsReview = true; }
  else if (!middle) { confidence = 'high'; reason = 'suffix_recovered'; needsReview = false; }
  else if (sawWeakParticle) { confidence = 'low'; reason = 'surname_particle'; needsReview = true; }
  else if (words === 2 && isInitial(middle)) { confidence = 'high'; reason = 'middle_initial'; needsReview = false; }
  else if (words === 2) { confidence = 'medium'; reason = 'three_words'; needsReview = true; }
  else { confidence = 'low'; reason = 'four_or_more_words'; needsReview = true; }

  return Object.assign(result({ first, middle, last, suffix }, confidence, reason, needsReview), { changed: true });
}

// ── Joining ─────────────────────────────────────────────────────────────────

/**
 * joinFullName({first, middle, last, suffix}) → 'Avrohom Yitzchok Klein Jr.'
 * Also accepts positional args: joinFullName(first, middle, last, suffix).
 * A suffix is comma-separated the way it is written on a legal document.
 */
function joinFullName(a, b, c, d) {
  const p = (a && typeof a === 'object')
    ? { first: a.first != null ? a.first : a.first_name, middle: a.middle != null ? a.middle : a.middle_name,
        last: a.last != null ? a.last : a.last_name, suffix: a.suffix != null ? a.suffix : a.name_suffix }
    : { first: a, middle: b, last: c, suffix: d };
  const core = [p.first, p.middle, p.last].map(squish).filter((x) => x && !isPlaceholderName(x)).join(' ');
  const sfx = squish(p.suffix);
  if (!core) return '';
  return sfx && !isPlaceholderName(sfx) ? `${core} ${sfx}` : core;
}

/**
 * displayName(row, prefix) — THE ONE BIG NAME FIELD, for any row we hold.
 *
 * The owner's rule (2026-07-27): every place that showed a borrower's name before
 * the split must keep showing the WHOLE name. `borrowers.full_name` (db/346) is a
 * generated column, so it is always right and always present — this prefers it and
 * falls back to joining the parts, which means a query that has not (yet) selected
 * `full_name` behaves exactly as it did before instead of breaking.
 *
 *   displayName(borrowerRow)              -> 'Issac Michael Grunzweig'
 *   displayName(appRow, 'co_')            -> the co-borrower on a file row
 *   displayName({firstName, lastName})    -> camelCase rows work too
 */
function displayName(row, prefix) {
  if (!row || typeof row !== 'object') return '';
  const p = prefix || '';
  const cap = p ? p.charAt(0).toUpperCase() + p.slice(1).replace(/_$/, '') : '';
  const pick = (snake, camel) => {
    const keys = p
      ? [`${p}${snake}`, cap + camel.charAt(0).toUpperCase() + camel.slice(1)]
      : [snake, camel];
    for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return row[k];
    return '';
  };
  const full = pick('full_name', 'fullName');
  if (full && !isPlaceholderName(full)) return squish(full);
  return joinFullName({
    first: pick('first_name', 'firstName'),
    middle: pick('middle_name', 'middleName'),
    last: pick('last_name', 'lastName'),
    suffix: pick('name_suffix', 'nameSuffix'),
  });
}

/** The legal-document form: 'Klein, Avrohom Yitzchok'. Display only. */
function joinLastFirst(p) {
  const last = squish(p && (p.last != null ? p.last : p.last_name));
  const rest = [p && (p.first != null ? p.first : p.first_name), p && (p.middle != null ? p.middle : p.middle_name)]
    .map(squish).filter(Boolean).join(' ');
  if (!last) return rest;
  return rest ? `${last}, ${rest}` : last;
}

// ── Comparing ───────────────────────────────────────────────────────────────

function toParts(v) {
  if (v && typeof v === 'object') {
    const p = {
      first: squish(v.first != null ? v.first : v.first_name),
      middle: squish(v.middle != null ? v.middle : v.middle_name),
      last: squish(v.last != null ? v.last : v.last_name),
      suffix: squish(v.suffix != null ? v.suffix : v.name_suffix),
    };
    // LEGACY SHAPE. A record whose FIRST name still carries the middle name
    // ("Issac Michael" / "Grunzweig") is re-split before comparing, so the
    // comparison never depends on the boot backfill having reached that row yet —
    // a read replica, a stale cache, or a row created a second ago all compare
    // correctly against a properly split Encompass copy.
    if (!p.middle && p.first && p.first.includes(' ')) {
      const s = splitStoredName(p);
      if (s.changed) return { first: s.first, middle: s.middle, last: s.last, suffix: s.suffix };
    }
    return p;
  }
  const s = splitFullName(v);
  return { first: s.first, middle: s.middle, last: s.last, suffix: s.suffix };
}

// Two name PARTS agree when they are the same word, or when one is the other's
// initial ("A." ≡ "Avrohom"). Punctuation and casing never matter.
function partAgrees(a, b) {
  const x = bare(a), y = bare(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length === 1 && y.startsWith(x)) return true;
  if (y.length === 1 && x.startsWith(y)) return true;
  return false;
}

// Middle names agree loosely: a blank on either side is NOT a disagreement
// (ClickUp's one-line field often omits it), and an initial matches the full
// word. Multi-word middles compare token by token, tolerating a shorter list.
function middleAgrees(a, b) {
  const x = squish(a), y = squish(b);
  if (!x || !y) return true;               // one side simply does not carry it
  if (bare(x) === bare(y)) return true;
  const xs = x.split(' '), ys = y.split(' ');
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) if (!partAgrees(xs[i], ys[i])) return false;
  return true;
}

/**
 * compareNames(a, b) → { status, ours, theirs }
 *   status: 'match'              — the same person, spelled the same way
 *           'match_detail_only'  — the same person; only the middle name detail
 *                                  differs (one side omits it, or has an initial)
 *           'mismatch'           — genuinely different names
 *           'incomparable'       — a side is missing, nothing to compare
 * Either side may be a one-line string or a {first,middle,last,suffix} record.
 */
function compareNames(a, b) {
  const A = toParts(a), B = toParts(b);
  const aHas = !!(A.first || A.last), bHas = !!(B.first || B.last);
  const ours = joinFullName(A), theirs = joinFullName(B);
  if (!aHas || !bHas) return { status: 'incomparable', ours, theirs };

  // A surname is the anchor; when either side lacks one there is not enough to
  // judge, so we fall back to comparing the whole line rather than guessing.
  if (!A.last || !B.last) {
    return { status: bare(ours) === bare(theirs) ? 'match' : 'incomparable', ours, theirs };
  }
  if (!partAgrees(A.last, B.last) && bare(A.last) !== bare(B.last)) return { status: 'mismatch', ours, theirs };
  if (!partAgrees(A.first, B.first)) return { status: 'mismatch', ours, theirs };
  // A generational suffix present on BOTH sides and different is a different
  // person (a father and his son share everything else).
  if (A.suffix && B.suffix && bare(A.suffix) !== bare(B.suffix)) return { status: 'mismatch', ours, theirs };
  if (!middleAgrees(A.middle, B.middle)) return { status: 'mismatch', ours, theirs };
  const exact = bare(A.first) === bare(B.first) && bare(A.last) === bare(B.last)
    && bare(A.middle) === bare(B.middle) && bare(A.suffix) === bare(B.suffix);
  return { status: exact ? 'match' : 'match_detail_only', ours, theirs };
}

/** True when the two names describe the same person (middle-name tolerant). */
function sameName(a, b) {
  const s = compareNames(a, b).status;
  return s === 'match' || s === 'match_detail_only';
}

// ── Plain-language copy for the review prompt ───────────────────────────────
// Shown to staff verbatim, so it is written the way the owner asks for: short,
// everyday words, no jargon.
const REASON_TEXT = Object.freeze({
  empty: 'There is no name here yet.',
  placeholder: 'This is a filler name, not a real one.',
  only_one_word: 'Only one word was given, so we could not tell the first name from the last name.',
  two_words: 'Two words — the first word is the first name and the second is the last name.',
  middle_initial: 'The middle part is just an initial, so this split is safe.',
  three_words: 'Three words — we made the middle word the middle name. Please check that is right.',
  four_or_more_words: 'More than three words — please check we picked the right first, middle and last name.',
  surname_particle: 'The last name looks like it has a small word in it (like "van" or "de la"). Please check.',
  comma_form: 'The name was written last-name-first, so please check we read it the right way round.',
  surname_only: 'This looks like a last name with no first name. Please check.',
  suffix_recovered: 'We moved a suffix (like Jr.) out of the last name.',
  already_split: 'Already split.',
  nothing_to_split: 'Nothing to split.',
});
function reviewText(reason) { return REASON_TEXT[reason] || 'Please check this name is split correctly.'; }

module.exports = {
  splitFullName,
  splitStoredName,
  joinFullName,
  joinLastFirst,
  displayName,
  compareNames,
  sameName,
  isPlaceholderName,
  isInitial,
  isSuffixToken,
  canonicalSuffix,
  reviewText,
  REASON_TEXT,
  PLACEHOLDER_NAMES,
  _internals: { squish, lower, bare, tokenKey, particleKind, partAgrees, middleAgrees, toParts, TITLES, SUFFIXES, STRONG_PARTICLES, WEAK_PARTICLES },
};
