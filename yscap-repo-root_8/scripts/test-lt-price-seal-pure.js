/**
 * THE VENDOR'S OWN PRICE TRAVELS SEALED — the holdback cannot be read off the wire.
 *
 * ── THE DEFECT, MEASURED ───────────────────────────────────────────────────
 * The owner's standing rule is that our margin holdback is baked into the rate and is never
 * visible to a consumer, so `investor-routing.stripHoldbackTrail` removes every field that would
 * give it away by subtraction — `marginHoldback`, `vendorPrice`, `vendorPriceFloor`,
 * `vendorPriceCeiling` (audit F5, 2026-09-02).
 *
 * `priceExact` was added AFTER that audit, because LoanNEX matches a quote by its price EXACTLY and
 * our parser rounds to three decimals for display. It walked straight through the same door.
 * Measured on a real general-engine board, 2026-09-03:
 *
 *     price       100.786    ← held back, what the screen shows
 *     priceExact  101.0355   ← the vendor's own, on the same handle
 *     ─────────────────────
 *     difference    0.2495   ← the holdback, one subtraction off the wire
 *
 * on all 2,133 explain handles of that board.
 *
 * ── WHY A SEAL AND NOT A DELETION ──────────────────────────────────────────
 * Dropping the field re-opens the empty-breakdown bug it was added to close (269 of 4,396 rungs on
 * one live board need a fourth decimal; sent rounded the sheet answers Success with no body), and
 * it cannot be rebuilt from the rounded price — 104.1762 → 104.176 → +0.25 → 104.176. So the number
 * has to travel, and it travels under AES-256-GCM: the server opens it, the browser cannot read it,
 * and a forged blob fails its authentication tag rather than decoding to a plausible price.
 *
 * ── WHAT THIS PINS ─────────────────────────────────────────────────────────
 *   A  the seal's own truth table          D  the handle the browser holds
 *   B  a blob this process cannot open     E  the ONE door that opens it
 *   C  where the key comes from            F  what reaches the vendor
 *                                          G  source guards: no second way in
 *
 * ── PROVEN TO FAIL ─────────────────────────────────────────────────────────
 * Ten mutations of the production code, each with a green control either side (a second suite,
 * `test-lt-explain-exact-price-pure`, is named where it also went red):
 *
 *   1. the handle sends the exact price in the clear ................ red, both
 *   2. the door never opens the seal ................................ red, both
 *   3. the seal rides on past the door .............................. red
 *   4. `evidence` reverts to a bare `!= null` test .................. red
 *   5. `open()` drops the authentication tag check .................. red
 *   6. `seal()` coerces before it checks the type ................... red
 *   7. the derived key is the bare hash of the secret ............... red
 *   8. a forged plain price beats the seal .......................... red
 *   9. an unopenable seal leaves a forged price standing ............ red
 *  10. `keySource` reports the environment, not the minted key ...... red
 *
 * PURE: no network, no database, no RTL import.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const sealedPrice = require(path.join(ROOT, 'src/longterm/pricing/sealed-price'));
const quoteShape = require(path.join(ROOT, 'src/longterm/pricing/quote-shape'));
const vendorMargin = require(path.join(ROOT, 'src/longterm/pricing/vendor-margin'));
const parse = require(path.join(ROOT, 'src/longterm/loannex/parse'));
const nex = require(path.join(ROOT, 'src/longterm/loannex/client'));
const combined = require(path.join(ROOT, 'src/longterm/routes/combined-pricer'));
const { quoteFromBody } = combined._internals;
const { exactPrice } = nex._internals;

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass++; console.log('  ok  ' + n); };
const eq = (a, b, n) => { assert.strictEqual(a, b, `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + n); };

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
console.log('\nA · the seal itself');
// ---------------------------------------------------------------------------
{
  /* The four decimals are what the whole field exists for, so they are the first thing proven. */
  for (const n of [104.1762, 100.7605, 96.6756, 102.5, 100, 0, -3.5, 101.0355]) {
    eq(sealedPrice.open(sealedPrice.seal(n)), n, `A1 ${n} survives the round trip exactly`);
  }
  eq(sealedPrice.open(sealedPrice.seal('104.1762')), 104.1762, 'A2 a numeric string seals as its number');

  /* ⛔ NOTHING THAT IS NOT A PRICE MAY SEAL. `Number(null)` and `Number('')` are both 0, so a
     missing price would otherwise travel as a confident par-minus-100 quote the sheet cannot
     match — the same three-valued-logic trap this repo has been bitten by elsewhere. */
  for (const v of [null, undefined, '', NaN, Infinity, -Infinity, 'abc', {}, []]) {
    eq(sealedPrice.seal(v), null, `A3 ${JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v)} seals to null, never to 0`);
  }

  const a = sealedPrice.seal(104.1762);
  const b = sealedPrice.seal(104.1762);
  ok(a !== b, 'A4 two seals of the SAME number differ — a random iv, so the blob is not a lookup key for the price');
  ok(sealedPrice.isSealed(a), 'A5 a seal is recognisable as one');
  for (const v of [104.1762, '104.1762', null, undefined, '', 'p2.abc', {}]) {
    ok(!sealedPrice.isSealed(v), `A6 ${JSON.stringify(v)} is not mistaken for a seal`);
  }
  ok(!/104\.1762|1041762/.test(a), 'A7 the number is nowhere in the blob, in any obvious form');
}

