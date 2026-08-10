'use strict';
/**
 * THE ONE COMPOSER FOR EVERY DRAW EMAIL — the money block, the facts box, and the wording.
 *
 * Owner-directed 2026-08-03, on the draw notifications as they stood: *"right now the email
 * notifications has stupid language — this and this was approved, this and this was requested,
 * this and this is being released … A BIG amount of how much is going to be released, and a
 * smaller amount how much was approved, and a small amount also how much was requested, and a
 * small amount of the difference … the rest remaining from the rehab budget and a box over
 * there … information that is relevant to the draw process. Not just stupid information from
 * the file just laid out."*
 *
 * WHAT WAS WRONG, precisely — every one of these is a thing this module fixes:
 *
 *   1. THE NUMBERS WERE PROSE. "Draw #2 … was approved: $33,450 of $50,000 requested" puts four
 *      different quantities in one sentence at one size, so nothing stands out and the reader has
 *      to parse a sentence to learn the one thing they opened the mail for. The owner's ask is a
 *      HIERARCHY, and the hierarchy is not decorative: the amount that MOVES is the answer to
 *      "what happens to me", and approved / requested / held back are the supporting arithmetic.
 *
 *   2. THE FACTS WERE THE WRONG FACTS. Every draw email carried the file's identity block —
 *      purchase price, ARV, loan amount, program. True, and irrelevant: nobody reading a draw
 *      notice is asking what the property will be worth after the rehab. What they want is the
 *      draw fee, the dates, and how much rehab budget is left. `drawFacts` is that box.
 *
 *   3. THE WORDING DID NOT MATCH THE STAGE. "Approved" was used for the inspector's PROPOSAL and
 *      for our FINAL approval — two different events, one of which is a request to the borrower
 *      to confirm and the other of which means money is moving. `stageCopy` keeps them apart.
 *
 * NON-NEGOTIABLE — THIS MODULE NEVER COMPUTES MONEY. Every figure comes from `approval.drawMoney()`
 * (the ONE source of per-draw money, CLAUDE.md draw rule 13) and every budget figure from the
 * rollup. A second arithmetic path here is exactly how an email ends up quoting a different number
 * from the PDF attached to it — the class the release-headline work closed. This module chooses
 * which of those numbers to show, how big, and in what words. Nothing else.
 *
 * PURE: no DB, no network, no `require` of anything that touches either. Unit-testable, and safe to
 * call from a notification path that must never throw.
 */

const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Whole dollars. A draw email never wants cents — they are noise next to a $33,450 headline. */
function usd(cents) {
  return '$' + Math.round(N(cents) / 100).toLocaleString('en-US');
}

/** A date the way a person says it. Returns null for anything unreadable — never a guess, and
 *  never the epoch, which is what `new Date(null)` quietly produces. */
