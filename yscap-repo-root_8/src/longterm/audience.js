'use strict';
/**
 * LONG-TERM (LT) — WHO IS ALLOWED TO SEE WHAT.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE HARD RULE (owner-directed 2026-08-14, in his own words):
 *
 *   "You also need to make sure that you put a hard rule to block the investor
 *    name. The client should not be able to see the investor name. Never ever!
 *    Not borrowers, not TPOs, only internal staff."
 *
 * The investor / capital provider who buys a long-term loan is INTERNAL
 * KNOWLEDGE. It never reaches a borrower and it never reaches a broker (TPO),
 * on any surface, in any form — not a field, not a label, not a document name,
 * not a filter option, not an email, not a PDF, not an error message, not a
 * tooltip, not an export, not a log line a client can see.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS MODULE EXISTS RATHER THAN A NOTE IN A DOC. The investor name is typed
 * by hand and is spelled 151 different ways across the live book — "Deephaven",
 * "Deepahven", "deep heaven", "OAK TREE", "AHL", "BPL". A rule that says "don't
 * show the investor" is unenforceable against that; a naive `!== 'Deephaven'`
 * check passes a document titled "Deepahven approval.pdf" straight through to a
 * borrower. So the block is built on the SAME registry that resolves those
 * spellings (`investors.js`), which is the only thing that can actually catch
 * them all.
 *
 * WHAT THIS IS NOT. It is not a substitute for not sending the data in the first
 * place. The primary defence is always: don't select the column, don't put it in
 * the payload. This is the BACKSTOP for free text — a condition body, a comment,
 * a document filename, an email subject — where a human may have typed a name we
 * would never have chosen to send.
 *
 * READ-ONLY and PURE: no database, no network, no Encompass. It classifies and
 * redacts strings.
 *
 * ── THE INVESTORS ADDED BY HAND ARE UNDER THE SAME BLOCK (2026-09-02) ───────
 * A super admin can now add an investor the code registry does not carry
 * (`pricing.customInvestors`, read through `pricing/investor-roster.js`). Rule
 * 10 does not say "a REGISTRY investor's name never reaches a client"; it says
 * an investor's name never does. So the spellings this module blocks are the
 * EFFECTIVE roster — registry plus custom — through the one roster module,
 * never a second list here. The custom map reaches this module two ways:
 *   • `useCustomInvestors(map)` — called by the settings store every time the
 *     company settings are read or written (the declaration's `applyOnLoad`
 *     hook), so the block is rebuilt the moment somebody adds an investor and
 *     never runs a request behind; and
 *   • `opts.custom` on `scrubInvestorNames` — for a caller holding a candidate
 *     map in its hand, which is how the write door proves a typed white label
 *     survives the scrub BEFORE the map is stored.
 * The spelling list is memoised PER MAP (by identity), so a request costs no
 * rebuild and a changed map cannot serve a stale block.
 */

const roster = require('./pricing/investor-roster');

// ── The three audiences a long-term surface can serve ────────────────────────
// Deliberately an ordered list rather than a boolean: "internal or not" is the
// question today, and "which client" is the question the moment a broker portal
// exists. Getting that shape right now costs nothing.
const AUDIENCES = {
  /** Our own people. The ONLY audience that may see an investor. */
  INTERNAL: 'internal',
  /** The borrower — the person on the loan. */
  BORROWER: 'borrower',
  /** A third-party originator: the broker's own staff. A CLIENT, not us. */
  TPO: 'tpo',
};

const CLIENT_AUDIENCES = [AUDIENCES.BORROWER, AUDIENCES.TPO];

/** Is this audience a client (i.e. NOT our own staff)? Anything unrecognised is
 *  treated as a client — an unknown audience must never be handed internal data
 *  because somebody forgot to add it here. FAILS CLOSED. */
function isClient(audience) {
  return audience !== AUDIENCES.INTERNAL;
}

