'use strict';
/**
 * "THE SYSTEM SAYS" → "I CHECKED" — the facts a value is most sensitive to, and
 * what silently does not happen when one of them is missing.
 *
 * A build-your-own valuation reads its subject out of the warehouse, and the
 * warehouse read it out of somebody's appraisal. That is usually right and is
 * never CONFIRMED, so a number an officer is about to quote rests on a fact
 * nobody has looked at. This module is the step that fixes that: it names the
 * handful of facts the grid is actually sensitive to, says in words what each one
 * moves, and — the part that matters most — says what is NOT being adjusted for at
 * all because the fact is missing.
 *
 * ─── WHY MISSING IS THE INTERESTING CASE ───────────────────────────────────────
 *
 * A WRONG fact produces a wrong number, which at least looks like a number
 * somebody can argue with. A MISSING fact produces a grid with a line simply
 * absent — and an absent line reads exactly like "no adjustment was needed". Two
 * examples, both real in this codebase:
 *
 *  · WITHOUT LIVING AREA, four adjustments vanish at once. `suggestAdjustments`
 *    multiplies the bedroom, bathroom AND condition rates by the subject's own
 *    square footage (`* sg`), and skips the size line entirely — so a subject with
 *    no stated GLA gets a grid with no size, no room-count and no condition
 *    adjustment, and the value is simply the average of the raw sale prices. It
 *    still prints a confident figure.
 *
 *  · WITHOUT A UNIT COUNT the comparable search cannot band, which is the owner's
 *    own first rule: "there shouldn't be a possibility that you should see a
 *    comparable in your system that doesn't have how many units the property is …
 *    if it's a 2 to 4 then all the comparables are two to 4."
 *
 * ─── THE CONFIRMATION HAS TO BE ABLE TO GO STALE ──────────────────────────────
 *
 * A stamp saying "checked" that survives the fact being changed afterwards is
 * worse than no stamp: it launders an unchecked number as a checked one.
 * `confirmationStale` compares the CONFIRMED values to the current ones and says
 * which moved, so the screen can say "this was confirmed, and the living area has
 * changed since".
 *
 * Pure — no database, no network, no clock beyond what is passed in.
 */

/**
 * A NUMBER, OR NOTHING — and "nothing" includes everything that LOOKS like a
 * number after the punctuation comes off but is not one.
 *
 * `Number('')` is 0, so stripping `$ , and whitespace` and handing the remainder
 * to Number turned '   ', '\t', '$' and ',' into a living area of ZERO — filed
 * with a 200 and a "checked by a person" badge, on a valuation with no size, room
 * or condition adjustment behind it. This module's own docstring says that is what
 * it refuses ("quietly reading it as 2400, or as 0, is how a typo becomes a
 * valuation"), and it was doing it. Reachable from the panel by clearing the box
 * with a space instead of a backspace.
 *
 * INTERNAL WHITESPACE IS REFUSED TOO. ' 12 34 ' silently became 1234 — a
 * fat-fingered space turning into a plausible wrong number is worse than a
 * refusal, because nobody looks twice at a plausible number. Only a leading or
 * trailing trim is forgiven.
 *
 * And `Number` accepts '0x10' (16), '1e5' and 'Infinity'; a living area is typed
 * in digits, so the shape is checked rather than left to the coercion.
 */
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;
/**
 * EMPTY MEANS WHAT THE PERSON CAN SEE IS EMPTY — and nothing more.
 *
 * `.trim()` already removes the space, the tab, the non-breaking space, the BOM
 * and the ideographic space. It does NOT remove the ZERO-WIDTH SPACE (U+200B is
 * category Cf, not Zs) or its neighbours, which a paste out of a web page or a
 * PDF carries far more often than any of those — and a box holding one LOOKS
 * empty while refusing with `"​" is not a number`, which renders on screen as
 * `"" is not a number`: a complaint about nothing at all.
 *
 * SO INVISIBLE IS BLANK, AND VISIBLE IS NOT. A "$" or a "," left in the box is
 * something the person can SEE, so it is a typo to point at — never a licence to
 * DELETE a fact they never asked to delete. Clearing `units` is a real answer
 * ("we do not know") with real consequences downstream, and it must be something
 * somebody chose, not something a stray keystroke did on their behalf. The
 * refusal names what to do instead.
 */
