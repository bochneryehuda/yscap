/**
 * Pure text-matching for the "highlight the conflicting text in the PDF" finding
 * feature. PDF.js gives a page's text as a list of items (each with a string +
 * position); this finds which items cover the value we want to highlight, so the
 * viewer can draw a box over them. Case-insensitive, and it tries a few FORMS of
 * the value (as-is, with $/spaces stripped, digits with grouping commas) so a
 * money value like "$425,000" matches PDF text of "425,000" or "$425,000.00".
 *
 * No length-changing normalization is done to the page text (only toLowerCase,
 * which preserves length), so a match's character offsets map straight back to
 * the items that produced them.
 */

// The candidate strings to try, most-specific first. Deduped, length >= 2.
export function highlightCandidates(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return [];
  const out = [];
  const add = (s) => { if (s && s.length >= 2 && !out.includes(s)) out.push(s); };
  add(raw);
  add(raw.replace(/[$\s]/g, ''));          // "$425,000" -> "425,000"
  add(raw.replace(/\s+/g, ''));            // "John Smith" -> "JohnSmith" (PDFs often drop the space)
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length >= 3) {
    add(digits);                           // "425000"
    try { add(Number(digits).toLocaleString('en-US')); } catch (_) { /* huge/NaN — skip */ }  // "425,000"
  }
  return out;
}

/**
 * @param {Array<{str:string}>} items  PDF.js textContent.items for one page
 * @param {*} value                    the value to highlight (finding doc_value)
 * @returns {number[]}  indices into `items` that cover the first match (or [])
 */
export function findHighlightItems(items, value) {
  const cands = highlightCandidates(value);
  if (!Array.isArray(items) || !items.length || !cands.length) return [];
  // Concatenate the page text, recording each item's [start, end) char range.
  let full = '';
  const spans = [];
  for (let i = 0; i < items.length; i++) {
    const s = String((items[i] && items[i].str) || '');
    spans.push([full.length, full.length + s.length, i]);
    full += s;
  }
  const hay = full.toLowerCase();
  for (const cand of cands) {
    const needle = cand.toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    const end = at + needle.length;
    const hit = [];
    for (const [s, e, idx] of spans) { if (s < end && e > at) hit.push(idx); }
    if (hit.length) return hit;
  }
  return [];
}