// ── What is internal-only ────────────────────────────────────────────────────
// A named list rather than a scattering of checks, so "what may a client see?"
// has ONE answer and adding a new secret is one line.
const INTERNAL_ONLY = [
  {
    key: 'investor',
    what: 'The investor / capital provider who buys the loan — their name in any '
      + 'form, their contact details, their own loan number, and the funding channel.',
    ownerRule: 'HARD RULE 2026-08-14: "Never ever! Not borrowers, not TPOs, only '
      + 'internal staff."',
    // Every Encompass field that carries it. A surface that reads one of these
    // for a client is wrong before any scrubbing question arises.
    fieldIds: [
      'CX.WHICHINVESTOR',   // step 1 — the shorthand name
      'VEND.X263',          // step 2 — the accurate name
      'VEND.X276',          // step 3 — the investor's own loan number
      'VEND.X273',          // the investor's email (its DOMAIN names them)
      'VEND.X267',          // the investor's ZIP
      'CX.TABLEFUNDER',     // the funding channel — names how, and implies who
    ],
    // The columns on our own side.
    columns: [
      'lt_loan_investors.shorthand_name',
      'lt_loan_investors.accurate_name',
      'lt_loan_investors.canonical_key',
      'lt_loan_investors.investor_loan_number',
      'lt_loan_investors.investor_email',
      'lt_loan_investors.funding_channel',
    ],
  },
];

/** Every field id that is internal-only, flattened. */
function internalOnlyFieldIds() {
  return INTERNAL_ONLY.reduce((all, e) => all.concat(e.fieldIds), []);
}

/** Every column on our own side that is internal-only, flattened. */
function internalOnlyColumns() {
  return INTERNAL_ONLY.reduce((all, e) => all.concat(e.columns), []);
}

/**
 * May this audience see this Encompass field?
 * The question a mapping layer should ask before it puts a value on a payload.
 */
function maySeeField(audience, fieldId) {
  if (!isClient(audience)) return true;
  const id = String(fieldId || '').toUpperCase();
  return !internalOnlyFieldIds().some((f) => f.toUpperCase() === id);
}

// ── Scrubbing free text ──────────────────────────────────────────────────────
// The wording a client sees INSTEAD. Deliberately says nothing about who the
// investor is — not even "a lender", which invites a follow-up question.
const REDACTION = 'our capital partner';

// ── How each spelling is allowed to match ────────────────────────────────────
// Three modes, decided by reading the actual alias list rather than by a length
// heuristic. The first cut used `length <= 5` and silently DROPPED 'emcap',
// 'emcep', 'acra', 'eresi', 'rcn' and 'nqm' — six real investor spellings that
// would have walked straight through to a borrower. Never guess at this: the
// aliases are enumerated, so read them.

/** LETTER CODES that are ALSO ordinary English, so they match only as a
 *  standalone UPPER-CASE word.
 *
 *  THE LIST IS TWO ENTRIES ON PURPOSE, and the first cut got this wrong. It
 *  held BPL, AHL, PHH, NPB, ROC and NQM as well — and the exhaustive sweep over
 *  the registry caught the consequence immediately: a staffer typing "roc" or
 *  "Bpl" in a condition leaked straight through to the borrower, because those
 *  are REAL recorded spellings and upper-case-only never matched them.
 *
 *  Only two of these codes are genuinely ambiguous: 'ad' is an English word
 *  (advertisement), and 'cf.' is the ordinary abbreviation for "compare". The
 *  rest — bpl, ahl, phh, npb, roc, nqm — are not English in any case, so they
 *  match case-insensitively like any other name. Narrow this list, never widen
 *  it: every code moved in here becomes invisible in lower case. */
const SHORT_CODES = new Set(['AD', 'CF']);

/** THE ONE ORDINARY ENGLISH WORD that is also an investor name on its own, and
 *  that a mortgage condition genuinely uses in its everyday sense all the time:
 *  "photos of the foundation", "foundation repair", "foundation inspection".
 *  Redacting that in every case would mangle real conditions constantly.
 *
 *  THE COMPROMISE, stated so it is a decision and not an oversight: it matches
 *  only when CAPITALISED ("Foundation", "FOUNDATION") — how a company name is
 *  written — and is left alone in lower case. Its multi-word form ("Foundation
 *  Mortgage") always matches, in any case.
 *
 *  RESIDUAL, accepted: a sentence STARTING with the word in its ordinary sense
 *  ("Foundation repair is required") is redacted. That is the cheap direction to
 *  be wrong in — an odd sentence, versus telling a borrower who bought their loan.
 *
 *  WHY THE LIST IS ONE ENTRY. It started as four — foundation, champions,
 *  dominion, arc — and the exhaustive sweep over the registry rejected the other
 *  three for a reason worth keeping: **the registry records those spellings in
 *  LOWER CASE, which means a staffer actually typed them that way on a real
 *  file.** A recorded spelling that the scrubber cannot see is a leak, and no
 *  amount of "it is also an English word" changes that. Only keep a word here if
 *  its ordinary use in a loan condition is genuinely common — otherwise catch it. */
