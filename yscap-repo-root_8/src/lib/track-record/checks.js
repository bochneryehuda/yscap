'use strict';
/**
 * THE THREE PILLARS, COMPUTED FROM THE RECORDS — pure, offline, never a verdict.
 *
 * PURE in the sense this repo already uses for `public-records-crosscheck.js`:
 * zero database work, zero network, and no clock of its own (`today` is passed
 * in). It takes a track-record line, whatever the vendor returned about that
 * property, and what we know about the entity, and reports THREE OBSERVATIONS —
 * one per pillar. It never decides anything: `auto_verdict` is the machine's
 * reading and `human_verdict` is the answer, and db/494 keeps them in separate
 * columns precisely so they can never collapse into one.
 *
 * ── NEVER FABRICATE ─────────────────────────────────────────────────────────
 * Absent data yields `no_data`. Not `contradicted`, not a guess, and never a
 * quiet `proved` on a thin signal. A `contradicted` requires an AFFIRMATIVE
 * disagreement — a record that says something else — because "we could not find
 * it" and "the record says otherwise" send a reviewer to two different places,
 * and the vendor's county coverage is genuinely patchy (that is what the
 * `entityCombinedCoveragePct` penalty in the scoring ladder is about).
 *
 * ── `too_recent` IS A REAL ANSWER, AND IT IS NOT `no_data` ──────────────────
 * Counties record on their own schedule; two to eight weeks between a closing
 * and a searchable record is ordinary. So the absence of a deed for something
 * that happened three weeks ago proves NOTHING, and saying `no_data` invites a
 * reviewer to go chasing a document that does not exist yet. `too_recent` tells
 * them the honest thing: ask again in a month. On the RECENCY pillar the same
 * verdict carries the frozen rule's other temporal state — an exit dated in the
 * FUTURE has not closed, so it counts toward nothing yet.
 *
 * ── THE OWNERSHIP PILLAR IS TWO CHECKS, AND THIS MODULE ONLY ANSWERS ONE ────
 * The owner's own correction (2026-08-09): Check A is "does the borrower CONTROL
 * this entity", asked ONCE per entity; Check B is "did that entity own THIS
 * property", asked once per line. This module reads the records, so it answers
 * CHECK B. Check A is a human's decision, carried onto every one of the entity's
 * properties by `track-record-ownership.syncEntityToTrackRecords`.
 *
 * WHEN CHECK B IS PROVED AND CHECK A HAS NEVER BEEN ASKED, THIS REPORTS
 * `no_data` — NOT `proved`. That looks strict and it is deliberate: the pillar's
 * question is "did THIS BORROWER own it", and an entity holding a deed says
 * nothing about who controls the entity. Reporting `proved` there would put a
 * green tick in front of a reviewer for a question nobody has answered, which is
 * the precise shape of the false positive this rebuild exists to prevent.
 * Nothing is lost: the proved Check B rides in `auto_evidence.checkB` and the
 * workspace shows "the entity held it — now confirm the borrower controls the
 * entity". Do not "simplify" this into a pass.
 *
 * ── THE EXIT DATE COMES FROM THE FROZEN RULE, NOT FROM HERE ─────────────────
 * `experience.exitDateOf` is the one definition of when a deal exited (and, as
 * amended 2026-08-09, of a ground-up exiting on whichever completion it has).
 * This module calls it. It must never re-derive one — a second copy is how the
 * SQL and JS twins drift, and the count feeds the tier, which prices the loan.
 *
 * ── THE EVIDENCE GRADE IS THE NIST SP 800-63A LADDER, MAPPED ONCE ──────────
 *   superior      the recorded instrument itself, with the signers read, showing
 *                 the borrower personally signed it
 *   strong        a recorded county instrument (deed / mortgage / satisfaction)
 *                 with a document id and a recording date
 *   fair          the vendor's aggregated record of a transaction, no document
 *   weak          a name match, or the borrower's own typed date, uncorroborated
 *   unacceptable  nothing at all
 * A grade describes the EVIDENCE, never the conclusion — a `contradicted` can be
 * `strong` (a deed says otherwise) or `weak` (a name did not line up).
 */

/* `experience` reaches `../db` when it is loaded, which builds a pg Pool and
   connects to nothing — the same shape `scripts/test-ground-up-exit-pure.js`
   already relies on. It is required here rather than copied because the exit
   rule is FROZEN and may have exactly one definition. */
const experience = require('../experience');
const ADDR = require('../address');
const entityLib = require('../track-record-entity');
const compare = require('../underwriting/compare');

const PILLARS = ['recency', 'ownership', 'exit'];

/** How long a county may reasonably take before a closing is searchable. */
const RECORDING_LAG_DAYS = 45;

/** How far a recorded date may sit from the claimed date and still be the same
 *  event. A closing recorded six weeks later is ordinary; six months is not. */
const DATE_TOLERANCE_DAYS = 120;

/** A refinance into anything shorter than this is another short-term loan, not
 *  an exit. Mirrors `scoring.PERM_TERM_MIN_MONTHS` — the two are the same rule
 *  read from two sides, and a test pins them together. */
const PERM_TERM_MIN_MONTHS = 120;

const VERDICT = {
  PROVED: 'proved',
  CONTRADICTED: 'contradicted',
  NO_DATA: 'no_data',
  TOO_RECENT: 'too_recent',
};

