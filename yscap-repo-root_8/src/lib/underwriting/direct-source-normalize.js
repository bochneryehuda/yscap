'use strict';
/**
 * R5.50-53 — Direct-source response NORMALIZERS (deterministic core, ADVISORY).
 *
 * The direct-source connectors (src/lib/integrations/direct-source-connectors/*)
 * FETCH raw provider payloads; the verification reconciler (lib/verification/
 * reconciler.js) COMPARES a document-claimed value to an independent source's
 * value and raises an advisory conflict. The missing glue between them is this
 * module: turning each provider's RAW, provider-shaped JSON into the canonical
 *   { available, provider, value, field, extra }
 * shape the reconciler's `source` argument expects — one normalizer per source:
 *
 *   Plaid (R5.50)        — bank account ownership name + available balance
 *   State SoS / Middesk (R5.51) — entity legal name + good-standing status
 *   ATTOM / HouseCanary / Clear Capital (R5.52) — property AVM value
 *   Xactus (R5.53)       — credit score + fraud/OFAC/public-record flags
 *
 * `toReconcilable(kind, rawResponse, claim)` pairs a normalized source with the
 * file's document-CLAIMED value so a caller can drop the result straight into
 * `reconcile(claim, source)` / `reconcileAll([...])`.
 *
 * PURE: no DB, no HTTP, no AI. It only RESHAPES a payload the connector already
 * fetched — it fetches nothing, decides nothing, and changes no value. Advisory.
 * NEVER THROWS: a hostile/garbage/partial payload (including throwing getters)
 * degrades to `{ available: false }`, never an exception — so a flaky provider
 * response can never crash an underwriting run.
 */

// ---- safe scalar readers (never throw on a hostile getter / odd type) ----
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
// Safe nested read: get(obj, 'a.b.0.c') never throws, returns undefined on any gap.
function get(obj, path) {
  try {
    let cur = obj;
    for (const key of String(path).split('.')) {
      if (cur == null) return undefined;
      cur = cur[key];
    }
    return cur;
  } catch (_e) { return undefined; }
}
// First non-empty of several candidate paths.
function firstOf(obj, paths) {
  for (const p of paths) {
    const v = get(obj, p);
    if (v != null && !(typeof v === 'string' && v.trim() === '')) return v;
  }
  return undefined;
}
function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }

const unavailable = (provider, reason) => ({ available: false, provider: provider || null, value: null, reason: reason || 'no data' });

// ---- R5.50 Plaid: bank account ownership + balance ----
// Raw shape (Plaid /accounts + /identity, tolerant): { accounts:[{ owners|owner_names,
// balances:{ available, current } }], names:[...] } or a single flattened account.
function normalizePlaid(raw, opts = {}) {
  try {
    if (!raw || typeof raw !== 'object') return unavailable('plaid', 'empty response');
    const accounts = arr(firstOf(raw, ['accounts', 'account']) || (raw.balances || raw.owners ? [raw] : []));
    const account = accounts.length ? (pickAccount(accounts, opts.accountMask) || accounts[0]) : (raw.balances || raw.owners ? raw : null);
    // owner names: Plaid identity gives owners[].names[]; tolerate several spellings.
    const ownerNames = collectOwnerNames(account, raw);
    // available balance preferred (spendable), fall back to current.
    const bal = account ? num(firstOf(account, ['balances.available', 'balances.current', 'available_balance', 'current_balance', 'balance'])) : null;
    const available = ownerNames.length > 0 || bal != null;
    return {
      available,
      provider: 'plaid',
      // default `value` is the primary owner name (the fatal ownership check);
      // callers wanting the balance read `.balance` / pass field:'balance'.
      value: ownerNames[0] != null ? ownerNames[0] : null,
      field: 'account_owner',
      ownerNames,
      balance: bal,
      accountMask: account ? str(firstOf(account, ['mask', 'account_mask', 'last4'])) : null,
      reason: available ? null : 'no owner name or balance in response',
    };
  } catch (_e) { return unavailable('plaid', 'parse error'); }
}
function pickAccount(accounts, mask) {
  const m = str(mask);
  if (!m) return null;
  const want = m.replace(/\D+/g, '').slice(-4);
  return accounts.find((a) => {
    const am = str(firstOf(a, ['mask', 'account_mask', 'last4']));
    return am && am.replace(/\D+/g, '').slice(-4) === want;
  }) || null;
}
function collectOwnerNames(account, raw) {
  const names = new Set();
  const push = (v) => { const s = str(v); if (s) names.add(s); };
  for (const src of [account, raw]) {
    if (!src) continue;
    for (const o of arr(src.owners)) { for (const n of arr(o && o.names)) push(n); push(o && o.name); }
    for (const n of arr(src.owner_names)) push(n);
    for (const n of arr(src.names)) push(n);
    push(src.owner_name); push(src.holder_name); push(src.account_holder);
  }
  return Array.from(names);
}

