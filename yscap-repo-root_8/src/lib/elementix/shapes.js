'use strict';
/**
 * THE VENDOR'S SHAPES, NORMALISED ONCE — no raw record leaves this module.
 *
 * ═══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
 * The connector was written against GUESSED field names, and its tests were
 * written against the same guesses, so every test passed while the code could
 * not read a single real record. Measured against a real payload:
 *
 *   · a deed row has NO `address` field — it carries `addresses[{addressFull}]`,
 *     so `checks.forProperty` matched nothing and BOTH the ownership and exit
 *     pillars reported `no_data` on files with perfect evidence;
 *   · `importer.candidatesFrom` keyed on the same missing field, so every deed
 *     hashed to the SAME empty key and two properties in two different towns
 *     collapsed into ONE candidate with no address, no price and no date;
 *   · the price is `totalConsideration` (never `consideration`) and the date is
 *     `recordingDate` (never `recordedDate`).
 *
 * ═══ THERE IS NO SHARED SCHEMA, AND THAT IS THE WHOLE POINT ════════════════
 * Four tools return four names for the same two parties, and two of them return
 * the same field as a NUMBER in one place and a STRING in another:
 *
 *   get_entity_deeds        grantors[]        grantees[]        totalConsideration (number)
 *   get_address_transactions partiesGrantor[] partiesGrantee[]  amount             (number)
 *   get_address_ownership   —                 grantees[]        totalConsideration (STRING)
 *   get_lender_satisfactions —                borrower[]        originalMortgageAmount (STRING)
 *
 * `get_address_ownership` also carries `entity_grantees` — snake_case, the only
 * one in the API, and the field the blueprint's §2.2 names in camelCase. Since
 * §6.2 makes that check a HARD DISCARD, reading the camelCase name discards
 * every property forever with no error anywhere.
 *
 * So there is ONE NORMALISER PER TOOL. A single clever reader that tries every
 * spelling is how this stays broken: it would silently return null for a tool
 * whose spelling nobody thought of, which is indistinguishable from "the vendor
 * has nothing" — the exact failure mode this module was written to end.
 *
 * ═══ ABSENCE IS `null`, NEVER A DEFAULT ═══════════════════════════════════
 * A missing amount is `null`, not 0; a missing date is `null`, not today. The
 * engine's whole discipline is that a coverage gap reads as "we could not tell"
 * and never as a contradiction, and a defaulted 0 would read as a real $0 sale —
 * which `checks.js` would treat as an affirmative record.
 *
 * ═══ PURE ═════════════════════════════════════════════════════════════════
 * No IO, no clock, no DB. Fixtures in scripts/fixtures/elementix-shapes.json are
 * REAL captured payloads and the tests read from there — never a hand-written
 * row, because a fixture invented by whoever wrote the reader can only ratify
 * their guess.
 */

const str = (v) => String(v == null ? '' : v).trim();

/** A money value that may arrive as a number, a string, or `"$1,240,000"`.
 *  Absent, blank or unreadable is `null` — never 0. */