const AMBIGUOUS_ALONE = new Set(['foundation']);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How ONE spelling is allowed to match. The single classifier for a registry
 * spelling and a hand-added one alike — a custom alias that happened to be a
 * short code or an ambiguous English word gets exactly the treatment the
 * registry's own would, because the rules above are about the WORD, not about
 * where it was recorded. Null for a blank.
 */
function classify(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (s.includes(' ')) {
    // A multi-word name is specific enough to match in any case. This
    // deliberately includes "Oak Tree", "Blue Lake" and "Temple View" —
    // they read like scenery, and they are the investor.
    return { text: s, mode: 'phrase' };
  }
  if (SHORT_CODES.has(s.toUpperCase())) return { text: s.toUpperCase(), mode: 'code' };
  if (AMBIGUOUS_ALONE.has(lower)) return { text: s, mode: 'capitalised' };
  // Not an English word — 'deepahven', 'emcap', 'oaktree', 'rcn'. Safe in
  // any case.
  return { text: s, mode: 'word' };
}

/**
 * Every spelling of every investor we have ever seen, longest first — over the
 * EFFECTIVE roster (registry + the investors added by hand).
 *
 * LONGEST FIRST IS LOAD-BEARING: "Deephaven Mortgage LLC" must be replaced
 * before "Deephaven", or the leading match leaves " Mortgage LLC" stranded in
 * the sentence and the reader can still infer the company.
 *
 * Memoised PER CUSTOM MAP, by identity. The module-level map is swapped only
 * when its contents actually change (`useCustomInvestors`), so ordinary
 * requests never rebuild, and a caller's own candidate map gets its own list.
 */
const SPELLINGS_BY_MAP = new WeakMap();
/** The custom investors in force for this process — set by the settings store. */
let CUSTOM = roster.EMPTY;
let CUSTOM_IDENTITY = 'null';

