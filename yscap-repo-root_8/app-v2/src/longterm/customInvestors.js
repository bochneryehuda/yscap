/**
 * LONG-TERM — THE BROWSER TWIN of two rules from `src/longterm/pricing/investor-roster.js`.
 *
 * The Add-an-investor form has to show the key it is about to create BEFORE the
 * server sees it ("ClearEdge Lending" → `clearedge_lending`), and it has to turn
 * a comma-separated box into the list of spellings a person will be shown back.
 * A screen cannot require server code, so these two rules exist twice.
 *
 * ⛔ THIS IS A MIRROR, NOT A SECOND DEFINITION. The server's copy is the one that
 * decides — the write door re-derives nothing from here and validates whatever it
 * is sent — so the worst a drift can do is show a person a key they will not get.
 * `scripts/test-lt-custom-investors-pure.js` runs BOTH copies over the same
 * battery and fails the moment they disagree, which is the only thing that keeps
 * a mirror honest. Change one, change the other.
 *
 * NOTHING ELSE IS MIRRORED, deliberately: the collision rules, the audience scrub
 * and the refusals all live at the door, where they cannot be talked past.
 */

const MAX_KEY = 64;
const MAX_LABEL = 120;
const MAX_WHITE_LABEL = 60;

/** Collapse whitespace, trim, cap — the same tidy the server applies. */
export function cleanText(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The key a label would produce. `&` becomes "and" (so "A&D Mortgage" keys the
 * way the registry itself spells it) and accents are folded, so a name typed
 * with one still lands on a key made of the letters and digits only.
 */
export function keyFromLabel(label) {
  return String(label == null ? '' : label)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY);
}

/**
 * The spellings from a comma-separated box (semicolons and new lines too, since
 * that is what a paste from a spreadsheet carries). Case-insensitively deduped,
 * keeping the first spelling — the one the person typed.
 */
export function parseAliases(v) {
  const parts = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\n]/);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const s = cleanText(p, MAX_LABEL);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export const LIMITS = { MAX_KEY, MAX_LABEL, MAX_WHITE_LABEL };