/* The characters that render as NOTHING and are not whitespace, so `.trim()`
   leaves them behind. The SOFT HYPHEN (U+00AD) leads the list deliberately: it is
   the single most common artifact of copying out of a PDF — the exact scenario
   this exists for — and the first cut of this class missed it, along with the
   left/right marks a Word or web paste carries routinely. `​-‏` covers
   the zero-width trio plus both directional marks in one range. */
const INVISIBLE_RE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const visible = (v) => String(v).replace(INVISIBLE_RE, '').trim();
/** What is left once the currency sign and thousands commas come off. */
const strippedForNumber = (v) => visible(v).replace(/[$,]/g, '');
/* Nothing but punctuation and space — visible, so never blanked; never an answer
   either. ALL punctuation and symbols, not the two the number reader happens to
   strip: the first cut knew only `$` and `,`, so a "." — a likelier stray
   keystroke than either — was still STORED as the property type, which reads as a
   stated fact and hides the "not stated" warning. Every real value carries a
   letter or a digit, so none of them is caught. */
const punctuationOnly = (s) => s.replace(/[\p{P}\p{S}\s]/gu, '') === '';
const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = strippedForNumber(v);
  if (t === '' || !NUMERIC_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/* Through `visible()`, not a bare trim: a paste of "​Single Family" is not
   blank and must not be, but STORING the zero-width space makes the value differ
   from "Single Family" for `sameFactValue` — so the confirmation reads stale the
   instant it is made, and the type matches no comparable. */
const txt = (v) => { const s = v == null ? '' : visible(v); return s === '' ? null : s; };

/**
 * THE FACTS, IN THE ORDER THEY MATTER — and the order is not arbitrary.
 *
 * `units` and `property_type` come first because they decide which comparables
 * are ELIGIBLE at all; getting them wrong does not adjust a number, it values the
 * property against the wrong kind of building. `gla` is next because four separate
 * adjustments hang off it. Condition, beds and baths follow: each moves one line.
 *
 * `drives` is what the fact does when it is there. `without` is what stops
 * happening when it is not — written as the consequence, because "GLA is missing"
 * is not information an officer can act on and "no size, room-count or condition
 * adjustment is being made, so this is an average of the raw sale prices" is.
 */
const FACTS = Object.freeze([
  {
    key: 'units', label: 'How many units', kind: 'int', zeroIsBlank: true,
    drives: 'which sales are eligible at all — a 2-4 unit property is only ever compared with 2-4 unit sales',
    without: 'the search cannot band by unit count, so single families and 2-4 unit buildings can be mixed '
      + 'into one answer',
    critical: true,
  },
  {
    key: 'property_type', label: 'What kind of property', kind: 'text',
    drives: 'which sales are eligible, alongside the unit count',
    without: 'nothing is holding the comparables to the same kind of building',
    critical: true,
  },
  {
    key: 'gla', label: 'Living area (sq ft)', kind: 'int', zeroIsBlank: true,
    drives: 'the size adjustment, and it is the multiplier on the bedroom, bathroom and condition adjustments too',
    without: 'no size, room-count or condition adjustment is being made at all — the value is close to a plain '
      + 'average of the sale prices',
    critical: true,
  },
  {
    key: 'condition_uad', label: 'Condition', kind: 'grade',
    drives: 'the condition adjustment against each sale',
    without: 'no condition adjustment is being made, so a tired house and a renovated one count the same',
  },
  {
    key: 'beds', label: 'Bedrooms', kind: 'int',
    drives: 'part of the room-count adjustment',
    without: 'the room-count adjustment ignores bedrooms',
  },
  {
    key: 'baths_full', label: 'Full bathrooms', kind: 'int',
    drives: 'part of the room-count adjustment',
    without: 'the room-count adjustment ignores bathrooms',
  },
  {
    key: 'baths_half', label: 'Half bathrooms', kind: 'int',
    drives: 'part of the room-count adjustment',
    without: 'a half bathroom is not counted',
    optional: true,          // a property with none is normal; blank is not a gap
  },
  {
    key: 'year_built', label: 'Year built', kind: 'int',
    drives: 'nothing in the grid today — it is here because an officer reading the facts should see it',
    without: 'nothing changes; no adjustment uses it yet',
    optional: true,
  },
]);

/** The keys a confirmation records, in order. */
const FACT_KEYS = Object.freeze(FACTS.map((f) => f.key));

/* WHAT IS TOO BIG TO BE THAT FACT. Generous — this is a refusal for a pasted phone
   number or a doubled digit, not a plausibility opinion about a large house. */
const MAX = Object.freeze({
  units: 999, gla: 1000000, beds: 99, baths_full: 99, baths_half: 99, year_built: 2200,
  property_type: Infinity, condition_uad: Infinity,
});

const readValue = (subject, key) => {
  const s = subject || {};
  const raw = s[key];
  if (raw == null || raw === '') return null;
  const f = FACTS.find((x) => x.key === key);
  if (f && f.kind === 'int') return num(raw);
  return txt(raw);
};

/**
 * The facts to walk through, each with its value and what it is doing.
 *
 * `stated` is the honest word rather than "valid": we are not judging whether a
 * living area of 900 is plausible, only whether anybody has told us one. A blank
 * OPTIONAL fact is not a gap — a house with no half bathroom has none, and
 * badging that as missing trains people to click past the badges that matter.
 */
function factsToConfirm(subject) {
  return FACTS.map((f) => {
    const value = readValue(subject, f.key);
    /* ZERO IS NOT AN ANSWER FOR THE FACTS THE GRID GATES ON TRUTHINESS.
       `suggestAdjustments` reads `const sg = num(subject.gla)` and then gates the
       size, room-count and condition lines on `sg` being TRUTHY — so a living area
       of 0 produces exactly the same silent grid as a missing one, while a plain
       `!= null` test reported it as stated and the panel announced the opposite of
       what was happening. Same for the unit count, which bands the search. A half
       bathroom of 0 and a year built of 0 are different: the first is a real
       answer, the second is nonsense nobody stores. */
    const stated = f.zeroIsBlank ? (value != null && Number(value) > 0) : value != null;
    return {
      key: f.key,
      label: f.label,
      kind: f.kind,
      value,
      stated,
      critical: !!f.critical,
      optional: !!f.optional,
      // A gap worth showing: not stated, and not one of the ones that are
      // legitimately blank.
      gap: !stated && !f.optional,
      drives: f.drives,
      without: f.without,
    };
  });
}

/**
 * Everything the screen needs to decide how loudly to speak, in one object.
 *
 * `blindSpots` is the list that earns this whole module: the facts that are
 * missing AND whose absence removes an adjustment. `readyToTrust` is deliberately
 * NOT "no gaps" — a research valuation on a property we know little about is a
 * legitimate thing to build; it is a value nobody has LOOKED at that is not.
 */
function reviewSubject(subject, opts = {}) {
  const facts = factsToConfirm(subject);
  const gaps = facts.filter((f) => f.gap);
  const blindSpots = gaps.filter((f) => f.critical);
  const confirmedAt = opts.confirmedAt || null;
  const stale = confirmationStale(subject, opts.confirmedSnapshot, confirmedAt);
  return {
    facts,
    gaps: gaps.map((f) => f.key),
    blindSpots: blindSpots.map((f) => f.key),
    confirmed: !!confirmedAt && !stale.stale,
    confirmedAt,
    confirmedBy: opts.confirmedBy || null,
    stale,
    // The one sentence a screen leads with.
    headline: headlineFor(gaps, blindSpots, confirmedAt, stale),
  };
}

function headlineFor(gaps, blindSpots, confirmedAt, stale) {
  if (stale && stale.stale) {
    return `Somebody confirmed these facts, but ${stale.changed.length === 1 ? 'one of them has' : `${stale.changed.length} of them have`} `
      + 'changed since — worth another look before this number is quoted.';
  }
  if (blindSpots.length) {
    return `${blindSpots.length === 1 ? 'One fact is' : `${blindSpots.length} facts are`} missing that the value `
      + 'genuinely depends on, and their adjustments are simply not being made. Fill them in, or read the value '
      + 'knowing that.';
  }
  if (gaps.length) {
    return `Everything the value leans on is here. ${gaps.length === 1 ? 'One smaller fact is' : `${gaps.length} smaller facts are`} `
      + 'blank, which costs one adjustment line each.';
  }
  if (confirmedAt) return 'A person has checked these facts against the property, and none has changed since.';
  return 'Every fact the value leans on is stated. Nobody has confirmed them against the property yet.';
}

/**
 * HAS A CONFIRMED FACT MOVED SINCE? A stamp that survives the fact changing is
 * worse than no stamp — it launders an unchecked number as a checked one.
 *
 * Compared by MEANING, not by spelling: 2400 and "2400" are the same living area,
 * and re-badging a valuation stale because a number arrived as a string would
 * train people to ignore the badge.
 */
function confirmationStale(subject, confirmedSnapshot, confirmedAt) {
  if (!confirmedAt || !confirmedSnapshot || typeof confirmedSnapshot !== 'object') {
    return { stale: false, changed: [] };
  }
  const changed = [];
  // THE PROPERTY ITSELF FIRST. A confirmation is about a house, and a valuation
  // whose subject was re-pointed at a different address is not the thing that was
  // checked — however identical its bedroom count happens to be.
  /* BOTH SIDES THROUGH `txt()`, or the comparison is lopsided. Once `txt()` began
     stripping invisible characters, a snapshot written BEFORE that whose stored
     address carried one would mismatch its own unchanged self forever — the panel
     printing "was 12 Elm St, is now 12 Elm St", a warning nobody can act on and
     only re-confirming can clear. That is the born-stale defect this file already
     fixed once, relocated to the address. */
  const thenAddr = txt((confirmedSnapshot || {})[IDENTITY_KEY]);
  const nowAddr = txt((subject || {}).display_address);
  if (thenAddr && String(thenAddr).trim().toLowerCase() !== String(nowAddr || '').trim().toLowerCase()) {
    changed.push({ key: 'display_address', label: 'The property', was: thenAddr, now: nowAddr });
  }
  for (const f of FACTS) {
    const then = readValue(confirmedSnapshot, f.key);
    const now = readValue(subject, f.key);
    if (!sameFactValue(f, then, now)) changed.push({ key: f.key, label: f.label, was: then, now });
  }
  return { stale: changed.length > 0, changed };
}

/**
 * ARE THESE THE SAME ANSWER? ONE definition, exported, because there were two.
 *
 * The confirm route compared with `String(a) !== String(b)` while this module
 * compared ints numerically and text case-insensitively — so correcting a property
 * type from "Single Family" to "single family" counted as a CHANGE at the door
 * (a full re-derive, `market_rates` rewritten, the officer told "1 fact was
 * corrected") and as IDENTICAL here. Sameness is by MEANING, in one place.
 */
function sameFactValue(f, a, b) {
  if (f.kind === 'int') {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Number(a) === Number(b);
  }
  return String(a == null ? '' : a).trim().toLowerCase()
    === String(b == null ? '' : b).trim().toLowerCase();
}

/**
 * The subset of a subject a confirmation records — never the whole snapshot.
 *
 * IT RECORDS WHICH PROPERTY WAS CHECKED, not only what was checked about it.
 * Without the address, confirming the facts of 12 Elm St and then editing the
 * subject to 900 Ocean Ave left the stamp standing: no FACT had moved, so the
 * screen said "a person has checked these facts against the property, and none
 * has changed since" — about a different property. That is the laundering the
 * whole staleness design exists to prevent, walking in through the door next to
 * it.
 */
const IDENTITY_KEY = '__address';
function confirmedSnapshotOf(subject) {
  const out = {};
  for (const k of FACT_KEYS) {
    const v = readValue(subject, k);
    if (v != null) out[k] = v;
  }
  const addr = txt((subject || {}).display_address);
  if (addr) out[IDENTITY_KEY] = addr;
  return out;
}

/**
 * Clean a set of corrections into the shape `subject_snapshot` stores.
 *
 * REFUSES rather than coerces: a living area of "about 2400" is not a number, and
 * silently reading it as 2400 (or as 0) is how a typo becomes a valuation. An
 * explicit blank CLEARS the fact, because "we do not actually know" is an answer a
 * person is allowed to give — and a cleared fact then shows up as a blind spot,
 * which is exactly right.
 */
function cleanCorrections(input) {
  const out = {}, problems = [];
  for (const [k, raw] of Object.entries(input || {})) {
    const f = FACTS.find((x) => x.key === k);
    if (!f) continue;                                   // not a fact we confirm
    // A NON-STRING IS NOT AN ANSWER. `String({})` is "[object Object]" and
    // `String(['a','b'])` is "a,b"; both used to be filed as the property type.
    if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
      problems.push({ key: k, label: f.label, why: 'that is not something this field holds' });
      continue;
    }
    // BLANK IS BLANK, however it is spelled — a box cleared with a space instead
    // of a backspace, or holding only characters that render as nothing, is "we
    // do not know". A box the person can SEE something in is never blanked for
    // them; see `visible()`.
    if (raw === null || visible(raw) === '') { out[k] = null; continue; }
    /* PUNCTUATION IS ITS OWN ANSWER, FOR EVERY KIND OF FACT — and it has to sit
       ABOVE the kind branch, because the first cut guarded only numbers and the
       text branch then took the third and worst option: it STORED it. A property
       type of "$" is not blank and not refused, it is a stated fact — so
       `factsToConfirm` reads the type as answered, the panel stops printing the
       red "what kind of property is not stated" line, and every comparable scores
       zero on a type match against a dollar sign. `property_type` is one of the
       two facts the owner said may never be unknown on a comparable.
       Interior whitespace counts as nothing here too, or "$," and "$ ," — the
       same typo with a stray space — would get two different answers. */
    const shown = visible(raw);
    if (punctuationOnly(shown)) {
      problems.push({ key: k, label: f.label,
        // CAPPED, like every other refusal here. Uncapped, a pasted 100,000-character
        // run of "$" came back twice in one 400 — as `error` and again in `problems`.
        why: `that box has only punctuation ("${shown.slice(0, 40)}") in it — clear it completely to say we do not know` });
      continue;
    }
    if (f.kind === 'int') {
      const n = num(raw);
      if (n == null || !Number.isFinite(n)) {
        problems.push({ key: k, label: f.label, why: `"${shown.slice(0, 40)}" is not a number` });
        continue;
      }
      if (n < 0) { problems.push({ key: k, label: f.label, why: 'that cannot be negative' }); continue; }
      // A CEILING, because there was none. A pasted phone number as a living area
      // is not a refusal anybody would think to write, and it reaches a
      // numeric(8,2) adjustment percentage as an overflow three layers down.
      if (n > MAX[f.key]) {
        problems.push({ key: k, label: f.label, why: `that is larger than a ${f.label.toLowerCase()} can be` });
        continue;
      }
      out[k] = Math.round(n);
    } else {
      const s = txt(raw);
      if (s == null) { out[k] = null; continue; }
      if (s.length > 120) { problems.push({ key: k, label: f.label, why: 'that is longer than this field holds' }); continue; }
      out[k] = s;
    }
  }
  return { values: out, problems };
}

module.exports = {
  FACTS, FACT_KEYS, MAX,
  factsToConfirm, reviewSubject, confirmationStale, confirmedSnapshotOf, cleanCorrections,
  sameFactValue,
  _internals: { readValue, headlineFor, num },
};