function spellings(custom) {
  const map = custom === undefined ? CUSTOM : roster.asCustom(custom);
  const hit = SPELLINGS_BY_MAP.get(map);
  if (hit) return hit;
  const out = [];
  for (const inv of roster.effectiveList(map)) {
    for (const raw of [inv.label].concat(inv.aliases || [])) {
      const c = classify(raw);
      if (c) out.push(c);
    }
  }
  // De-duplicate per mode, then sort longest-first.
  const seen = new Set();
  const list = out
    .filter((e) => {
      const k = `${e.mode}:${e.text.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.text.length - a.text.length);
  SPELLINGS_BY_MAP.set(map, list);
  return list;
}

/**
 * Tell the block which investors have been added by hand.
 *
 * Called by the settings store on every read and every write of the company
 * settings (the declaration's `applyOnLoad` hook), with the STORED map. The
 * identity is the map's JSON: an unchanged map is a no-op, a changed one swaps
 * the module-level map and — because the memo is keyed on the map — the
 * spelling list is rebuilt on the next scrub. Never throws: an unreadable map
 * reads as no custom investors, which leaves the registry block exactly as it
 * was and can only ever cost the hand-added names, never the block itself.
 */
function useCustomInvestors(raw) {
  let identity;
  try { identity = JSON.stringify(raw === undefined ? null : raw); } catch { identity = null; }
  if (identity === CUSTOM_IDENTITY) return { changed: false, customInvestors: CUSTOM.size };
  let next = roster.EMPTY;
  try { next = raw == null ? roster.EMPTY : roster.readCustom(raw).custom; } catch { next = roster.EMPTY; }
  CUSTOM = next;
  CUSTOM_IDENTITY = identity;
  return { changed: true, customInvestors: CUSTOM.size };
}

/**
 * Take an investor name out of free text before a client reads it.
 *
 * Use on anything a human typed that a borrower or broker will see: a condition
 * body, a comment, a document filename, an email subject or body.
 *
 * NEVER THROWS, and never returns undefined — a scrubber that can fail is a
 * scrubber that gets wrapped in a try/catch that swallows the leak.
 *
 * @param {string} text
 * @param {string} [audience] — internal text is returned untouched.
 * @param {{custom?: Map|object}} [opts] — a custom map to scrub against INSTEAD
 *   of the one in force; the write door uses it to prove a typed white label
 *   survives before the map is stored. Omitted → the map in force.
 * @returns {string}
 */
function scrubInvestorNames(text, audience = AUDIENCES.BORROWER, opts = undefined) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  if (!isClient(audience)) return s;
  try {
    const custom = opts && opts.custom !== undefined ? opts.custom : undefined;
    for (const { text: name, mode } of spellings(custom)) {
      // Whitespace inside a name matches any run of it, so "Oak  Tree" and a
      // name broken across a line are both caught.
      const body = escapeRe(name).replace(/\s+/g, '\\s+');
      // Boundaries are alphanumeric-only on purpose, NOT \b: it must still fire
      // inside "Deephaven_approval.pdf" and "OAKTREE-letter.pdf".
      const pattern = `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`;
      let re;
      if (mode === 'code') {
        // Standalone UPPER-CASE only: "AD" but never "added" or "road".
        re = new RegExp(pattern, 'g');
      } else if (mode === 'capitalised') {
        // "Foundation" and "FOUNDATION", never lower-case "foundation".
        re = new RegExp(
          `(?<![A-Za-z0-9])(?:${escapeRe(name[0].toUpperCase())}${escapeRe(name.slice(1))}`
          + `|${escapeRe(name.toUpperCase())})(?![A-Za-z0-9])`,
          'g',
        );
      } else {
        re = new RegExp(pattern, 'gi');
      }
      s = s.replace(re, REDACTION);
    }
    // Collapse "our capital partner our capital partner" from adjacent hits.
    s = s.replace(new RegExp(`(?:${REDACTION})(?:\\s+${REDACTION})+`, 'gi'), REDACTION);
    return s;
  } catch {
    // If the matcher itself ever fails we must NOT return the raw text.
    return REDACTION;
  }
}

/** Does this text still name an investor? For tests and for a last-line guard
 *  before something goes out. */
function mentionsInvestor(text, opts = undefined) {
  if (text === null || text === undefined) return false;
  return scrubInvestorNames(String(text), AUDIENCES.BORROWER, opts) !== String(text);
}

/**
 * Remove every internal-only key from an object bound for a client.
 *
 * Shallow by design: a client payload should be BUILT for the client, not an
 * internal object with bits deleted — deep-stripping an arbitrary shape invites
 * the belief that any internal object is safe to hand over, which it is not.
 */
const INTERNAL_ONLY_KEYS = [
  'investor', 'investorName', 'investorKey', 'investorLoanNumber', 'investorEmail',
  'shorthandName', 'accurateName', 'canonicalKey', 'investor_loan_number',
  'investor_email', 'shorthand_name', 'accurate_name', 'canonical_key',
  'fundingChannel', 'funding_channel', 'noteBuyer', 'note_buyer', 'capitalProvider',
  'capital_provider',
];

function stripInternalOnly(obj, audience = AUDIENCES.BORROWER) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  if (!isClient(audience)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (INTERNAL_ONLY_KEYS.includes(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

function summary() {
  return {
    audiences: Object.values(AUDIENCES),
    clientAudiences: CLIENT_AUDIENCES,
    internalOnlySubjects: INTERNAL_ONLY.length,
    internalOnlyFieldIds: internalOnlyFieldIds().length,
    internalOnlyColumns: internalOnlyColumns().length,
    spellingsBlocked: spellings().length,
    // How many hand-added investors the block currently covers, so a health
    // reading can tell "no custom investors" from "the store never told us".
    customInvestorsBlocked: CUSTOM.size,
    redaction: REDACTION,
    rule: 'The investor name never reaches a borrower or a TPO. Internal staff only. '
      + 'Owner-directed 2026-08-14.',
  };
}

module.exports = {
  AUDIENCES,
  CLIENT_AUDIENCES,
  INTERNAL_ONLY,
  INTERNAL_ONLY_KEYS,
  REDACTION,
  isClient,
  maySeeField,
  internalOnlyFieldIds,
  internalOnlyColumns,
  scrubInvestorNames,
  mentionsInvestor,
  stripInternalOnly,
  useCustomInvestors,
  summary,
  _internals: { spellings, classify, AMBIGUOUS_ALONE, SHORT_CODES, customInForce: () => CUSTOM },
};
