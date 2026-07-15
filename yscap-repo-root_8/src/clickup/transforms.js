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

// 'Unknown' / 'Co-Borrower' are OUR OWN placeholders (the NOT NULL name columns
// need something at insert time) — they are never real data. Every store/heal
// path must treat them as ABSENT, exactly like the push side already blanks
// 'Unknown' before writing ClickUp. Root fix 2026-07-14: the pull/store side
// treating placeholders as data is what froze co-borrowers as
// "Unknown Unknown" forever.
const PLACEHOLDER_NAMES = new Set(['', 'unknown', 'co-borrower', 'n/a', 'na', 'tbd', '-', '--']);
const isPlaceholderName = (v) => v == null || PLACEHOLDER_NAMES.has(String(v).trim().toLowerCase());
// Synthetic no-email shadow addresses minted by the sync (never user data).
const isShadowEmail = (v) => /@clickup\.local$/i.test(String(v || '').trim());

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
// LOOSE epoch → 'YYYY-MM-DD' with NO sanity window — for guard/forensic code
// that must SEE a corrupt stored day (e.g. a literal year-0095 DOB artifact)
// in order to classify and auto-resolve it. Never use this on a persistence
// path; fromEpochMs (windowed) remains the ingest chokepoint.
function epochToDayLoose(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!isFinite(n)) return null;
  try { return new Date(n + 12 * 3600 * 1000).toISOString().slice(0, 10); } catch (_) { return null; }
}

function fromEpochMs(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (!isFinite(n)) return null;
  // The synced ClickUp fields (DOB, expected/actual closing, acquisition date)
  // are all DATE-ONLY. ClickUp pins a no-time date to 4:00 AM in the timezone of
  // the user who set it (developer.clickup.com/docs/general-time), so a human
  // entry from this team sits at 08:00Z/09:00Z; our own writes sit at 4 AM
  // workspace time too (see dateOnlyToClickUpEpoch); and a legacy pre-fix portal
  // write sits at exactly 00:00Z. Snapping to the NEAREST UTC day (add 12h then
  // slice) makes every one of those resolve to its intended calendar day,
  // instead of rolling back a day (the off-by-one the owner saw on closing/DOB).
  return new Date(n + 12 * 3600 * 1000).toISOString().slice(0, 10);   // YYYY-MM-DD
}

// ---- date-only ClickUp WRITE convention (incident root fix, 2026-07-15) ----
// ClickUp renders a date field in each VIEWER's local timezone, and its own UI
// stores a no-time date at 4:00 AM in the setter's timezone. An epoch at UTC
// MIDNIGHT (what we used to write) is 7–8 PM the PREVIOUS evening in New York —
// so every date the portal pushed displayed one day early to the whole team,
// which is exactly how "the system changed the DOBs in ClickUp" looked, even
// when the stored epoch was the "technically correct" UTC day. The fix writes
// date-only values the same way ClickUp itself does for this team: 4 AM in the
// workspace's home timezone (America/New_York unless CLICKUP_DATE_TZ overrides).
// That epoch lands in the [08:00Z, 10:00Z] window, which (a) renders as the
// intended calendar day for every viewer from US Pacific (UTC-8) through Israel
// (UTC+3), and (b) round-trips through fromEpochMs' nearest-day snap to the very
// same day — enforced below, so a write our own pull would misread CANNOT happen.
const CLICKUP_DATE_TZ = process.env.CLICKUP_DATE_TZ || 'America/New_York';
const CLICKUP_DATE_HOUR = 4;

/** Offset (ms) of `tz` from UTC at the given instant (EDT → -14400000). */
function tzOffsetMs(tz, at) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return asUtc - at.getTime();
}
/** Calendar {y,m,d} of an instant, as seen in `tz`. */
function zonedYmd(tz, at) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day };
}
/** Epoch ms of Y-M-D at `hour`:00 local time in `tz` (DST-correct, two-pass). */
function epochAtZonedTime(y, m, d, hour, tz) {
  const guess = Date.UTC(y, m - 1, d, hour);
  let off = tzOffsetMs(tz, new Date(guess));
  off = tzOffsetMs(tz, new Date(guess - off));       // re-check across a DST edge
  return guess - off;
}

/**
 * A 'YYYY-MM-DD' day with an out-of-range year (mid-typing artifact, or a
 * 2-digit year the source wrote literally — ClickUp displays "26" for 2026,
 * and a "26" typed/imported as the actual year lands in year 0026). Propose
 * the intended year so a human can approve it from the review queue:
 *   kind 'dob':   00–99 pivots to the century that puts the date in the past
 *                 (26 → 1926; a DOB can never be in the future).
 *   other kinds:  00–99 pivots to 20xx (closings/submissions are modern).
 * Returns the corrected 'YYYY-MM-DD' or null when no sane proposal exists.
 */
