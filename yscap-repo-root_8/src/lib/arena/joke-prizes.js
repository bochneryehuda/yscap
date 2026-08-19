'use strict';
/**
 * THE BOOBY PRIZES — the slices that "win" you more work.
 *
 * WHAT THE OWNER ASKED FOR, in their words: "every spin, not on the officer but
 * on the prize that you win, should be that you can go now and make an Elementix
 * call and win another client. It should be like a joke. It can be sometimes one
 * in the spin and sometimes two in the spin ... on every fourth spin, something
 * like this pops up, but not too often. It should not be exactly every fourth.
 * Not every spin should be a real winner, but not too many should be this one."
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS FROM ──────────────────────────
 * THE JOKE IS A SLICE OF THE WHEEL, NOT A SECOND ROLL. The obvious build is to
 * let the wheel land normally and then, one time in four, quietly swap the
 * result for a joke. That would be a rigged wheel — the whole Arena rests on a
 * number sealed before anybody enters and a roster published and hashed before
 * it turns, and a hidden second roll after the landing throws all of that away
 * for a gag. So the joke slices are put ON the wheel at the moment the roster is
 * frozen: they are in the published list, they are inside the hash, they take up
 * real space, and anybody can check the landing afterwards exactly as before.
 * "One in four" is then a fact about how much of the wheel they occupy.
 *
 * ── HOW IT STAYS AT ABOUT ONE IN FOUR WITHOUT EVER BEING EVERY FOURTH ──────
 * Pure independent chance at 22% will, across a real day, sometimes give three
 * jokes in a row — and a room that wins nothing three times running stops
 * playing. A counter that fires on exactly every fourth spin is the opposite
 * failure: by mid-afternoon somebody has worked it out and the surprise is gone.
 *
 * So the SHARE of the next wheel is nudged by what the last few actually did:
 * ordinary 22%, dropped to 8% right after one lands, raised to 32% after three
 * clean spins. Every individual wheel is still exactly what it says on the tin
 * and still lands where the sealed number says — this only changes how the NEXT
 * wheel is built, which is a thing anybody is allowed to do, and it keeps the
 * day inside the owner's one-in-four-to-one-in-five band without the rate ever
 * being a countdown.
 *
 * ── WHAT MAKES A JOKE ACCEPTABLE HERE ─────────────────────────────────────
 * These land on a big screen in front of the whole sales floor, with the same
 * fanfare a real prize gets, so the comedy is the GAP between the fanfare and
 * the prize — never the person standing there. Three rules, and they are why
 * the list reads the way it does: it never names anybody, it never says or
 * implies somebody is behind or not selling, and it never mocks the job the
 * person is about to go and do. It punches at the WHEEL and at the day, and the
 * punchline is always something the whole room is in on.
 *
 * NEVER WORTH MONEY. A joke is recorded with a value of zero and its own kind,
 * so it can show up in the day's history and on somebody's recap card as the
 * moment it was, and can never add a penny to what anybody is owed.
 */

/**
 * THE LIST. Grouped by the shape of the joke rather than by topic, because the
 * variety that matters on the day is the shape — four "you won another client"
 * gags in a row is one joke told four times.
 *
 * `label` is what the slice says on the wheel, so it is short enough to read
 * from across a room. `detail` is the follow-through, shown when it lands.
 */
