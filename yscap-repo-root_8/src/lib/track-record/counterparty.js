'use strict';
/**
 * THE BALTIMORE CONTROL — is the buyer of this "exit" really a stranger?
 *
 * PURE. No database, no network, no clock. It is handed the relationship graph
 * somebody else fetched and reports whether the counterparty on a claimed exit
 * is connected to the borrower.
 *
 * ── WHY THIS EXISTS, AND WHY THE OTHER CHECKS CANNOT REPLACE IT ────────────
 * Every other check in this engine reads INSTRUMENTS: was there a deed, is the
 * borrower the grantee, was there a satisfaction, is the date inside the window.
 * In the Baltimore scheme that exposed roughly twelve lenders to about $160
 * million, every one of those signals fired cleanly — because the deeds and the
 * mortgages were REAL. Properties were genuinely bought and genuinely sold at
 * genuine recorded prices. What made the track records fiction was that the
 * buyers were the sellers' own people: the same principals, the same mailing
 * address, the same handful of entities trading the same houses in a circle.
 *
 * So this is the only check in the set that asks about the COUNTERPARTY rather
 * than the paperwork, and it is the one that catches a track record where
 * nothing is forged and nothing is true. A hit does not mean fraud — families
 * buy from families, and a partner buying out a partner is ordinary — it means a
 * person reads this one before it counts toward a tier.
 *
 * ── TRI-STATE, BECAUSE "WE DID NOT LOOK" IS NOT "THEY ARE STRANGERS" ──────
 * `unknown` is a first-class answer and it is the default. An empty graph means
 * nobody asked the vendor, and reporting `unrelated` there would put a green
 * tick on the single check most worth running. The caller must treat `unknown`
 * as work outstanding, never as an all-clear.
 *
 * ── SIGNAL STRENGTH, AND WHY THE NAME TOKEN IS THE WEAKEST ────────────────
 * A shared PRINCIPAL is close to proof: one human on both sides of a sale is
 * exactly the shape. A vendor-asserted link between the entities is nearly as
 * good. A shared mailing address is strong but has an innocent explanation (a
 * registered-agent service or an accountant's office serves thousands of
 * unrelated companies — hence `agentAddresses`, which the caller may fill so a
 * known agent never fires this). A repeated counterparty across several of the
 * borrower's own claimed exits is the Baltimore pattern in miniature. A shared
 * NAME TOKEN is the weakest and the most likely to be a coincidence, so it is
 * worth points but never enough on its own — "Hudson Holdings" and "Hudson
 * Capital" may be one family or may be two companies named after the same river.
 */

const compare = require('../underwriting/compare');
const ADDR = require('../address');

const VERDICT = { RELATED: 'related', UNRELATED: 'unrelated', UNKNOWN: 'unknown' };

const CODE = 'related_party_exit';

/**
 * Points per signal, and the bar. Tuned so any ONE strong signal is enough and
 * two soft ones together are enough, while a lone name coincidence is not.
 */
const WEIGHT = {
  shared_principal: 60,
  shared_signer: 55,
  co_occurring_entity: 45,
  shared_mailing_address: 45,
  repeat_counterparty: 30,
  shared_name_token: 20,
  vendor_flagged_non_arms_length: 50,
};
const RELATED_AT = 40;
/** Each repeat beyond the first adds this much — see signal 5. */
const REPEAT_STEP = 15;

/**
 * Words that identify no one. A token shared between two entity names only
 * means something when it is DISTINCTIVE — every third company in this book is
 * a "Holdings LLC", and firing on that would flag the whole industry.
 */
const GENERIC_TOKENS = new Set([
  'llc', 'l', 'lc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
  'lp', 'llp', 'plc', 'trust', 'the', 'and', 'of', 'a',
  'holdings', 'holding', 'capital', 'properties', 'property', 'realty', 'real', 'estate', 'group',
  'management', 'mgmt', 'ventures', 'venture', 'investments', 'investment', 'investors', 'partners',
  'partnership', 'development', 'developers', 'homes', 'home', 'house', 'housing', 'builders',
  'construction', 'enterprises', 'enterprise', 'associates', 'acquisitions', 'equity', 'fund',
  'funding', 'assets', 'solutions', 'services', 'residential', 'commercial', 'land', 'north',
  'south', 'east', 'west', 'new', 'first', 'best', 'prime', 'premier', 'united', 'american', 'usa',
]);

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : (v == null ? [] : [v]));

