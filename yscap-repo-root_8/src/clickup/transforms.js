/**
 * Value transforms for the ClickUp ⇄ portal sync — the exact algorithms from
 * docs/CLICKUP-DATA-MAPPING.md Part 6.12. Pure functions, no I/O, so they're
 * unit-testable in isolation (see scripts/test-clickup-transforms.js).
 *
 * ClickUp read/write is asymmetric for dropdowns: reads return the option's
 * orderindex INTEGER, writes take the option UUID. dropdownIndexToId /
 * dropdownLabelToId below are the single translation point for that.
 */

// ---- names ----------------------------------------------------------------
function splitName(full) {
  const s = String(full || '').trim().replace(/\s+/g, ' ');
  if (!s) return { first: '', last: '' };
  const i = s.lastIndexOf(' ');
  if (i < 0) return { first: s, last: '' };
  return { first: s.slice(0, i), last: s.slice(i + 1) };
}
const joinName = (first, last) => [first, last].map((x) => String(x || '').trim()).filter(Boolean).join(' ');

// ---- dates (portal date <-> ClickUp epoch ms) -----------------------------
function toEpochMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v.getTime();
  const s = String(v).trim();
  // Date-only YYYY-MM-DD → midnight UTC (avoid TZ drift).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const n = Number(s);
  if (isFinite(n) && s.length >= 10) return n;            // already epoch ms
  const d = new Date(s);
  return isNaN(d) ? null : d.getTime();
}
function fromEpochMs(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 10);          // YYYY-MM-DD
}

// ---- money / numbers ------------------------------------------------------
function parseMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
}
const numToString = (n) => (n == null || n === '' || !isFinite(Number(n)) ? null : String(Number(n)));

// ---- phone (US E.164-ish) -------------------------------------------------
function normalizePhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '+' + d;                                          // pass through intl
}
const phoneDigits = (v) => String(v || '').replace(/\D/g, '') || null;

// ---- marital (smart normalization, both ways) -----------------------------
// ClickUp "Marital Status" is a YES/NO = "is married?" dropdown. We accept any
// phrasing and resolve to a boolean; an optional async LLM hook handles input
// the keyword pass can't classify.
const MARRIED_YES = /\b(married|marreid|spouse|husband|wife|wedded)\b/i;
const MARRIED_NO = /\b(?:single|un[\s-]?married|not\s+married|never\s+married|divorc\w*|separat\w*|widow\w*|bachelor)\b/i;
function normalizeMarried(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (MARRIED_NO.test(s)) return false;    // check "unmarried/not married" before "married"
  if (MARRIED_YES.test(s)) return true;
  return null;                             // unknown → caller may use the AI hook
}
/**
 * Async wrapper: keyword pass first; if unclear, call the injected LLM
 * classifier (so the sync can run fully offline/deterministic when no model is
 * wired). classify(text) must resolve to true|false|null.
 */
async function normalizeMarriedAI(text, classify) {
  const kw = normalizeMarried(text);
  if (kw !== null || typeof classify !== 'function') return kw;
  try { const r = await classify(String(text || '')); return r === true || r === false ? r : null; }
  catch { return null; }
}
// portal marital_status string <-> boolean(is-married)
const portalMaritalToMarried = (status) => normalizeMarried(status);
const marriedToPortalMarital = (isMarried, existing) =>
  isMarried === true ? 'Married' : (existing || 'Single');

// ---- appraisal card line (single ClickUp field <-> structured slots) ------
// ClickUp stores e.g. "4266843539945489    05/31   789". Parse to parts on
// pull; join on push. PCI-sensitive: callers encrypt number/cvv and never log.
function parseCardLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  // number (13-19 digits, possibly spaced) · exp mm/yy(yy) · cvv (3-4)
  const m = /(\d[\d ]{11,21}\d)\D+(\d{1,2}\s*[\/\-]\s*\d{2,4})\D+(\d{3,4})\b/.exec(s);
  if (m) {
    const number = m[1].replace(/\s/g, '');
    return { number, exp: m[2].replace(/\s/g, ''), cvv: m[3], last4: number.slice(-4) };
  }
  // fallback: whitespace tokens → [number, exp, cvv]
  const toks = s.split(/\s+/).filter(Boolean);
  const numTok = toks.find((t) => /^\d[\d]{11,}$/.test(t.replace(/\D/g, '')) && t.replace(/\D/g, '').length >= 12);
  const expTok = toks.find((t) => /^\d{1,2}[\/\-]\d{2,4}$/.test(t));
  const cvvTok = toks.find((t) => /^\d{3,4}$/.test(t) && t !== numTok);
  if (!numTok && !expTok && !cvvTok) return { raw: s };     // unparseable — keep raw for a human
  const number = (numTok || '').replace(/\D/g, '');
  return { number: number || null, exp: expTok || null, cvv: cvvTok || null, last4: number ? number.slice(-4) : null };
}
function joinCardLine({ number, exp, cvv } = {}) {
  return [number, exp, cvv].map((x) => String(x || '').trim()).filter(Boolean).join('  ') || null;
}

// ---- generic dropdown index<->uuid<->label translation --------------------
// optionList = [{ id, orderindex, name }] (from ClickUp field type_config.options)
const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
function dropdownIndexToLabel(optionList, index) {
  if (!Array.isArray(optionList) || index == null) return null;
  const byIdx = optionList.find((o) => Number(o.orderindex) === Number(index));
  return byIdx ? byIdx.name : null;
}
function dropdownIndexToId(optionList, index) {
  if (!Array.isArray(optionList) || index == null) return null;
  const byIdx = optionList.find((o) => Number(o.orderindex) === Number(index));
  return byIdx ? byIdx.id : null;
}
function dropdownLabelToId(optionList, label) {
  if (!Array.isArray(optionList) || label == null) return null;
  const want = _norm(label);
  const hit = optionList.find((o) => _norm(o.name) === want)
           || optionList.find((o) => _norm(o.name).startsWith(want) || want.startsWith(_norm(o.name)));
  return hit ? hit.id : null;
}
function dropdownIdToLabel(optionList, id) {
  if (!Array.isArray(optionList) || !id) return null;
  const hit = optionList.find((o) => o.id === id);
  return hit ? hit.name : null;
}

// ---- masking (for logs / activity feed) -----------------------------------
function maskSSN(ssn) {
  const d = String(ssn || '').replace(/\D/g, '');
  return d ? `✱✱✱-✱✱-${d.slice(-4)}` : '';
}
function maskCard(number) {
  const d = String(number || '').replace(/\D/g, '');
  return d ? `✱✱✱✱ ✱✱✱✱ ✱✱✱✱ ${d.slice(-4)}` : '';
}

module.exports = {
  splitName, joinName,
  toEpochMs, fromEpochMs,
  parseMoney, numToString,
  normalizePhone, phoneDigits,
  normalizeMarried, normalizeMarriedAI, portalMaritalToMarried, marriedToPortalMarital,
  parseCardLine, joinCardLine,
  dropdownIndexToLabel, dropdownIndexToId, dropdownLabelToId, dropdownIdToLabel,
  maskSSN, maskCard,
};