const GRADE = {
  SUPERIOR: 'superior',
  STRONG: 'strong',
  FAIR: 'fair',
  WEAK: 'weak',
  UNACCEPTABLE: 'unacceptable',
};

/* ── small pure helpers ──────────────────────────────────────────────────── */

/** 'YYYY-MM-DD' or null. Never throws, never guesses a format. */
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Whole days from a to b (b later ⇒ positive). null when either is unreadable. */
function daysBetween(a, b) {
  const x = ymd(a); const y = ymd(b);
  if (!x || !y) return null;
  return Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / 86400000);
}

/** Whole months between two calendar days, floored — the same arithmetic the
 *  frozen window uses, done on strings so no timezone can shift a day. */
function monthsBetween(from, to) {
  const a = ymd(from); const b = ymd(to);
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let n = (by - ay) * 12 + (bm - am);
  if (bd < ad) n -= 1;
  return n;
}

/** sameAddress, guarded. An unreadable side is never a match (never a merge). */
function samePlace(a, b) {
  try { return ADDR.sameAddress(a, b); } catch (_) { return false; }
}

/**
 * Is this recorded party name OUR side?
 *
 * Entity names go through `track-record-entity.promotionMatch`, which delegates
 * to `compare.entityMatch` and then RE-CHECKS through an allowlist of safe arms,
 * withholding the substring arm that calls "Hudson Properties LLC" and "Hudson
 * Properties LLC II" the same company. Person names use `namesMatchLoose`.
 * Returns { hit, as } so a caller can tell a person from an entity — the
 * ownership pillar needs that distinction, because a deed in the BORROWER's own
 * name needs no Check A at all.
 */
function whoIsThis(name, ctx) {
  const raw = String(name || '').trim();
  if (!raw) return { hit: false, as: null };
  for (const e of ctx.entityNames) {
    try { if (entityLib.promotionMatch(raw, e)) return { hit: true, as: 'entity', matched: e }; }
    catch (_) { /* a matcher that throws is not a match */ }
  }
  for (const p of ctx.borrowerNames) {
    try { if (compare.namesMatchLoose(raw, p)) return { hit: true, as: 'person', matched: p }; }
    catch (_) { /* same */ }
  }
  return { hit: false, as: null };
}

/** Any of these party names ours? Returns the first hit, or a miss. */
function anyOurs(names, ctx) {
  for (const n of asArray(names)) {
    const r = whoIsThis(n, ctx);
    if (r.hit) return r;
  }
  return { hit: false, as: null };
}

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : (v == null ? [] : [v]));

/** Borrower/grantee names on a mortgage. `shapes.js` emits the borrower names as
 *  `grantees` (from `borrowerNames || borrower`); a legacy or hand-built row may
 *  instead carry `borrowers`. Accept BOTH — reading only `borrowers` was
 *  `undefined` on every production mortgage, which is why `findRefinance` was
 *  silently `no_data` on real files (the exit-pillar refinance never fired). */
const mortgageHolders = (m) => [...asArray(m && m.grantees), ...asArray(m && m.borrowers)];

/** The grade a recorded instrument earns, lifted one rung when we read the
 *  signers and the borrower's own signature is on it. */
function gradeOf(rec, signedByBorrower) {
  if (!rec) return GRADE.UNACCEPTABLE;
  if (signedByBorrower) return GRADE.SUPERIOR;
  if (rec.documentId && ymd(rec.date)) return GRADE.STRONG;
  return GRADE.FAIR;
}

/** Did the borrower personally sign this instrument? Only ever true when the
 *  signers were actually retrieved — an absent signer list is not a "no", but it
 *  is certainly not a yes. */
function signedByBorrower(rec, ctx) {
  const signers = asArray(rec && rec.signers);
  if (!signers.length) return false;
  return signers.some((s) => {
    const nm = typeof s === 'string' ? s : (s && (s.name || s.signerName));
    const r = whoIsThis(nm, ctx);
    return r.hit && r.as === 'person';
  });
}

/* ── the context, normalized defensively ─────────────────────────────────── */

function normalizeContext(line, entityContext) {
  const ec = entityContext || {};
  const entityNames = [];
  for (const n of asArray(ec.entityNames)) if (String(n || '').trim()) entityNames.push(String(n).trim());
  // The line's own free-text entity is a name we should look for even when the
  // caller supplied none — it is what the borrower typed on the tool.
  const own = String((line && line.entity_name) || '').trim();
  if (own && !entityNames.some((e) => e.toLowerCase() === own.toLowerCase())) entityNames.push(own);

  const borrowerNames = [];
  for (const n of asArray(ec.borrowerNames)) if (String(n || '').trim()) borrowerNames.push(String(n).trim());

  return {
    entityNames: entityNames.filter((n) => { try { return !entityLib.junkEntityName(n); } catch (_) { return true; } }),
    borrowerNames,
    controlVerdict: ec.controlVerdict === 'confirmed' || ec.controlVerdict === 'rejected' ? ec.controlVerdict : null,
    llcId: ec.llcId || null,
  };
}