/** A party's display name, whether it arrived as a string or an object. */
function nameOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  return String(v.name || v.entityName || v.fullName || v.personName || '').trim();
}

/** A party's vendor id, when it carried one. */
function idOf(v) {
  if (!v || typeof v === 'string') return '';
  return String(v.id || v.entityId || v.personId || v.uuid || '').trim();
}

/** Distinctive tokens in an entity name — lowercase, generic words removed. */
function distinctiveTokens(name) {
  const canon = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return [...new Set(canon.split(/\s+/).filter(Boolean)
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t)))];
}

/** Two people are the same human. Loose on spelling, never on identity: an id
 *  match is proof, a name match is `namesMatchLoose`, and nothing else counts. */
function samePerson(a, b) {
  const ia = idOf(a); const ib = idOf(b);
  if (ia && ib) return ia === ib;
  const na = nameOf(a); const nb = nameOf(b);
  if (!na || !nb) return false;
  try { return compare.namesMatchLoose(na, nb); } catch (_) { return false; }
}

/** Two entities are the same company, by the repo's own comparer. */
function sameEntity(a, b) {
  const ia = idOf(a); const ib = idOf(b);
  if (ia && ib) return ia === ib;
  const na = nameOf(a); const nb = nameOf(b);
  if (!na || !nb) return false;
  try { return compare.entityMatch(na, nb) === true; } catch (_) { return false; }
}

/**
 * Two mailing addresses are the same place — through `address.sameAddress`, the
 * repo's one answer, NOT through the unit-free grouping key.
 *
 * The distinction matters and it is why this signal can carry real weight: in a
 * dense city an office tower holds hundreds of unrelated tenants, so a key that
 * drops the suite number would fire on every one of them. `sameAddress` keeps
 * two stated units apart while still reading "5 Court St" and "5 Court Street"
 * as one address. `compare.addrKey` is deliberately not used — it answers null
 * for a one-line string, which is the shape a vendor's mailing address arrives
 * in, and a null-equals-null comparison would match every unreadable pair.
 */
function samePlaceAddr(a, b) {
  try { return !!a && !!b && ADDR.sameAddress(a, b); } catch (_) { return false; }
}

/** A stable label for an address, for the evidence only — never for matching. */
function addrLabel(v) {
  try { return ADDR.addressCompareKey(v) || String(ADDR.addressTextOf(v) || ''); } catch (_) { return ''; }
}

/**
 * Assess one claimed exit.
 *
 * @param {object} exit   {grantee, granteeId, address, recordedDate, isNonArmsLengthTransfer}
 * @param {object} graph  everything fetched about both sides:
 *        {
 *          fetched            boolean — was the vendor actually asked? Without
 *                             this (or any populated field) the answer is `unknown`.
 *          coOccurring        [{id,name,sharedDeals}]  our entity's co-occurring entities
 *          ourPeople          [{id,name}]              principals of OUR entity
 *          theirPeople        [{id,name}]              principals of the BUYER
 *          ourAddresses       [address]                mailing addresses on our side
 *          theirAddresses     [address]                mailing addresses on the buyer
 *          ourSigners         [{id,name}]              who signed our side
 *          theirSigners       [{id,name}]              who signed the buyer's side
 *          priorExits         [{grantee,granteeId,address,date}]  the borrower's other claimed exits
 *          agentAddresses     [address]  known registered-agent / accountant addresses
 *                                        that must never raise the shared-address signal
 *        }
 * @returns {{verdict, code, score, signals, why}}
 *
 * Never throws.
 */
function assessCounterparty(exit, graph) {
  try { return assess(exit || {}, graph || {}); }
  catch (e) {
    return {
      verdict: VERDICT.UNKNOWN, code: CODE, score: 0, signals: [],
      why: 'The relationship check could not be run.',
      error: String((e && e.message) || e).slice(0, 200),
    };
  }
}

