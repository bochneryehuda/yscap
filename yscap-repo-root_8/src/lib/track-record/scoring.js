'use strict';
/**
 * THE SCORING LADDER — how much a public-record match is worth, and what band
 * that puts a claimed deal in.
 *
 * PURE. No database, no network, no clock of its own (`today` is passed in). It
 * takes signals somebody else gathered and returns a score, a band and — the
 * part that actually matters to a reviewer — the REASONS.
 *
 * ── TUNED HARD FOR PRECISION, AND HERE IS WHY THAT ASYMMETRY IS RIGHT ───────
 * A false positive credits this borrower with SOMEBODY ELSE'S FLIP. That is a
 * direct credit loss, it inflates an experience tier, it prices a loan on
 * experience the borrower does not have, and it is exactly the error an investor
 * finds in diligence. A false negative sends the line to a human, who spends ten
 * minutes. Every threshold below leans on that asymmetry, so when a rule is
 * ambiguous the STRICTER reading wins.
 *
 * ── GATE A IS AN IDENTITY GATE, AND A3 IS A HARD PRECONDITION ───────────────
 * A3 (the entity we matched is the GRANTEE on the instrument) is MANDATORY: a
 * row without it is DISCARDED, not scored. This is not a nicety — it caught a
 * live false positive during API probing, where a York, PA investor's profile
 * returned a Philadelphia property he never owned, because his LLC appeared as
 * GRANTOR on an unrelated later deed. Appearing on a deed is not owning the
 * property; being the grantee is.
 *
 * ── THE SPEC CONTRADICTED ITSELF ON nameCommonnessScore >= 85 ───────────────
 * The blueprint's penalty list says ">= 85 -> cap at NEEDS REVIEW" and its band
 * list says ">= 85 -> cannot verify". Both are implemented literally and the
 * STRICTER one binds, which resolves the contradiction without picking a side:
 * at >= 85 the answer is `cannot_verify`, and the cap is simply never the
 * binding constraint there. The reason to resolve it strictly rather than
 * loosely is the asymmetry above — "Michael Smith" in Georgia is ONE node in the
 * vendor's graph carrying 102 exits in the last three years, and crediting a
 * fraction of those to the wrong Michael Smith is the precise failure this
 * whole rebuild exists to prevent.
 *
 * ── NO HOLD-PERIOD PENALTY ──────────────────────────────────────────────────
 * Owner-directed 2026-08-09: "I don't care about such a short hold period."
 * Real presentable flips were found at 2, 11 and 13 days. There is deliberately
 * no rule here about how long a property was held, and one must not be added.
 */

/* ── GATE A — IDENTITY ───────────────────────────────────────────────────── */
const A = {
  signer: { key: 'A1', points: 50, why: 'the borrower personally signed the instrument' },
  sosOfficer: { key: 'A2', points: 35, why: 'the Secretary of State lists them as an officer of the entity' },
  granteeMember: { key: 'A3', points: 20, why: 'the entity we matched is the GRANTEE on the instrument' },
  researchLinked: { key: 'A4', points: 10, why: 'the vendor links this entity to the borrower' },
  membershipOnly: { key: 'A5', points: 0, why: 'we only know they are a member of the entity' },
};

/* ── GATE B — RECENCY ────────────────────────────────────────────────────── */
const B = {
  inWindowWithDeed: { key: 'B1', points: 20, why: 'the exit is inside the 3-year window and a recorded deed corroborates the date' },
  inWindowNoDeed: { key: 'B2', points: 10, why: 'the exit is inside the 3-year window, but nothing recorded corroborates the date' },
};
/** B3 is a CAP, not points: an exit this close to the boundary decides a tier. */
const BOUNDARY_DAYS = 60;

/* ── GATE C — THE EXIT ───────────────────────────────────────────────────── */
const C = {
  armsLengthSale: { key: 'C1', points: 25, why: 'sold to an unrelated buyer' },
  refinanceInWindow: { key: 'C2', points: 25, why: 'refinanced into a permanent loan within the window' },
  recordedSatisfaction: { key: 'C3', points: 5, why: 'the original loan has a recorded satisfaction' },
  rentStabilized: { key: 'C4', points: 5, why: 'the property was leased up' },
  relatedParty: { key: 'C5', points: -30, why: 'the buyer looks related to the borrower — this is not an arm’s-length exit' },
};

/* ── PENALTIES ───────────────────────────────────────────────────────────── */
const P = {
  commonName: { key: 'P1', points: -40, why: 'the name is common and nothing ties this person to the instrument personally' },
  thinCoverage: { key: 'P2', points: -10, why: 'the county’s entity records are thin, so an absence here proves little' },
  underConsideration: { key: 'P3', points: -15, why: 'the sale price recorded is less than the total consideration' },
  synthesizedListing: { key: 'P4', points: -10, why: 'the only exit evidence is a listing whose dates were synthesized from the deed' },
};

