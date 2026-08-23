/**
 * LONG-TERM PRICING ENGINE — reading Lender Price's own fee and comp blocks.
 *
 * PURE, AND DELIBERATELY NOT JSX. These rules decide what a money figure MEANS, which is
 * the part worth testing hardest — and a `.jsx` module can only be loaded in a test by
 * bundling it through esbuild, which is installed under `app-v2/` and is NOT present in
 * CI (no CI job installs the front end). Every render-through-esbuild suite in this repo
 * therefore SKIPS on the build server. Leaving these rules inside the screen would have
 * meant the one thing that must never be wrong here — the unit on a dollar figure — was
 * checked on a developer's machine and nowhere else.
 *
 * `app-v2/package.json` is `"type": "module"`, so a plain `.js` file here is ESM and a
 * Node test can import it directly, with no bundler in the way.
 */

import { money2 } from './format.js';

const nn = (v) => Number.isFinite(v);

/**
 * A vendor key as a readable label. Typography only — `borrowerPaid` → "Borrower paid".
 *
 * It invents no meaning: the raw key still rides along in the row's tooltip, so what is on
 * screen can always be checked back against Lender Price's own field name.
 */
export function labelize(key) {
  const s = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}

/**
 * ⛔ THE ONLY TWO COMP FIGURES THIS SCREEN CALLS DOLLARS, and it calls them that because it
 * was MEASURED: on all twelve options of the captured Lender Price answer, `borrowerPaid`
 * and `lenderPaid` each equal the sum of their own detail lines' `amount`, and those lines
 * read "Origination : 1.439 (Points) x $350,000.00 (Loan Amount)" → $5,036.50.
 *
 * Everything else in the block is printed with NO unit. `compPlanBorrowerPaid` is 0 on every
 * captured option and its name reads as a flag; nothing available here can prove whether it
 * is dollars, points or a yes/no — and a guessed unit is exactly the defect this replaced,
 * which printed $5,036.50 of compensation as "+5036.500" points.
 */
export const COMP_DOLLARS = new Set(['borrowerPaid', 'lenderPaid']);

/**
 * The comp block as rows: each figure with the vendor's own itemisation underneath it.
 *
 * A `…Details` array is attached to the figure it belongs to (`borrowerPaidDetails` →
 * `borrowerPaid`) rather than rendered as a row of its own, because those lines ARE the
 * explanation of that figure. A details array whose figure is absent still gets its own
 * row — dropping it would hide part of an answer we paid for.
 *
 * Never throws on a shape it has not seen, and never yields a value that reads as broken:
 * an unreadable entry is an em dash, never "[object Object]" and never the word "null".
 */
export function compRowsOf(comp) {
  if (!comp || typeof comp !== 'object') return [];
  const entries = Object.entries(comp);
  const detailOf = new Map();
  for (const [k, v] of entries) {
    if (/Details$/.test(k) && Array.isArray(v)) detailOf.set(k.replace(/Details$/, ''), v);
  }
  const rows = [];
  for (const [k, v] of entries) {
    if (/Details$/.test(k) && Array.isArray(v)) {
      if (Object.prototype.hasOwnProperty.call(comp, k.replace(/Details$/, ''))) continue; // shown under its figure
      rows.push({ key: k, text: '', lines: v });
      continue;
    }
    let text;
    if (nn(v)) text = COMP_DOLLARS.has(k) ? money2(v) : v.toFixed(3);
    else if (v == null) text = '—';
    else if (typeof v === 'string') text = v;               // the vendor's own word, kept
    else if (typeof v === 'boolean') text = v ? 'yes' : 'no';
    else text = '—';                                        // never "[object Object]"
    rows.push({ key: k, text, lines: detailOf.get(k) || [] });
  }
  return rows;
}

/**
 * The fee block as rows. Every key the vendor's parser emits is kept, because a NAMED fee
 * with no figure is itself information — we asked and Lender Price did not quote it. The
 * block is built with `firstNum`, which answers null in exactly that case, so the value
 * must read as an em dash and never as the literal word "null".
 */
export function feeRowsOf(fees) {
  if (!fees || typeof fees !== 'object') return [];
  return Object.entries(fees).map(([k, v]) => ({ key: k, text: nn(v) ? money2(v) : '—' }));
}

/* -- ONE LINE PER LENDER, best price in front ---------------------------------
   Owner-directed 2026-08-23: *"when you have the same lender that has a few programs, you need to
   handle them the same way our system handles them and show them only as one lender... The front
   should be the best price that lender has available for the best program... you can then click to
   open up and see a dropdown on that lender itself... and see all other programs that this lender
   has available and all prices for all their different programs."*

   THE BOARD IS STILL A MIRROR, and "best" here is arithmetic rather than a judgement. At ONE note
   rate a higher price is worth more to the borrower -- that is what a price IS, not an opinion
   about execution. Nothing here compares across rates, ranks a lender by anything except the
   number they themselves quoted, or hides a quote.

   NOTHING IS EVER DROPPED. A quote with no price still belongs to its lender and still appears when
   that lender is opened; it simply cannot be the front line unless there is nothing else, in which
   case the screen shows an em dash rather than inventing a figure. A quote with no LENDER NAME
   becomes its own group rather than being folded into somebody else's -- putting one lender's price
   under another's name is the worst thing this board could do.

   Returns [{ key, lender, best, bestPrice, quotes, programCount }], best-priced lender first.
   Pure; never throws; a non-array yields []. */
export function groupByLender(quotes) {
  if (!Array.isArray(quotes)) return [];
  // A price that is not a finite number is NOT a price. Sorting on it would let an undefined or a
  // vendor's null win a comparison by accident, which is how a lender comes to front a figure
  // nobody quoted.
  const priceOf = (q) => (q && Number.isFinite(q.price) ? q.price : null);
  // Highest price first; anything unpriced sinks rather than counting as zero.
  const byBestPrice = (a, b) => {
    const x = priceOf(a); const y = priceOf(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
  };

  const groups = new Map();
  for (const q of quotes) {
    // The KEY is the lender's name exactly as the vendor wrote it, deliberately NOT normalized:
    // two spellings we cannot PROVE are one company must stay two rows.
    const name = q && typeof q.lender === 'string' ? q.lender : '';
    const key = name || ' no-lender';
    if (!groups.has(key)) groups.set(key, { key, lender: name || null, quotes: [] });
    groups.get(key).quotes.push(q);
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.quotes.sort(byBestPrice);
    g.best = g.quotes[0] || null;
    g.bestPrice = priceOf(g.best);
    // How many QUOTES this lender has at this rate -- which is what the dropdown reveals. It is NOT
    // a count of distinct programme names: the same programme can appear on two different lock or
    // price rungs, and both are real quotes somebody may want to see.
    g.programCount = g.quotes.length;
  }
  out.sort((a, b) => byBestPrice(a.best, b.best));
  return out;
}
