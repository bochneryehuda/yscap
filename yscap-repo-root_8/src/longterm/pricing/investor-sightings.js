'use strict';
/**
 * WHICH RATE SHEET HAS ACTUALLY PRODUCED THIS INVESTOR — the register behind the
 * side-by-side list's "available on" column, and behind the locked-out button.
 *
 * ── THE OWNER'S INSTRUCTION, IN WRITING ────────────────────────────────────
 * 2026-09-03, on the side-by-side investor list in the General Pricing Engine's
 * settings — first, what the list must show:
 *
 *   *"the white labelled name, which systems that investor is available on,
 *   three buttons on the right… price from Lender Price, price from LoanNEX, or
 *   turn off this investor."*
 *
 * …then, answering directly what happens when an investor exists on only one:
 *
 *   *"the other option is locked out, but the investor can always be turned
 *   off."*
 *
 * …and then, the reason this is a REGISTER and not a hand-written table:
 *
 *   *"If you see a new investor populating in any of the systems, just add that
 *   to the list, to the side by side, for which investor populates. Let the
 *   person turn it on and select the holdback and select the white label name
 *   and whatever."*
 *
 * ── WHY IT IS RECORDED FROM REAL BOARDS AND NEVER WRITTEN DOWN ─────────────
 * "Available on Lender Price" is not a fact anybody can type correctly for long.
 * Vendors add and drop investors; ClearEdge appeared on LoanNEX between one
 * measurement and the next, and Acra answers in Connecticut but not in New
 * Jersey. A table of who-is-on-what would be a SECOND roster beside the two real
 * ones, and the one that drifts is the one somebody prices a loan on.
 *
 * So this holds only what was MEASURED: every board the engine asks for stamps
 * the investors that came back, per source, with the moment they did. Nothing is
 * inferred and nothing is invented.
 *
 * ── THE THREE ANSWERS, AND WHY "NEVER" IS NOT "UNKNOWN" ────────────────────
 * A button is locked out only on positive evidence, which is the whole reason
 * these are three states rather than a boolean:
 *
 *   · `seen`    — that source has produced this investor. The button is live.
 *   · `never`   — that source HAS answered boards, and this investor was on none
 *                 of them. The button is locked out.
 *   · `unknown` — that source has produced no board yet, so we know nothing. The
 *                 button stays live, quietly marked "not seen yet".
 *
 * ⛔ A COLD REGISTER MUST NOT LOCK EVERYTHING. On a fresh install nothing has
 * been priced, so a two-state version of this would lock every button on every
 * row — including the five investors the owner named — and the screen would be
 * unusable exactly when somebody first opens it. `unknown` is that guard, and it
 * is why the distinction is carried rather than collapsed.
 *
 * ⛔ AND "OFF" IS NEVER LOCKED. The owner's rule, verbatim above: whatever the
 * register says, an investor can always be turned off. Nothing here can produce
 * a row that cannot be switched off.
 *
 * PURE: no network, no database, no clock of its own — the caller passes `at`.
 */

/** The settings key the register lives under. One name, used by every caller. */
const SETTING_KEY = 'pricing.investorSightings';

/** The sources a sighting may be recorded against — the two rate sheets, and only those. */
const SOURCES = ['lenderprice', 'loannex'];

/**
 * How many investors the register will hold. A vendor adding rows is not ours to
 * limit, but a settings ROW that grows without bound is: past this, the oldest
 * sightings are dropped and the newest kept, because a register that refused to
 * write would silently stop learning about new investors — the one thing it is for.
 */
const MAX_INVESTORS = 500;

const EMPTY = { boards: {}, investors: {} };

const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
const asKey = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The stored value, read into a shape a caller can trust.
 *
 * NON-THROWING AND SELF-REPORTING, like every other read in this family: a
 * register that cannot be parsed costs the "available on" column, never a board.
 */
function read(stored) {
  const problems = [];
  const out = { boards: {}, investors: {} };
  if (stored == null) return { ...out, problems };
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return { ...out, problems: ['The sightings register is not an object; it was ignored.'] };
  }
  const b = stored.boards;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    for (const s of SOURCES) if (isIso(b[s])) out.boards[s] = b[s];
  }
  const inv = stored.investors;
  if (inv && typeof inv === 'object' && !Array.isArray(inv)) {
    for (const [k, v] of Object.entries(inv)) {
      const key = asKey(k);
      if (!key) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(`Sighting for "${key}" is not an object; it was ignored.`); continue; }
      const row = {};
      for (const s of SOURCES) if (isIso(v[s])) row[s] = v[s];
      if (Object.keys(row).length) out.investors[key] = row;
    }
  }
  return { ...out, problems };
}