function assess(exit, g) {
  const buyer = { name: nameOf(exit.grantee), id: String(exit.granteeId || '') };
  const signals = [];
  const push = (key, why, evidence) => signals.push({ key, weight: WEIGHT[key] || 0, why, evidence: evidence || null });

  const coOccurring = asArray(g.coOccurring);
  const ourPeople = asArray(g.ourPeople);
  const theirPeople = asArray(g.theirPeople);
  const ourAddresses = asArray(g.ourAddresses);
  const theirAddresses = asArray(g.theirAddresses);
  const ourSigners = asArray(g.ourSigners);
  const theirSigners = asArray(g.theirSigners);
  const priorExits = asArray(g.priorExits);

  const anythingFetched = g.fetched === true || coOccurring.length || ourPeople.length || theirPeople.length
    || ourAddresses.length || theirAddresses.length || ourSigners.length || theirSigners.length || priorExits.length;

  if (!buyer.name && !buyer.id) {
    return {
      verdict: VERDICT.UNKNOWN, code: CODE, score: 0, signals: [],
      why: 'The record does not name a buyer, so there is nobody to check the borrower against.',
    };
  }
  if (!anythingFetched) {
    return {
      verdict: VERDICT.UNKNOWN, code: CODE, score: 0, signals: [],
      why: `Nobody has looked up who "${buyer.name || 'the buyer'}" is yet, so we cannot say whether they are a stranger.`,
    };
  }

  /* 1 — THE VENDOR ALREADY LINKS THE TWO COMPANIES. */
  const co = coOccurring.find((c) => sameEntity(c, buyer));
  if (co) {
    push('co_occurring_entity',
      `The records service already links "${buyer.name}" to the borrower's own company — they turn up together on other filings.`,
      { sharedDeals: co.sharedDeals != null ? co.sharedDeals : null, entityId: idOf(co) || null });
  }

  /* 2 — THE SAME HUMAN IS ON BOTH SIDES. The closest thing to proof here. */
  const sharedPeople = [];
  for (const a of ourPeople) for (const b of theirPeople) {
    if (samePerson(a, b) && !sharedPeople.some((s) => samePerson(s, a))) sharedPeople.push(a);
  }
  if (sharedPeople.length) {
    push('shared_principal',
      `${sharedPeople.length === 1 ? 'A person is' : `${sharedPeople.length} people are`} listed behind BOTH the borrower's company and the buyer — ${sharedPeople.slice(0, 3).map(nameOf).filter(Boolean).join(', ')}.`,
      { people: sharedPeople.slice(0, 5).map(nameOf).filter(Boolean) });
  }

  /* 3 — THE SAME HUMAN SIGNED BOTH SIDES OF THE INSTRUMENT. */
  const sharedSigners = [];
  for (const a of ourSigners) for (const b of theirSigners) {
    if (samePerson(a, b) && !sharedSigners.some((s) => samePerson(s, a))) sharedSigners.push(a);
  }
  if (sharedSigners.length) {
    push('shared_signer',
      `The same person signed for both the seller and the buyer — ${sharedSigners.slice(0, 3).map(nameOf).filter(Boolean).join(', ')}.`,
      { signers: sharedSigners.slice(0, 5).map(nameOf).filter(Boolean) });
  }

  /* 4 — THE SAME MAILING ADDRESS, unless it is a known agent's office. */
  const agentList = asArray(g.agentAddresses);
  const hitAddr = theirAddresses.find((t) => !agentList.some((a) => samePlaceAddr(a, t))
    && ourAddresses.some((o) => samePlaceAddr(o, t)));
  if (hitAddr) {
    push('shared_mailing_address',
      'The borrower\'s company and the buyer use the same mailing address.',
      { address: addrLabel(hitAddr) });
  }

  /* 5 — THE SAME BUYER KEEPS TURNING UP. The Baltimore pattern in miniature.
     ONE repeat is deliberately BELOW the bar on its own: an investor selling to
     the same landlord twice is ordinary. Each further repeat adds, so a buyer
     absorbing three or more of one borrower's "exits" crosses it alone. */
  const repeats = priorExits.filter((p) => sameEntity({ id: p.granteeId, name: nameOf(p.grantee) }, buyer));
  if (repeats.length >= 1) {
    const s = { key: 'repeat_counterparty', weight: WEIGHT.repeat_counterparty + (repeats.length - 1) * REPEAT_STEP,
      why: `"${buyer.name}" also bought ${repeats.length === 1 ? 'another property' : `${repeats.length} other properties`} the borrower claims on this track record.`,
      evidence: { count: repeats.length + 1, addresses: repeats.slice(0, 5).map((p) => p.address).filter(Boolean) } };
    signals.push(s);
  }

  /* 6 — A DISTINCTIVE NAME IN COMMON. Worth points, never enough alone. */
  const ourNames = [nameOf(g.ourEntity), ...ourPeople.map(nameOf), ...(asArray(g.ourEntityNames).map(nameOf))].filter(Boolean);
  const ourTokens = new Set(ourNames.flatMap(distinctiveTokens));
  const sharedTokens = distinctiveTokens(buyer.name).filter((t) => ourTokens.has(t));
  if (sharedTokens.length) {
    push('shared_name_token',
      `"${buyer.name}" shares an unusual name with the borrower's side — ${sharedTokens.slice(0, 3).join(', ')}. That can be a coincidence, so somebody should look.`,
      { tokens: sharedTokens.slice(0, 5) });
  }

  /* 7 — THE RECORD ITSELF SAYS IT WAS NOT ARM'S LENGTH. */
  if (exit.isNonArmsLengthTransfer === true || exit.armsLength === false) {
    push('vendor_flagged_non_arms_length',
      'The records service flags this transfer as not arm\'s length.', null);
  }

  const score = signals.reduce((n, s) => n + s.weight, 0);
  const related = score >= RELATED_AT;

  return {
    verdict: related ? VERDICT.RELATED : VERDICT.UNRELATED,
    code: CODE,
    score,
    signals: signals.sort((a, b) => b.weight - a.weight),
    why: related
      ? `The buyer on this exit is connected to the borrower: ${signals[0] ? signals[0].why : ''}`
      : `Nothing we looked at connects "${buyer.name}" to the borrower.`,
  };
}

