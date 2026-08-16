'use strict';
/**
 * Class Valuation product catalogue reader — PURE (no DB, no network; the transport is a
 * stub). Proves the two things the owner reported: the WHOLE catalogue is read (the
 * endpoint is paginated), and every product carries a readable NAME, never a bare id.
 */
const path = require('path');
const P = require(path.join(__dirname, '..', 'src/class/products'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', l); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (got ${JSON.stringify(a)})`);

// ---------------------------------------------------------------------------
console.log('\n--- extractArray: read the products from wherever the shape puts them ---');
eq(P.extractArray({ products: [{ id: 'a' }] }).length, 1, 'the documented `products` key');
eq(P.extractArray([{ id: 'a' }, { id: 'b' }]).length, 2, 'a bare array');
eq(P.extractArray({ data: [{ id: 'a' }] }).length, 1, 'a `data` envelope (defensive)');
eq(P.extractArray({ value: [{ id: 'a' }] }).length, 1, 'a `value` envelope (defensive)');
eq(P.extractArray({ nope: 1 }), [], 'no array anywhere → empty');
eq(P.extractArray(null), [], 'null → empty');
eq(P.extractArray('x'), [], 'a string → empty');

// ---------------------------------------------------------------------------
console.log('\n--- normalizeProduct: the NAME the owner asked for ---');
{
  // The reported case: only an id (title blank) → a plain name, NEVER a bare id.
  const only = P.normalizeProduct({ id: '638a58a35b6c2c21d6c370f9' });
  eq(only.title, 'Product 638a58a35b6c2c21d6c370f9', 'an id-only product still gets a display name');
  ok(only.title !== only.id, 'the name is never just the id');

  // title present → title wins.
  eq(P.normalizeProduct({ id: '1', title: 'Full URAR 1004' }).title, 'Full URAR 1004', 'title wins when present');

  // title blank, alternativeName present → the alternative name is the display name.
  const alt = P.normalizeProduct({ id: '2', title: '', alternativeName: 'Desktop 1004D' });
  eq(alt.title, 'Desktop 1004D', 'a blank title falls back to alternativeName');
  eq(alt.alternativeName, 'Desktop 1004D', 'alternativeName is carried through');

  // other vendor name spellings.
  eq(P.normalizeProduct({ id: '3', name: 'By name' }).title, 'By name', '`name` is read');
  eq(P.normalizeProduct({ id: '4', productName: 'By productName' }).title, 'By productName', '`productName` is read');

  // id aliases.
  eq(P.normalizeProduct({ productId: 'pid', title: 'x' }).id, 'pid', 'id read from productId');
  eq(P.normalizeProduct({ _id: 'mongo', title: 'x' }).id, 'mongo', 'id read from _id');

  // no id at all → unusable, dropped.
  ok(P.normalizeProduct({ title: 'nameless' }) === null, 'a product with no id is dropped');
  ok(P.normalizeProduct(null) === null, 'null is dropped');

  // flags: active defaults true (missing), only false hides; licensing only true when true.
  eq(P.normalizeProduct({ id: '5', title: 'x' }).active, true, 'active defaults to true');
  eq(P.normalizeProduct({ id: '6', title: 'x', active: false }).active, false, 'active:false is kept');
  eq(P.normalizeProduct({ id: '7', title: 'x' }).isLicensingEnabled, false, 'licensing defaults false');
  eq(P.normalizeProduct({ id: '8', title: 'x', isLicensingEnabled: true }).isLicensingEnabled, true, 'licensing:true kept');
}

// ---------------------------------------------------------------------------
console.log('\n--- parseProductPage + mergeProducts ---');
eq(P.parseProductPage({ products: [{ id: 'a', title: 'A' }, { title: 'no id' }, { id: 'b', title: 'B' }] }).map((p) => p.id),
   ['a', 'b'], 'a page parses + drops the id-less row');
eq(P.mergeProducts([[{ id: 'a', title: 'A' }], [{ id: 'a', title: 'A2' }, { id: 'b', title: 'B' }]]).map((p) => p.title),
   ['A', 'B'], 'merge de-dupes by id (first title wins), order preserved');

// ---------------------------------------------------------------------------
console.log('\n--- fetchAll: page through the WHOLE catalogue ---');
(async () => {
  // A stub transport that pages a fixture honoring offset/limit — a real paginated API.
  function pagedClient(all) {
    const calls = [];
    return {
      calls,
      async products({ offset, limit, title }) {
        calls.push({ offset, limit, title });
        return { success: true, products: all.slice(offset, offset + limit) };
      },
    };
  }

  {
    // 5 products, page size 2 → three pages (2 + 2 + 1), all five returned.
    const all = [1, 2, 3, 4, 5].map((n) => ({ id: 'p' + n, title: 'P' + n }));
    const c = pagedClient(all);
    const got = await P.fetchAll(c, { pageSize: 2 });
    eq(got.length, 5, 'every product across pages is returned');
    eq(got.map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5'], 'in order, no dupes');
    eq(c.calls.map((x) => x.offset), [0, 2, 4], 'offset advanced page by page and STOPPED on the short last page');
  }

  {
    // One short page (fewer than pageSize) → exactly one call, no needless second page.
    const c = pagedClient([{ id: 'only', title: 'Only one' }]);
    const got = await P.fetchAll(c, { pageSize: 200 });
    eq(got.length, 1, 'a single-product catalogue reads fine');
    eq(c.calls.length, 1, 'and only makes ONE call (short page ends it)');
    eq(got[0].title, 'Only one', 'its name is shown');
  }

  {
    // An endpoint that IGNORES offset (returns the same first page forever) must not loop.
    let n = 0;
    const stuck = { async products() { n++; return { products: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }] }; } };
    const got = await P.fetchAll(stuck, { pageSize: 2 });
    eq(got.length, 2, 'a repeated page de-dupes to its real contents');
    ok(n <= 2, `and stops (added-nothing guard) rather than looping forever (calls=${n})`);
  }

  {
    // Empty catalogue.
    const c = pagedClient([]);
    eq((await P.fetchAll(c, { pageSize: 2 })).length, 0, 'an empty catalogue → empty list');
  }

  {
    // The `title` filter is passed through to the transport.
    const c = pagedClient([{ id: 'a', title: 'Appraisal' }]);
    await P.fetchAll(c, { title: '  URAR  ' });
    eq(c.calls[0].title, 'URAR', 'the title filter is trimmed and passed to the endpoint');
    const c2 = pagedClient([{ id: 'a', title: 'x' }]);
    await P.fetchAll(c2, {});
    ok(c2.calls[0].title === undefined, 'no filter → title is undefined (not sent)');
  }

  console.log(`\nclass products: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