function normalizeRecords(v) {
  const r = v || {};
  return {
    deeds: asArray(r.deeds),
    mortgages: asArray(r.mortgages),
    satisfactions: asArray(r.satisfactions),
    currentOwner: r.currentOwner && typeof r.currentOwner === 'object' ? r.currentOwner : null,
    coverage: r.coverage && typeof r.coverage === 'object' ? r.coverage : null,
    /* `searched` says the vendor was actually ASKED about this property. With
       nothing searched, every pillar is `no_data` for the honest reason "we have
       not looked" rather than the misleading "we looked and found nothing". */
    searched: r.searched !== false && (asArray(r.deeds).length > 0 || asArray(r.mortgages).length > 0
      || asArray(r.satisfactions).length > 0 || !!r.currentOwner || r.searched === true),
  };
}

/**
 * EVERY ADDRESS A RECORD NAMES FOR THE PROPERTY.
 *
 * A vendor row carries `addresses[]` — a list, because one recorded document can
 * convey more than one parcel — and NEVER a field called `address`. Reading
 * `r.address` returned `undefined` on every real row, so `forProperty` matched
 * nothing, so BOTH the ownership and the exit pillar reported `no_data` on files
 * where the records held perfect evidence. The engine was dark and nothing
 * anywhere said so, because "no records about this property" and "I cannot read
 * the records at all" produce the identical verdict.
 *
 * `src/lib/elementix/shapes.js` now normalises at the connector seam, so a
 * production row always arrives with `addresses[]`. The single-string form is
 * still accepted for a hand-built row (the pure tests build rows directly), and
 * a row that carries neither yields NO addresses — never a silent match.
 */
function addressesOfRecord(r) {
  if (!r) return [];
  if (Array.isArray(r.addresses)) return r.addresses;
  if (r.addresses) return [r.addresses];
  return r.address ? [r.address] : [];
}

/** Every record of this kind that is about THIS property. */
function forProperty(records, address) {
  return records.filter((r) => addressesOfRecord(r).some((a) => samePlace(a, address)));
}

/* ── PILLAR 1 — RECENCY ──────────────────────────────────────────────────── */

function recencyPillar(line, recs, ctx, today) {
  const exit = experience.exitDateOf(line);
  const base = { pillar: 'recency', auto_source: 'derived' };

  if (!exit) {
    return {
      ...base,
      auto_verdict: VERDICT.NO_DATA,
      auto_confidence: null,
      auto_grade: GRADE.UNACCEPTABLE,
      auto_evidence: {
        why: 'This deal has no completed exit date yet, so there is nothing to date it by.',
        dealType: line.deal_type || null,
      },
    };
  }

  if (exit > today) {
    return {
      ...base,
      auto_verdict: VERDICT.TOO_RECENT,
      auto_confidence: 'certain',
      auto_grade: GRADE.WEAK,
      auto_evidence: { why: `The exit is dated ${exit}, which is in the future — it has not closed yet.`, exitDate: exit },
    };
  }

  const monthsAgo = monthsBetween(exit, today);
  if (monthsAgo != null && monthsAgo > experience.EXIT_WINDOW_MONTHS) {
    return {
      ...base,
      auto_verdict: VERDICT.CONTRADICTED,
      auto_confidence: 'certain',
      auto_grade: GRADE.WEAK,
      auto_evidence: {
        why: `The exit is dated ${exit}, about ${monthsAgo} months ago — outside the ${experience.EXIT_WINDOW_MONTHS}-month window, so it counts toward nothing.`,
        exitDate: exit,
        monthsAgo,
        /* The owner's REO rule: a line that does not count is not deleted, it
           joins the general REO list carrying the reason it is there. */
        reoReason: 'outside_window',
      },
    };
  }

  // In the window. How well is the DATE itself corroborated? That is the B1/B2
  // distinction the scoring ladder pays for, so report it here rather than
  // making the ladder re-derive it.
  const deed = forProperty(recs.deeds, line.property_address)
    .find((d) => { const n = daysBetween(exit, d.date); return n != null && Math.abs(n) <= DATE_TOLERANCE_DAYS; });

  return {
    ...base,
    auto_source: deed ? 'elementix' : 'derived',
    auto_verdict: VERDICT.PROVED,
    auto_confidence: deed ? 'certain' : 'likely',
    auto_grade: deed ? gradeOf(deed, false) : GRADE.WEAK,
    auto_evidence: {
      why: deed
        ? `The exit is dated ${exit}, inside the ${experience.EXIT_WINDOW_MONTHS}-month window, and a recorded instrument on ${ymd(deed.date)} corroborates it.`
        : `The exit is dated ${exit}, inside the ${experience.EXIT_WINDOW_MONTHS}-month window. Nothing recorded corroborates the date.`,
      exitDate: exit,
      monthsAgo,
      recordingDate: deed ? ymd(deed.date) : null,
      documentId: deed ? (deed.documentId || null) : null,
      deedCorroboratesExitDate: !!deed,
    },
  };
}

/* ── PILLAR 2 — OWNERSHIP (Check B, plus the Check A carry) ──────────────── */

/**
 * Decide the pillar from a holder we matched on a NON-DEED source (the county's
 * current-owner record, or a refinance mortgage). The verdict logic is exactly
 * the acquisition-deed branch's — a deed in the borrower's OWN name proves it; an
 * ENTITY holder is Check-B-proved but needs Check A (confirmed → proved, rejected
 * → contradicted, never-asked → no_data). Kept in one place so the three sources
 * can never disagree about what an entity match means. `w` supplies the per-source
 * wording; `source`/`confidence` are the source's own grade inputs.
 */
