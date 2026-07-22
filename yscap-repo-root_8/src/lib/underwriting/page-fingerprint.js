'use strict';
/**
 * R5.7 — Page fingerprint (perceptual + text hash) — deterministic core, ADVISORY.
 *
 * After a combined PDF packet is rendered + OCR'd (R5.8 quality, R5.9 splitter),
 * every page has extracted text and — when a raster renderer is available — a
 * perceptual image hash. This module turns those into a stable per-page
 * FINGERPRINT so the packet pipeline can answer three questions deterministically,
 * with no AI and no I/O:
 *
 *   1. Is this page an EXACT duplicate of another? (byte-identical re-scan / a
 *      statement uploaded twice under two conditions.) → text hash equality.
 *   2. Is it a NEAR duplicate? (same statement re-exported, a page that differs
 *      only in a footer timestamp, an OCR pass with a few flipped characters.)
 *      → simhash Hamming distance under a threshold.
 *   3. Are two pages visually the same even when OCR text differs? (a blank
 *      separator, a full-page image with no selectable text.) → perceptual
 *      image-hash Hamming distance, when the renderer supplied one.
 *
 * Why it matters: a packet full of duplicate pages inflates the page count, makes
 * the splitter propose phantom boundaries, and double-counts the same bank
 * balance. Flagging duplicates lets a human collapse them and lets liquidity math
 * refuse to add the same account twice (R5.59).
 *
 * Pure: no DB, no AI, no image libs — it consumes text (from OCR) and an OPTIONAL
 * perceptual hash hex (from the renderer, e.g. a 64-bit aHash/dHash). It computes
 * the text side itself; it never renders a page. Advisory: it REPORTS duplicates
 * and clusters; it never deletes, merges, or reorders a page. Never throws.
 */

const crypto = require('crypto');

// A page with fewer than this many meaningful characters (after normalization)
// and no image hash is treated as textually EMPTY — its text hash/simhash are not
// trusted for near-duplicate matching (every blank page would otherwise "match"
// every other blank page on text alone; visual matching still applies).
const EMPTY_TEXT_CHARS = 8;
// Default k for the word k-gram shingles the simhash is built from. 2-grams catch
// re-ordered lines without collapsing every page that shares common words.
const DEFAULT_SHINGLE = 2;
// Simhash is 64-bit → 16 hex chars. A Hamming distance at or under this (out of 64
// bits) is a NEAR-duplicate by default. Deliberately CONSERVATIVE: a small footer/
// date stamp or a couple of OCR flips on the same page lands at ~3-7, while two
// DIFFERENT months of the same statement template (different balances/dates — a
// genuinely different page that must NEVER be collapsed, or liquidity would
// double-count / drop an account) sit at ~16+. 7 keeps a wide safety margin below
// that, so the module errs toward "distinct" — a missed near-dup is just an extra
// row a human reviews; a false near-dup would merge real, different data.
const NEAR_TEXT_HAMMING = 7;
// Perceptual image-hash near-duplicate threshold (out of the hash's own bit length).
const NEAR_IMAGE_HAMMING = 6;

// 64-bit FNV-1a offset basis + prime (BigInt), masked to 64 bits.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

// Deterministic 64-bit hash of a string → BigInt in [0, 2^64).
function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i) & 0xff);
    // include the high byte too so multi-byte code units still spread bits
    h ^= BigInt((str.charCodeAt(i) >> 8) & 0xff) << 8n;
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

// Coerce any text-ish value to a string WITHOUT ever throwing — a hostile/broken
// value whose toString() throws must not break the module's "never throws"
// contract. A string is used as-is; anything else is String()'d in a guard.
function asString(text) {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  try { return String(text); } catch (_e) { return ''; }
}

// Normalize page text for hashing: lowercase, strip accents, collapse all runs of
// non-alphanumerics to a single space, trim. Deterministic and locale-free so the
// same page always hashes the same regardless of whitespace/punctuation noise.
function normText(text) {
  return asString(text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Extract the SALIENT dollar amounts / balances from a page's RAW text (before
// normalization strips the separators): money with commas/decimals, and bare
// integers of 4+ digits — the figures a bank statement's balances live in. Bare
// 4-digit plausible years (1900-2099) are excluded (a "printed 2026" footer is not
// an amount). This set is the corroboration signal behind near-duplicate detection:
// two pages that are the "same page" (a re-export, a footer stamp) carry the SAME
// amounts, while two different months carry DIFFERENT balances — so a near-simhash
// match whose amount sets DIFFER is not a duplicate, it is different data.
function salientNumbers(text) {
  const s = asString(text);
  const re = /\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d+\.\d{2}|\$?\d{4,}/g;
  const out = new Set();
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0].replace(/[$,]/g, '');
    const num = Number(tok);
    if (!Number.isFinite(num)) continue;
    // a bare 4-digit year is not a balance
    if (!tok.includes('.') && tok.length === 4 && num >= 1900 && num <= 2099) continue;
    out.add(String(num));
  }
  return out;
}