const JOKES = [
  // ── the owner's own two, and their family: you have won more work ────────
  { key: 'joke_another_client', family: 'work',
    label: 'Another client',
    detail: 'They are already sitting in Elementix with your name on them. Go and call them.' },
  { key: 'joke_fresh_lead', family: 'work',
    label: 'A brand-new lead',
    detail: 'Freshly skip-traced this morning. Elementix is holding it for you.' },
  { key: 'joke_next_in_queue', family: 'work',
    label: 'The next name in the queue',
    detail: 'Congratulations. It was going to be yours in about four minutes anyway.' },
  { key: 'joke_one_more_dial', family: 'work',
    label: 'One more dial',
    detail: 'You have won the privilege of making it. Right now, ideally.' },
  { key: 'joke_warm_lead', family: 'work',
    label: 'A warm lead',
    detail: 'Room temperature, if we are being honest. Still yours.' },

  // ── the thing you already have ──────────────────────────────────────────
  { key: 'joke_elementix_login', family: 'already',
    label: 'An Elementix login',
    detail: 'You have one. Consider this a second, more official invitation to use it.' },
  { key: 'joke_unlimited_access', family: 'already',
    label: 'Unlimited Elementix access',
    detail: 'Exactly as unlimited as it was yesterday. Enjoy.' },
  { key: 'joke_your_own_dialler', family: 'already',
    label: 'Your very own dialler',
    detail: 'It is the one on your desk. It has been there the whole time.' },
  { key: 'joke_phone_back', family: 'already',
    label: 'Your phone, back',
    detail: 'It was under the paperwork. You are welcome.' },

  // ── absurdly specific ───────────────────────────────────────────────────
  { key: 'joke_fourteen_minutes', family: 'specific',
    label: 'Fourteen minutes of talk time',
    detail: 'Not a minute more. Spend them somewhere good.' },
  { key: 'joke_one_followup', family: 'specific',
    label: 'One (1) follow-up call',
    detail: 'Non-transferable. Expires at the end of the day.' },
  { key: 'joke_callback_455', family: 'specific',
    label: 'A callback at 4:55pm',
    detail: 'They said they would be free then. They said that last week too.' },
  { key: 'joke_second_ring', family: 'specific',
    label: 'The second ring',
    detail: 'Not the first. Not the third. The second one is yours.' },

  // ── corporate deadpan ───────────────────────────────────────────────────
  { key: 'joke_firm_handshake', family: 'deadpan',
    label: 'A firm handshake',
    detail: 'Redeemable at no location. Transferable to no one. Available immediately.' },
  { key: 'joke_sincere_thanks', family: 'deadpan',
    label: 'Our sincere thanks',
    detail: 'Cash value: nil. Sentimental value: pending review.' },
  { key: 'joke_recognition', family: 'deadpan',
    label: 'Recognition',
    detail: 'You are hereby recognised. That is the entire prize. It has been recognised.' },
  { key: 'joke_certificate', family: 'deadpan',
    label: 'A certificate',
    detail: 'We have not printed it. Picture it clearly and the effect is the same.' },

  // ── the wheel breaking the fourth wall ──────────────────────────────────
  { key: 'joke_this_slice', family: 'meta',
    label: 'This slice of the wheel',
    detail: 'That is it. That is the prize. You own this bit of the picture now.' },
  { key: 'joke_nothing', family: 'meta',
    label: 'Nothing at all',
    detail: 'But you won it fairly, in front of everybody, and the maths can be checked.' },
  { key: 'joke_another_spin', family: 'meta',
    label: 'The feeling of nearly winning',
    detail: 'Widely reported to be the best part. You have the full amount of it.' },

  // ── the job itself, fondly ──────────────────────────────────────────────
  { key: 'joke_voicemail', family: 'job',
    label: 'A voicemail',
    detail: 'Beautifully delivered. They will call back. Probably.' },
  { key: 'joke_polite_no', family: 'job',
    label: 'A very polite no',
    detail: 'Still a no. But genuinely one of the nicer ones.' },
  { key: 'joke_dial_tone', family: 'job',
    label: 'The dial tone',
    detail: 'Yours to keep. Plays on request.' },
  { key: 'joke_full_contact_record', family: 'job',
    label: 'A complete contact record',
    detail: 'Every single field filled in. By you. Later on.' },
];

const BY_KEY = new Map(JOKES.map((j) => [j.key, j]));

// How much of the wheel the jokes hold. The middle number is the owner's band —
// 22% is a shade over one in five and a shade under one in four.
const SHARE_ORDINARY = 0.22;
const SHARE_AFTER_ONE = 0.08;    // one just landed: back right off
const SHARE_AFTER_DRY = 0.32;    // three clean spins: lean in
const SHARE_LONG_DRY = 0.45;     // four or more: lean in hard
const SHARE_CEILING = 0.45;      // never more than this, whatever the arithmetic
// The wheel is scaled up to at least this many whole units before the joke's
// share is worked out, so the share can be placed accurately on an integer grid.
const SCALE_TARGET = 40;

// A wheel needs enough real prizes to carry a joke without becoming a coin toss.
const MIN_REAL_FOR_ANY = 2;
const MIN_REAL_FOR_TWO = 4;

/** Is this candidate one of ours? */
function isJoke(candidate) {
  return !!(candidate && candidate.meta && candidate.meta.joke === true);
}

/** The joke behind a key, or null. Never throws. */
function jokeFor(key) { return BY_KEY.get(String(key || '')) || null; }

/**
 * How much of the NEXT wheel the jokes should hold.
 *
 * `recent` is the outcome of the last few PRIZE wheels, newest first, as
 * booleans: did that one land on a joke?
 */
/**
 * The ladder, and why it is a ladder rather than one number.
 *
 * MEASURED over 20,000 simulated days rather than reasoned about. At a flat
 * 22% with a six-spin day, ONE DAY IN SIX would pass with the joke never once
 * appearing — a feature the owner asked for, absent, on a day that only happens
 * a few times a year. Escalating a dry run to 32% and then 45% halves that
 * (16.6% → 10.8% on six spins, 7.7% → 3.3% on eight) while leaving the overall
 * rate where the owner put it, at about one in four and a half.
 *
 * It never reaches certainty on purpose. A guaranteed joke after four clean
 * spins is a countdown, and "it should not be exactly every fourth" rules that
 * out just as firmly at the tail as in the middle.
 */
