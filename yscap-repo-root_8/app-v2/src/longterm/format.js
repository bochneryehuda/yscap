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
 * A ratio — DSCR — to three places with the trailing zeros trimmed.
 *
 * This is the INCUMBENT rule, already written out by hand in three places (the summary
 * rail and both DSCR rows in the file sections), and it is the one that wins for that
 * reason alone: the pipeline's new DSCR column was the only surface reading two
 * places, and four surfaces agreeing matters more than which convention is nicer.
 * Changing how a DSCR is quoted is a product decision, not a side effect of tidying up.
 */
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
 * A yes/no that was ANSWERED false is "No"; one nobody answered is a dash.
 *
 * Strictly booleans, deliberately: anything else — a 0, a '', an 'N' — is a value we
 * do not understand, and reading it as "No" would state a determination nobody made.
 */
export const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');
