/* Shared bits for the Research desk screens (property search, property page,
   appraiser directory, the valuation grid).

   COLOUR NOTE, and it is a real trap in this codebase: the `--ink*` tokens are
   LIGHT (paper) colours despite their names, so they must never be used for a
   text `color`. Dark text is `#141B22`, secondary text is `#4B585C`. */

export const INK = '#141B22';
export const MUTED = '#4B585C';
export const GOLD = '#AE8746';
export const TEAL = '#2F7F86';

export const money = (v) =>
  (v == null || v === '' ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
export const money0 = (v) =>
  (v == null || v === '' ? '' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
export const num = (v, digits = 0) =>
  (v == null || v === '' ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }));
export const sqft = (v) => (v == null || v === '' ? '—' : Math.round(Number(v)).toLocaleString('en-US') + ' sq ft');
export const pct = (v, d = 1) => (v == null || v === '' ? '—' : Number(v).toFixed(d) + '%');

/* A date-only value is a 'YYYY-MM-DD' STRING end to end in this codebase — never
   run it through `new Date()`, which reads it as UTC midnight and can render the
   day before in a western timezone. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function day(v) {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (!m) return String(v);
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}
/* Appraisal sale dates are month-resolution (the parser fills the day as 01), so
   a comp's sale is honestly shown as a MONTH, not a fabricated day. */
export function saleMonth(v) {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})/.exec(String(v));
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : String(v);
}
export function monthsAgo(v, today) {
  if (!v) return null;
  const a = /^(\d{4})-(\d{2})/.exec(String(v));
  const b = /^(\d{4})-(\d{2})/.exec(String(today || new Date().toISOString().slice(0, 10)));
  if (!a || !b) return null;
  return (+b[1] - +a[1]) * 12 + (+b[2] - +a[2]);
}

/* UAD condition and quality, in words. C1 is the BEST — the scale runs the other
   way round from how people expect, which is why every screen spells it out. */
export const CONDITION = {
  C1: 'C1 — brand new', C2: 'C2 — like new', C3: 'C3 — well maintained',
  C4: 'C4 — average, some wear', C5: 'C5 — needs obvious work', C6: 'C6 — not liveable',
};
export const QUALITY = {
  Q1: 'Q1 — highest quality', Q2: 'Q2 — high quality', Q3: 'Q3 — good quality',
  Q4: 'Q4 — average quality', Q5: 'Q5 — basic quality', Q6: 'Q6 — lowest quality',
};
export const conditionLabel = (c, text) => (c ? (CONDITION[c] || c) : (text || '—'));
export const qualityLabel = (q, text) => (q ? (QUALITY[q] || q) : (text || '—'));
export const CONDITION_CODES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
export const QUALITY_CODES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];

/* Baths as people write them: 2 full + 1 half reads "2.1" on the form and "2½"
   to everybody else. */
export function baths(p) {
  const f = p && p.baths_full, h = p && p.baths_half;
  if (f == null && h == null) return p && p.baths_text ? String(p.baths_text) : '—';
  return `${f || 0}${h ? '½' : ''}`;
}

export const addressOf = (p) => (p && (p.display_address || p.address || p.subject_address)) || '—';

/* Which grid a comparable came off — the owner asked for this to be visible on
   every comparable, because an ARV comp and an As-Is comp are not interchangeable. */
export const COMP_SET_LABEL = {
  arv: 'After-repair (ARV) grid',
  as_is: 'As-is grid',
  unknown: 'Grid not stated',
};
export const compSetShort = { arv: 'ARV', as_is: 'As-is', unknown: '—' };

/* Severity → the colour a warning is shown in. */
export const severityColor = (s) => (s === 'fatal' ? '#B4423A' : s === 'warning' ? GOLD : MUTED);

/* Shared card / chip styles used across the research screens. Inline rather than
   in styles.css because they are specific to this desk and nothing else reads
   them; the surrounding page keeps the app's own `card`/`btn`/`chip` classes. */
export const S = {
  label: { display: 'block', fontSize: 12, color: MUTED, marginBottom: 3, fontWeight: 600 },
  input: { width: '100%', padding: '7px 9px', border: '1px solid #DDD6C7', borderRadius: 6,
    fontSize: 14, color: INK, background: '#fff' },
  cell: { padding: '7px 9px', borderBottom: '1px solid #EEE9DD', fontSize: 13, color: INK, verticalAlign: 'top' },
  th: { padding: '7px 9px', borderBottom: '2px solid #DDD6C7', fontSize: 12, color: MUTED,
    textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap' },
  tag: { display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11,
    fontWeight: 700, border: '1px solid #DDD6C7', color: MUTED, background: '#F6F3EC' },
  panel: { border: '1px solid #E4DECF', borderRadius: 10, background: '#fff', padding: 14 },
};