// ---------------------------------------------------------------------------
console.log('\nB · a blob this process cannot open answers null, never a number');
// ---------------------------------------------------------------------------
{
  const good = sealedPrice.seal(104.1762);
  const flip = good.slice(0, -2) + (good.endsWith('aa') ? 'bb' : 'aa');
  eq(sealedPrice.open(flip), null, 'B1 a tampered blob does not open');

  /**
   * ⛔ THE ASSERTION THAT IS ACTUALLY ABOUT THE AUTHENTICATION TAG, and the reason B1 alone is not
   * enough. GCM is a stream cipher: flipping a bit of the ciphertext flips the SAME bit of the
   * plaintext. So somebody who can guess the price — and it is a price, in a known format — can
   * flip it into a DIFFERENT VALID PRICE, and without the tag check the blob would open to a
   * number the vendor is then asked to itemise. Here the last byte of "104.1762" is turned into
   * "104.1763" by hand.
   *
   * MEASURED, by removing the tag check from `open()` on purpose: the forged blob opened to
   * **104.1763** and this suite went red. B1's random corruption cannot prove that — it merely
   * produces text `Number()` reads as NaN, so B1 alone passes with the tag check gone.
   */
  {
    const raw = Buffer.from(good.slice(sealedPrice.V.length + 1), 'base64url');
    const forgedRaw = Buffer.from(raw);
    forgedRaw[forgedRaw.length - 1] ^= 0x01;              // '2' → '3'
    const forged = `${sealedPrice.V}.${forgedRaw.toString('base64url')}`;
    ok(forged !== good, 'B1b the bit-flip really produced a different blob');
    eq(sealedPrice.open(forged), null,
      'B1c a bit-flip that would decrypt to a DIFFERENT VALID PRICE is refused — this is the tag, and nothing else can do it');
    const ivFlip = Buffer.from(raw); ivFlip[0] ^= 0x01;
    eq(sealedPrice.open(`${sealedPrice.V}.${ivFlip.toString('base64url')}`), null,
      'B1d …and so is a blob whose iv was altered');
  }
  eq(sealedPrice.open(good.slice(0, 20)), null, 'B2 a truncated blob opens to nothing');
  eq(sealedPrice.open(`p2.${good.slice(3)}`), null, 'B3 a blob under a version we do not mint is refused');
  eq(sealedPrice.open(`${sealedPrice.V}.`), null, 'B4 an empty body is refused rather than throwing');
  eq(sealedPrice.open(`${sealedPrice.V}.!!!not-base64!!!`), null, 'B5 rubbish is refused rather than throwing');
  for (const v of [null, undefined, 104.1762, {}, [], '']) {
    eq(sealedPrice.open(v), null, `B6 open(${JSON.stringify(v)}) is null`);
  }
  /* ⛔ THE FORGERY CASE IS THE ONE THAT MATTERS: a browser inventing a price would ask the vendor
     to itemise somebody else's quote. GCM is what makes that impossible rather than unlikely. */
  const forged = `${sealedPrice.V}.${Buffer.from('104.1762').toString('base64url')}`;
  eq(sealedPrice.open(forged), null, 'B7 a hand-made blob carrying a plain price does NOT open');
}