/** The newest timestamp anywhere on a row — how "oldest first" is decided when trimming. */
function newestOf(row) {
  let best = 0;
  for (const s of SOURCES) if (row[s]) best = Math.max(best, Date.parse(row[s]) || 0);
  return best;
}

/**
 * Record that ONE source's board came back carrying these investor keys.
 *
 * Pure: takes the current stored value and returns the next one. The caller owns
 * the clock and the write, so this can be unit-tested to the millisecond and so a
 * failed write costs nothing but a stamp.
 *
 * ⛔ THE BOARD STAMP IS SET EVEN WHEN THE LIST IS EMPTY, and that is the point of
 * it: "that sheet answered and had nobody" is exactly the evidence that turns
 * `unknown` into `never`. Dropping it would leave a source that consistently
 * returns nothing looking merely unmeasured for ever.
 *
 * ⛔ AND IT IS NOT SET WHEN THE SOURCE DID NOT ANSWER AT ALL. A vendor outage is
 * not evidence about any investor; passing `answered: false` records nothing, so
 * an hour of LoanNEX being down can never lock out five investors.
 */
function record(stored, { source, keys, at, answered = true } = {}) {
  const cur = read(stored);
  const base = { boards: { ...cur.boards }, investors: {} };
  for (const [k, v] of Object.entries(cur.investors)) base.investors[k] = { ...v };

  if (!SOURCES.includes(source)) return base;
  if (!answered) return base;
  const when = isIso(at) ? at : new Date(at || Date.now()).toISOString();
  if (!isIso(when)) return base;

  base.boards[source] = when;
  for (const raw of keys || []) {
    const key = asKey(raw);
    if (!key) continue;
    base.investors[key] = { ...(base.investors[key] || {}), [source]: when };
  }

  const entries = Object.entries(base.investors);
  if (entries.length > MAX_INVESTORS) {
    entries.sort((a, b) => newestOf(b[1]) - newestOf(a[1]));
    base.investors = Object.fromEntries(entries.slice(0, MAX_INVESTORS));
  }
  return base;
}

/**
 * What we know about one investor on each source: `seen`, `never` or `unknown`.
 * See the three-state note at the top — `never` is the only one that locks a button.
 */
function availabilityFor(key, stored) {
  const cur = stored && stored.boards !== undefined && stored.investors !== undefined
    ? stored : read(stored);
  const row = cur.investors[asKey(key)] || {};
  const out = {};
  for (const s of SOURCES) {
    if (row[s]) out[s] = { state: 'seen', at: row[s] };
    else if (cur.boards[s]) out[s] = { state: 'never', at: null, sourceLastAnswered: cur.boards[s] };
    else out[s] = { state: 'unknown', at: null };
  }
  return out;
}

/**
 * WHICH SOURCE BUTTONS ARE LOCKED OUT FOR THIS INVESTOR — the owner's rule, in one function.
 *
 * *"the other option is locked out, but the investor can always be turned off."* So this returns
 * only SOURCES, and `off` is not one — nothing here can ever produce a row that cannot be
 * switched off.
 *
 * ⛔ ONLY A PROVEN `never` LOCKS. An `unknown` is "no board from that sheet yet", and locking on
 * it would leave every button dead on a fresh install — including the five investors the owner
 * switched over. It lives here rather than in the route so the rule is callable, and testable,
 * without an HTTP door.
 */
function lockedOutFor(key, stored) {
  const a = availabilityFor(key, stored);
  return SOURCES.filter((s) => a[s].state === 'never');
}

/** Every investor key the register has ever seen, on either source. */
function keysSeen(stored) {
  const cur = stored && stored.investors !== undefined ? stored : read(stored);
  return Object.keys(cur.investors).sort();
}

/** The settings door's check. A register that cannot be read is refused rather than stored. */
function validate(v) {
  if (v == null) return { ok: true, value: EMPTY, problems: [] };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, value: v, problems: ['The sightings register must be an object.'] };
  }
  const r = read(v);
  return { ok: r.problems.length === 0, value: v, problems: r.problems };
}

module.exports = {
  SETTING_KEY, SOURCES, MAX_INVESTORS, EMPTY,
  read, record, availabilityFor, lockedOutFor, keysSeen, validate,
  _internals: { isIso, newestOf },
};