function ownershipFromHolder(base, who, rec, ctx, source, confidence, w) {
  const signed = signedByBorrower(rec, ctx);
  // A mortgage carries `documentId`; an ownership row carries `deedId`.
  const docId = rec.documentId || rec.deedId || null;
  const grade = gradeOf({ ...rec, documentId: docId }, signed);

  /* The SAME evidence shape the acquisition-deed branch records. Two reasons it
     must match: `signalsFor` reads `checkB.granteeIsMatchedEntity` to satisfy the
     scoring ladder's A3 identity gate (a HARD discard gate — without it a deal
     proved only by the current-owner record or a refinance would be thrown away
     as "not the grantee on any deed", so the pillar and the score would disagree),
     and `checkB.borrowerSignedInstrument` feeds the personal-identity gate. A3
     firing can only move such a deal from `discarded` to `needs_review`; it can
     never reach `auto_proved` without the exit/personal-identity gates passing on
     their own. `granteeIsMatchedEntity` reads "the party we matched is named as
     holder on this recorded instrument" — true for a person or an entity, exactly
     as the acquisition-deed branch sets it. */
  const checkB = {
    grantee: who.matched,
    granteeIsMatchedEntity: true,
    recordingDate: ymd(rec.date),
    documentId: docId,
    heldAs: who.as,
    borrowerSignedInstrument: signed,
  };

  // The borrower's OWN name — no entity between the person and the property.
  if (who.as === 'person') {
    return {
      ...base,
      auto_source: source,
      auto_verdict: VERDICT.PROVED,
      auto_confidence: confidence,
      auto_grade: grade,
      auto_evidence: { why: w.person, matched: who.matched, checkB },
    };
  }

  // An ENTITY holder. Check A decides whether it carries to this borrower. (The
  // 'rejected' branch mirrors the acq-deed branch and is currently unreachable —
  // see that branch's note; kept for a future explicit Check-A rejection.)
  if (ctx.controlVerdict === 'rejected') {
    return {
      ...base,
      auto_source: 'entity',
      auto_verdict: VERDICT.CONTRADICTED,
      auto_confidence: 'certain',
      auto_grade: grade,
      auto_evidence: { why: w.entityRejected, matched: who.matched, checkB, controlVerdict: 'rejected' },
    };
  }
  if (ctx.controlVerdict === 'confirmed') {
    return {
      ...base,
      auto_source: source,
      auto_verdict: VERDICT.PROVED,
      auto_confidence: confidence,
      auto_grade: grade,
      auto_evidence: { why: w.entityConfirmed, matched: who.matched, checkB, controlVerdict: 'confirmed', satisfiedByLlcId: ctx.llcId },
    };
  }
  return {
    ...base,
    auto_source: source,
    auto_verdict: VERDICT.NO_DATA,
    auto_confidence: null,
    auto_grade: grade,
    auto_evidence: { why: w.entityNoData, matched: who.matched, checkB, needsControlCheck: true },
  };
}

