/**
 * LONG-TERM — how a value is written down, in ONE place.
 *
 * These lived in `LtFileSections.jsx` and were copied into `LtPipeline.jsx` when the
 * pipeline grew its own cells, which is how a screen and a screen come to disagree
 * about the same loan. They had already drifted in a way that matters: the pipeline's
 * `day` used `new Date(v).toLocaleDateString()`, which on a DATE column — a calendar
 * day, not an instant — parses as UTC midnight and prints THE DAY BEFORE in every US
 * timezone. The file screen had the guard; the pipeline did not. Nothing showed a bare
 * date column there yet, so nothing was wrong on screen — and making the columns
 * configurable is exactly what would have made it wrong, quietly, the first time a
 * buyer added one.
 *
 * TWO RULES RUN THROUGH ALL OF THEM.
 *
 * A MISSING VALUE IS A DASH, NEVER A ZERO. "We have not read this yet" and "it is
 * nothing" are different answers, and on money, a rate or a ratio the second one is a
 * lie a desk would act on.
 *
 * A VALUE IS WRITTEN THE WAY IT IS HELD. A percent column holds a whole percent
 * (`DECIMAL(6,3)`, so 72.500 means 72.5%), never a fraction — printing 0.725% on a
 * 72.5% loan is the kind of wrong nobody queries because it looks like a typo.
 */

export const money = (v) => (v == null || v === '' ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));

export const money2 = (v) => (v == null || v === '' ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

/** A whole percent as stated. `Number` drops the column's trailing zeros for free. */
export const pct = (v) => (v == null || v === '' ? '—' : `${Number(v)}%`);

/**
 * A FRACTION written as a percent — 0.97 → "97.0%".
 *
 * The sibling of `pct` and NOT interchangeable with it, which is exactly why it lives
 * here rather than being hand-written wherever a fraction turns up. The loan columns
 * hold whole percents (72.500 means 72.5%); the PPE agreement rate is a fraction of
 * scenarios that matched, because that is what dividing two counts gives you. Feeding
 * a fraction to `pct` prints "0.97%" on a shadow engine agreeing 97% of the time — a
 * go-live gate reading as catastrophically broken — and feeding a whole percent to
 * this one prints "7250.0%". Neither is a rounding difference; both are the wrong
 * number, so the two conversions are named separately and each says what it takes.
 *
 * Non-finite is a dash for the standing reason: an agreement rate nobody has measured
 * must never be drawn as 0%.
 */
export const rate = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

/**
 * A ratio — DSCR — to three places with the trailing zeros trimmed.
 *
 * This is the INCUMBENT rule, already written out by hand in three places (the summary
 * rail and both DSCR rows in the file sections), and it is the one that wins for that
 * reason alone: the pipeline's new DSCR column was the only surface reading two
 * places, and four surfaces agreeing matters more than which convention is nicer.
 * Changing how a DSCR is quoted is a product decision, not a side effect of tidying up.
 */
/**
 * A NOTE RATE — a whole percent to three places. 5.875 → "5.875%".
 *
 * ⛔ IT IS NOT `rate`, AND THE TWO MUST NEVER BE SWAPPED. `rate` above takes a FRACTION
 * (0.97 → "97.0%") because that is what dividing two counts gives you; this takes a whole
 * percent, because that is how a rate sheet quotes a note rate and how the column holds it.
 * Feed a note rate to `rate` and 5.875 prints as "587.5%"; feed an agreement fraction to
 * this one and 0.97 prints as "0.970%". Neither is a rounding difference — both are simply
 * the wrong number, which is why they are named separately and each says what it takes.
 *
 * THREE PLACES, not two: rate ladders step in eighths (5.875, 6.125), and two places would
 * print two different rungs as the same rate.
 *
 * Non-finite is a DASH. A rate the vendor never quoted must never be drawn as 0.000%.
 */
export const noteRate = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(3)}%` : '—');

/**
 * A PRICE — three places, no percent sign. 100.061 → "100.061".
 *
 * A price is not a percent even though it looks like one: par is 100, and 98.5 means the
 * buyer pays 98.5% of par. Printing it with a "%" invites somebody to read 98.5 as a rate.
 *
 * Non-finite is a DASH, for the standing reason: a price nobody quoted is not 0.000, and a
 * price of zero is a real (catastrophic) figure that must stay distinguishable from it.
 */
export const price = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '—');

/**
 * POINTS — three places, SIGNED, with the plus kept. -0.689 → "-0.689", 2 → "+2.000".
 *
 * The sign is the whole meaning: points ADDED to a price cost the borrower money and points
 * SUBTRACTED pay them. An unsigned "2.000" beside a "0.689" reads as two costs when one of
 * them is a credit, so the plus is printed rather than left implied.
 *
 * Non-finite is a DASH: an adjustment the vendor never itemized is not a zero adjustment.
 */
export const points = (v) => (typeof v === 'number' && Number.isFinite(v)
  ? (v > 0 ? `+${v.toFixed(3)}` : v.toFixed(3))
  : '—');

export const ratio = (v) => (v == null || v === ''
  ? '—' : Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

export const plain = (v) => (v == null || v === '' ? '—' : String(v));

export const day = (v) => {
  if (!v) return '—';
  // A date column is a CALENDAR DAY, not an instant — `new Date('2019-08-01')` is
  // parsed as UTC midnight and prints as the day before in every US timezone. So a
  // plain `YYYY-MM-DD` is read as the day it says and never handed to `Date` at all.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US') : '—';
};

/**
 * How big a file is, in the units a person reads.
 *
 * A size nobody stated is a DASH, and a stated ZERO is "0 KB" — those are different
 * facts about a document, and an empty file somebody uploaded by mistake is worth
 * seeing rather than hiding behind the same dash as "we do not know". Rounded up to
 * the KB so a 400-byte file does not read as nothing at all.
 */
export const fileSize = (v) => {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * A yes/no that was ANSWERED false is "No"; one nobody answered is a dash.
 *
 * Strictly booleans, deliberately: anything else — a 0, a '', an 'N' — is a value we
 * do not understand, and reading it as "No" would state a determination nobody made.
 */
export const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');
