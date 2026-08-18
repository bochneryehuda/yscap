'use strict';
/**
 * LT — DID LENDER PRICE UNDERSTAND THE SCENARIO WE SENT? (§2.86)
 *
 * THE OWNER'S REQUIREMENT, in their own words:
 *   "…just to make sure that the mirror is working correctly, that the scenario that they're entering
 *    is actually the system is reading it for the correct scenario, that the system understands your
 *    scenario exactly and it doesn't get any of your fields wrong. This is the main key right now."
 *
 * ⛔ THE VENDOR ALREADY TELLS US, AND WE THREW IT AWAY. Every priced response carries
 * `results.baseSearch` — the vendor's own statement of the search it actually ran. Measured live
 * 2026-08-18 on a cash-out scenario: **all 41 `criteria` keys we send come back**, plus all 17
 * `dynamicPropertiesMap` entries. `client.parse` kept `search.date` and nothing else; `collectOptions`
 * extracted the per-leaf echo into `option.terms` and `parse` then dropped all but two of its fields.
 * Grepped before building this: **zero readers anywhere** compared a single echoed value against what
 * was sent.
 *
 * That is the whole mechanism the owner is asking for, sitting unread in a response we already pay for.
 * A field we drop, mistransform, or silently default shows up here as "we sent X, they ran Y" — so this
 * check does not test one defect, it makes the entire class self-reporting.
 *
 * ⛔ WHAT IS DELIBERATELY *NOT* COMPARED, AND WHY THAT MATTERS MORE THAN WHAT IS. Some keys in
 * `baseSearch.criteria` are the vendor's own arithmetic, not an echo — `totalLoanAmountByMortgageType`
 * comes back `{Conventional: 325000}` where we sent `{FHA:0,VA:0,UsdaRural:0}`, and
 * `mortgageLimitForLatestYear` is re-derived from the county. Comparing those would produce a permanent
 * false alarm, and **a check that always cries wolf is worse than no check** — it teaches its reader to
 * ignore it, which is how a real mismatch gets missed. So the exclusions are a NAMED list with a stated
 * reason each, never a silent skip, and `notEchoed` is reported as its own count so "nobody looked" can
 * never be read as "everything agreed".
 *
 * PURE: takes the body we built and the raw response, returns a verdict. No I/O, no network. LT-only.
 */

// Criteria keys that are the vendor's OWN computation, not an echo of ours. Each says why, because an
// exclusion without a reason is indistinguishable from a bug being swept under the rug.
const VENDOR_COMPUTED = {
  totalLoanAmountByMortgageType: 'the vendor re-keys this by the mortgage type it resolved ({Conventional: <loan>}); we send a zeroed FHA/VA/USDA shape',
  calculatedFeeByMortgageType: 'vendor-side fee arithmetic; comes back {} on a conventional DSCR search',
  mortgageLimitForLatestYear: 're-derived from the county FIPS on their side, in a different shape from the one we send',
  specialMortgageOptions: 'the vendor RESOLVES our SMO ids against its own registry and may answer with different ids — compared separately by NAME, not by id',
};

// The dynamic properties worth confirming: the ones that carry a scenario fact rather than a profile
// constant. Confirmed present in a live echo before being listed here.
const CHECKED_DYNAMICS = ['PrepayTerm', 'PrePayment_Plan_Type', 'GLOBAL_BorrowerType', 'IncomeDocType',
  'Citizenship', 'GLOBAL_RESERVES', 'Tradelines', 'GLOBAL_DECLININGMARKET'];

