/**
 * READING A CONDITION OR QUALITY RATING THAT IS NOT A UAD CODE.
 *
 * There are two vocabularies, and the split is by FORM, not by property type:
 * UAD was mandated for exactly four forms — 1004, 1073, 1075, 2055 — and the
 * 1025 (2-4 unit) was explicitly left out, so its grid condition is the
 * appraiser's own words. A condo on a 1073 carries `C3` exactly like a house;
 * the same 2-4 family used as a comparable ON a 1004 carries `C3` too. So one
 * building can be `C4` on one report and "Average" on another, and both are
 * correct. For a 2-4 unit lender that is not an edge case — it is the book.
 *
 * `properties.condition_rank` is a GENERATED column: the digits of
 * `condition_uad`. A worded rating therefore ranks as NULL, and a property whose
 * only rating is a word is invisible to every condition filter, to the facets
 * and to the valuation's condition adjustment. Measured on the real corpus:
 * 955 properties, 680 with a code, **234 with words only** and 41 with nothing.
 * A quarter of the warehouse.
 *
 * THIS MODULE READS THE WORDS AND REFUSES MOST OF THEM. What it refuses is the
 * point — the corpus contains far more unreadable text than readable, and every
 * refusal below is a real string counted in it:
 *
 *   · A RELATIVE WORD IS ABOUT THAT REPORT'S SUBJECT, NOT ABOUT THE PROPERTY.
 *     `similar` (13), `INFERIOR` (11), `superior` (7), `Inferior 5%` (5),
 *     `Superior 10%` (3) — 45 rows, and the single most common thing in a
 *     non-UAD grid. "Inferior" means inferior TO THE SUBJECT OF THAT REPORT; the
 *     same building is superior on the next report. Reading one as a grade would
 *     file a judgement about a comparison as a fact about a house.
 *   · `Updated` / `Renovated` IS WORK, NOT CONDITION. A cosmetic flip over a
 *     failing roof is still C4.
 *   · A `Q` CODE IN THE CONDITION SLOT IS NOT A CONDITION. `Q2` (4), `Q3` (2),
 *     `Q4` (1) appear in condition text in the real corpus. Q2 is a QUALITY of
 *     construction grade; reading it as C2 would claim a nearly-new building.
 *   · A MATERIAL IS NOT A QUALITY. `BRICK` is a real value in the quality slot,
 *     which is exactly why there can be no default and no fuzzy match.
 *
 * WHAT IT RETURNS, and why each field exists:
 *   code       — set ONLY from a literal C1..C6 / Q1..Q6. Never invented from a
 *                word, so no screen can ever show a code we did not receive.
 *   rank       — 1..6, the ONLY thing anything filters, sorts or adjusts on.
 *   rankLow/High — the span the word actually supports. "Average" is not C4; it
 *                is C3-or-C4 and we happen to lean C4. A spanned word keeps its
 *                span so a filter can be honest about what it cannot separate.
 *   basis      — 'as_is' | 'as_repaired', carried through untouched. A
 *                renovation report's condition describes a house that does not
 *                exist yet.
 *   source     — 'code' | 'word', so a screen can say which it is reading.
 *   original   — always kept and always displayed. The appraiser's own word is
 *                the record; our reading is a convenience laid beside it.
 *   confidence — 'definite' for a code, 'likely' for a plain word, 'weak' for a
 *                word carrying a modifier we can only partly resolve.
 *   why        — why nothing was read, in words a person can act on.
 *
 * PURE. No database, no network — the whole point is that it can be reasoned
 * about and tested exhaustively.
 */
'use strict';

const CONDITION_CODE = /\bC([1-6])\b/i;
const QUALITY_CODE = /\bQ([1-6])\b/i;

// The industry's own words, in the order they must be tried: the LONGEST match
// first, so "average-good" is never read as "average" with a stray "good".
//
// `rank` is the point estimate, `low`/`high` the span the word supports. The
// spans overlap on purpose — that is what the words actually mean, and pretending
// otherwise is how a worded rating becomes a false code.
const WORDS = [
  { re: /\bbelow[\s-]*average\b/, rank: 5, low: 4, high: 5 },
  { re: /\babove[\s-]*average\b/, rank: 3, low: 3, high: 4 },
  { re: /\bvery[\s-]*good\b/, rank: 2, low: 2, high: 3 },
  // "Average-Good" and "Avg-Good" are the SAME rating and must read identically.
  // The first cut spelled this `avg?`, which matches "av"/"avg" but NOT
  // "average" — so the full spelling fell through to plain "good" and the two
  // forms of one word read a whole grade apart on the real corpus.
  { re: /\b(?:avg|average)[\s./+-]*good\b/, rank: 3, low: 3, high: 4 },
  { re: /\bgood[\s./+-]*(?:avg|average)\b/, rank: 3, low: 3, high: 4 },
  { re: /\bexcellent\b/, rank: 1, low: 1, high: 2 },
  { re: /\bgood\b/, rank: 3, low: 2, high: 3 },
  { re: /\baverage\b|\bavg\b/, rank: 4, low: 3, high: 4 },
  { re: /\bfair\b/, rank: 5, low: 4, high: 5 },
  { re: /\bpoor\b/, rank: 6, low: 5, high: 6 },
];

