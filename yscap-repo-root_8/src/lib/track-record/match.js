'use strict';
/**
 * MAY PILOT BIND THIS VENDOR RECORD TO THIS TRACK-RECORD LINE ON ITS OWN?
 *
 * PURE — no database, no network. The SQL twin's answer is an INPUT, never a
 * call from here (see "BOTH MUST AGREE" below).
 *
 * ── THE DOCTRINE THIS INHERITS ─────────────────────────────────────────────
 * "Never a new normalizer." Address identity in this repo has exactly one
 * answer, `address.sameAddress`, reached through `track-record-key`'s two-layer
 * split: `trackRecordKey` is a cheap GROUPING net (house|street|zip, unit-free
 * on purpose, so two condo units share it) and `matchTrackRecord` is the VERDICT.
 * This module adds no matching of its own. It adds a REFUSAL layer on top,
 * because binding a stranger's deed to a borrower's line credits them with
 * somebody else's flip — the exact loss the whole rebuild exists to prevent.
 *
 * ── BOTH MUST AGREE, AND THAT IS WHY THE SQL ANSWER IS AN ARGUMENT ─────────
 * Two independent implementations answer "same place": the JS `sameAddress`, and
 * `pilot_address_same_place` in SQL (db/415, patched by db/497). They are held
 * to a standing rule — the SQL may UNDER-match, never OVER-match — and an
 * auto-confirm here requires BOTH to say yes. One implementation agreeing with
 * itself proves nothing; two written on different days, in different languages,
 * agreeing is a real check.
 *
 * So `sqlSamePlace` is passed IN. A caller that could not obtain it passes
 * undefined, and this FAILS CLOSED to manual review — never "well, the JS said
 * yes". Making this module reach for a database would also make it untestable
 * offline and would put a query inside a loop over every candidate.
 *
 * ── THE FOUR FORCED-REVIEW SHAPES, AND WHY EACH IS HERE ────────────────────
 * Each is a case where two addresses can look identical to a comparer and be two
 * different buildings. None is hypothetical; each is written down in this repo
 * already, in the code that had to learn it the hard way.
 *
 *   HYPHENATED HOUSE NUMBER — in Queens, the Bronx, much of Philadelphia and
 *   Hawaii a hyphen is part of ONE number (the prefix is the nearest cross
 *   street), so "150-25 78th Rd" and "150-99 78th Rd" are different houses.
 *   Elsewhere it is a RANGE and "27-29 Tuscany Ter" IS "27 Tuscany Ter".
 *   `houseMatches` already refuses two hyphenated numbers; what it cannot do is
 *   tell a genuine span from a Queens number when only ONE side is hyphenated —
 *   so a person looks.
 *
 *   ONE SIDE NAMES A UNIT — `sameAddress` treats a blank unit as "the same
 *   address written with less detail", which is right for deduping our own rows
 *   and wrong for adopting a stranger's deed: the deed may be for unit 4 of a
 *   building whose line is written without a unit, and crediting the whole
 *   building to one unit's deed is a fabrication.
 *
 *   `Ext` / `Extension` — "Oak Street" and "Oak Street Extension" are two
 *   streets. The SharePoint folder matcher already carries this exact rule.
 *
 *   A DIRECTIONAL THAT DIFFERS — "S 2nd St" and "2nd St" are different streets,
 *   which is the corruption `geocodeRewriteIsSafe` exists to refuse. Here it is
 *   a belt to that suspender: even if both comparers said yes, a directional
 *   present on one side and not the other is never bound automatically.
 *
 * ── A REFUSAL IS NEVER A DELETION ──────────────────────────────────────────
 * `manual_review` means a human decides. It does not discard the candidate, and
 * nothing here ever removes a line. `reject` is reserved for a candidate that is
 * provably about a different property, and even that only keeps it out of the
 * auto path — the staging area still records it with the reason (db/496's
 * `skips`), because "we found this and did not stage it" is the record that
 * makes a missed property answerable later.
 */

const ADDR = require('../address');
const TRK = require('../track-record-key');

const ACTION = { AUTO: 'auto_confirm', REVIEW: 'manual_review', REJECT: 'reject' };

/** A street whose last word makes it a DIFFERENT street from the same name
 *  without it. Deliberately tiny and exact — this list refuses matches, so a
 *  loose entry here silently sends real work to a human forever. */
const EXTENSION_RE = /(?:^|[\s,])ext(?:\.|ension)?(?:[\s,]|$)/i;

const asText = (v) => { try { return ADDR.addressTextOf(v) || ''; } catch (_) { return ''; } };

/** The street portion (everything after the house number, before the city). */
function streetOf(v) {
  const t = asText(v).split(',')[0] || '';
  const toks = t.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return '';
  return (ADDR.houseNumberOf(t) ? toks.slice(1) : toks).join(' ');
}

function parts(v) {
  try { return ADDR.parseAddressParts(v); }
  catch (_) { return { house: '', street: '', streetBase: '', unit: '', city: '', state: '', zip: '' }; }
}

/**
 * How two addresses differ, in the terms the forced-review rules are written in.
 * Every field is a plain boolean so a caller can log or display it. Never throws.
 */
function differences(a, b) {
  const x = parts(a); const y = parts(b);
  const dirA = (() => { try { return ADDR.leadingDirectionalOf(asText(a).split(',')[0]); } catch (_) { return ''; } })();
  const dirB = (() => { try { return ADDR.leadingDirectionalOf(asText(b).split(',')[0]); } catch (_) { return ''; } })();
  return {
    houseHyphen: x.house.includes('-') || y.house.includes('-'),
    /* EXACTLY one side names a unit. Both naming the same unit is agreement;
       both naming different units is already a refusal inside `sameAddress`. */
    unitOneSided: (!!x.unit) !== (!!y.unit),
    unitConflict: !!x.unit && !!y.unit && x.unit !== y.unit,
    extension: EXTENSION_RE.test(streetOf(a)) || EXTENSION_RE.test(streetOf(b)),
    directional: dirA !== dirB,
    state: !!x.state && !!y.state && x.state !== y.state,
    zip: !!x.zip && !!y.zip && x.zip !== y.zip,
  };
}

