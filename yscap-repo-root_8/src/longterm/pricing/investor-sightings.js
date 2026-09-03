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

const EMPTY = { boards: {}, searches: {}, investors: {} };

/* ⛔ HOW MANY ANSWERED SEARCHES BEFORE SILENCE MEANS ANYTHING.
   A search is about ONE SCENARIO. An investor absent from one answer has NOT been
   shown to be absent from the sheet — it may simply have no product for that loan.
   The register used to lock a source button the moment a sheet answered ONCE
   without carrying an investor, which is absence of evidence read as evidence of
   absence. MEASURED by the pre-merge audit of 2026-09-03: after a single ordinary
   search, 26 of 26 settings rows had a locked button and 15 had BOTH locked —
   including ClearEdge, one of the five investors the owner had just switched to
   LoanNEX, whose only pressable control was then "Off".

   This number is a THRESHOLD, not a proof: no count of similar scenarios can prove
   a sheet does not carry somebody. It is set where a fresh install cannot lock
   anything (the reported failure) and where a sheet that has answered twenty
   varied searches without ever naming an investor is genuinely worth flagging.
   Erring low costs a wrong lock nobody can work around; erring high costs a
   button somebody may press in vain — and a wrong route is caught and reported by
   the miss register and its super-admin email, which a wrong lock is not. */