function money(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** `YYYY-MM-DD`, or null. Never today, never an epoch. */
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Every address a row names for THE PROPERTY, as one-line strings.
 *
 * Three real shapes, all seen live: `addresses[{id, addressFull}]` on deeds and
 * mortgages, `addresses[]` of bare STRINGS on satisfactions (with the objects
 * moved to `addressDetails[]`), and a plain string. Duplicates are collapsed —
 * a real mortgage row listed the same address twice.
 *
 * Deliberately NOT included: `grantorAddress` / `granteeAddress` / `borrowerAddress`
 * / `lenderAddress`. Those are where a PARTY receives mail, not the property the
 * deed conveys, and folding them in here would match a property to the
 * borrower's home address and credit them with a deal they never did.
 */
function addressesOf(row) {
  const out = [];
  const push = (v) => {
    const s = typeof v === 'string' ? str(v) : str(v && (v.addressFull || v.address || v.oneLine));
    if (s && !out.includes(s)) out.push(s);
  };
  for (const key of ['addresses', 'addressDetails']) {
    const list = row && row[key];
    if (Array.isArray(list)) list.forEach(push);
    else if (list) push(list);
  }
  return out;
}

/** Names out of a party list that may hold strings or `{name}` objects. */
function namesOf(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  for (const p of arr) {
    const n = typeof p === 'string' ? str(p) : str(p && (p.name || p.partyName));
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Entity ids from either an id array or an array of `{id}` objects. */
function idsOf(...lists) {
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const id = typeof v === 'string' ? str(v) : str(v && v.id);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** The MLS block, which is the only lease/rent signal the records carry — and
 *  the reason a HOLD can be proved at all. Absent reads as absent. */
function mlsOf(row) {
  const m = {
    salePrice: money(row.mlsSalePrice), saleStatus: str(row.mlsSaleStatus) || null,
    saleListedOn: ymd(row.mlsSaleListingDate),
    rentPrice: money(row.mlsRentPrice), rentStatus: str(row.mlsRentStatus) || null,
    rentListedOn: ymd(row.mlsRentListingDate),
  };
  return Object.values(m).some((v) => v != null) ? m : null;
}

const base = (row, kind) => ({
  kind,
  id: str(row.id) || null,
  source: str(row.dataSource) || null,
  addresses: addressesOf(row),
  mls: mlsOf(row),
  /* The identity a HUMAN can look up at the county. The vendor's own
     `documentId` was null on every real row inspected, so the county's
     document id is the one worth carrying; the vendor row id is the
     fallback so evidence is never left unattributed. */
  documentId: str(row.countyDocumentId) || str(row.documentId) || str(row.id) || null,
  raw: row,
});

/* ── one normaliser per tool ─────────────────────────────────────────────── */

/** `get_entity_deeds` / `get_person_deeds`. */
function deed(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...base(row, 'deed'),
    date: ymd(row.recordingDate),
    amount: money(row.totalConsideration),
    grantors: namesOf(row.grantors), grantees: namesOf(row.grantees),
    grantorEntityIds: idsOf(row.entityGrantorIds, row.grantorEntities),
    granteeEntityIds: idsOf(row.entityGranteeIds, row.granteeEntities),
    /* SERVER-COMPUTED against the entity that was queried — strictly better than
       re-deriving it by fuzzy name matching, which is what produced the York, PA
       false positive the scoring ladder's A3 exists for. `null` when the vendor
       did not say, so a caller must fall back rather than read false as "no". */
    isGrantee: typeof row.isGrantee === 'boolean' ? row.isGrantee : null,
    isGrantor: typeof row.isGrantor === 'boolean' ? row.isGrantor : null,
    isCashPurchase: typeof row.isCashPurchase === 'boolean' ? row.isCashPurchase : null,
    mortgageId: str(row.mortgageId) || null,
    countyDocumentId: str(row.countyDocumentId) || null,
  };
}

/** `get_entity_mortgages` / `get_person_mortgages`. */
function mortgage(row) {
  if (!row || typeof row !== 'object') return null;
  const recorded = ymd(row.recordingDate);
  const matures = ymd(row.maturityDate);
  return {
    ...base(row, 'mortgage'),
    date: recorded,
    amount: money(row.mortgageAmount),
    grantees: namesOf(row.borrowerNames || row.borrower),
    grantors: [],
    granteeEntityIds: idsOf(row.entityBorrowerIds, row.borrowerEntities),
    grantorEntityIds: [],
    lenderName: str(row.lenderName) || null,
    lenderType: str(row.lenderType) || null,
    /* THE SHORT-TERM-LOAN TEST'S INPUT. `loanTermMonths` is real but is often
       null, so it falls back to the span the row states itself. Derived rather
       than absent matters: the owner's rule is that the purchase was financed
       with a short-term loan (or cash), and a null term makes that unanswerable
       on rows that plainly answer it. */
    termMonths: Number.isFinite(Number(row.loanTermMonths)) && row.loanTermMonths != null
      ? Number(row.loanTermMonths)
      : monthsBetween(recorded, matures),
    termMonthsDerived: !(Number.isFinite(Number(row.loanTermMonths)) && row.loanTermMonths != null),
    maturityDate: matures,
    satisfactionDate: ymd(row.satisfactionDate),
    satisfactionId: str(row.satisfactionId) || null,
    /* `loanPurpose:'refinance'` DOES NOT MEAN AN EXIT — a 10-month bridge can
       carry it. Passed through as a signal, never as a verdict. */
    isRefinance: typeof row.isRefinance === 'boolean' ? row.isRefinance : null,
    isExtension: typeof row.isExtension === 'boolean' ? row.isExtension : null,
    loanPurpose: str(row.loanPurpose) || null,
    deedId: str(row.deedId) || null,
  };
}

/** `get_lender_satisfactions`. The payoff record — a mortgage going away. */
function satisfaction(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...base(row, 'satisfaction'),
    date: ymd(row.recordingDate),
    amount: money(row.originalMortgageAmount),
    originalMortgageDate: ymd(row.originalMortgageDate),
    grantees: namesOf(row.borrower), grantors: [],
    granteeEntityIds: idsOf(row.entityBorrowers), grantorEntityIds: [],
    mortgageId: str(row.mortgageId) || null,
    lenderName: str(row.lender || row.lenderAliasName) || null,
  };
}

/**
 * `get_address_ownership` — who held this property, and between which dates.
 *
 * THE snake_case FIELD LIVES HERE. `entity_grantees` is the only one in the API
 * and it is the field Check B is decided on, so reading the camelCase spelling
 * discards every property forever. Both are accepted; neither is guessed at.
 */
function ownership(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...base(row, 'ownership'),
    date: ymd(row.startDate),
    endDate: ymd(row.endDate),
    amount: money(row.totalConsideration),
    grantees: namesOf(row.grantees), grantors: [],
    granteeEntityIds: idsOf(row.entity_grantees, row.entityGrantees, row.entityGranteeIds),
    grantorEntityIds: [],
    people: namesOf(row.people),
    /* Lives on the OWNERSHIP row, not on the deed — a caller looking for it on a
       deed finds nothing and reads that as "arm's length". */
    nonArmsLength: typeof row.isNonArmsLengthTransfer === 'boolean' ? row.isNonArmsLengthTransfer : null,
    deedId: str(row.deedId) || null,
    /* An ownership row with no `endDate` is the CURRENT owner — the input to the
       single most valuable check there is: they say they sold it and the record
       still shows them holding it. */
    isCurrent: !ymd(row.endDate),
  };
}

/**
 * `get_address_transactions` — a mixed feed. The row's own `type` decides which
 * normaliser it gets; an unrecognised type is returned as a deed-shaped row
 * rather than dropped, because dropping it would silently lose evidence.
 */
function transaction(row) {
  if (!row || typeof row !== 'object') return null;
  const kind = str(row.type).toLowerCase();
  const common = {
    ...base(row, kind.includes('mortgage') ? 'mortgage' : (kind.includes('satisf') || kind.includes('release') ? 'satisfaction' : 'deed')),
    date: ymd(row.recordingDate),
    amount: money(row.amount),
    grantors: namesOf(row.partiesGrantor), grantees: namesOf(row.partiesGrantee),
    grantorEntityIds: idsOf(row.entityGrantors), granteeEntityIds: idsOf(row.entityGrantees, row.entityBorrowers),
    lenderName: str(row.lenderName) || null,
    lenderType: str(row.lenderType) || null,
    isRefinance: typeof row.isRefinance === 'boolean' ? row.isRefinance : null,
    loanPurpose: str(row.loanPurpose) || null,
    maturityDate: ymd(row.maturityDate),
  };
  if (common.kind === 'mortgage') {
    common.termMonths = monthsBetween(common.date, common.maturityDate);
    common.termMonthsDerived = true;
  }
  return common;
}

/** Whole months between two `YYYY-MM-DD` strings; null unless both are readable
 *  and the second is not before the first. Calendar arithmetic only — no Date
 *  maths, no timezone, matching `term-options.js`. */
function monthsBetween(a, b) {
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let m = (by - ay) * 12 + (bm - am);
  if (bd < ad) m -= 1;
  return m >= 0 ? m : null;
}

/**
 * THE SAME TRANSACTION CAN ARRIVE TWICE.
 *
 * A row is returned once as `dataSource:'elementix'` and again as `'external'`,
 * with DIFFERENT ids — so one flip counts twice unless they are collapsed. The
 * key is what the county recorded (its document id, else the date + amount +
 * property), never the vendor's own id, which is exactly what differs.
 * `elementix` wins when both are present: it is the richer row.
 */
function dedupe(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r) continue;
    const key = r.countyDocumentId
      ? `c:${r.countyDocumentId}`
      : `k:${r.kind}|${r.date || ''}|${r.amount == null ? '' : r.amount}|${(r.addresses[0] || '').toLowerCase()}`;
    const prior = byKey.get(key);
    if (!prior) { byKey.set(key, r); continue; }
    if (prior.source !== 'elementix' && r.source === 'elementix') byKey.set(key, r);
  }
  return [...byKey.values()];
}

/** Map a list through a normaliser, dropping only what could not be read. */
const many = (rows, fn) => (Array.isArray(rows) ? rows.map(fn).filter(Boolean) : []);

module.exports = {
  deed, mortgage, satisfaction, ownership, transaction,
  deeds: (r) => dedupe(many(r, deed)),
  mortgages: (r) => dedupe(many(r, mortgage)),
  satisfactions: (r) => dedupe(many(r, satisfaction)),
  ownerships: (r) => many(r, ownership),
  transactions: (r) => dedupe(many(r, transaction)),
  dedupe,
  _internals: { money, ymd, addressesOf, namesOf, idsOf, monthsBetween, mlsOf },
};
