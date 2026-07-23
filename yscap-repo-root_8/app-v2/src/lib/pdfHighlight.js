/**
 * Pure text-matching for the "highlight the conflicting text in the PDF" finding
 * feature. PDF.js gives a page's text as a list of items (each with a string +
 * position); this finds which items cover the value we want to highlight, so the
 * viewer can draw a box over them. Case-insensitive, and it tries a few FORMS of
 * the value (as-is, with $/spaces stripped, digits with grouping commas) so a
 * money value like "$425,000" matches PDF text of "425,000" or "$425,000.00".
 *
 * The page text is lower-cased PER ITEM before it is concatenated, and each
 * item's [start, end) span is measured on that SAME lower-cased string that we
 * then search — so a match's character offsets always map straight back to the
 * items that produced them, even for characters whose lower-case form changes
 * length (e.g. İ → i̇). (Lower-casing the whole concatenation AFTER measuring
 * spans on the original text would shift the offsets for such characters and
 * spill the highlight into an adjacent item.)
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
  // Concatenate the LOWER-CASED page text, recording each item's [start, end)
  // char range on that same lower-cased string. Lower-casing per item (not once
  // over the whole concatenation) keeps every offset aligned even when a
  // character's lower-case form changes length.
  let full = '';
  const spans = [];
  for (let i = 0; i < items.length; i++) {
    const s = String((items[i] && items[i].str) || '').toLowerCase();
    spans.push([full.length, full.length + s.length, i]);
    full += s;
  }
  for (const cand of cands) {
    const needle = cand.toLowerCase();
    const at = full.indexOf(needle);
    if (at < 0) continue;
    const end = at + needle.length;
    const hit = [];
    // e > s skips zero-width (empty) items — they can't "cover" any character,
    // so a blank item between two matched items never draws a stray box.
    // Substring matching is deliberate (best-effort): a bare-digit candidate can
    // land inside a longer digit run when the page has no better-formatted form,
    // which is acceptable for a soft visual cue.
    for (const [s, e, idx] of spans) { if (e > s && s < end && e > at) hit.push(idx); }
    if (hit.length) return hit;
  }
  return [];
}