/**
 * Which of the borrower's existing lines IS this address?
 *
 * Delegates to the chokepoint verbatim. It exists here only so a caller reads
 * one module rather than two, and so a future session cannot be tempted to
 * "just narrow by key" in the staging path — the key is a net, not a verdict.
 */
function findOurRow(rows, address) {
  try { return TRK.matchTrackRecord(rows, address); } catch (_) { return null; }
}

/**
 * The decision.
 *
 * @param {object}  ourRow      the `track_records` line we might bind to
 * @param {object}  candidate   the vendor's record — needs at least `.address`
 * @param {object}  opts
 * @param {string}  opts.elxStatus     the vendor's own address-match status;
 *                                     'exact' is the only value that may auto-bind
 * @param {boolean} opts.sqlSamePlace  what `pilot_address_same_place` answered.
 *                                     Omit and this fails closed to review.
 * @returns {{action, auto, reasons, blockers, differs, key}}
 *
 * Never throws.
 */
function decideMatch(ourRow, candidate, opts = {}) {
  const reasons = []; const blockers = [];
  const ours = ourRow && ourRow.property_address !== undefined ? ourRow.property_address : ourRow;
  const theirs = candidate && candidate.address !== undefined ? candidate.address : candidate;
  const differs = differences(ours, theirs);
  const key = (() => { try { return TRK.trackRecordKey(theirs) || ''; } catch (_) { return ''; } })();

  const add = (list, k, why) => list.push({ key: k, why });

  /* ── PRECONDITIONS. All mandatory; failing one can never auto-bind. ────── */
  const elx = String(opts.elxStatus || '').toLowerCase();
  if (elx !== 'exact') add(blockers, 'elx_not_exact', `The address service answered "${elx || 'nothing'}" rather than an exact match, so we are not certain it is even the same property.`);
  if (!key) add(blockers, 'unreadable_candidate', 'The record\'s address cannot be read well enough to group on — no house number or no street.');

  const p = parts(ours);
  if (!p.state && !p.zip) add(blockers, 'our_row_has_no_place', 'Our own line carries neither a state nor a ZIP, so two towns with the same street name would look identical.');

  /* ── THE TWO COMPARERS. Both must say yes. ────────────────────────────── */
  const jsSame = (() => { try { return ADDR.sameAddress(ours, theirs); } catch (_) { return false; } })();
  if (!jsSame) add(blockers, 'not_same_place', 'These are not the same address.');
  if (opts.sqlSamePlace !== true) {
    add(blockers, opts.sqlSamePlace === false ? 'sql_disagrees' : 'sql_not_consulted',
      opts.sqlSamePlace === false
        ? 'The database\'s own address comparison disagrees with ours. Two comparers must agree before PILOT binds a record by itself.'
        : 'The database\'s address comparison was not consulted, so only one comparer has answered.');
  }

  /* A candidate that is not the same place at all is a REJECT, not a question
     for a human — but it is still recorded, with this reason. */
  if (!jsSame && (differs.state || differs.zip || differs.unitConflict)) {
    return { action: ACTION.REJECT, auto: false, reasons, blockers, differs, key };
  }

  /* ── THE FOUR FORCED-REVIEW SHAPES. ──────────────────────────────────── */
  if (differs.houseHyphen) add(blockers, 'hyphenated_house_number', 'One of the house numbers is hyphenated. In Queens, the Bronx, Philadelphia and Hawaii that is one number, not a range — two houses can share a prefix.');
  if (differs.unitOneSided) add(blockers, 'unit_on_one_side_only', 'One side names a unit and the other does not. A deed for one unit is not evidence about the whole building.');
  if (differs.extension) add(blockers, 'street_extension', '"Extension" makes it a different street from the same name without it.');
  if (differs.directional) add(blockers, 'directional_differs', 'The leading direction on the street (N/S/E/W) is not the same on both sides — that is a different street.');

  if (blockers.length) return { action: ACTION.REVIEW, auto: false, reasons, blockers, differs, key };

  add(reasons, 'both_comparers_agree', 'Both address comparisons agree this is the same property, the address service matched it exactly, and none of the look-alike shapes apply.');
  return { action: ACTION.AUTO, auto: true, reasons, blockers, differs, key };
}

/**
 * The whole question in one call: find the borrower's line, then decide.
 * Returns `{ row: null, action: 'manual_review' }` when nothing on the record
 * looks like this property — a candidate with no home is a person's call about
 * whether to add a NEW line, never an automatic insert.
 */
function matchCandidate(rows, candidate, opts = {}) {
  const theirs = candidate && candidate.address !== undefined ? candidate.address : candidate;
  const row = findOurRow(rows, theirs);
  if (!row) {
    return {
      row: null,
      action: ACTION.REVIEW,
      auto: false,
      reasons: [],
      blockers: [{ key: 'no_matching_line', why: 'This property is not on the borrower\'s track record yet. Adding a property is a person\'s decision.' }],
      differs: differences(null, theirs),
      key: (() => { try { return TRK.trackRecordKey(theirs) || ''; } catch (_) { return ''; } })(),
    };
  }
  return { row, ...decideMatch(row, candidate, opts) };
}

module.exports = {
  decideMatch,
  matchCandidate,
  findOurRow,
  differences,
  ACTION,
  EXTENSION_RE,
  _internals: { streetOf, parts },
};