function ownershipPillar(line, recs, ctx, today) {
  const base = { pillar: 'ownership' };
  const deeds = forProperty(recs.deeds, line.property_address);

  // The acquisition: a deed conveying the property TO our side.
  let acq = null; let acqWho = null;
  for (const d of deeds) {
    const who = anyOurs(d.grantees, ctx);
    if (!who.hit) continue;
    // Prefer the one nearest the claimed purchase date; any is better than none.
    if (!acq) { acq = d; acqWho = who; continue; }
    const cur = daysBetween(line.purchase_date, acq.date);
    const cand = daysBetween(line.purchase_date, d.date);
    if (cand != null && (cur == null || Math.abs(cand) < Math.abs(cur))) { acq = d; acqWho = who; }
  }

  if (acq) {
    const signed = signedByBorrower(acq, ctx);
    const checkB = {
      grantee: acqWho.matched,
      granteeIsMatchedEntity: true,
      recordingDate: ymd(acq.date),
      documentId: acq.documentId || null,
      heldAs: acqWho.as,
      borrowerSignedInstrument: signed,
    };

    // A deed in the BORROWER'S OWN NAME needs no Check A — there is no entity
    // between the person and the property.
    if (acqWho.as === 'person') {
      return {
        ...base,
        auto_source: 'elementix',
        auto_verdict: VERDICT.PROVED,
        auto_confidence: 'certain',
        auto_grade: gradeOf(acq, signed),
        auto_evidence: { why: `The borrower is named as the grantee on the recorded deed for this property.`, checkB },
      };
    }

    // CHECK A EXPLICITLY REJECTED — an active human statement that the borrower does
    // NOT control this company, so the deed does not carry to them. NOTE: the only
    // current source of controlVerdict (verify-run.controlVerdictFor, reading the
    // boolean llc_borrowers.ownership_verified) can no longer produce 'rejected' — a
    // not-verified link (never-reviewed OR revoked) is 'no data' (null), never a
    // rejection. This branch is therefore currently unreachable and kept defensively
    // for a future explicit Check-A rejection signal; do NOT resurrect the old
    // false==rejected reading that made a never-reviewed link contradict the property.
    if (ctx.controlVerdict === 'rejected') {
      return {
        ...base,
        auto_source: 'entity',
        auto_verdict: VERDICT.CONTRADICTED,
        auto_confidence: 'certain',
        auto_grade: gradeOf(acq, signed),
        auto_evidence: {
          why: `"${acqWho.matched}" is the grantee on the recorded deed, but somebody reviewed this borrower's control of that company and rejected it — so this property does not carry to them.`,
          checkB,
          controlVerdict: 'rejected',
        },
      };
    }

    if (ctx.controlVerdict === 'confirmed') {
      return {
        ...base,
        auto_source: 'elementix',
        auto_verdict: VERDICT.PROVED,
        auto_confidence: 'certain',
        auto_grade: gradeOf(acq, signed),
        auto_evidence: {
          why: `"${acqWho.matched}" is the grantee on the recorded deed, and this borrower's control of that company has been confirmed.`,
          checkB,
          controlVerdict: 'confirmed',
          satisfiedByLlcId: ctx.llcId,
        },
      };
    }

    /* CHECK B PROVED, CHECK A NEVER ASKED. Read the file header before changing
       this to `proved` — the pillar's question is about the BORROWER, and an
       entity holding a deed says nothing about who controls the entity. */
    return {
      ...base,
      auto_source: 'elementix',
      auto_verdict: VERDICT.NO_DATA,
      auto_confidence: null,
      auto_grade: gradeOf(acq, signed),
      auto_evidence: {
        why: `"${acqWho.matched}" is the grantee on the recorded deed, so the company did hold this property. Nobody has confirmed yet that this borrower controls that company.`,
        checkB,
        needsControlCheck: true,
      },
    };
  }

  // NO ACQUISITION DEED NAMES US — but ownership can still be PROVED two other
  // ways, each stronger than an old deed naming somebody else (a current-owner or
  // refinance in our name means we owned it), so both run before the CONTRADICTED
  // branch and after the acquisition deed (neither is stronger than the deed).

  // (1) THE COUNTY'S CURRENT-OWNER RECORD names our side. `get_address_ownership`
  //     with no end date is the party holding the property today; if that is the
  //     borrower (or a confirmed entity of theirs), they own it.
  if (recs.currentOwner
      && addressesOfRecord(recs.currentOwner).some((a) => samePlace(a, line.property_address))) {
    const who = anyOurs([...(recs.currentOwner.grantees || []), ...(recs.currentOwner.people || [])], ctx);
    if (who.hit) {
      return ownershipFromHolder(base, who, recs.currentOwner, ctx, 'elementix', 'certain', {
        person: `The county's current-owner record for this property names the borrower as the holder.`,
        entityNoData: `"${who.matched}" is the current owner of record for this property, so the company holds it. Nobody has confirmed yet that this borrower controls that company.`,
        entityConfirmed: `"${who.matched}" is the current owner of record for this property, and this borrower's control of that company has been confirmed.`,
        entityRejected: `"${who.matched}" is the current owner of record, but this borrower's control of that company was reviewed and rejected — so this property does not carry to them.`,
      });
    }
  }

  // (2) A REFINANCE in our name. You cannot refinance a property you do not own,
  //     so a refinance mortgage naming the borrower (or a confirmed entity) proves
  //     ownership — ANY term (this is the ownership question, not the exit
  //     question, so the exit pillar's permanent-term test does not apply here).
  const refiMort = forProperty(recs.mortgages, line.property_address)
    .filter((m) => m.isExtension !== true
      && (m.isRefinance === true || /refi/i.test(String(m.loanPurpose || '')))
      && anyOurs(mortgageHolders(m), ctx).hit)
    .sort((a, b) => (ymd(b.date) || '').localeCompare(ymd(a.date) || ''))[0];
  if (refiMort) {
    const who = anyOurs(mortgageHolders(refiMort), ctx);
    return ownershipFromHolder(base, who, refiMort, ctx, 'elementix', 'certain', {
      person: `A refinance recorded on ${ymd(refiMort.date)} names the borrower on this property — you cannot refinance a property you do not own.`,
      entityNoData: `A refinance recorded on ${ymd(refiMort.date)} names "${who.matched}" as the borrower on this property, so the company held it. Nobody has confirmed yet that this borrower controls that company.`,
      entityConfirmed: `A refinance recorded on ${ymd(refiMort.date)} names "${who.matched}" as the borrower, and this borrower's control of that company has been confirmed.`,
      entityRejected: `A refinance recorded on ${ymd(refiMort.date)} names "${who.matched}", but this borrower's control of that company was reviewed and rejected.`,
    });
  }

  // No deed names us. Does one affirmatively name somebody else?
  const named = deeds.filter((d) => asArray(d.grantees).some((g) => String(g || '').trim()));
  if (named.length) {
    const others = [...new Set(named.flatMap((d) => asArray(d.grantees).map((g) => String(g || '').trim()).filter(Boolean)))];
    return {
      ...base,
      auto_source: 'elementix',
      auto_verdict: VERDICT.CONTRADICTED,
      /* `possible`, not `certain`: patchy county coverage looks exactly like
         this, which is why a human still decides. */
      auto_confidence: 'possible',
      auto_grade: gradeOf(named[0], false),
      auto_evidence: {
        why: `Every recorded deed we can see for this property conveys it to somebody else — ${others.slice(0, 3).join(', ')}${others.length > 3 ? '…' : ''} — and none names the borrower or their company. County coverage can be incomplete, so this needs a person to look.`,
        recordedGrantees: others,
        coveragePct: recs.coverage ? recs.coverage.entityCombinedCoveragePct : null,
      },
    };
  }

  // Nothing found at all.
  const sincePurchase = daysBetween(line.purchase_date, today);
  if (sincePurchase != null && sincePurchase >= 0 && sincePurchase <= RECORDING_LAG_DAYS) {
    return {
      ...base,
      auto_source: 'elementix',
      auto_verdict: VERDICT.TOO_RECENT,
      auto_confidence: 'likely',
      auto_grade: GRADE.UNACCEPTABLE,
      auto_evidence: { why: `The purchase is only ${sincePurchase} days old. Counties normally take a few weeks to publish a deed, so nothing found yet proves nothing — check again in a month.`, purchaseDate: ymd(line.purchase_date) },
    };
  }

  return {
    ...base,
    auto_source: 'elementix',
    auto_verdict: VERDICT.NO_DATA,
    auto_confidence: null,
    auto_grade: GRADE.UNACCEPTABLE,
    auto_evidence: {
      why: recs.searched
        ? 'We searched the public records for this property and found no deed naming the borrower or their company.'
        : 'The public records have not been searched for this property yet.',
      searched: recs.searched,
      coveragePct: recs.coverage ? recs.coverage.entityCombinedCoveragePct : null,
    },
  };
}

