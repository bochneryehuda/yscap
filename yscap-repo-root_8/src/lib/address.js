/**
 * Server-side US address normalization. Turns any address — whether picked from
 * autocomplete or typed free-hand as one line — into discrete components so the
 * rest of the system always stores a properly divided address:
 *   { line1 (street), unit (apt/suite), city, state (2-letter), zip, country }
 * All splitting happens here, on the backend.
 */
const US_STATE_ABBR = { alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE','district of columbia':'DC',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY' };
const STATE_ABBRS = new Set(Object.values(US_STATE_ABBR));
function stateAbbr(s) { if (!s) return ''; s = s.trim(); if (s.length === 2 && STATE_ABBRS.has(s.toUpperCase())) return s.toUpperCase(); return US_STATE_ABBR[s.toLowerCase()] || (s.length === 2 ? s.toUpperCase() : s); }

// The keyword must be a whole word (\b on BOTH sides) so an abbreviation like
// "Fl" never matches inside a longer street name; plus a bare "#unit" form.
const UNIT_RE = /\b(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|trailer|dept|department)\b\.?\s*#?\s*([A-Za-z0-9-]+)|#\s*([A-Za-z0-9-]+)/i;

/** Pull an apartment/suite token out of a street string. Returns { line1, unit }. */
function splitUnit(street) {
  const s = String(street || '').trim();
  const m = s.match(UNIT_RE);
  if (!m) return { line1: s, unit: '' };
  const unit = (m[0].replace(/^#/, '# ').trim());
  const line1 = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s*,\s*$/, '').replace(/\s{2,}/g, ' ').trim().replace(/,\s*$/, '');
  return { line1: line1 || s, unit };
}

const empty = () => ({ line1: '', unit: '', city: '', state: '', zip: '', country: 'US' });

/** Parse a free-text US address string into components. */
function parseAddress(raw) {
  const out = empty();
  if (!raw || typeof raw !== 'string') return out;
  let s = raw.replace(/\s+/g, ' ').trim().replace(/,?\s*(USA|United States)\.?$/i, '').trim();

  // ZIP at the end (5 or ZIP+4).
  const zip = s.match(/\b(\d{5}(?:-\d{4})?)\s*$/);
  if (zip) { out.zip = zip[1]; s = s.slice(0, zip.index).trim().replace(/,\s*$/, ''); }

  // State at the end (2-letter or full name).
  let st = s.match(/[,\s]([A-Za-z]{2})\s*$/);
  if (st && STATE_ABBRS.has(st[1].toUpperCase())) { out.state = st[1].toUpperCase(); s = s.slice(0, st.index).trim().replace(/,\s*$/, ''); }
  else {
    const full = Object.keys(US_STATE_ABBR).sort((a, b) => b.length - a.length).find(n => new RegExp('[,\\s]' + n + '\\s*$', 'i').test(s));
    if (full) { out.state = US_STATE_ABBR[full]; s = s.replace(new RegExp('[,\\s]' + full + '\\s*$', 'i'), '').trim().replace(/,\s*$/, ''); }
  }

  // Remaining: "street[, unit], city" or "street city".
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.city = parts[parts.length - 1];
    const streetPart = parts.slice(0, parts.length - 1).join(', ');
    const u = splitUnit(streetPart);
    out.line1 = u.line1; out.unit = u.unit;
    // A middle comma part that is purely a unit token also counts.
    if (!out.unit && parts.length >= 3) { const mid = splitUnit(parts[1]); if (mid.unit) { out.unit = mid.unit; out.line1 = parts[0]; } }
  } else if (parts.length === 1) {
    // No commas: last token before the (removed) state is likely the city.
    const u = splitUnit(parts[0]);
    out.unit = u.unit;
    const toks = u.line1.split(' ');
    if (out.state && toks.length > 2) { out.city = toks.pop(); out.line1 = toks.join(' '); }
    else { out.line1 = u.line1; }
  }
  return out;
}

/** Normalize a partial address object (autocomplete-sourced) — extract a unit
 *  embedded in line1 and 2-letter the state. */
function normalizeAddress(a) {
  const out = Object.assign(empty(), a || {});
  if (out.line1 && !out.unit) { const u = splitUnit(out.line1); out.line1 = u.line1; out.unit = u.unit; }
  out.state = stateAbbr(out.state);
  out.country = (out.country || 'US').toUpperCase();
  // convenient single-line form
  out.oneLine = [ [out.line1, out.unit].filter(Boolean).join(' '), out.city, [out.state, out.zip].filter(Boolean).join(' ') ].filter(Boolean).join(', ');
  return out;
}

module.exports = { parseAddress, normalizeAddress, splitUnit, stateAbbr };