function canon(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  // THE VENDOR NORMALIZES TYPES, AND THAT IS NOT A MISMATCH. Measured: we send `ownProperties: "1"`
  // and it echoes `1`. Reporting a string/number difference as "they misunderstood us" would be the
  // false-alarm failure this module exists to avoid. A value that differs only by its JS type is the
  // same answer; a value that differs in substance is not.
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function dynValue(map, key) {
  const e = map && map[key];
  if (e === undefined) return undefined;
  return (e && typeof e === 'object' && 'value' in e) ? e.value : e;
}

/**
 * Compare the request we BUILT against the search the vendor says it RAN.
 *
 *   sentBody — the object `search-model.buildSearch` produced (not the caller's scenario: the scenario
 *              is in our units and the echo is in the vendor's, so comparing those would compare two
 *              different things and call the difference a defect).
 *   raw      — the vendor response.
 *
 * Returns { available, checked, agreed, mismatched[], notEchoed[], vendorComputed[], understood }.
 * `understood` is true only when something was actually checked and nothing mismatched — an empty
 * check is NOT an agreement, and this is the one place that distinction has to hold.
 */
function compareEcho(sentBody, raw) {
  const base = raw && raw.results && raw.results.baseSearch;
  if (!base || typeof base !== 'object') {
    return { available: false, checked: 0, agreed: 0, mismatched: [], notEchoed: [], vendorComputed: [],
      understood: false, why: 'the response carries no results.baseSearch, so the vendor stated no search' };
  }
  const sentC = (sentBody && sentBody.criteria) || {};
  const echoC = base.criteria || {};
  const mismatched = []; const notEchoed = []; const vendorComputed = [];
  let checked = 0; let agreed = 0;

  for (const key of Object.keys(sentC)) {
    if (VENDOR_COMPUTED[key]) { vendorComputed.push({ field: `criteria.${key}`, reason: VENDOR_COMPUTED[key] }); continue; }
    if (echoC[key] === undefined) { notEchoed.push(`criteria.${key}`); continue; }
    checked += 1;
    if (same(sentC[key], echoC[key])) agreed += 1;
    else mismatched.push({ field: `criteria.${key}`, sent: sentC[key], ran: echoC[key] });
  }

  const sentD = (sentBody && sentBody.dynamicPropertiesMap) || {};
  const echoD = base.dynamicPropertiesMap || {};
  for (const key of CHECKED_DYNAMICS) {
    const s = dynValue(sentD, key);
    if (s === undefined) continue;                       // we did not set it; nothing to confirm
    const e = dynValue(echoD, key);
    if (e === undefined) { notEchoed.push(`dynamic.${key}`); continue; }
    checked += 1;
    if (same(s, e)) agreed += 1;
    else mismatched.push({ field: `dynamic.${key}`, sent: s, ran: e });
  }

  // The SMO list by NAME rather than id: the vendor resolves ids against its own registry, so an id
  // difference is routine while a NAME difference means it priced a different option than we asked for.
  const smoNames = (list) => (Array.isArray(list) ? list : []).map((o) => (o && o.name) || null).filter(Boolean).sort();
  const sentSmo = smoNames(sentC.specialMortgageOptions);
  const echoSmo = smoNames(echoC.specialMortgageOptions);
  if (sentSmo.length || echoSmo.length) {
    checked += 1;
    if (same(sentSmo, echoSmo)) agreed += 1;
    else mismatched.push({ field: 'criteria.specialMortgageOptions[].name', sent: sentSmo, ran: echoSmo });
  }

  return { available: true, checked, agreed, mismatched, notEchoed, vendorComputed,
    understood: checked > 0 && mismatched.length === 0,
    why: checked === 0 ? 'the vendor echoed a search but none of the fields we set came back — nothing was confirmed' : null };
}

/**
 * The SECOND direction: did any PRICED option come back on a different loan purpose than we asked for?
 * This is the owner's literal sentence — "if you're pressing a cash-out, you see it for a purchase".
 * The per-leaf echo (`option.terms.loanPurpose`, extracted by `collectOptions`) is what answers it.
 *
 *   parsedFull — the output of `client.parseFull`.
 * Returns { checked, wrongPurpose: [{lender, program, asked, priced}] }.
 */
function checkOptionPurposes(parsedFull, askedPurpose) {
  const out = { checked: 0, wrongPurpose: [] };
  if (!parsedFull || !askedPurpose) return out;
  for (const p of parsedFull.programs || []) {
    for (const o of p.options || []) {
      const got = o && o.terms && o.terms.loanPurpose;
      if (got == null) continue;
      out.checked += 1;
      if (!same(got, askedPurpose)) out.wrongPurpose.push({ lender: p.lender, program: p.program, asked: askedPurpose, priced: got });
    }
  }
  return out;
}

module.exports = { compareEcho, checkOptionPurposes, VENDOR_COMPUTED, CHECKED_DYNAMICS, _internals: { canon, same, dynValue } };
