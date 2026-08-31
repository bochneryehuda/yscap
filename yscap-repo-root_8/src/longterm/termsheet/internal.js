'use strict';
/* ──────────────────────────────────────────────────────────────────────────
   LONG-TERM — WHO IS REALLY BEHIND A PRICED OPTION (db/651).

   Owner-reported 2026-08-31: *"there is no place where loan officers can go in
   and see the data when they put in the ID … see exactly what the input was and
   what exactly they priced in the real program and the real investors behind
   everything."*

   Half of that already replayed and half could not. The SCENARIO — every figure
   the officer typed — has always been stored on the member, so "what was the
   input" comes back exactly. The INVESTOR never was: `snapshot.buildMember`
   states in a comment that `lender`, `investor`, `lenderId` and `rateSheetName`
   "are not keys on this object", because the snapshot IS the borrower's document
   and rule 10 is that an investor's name never reaches a client, in any form.

   ⛔ THAT REFUSAL IS NOT REOPENED. This is a SECOND record, beside the snapshot
   and never inside it — `lt_term_sheet_scenario.internal`, a staff-side column
   on a staff-side table, read by one staff-gated door. The snapshot stays a
   document a client may hold; this stays a note about who funded it.

   ⛔ IT IS A WHITELIST, NOT A COPY. A caller may post anything; only the nine
   keys below are kept, each capped and each type-checked, so a browser cannot
   grow the record by sending a bigger object — and, more to the point, so that
   adding a field is a deliberate decision about what we record about a vendor
   rather than a side effect of the board learning a new column.

   ⛔ NOTHING HERE IS DERIVED. Every value is the vendor's own, carried through
   the price response the officer was looking at. `investorKey` is the SERVER's
   canonical resolution (the registry that turns 151 spellings into one key —
   see `audience.js`), passed through the board, never re-derived in the browser
   and never re-derived here: two normalisers is how one investor becomes two.

   PURE — no database, no requires — so every rule is unit-testable and the
   projection can run inside the same transaction as the write.
   ────────────────────────────────────────────────────────────────────────── */

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Text as it is RECORDED (never rendered on a document): control characters
 *  out, whitespace collapsed, capped. A vendor's name is not ours to tidy beyond
 *  that — it is matched against the registry elsewhere by its own spelling. */
const str = (v, max = 120) => {
  if (v == null) return null;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

/**
 * The nine things we record about the vendor behind one option.
 *
 * `program` is the VENDOR'S OWN programme name and is the reason this exists at
 * all: the document prints the white-label name, so without this the officer can
 * never get back from "30-Year Rental Select" to what the investor calls it.
 */
const FIELDS = [
  'investor', //        who funds it — the vendor's own spelling
  'investorKey', //     the server's canonical identity for that investor
  'lender', //          the counterparty on the rate sheet
  'program', //         THEIR name for the programme, not the white label
  'product', //         their product / plan code
  'rateSheet', //       which sheet this price came off
  'rateGridId', //      the vendor's own handle on the grid
  'rawPrice', //        the price BEFORE our compensation
  'adjustedPoints', //  the points the board showed at that price
];

/** How each field is read. Numbers are numbers; everything else is capped text. */
const CAPS = {
  investor: 160,
  investorKey: 80,
  lender: 160,
  program: 160,
  product: 120,
  rateSheet: 160,
  rateGridId: 80,
};

/**
 * One selection's `internal` block → what is stored.
 *
 * ⛔ ALWAYS AN OBJECT, NEVER NULL. The column is `NOT NULL DEFAULT '{}'`, and a
 * member with nothing recorded must be indistinguishable from one whose record
 * came back empty — both mean "we do not know who was behind this", and
 * answering with two different shapes would make every reader handle a second
 * case that says the same thing. `isEmpty` is how a screen asks.
 */
function projectInternal(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of FIELDS) {
    if (CAPS[key] != null) {
      const v = str(s[key], CAPS[key]);
      if (v) out[key] = v;
    } else {
      const n = num(s[key]);
      if (n != null) out[key] = n;
    }
  }
  return out;
}

/** Is there anything recorded at all? A sheet issued before db/651 answers true. */
function isEmpty(v) {
  return !v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0;
}

/**
 * The one sentence a screen prints when there is nothing recorded.
 *
 * ⛔ IT SAYS WHY, AND IT DOES NOT GUESS. A blank here is not a fault and it is
 * not recoverable: the investor identity was never sent to the server when that
 * sheet was issued, so there is nothing to back-fill FROM. Telling an officer
 * "unknown" and leaving them to wonder whether the record is broken is worse
 * than telling them the record predates the feature.
 */
const NOT_RECORDED = 'This sheet was issued before PILOT recorded who was behind each price, so the '
  + 'investor is not on the record. Everything the officer typed is still exactly as it was.';

module.exports = { projectInternal, isEmpty, FIELDS, CAPS, NOT_RECORDED, _internals: { str, num } };