const COMMON_NAME_PENALTY_AT = 60;
const COMMON_NAME_REFUSE_AT = 85;
const THIN_COVERAGE_BELOW = 40;

const BAND_AUTO = 85;
const BAND_REVIEW = 55;

/** The refinance window the owner widened: "4 to 20 months, maybe." */
const REFI_MIN_MONTHS = 4;
const REFI_MAX_MONTHS = 20;
/** A permanent loan, not another bridge. */
const PERM_TERM_MIN_MONTHS = 120;

const daysBetween = (a, b) => {
  const t = (v) => Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`);
  const x = t(a); const y = t(b);
  return (isFinite(x) && isFinite(y)) ? Math.round((y - x) / 86400000) : null;
};

/**
 * Is a refinance the kind that shows a real exit?
 * Owner-directed: the window is 4–20 months, and "if you purchase with cash and
 * you refinance, then it's the same good" — so how the property was ACQUIRED is
 * deliberately not a condition.
 */
function refinanceQualifies(refi) {
  if (!refi) return { ok: false, why: 'no refinance recorded' };
  if (refi.isExtension === true) return { ok: false, why: 'that refinance is an extension of the same loan, not a new one' };
  const m = Number(refi.monthsAfterPurchase);
  if (!isFinite(m)) return { ok: false, why: 'we cannot tell how long after the purchase the refinance happened' };
  if (m < REFI_MIN_MONTHS) return { ok: false, why: `the refinance came ${Math.round(m)} months after purchase, too soon to be a completed project` };
  if (m > REFI_MAX_MONTHS) return { ok: false, why: `the refinance came ${Math.round(m)} months after purchase, outside the ${REFI_MIN_MONTHS}-${REFI_MAX_MONTHS} month window` };
  const term = Number(refi.termMonths);
  if (isFinite(term) && term < PERM_TERM_MIN_MONTHS) {
    return { ok: false, why: `the new loan runs ${Math.round(term)} months, which is another short-term loan rather than a permanent one` };
  }
  return { ok: true, why: `refinanced into a permanent loan ${Math.round(m)} months after purchase` };
}

/**
 * Score one claimed deal against the signals gathered for it.
 *
 * `signals` is a plain object; every field is OPTIONAL and an absent field means
 * "we did not look" or "nothing was there" — NEVER a negative. Returns:
 *   { discarded, band, score, reasons[], caps[], needs[] }
 */
function scoreDeal(signals = {}, opts = {}) {
  const s = signals || {};
  const reasons = [];
  const caps = [];
  let score = 0;

  const add = (rule, extraWhy) => {
    score += rule.points;
    reasons.push({ key: rule.key, points: rule.points, why: extraWhy || rule.why });
  };

  /* ── GATE A, and its hard precondition ─────────────────────────────────── */
  if (s.granteeIsMatchedEntity !== true) {
    /* DISCARDED, not scored. Appearing on a deed is not owning the property.
       Returning a low score instead would let a pile of weak-but-positive
       signals push a row somebody never owned into needs-review. */
    return {
      discarded: true,
      band: 'discarded',
      score: 0,
      reasons: [{
        key: 'A3',
        points: 0,
        why: 'the entity we matched is not the GRANTEE on this instrument, so this record does not show them acquiring the property',
      }],
      caps: [],
      needs: ['a record where the borrower’s entity is the grantee'],
    };
  }
  add(A.granteeMember);

  const hasPersonalIdentity = s.borrowerSignedInstrument === true || s.sosListsAsOfficer === true;
  if (s.borrowerSignedInstrument === true) add(A.signer);
  if (s.sosListsAsOfficer === true) add(A.sosOfficer);
  if (s.vendorLinksEntityToBorrower === true) add(A.researchLinked);
  if (!hasPersonalIdentity && s.memberOfEntity === true) add(A.membershipOnly);

  /* ── GATE B — recency ──────────────────────────────────────────────────── */
  if (s.exitInWindow === true) {
    if (s.deedCorroboratesExitDate === true) add(B.inWindowWithDeed);
    else add(B.inWindowNoDeed);

    /* B3 — an exit within 60 days of the boundary decides whether a deal counts
       at all, so it is never auto-proved on a date nobody checked. */
    if (s.exitDate && opts.today) {
      const d = daysBetween(s.exitDate, opts.today);
      if (d != null) {
        const fromBoundary = Math.abs((36 * 30.4375) - d);   // approximate, only to select a cap
        if (fromBoundary <= BOUNDARY_DAYS) {
          caps.push({ key: 'B3', band: 'needs_review', why: 'the exit date is close to the 3-year boundary, so it decides whether this deal counts at all' });
        }
      }
    }
  }

  /* ── GATE C — the exit ─────────────────────────────────────────────────── */
  /* RELATED PARTY IS DECIDED FIRST, because it changes what the other exit
     signals MEAN. A "sale" to the borrower's own other entity is not an
     arm's-length sale — the two are contradictory claims about one transaction,
     and awarding C1 alongside C5 would score a deal on both readings at once. */
  const related = s.relatedPartyExit === true || s.isNonArmsLengthTransfer === true;

  if (s.armsLengthSale === true && !related) add(C.armsLengthSale);
  const refi = refinanceQualifies(s.refinance);
  if (refi.ok) add(C.refinanceInWindow, refi.why);
  if (s.recordedSatisfaction === true) add(C.recordedSatisfaction);
  if (s.rentStabilized === true) add(C.rentStabilized);
  if (related) {
    add(C.relatedParty);
    /* AND IT CAPS THE BAND — a STRENGTHENING of the blueprint, deliberately.
       The spec gives C5 a -30 and nothing more. Measured against the clean
       fixture that is not a control at all: a fully corroborated deal scores
       165, and 165 - 30 = 135 still clears the 85 bar with every gate passing,
       so the deal auto-proves anyway.

       That cannot be right for THIS signal. §6.4 calls it "the Baltimore
       control" — the check that would have caught a scheme exposing ~12 lenders
       to $160M, in which every public-record signal fired CLEANLY because the
       deeds and the mortgages were all real. The whole point is that a
       related-party exit looks perfect on paper; a penalty that a perfect-looking
       deal can absorb is decorative. So it can never be auto-proved, and a human
       always looks. */
    caps.push({
      key: 'C5cap',
      band: 'needs_review',
      why: 'the buyer looks related to the borrower — a related-party exit can look perfect in the public record, so a person always reviews it',
    });
  }

  /* ── PENALTIES ─────────────────────────────────────────────────────────── */
  const common = Number(s.nameCommonnessScore);
  if (isFinite(common)) {
    if (common >= COMMON_NAME_PENALTY_AT && !hasPersonalIdentity) add(P.commonName);
    if (common >= COMMON_NAME_REFUSE_AT) {
      caps.push({ key: 'P1b', band: 'needs_review', why: 'the name is very common, so a name match alone cannot identify this person' });
    }
  }
  const coverage = Number(s.entityCombinedCoveragePct);
  if (isFinite(coverage) && coverage < THIN_COVERAGE_BELOW) add(P.thinCoverage);
  if (isFinite(Number(s.soldConsideration)) && isFinite(Number(s.totalConsideration))
      && Number(s.soldConsideration) < Number(s.totalConsideration)) add(P.underConsideration);
  if (s.mlsSaleDom === 0 && s.exitEvidenceIsListingOnly === true) add(P.synthesizedListing);

  /* ── BANDS ─────────────────────────────────────────────────────────────── */
  const gateAStrong = hasPersonalIdentity;
  const gateB1 = s.exitInWindow === true && s.deedCorroboratesExitDate === true;
  /* A related-party sale does not satisfy Gate C, for the same reason it does
     not earn C1: it is not an arm's-length exit. */
  const gateC = (s.armsLengthSale === true && !related) || refi.ok;

  let band;
  if (isFinite(common) && common >= COMMON_NAME_REFUSE_AT) {
    /* The spec says both "cap at needs review" and "cannot verify" for >= 85.
       Both are applied; the stricter binds. See the header. */
    band = 'cannot_verify';
  } else if (score < BAND_REVIEW) {
    band = 'cannot_verify';
  } else if (score >= BAND_AUTO && gateAStrong && gateB1 && gateC) {
    band = 'auto_proved';
  } else {
    band = 'needs_review';
  }

  /* A cap can only ever LOWER the band. */
  const order = { auto_proved: 3, needs_review: 2, cannot_verify: 1, discarded: 0 };
  for (const cap of caps) {
    if (order[cap.band] < order[band]) band = cap.band;
  }

  const needs = [];
  if (band === 'cannot_verify') {
    needs.push(hasPersonalIdentity
      ? 'a document showing the exit — the closing statement or the recorded deed'
      : 'a document tying the borrower to this entity — the operating agreement, or a deed they signed');
  }

  return { discarded: false, band, score, reasons, caps, needs };
}

module.exports = {
  scoreDeal,
  refinanceQualifies,
  A, B, C, P,
  BAND_AUTO,
  BAND_REVIEW,
  BOUNDARY_DAYS,
  COMMON_NAME_PENALTY_AT,
  COMMON_NAME_REFUSE_AT,
  REFI_MIN_MONTHS,
  REFI_MAX_MONTHS,
  PERM_TERM_MIN_MONTHS,
  _internals: { daysBetween },
};
