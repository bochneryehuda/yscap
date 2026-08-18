'use strict';
/**
 * LONG-TERM — does this property cover its own debt service?
 *
 * The DSCR is the number a long-term file is underwritten on, and the file screen
 * has shown it as a bare figure: 1.28 means one thing to somebody who works these
 * loans every day and nothing at all to anybody else. Meanwhile the settings
 * registry has carried this company's own MINIMUM ("below this the property does
 * not cover its own debt service") and COMFORTABLE thresholds since it was
 * written, and nothing read either of them.
 *
 * SO THIS JUDGES THE RATIO AGAINST WHAT THE COMPANY SET, AND SAYS WHICH. It is not
 * a rule of its own — it compares a measured figure to a configured number and
 * reports which side of it the figure fell, with the threshold itself carried
 * along so a screen can say "below the 1.00 minimum this company set" rather than
 * pronouncing on the loan. A buyer who works to 1.10 changes the setting and every
 * verdict moves with it.
 *
 * IT NEVER JUDGES A RATIO WE DO NOT HAVE. A missing DSCR returns null, not
 * "below" — the whole long-term side keeps "we have not read it" and "it is bad"
 * apart, and this is the one place where confusing them would put a red mark on a
 * loan nobody has measured.
 *
 * PURE. No database, no settings load, no requires — hand it the ratio and the
 * settings object.
 */

/** The registry's own defaults, so a caller with no settings still gets the shipped rule. */
const DEFAULT_MINIMUM = 1.0;
const DEFAULT_COMFORT = 1.2;

/**
 * A configured threshold, or the shipped one.
 *
 * THE TYPE IS TESTED BEFORE THE CONVERSION, and it is not belt-and-braces: the
 * `> 0` test below refuses `Number(null)`, `Number('')`, `Number(false)` and
 * `Number([])` on its own, because all four are a perfectly finite 0 — but it
 * WELCOMES `Number(true)` as a minimum of 1.00, `Number([1.15])` as 1.15, and a
 * Date as a minimum of about 1.79 trillion, which would put every loan this
 * company writes below its own floor. A settings registry is a jsonb column with
 * an admin screen on the front of it; none of those three is exotic. Two of them
 * are pinned by the suite so this line can be proven to bite.
 *
 * A blank string needs NO line of its own: `Number('')` and `Number('   ')` are
 * both 0, so the `> 0` test already sends them to the fallback. One rule, one
 * test — a second guard nothing could ever reach would read as protection and be
 * nothing of the kind.
 */
function threshold(raw, fallback) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return { value: fallback, configured: false };
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? { value: n, configured: true }
    : { value: fallback, configured: false };
}

/**
 * `{ level, minimum, comfort }` — or null when there is no ratio to judge.
 *
 * `level` is one of:
 *   'below'       — under the company's minimum: the property does not cover its
 *                   own debt service on the figures we hold.
 *   'thin'        — over the minimum but under the comfortable line.
 *   'comfortable' — at or over it.
 */
function dscrVerdict(ratio, settings) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;

  const s = settings || {};
  const min = threshold(s['dscr.minimumRatio'], DEFAULT_MINIMUM);
  const com = threshold(s['dscr.comfortRatio'], DEFAULT_COMFORT);
  const minimum = min.value;
  // A comfortable line BELOW the minimum is a misconfiguration, not an opinion:
  // it would make "thin" impossible and "comfortable" start under the floor. The
  // minimum wins, so the worst a bad pair can do is collapse two verdicts into
  // one rather than call a failing loan comfortable.
  const comfort = Math.max(minimum, com.value);

  let level = 'comfortable';
  if (ratio < minimum) level = 'below';
  else if (ratio < comfort) level = 'thin';

  return {
    level,
    minimum,
    comfort,
    // WHOSE NUMBER IS THIS. Both screens worded the verdict "under the 1 minimum
    // THIS COMPANY SET" — true when they set one, and a plain falsehood when they
    // did not, or when the settings read was degraded and the shipped default was
    // all we had. A red mark on a loan, attributed to a rule the company never
    // wrote, is the same mistake as the personal settings screen reading "does
    // this differ from ours" as "did they choose": the value and its AUTHORSHIP
    // are two questions, and only one of them was being answered.
    //
    // A comfortable line raised to meet the minimum is no longer the company's
    // number either, whatever they configured — so it is reported as ours.
    minimumIsCompany: min.configured,
    comfortIsCompany: com.configured && com.value >= minimum,
  };
}

module.exports = { dscrVerdict, DEFAULT_MINIMUM, DEFAULT_COMFORT, _internals: { threshold } };