// ---- R5.51 State SoS / Middesk: entity formation + good standing ----
// Raw shape (tolerant): { name|legal_name, status|standing, formation_date, jurisdiction }.
function normalizeSos(raw) {
  try {
    if (!raw || typeof raw !== 'object') return unavailable('sos', 'empty response');
    const name = str(firstOf(raw, ['legal_name', 'name', 'entity.name', 'entity_name', 'business_name']));
    const status = str(firstOf(raw, ['status', 'standing', 'entity.status', 'registration.status', 'good_standing_status']));
    // some providers give a boolean good_standing instead of a status string.
    const gsBool = firstOf(raw, ['good_standing', 'is_active', 'active']);
    const statusValue = status != null ? status
      : (gsBool === true ? 'active' : (gsBool === false ? 'inactive' : null));
    const formation = str(firstOf(raw, ['formation_date', 'formed_on', 'registration_date', 'incorporation_date', 'entity.formation_date']));
    const available = name != null || statusValue != null;
    return {
      available,
      provider: 'sos',
      // default `value` is the entity status (the good-standing check); the
      // entity NAME is on `.entityName` for a name-match reconcile.
      value: statusValue,
      field: 'entity_status',
      entityName: name,
      formationDate: formation,
      jurisdiction: str(firstOf(raw, ['jurisdiction', 'state', 'entity.jurisdiction'])),
      reason: available ? null : 'no entity name or status in response',
    };
  } catch (_e) { return unavailable('sos', 'parse error'); }
}

// ---- R5.52 ATTOM / HouseCanary / Clear Capital: property AVM ----
// Raw shapes differ per vendor; normalize each to a single dollar value.
const AVM_PATHS = [
  'avm.amount.value', 'avm.value', 'avm_value', 'value', 'estimated_value', 'estimatedValue',
  'price_hint', 'property.avm.amount.value', 'valuation.value', 'result.value', 'value_estimate',
];
function normalizeAvm(raw, provider) {
  try {
    if (!raw || typeof raw !== 'object') return unavailable(provider || 'avm', 'empty response');
    const value = num(firstOf(raw, AVM_PATHS));
    const low = num(firstOf(raw, ['avm.amount.low', 'value_low', 'low', 'valuation.low', 'confidence.low']));
    const high = num(firstOf(raw, ['avm.amount.high', 'value_high', 'high', 'valuation.high', 'confidence.high']));
    const available = value != null;
    return {
      available,
      provider: provider || str(firstOf(raw, ['provider', 'source'])) || 'avm',
      value,
      field: 'property_value',
      low, high,
      // fsd = forecast standard deviation / confidence, if the vendor gives one.
      confidence: num(firstOf(raw, ['avm.confidence', 'confidence_score', 'fsd', 'confidence'])),
      reason: available ? null : 'no AVM value in response',
    };
  } catch (_e) { return unavailable(provider || 'avm', 'parse error'); }
}