const NEVER_AFTER_SEARCHES = 20;

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
  const out = { boards: {}, searches: {}, investors: {} };
  if (stored == null) return { ...out, problems };
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return { ...out, problems: ['The sightings register is not an object; it was ignored.'] };
  }
  const b = stored.boards;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    for (const s of SOURCES) if (isIso(b[s])) out.boards[s] = b[s];
  }
  /* HOW MANY answered boards, per sheet. A register written before this counter
     existed has none; it reads as 0, so it locks nothing until the sheet has
     answered enough NEW searches to earn it. That is the safe direction. */
  const n = stored.searches;
  if (n && typeof n === 'object' && !Array.isArray(n)) {
    for (const s of SOURCES) {
      const v = Number(n[s]);
      if (Number.isFinite(v) && v > 0) out.searches[s] = Math.floor(v);
    }
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
function record(stored, { source, keys, at, answered = true, counts = true } = {}) {
  const cur = read(stored);
  const base = { boards: { ...cur.boards }, searches: { ...cur.searches }, investors: {} };
  for (const [k, v] of Object.entries(cur.investors)) base.investors[k] = { ...v };

  if (!SOURCES.includes(source)) return base;
  if (!answered) return base;
  const when = isIso(at) ? at : new Date(at || Date.now()).toISOString();
  if (!isIso(when)) return base;

  /* ⛔ `counts: false` RECORDS WHAT WAS SEEN WITHOUT COUNTING A SEARCH — and the two
     lines below move TOGETHER, deliberately, so the stated lock-step holds either way.

     ONE PRESS ON THE GENERAL ENGINE IS TWO DOORS (post-merge audit 2026-09-03).
     `LtPricer` fires the immediate board and then the band board on the same press, and
     both now record. Counting that as two searches makes `NEVER_AFTER_SEARCHES` — twenty
     VARIED searches — arrive after about ten presses, so a source button is locked out on
     half the evidence the three-state rule was designed to demand. Locking a button early
     is the one harm that design exists to avoid.

     So the door that knows another is following records its sightings as part of the SAME
     search: the investor keys land (they are a fact about what the sheet carried), and the
     evidence COUNTER is left to the door that finishes the press. The board stamp goes with
     the counter rather than being set alone, or `boards` and `searches` would start
     disagreeing about how much this sheet has actually told us — which is what the comment
     below has always promised they cannot do. */
  if (counts) {
    base.boards[source] = when;
    // Counted per ANSWERED board, which is the same event `boards` timestamps — so the
    // two can never disagree about how much this sheet has actually told us.
    base.searches[source] = (Number(base.searches[source]) || 0) + 1;
  }
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
/**
 * ALWAYS THE READ — the shortcut is gone, and that is the fix rather than a tidy-up.
 *
 * ⛔ IT TRIED TWICE TO ASK "IS THIS ALREADY READ?" AND BOTH ANSWERS WERE WRONG IN THE
 * SAME WAY: they judged the SHAPE and never the CONTENTS.
 *   · `stored[k] === undefined` — an explicit `null` passes, and the next line threw.
 *   · `typeof v === 'object'` — a key holding `{ nqm: { lenderprice: 'not-a-date' } }`
 *     passes, and an UNUSABLE TIMESTAMP then lights a source button and keeps a row on
 *     the settings list. Measured (re-audit 2026-09-03): a bad stamp read as `seen`
 *     through the shortcut and `unknown` through `read`, and `validate()` stores it.
 *
 * There is no third test that is right, because "already read" is not a property of the
 * shape at all — only `read` itself can answer it, and `read` is TOTAL and IDEMPOTENT
 * (its own output fed back in is unchanged). So this asks it every time. The cost is one
 * pass over a small object; the class it closes is every future value nobody validated.
 *
 * ⛔ AND THE SEVERITY IS STATED HONESTLY. An earlier version of this note claimed a throw
 * here "takes down `GET /investors`, the whole settings screen". That is NOT reachable:
 * the one production caller, `investorConfig.sightingsRaw()`, spreads `sightings.read(...)`,
 * so a raw blob never arrives. It was LATENT, exactly as the paragraph beside it said —
 * two paragraphs of one comment contradicting each other, which the re-audit caught. It
 * is worth fixing because this module is exported so the rule can be asked without an
 * HTTP door, not because a screen was falling over.
 */
function availabilityFor(key, stored) {
  const cur = read(stored);
  const row = cur.investors[asKey(key)] || {};
  const out = {};
  for (const s of SOURCES) {
    const searches = cur.searches[s] || 0;
    if (row[s]) out[s] = { state: 'seen', at: row[s] };
    else if (cur.boards[s] && searches >= NEVER_AFTER_SEARCHES) {
      out[s] = { state: 'never', at: null, sourceLastAnswered: cur.boards[s], searches };
    } else if (cur.boards[s]) {
      /* ANSWERED, BUT NOT ENOUGH TIMES TO MEAN ANYTHING. Distinct from `unknown`
         ("no board from that sheet at all") so a screen can word the two honestly,
         and neither locks a button. */
      out[s] = { state: 'not_yet', at: null, sourceLastAnswered: cur.boards[s], searches };
    } else out[s] = { state: 'unknown', at: null, searches };
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
 * ⛔ ONLY A PROVEN `never` LOCKS, and `never` now takes real evidence (see
 * `NEVER_AFTER_SEARCHES`). `unknown` is "no board from that sheet at all" and `not_yet` is
 * "it has answered, but not enough times for its silence to mean anything"; locking on either
 * would leave every button dead on a fresh install — including the five investors the owner
 * switched over, which is exactly what was measured.
 *
 * ⛔ AND THE SOURCE AN INVESTOR IS ACTUALLY SET TO IS NEVER LOCKED. You cannot lock the door
 * somebody is standing in: a row routed to LoanNEX whose LoanNEX button is dead cannot be
 * turned off and back on, cannot be re-routed, and reads as broken. `currentSource` is the
 * setting in force for this investor; passing it is what makes that guarantee, and a caller
 * that omits it gets the evidence rule alone.
 *
 * It lives here rather than in the route so the rule is callable, and testable, without an
 * HTTP door.
 */
function lockedOutFor(key, stored, currentSource) {
  const a = availabilityFor(key, stored);
  const inUse = typeof currentSource === 'string' ? currentSource : null;
  return SOURCES.filter((s) => a[s].state === 'never' && s !== inUse);
}

/** Every investor key the register has ever seen, on either source. */
function keysSeen(stored) {
  const cur = read(stored);
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
  read, record, availabilityFor, lockedOutFor, keysSeen, validate, NEVER_AFTER_SEARCHES,
  _internals: { isIso, newestOf },
};
