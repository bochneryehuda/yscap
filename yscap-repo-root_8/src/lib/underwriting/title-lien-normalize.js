'use strict';
/**
 * R5.53 (title/lien half) — Title / public-records LIEN normalizer (deterministic
 * core, ADVISORY).
 *
 * Companion to direct-source-normalize.js (bank/entity/AVM/credit): a title or
 * public-records search (DataTree / CoreLogic / a title company's prelim) returns
 * the RECORDED owner plus any encumbrances — open mortgages, tax liens, judgments,
 * mechanic's liens, lis pendens. This turns that raw, vendor-shaped payload into a
 * canonical shape the rest of underwriting can use: the owner OF RECORD (to
 * reconcile against the contract seller / title grantor via the verification
 * reconciler's name check) and a de-duplicated, categorized list of open
 * encumbrances (advisory — a clean payoff/subordination is a human call).
 *
 * `toOwnerClaim(raw)` produces the { type:'name', value } source the reconciler's
 * name comparator consumes, pairing the recorded owner with a document-claimed
 * seller/grantor.
 *
 * PURE: no DB, no HTTP, no AI. It RESHAPES a payload the connector already
 * fetched — fetches nothing, decides nothing, clears no title, changes no value.
 * Advisory. NEVER THROWS: a hostile/partial payload (incl. throwing getters)
 * degrades to a safe empty result, never an exception.
 */

function str(v) {
  try {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return null;
  } catch (_e) { return null; }
}
function num(v) {
  try {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  } catch (_e) { return null; }
}
function get(obj, path) {
  try { let c = obj; for (const k of String(path).split('.')) { if (c == null) return undefined; c = c[k]; } return c; }
  catch (_e) { return undefined; }
}
function firstOf(obj, paths) {
  for (const p of paths) { const v = get(obj, p); if (v != null && !(typeof v === 'string' && v.trim() === '')) return v; }
  return undefined;
}
function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }

// Canonical encumbrance categories. Anything that isn't clearly one of the
// borrower-benign kinds is treated as an OPEN lien for advisory purposes.
const LIEN_KINDS = Object.freeze({
  mortgage: /mortgage|deed of trust|dot\b|first lien|second lien|heloc|home equity/i,
  tax: /tax lien|property tax|irs|state tax|delinquent tax/i,
  judgment: /judgment|judgement|abstract of judgment/i,
  mechanic: /mechanic|materialman|construction lien|contractor lien/i,
  lis_pendens: /lis pendens|pending (litigation|suit)|notice of default|foreclosure/i,
  hoa: /hoa|assessment|homeowner.?s? association/i,
  ucc: /ucc|financing statement/i,
  other: /.*/,
});
function classifyLien(text) {
  const s = String(text == null ? '' : text);
  for (const [kind, re] of Object.entries(LIEN_KINDS)) { if (kind !== 'other' && re.test(s)) return kind; }
  return 'other';
}
// Encumbrances that a normal purchase/refi payoff clears at closing (not an
// alarm by themselves) vs ones that warrant a human look.
const BENIGN_AT_PAYOFF = new Set(['mortgage', 'hoa', 'ucc']);

/**
 * normalizeTitleRecord(raw) → {
 *   available, provider,
 *   ownerOfRecord,                 // recorded owner name (for the name reconcile)
 *   vesting,                       // how title is held, if given
 *   liens: [{ kind, description, amount, holder, recordedDate, benignAtPayoff }],
 *   openLienTotal,                 // Σ amount of liens that carry one
 *   hasAdverseEncumbrance,         // any non-benign lien (judgment/tax/mechanic/lis_pendens/other)
 *   counts: { <kind>: n },
 * }
 * NEVER THROWS.
 */