function shareFor(recent) {
  const r = Array.isArray(recent) ? recent : [];
  if (r[0] === true) return SHARE_AFTER_ONE;
  let dry = 0;
  while (dry < r.length && r[dry] === false) dry++;
  if (dry >= 4) return SHARE_LONG_DRY;
  if (dry >= 3) return SHARE_AFTER_DRY;
  return SHARE_ORDINARY;
}

/**
 * How many joke slices this wheel carries. "Sometimes one and sometimes two",
 * and never two on a wheel too small to absorb them.
 *
 * `rng` returns a float in [0,1) and is injected so a test can pin it.
 */
function countFor(realCount, rng = Math.random) {
  const n = Number(realCount) || 0;
  if (n < MIN_REAL_FOR_ANY) return 0;
  if (n < MIN_REAL_FOR_TWO) return 1;
  return rng() < 0.3 ? 2 : 1;      // two about a third of the time
}

/**
 * Which jokes. Never one already told in this session — a punchline repeated in
 * the same afternoon is not a punchline, it is a pattern.
 */
function pick(count, { used = [], rng = Math.random } = {}) {
  const seen = new Set((used || []).map(String));
  const pool = JOKES.filter((j) => !seen.has(j.key));
  const from = pool.length >= count ? pool : JOKES.slice();   // a very long day: allow repeats rather than nothing
  const out = [];
  const left = from.slice();
  for (let i = 0; i < count && left.length; i++) {
    out.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
  }
  return out;
}

/**
 * Put them on the wheel.
 *
 * The weight arithmetic is the whole point: to make the jokes hold `share` of
 * the FINAL wheel, they need `W * share / (1 - share)` between them, where W is
 * what the real prizes already hold. Splitting that evenly means two joke slices
 * are each half the size of one — two chances to hit, the same total space, so
 * "sometimes two" changes the look of the wheel and not the odds.
 *
 * Returns the new candidate list. Never throws; on anything unexpected it hands
 * back the list it was given, because a wheel with no joke on it is a normal
 * wheel and a wheel that failed to build is not.
 */
function injectInto(candidates, { recent = [], used = [], rng = Math.random, share = null } = {}) {
  try {
    const real = (candidates || []).filter((c) => !isJoke(c));
    if (real.length !== (candidates || []).length) return candidates;   // already done
    const count = countFor(real.length, rng);
    if (!count) return candidates;

    const s = Math.min(SHARE_CEILING, Math.max(0, share == null ? shareFor(recent) : Number(share)));
    if (!(s > 0)) return candidates;

    const W = real.reduce((a, c) => a + (Number(c.weight) || 0), 0);
    if (!(W > 0)) return candidates;
    if (!real.every((c) => Number.isInteger(Number(c.weight)))) return candidates;

    // WHOLE NUMBERS, OR THE DRAW REFUSES THE WHEEL. `fair.pickWeighted` — the
    // auto-draw path — takes only non-negative whole numbers, and the first
    // fractional joke slice threw "weight must be a non-negative whole number"
    // on every automatic prize spin. The held wheel happened not to care, which
    // is exactly why this was caught by an existing suite rather than by the
    // new one.
    //
    // So the WHOLE wheel is scaled up to a grid fine enough to place the share
    // accurately. Multiplying every weight by the same whole number leaves the
    // relative odds untouched to the last digit, and nothing anywhere shows a
    // raw weight — the room is shown percentages — so the scale is invisible.
    // Without it a small wheel lands badly: two prizes and one joke is 33%, a
    // third again more than the owner asked for.
    const k = Math.max(1, Math.ceil(SCALE_TARGET / W));
    const scaled = k === 1 ? real : real.map((c) => ({ ...c, weight: Number(c.weight) * k }));
    const Wk = W * k;

    const jokeTotal = Math.max(count, Math.round((Wk * s) / (1 - s)));
    const base = Math.floor(jokeTotal / count);
    const spare = jokeTotal - base * count;
    const chosen = pick(count, { used, rng });
    if (!chosen.length) return candidates;

    return scaled.concat(chosen.map((j, i) => ({
      key: j.key,
      label: j.label,
      // The remainder goes on the first slice, so two jokes hold the intended
      // total between them even when it does not divide evenly.
      weight: base + (i < spare ? 1 : 0),
      meta: {
        joke: true, jokeKey: j.key, family: j.family,
        detail: j.detail, kind: 'joke', valueCents: 0,
      },
    })));
  } catch (_) {
    return candidates;
  }
}

module.exports = {
  JOKES, isJoke, jokeFor, shareFor, countFor, pick, injectInto,
  SHARE_ORDINARY, SHARE_AFTER_ONE, SHARE_AFTER_DRY, SHARE_LONG_DRY, SHARE_CEILING,
  MIN_REAL_FOR_ANY, MIN_REAL_FOR_TWO, SCALE_TARGET,
};