/**
 * Every claimed exit at once, plus the pattern that only shows across the whole
 * record: a small number of buyers absorbing most of a borrower's deals. One
 * repeat buyer is ordinary — an investor sells to the same landlord twice.
 * Most of a "track record" flowing to two or three counterparties is the shape
 * the Baltimore control exists to see.
 */
function assessPortfolio(exits, graphFor) {
  const list = asArray(exits);
  const results = list.map((e) => ({ exit: e, assessment: assessCounterparty(e, typeof graphFor === 'function' ? graphFor(e) : graphFor) }));

  const buyers = new Map();
  for (const e of list) {
    const n = nameOf(e.grantee);
    if (!n) continue;
    const k = (() => { try { return compare.canonEntity(n) || n.toLowerCase(); } catch (_) { return n.toLowerCase(); } })();
    buyers.set(k, (buyers.get(k) || 0) + 1);
  }
  const named = [...buyers.values()].reduce((a, b) => a + b, 0);
  const top = [...buyers.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const concentration = named >= 3 && top ? top[1] / named : null;

  return {
    results,
    relatedCount: results.filter((r) => r.assessment.verdict === VERDICT.RELATED).length,
    unknownCount: results.filter((r) => r.assessment.verdict === VERDICT.UNKNOWN).length,
    distinctBuyers: buyers.size,
    concentration,
    concentrated: concentration != null && concentration >= 0.5,
    why: concentration != null && concentration >= 0.5
      ? `One buyer took ${top[1]} of the ${named} exits on this track record. A real market has more buyers than that.`
      : null,
  };
}

module.exports = {
  assessCounterparty,
  assessPortfolio,
  distinctiveTokens,
  VERDICT,
  CODE,
  WEIGHT,
  RELATED_AT,
  REPEAT_STEP,
  GENERIC_TOKENS,
  _internals: { nameOf, idOf, samePerson, sameEntity, samePlaceAddr, addrLabel },
};