// ---------------------------------------------------------------------------
console.log('\nC · where the key comes from, and that another key cannot open ours');
// ---------------------------------------------------------------------------
{
  /**
   * Each case gets its OWN module instance, and its key is MINTED WHILE ITS ENVIRONMENT IS IN
   * PLACE before the environment is put back. That ordering is the whole trick: the key is cached
   * on first use, so an instance interrogated after the restore would answer about whatever the
   * environment happens to hold then — which is exactly the inconsistency `keySource()` reports
   * around, and a test that did not force the mint would be asserting on the wrong process.
   */
  const freshWith = (env) => {
    const keep = {};
    for (const k of ['LT_PRICE_SEAL_KEY', 'JWT_SECRET']) { keep[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env);
    const id = require.resolve(path.join(ROOT, 'src/longterm/pricing/sealed-price'));
    delete require.cache[id];
    const mod = require(id);
    mod._internals.key();          // mint it here, under THIS environment
    delete require.cache[id];
    for (const k of ['LT_PRICE_SEAL_KEY', 'JWT_SECRET']) {
      if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
    }
    return mod;
  };

  const cfg = freshWith({ LT_PRICE_SEAL_KEY: 'a-configured-key', JWT_SECRET: 'jjj' });
  eq(cfg.keySource(), 'configured', 'C1 an explicit key wins');
  const der = freshWith({ JWT_SECRET: 'jjj' });
  eq(der.keySource(), 'derived', 'C2 with no explicit key it is derived from the deployment secret');
  const eph = freshWith({});
  eq(eph.keySource(), 'ephemeral', 'C3 with neither it is random for this process');
  eq(cfg.keyIsConfigured(), true, 'C4 a configured key survives a restart');
  eq(der.keyIsConfigured(), true, 'C5 …and so does a derived one — which is the whole reason it exists');
  eq(eph.keyIsConfigured(), false, 'C6 a random one does not, and says so');

  /* ⛔ THE DERIVED KEY IS NOT THE SECRET IT CAME FROM. */
  const derKey = der._internals.key();
  ok(!derKey.equals(Buffer.from('jjj')), 'C7 the derived key is not the secret verbatim');
  ok(!derKey.equals(require('crypto').createHash('sha256').update('jjj').digest()),
    'C8 …nor its bare hash — the domain label is what keeps the two apart');

  /* Two deployments with two secrets cannot read each other's seals. */
  const der2 = freshWith({ JWT_SECRET: 'a-different-deployment' });
  const blob = der.seal(104.1762);
  eq(der.open(blob), 104.1762, 'C9 the minting process opens its own seal');
  eq(der2.open(blob), null, 'C10 a different key opens it to NOTHING — never to a different number');
  eq(cfg.open(blob), null, 'C11 …and neither does an explicitly configured one');

  /* Two processes on the SAME derived key agree — which is what makes a restart survivable. */
  const der1b = freshWith({ JWT_SECRET: 'jjj' });
  eq(der1b.open(blob), 104.1762, 'C12 a restart on the same secret still opens yesterday’s seal');
}

// ---------------------------------------------------------------------------
console.log('\nD · the handle the browser actually holds');
// ---------------------------------------------------------------------------
/**
 * A vendor board in the shape `/quick-prices` really answers, carrying the exact price measured
 * live (NQM product 38068 at 6.875%, 30-day lock) alongside one that survives rounding.
 */
const RAW = {
  status: 'Success',
  data: {
    investors: [{ id: 7233, name: 'NQM Funding', organizationGuid: 'g-nqm' }],
    programs: [{ id: 1382, name: 'CORR: Investor - DSCR', programCode: 'C9001' }],
    products: [{ id: 38068, mortgageProductId: 900 }],
    mortgageProducts: [{ id: 900, description: '30 Yr. Fixed', amortizationType: 'Fixed', termInMonths: 360, isInterestOnly: false }],
    prices: [
      { rate: 6.875, investorId: 7233, programId: 1382, productId: 38068, dscr: 1.3, payment: 2464.5,
        priceHashKey: '38068-1382-33114-5316',
        lockTermPrices: [{ lockDays: 30, price: 104.1762, cushionedLockDays: 30 }] },
      { rate: 7, investorId: 7233, programId: 1382, productId: 38068, dscr: 1.3, payment: 2494.88,
        priceHashKey: '38068-1382-33114-5317',
        lockTermPrices: [{ lockDays: 30, price: 102.5, cushionedLockDays: 30 }] },
    ],
  },
};

const held = vendorMargin.applyToBoard(parse.parse(RAW), 'loannex', {});
const rows = quoteShape.programsFromLoanNex(held, { transactionId: 'txn-1' });
const options = rows[0].options;
const optFourth = options.find((o) => o.explain && o.explain.rate === 6.875);
const optThird = options.find((o) => o.explain && o.explain.rate === 7);

{
  ok(optFourth && optFourth.explain, 'D1 the row carries an explain handle');
  ok(!('priceExact' in optFourth.explain), 'D2 the vendor’s own price is NOT readable on it');
  ok(!('vendorPrice' in optFourth.explain), 'D3 …and neither is the field audit F5 closed');
  ok(!('marginHoldback' in optFourth.explain), 'D4 …nor the holdback itself');
  ok(sealedPrice.isSealed(optFourth.explain.priceSeal), 'D5 it travels as a seal');
  eq(sealedPrice.open(optFourth.explain.priceSeal), 104.1762, 'D6 which opens, server-side, to the sheet’s own number');
  eq(optFourth.explain.price, 103.926, 'D7 the price the screen shows is still the held-back, rounded one');

  /**
   * ⛔ THE RULE, NOT THE FIELD. Every readable number on the whole handle is swept against the
   * holdback. Asserting only on `priceExact` would pass again the day a fifth field is added and
   * walks through the same door this one did.
   */
  const HOLDBACK = 0.25;
  for (const o of options) {
    const leak = Object.entries(o.explain)
      .filter(([k, v]) => k !== 'price' && typeof v === 'number' && Number.isFinite(v))
      .filter(([, v]) => Math.abs(Math.abs(v - o.explain.price) - HOLDBACK) < 0.01);
    eq(leak.length, 0, `D8 rate ${o.explain.rate}: nothing readable is the holdback away from the price — ${JSON.stringify(leak)}`);
  }

  /* The JSON that actually crosses the wire may not contain the vendor's figure in any form. */
  const wire = JSON.stringify(rows);
  ok(!wire.includes('104.1762'), 'D9 the vendor’s exact price appears nowhere in the board JSON');
  ok(!wire.includes('priceExact'), 'D10 …and neither does the key');
  ok(!wire.includes('marginHoldback'), 'D11 …nor the holdback');

  /* A rung whose price needs no fourth decimal is still sealed — a handle that carried the seal
     only sometimes would tell an observer WHICH rungs needed one, which is a different tell. */
  ok(sealedPrice.isSealed(optThird.explain.priceSeal), 'D12 a rung needing no fourth decimal is sealed too');
  eq(sealedPrice.open(optThird.explain.priceSeal), 102.5, 'D13 …and opens to its own number');

  /**
   * Nothing to seal ⇒ NO KEY AT ALL, rather than a null. A null reads as "asked and there was
   * none", which is a claim; the absence reads as "this row does not work that way", which is the
   * truth for a Lender Price row and for anything shaped before the field existed.
   */
  {
    const priceless = quoteShape.programsFromLoanNex({
      programs: [{
        lender: 'x', investor: 'x', program: 'p', product: 'pr', programId: 1,
        rungs: [{ priceHashKey: 'k-none', rate: 6.5, lockDays: 30 }],
      }],
    }, {});
    const h = priceless[0].options[0].explain;
    ok(h, 'D14 a rung with no price at all still gets a handle');
    ok(!('priceSeal' in h), 'D14b …carrying no seal key at all, not a null one');
    ok(!('priceExact' in h), 'D14c …and no readable exact price either');
  }
}

// ---------------------------------------------------------------------------
console.log('\nE · the ONE door that opens it');
// ---------------------------------------------------------------------------
{
  const opened = quoteFromBody({ quote: optFourth.explain });
  eq(opened.priceExact, 104.1762, 'E1 the door opens the seal into the number the vendor call needs');
  ok(!('priceSeal' in opened), 'E2 …and the blob never rides on past it');
  eq(opened.priceHashKey, '38068-1382-33114-5316', 'E3 everything else on the quote is untouched');
  eq(opened.price, 103.926, 'E4 including the held-back price the panel prints');

  /* Both body shapes the route accepts. */
  eq(quoteFromBody(optFourth.explain).priceExact, 104.1762, 'E5 a bare quote body works the same way');

  /* ⛔ AN UNOPENABLE SEAL IS A FALLBACK, NEVER AN ERROR — a restart, a rotated key, a stale tab. */
  const stale = quoteFromBody({ quote: { ...optFourth.explain, priceSeal: `${sealedPrice.V}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } });
  ok(!('priceExact' in stale), 'E6 a seal this process cannot open yields no exact price');
  ok(!('priceSeal' in stale), 'E7 …and the blob is still dropped');
  eq(stale.price, 103.926, 'E8 …leaving exactly the quote the add-back path has always handled');

  /* ⛔ AND AN UNOPENABLE SEAL DOES NOT LEAVE A FORGED FIGURE STANDING. A browser posting a stale
     blob AND a made-up exact price must end with NO exact price — not with the made-up one. */
  const staleForged = quoteFromBody({ quote: { ...optFourth.explain, priceExact: 999, priceSeal: `${sealedPrice.V}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } });
  ok(!('priceExact' in staleForged), 'E8b an unopenable seal drops a forged exact price sent beside it');

  /* A forged plain number in the seal slot must not become a price. */
  const forged = quoteFromBody({ quote: { ...optFourth.explain, priceSeal: 104.1762 } });
  ok(!('priceExact' in forged), 'E9 a number in the seal slot is not read as a price');

  /**
   * ⛔ THE SEAL WINS OVER A PLAIN FIGURE SENT BESIDE IT. A browser holding a handle can post
   * anything it likes; the only price this door will believe is one it minted itself, so a forged
   * `priceExact` riding in alongside the seal is overwritten rather than trusted. Asking the sheet
   * to itemise a price somebody typed is how the wrong quote gets explained.
   */
  const both = quoteFromBody({ quote: { ...optFourth.explain, priceExact: 999 } });
  eq(both.priceExact, 104.1762, 'E10 a forged priceExact sent beside the seal is overwritten by what the seal says');

  /* With NO seal there is nothing to overrule, so an internal caller's own figure rides — that is
     the older-row path, and the path every non-LoanNEX quote has always taken. */
  const internal = quoteFromBody({ quote: { priceHashKey: 'k', price: 100, priceExact: 999 } });
  eq(internal.priceExact, 999, 'E10b with no seal an internal caller’s own exact price is untouched');

  /* A body with no quote at all is handed back rather than blowing up the route. */
  for (const v of [null, undefined, 'x', 7]) {
    eq(quoteFromBody(v), v, `E11 quoteFromBody(${JSON.stringify(v)}) is handed straight back`);
  }
  ok(!('priceSeal' in quoteFromBody({ quote: { price: 1, priceSeal: undefined } })),
    'E12 an undefined seal key is dropped rather than carried as undefined');
}

// ---------------------------------------------------------------------------
console.log('\nF · what reaches the vendor');
// ---------------------------------------------------------------------------
{
  eq(exactPrice({ priceExact: 104.1762, price: 103.926 }), 104.1762, 'F1 a real exact price wins');
  eq(exactPrice({ priceExact: '104.1762', price: 103.926 }), 104.1762, 'F2 a numeric string is normalised, not refused');
  eq(exactPrice({ price: 103.926 }), 103.926, 'F3 with none, the rounded price is asked about');
  for (const bad of [null, undefined, '', NaN, {}, [], 'abc']) {
    eq(exactPrice({ priceExact: bad, price: 103.926 }), 103.926,
      `F4 priceExact=${JSON.stringify(bad)} falls back — Number(null) is 0 and 0 is a price the sheet cannot match`);
  }
  /* ⛔ AND A SEAL NEVER TRAVELS TO THE VENDOR. The sheet cannot match a base64 string, so the panel
     would report an empty breakdown and blame LoanNEX for our own plumbing. */
  eq(exactPrice({ priceExact: sealedPrice.seal(104.1762), price: 103.926 }), 103.926,
    'F5 a seal handed to the client is refused and the rounded price is sent instead');
}

// ---------------------------------------------------------------------------
console.log('\nG · no second way in');
// ---------------------------------------------------------------------------
{
  const qs = stripComments(read('src/longterm/pricing/quote-shape.js'));
  ok(/priceSeal:\s*sealedPrice\.seal\(/.test(qs), 'G1 the handle seals it through the shared module');
  /**
   * ⛔ AN OBJECT KEY, NOT A MENTION. `r.priceExact != null ? r.priceExact : …` is how the seal is
   * FED and must keep passing; what may never come back is `priceExact:` as a key on the handle.
   * The two are told apart by the character in front of it — a key is never preceded by a dot.
   * (The first cut of this guard matched the ternary's own colon and failed on the fix it guards.)
   */
  ok(!/[^.\w]priceExact\s*:/.test(qs), 'G2 nothing in the quote shape assigns a readable priceExact as a key');

  const cp = stripComments(read('src/longterm/routes/combined-pricer.js'));
  ok(!/b\.quote\s*\|\|\s*b/.test(cp),
    'G3 no explain door reads the body’s quote for itself — a door that forgot to open the seal would ask the sheet a rounded price and get nothing back');
  // `= quoteFromBody(b)` counts the CALLS; a bare name match also counts the definition.
  eq((cp.match(/=\s*quoteFromBody\(b\)/g) || []).length, 2, 'G4 both explain doors go through the one reader');
  eq((cp.match(/router\.post\('\/(loannex\/)?explain'/g) || []).length, 2, 'G5 …and there are exactly two of them');

  const cl = stripComments(read('src/longterm/loannex/client.js'));
  ok(/price:\s*exactPrice\(quote\)/.test(cl), 'G6 the vendor call asks the shared rule which price to send');

  /* ⛔ NEVER LOGGED. The blob is opaque, but a log line naming it invites the next person to print
     what it opens to, and the plaintext is the thing this whole module exists to keep off the wire. */
  for (const f of ['src/longterm/pricing/sealed-price.js', 'src/longterm/pricing/quote-shape.js', 'src/longterm/routes/combined-pricer.js']) {
    const code = stripComments(read(f));
    ok(!/console\.(log|warn|error)[^\n]*price(Seal|Exact)/i.test(code), `G7 ${path.basename(f)} never logs the seal or its plaintext`);
  }

  /**
   * PRODUCT SEPARATION, and purity. The seal reads its secret from the environment rather than
   * from `src/config`, which is RTL's module — so the requires are ENUMERATED rather than tested
   * for the absence of one bad name, which would pass for every name nobody thought of.
   */
  const sp = stripComments(read('src/longterm/pricing/sealed-price.js'));
  const requires = (sp.match(/require\(\s*'([^']+)'\s*\)/g) || []).map((m) => m.replace(/^require\(\s*'|'\s*\)$/g, ''));
  assert.deepStrictEqual(requires, ['crypto']);
  pass++; console.log('  ok  G8 the seal requires nothing but node crypto — no config, no database, no RTL import');
}

console.log('\n' + pass + ' checks passed\n');