// A RELATIVE WORD IS NEVER A GRADE. Matched on the WHOLE remaining text rather
// than as a token, because "Inferior 5%" and "Superior 10%" are the shapes the
// corpus actually holds, and a bare "+" or "-" is the same claim with no word
// at all. `same`/`equal` join them: they say this comparable matched the
// subject, which tells us nothing about either.
const RELATIVE = /\b(?:similar|superior|inferior|same|equal|comparable\s+to)\b/i;
const BARE_SIGN = /^[+\-=]+\s*\d*\s*%?$/;
// WORK IS NOT CONDITION.
const WORK = /\b(?:updated|renovated|remodel(?:l?ed|ing)?|rehabbed|modernized)\b/i;

const clamp = (n) => Math.max(1, Math.min(6, n));

/**
 * `+` and `-` are a nudge WITHIN a band, and we cannot know how big a nudge. So
 * they move the POINT ESTIMATE one step and stretch the span toward the
 * neighbouring grade rather than replacing the band outright — "Average+" is
 * still an average building, read at the better end of average.
 *
 * Returned separately from the word match so an unmodified word keeps its exact
 * published span, and so the confidence can drop for a reading we only partly
 * resolved.
 */
function applyModifier(hit, text) {
  const plus = /[+]/.test(text) || /\bplus\b/i.test(text);
  const minus = /(?:\w|\s)-\s*$/.test(text) || /-\s*$/.test(text) || /\bminus\b/i.test(text);
  if (plus === minus) return { ...hit, modified: false };   // neither, or both — leave it alone
  // THE POINT MOVES TO THE EDGE THE MODIFIER NAMES; THE BAND IS NOT REPLACED.
  // Moving the whole reading a full grade made "Average-" come out as FAIR
  // (rank 5, C3–C5) on the real corpus — a building the appraiser called average
  // graded as one with obvious deferred maintenance. A "+" or "-" is a nudge
  // within the band and is read as one: the estimate goes to that end of the
  // word's own span, and only the span's far side stretches by one, so
  // "Average+" (3, C3–C4) reads exactly like "Avg-Good" — which is what the two
  // mean — and "Average-" (4, C4–C5) is still an average building at its worse
  // edge, reaching toward fair.
  if (plus) return { rank: hit.low, low: hit.low, high: hit.rank, modified: true };
  return { rank: hit.high, low: hit.rank, high: clamp(hit.high + 1), modified: true };
}

function blank(original, why, basis, scale) {
  return { code: null, rank: null, rankLow: null, rankHigh: null, scale: scale || null,
    basis: basis || null, source: null, original: original || null, confidence: null, why };
}

/**
 * Read a condition rating. `text` may be a UAD code, a worded rating, both
 * ("C4 / average"), or something that is neither.
 */
function readCondition(text, opts = {}) {
  const basis = opts.basis || null;
  const raw = text == null ? '' : String(text).trim();
  if (!raw) return blank(null, 'no condition was stated', basis, 'C');

  // A LITERAL CODE ALWAYS WINS, including inside a mixed "C4 / average" string —
  // the code is what the appraiser actually graded and the word is corroboration.
  const c = CONDITION_CODE.exec(raw);
  if (c) {
    const rank = Number(c[1]);
    return { code: `C${rank}`, rank, rankLow: rank, rankHigh: rank, basis,
      scale: 'C', source: 'code', original: raw, confidence: 'definite', why: null };
  }

  // A QUALITY CODE IN THE CONDITION SLOT IS NOT A CONDITION. Checked before the
  // word table so a "Q2" can never fall through to something else, and before
  // the relative test so the message names the real problem.
  if (QUALITY_CODE.test(raw)) {
    return blank(raw, 'this is a quality-of-construction grade, not a condition rating', basis, 'C');
  }
  if (RELATIVE.test(raw) || BARE_SIGN.test(raw)) {
    return blank(raw, 'this says how it compared with that report’s subject, not what condition it is in', basis, 'C');
  }

  const lower = raw.toLowerCase();
  const hit = WORDS.find((w) => w.re.test(lower));
  if (!hit) {
    // WORK LAST, so "C3 / updated" is read as C3 and only a text with NOTHING
    // else in it is refused for being about work.
    if (WORK.test(raw)) return blank(raw, 'this describes work that was done, not the condition it is in', basis, 'C');
    return blank(raw, 'this rating is not one we can read', basis, 'C');
  }
  const m = applyModifier(hit, raw);
  return { code: null, rank: m.rank, rankLow: m.low, rankHigh: m.high, basis, scale: 'C',
    source: 'word', original: raw,
    // A MODIFIER IS A PARTIAL READ. We know the direction and not the size, so
    // the reading is offered with less confidence than a plain word.
    confidence: m.modified ? 'weak' : 'likely', why: null };
}

