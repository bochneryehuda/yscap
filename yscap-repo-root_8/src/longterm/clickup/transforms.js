'use strict';
/**
 * LONG-TERM — value transforms for the ClickUp field writer.
 *
 * BY-VALUE COPY of the proven RTL machinery (src/clickup/transforms.js), under
 * the CLICKUP WRITER'S INHERITANCE sanction (owner, 2026-08-23 — recorded in
 * docs/LONG-TERM-AUTHORIZED-COPIES.md). A copy, not an import: this file
 * requires ZERO RTL modules, so the two products stay two systems and the CI
 * separation gate stays honest. Trimmed to what the LT writer uses — the card
 * line and the AI marital hook are RTL-only and did not cross.
 *
 * PURE. No I/O, no database — every rule unit-testable in isolation.
 */

// ---- dates (portal date -> ClickUp epoch ms) ------------------------------
function toEpochMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v.getTime();
  const s = String(v).trim();
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
  // The synced ClickUp fields are all DATE-ONLY. ClickUp pins a no-time date to
  // 4:00 AM in the timezone of the user who set it, so a human entry from this
  // team sits at 08:00Z/09:00Z; our own writes sit at 4 AM workspace time too
  // (see dateOnlyToClickUpEpoch); and a legacy UTC-midnight write sits at
  // exactly 00:00Z. Snapping to the NEAREST UTC day (add 12h then slice) makes
  // every one of those resolve to its intended calendar day.
  return new Date(n + 12 * 3600 * 1000).toISOString().slice(0, 10);   // YYYY-MM-DD
}

// ---- date-only ClickUp WRITE convention (the RTL 2026-07-15 incident fix) --
// ClickUp renders a date field in each VIEWER's local timezone, and its own UI
// stores a no-time date at 4:00 AM in the setter's timezone. An epoch at UTC
// MIDNIGHT is 7-8 PM the PREVIOUS evening in New York — so every date pushed
// that way displays one day early to the whole team, which is exactly how "the
// system changed the DOBs in ClickUp" looked, even when the stored epoch was
// the "technically correct" UTC day. The fix writes date-only values the same
// way ClickUp itself does for this team: 4 AM in the workspace's home timezone.
// That epoch lands in the [08:00Z, 10:00Z] window, which (a) renders as the
// intended calendar day for every viewer from US Pacific through Israel, and
// (b) round-trips through fromEpochMs' nearest-day snap to the very same day —
// enforced below, so a write our own read would misread CANNOT happen.
const CLICKUP_DATE_TZ = process.env.CLICKUP_DATE_TZ || 'America/New_York';
const CLICKUP_DATE_HOUR = 4;

/** Offset (ms) of `tz` from UTC at the given instant (EDT -> -14400000). */
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
 * Portal date value -> the epoch to WRITE into a ClickUp date field.
 * Accepts a 'YYYY-MM-DD' string, a US 'MM/DD/YYYY' string (Encompass's own
 * format — the LT addition to the copy), a JS Date / epoch / ISO string
 * (converted to its calendar day IN THE WORKSPACE TZ). Returns null for blanks,
 * for Encompass's '//' unreached-date convention, AND for out-of-range years (a
 * mid-typing year-0026 artifact must never reach ClickUp). Throws if the
 * produced epoch would not round-trip through fromEpochMs to the same day.
 */
function dateOnlyToClickUpEpoch(v, tz = CLICKUP_DATE_TZ) {
  if (v == null || v === '') return null;
  let y, m, d;
  if (!(v instanceof Date)) {
    const s = String(v).trim();
    if (/^[/\s-]*$/.test(s)) return null;             // Encompass '//' = unreached
    let mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);     // pure date-only string
    if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
    if (y == null) {
      mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // US date — Encompass fieldReader output
      if (mm) { y = +mm[3]; m = +mm[1]; d = +mm[2]; }
    }
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
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  // "N/A" (or any text with no digit) strips to "" and Number("") is 0 — a real
  // zero that silently overwrites a six-figure amount. Require a digit.
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
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

// ---- marital (field 52 -> the YES/NO "is married?" dropdown) --------------
const MARRIED_YES = /\b(married|marreid|spouse|husband|wife|wedded)\b/i;
const MARRIED_NO = /\b(?:single|un[\s-]?married|not\s+married|never\s+married|divorc\w*|separat\w*|widow\w*|bachelor)\b/i;
function normalizeMarried(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (MARRIED_NO.test(s)) return false;    // "unmarried/not married" before "married"
  if (MARRIED_YES.test(s)) return true;
  return null;
}

// ---- generic dropdown index<->uuid<->label translation --------------------
// ClickUp READS a dropdown as the option's orderindex INTEGER; WRITES take the
// option UUID. These four helpers are the single translation point.
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
// The loan number is a match key; a PLACEHOLDER ("TBD", "0", "N/A", "xxxx")
// must never be written as a real number.
const LOAN_NUMBER_SENTINELS = new Set([
  'tbd', 'tba', 'tbc', 'n/a', 'na', 'n\\a', 'none', 'null', 'nil', 'nan',
  'pending', 'pend', 'unknown', 'unk', 'test', 'temp', 'tmp', 'placeholder',
  'loan', 'number', 'loannumber', 'loan number', 'loan#', 'loan #', '#',
  'none yet', 'not yet', 'no number', 'no loan number', 'tbd.', 'to be determined',
]);
function isPlaceholderLoanNumber(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '') return true;
  if (LOAN_NUMBER_SENTINELS.has(s)) return true;
  const stripped = s.replace(/[\s\-_.#/\\]/g, '');
  if (stripped === '' || /^0+$/.test(stripped)) return true;
  if (/^x+$/.test(stripped) || /^\?+$/.test(stripped)) return true;
  return false;
}

// ---- placeholder names / shadow emails ------------------------------------
// Synthetic values a mirror mints must never be pushed as data.
const PLACEHOLDER_NAMES = new Set(['unknown', 'co-borrower', 'coborrower', 'borrower', 'n/a', 'na', 'tbd', 'test']);
function isPlaceholderName(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return true;
  if (PLACEHOLDER_NAMES.has(s)) return true;
  return s === 'unknown unknown';
}
const isShadowEmail = (v) => /@(clickup|import)\.local$/i.test(String(v || '').trim());

// ---- masking (for the journal / logs) -------------------------------------
function maskSSN(ssn) {
  const d = String(ssn || '').replace(/\D/g, '');
  return d ? `✱✱✱-✱✱-${d.slice(-4)}` : '';
}

module.exports = {
  toEpochMs, fromEpochMs, dateOnlyToClickUpEpoch, epochAtZonedTime, zonedYmd,
  parseMoney, numToString,
  normalizePhone, phoneDigits,
  normalizeMarried,
  dropdownIndexToLabel, dropdownIndexToId, dropdownLabelToId, dropdownIdToLabel,
  isPlaceholderLoanNumber, isPlaceholderName, isShadowEmail,
  maskSSN,
  CLICKUP_DATE_TZ, CLICKUP_DATE_HOUR,
};