/* ── PILLAR 3 — THE EXIT ─────────────────────────────────────────────────── */

function exitPillar(line, recs, ctx, today) {
  const base = { pillar: 'exit' };
  const dealType = String(line.deal_type || '').toLowerCase();
  const isFlip = dealType.includes('flip');
  let ground = false;
  try { ground = experience.isGroundUp(line.deal_type); } catch (_) { ground = false; }
  const exit = experience.exitDateOf(line);

  if (!exit) {
    return {
      ...base,
      auto_source: 'derived',
      auto_verdict: VERDICT.NO_DATA,
      auto_confidence: null,
      auto_grade: GRADE.UNACCEPTABLE,
      auto_evidence: { why: 'This deal has no completed exit on file yet — no sale, no lease and no refinance.', dealType: line.deal_type || null },
    };
  }

  // THE ONE AFFIRMATIVE CONTRADICTION: they say they exited, and the record says
  // they still own it, as of a date after the claimed exit.
  /* THE SAME MISSING FIELD, one more time. An ownership row carries
     `addresses[]` too, so reading `.address` here made the single most valuable
     check in the engine — they say they sold it and the record still shows them
     holding it — permanently unreachable, on top of `currentOwner` never being
     populated at all. Both halves are fixed; this is the read. */
  if (recs.currentOwner && addressesOfRecord(recs.currentOwner).some((a) => samePlace(a, line.property_address))) {
    /* THE FIELDS ARE THE SHAPE'S OWN — `grantees`/`people`/`date`/`isCurrent`
       (shapes.ownership), never `owners`/`asOf`, which exist on NO row the
       normaliser produces. Reading the invented names made this check
       permanently dark: proven against a real ownership row, `own.owners` and
       `own.asOf` were both undefined, so a borrower claiming a 2024 sale on a
       property the county still showed them holding passed as `no_data`
       instead of `contradicted` (audit 2026-08-09). This is the exact class
       the shapes module's header exists to end, one layer up.

       An ownership row carries no "as of" stamp — `date` is when the holding
       STARTED and `isCurrent` means no transfer has been recorded since. So
       the honest test is: the CURRENT owner is still our side, the holding
       began on or before the claimed exit, and the exit is far enough in the
       past that "the county just hasn't recorded it yet" is no longer the
       ordinary explanation (recording lag is weeks; 90 days is generous).
       Inside the lag window this stays `no_data` — a lag painted as a
       contradiction is a false accusation. */
    const holders = [...(recs.currentOwner.grantees || []), ...(recs.currentOwner.people || [])];
    const still = anyOurs(holders, ctx);
    const heldSince = ymd(recs.currentOwner.date);
    // `today` is the injected clock — this module owns none (see the header).
    const exitWellPast = (daysBetween(exit, today) ?? 0) > 90;
    if (still.hit && recs.currentOwner.isCurrent !== false
        && (!heldSince || heldSince <= exit) && exitWellPast) {
      return {
        ...base,
        auto_source: 'elementix',
        auto_verdict: VERDICT.CONTRADICTED,
        auto_confidence: 'likely',
        auto_grade: GRADE.FAIR,
        auto_evidence: {
          why: `The claimed exit is ${exit}, but the county's current-owner record still shows "${still.matched}" holding this property`
            + `${heldSince ? ` (since ${heldSince})` : ''}, with no transfer recorded since.`,
          exitDate: exit, currentOwner: still.matched, heldSince: heldSince || null,
        },
      };
    }
  }

  // A sale: a deed conveying the property OUT of our side, near the exit date.
  const saleFound = isFlip || ground ? findSale(line, recs, ctx, exit) : null;
  if (saleFound && saleFound.verdict) return { ...base, ...saleFound.verdict };

  // A refinance: a new mortgage on a real permanent term, near the refi date.
  const wantsRefi = !isFlip || ground;
  if (wantsRefi) {
    const refi = findRefinance(line, recs, ctx);
    if (refi) return { ...base, ...refi };
  }

  // A lease is not a public record. Say so plainly rather than reporting a
  // failed search a reviewer cannot act on.
  const rent = ymd(line.rent_date);
  if (!isFlip && rent && rent === exit) {
    return {
      ...base,
      auto_source: 'derived',
      auto_verdict: VERDICT.NO_DATA,
      auto_confidence: null,
      auto_grade: GRADE.WEAK,
      auto_evidence: {
        why: `The exit claimed is a lease dated ${rent}. A lease is not recorded anywhere public, so the records can never show it — a signed lease or the rent roll is what settles this one.`,
        exitDate: exit, needsDocument: 'lease_or_rent_roll',
      },
    };
  }

  const sinceExit = daysBetween(exit, today);
  if (sinceExit != null && sinceExit >= 0 && sinceExit <= RECORDING_LAG_DAYS) {
    return {
      ...base,
      auto_source: 'elementix',
      auto_verdict: VERDICT.TOO_RECENT,
      auto_confidence: 'likely',
      auto_grade: GRADE.UNACCEPTABLE,
      auto_evidence: { why: `The exit is only ${sinceExit} days old. Counties normally take a few weeks to publish, so check again in a month.`, exitDate: exit },
    };
  }

  return {
    ...base,
    auto_source: 'elementix',
    auto_verdict: VERDICT.NO_DATA,
    auto_confidence: null,
    auto_grade: GRADE.UNACCEPTABLE,
    auto_evidence: {
      why: recs.searched
        ? `We searched the public records around ${exit} and found nothing recording this exit.`
        : 'The public records have not been searched for this property yet.',
      exitDate: exit, searched: recs.searched,
    },
  };
}