/**
 * Read a quality-of-construction rating. Same shape, and DELIBERATELY STRICTER:
 * the quality slot in a real grid carries construction MATERIALS (`BRICK`,
 * `FRAME`, `VINYL`), so a word table over it would turn a wall into a grade.
 * Only a literal Q code, and the same handful of absolute words, are read.
 */
function readQuality(text, opts = {}) {
  const basis = opts.basis || null;
  const raw = text == null ? '' : String(text).trim();
  if (!raw) return blank(null, 'no quality rating was stated', basis, 'Q');

  const q = QUALITY_CODE.exec(raw);
  if (q) {
    const rank = Number(q[1]);
    return { code: `Q${rank}`, rank, rankLow: rank, rankHigh: rank, basis, scale: 'Q',
      source: 'code', original: raw, confidence: 'definite', why: null };
  }
  // A CONDITION CODE IN THE QUALITY SLOT IS NOT A QUALITY — the mirror of the
  // guard above, and the same reasoning.
  if (CONDITION_CODE.test(raw)) {
    return blank(raw, 'this is a condition rating, not a quality-of-construction grade', basis, 'Q');
  }
  if (RELATIVE.test(raw) || BARE_SIGN.test(raw)) {
    return blank(raw, 'this says how it compared with that report’s subject, not what it is built to', basis, 'Q');
  }
  const lower = raw.toLowerCase();
  const hit = WORDS.find((w) => w.re.test(lower));
  if (!hit) return blank(raw, 'this rating is not one we can read', basis, 'Q');
  const m = applyModifier(hit, raw);
  return { code: null, rank: m.rank, rankLow: m.low, rankHigh: m.high, basis, scale: 'Q',
    source: 'word', original: raw, confidence: m.modified ? 'weak' : 'likely', why: null };
}

/**
 * THE ONE ANSWER A SCREEN OR A FILTER SHOULD USE, given both columns.
 *
 * The code is preferred whenever there is one — it is what the appraiser
 * actually graded — and the words are only read when there is no code. Returns
 * the same shape either way, so nothing downstream needs to know which happened.
 */
function resolveCondition(row, opts = {}) {
  const r = row || {};
  const fromCode = readCondition(r.condition_uad, opts);
  if (fromCode.rank != null) return fromCode;
  const fromWords = readCondition(r.condition_text, opts);
  // A refusal about the WORDS is more useful than "no condition was stated" when
  // words were in fact stated — it says what we saw and could not use.
  return fromWords.rank != null || r.condition_text ? fromWords : fromCode;
}

function resolveQuality(row, opts = {}) {
  const r = row || {};
  const fromCode = readQuality(r.quality_uad, opts);
  if (fromCode.rank != null) return fromCode;
  const fromWords = readQuality(r.quality_text, opts);
  return fromWords.rank != null || r.quality_text ? fromWords : fromCode;
}

/**
 * How to SAY it. The appraiser's own word is the record; our reading is offered
 * beside it, never in place of it — "Average (reads as C3–C4)", never a bare
 * "C4" we were never given.
 */
function describe(read) {
  if (!read || read.rank == null) return null;
  if (read.source === 'code') return read.code;
  // THE SCALE'S OWN LETTER. Printing "C3" beside a quality-of-construction word
  // would state a condition grade the appraiser never gave.
  const L = read.scale === 'Q' ? 'Q' : 'C';
  const span = read.rankLow === read.rankHigh
    ? `${L}${read.rankLow}` : `${L}${read.rankLow}–${L}${read.rankHigh}`;
  return `${read.original} (reads as ${span})`;
}

module.exports = {
  readCondition, readQuality, resolveCondition, resolveQuality, describe,
  _internals: { WORDS, RELATIVE, WORK, applyModifier },
};