// ---- R5.53 Xactus: credit + fraud / public-record flags ----
// Raw shape (tolerant): { score|fico, alerts|flags:[...], ofac, frozen }.
// A CREDIT source's default reconcile is the score (advisory 'exists'/amount);
// the real signal is the FRAUD flag set, surfaced for a caller to raise on.
function normalizeXactus(raw) {
  try {
    if (!raw || typeof raw !== 'object') return unavailable('xactus', 'empty response');
    const score = num(firstOf(raw, ['score', 'fico', 'credit_score', 'fico_score', 'middle_score']));
    const flags = collectFlags(raw);
    // "found" iff the provider actually returned a credit file (a score OR any flag).
    const found = score != null || flags.length > 0
      || firstOf(raw, ['found', 'hit', 'file_found']) === true;
    return {
      available: score != null || flags.length > 0 || firstOf(raw, ['found', 'hit', 'file_found']) != null,
      provider: 'xactus',
      value: found ? 'found' : (raw && (raw.found === false || raw.hit === false) ? 'not_found' : null),
      field: 'credit_file',
      score,
      flags,
      // a fraud alert is any flag that isn't a benign informational one.
      fraudFlags: flags.filter((f) => f.severe),
      frozen: firstOf(raw, ['frozen', 'credit_frozen', 'security_freeze']) === true,
      reason: found ? null : 'no credit file found',
    };
  } catch (_e) { return unavailable('xactus', 'parse error'); }
}
const SEVERE_FLAG = /ofac|sdn|fraud|deceased|ssn.*(mismatch|invalid|issued)|freeze|frozen|alert|hawk|watch|lien|judgment|bankruptc/i;
function collectFlags(raw) {
  const out = [];
  const seen = new Set();
  const add = (code, severeHint) => {
    const c = str(code);
    if (!c) return;
    const key = c.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ code: c, severe: severeHint === true || SEVERE_FLAG.test(c) });
  };
  for (const path of ['alerts', 'flags', 'fraud_alerts', 'messages', 'public_records', 'hawk_alerts']) {
    for (const f of arr(get(raw, path))) {
      if (f == null) continue;
      if (typeof f === 'string') add(f);
      else add(firstOf(f, ['code', 'type', 'message', 'description', 'name']), firstOf(f, ['severe', 'critical', 'fraud']) === true);
    }
  }
  if (firstOf(raw, ['ofac', 'ofac_hit', 'sdn_match']) === true) add('OFAC/SDN match', true);
  if (firstOf(raw, ['deceased', 'is_deceased']) === true) add('Deceased indicator', true);
  return out;
}

// ---- bridge to the reconciler ----
// The verification-type each kind reconciles by default, and where the normalized
// value lives, so a caller doesn't have to remember the mapping.
const KIND_META = Object.freeze({
  plaid: { type: 'name', provider: 'plaid' },          // account owner name (fatal on mismatch)
  plaid_balance: { type: 'amount', provider: 'plaid', valueKey: 'balance' },
  sos: { type: 'entity_status', provider: 'sos' },     // good standing (fatal)
  sos_name: { type: 'name', provider: 'sos', valueKey: 'entityName' },
  avm: { type: 'property_value', provider: 'avm' },
  attom: { type: 'property_value', provider: 'attom' },
  housecanary: { type: 'property_value', provider: 'housecanary' },
  clearcapital: { type: 'property_value', provider: 'clearcapital' },
  xactus: { type: 'exists', provider: 'xactus' },      // credit file confirmed
});

function normalizeByKind(kind, raw) {
  switch (kind) {
    case 'plaid':
    case 'plaid_balance': return normalizePlaid(raw);
    case 'sos':
    case 'sos_name': return normalizeSos(raw);
    case 'attom': return normalizeAvm(raw, 'attom');
    case 'housecanary': return normalizeAvm(raw, 'housecanary');
    case 'clearcapital': return normalizeAvm(raw, 'clearcapital');
    case 'avm': return normalizeAvm(raw, null);
    case 'xactus': return normalizeXactus(raw);
    default: return unavailable(kind, `unknown source kind "${kind}"`);
  }
}

/**
 * toReconcilable(kind, raw, claim) → { claim, source, opts } | null
 *   kind  : a KIND_META key ('plaid'|'sos'|'attom'|'xactus'|'avm'|...)
 *   raw   : the provider's raw response
 *   claim : { value, field? } — the document-CLAIMED value (from the twin)
 * Produces the exact pair `reconcile()` consumes. The `source.value` is pulled
 * from the normalized shape per KIND_META (owner name / status / AVM / found).
 * Returns null only for an unknown kind. NEVER THROWS.
 */
function toReconcilable(kind, raw, claim, opts = {}) {
  try {
    const meta = KIND_META[kind];
    if (!meta) return null;
    const norm = normalizeByKind(kind, raw);
    const value = meta.valueKey ? (norm && norm[meta.valueKey] != null ? norm[meta.valueKey] : null) : (norm ? norm.value : null);
    const source = {
      available: !!(norm && norm.available) && value != null,
      provider: (norm && norm.provider) || meta.provider,
      value,
    };
    const c = claim && typeof claim === 'object' ? claim : {};
    return {
      claim: { type: meta.type, value: c.value != null ? c.value : null, field: c.field || meta.type },
      source,
      opts: opts || {},
      normalized: norm,
    };
  } catch (_e) { return null; }
}

module.exports = {
  normalizePlaid,
  normalizeSos,
  normalizeAvm,
  normalizeXactus,
  normalizeByKind,
  toReconcilable,
  KIND_META,
  _internals: { str, num, get, firstOf, collectOwnerNames, collectFlags, SEVERE_FLAG },
};