/** A deed conveying the property away from our side, near the claimed exit. */
function findSale(line, recs, ctx, exit) {
  const deeds = forProperty(recs.deeds, line.property_address);
  let best = null;
  for (const d of deeds) {
    const out = anyOurs(d.grantors, ctx);
    if (!out.hit) continue;
    const gap = daysBetween(exit, d.date);
    if (gap == null || Math.abs(gap) > DATE_TOLERANCE_DAYS) continue;
    if (!best || Math.abs(gap) < Math.abs(daysBetween(exit, best.date))) best = d;
  }
  if (!best) return null;

  const buyer = anyOurs(best.grantees, ctx);
  // SOLD TO THEMSELVES IS NOT AN EXIT. The property never left, so the claim
  // that it was sold is contradicted — a different thing from selling to a
  // cousin, which IS a sale and is what `counterparty.js` is for.
  if (buyer.hit) {
    return {
      verdict: {
        auto_source: 'elementix',
        auto_verdict: VERDICT.CONTRADICTED,
        auto_confidence: 'certain',
        auto_grade: gradeOf(best, false),
        auto_evidence: {
          why: `The deed recorded on ${ymd(best.date)} conveys this property from "${anyOurs(best.grantors, ctx).matched}" to "${buyer.matched}" — both the borrower's own side. The property never changed hands, so this is not an exit.`,
          exitDate: exit, recordingDate: ymd(best.date), documentId: best.documentId || null,
          selfDealing: true,
        },
      },
    };
  }

  const relatedParty = best.armsLength === false || best.isNonArmsLengthTransfer === true;
  const signed = signedByBorrower(best, ctx);
  return {
    verdict: {
      auto_source: 'elementix',
      auto_verdict: VERDICT.PROVED,
      auto_confidence: relatedParty ? 'possible' : 'certain',
      auto_grade: gradeOf(best, signed),
      auto_evidence: {
        why: relatedParty
          ? `A deed recorded on ${ymd(best.date)} conveys this property away from the borrower's side, but the record flags it as not arm's length — a person should look at who the buyer is.`
          : `A deed recorded on ${ymd(best.date)} conveys this property away from the borrower's side to an unrelated buyer.`,
        exitDate: exit,
        recordingDate: ymd(best.date),
        documentId: best.documentId || null,
        grantee: asArray(best.grantees)[0] || null,
        consideration: best.amount != null ? best.amount : null,
        armsLengthSale: !relatedParty,
        relatedPartyExit: relatedParty,
        borrowerSignedInstrument: signed,
      },
    },
  };
}

/**
 * A refinance that is a real exit: a NEW mortgage to our side on a permanent
 * term, inside the window the owner widened, and not a mere extension.
 *
 * OWNER-DIRECTED 2026-08-09: the window is 4–20 months ("16 to 20 months,
 * maybe"), and how the property was ACQUIRED is deliberately not a condition —
 * "if you purchase with cash and you refinance, then it's the same good."
 */
