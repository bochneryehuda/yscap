'use strict';
/**
 * Class Valuation product (form) catalogue — the response reader + the paginated fetch.
 *
 * WHY THIS EXISTS. Two things the "Get all available products" endpoint does that the
 * naive `resp.products` read got wrong:
 *
 *  1. IT IS PAGINATED. The V1 guide ("Get all available products", p.54) documents
 *     `GET /products` with `offset` + `limit` query params — a page, not the whole
 *     catalogue. Asking for `limit=200` returns at most one page; a lender with more
 *     products than the server's page cap silently loses the rest. `fetchAll` pages
 *     through with `offset` until the catalogue is exhausted, so the screen always
 *     shows every report the account can order.
 *
 *  2. THE NAME A HUMAN READS IS `title`, WITH `alternativeName` AS THE FALLBACK. Each
 *     product carries `id / title / active / isLicensingEnabled / created /
 *     alternativeName`. `id` is an opaque Mongo id (e.g. 638a58a35b6c2c21d6c370f9) —
 *     never a name — so when `title` is blank the vendor's human name is in
 *     `alternativeName`, and `normalizeProduct` settles ONE display `title` so the
 *     picker never falls back to a bare id.
 *
 * The parsers are PURE. `fetchAll` takes the transport as an argument, so it is unit
 * tested with a stub client and never touches the network here
 * (scripts/test-class-products-pure.js). The `/v2/products` (UAD 3.6) endpoint returns
 * the identical shape (guide p.60), so the same parser serves both when a caller wires
 * the v2 path.
 */

// The catalogue lives under `products` per the guide; the other keys are defensive so a
// vendor shape drift degrades to "read fewer" rather than "read nothing".
function extractArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== 'object') return [];
  for (const k of ['products', 'data', 'items', 'results', 'value', 'records', 'content']) {
    if (Array.isArray(resp[k])) return resp[k];
  }
  return [];
}

function firstString(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

// One product → a stable shape the screen renders without guessing. A row with no id at
// all is unusable (nothing to order) and is dropped.
function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const id = firstString(p.id, p.productId, p._id, p.code);
  if (!id) return null;
  const alternativeName = firstString(p.alternativeName, p.altName);
  // The recognisable name: title, then the alternative name the vendor sometimes uses
  // instead, and only then a plain "Product <id>" — never a bare, nameless id.
  const title = firstString(p.title, p.name, p.productName, p.displayName, p.label, alternativeName)
    || `Product ${id}`;
  return {
    id,
    title,
    alternativeName: alternativeName || null,
    active: p.active !== false,          // a missing flag reads as active (do not hide it)
    isLicensingEnabled: p.isLicensingEnabled === true,
    created: p.created || null,
  };
}

// A single response page → a normalized product array (unusable rows dropped).
function parseProductPage(resp) {
  return extractArray(resp).map(normalizeProduct).filter(Boolean);
}

// Merge pages, de-duping by id (first title wins), preserving order first-seen.
function mergeProducts(pages) {
  const byId = new Map();
  for (const page of pages) {
    for (const p of page) if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return Array.from(byId.values());
}

const PAGE_SIZE = 200;
const MAX_PRODUCTS = 5000;   // a hard ceiling so a misbehaving endpoint can never loop us forever

/**
 * Fetch the WHOLE catalogue, paging through `offset`/`limit`.
 * @param client the Class transport (only `client.products(query)` is used).
 * @param opts.title  optional server-side name filter (the endpoint's `title` param).
 * The loop stops on: an empty page, a short (final) page, a page that adds NO new ids
 * (an endpoint that ignores `offset` would otherwise repeat forever), or the ceiling.
 */
async function fetchAll(client, opts = {}) {
  const title = firstString(opts.title) || undefined;
  const pageSize = opts.pageSize || PAGE_SIZE;
  const cap = opts.maxProducts || MAX_PRODUCTS;
  const maxPages = Math.ceil(cap / pageSize) + 1;
  const pages = [];
  const seen = new Set();
  let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    const resp = await client.products({ offset, limit: pageSize, title });
    const page = parseProductPage(resp);
    if (!page.length) break;                       // no more rows
    let added = 0;
    for (const p of page) if (!seen.has(p.id)) { seen.add(p.id); added++; }
    pages.push(page);
    if (added === 0) break;                        // offset ignored / repeated page → stop
    if (page.length < pageSize) break;             // last (short) page
    if (seen.size >= cap) break;                   // safety ceiling
    offset += pageSize;
  }
  return mergeProducts(pages);
}

module.exports = {
  extractArray, normalizeProduct, parseProductPage, mergeProducts, fetchAll,
  PAGE_SIZE, MAX_PRODUCTS, _internals: { firstString },
};