// Do two salient-amount sets carry DIFFERENT figures? (symmetric difference is
// non-empty). Only meaningful when BOTH pages actually have amounts.
function amountsDiffer(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}

// SHA-256 hex of the normalized text — the EXACT-duplicate key.
function textHash(text) {
  return crypto.createHash('sha256').update(normText(text)).digest('hex');
}

// Build the word k-gram shingle list from normalized text. Short text (fewer than
// k words) falls back to the individual words so a one-line page still fingerprints.
function shingles(norm, k) {
  const words = norm ? norm.split(' ').filter(Boolean) : [];
  if (words.length === 0) return [];
  if (words.length < k) return words.slice();
  const out = [];
  for (let i = 0; i + k <= words.length; i++) out.push(words.slice(i, i + k).join(' '));
  return out;
}

/**
 * simHash(text, opts?) → 16-char hex (64-bit). A locality-sensitive hash: two
 * pages whose text differs slightly differ in only a few bits, so a small Hamming
 * distance means "nearly the same page". Empty/normalizes-to-nothing text → all
 * zeros ('0000000000000000').
 *   opts.shingle: k-gram size (default 2)
 */
function simHash(text, opts = {}) {
  const k = Number.isInteger(opts.shingle) && opts.shingle >= 1 ? opts.shingle : DEFAULT_SHINGLE;
  const norm = normText(text);
  const grams = shingles(norm, k);
  if (grams.length === 0) return '0000000000000000';
  // Weight each shingle by how often it appears (frequency = importance).
  const freq = new Map();
  for (const g of grams) freq.set(g, (freq.get(g) || 0) + 1);
  const bits = new Array(64).fill(0);
  for (const [g, w] of freq) {
    const h = fnv1a64(g);
    for (let b = 0; b < 64; b++) {
      const set = (h >> BigInt(b)) & 1n;
      bits[b] += set === 1n ? w : -w;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (bits[b] > 0) out |= (1n << BigInt(b));
  return out.toString(16).padStart(16, '0');
}

// Popcount of a BigInt (number of set bits).
function popcount(x) {
  let n = 0;
  while (x > 0n) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// Is a string a plausible hex hash? (even length, hex digits only).
function isHex(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * hamming(hexA, hexB) → the bitwise Hamming distance between two EQUAL-LENGTH hex
 * hashes, or null when either is not hex or the lengths differ (comparing hashes
 * of different bit lengths is meaningless — never coerce). Works for the 64-bit
 * simhash AND any-length perceptual image hash.
 */
function hamming(hexA, hexB) {
  if (!isHex(hexA) || !isHex(hexB) || hexA.length !== hexB.length) return null;
  const a = BigInt('0x' + hexA), b = BigInt('0x' + hexB);
  return popcount(a ^ b);
}

/**
 * fingerprintPage(page) → {
 *   pageNumber, empty, charCount, textHash, simhash, imageHash|null, bitLen
 * }
 *   page: { text?|ocrText?, imageHash?|imageHashHex? (hex perceptual hash),
 *           pageNumber?|page_number? }
 * Computes the text side; carries through a supplied perceptual image hash
 * (validated to be hex, else dropped to null). `empty` marks a page whose text is
 * too sparse to trust for text matching (visual matching still applies).
 */
function fingerprintPage(page) {
  const p = page || {};
  const rawText = p.text != null ? p.text : (p.ocrText != null ? p.ocrText : (p.ocr_text != null ? p.ocr_text : ''));
  const norm = normText(rawText);
  const charCount = norm.replace(/ /g, '').length;
  const imgRaw = p.imageHash != null ? p.imageHash : (p.imageHashHex != null ? p.imageHashHex : p.image_hash);
  const imageHash = isHex(imgRaw) ? String(imgRaw).toLowerCase() : null;
  const pn = p.pageNumber != null ? p.pageNumber : (p.page_number != null ? p.page_number : null);
  return {
    pageNumber: Number.isInteger(Number(pn)) ? Number(pn) : null,
    empty: charCount < EMPTY_TEXT_CHARS,
    charCount,
    textHash: textHash(rawText),
    simhash: simHash(rawText),
    amounts: salientNumbers(rawText),   // salient dollar figures — the corroboration signal
    imageHash,
    bitLen: 64,
  };
}

/**
 * compare(a, b, opts?) → {
 *   relation: 'identical' | 'near_duplicate' | 'distinct',
 *   textIdentical, textHamming|null, imageHamming|null,
 *   similarity  // 0..1 over the strongest available signal
 * }
 * a, b: fingerprintPage() outputs (or raw pages — they're fingerprinted on the fly).
 * Rules, strongest signal first:
 *   - EXACT: same non-empty text hash  → identical.
 *   - text simhash Hamming ≤ near-text threshold (both non-empty) → near_duplicate.
 *   - image hash present on both + Hamming ≤ near-image threshold → near_duplicate
 *     (covers blank/image-only pages OCR can't distinguish).
 *   - else distinct.
 * Two EMPTY pages are never called duplicates on text alone (every blank page has
 * the same empty text hash) — only a matching IMAGE hash pairs them.
 */
function compare(a, b, opts = {}) {
  const fa = a && a.textHash ? a : fingerprintPage(a);
  const fb = b && b.textHash ? b : fingerprintPage(b);
  const nearText = Number.isFinite(opts.nearTextHamming) ? opts.nearTextHamming : NEAR_TEXT_HAMMING;
  const nearImage = Number.isFinite(opts.nearImageHamming) ? opts.nearImageHamming : NEAR_IMAGE_HAMMING;

  const bothTextReal = !fa.empty && !fb.empty;
  const textIdentical = bothTextReal && fa.textHash === fb.textHash;
  const textHamming = bothTextReal ? hamming(fa.simhash, fb.simhash) : null;
  const imageHamming = (fa.imageHash && fb.imageHash) ? hamming(fa.imageHash, fb.imageHash) : null;

  // Corroboration veto: a NEAR (non-identical) text match between two pages that
  // carry DIFFERENT salient dollar amounts is NOT a duplicate — it is different
  // data (two months of the same statement template) that simhash alone can't
  // separate on a boilerplate-heavy page. Identical text (same hash) has identical
  // amounts by construction, so the veto never blocks a true exact duplicate.
  const amtsDiffer = amountsDiffer(fa.amounts, fb.amounts);

  let relation = 'distinct';
  let similarity = 0;
  if (textIdentical) {
    relation = 'identical';
    similarity = 1;
  } else if (textHamming != null && textHamming <= nearText && !amtsDiffer) {
    relation = 'near_duplicate';
    similarity = 1 - textHamming / 64;
  } else if (imageHamming != null && imageHamming <= nearImage && !amtsDiffer) {
    relation = 'near_duplicate';
    similarity = 1 - imageHamming / (fa.imageHash.length * 4);
  } else {
    // report the best similarity we can even when distinct, for ranking.
    if (textHamming != null) similarity = Math.max(similarity, 1 - textHamming / 64);
    if (imageHamming != null) similarity = Math.max(similarity, 1 - imageHamming / (fa.imageHash.length * 4));
  }
  return {
    relation,
    textIdentical,
    textHamming,
    imageHamming,
    similarity: Math.round(similarity * 1000) / 1000,
  };
}

/**
 * groupDuplicates(pages, opts?) → {
 *   fingerprints: [fingerprintPage...],
 *   clusters: [{ pages:[pageNumber|index...], size, exact }],   // size ≥ 2 only
 *   duplicatePageCount,   // total pages that belong to some cluster
 *   uniquePageCount,      // pages not in any cluster + one representative per cluster
 * }
 * Union-finds pages into near-duplicate clusters (pairwise compare). O(n²) in the
 * page count — fine for a packet (tens to low hundreds of pages), and it never
 * enumerates anything unbounded. `exact` marks a cluster whose members are all
 * byte-identical text. Advisory only: a caller decides which representative to keep.
 */
function groupDuplicates(pages, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const fps = list.map((p) => fingerprintPage(p));
  const n = fps.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry); };
  // A SEPARATE union-find over ONLY the byte-identical (textIdentical) pairs.
  // Identical-text is a true equivalence relation, so an exact-component is a set
  // of pages that are all identical to each other — a cluster is only truly `exact`
  // when every member shares one exact-root (never when a NEAR link bridged two
  // distinct exact pairs, e.g. Jan==Jan' ~ Feb==Feb').
  const eparent = Array.from({ length: n }, (_, i) => i);
  const efind = (x) => { while (eparent[x] !== x) { eparent[x] = eparent[eparent[x]]; x = eparent[x]; } return x; };
  const eunion = (x, y) => { const rx = efind(x), ry = efind(y); if (rx !== ry) eparent[Math.max(rx, ry)] = Math.min(rx, ry); };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = compare(fps[i], fps[j], opts);
      if (c.relation !== 'distinct') {
        union(i, j);
        if (c.textIdentical) eunion(i, j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const idOf = (i) => (fps[i].pageNumber != null ? fps[i].pageNumber : i);
  const clusters = [];
  let duplicatePageCount = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    duplicatePageCount += members.length;
    const eroot = efind(members[0]);
    clusters.push({
      pages: members.map(idOf),
      size: members.length,
      // exact only when EVERY member is in the same exact (identical-text) component
      exact: members.every((i) => efind(i) === eroot),
    });
  }
  clusters.sort((a, b) => (b.size - a.size) || (a.pages[0] - b.pages[0]));
  const uniquePageCount = n - duplicatePageCount + clusters.length;
  return { fingerprints: fps, clusters, duplicatePageCount, uniquePageCount };
}

module.exports = {
  fingerprintPage,
  textHash,
  simHash,
  hamming,
  compare,
  groupDuplicates,
  _internals: { normText, shingles, fnv1a64, popcount, isHex, salientNumbers, amountsDiffer, asString },
  EMPTY_TEXT_CHARS,
  NEAR_TEXT_HAMMING,
  NEAR_IMAGE_HAMMING,
};
