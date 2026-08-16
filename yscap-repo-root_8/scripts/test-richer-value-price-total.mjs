/**
 * PURE test — the ONE figure a Richer Values order is quoted at.
 *
 *   node scripts/test-richer-value-price-total.mjs
 *
 * No database, no network, no vendor.
 *
 * THE RULE (owner-directed 2026-08-16, asked directly and answered): *"the borrower
 * should be quoted the total with the $3.50."* Their quote carries `cc_surcharge`
 * OUTSIDE `total_price`, so the figure the order screen showed before this was the
 * one number nobody ever pays.
 *
 * Two things are proven here, and they fail differently:
 *   - the ARITHMETIC, by running the real function (a source grep cannot see that
 *     489.99 + 3.5 comes out as 493.49000000000007 in floating point);
 *   - that the SCREEN actually reads it, in all three places a price is printed —
 *     the panel, the order button and the confirmation line underneath it. A button
 *     promising one total while the panel above shows another is the exact drift a
 *     single shared definition exists to prevent, and only the source can show it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rvOrderTotal, moneyExact } from '../app-v2/src/lib/rvPrice.js';

const R = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* ═══ A. the total ══════════════════════════════════════════════════════ */
{
  // THE REAL MEASURED QUOTE from their training tenant: a $489.99 report with their
  // $3.50 flat card fee.
  ok(rvOrderTotal({ total_price: 489.99, cc_surcharge: 3.5 }) === 493.49,
    'A their real $489.99 quote plus the $3.50 card fee is exactly $493.49');
  ok(moneyExact(rvOrderTotal({ total_price: 489.99, cc_surcharge: 3.5 })) === '$493.49',
    'A and it PRINTS as $493.49');

  // AND THE PRICE THAT PROVES WHY THE SUM IS DONE IN CENTS. Plain addition is exact
  // for the quote above and NOT for this one (508.57 + 3.5 is 512.0699999999999),
  // which is the worst shape a bug can have — it works until it does not, and their
  // pricing moves with the state and the ZIP, so which prices a desk sees is not
  // something we choose. 168 prices between $300 and $1,200 behave this way.
  ok(rvOrderTotal({ total_price: 508.57, cc_surcharge: 3.5 }) === 512.07,
    'A a price where plain addition drifts still comes out exact');
  ok((508.57 + 3.5) !== 512.07,
    'A (and plain addition on that same price genuinely does NOT — this is not a hypothetical)');

  ok(rvOrderTotal({ total_price: 489.99, cc_surcharge: 0 }) === 489.99,
    'A no card fee leaves their price exactly as it is');
  ok(rvOrderTotal({ total_price: 489.99 }) === 489.99,
    'A and a quote that carries no surcharge field at all is not inflated');

  // A NEGATIVE OR JUNK FEE IS IGNORED, NEVER SUBTRACTED. Quoting a borrower LESS
  // than they will be charged is the failure this whole change is about, so the
  // only direction a bad fee may move the total is nowhere.
  for (const bad of [-5, 'x', null, undefined, NaN, {}]) {
    ok(rvOrderTotal({ total_price: 489.99, cc_surcharge: bad }) === 489.99,
      `A a fee of ${JSON.stringify(bad) ?? String(bad)} is ignored, never subtracted`);
  }

  // NO PRICE IS "—", NEVER "$0.00". A zero would read as a free appraisal.
  for (const bad of [null, undefined, {}, { total_price: null }, { total_price: 'x' }]) {
    ok(rvOrderTotal(bad) === null, `A ${JSON.stringify(bad) ?? String(bad)} is “no price”, not zero`);
  }
  ok(moneyExact(null) === '—' && moneyExact(rvOrderTotal(null)) === '—',
    'A and “no price” prints as a dash');
}

/* ═══ B. writing a price down ═══════════════════════════════════════════ */
{
  ok(moneyExact(3.5) === '$3.50', 'B the card fee is $3.50, not $3.5 and not $4');
  ok(moneyExact(489.99) === '$489.99', 'B their report price keeps its cents');
  ok(moneyExact(1234.5) === '$1,234.50', 'B thousands are grouped and cents are kept');
  ok(moneyExact(0) === '$0.00', 'B a genuine zero is a zero — it is only ABSENCE that is a dash');
  for (const bad of [null, undefined, '', 'x', NaN, {}]) {
    ok(moneyExact(bad) === '—', `B ${JSON.stringify(bad) ?? String(bad)} prints as a dash`);
  }
}

/* ═══ C. the screen reads it — all three places ═════════════════════════ */
{
  const src = readFileSync(R + '/app-v2/src/components/AppraisalOrderSection.jsx', 'utf8');

  ok(/from '\.\.\/lib\/rvPrice\.js'/.test(src),
    'C the order screen imports the shared definition rather than keeping its own');

  const hits = (src.match(/rvOrderTotal\(price\)/g) || []).length;
  ok(hits >= 3, `C every place a price is printed reads it (${hits} of 3+: panel, button, confirmation line)`);

  // THE OLD FIGURE MUST BE GONE FROM ALL THREE. Leaving one behind is not a cosmetic
  // miss: it prints the vendor's price where the all-in total belongs, which is the
  // exact under-quote the owner asked to fix.
  ok(!/money\(price\.total_price\)/.test(src),
    'C and none of them still prints the vendor’s pre-fee price as the total');

  // The fee is NAMED as well as included — a total that silently differs from the
  // vendor's own invoice line is how somebody comes to think we were overcharged.
  ok(/card fee \$\{moneyExact\(price\.cc_surcharge\)\}|card fee \$/.test(src) || /card fee /.test(src),
    'C the breakdown names the card fee');
  ok(/Includes the .*card fee/.test(src),
    'C and the screen says plainly that the headline INCLUDES it');
  ok(/their own report price is/i.test(src),
    'C while still showing their own price, so our total can be reconciled to their invoice');
}

/* ═══ D. every Richer Values suite is actually WIRED INTO `npm test` ═════ */
/*
 * A test file that exists but sits in no CI list runs nowhere and proves nothing,
 * while still LOOKING like coverage to everyone who greps for it — which is worse
 * than having no test at all.
 *
 * THIS GUARD EXISTS BECAUSE IT ALREADY HAPPENED, on 2026-08-16. `main` rewrote the
 * whole `scripts.test` block in the same hours this branch was adding to it. The
 * conflict was resolved by taking main's block verbatim and re-applying "our
 * addition" — and that re-application carried the ONE suite added in the commit
 * being merged, silently dropping the TWO added earlier in the same branch. The
 * check run afterwards asked "did I drop any of MAIN's suites?" (no) and never
 * asked the mirror question about our own. Both halves of a conflict have to be
 * checked, and the side you are least likely to check is your own.
 *
 * Scoped to this vendor's family deliberately: ~55 suites repo-wide are not in
 * `npm test`, which is a real and much larger question, but not one to decide
 * inside a Richer Values test.
 */
{
  const pkgTest = JSON.parse(readFileSync(R + '/package.json', 'utf8')).scripts.test;
  const { readdirSync } = await import('node:fs');
  const family = readdirSync(R + '/scripts')
    .filter((f) => /^test-richer-value-.*\.(js|mjs)$/.test(f))
    .sort();

  ok(family.length >= 6, `D there are ${family.length} Richer Values suites to account for`);
  for (const f of family) {
    ok(pkgTest.includes('scripts/' + f), `D ${f} is wired into npm test — it would run nowhere otherwise`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\ntest-richer-value-price-total: all checks passed');
process.exit(failures ? 1 : 0);
