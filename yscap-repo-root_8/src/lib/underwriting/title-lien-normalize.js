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
// Resolve an owner value that may be a plain string OR a nested object (ATTOM/
// DataTree hand back an owner object). NEVER throws.
function ownerName(v) {
  try {
    const s = str(v);
    if (s) return s;
    if (v && typeof v === 'object') {
      // common owner-object name fields across vendors
      const n = str(firstOf(v, [
        'lastNameAndSuffix', 'fullName', 'full_name', 'name', 'ownerName', 'owner_name',
        'owner1.lastNameAndSuffix', 'owner1.fullName', 'owner1', 'formattedName',
      ]));
      if (n) return n;
      // first + last as a fallback
      const first = str(firstOf(v, ['firstName', 'first_name', 'owner1.firstName']));
      const last = str(firstOf(v, ['lastName', 'last_name', 'owner1.lastName']));
      const combined = [first, last].filter(Boolean).join(' ').trim();
      return combined || null;
    }
    return null;
  } catch (_e) { return null; }
}
// True iff any of the given boolean "this lien is closed" flags is explicitly set
// (checked independently — a firstOf() would stop on the first PRESENT key even
// when it is `false`, missing a later `satisfied:true`).
function anyTrue(obj, keys) {
  try { for (const k of keys) { if (obj && obj[k] === true) return true; } return false; }
  catch (_e) { return false; }
}

// Canonical encumbrance categories. Anything that isn't clearly one of the
// borrower-benign kinds is treated as an OPEN lien for advisory purposes.
// ORDER MATTERS: classifyLien returns the FIRST match, so the ADVERSE kinds are
// listed before the benign-at-payoff ones — a "deed of trust ... notice of
// default" entry must classify as lis_pendens (adverse/foreclosure), NOT as a
// plain mortgage, so a property in active foreclosure never reads as clean
// (the module's job is to OVER-flag, never under-flag).
// Short tokens (irs/hoa/ucc/dot) carry \b word boundaries so they don't match
// inside an unrelated word — e.g. "irs" must NOT fire on "F(irs)t Deed of Trust".
const LIEN_KINDS = Object.freeze({
  lis_pendens: /lis pendens|pending (litigation|suit)|notice of default|foreclosure/i,
  tax: /tax lien|property tax|\birs\b|state tax|delinquent tax/i,
  judgment: /judgment|judgement|abstract of judgment/i,
  mechanic: /mechanic|materialman|construction lien|contractor lien/i,
  mortgage: /mortgage|deed of trust|\bdot\b|first lien|second lien|heloc|home equity/i,
  hoa: /\bhoa\b|assessment|homeowner.?s? association/i,
  ucc: /\bucc\b|financing statement/i,
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
    const ownerOfRecord = ownerName(firstOf(raw, [
      'owner', 'owner_name', 'ownerName', 'current_owner', 'vesting_owner',
      'grantee', 'record_owner', 'title.owner', 'property.owner_name',
      // ATTOM / DataTree nested shapes (owner is an object, property is an array)
      'property.0.owner.owner1.lastNameAndSuffix', 'property.owner.owner1.lastNameAndSuffix',
      'property.0.owner', 'property.owner', 'title.grantee', 'ownership.owner',
    ]));
    const vesting = str(firstOf(raw, ['vesting', 'vesting_type', 'ownership_type', 'title.vesting', 'property.0.owner.type']));

    const rawLiens = arr(firstOf(raw, [
      'liens', 'encumbrances', 'open_liens', 'title.liens', 'records',
      'property.liens', 'property.0.liens', 'title_search.liens', 'report.records', 'title.encumbrances',
    ]));
    const liens = [];
    const seen = new Set();
    for (const l of rawLiens) {
      const lien = normalizeLien(l);
      if (!lien) continue;
      // de-dupe on kind+amount+holder+description (a search often returns the same
      // lien twice). Description is in the key so two DISTINCT liens that share a
      // kind + amount but have no holder don't wrongly collapse.
      const key = `${lien.kind}|${lien.amount == null ? '' : lien.amount}|${(lien.holder || '').toLowerCase()}|${(lien.description || '').toLowerCase()}`;
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
    // an explicitly released/satisfied lien is not open. Check each boolean flag
    // INDEPENDENTLY (not firstOf, which would stop on a `released:false` and miss
    // a later `satisfied:true`), plus a status-string match.
    const released = anyTrue(l, ['released', 'satisfied', 'reconveyed', 'paid_off'])
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
