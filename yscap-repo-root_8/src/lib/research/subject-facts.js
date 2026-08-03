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

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const txt = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };

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
    key: 'units', label: 'How many units', kind: 'int',
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
    key: 'gla', label: 'Living area (sq ft)', kind: 'int',
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
    const stated = value != null;
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
  for (const f of FACTS) {
    const then = readValue(confirmedSnapshot, f.key);
    const now = readValue(subject, f.key);
    const same = f.kind === 'int'
      ? (then == null && now == null) || (then != null && now != null && Number(then) === Number(now))
      : String(then == null ? '' : then).trim().toLowerCase()
        === String(now == null ? '' : now).trim().toLowerCase();
    if (!same) changed.push({ key: f.key, label: f.label, was: then, now });
  }
  return { stale: changed.length > 0, changed };
}

/** The subset of a subject a confirmation records — never the whole snapshot. */
function confirmedSnapshotOf(subject) {
  const out = {};
  for (const k of FACT_KEYS) {
    const v = readValue(subject, k);
    if (v != null) out[k] = v;
  }
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
    if (raw === null || raw === '') { out[k] = null; continue; }
    if (f.kind === 'int') {
      const n = num(raw);
      if (n == null || !Number.isFinite(n)) {
        problems.push({ key: k, label: f.label, why: `"${raw}" is not a number` });
        continue;
      }
      if (n < 0) { problems.push({ key: k, label: f.label, why: 'that cannot be negative' }); continue; }
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
  FACTS, FACT_KEYS,
  factsToConfirm, reviewSubject, confirmationStale, confirmedSnapshotOf, cleanCorrections,
  _internals: { readValue, headlineFor },
};