function pivotSuspectYear(day, kind) {
  const m = /^(\d{1,4})-(\d{2})-(\d{2})$/.exec(String(day || '').trim());
  if (!m) return null;
  let y = Number(m[1]);
  if (y >= 1900 && y <= 2100) return null;              // not suspect
  if (y > 99) return null;                              // e.g. year 0203 — no safe guess
  if (kind === 'dob') {
    y += 2000;
    // A borrower is an adult: a pivoted DOB implying age < 18 (incl. the current
    // year — "26" in 2026 would mean a newborn) belongs a century back.
    if (y > new Date().getUTCFullYear() - 18) y -= 100;
  } else {
    y += 2000;
  }
  if (!(y >= 1900 && y <= 2100)) return null;
  return `${String(y).padStart(4, '0')}-${m[2]}-${m[3]}`;
}

/**
 * Portal date value → the epoch to WRITE into a ClickUp date field.
 * Accepts a 'YYYY-MM-DD' string (the pg date type-parser output), a JS Date /
 * epoch / ISO string (timestamptz like submitted_at — converted to its calendar
 * day IN THE WORKSPACE TZ, so a 11 PM New York submission stays on its NY day).
 * Returns null for blanks AND for out-of-range years (a mid-typing artifact like
 * year 0026 must never reach ClickUp again — this chokepoint refuses it even if
 * a bad value sneaks into the DB). Throws if the produced epoch would not
 * round-trip through fromEpochMs to the same day (structural loop-safety).
 */
function dateOnlyToClickUpEpoch(v, tz = CLICKUP_DATE_TZ) {
  if (v == null || v === '') return null;
  let y, m, d;
  if (!(v instanceof Date)) {
    const s = String(v).trim();
    const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);   // pure date-only string
    if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  }
  if (y == null) {
    const ms = toEpochMs(v);                          // instant-bearing value
    if (ms == null) return null;
    ({ y, m, d } = zonedYmd(tz, new Date(ms)));
  }
  if (!(y >= 1900 && y <= 2100)) return null;         // refuse garbage years
  const epoch = epochAtZonedTime(y, m, d, CLICKUP_DATE_HOUR, tz);
  const want = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (fromEpochMs(epoch) !== want) {
    throw new Error(`clickup date round-trip mismatch: ${want} -> ${epoch} -> ${fromEpochMs(epoch)}`);
  }
  return epoch;
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

// ---- YS loan number: placeholder / sentinel detection ---------------------
// The YS loan number is a GLOBAL match key (same number == same loan), so a
// PLACEHOLDER typed into that field ("TBD", "0", "N/A", blank, …) must NEVER be
// treated as a real number — otherwise two unrelated brand-new deals both marked
// "TBD" would link to each other (and collide on the unique index). This returns
// true for anything that is clearly a "no number yet" placeholder rather than a
// real loan number. Matching is on the WHOLE trimmed string (so a real number that
// merely CONTAINS "na"/"x" is never misclassified).
const LOAN_NUMBER_SENTINELS = new Set([
  'tbd', 'tba', 'tbc', 'n/a', 'na', 'n\\a', 'none', 'null', 'nil', 'nan',
  'pending', 'pend', 'unknown', 'unk', 'test', 'temp', 'tmp', 'placeholder',
  'loan', 'number', 'loannumber', 'loan number', 'loan#', 'loan #', '#',
  'none yet', 'not yet', 'no number', 'no loan number', 'tbd.', 'to be determined',
]);
function isPlaceholderLoanNumber(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '') return true;                              // blank / whitespace
  if (LOAN_NUMBER_SENTINELS.has(s)) return true;          // exact sentinel word
  const stripped = s.replace(/[\s\-_.#/\\]/g, '');        // drop separators/punct
  if (stripped === '' || /^0+$/.test(stripped)) return true; // all zeros / all punct
  if (/^x+$/.test(stripped) || /^\?+$/.test(stripped)) return true; // xxxx / ????
  return false;
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
  splitName, joinName, isPlaceholderName, isShadowEmail,
  toEpochMs, fromEpochMs, epochToDayLoose, dateOnlyToClickUpEpoch, epochAtZonedTime, zonedYmd, pivotSuspectYear,
  parseMoney, numToString,
  normalizePhone, phoneDigits,
  normalizeMarried, normalizeMarriedAI, portalMaritalToMarried, marriedToPortalMarital,
  parseCardLine, joinCardLine,
  dropdownIndexToLabel, dropdownIndexToId, dropdownLabelToId, dropdownIdToLabel,
  isPlaceholderLoanNumber,
  maskSSN, maskCard,
};