function day(value) {
  if (!value) return null;
  const s = String(value);
  // A date-only column arrives as 'YYYY-MM-DD' and MUST NOT go through `new Date()` — that
  // reads it as UTC midnight and renders the PREVIOUS day for anybody west of Greenwich.
  // Same rule as lib/dates.js on the front end.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(s);
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * THE MONEY BLOCK — one big number, then the arithmetic behind it, smaller.
 *
 * WHICH number is the big one depends on the STAGE, and getting that wrong is the whole bug:
 *
 *   · Money is moving (final approved / released) → the RELEASE is the headline. It is the number
 *     that lands in a bank account.
 *   · The inspector has proposed and we are asking the borrower to confirm → the APPROVED amount
 *     is the headline. Leading with a release figure there would announce money that nobody has
 *     authorised to move yet, on an email whose entire purpose is to ask permission.
 *   · Nothing is approved yet (drafting / inspecting) → the REQUESTED amount is the headline,
 *     because it is the only figure that exists. Showing a $0 release would be a lie by layout.
 *
 * `secondary` carries the supporting figures in the owner's stated order — approved, requested,
 * then the difference — omitting any that is zero or that would merely repeat the headline. A row
 * reading "Not approved $0" is clutter; worse, it invites a question that has no answer.
 */
function drawFigures(m, { borrower = false } = {}) {
  if (!m) return null;

  const requested = N(m.requested_cents);
  const approved = N(m.approved_cents);
  const net = N(m.net_release_cents);
  const held = N(m.not_approved_cents);
  const moving = !!(m.is_released || m.is_final_approved);
  // The inspector's amounts are what make an "approved" figure meaningful. Without them the
  // draw is still just a request, whatever its status column says.
  //
  // KNOWN vs ZERO (owner-reported 2026-08-10, YSCAP258134746: the inspector approved NOTHING
  // and the borrower's email still led "Requested $24,750 — under review" while its callout
  // promised "$0 is wired to you"). `approved > 0` was standing in for "is the approval
  // KNOWN?" — the repo's documented missing-vs-zero class. An inspector's explicit $0 is an
  // ANSWER, and the doctrine (one amount that keeps updating at every step) says the email
  // must state it: "$0 approved this time", never a stale request presented as the expected
  // amount. Only a genuinely unanswered draw keeps the request as its headline.
  const hasApproval = !!m.has_inspector_amounts;

  const fee = N(m.fee_cents);

  let primary;
  if (moving && net > 0) {
    primary = {
      label: m.is_released ? 'Released to you' : 'To be released',
      value: usd(net),
      // SHOW THE ARITHMETIC, not just a label (owner-reported 2026-08-07 on the approved email:
      // *"This email also needs to have more information: the approved amount, the released
      // amount, the fee."*). With a fee on the draw the approved figure and the release differ,
      // and the secondary row for "Approved" is deliberately suppressed when it would merely
      // repeat the headline — so on a zero-fee draw the two ARE the same number and saying so
      // once is honest. Spelling the subtraction out here covers all three figures in one line
      // whichever way it falls.
      sub: fee > 0
        ? `${usd(approved)} approved − ${usd(fee)} draw fee${borrower ? ' — wired to you' : ''}`
        : (borrower ? 'wired to you' : 'no draw fee on this release'),
    };
  } else if (hasApproval && approved <= 0) {
    // The inspector's explicit $0 — stated as the answer it is. The money is never "lost":
    // it stays on the line and can be drawn once the work is done (the same wording rule the
    // "Held back" row follows), and NOTHING is promised as wiring.
    primary = {
      label: 'Approved on this draw',
      value: usd(0),
      sub: requested > 0
        ? `nothing approved this time — the ${usd(requested)} requested stays on the budget${borrower ? ' and can be drawn once the work is done' : ''}`
        : 'nothing approved this time',
    };
  } else if (hasApproval) {
    primary = {
      label: 'Approved on this draw',
      value: usd(approved),
      // Say what the borrower will actually receive, so the headline is never mistaken for the
      // wire amount — without promoting it to a promise that money is moving.
      sub: net > 0 && net !== approved ? `${usd(net)} would be wired after the draw fee` : null,
    };
  } else {
    primary = { label: 'Requested', value: usd(requested), sub: 'under review' };
  }

  const secondary = [];
  const seen = new Set([primary.value]);
  const push = (label, cents, tone) => {
    const v = usd(cents);
    if (N(cents) <= 0 || seen.has(v)) return;
    seen.add(v);
    secondary.push({ label, value: v, tone: tone || null });
  };
  if (hasApproval) push('Approved', approved, 'positive');
  push('Requested', requested, null);
  // "Not approved" is the owner's "difference". It is never a failure — the money stays on the
  // line and can be drawn again once the work is done — and the label must not imply otherwise.
  if (hasApproval) push(borrower ? 'Not approved this time' : 'Held back', held, 'muted');

  return { primary, secondary };
}

/**
 * THE FACTS BOX — what somebody reading a DRAW notice actually needs.
 *
 * Every row is omitted when its value is unknown. An email that says "Draw fee —" teaches the
 * reader that our numbers are unreliable; saying nothing costs nothing.
 *
 * `rollup.project` is the whole-project budget picture. AVAILABLE (not `remaining`) is the honest
 * figure to show a human: it counts a draw in flight as spoken for, which is the owner's own rule
 * ("treat a draw that is not fully approved as if it is approved"). Showing `remaining` here would
 * tell a borrower they can still draw money that this very email is about.
 */
function drawFacts({ money = null, rollup = null, draw = null, dates = {}, borrower = false } = {}) {
  const rows = [];
  const add = (label, value) => { if (value != null && value !== '') rows.push({ label, value }); };

  if (money && N(money.fee_cents) > 0) {
    add(money.fee_projected ? 'Draw processing fee (standard for this file)' : 'Draw processing fee',
      usd(money.fee_cents));
  }
  if (money && N(money.retainage_held_cents) > 0) add('Held as retainage', usd(money.retainage_held_cents));

  // These are DATES, and their labels must say so. "Approved" alone sat directly under the
  // "Approved $33,450" figure and read as a second, contradictory value for the same word.
  add('Inspection completed', day(dates.inspected_at));
  add('Approved on', day(dates.approved_at));
  add(dates.released_at ? 'Funds released on' : 'Expected release', day(dates.released_at || dates.wire_due_at));

  // THE WHOLE-PROJECT PICTURE, in the order somebody actually asks the questions (owner-directed
  // 2026-08-07): what is the construction budget · how much has been drawn already · how much
  // counting this draw · how much is left after it. Every figure comes off the rollup — none is
  // computed here.
  const p = rollup && rollup.project;
  if (p && N(p.budget) > 0) {
    add('Rehab budget', usd(p.budget));
    // "Drawn so far" is RELEASED money only — the figure the borrower can reconcile against their
    // own bank statements. `committed` is that plus everything in flight, which is the number the
    // owner asked for ("how much was drawn already, INCLUDING this amount"). The two are shown as
    // separate rows because they answer different questions, and the second is omitted when the
    // draw is already released and they are the same number.
    add('Drawn so far', usd(p.drawn));
    if (N(p.committed) !== N(p.drawn)) {
      add(borrower ? 'Drawn including this draw' : 'Drawn including draws in flight', usd(p.committed));
    }
    // "(this draw counted)" is a CLAIM about the math, not decoration (owner-reported
    // 2026-08-10: a staff email printed "Still available (this draw counted) $91,300" — the
    // FULL budget — while the same email's headline said $24,750 was requested; the draw's
    // line detail had not mirrored, so `committed` genuinely excluded it and the label
    // asserted the opposite of what the figure showed). The claim is only made when the
    // headline draw's money actually landed in the committed figure; otherwise the label
    // stays plain and a heads-up row says the detail has not synced yet.
    const headlineCounted = !money || !!money.is_released || (N(p.committed) - N(p.drawn)) > 0;
    add(borrower ? 'Still available to draw' : (headlineCounted ? 'Still available (this draw counted)' : 'Still available'), usd(p.available));
    if (!headlineCounted && money && N(money.requested_cents) > 0) {
      add('Heads up', `the ${usd(N(money.requested_cents))} on this draw isn’t counted in the figures above yet — its line detail hasn’t synced`);
    }
  }

  // The meter measures COMMITTED against the budget — this draw included, which is exactly what
  // the owner asked for ("the construction budget used percentage should be the percentage of
  // this draw as well, included already"). The label says so, so nobody reads it as released-only.
  const progress = p && N(p.budget) > 0
    ? {
      done: Math.max(0, Math.min(N(p.budget), N(p.committed))),
      total: N(p.budget),
      label: 'Construction budget used (this draw included)',
    }
    : null;

  if (draw && draw.number != null) rows.unshift({ label: 'Draw', value: `#${draw.number}` });

  return { rows, progress };
}

/**
 * STAGE-ACCURATE WORDING. The owner listed the vocabulary they want by stage: *"inspector
 * reviewed, inspector approved, amount as the inspector approved, please confirm this amount …
 * and everything was approved afterwards: draw final approved, wire being released."*
 *
 * The two that MUST never be conflated are `inspector_approved` (a proposal — we are asking) and
 * `final_approved` (a decision — money is moving). The old copy called both "approved", which is
 * how a borrower came to read a request-to-confirm as a done deal.
 *
 * The borrower voice never names the capital-partner step (the frozen borrower-safe rule), which
 * is why `with_investor` reads as an ordinary review rather than naming who is reviewing.
 */
const STAGE_COPY = {
  inspecting: {
    staff: { title: 'Inspection under way', badge: 'Inspecting', tone: 'gold' },
    borrower: { title: 'Your inspection is under way', badge: 'Inspecting', tone: 'gold' },
  },
  inspector_approved: {
    staff: { title: 'Inspector approved — awaiting our final approval', badge: 'Inspector approved', tone: 'gold' },
    borrower: { title: 'Your inspection is complete — please confirm the amount', badge: 'Please confirm', tone: 'action' },
  },
  borrower_review: {
    staff: { title: 'With the borrower to confirm', badge: 'With borrower', tone: 'gold' },
    borrower: { title: 'Please review and confirm your draw amount', badge: 'Please confirm', tone: 'action' },
  },
  borrower_disputed: {
    staff: { title: 'Borrower pushed back on a line', badge: 'Disputed', tone: 'action' },
    borrower: { title: 'We received your pushback', badge: 'Under review', tone: 'gold' },
  },
  borrower_accepted: {
    staff: { title: 'Borrower confirmed — awaiting our final approval', badge: 'Confirmed', tone: 'positive' },
    borrower: { title: 'Thanks — your draw is with us for final approval', badge: 'Confirmed', tone: 'positive' },
  },
  with_investor: {
    staff: { title: 'With the capital partner', badge: 'With partner', tone: 'gold' },
    borrower: { title: 'Your draw is under final review', badge: 'Under review', tone: 'gold' },
  },
  final_approved: {
    staff: { title: 'Draw final approved — wire being released', badge: 'Final approved', tone: 'positive' },
    borrower: { title: 'Your draw is approved — funds are on the way', badge: 'Approved', tone: 'positive' },
  },
  released: {
    staff: { title: 'Draw released', badge: 'Released', tone: 'positive' },
    borrower: { title: 'Your draw has been released', badge: 'Released', tone: 'positive' },
  },
};

function stageCopy(stage, { borrower = false } = {}) {
  const row = STAGE_COPY[String(stage || '')];
  if (!row) return null;
  return row[borrower ? 'borrower' : 'staff'] || null;
}

module.exports = { drawFigures, drawFacts, stageCopy, usd, day, STAGE_COPY };