function findRefinance(line, recs, ctx) {
  const purchase = ymd(line.purchase_date);
  const claimed = ymd(line.refi_date);
  const mortgages = forProperty(recs.mortgages, line.property_address);

  let best = null;
  for (const m of mortgages) {
    if (m.isExtension === true) continue;
    if (!anyOurs(mortgageHolders(m), ctx).hit) continue;
    const term = Number(m.termMonths);
    if (!Number.isFinite(term) || term < PERM_TERM_MIN_MONTHS) continue;
    if (claimed) {
      const gap = daysBetween(claimed, m.date);
      if (gap == null || Math.abs(gap) > DATE_TOLERANCE_DAYS) continue;
    }
    if (!best || (ymd(m.date) || '') > (ymd(best.date) || '')) best = m;
  }
  if (!best) return null;

  const monthsAfterPurchase = purchase ? monthsBetween(purchase, ymd(best.date)) : null;
  const satisfaction = forProperty(recs.satisfactions, line.property_address)
    .find((s) => !s.mortgageDocumentId || s.mortgageDocumentId !== best.documentId);

  return {
    auto_source: 'elementix',
    auto_verdict: VERDICT.PROVED,
    auto_confidence: 'certain',
    auto_grade: gradeOf(best, signedByBorrower(best, ctx)),
    auto_evidence: {
      why: `A ${best.termMonths}-month mortgage recorded on ${ymd(best.date)} refinanced this property${monthsAfterPurchase != null ? `, ${monthsAfterPurchase} months after the purchase` : ''}.`,
      recordingDate: ymd(best.date),
      documentId: best.documentId || null,
      termMonths: Number(best.termMonths),
      monthsAfterPurchase,
      isExtension: false,
      recordedSatisfaction: !!satisfaction,
    },
  };
}

/* ── the entry point ─────────────────────────────────────────────────────── */

/**
 * Report one observation per pillar.
 *
 * @param {object} line            a `track_records` row
 * @param {object} vendorRecords   {deeds, mortgages, satisfactions, currentOwner, coverage, searched}
 * @param {object} entityContext   {entityNames, borrowerNames, controlVerdict, llcId}
 * @param {string} today           'YYYY-MM-DD' — passed in; this module owns no clock
 * @returns {Array<{pillar,auto_verdict,auto_source,auto_confidence,auto_evidence,auto_grade}>}
 *
 * Never throws. A pillar that cannot be computed reports `no_data` with the
 * reason, because a thrown error in a read-only observer must not take a
 * borrower's whole track record off the screen.
 */
function computeChecks(line, vendorRecords, entityContext, today) {
  const day = ymd(today) || ymd(new Date());
  const row = line && typeof line === 'object' ? line : {};
  const recs = normalizeRecords(vendorRecords);
  const ctx = normalizeContext(row, entityContext);

  const runners = { recency: recencyPillar, ownership: ownershipPillar, exit: exitPillar };
  return PILLARS.map((p) => {
    try {
      const out = runners[p](row, recs, ctx, day);
      return { auto_confidence: null, auto_grade: GRADE.UNACCEPTABLE, auto_source: 'derived', ...out, pillar: p };
    } catch (e) {
      return {
        pillar: p,
        auto_verdict: VERDICT.NO_DATA,
        auto_source: 'derived',
        auto_confidence: null,
        auto_grade: GRADE.UNACCEPTABLE,
        auto_evidence: { why: 'This check could not be run.', error: String((e && e.message) || e).slice(0, 200) },
      };
    }
  });
}

/**
 * The signal bag `scoring.scoreDeal` wants, built from the pillar observations
 * plus the same records. Kept HERE rather than in the ladder so the ladder stays
 * a pure function of named signals and never learns the vendor's shapes.
 */
function signalsFor(checks, vendorRecords, entityContext) {
  const by = {};
  for (const c of asArray(checks)) by[c.pillar] = c;
  const recs = normalizeRecords(vendorRecords);
  const own = (by.ownership && by.ownership.auto_evidence) || {};
  const ex = (by.exit && by.exit.auto_evidence) || {};
  const rec = (by.recency && by.recency.auto_evidence) || {};
  const ec = entityContext || {};

  return {
    granteeIsMatchedEntity: !!(own.checkB && own.checkB.granteeIsMatchedEntity),
    borrowerSignedInstrument: !!((own.checkB && own.checkB.borrowerSignedInstrument) || ex.borrowerSignedInstrument),
    sosListsAsOfficer: ec.sosListsAsOfficer === true,
    vendorLinksEntityToBorrower: ec.vendorLinksEntityToBorrower === true,
    memberOfEntity: ec.controlVerdict === 'confirmed',
    exitInWindow: by.recency ? by.recency.auto_verdict === VERDICT.PROVED : false,
    exitDate: rec.exitDate || null,
    deedCorroboratesExitDate: !!rec.deedCorroboratesExitDate,
    armsLengthSale: ex.armsLengthSale === true,
    relatedPartyExit: ex.relatedPartyExit === true || ex.selfDealing === true,
    recordedSatisfaction: ex.recordedSatisfaction === true,
    refinance: ex.termMonths
      ? { monthsAfterPurchase: ex.monthsAfterPurchase, termMonths: ex.termMonths, isExtension: false }
      : null,
    nameCommonnessScore: Number.isFinite(Number(ec.nameCommonnessScore)) ? Number(ec.nameCommonnessScore) : undefined,
    entityCombinedCoveragePct: recs.coverage && Number.isFinite(Number(recs.coverage.entityCombinedCoveragePct))
      ? Number(recs.coverage.entityCombinedCoveragePct) : undefined,
  };
}

module.exports = {
  computeChecks,
  signalsFor,
  PILLARS,
  VERDICT,
  GRADE,
  RECORDING_LAG_DAYS,
  DATE_TOLERANCE_DAYS,
  PERM_TERM_MIN_MONTHS,
  _internals: { ymd, daysBetween, monthsBetween, whoIsThis, normalizeContext, normalizeRecords, gradeOf },
};
