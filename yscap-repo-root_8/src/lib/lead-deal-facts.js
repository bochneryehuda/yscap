'use strict';
/**
 * WHAT THE VISITOR ACTUALLY TYPED, PROMOTED ONTO THE LEAD ROW.
 *
 * Owner-reported 2026-08-07: "Another loan officer requested that he send out his
 * unique link, and somebody generated the term sheet with the name of the LLC and
 * everything, but that person didn't put in his email address and phone number. We
 * don't want to require them to put in the email address and phone number, but since
 * they didn't put in their email address and phone number, they were not added into
 * his account as a lead. He wants that person to be added into his account as a lead
 * with the phone number, the LLC property, and everything that that person entered
 * with all the information he used to enter the term sheet. He can also attach to the
 * lead the term sheet that he generated, and then loan officers can do his research to
 * try to figure out who that person is and try to call him."
 *
 * ROOT CAUSE, and it is not the contact requirement. `term_sheet_generated` has been
 * allowed to land with no email and no phone since 2026-07-24, so a row genuinely was
 * created — but `POST /api/leads` wrote only `tool, name, email, phone, officer_code,
 * officer_id, subject, message, payload, ip, ua, assigned_via`. The CRM columns the
 * lead screens actually read — `company`, `property_address`, `property_type`,
 * `program`, `loan_amount` — were added later for hand-typed leads and NOTHING ever
 * filled them from a tool. So the LLC name, the property and the figures the visitor
 * typed sat in the `payload` jsonb, which no screen renders, and the lead appeared in
 * the officer's book as a nameless row with nothing on it. From the officer's side
 * that is indistinguishable from "no lead was created".
 *
 * THE CLASS: a public capture door that writes only the columns it was born with, while
 * the structured columns everything downstream reads are filled by a different door.
 * The data was never missing — it was in a bag nobody opens.
 *
 * PURE — no DB, no network, never throws. Every value is bounded to its column, so a
 * pasted essay or a 30-digit number can never turn a lead capture into a 500 (the
 * standing "a value must fit its column" rule); `fields.js` owns the primitives.
 */

const F = require('./fields');

/* The bounded text columns on `leads` this promotes into, with the cap the COLUMN
   decides — never a number typed here twice. `company` and `program` are text;
   `property_type` is text. A value longer than its cap is trimmed rather than
   refused: a lead is captured or it is lost, and this is a door with no human at it
   (the same reasoning as the public intake form's drop-don't-refuse rule). */
const TEXT_CAPS = { company: 200, program: 80, propertyType: 60 };

/** A finite, POSITIVE money figure inside numeric(14,2), else null. Never throws.
 *
 * THE ABSENCE CHECK COMES FIRST, and it is the whole reason this is a function:
 * `Number(null)` is `0`, and `Number('')` is `0` — both finite, both non-negative — so
 * checking `Number.isFinite` alone turns "no loan amount was sent" into a stored $0.
 * That is not a cosmetic slip: it makes `any` true on a submission that carried
 * nothing, and it prints "$0" on the lead as though the deal were priced at zero. The
 * repo has been bitten by this exact trap before (see the `oldBlank` note in
 * clickup/mapper).
 *
 * A zero is dropped for the same reason: it means "not priced yet", not "$0". */
function money(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // numeric(14,2) → 12 integer digits. A bigger number is not a loan amount; drop it
  // rather than 500 the capture (22003).
  if (n >= 1e12) return null;
  return Math.round(n * 100) / 100;
}

function text(v, cap) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return s.slice(0, cap);
}

/**
 * A jsonb-safe property address for `leads.property_address`, in the shape the CRM
 * already stores and the convert-to-file flow already reads (`{oneLine, ...}`).
 * Accepts either a one-line string or an object the tool assembled.
 */
function propertyAddress(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    return { oneLine: s.slice(0, 300) };
  }
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of ['oneLine', 'line1', 'street', 'city', 'state', 'zip']) {
    const s = text(v[k], k === 'oneLine' ? 300 : 120);
    if (s) out[k] = s;
  }
  if (!Object.keys(out).length) return null;
  // Compose a one-line if the tool sent parts but not the line — every reader
  // prefers `oneLine`, and an address with no one-line renders blank.
  if (!out.oneLine) {
    const street = out.line1 || out.street || '';
    const tail = [out.city, [out.state, out.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const composed = [street, tail].filter(Boolean).join(', ');
    if (composed) out.oneLine = composed.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The deal facts a tool submission carries, ready to write onto the lead row.
 *
 * Reads the TOP-LEVEL body fields a tool sends, falling back to the same names inside
 * `payload` — several tools have always put their state there, and a caller should not
 * have to know which. Everything is optional: a tool that sends none of it produces an
 * all-null result and the INSERT behaves exactly as it did before.
 *
 * @param {object} body the request body
 * @returns {{company: string|null, propertyAddress: object|null, propertyType: string|null,
 *            program: string|null, loanAmount: number|null, any: boolean}}
 */
function dealFactsFrom(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const p = (b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload)) ? b.payload : {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (b[k] != null && b[k] !== '') return b[k];
      if (p[k] != null && p[k] !== '') return p[k];
    }
    return null;
  };
  const out = {
    // THE ENTITY IS THE ONE FACT THE OWNER NAMED FIRST — "somebody generated the term
    // sheet with the name of the LLC and everything". `entityName`/`borrower` are what
    // the term-sheet tool calls it.
    company: text(pick('company', 'entityName', 'entity', 'llcName'), TEXT_CAPS.company),
    propertyAddress: propertyAddress(pick('propertyAddress', 'property', 'propAddr')),
    propertyType: text(pick('propertyType', 'propType'), TEXT_CAPS.propertyType),
    program: text(pick('program'), TEXT_CAPS.program),
    loanAmount: money(pick('loanAmount', 'totalLoan')),
  };
  out.any = !!(out.company || out.propertyAddress || out.propertyType || out.program || out.loanAmount != null);
  return out;
}

/**
 * A DISPLAY NAME for a lead that arrived with no contact details at all.
 *
 * A nameless row is unworkable — the officer cannot tell one anonymous term sheet from
 * the next, which is the practical half of "they were not added into his account as a
 * lead". The entity or the borrower name they typed IS the identity they gave us, so
 * use it; failing that, name the property. Returns null when the submission genuinely
 * said nothing, so the caller keeps its own fallback rather than inventing a name.
 */
function displayNameFrom(body, facts) {
  const b = (body && typeof body === 'object') ? body : {};
  const p = (b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload)) ? b.payload : {};
  const f = facts || dealFactsFrom(b);
  const borrower = text(b.borrowerName || p.borrowerName || p.borrower, 200);
  const named = f.company || borrower;
  if (named) return named;
  const addr = f.propertyAddress && f.propertyAddress.oneLine;
  return addr ? `Term sheet — ${addr}`.slice(0, 200) : null;
}

/** jsonb-safe, NUL-stripped payload text — delegated, never re-inlined. */
function payloadJson(obj) { return F.jsonbText(obj); }

module.exports = { dealFactsFrom, displayNameFrom, propertyAddress, payloadJson, _internals: { money, text, TEXT_CAPS } };
