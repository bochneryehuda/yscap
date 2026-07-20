'use strict';
/**
 * Sitewire — pure value transforms. No I/O, no DB — unit-testable in isolation.
 * Money is INTEGER CENTS end-to-end (never a float in a ledger field). The dollar
 * parser mirrors the SOW builder's num() exactly so server-side recompute of a
 * saved Scope-of-Work matches the tool 1:1.
 */

// Parse a possibly-formatted money value ("1,200" / "$3k"? no — "$3,000.50" / 75000)
// EXACTLY like web/tools/rehab-budget.js num(): strip everything but digits/./-, then
// parseFloat; non-finite -> 0. (The builder does NOT expand "k"; neither do we.)
function num(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Dollars -> integer cents (round half-up at the cent; matches Math.round).
function dollarsToCents(v) { return Math.round(num(v) * 100); }
function centsToDollars(c) { return (Number(c) || 0) / 100; }

// Display only.
function usd(cents) {
  const c = Number(cents) || 0;
  return '$' + Math.round(c / 100).toLocaleString('en-US');
}

// Deterministic exploded-line names (the stability contract — see research doc §4.2).
function unitLineName(base, unitIndex) { return `Unit ${unitIndex} - ${base}`; }
function sectionLineName(section, base) {
  if (section === 'common') return `Common - ${base}`;
  if (section === 'exterior') return `Exterior - ${base}`;
  if (section === 'project') return `Project - ${base}`;
  return base; // 'all' (single-family)
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// Map our property_address jsonb -> Sitewire address (street/city/state/zip[/unit]).
// street comes from line1 (or legacy street/street_with_unit). Never guesses missing parts —
// an address with no line1 yields street:null and is parked by the completeness check on push.
function addressForSitewire(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const street = addr.line1 || addr.street || addr.street_with_unit || null;
  const out = {
    street,
    city: addr.city || null,
    state: addr.state || null,
    zip: addr.zip || addr.postal || null,
  };
  if (addr.unit) out.unit = addr.unit;
  return out;
}

// property_type -> Sitewire development_type. Unknown -> null (NEVER guessed — G-ENUM).
function developmentType(propertyType) {
  const t = String(propertyType || '').toLowerCase();
  if (!t) return null;
  if (/single|sfr|1\s*unit|detached/.test(t)) return 'single_family_residential';
  if (/multi|2-4|5\+|duplex|triplex|fourplex|apartment/.test(t)) return 'multi_family_residential';
  if (/mixed|commercial|retail|office/.test(t)) return 'commercial';
  return null; // unrecognized -> the push OMITS this optional field (left blank), never guesses a type
}

// rehab_type / registered program -> Sitewire construction_type. Sitewire's construction_type is a
// binary CONSTRUCTION dimension (ground_up vs rehabilitation_or_remodel). The reliable signal for it is
// the REHAB TYPE (Cosmetic / Moderate / Heavy / Adding SF / Ground-up) and the registered PROGRAM —
// NOT loan_type. loan_type is only the ACQUISITION method (Purchase vs Refinance) and says nothing about
// construction, so feeding it in as the primary signal made a plain "Purchase" (with a blank rehab_type)
// read as "unmapped" (owner-reported 2026-07-20: `construction_type "Purchase/" didn't map`). We still
// accept loan_type as a last, best-effort keyword source (a legacy "Ground up" loan_type would map), but
// it is no longer the driver. Returns null ONLY when there is no construction signal at all — the caller
// (a Sitewire draw push, which by definition carries a construction budget + Scope of Work) supplies the
// sane default rather than parking a spurious advisory.
function constructionType(loanType, rehabType, program) {
  const s = `${rehabType || ''} ${program || ''} ${loanType || ''}`.toLowerCase();
  if (!s.trim()) return null;
  if (/ground[\s-]*up|new\s*construction|\bshell\b/.test(s)) return 'ground_up';
  if (/rehab|remodel|reno|fix|cosmetic|moderate|heavy|repair|\bgut\b|add(?:ing)?\s*(?:sf|square)/.test(s)) return 'rehabilitation_or_remodel';
  return null;
}

function feeKindFor(inspectionMethod) { return inspectionMethod === 'traditional' ? 'physical' : 'virtual'; }

// Reject any value JSON would turn into a field-clearing null (mirror clickup guard):
// null / undefined / NaN / Infinity anywhere in the payload. Returns a reason or null.
function findJsonUnsafe(v, path = 'value') {
  if (v === undefined) return `${path} is undefined`;
  if (v === null) return `${path} is null`;
  if (typeof v === 'number' && !Number.isFinite(v)) return `${path} is ${v}`;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = findJsonUnsafe(v[i], `${path}[${i}]`); if (r) return r; } return null; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) { const r = findJsonUnsafe(v[k], `${path}.${k}`); if (r) return r; } return null; }
  return null;
}

// Largest-remainder split of a whole cents amount into n parts that sum EXACTLY to
// the whole (residual absorbed onto the earliest parts). Used only when a single
// amount is split evenly across units; explicit per-unit columns are used verbatim.
function splitEven(totalCents, n) {
  const total = Math.round(Number(totalCents) || 0);
  const k = Math.max(1, parseInt(n, 10) || 1);
  const base = Math.floor(total / k);
  let rem = total - base * k;
  const out = [];
  for (let i = 0; i < k; i++) { out.push(base + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
  return out;
}

// Stable, order-independent fingerprint of an object (echo suppression / no-op detect).
function stableHash(obj) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k]); return o; }
    return v;
  };
  const s = JSON.stringify(norm(obj));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Deterministic idempotency key for a write op (same logical op -> same key on retry).
function idempotencyKey(parts) { return stableHash(parts); }

// Nearest calendar day of a Sitewire ISO timestamp -> 'YYYY-MM-DD' (release date from
// the lender_approve event). Date-only, no TZ math on a pure instant we only day-slice.
function isoDay(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

module.exports = {
  num, dollarsToCents, centsToDollars, usd,
  unitLineName, sectionLineName, slugify,
  addressForSitewire, developmentType, constructionType, feeKindFor,
  findJsonUnsafe, splitEven, stableHash, idempotencyKey, isoDay,
};