function normalizeTitleRecord(raw) {
  try {
    if (!raw || typeof raw !== 'object') return empty('title');
    const provider = str(firstOf(raw, ['provider', 'source'])) || 'title';
    const ownerOfRecord = str(firstOf(raw, [
      'owner', 'owner_name', 'ownerName', 'current_owner', 'vesting_owner',
      'grantee', 'record_owner', 'title.owner', 'property.owner_name',
    ]));
    const vesting = str(firstOf(raw, ['vesting', 'vesting_type', 'ownership_type', 'title.vesting']));

    const rawLiens = arr(firstOf(raw, ['liens', 'encumbrances', 'open_liens', 'title.liens', 'records']));
    const liens = [];
    const seen = new Set();
    for (const l of rawLiens) {
      const lien = normalizeLien(l);
      if (!lien) continue;
      // de-dupe on kind+amount+holder (a search often returns the same lien twice)
      const key = `${lien.kind}|${lien.amount == null ? '' : lien.amount}|${(lien.holder || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      liens.push(lien);
    }

    const counts = {};
    for (const l of liens) counts[l.kind] = (counts[l.kind] || 0) + 1;
    const openLienTotal = liens.reduce((s, l) => s + (l.amount || 0), 0);
    const hasAdverseEncumbrance = liens.some((l) => !l.benignAtPayoff);

    return {
      available: ownerOfRecord != null || liens.length > 0,
      provider,
      ownerOfRecord,
      vesting,
      liens,
      openLienTotal: +openLienTotal.toFixed(2),
      hasAdverseEncumbrance,
      counts,
    };
  } catch (_e) { return empty('title'); }
}
function empty(provider) {
  return { available: false, provider: provider || 'title', ownerOfRecord: null, vesting: null, liens: [], openLienTotal: 0, hasAdverseEncumbrance: false, counts: {} };
}

function normalizeLien(l) {
  try {
    if (l == null) return null;
    if (typeof l === 'string') { const s = str(l); if (!s) return null; const kind = classifyLien(s); return { kind, description: s, amount: null, holder: null, recordedDate: null, benignAtPayoff: BENIGN_AT_PAYOFF.has(kind) }; }
    if (typeof l !== 'object') return null;
    const description = str(firstOf(l, ['description', 'type', 'lien_type', 'record_type', 'name', 'title']));
    const explicitKind = str(firstOf(l, ['kind', 'category']));
    const kind = (explicitKind && LIEN_KINDS[explicitKind.toLowerCase()]) ? explicitKind.toLowerCase() : classifyLien(`${explicitKind || ''} ${description || ''}`);
    const amount = num(firstOf(l, ['amount', 'balance', 'lien_amount', 'face_amount', 'value']));
    const holder = str(firstOf(l, ['holder', 'lienholder', 'lender', 'creditor', 'beneficiary', 'grantee']));
    const recordedDate = str(firstOf(l, ['recorded_date', 'recordedDate', 'date', 'recording_date']));
    // an explicitly released/satisfied lien is not open.
    const released = firstOf(l, ['released', 'satisfied', 'reconveyed', 'paid_off']) === true
      || /released|satisfied|reconveyed|paid.?off/i.test(str(firstOf(l, ['status'])) || '');
    if (released) return null;
    return { kind, description: description || kind, amount, holder, recordedDate, benignAtPayoff: BENIGN_AT_PAYOFF.has(kind) };
  } catch (_e) { return null; }
}

/**
 * toOwnerClaim(raw, claim) → { claim, source, opts } | null
 *   claim: { value } — the document-claimed seller/grantor name (from the twin)
 * Produces the pair the reconciler's `name` comparator consumes so a caller can
 * check the RECORDED owner against the contract seller. Returns null on a totally
 * empty record. NEVER THROWS.
 */
function toOwnerClaim(raw, claim) {
  try {
    const norm = normalizeTitleRecord(raw);
    const owner = norm.ownerOfRecord;
    if (owner == null) return null;
    const c = claim && typeof claim === 'object' ? claim : {};
    return {
      claim: { type: 'name', value: c.value != null ? c.value : null, field: c.field || 'seller' },
      source: { available: true, provider: norm.provider, value: owner },
      opts: {},
      normalized: norm,
    };
  } catch (_e) { return null; }
}

module.exports = {
  normalizeTitleRecord,
  toOwnerClaim,
  classifyLien,
  LIEN_KINDS,
  BENIGN_AT_PAYOFF,
  _internals: { str, num, get, firstOf, normalizeLien },
};
