'use strict';
/**
 * WHICH BUTTON DO I PRESS? — the one next step for a pillar, as data.
 *
 * PURE. No database, no network, no clock. Modelled on
 * `app-v2/src/lib/condition-actions.js`, whose header diagnoses the problem
 * this solves: *"the problem is never the number of buttons, it is a flat list
 * with no hierarchy."* A reviewer facing Confirm / Reject / Ask for a document
 * three times per property, six properties deep, is not helped by three equal
 * buttons — they are helped by one primary and a sentence saying what happens.
 *
 * ── CONFIRM IS PRIMARY ONLY WHEN THE MACHINE ALREADY PROVED IT ─────────────
 * Everywhere else the primary step is **Ask for a document**. That is the whole
 * hierarchy, and it is a safety property rather than a style choice: a reviewer
 * working at speed presses the primary button, so the primary button must never
 * be the one that CREDITS a borrower on evidence nobody has. When the records
 * proved it, confirming is the cheap correct move; when they did not, the
 * correct move is to ask, and the screen should make asking the easy one.
 *
 * ── `no_data` IS NEUTRAL, AND THE COPY SAYS WHOSE LIMITATION IT IS ─────────
 * "No data" is not a failure and not a pass. Presented as a red X it reads to a
 * reviewer — and, through them, to a borrower — as *"we could not verify you"*,
 * when the truth is usually *"that county does not publish deeds online"*. Every
 * neutral state here says so in words.
 *
 * ── THE HINT MUST TELL THE TRUTH ABOUT WHAT THE SERVER WILL DO ────────────
 * A button that promises something the server refuses is worse than no hint at
 * all (condition-actions.js learned this the expensive way). So the hints below
 * describe the ACTUAL server rules: who may confirm, and that a bulk confirm
 * refuses a line carrying a contradicted or unanswered pillar.
 *
 * ── WHO MAY DO WHAT, AND WHY THE ASYMMETRY IS DELIBERATE ──────────────────
 * CONFIRM needs `sign_off_conditions`. REJECT and "needs a document" do not.
 * That is not an oversight: confirming a pillar is the substantive judgement
 * that lets a deal count toward the experience tier, which prices the loan —
 * an action that can only ADD credit. Rejecting or asking for a document can
 * only WITHHOLD it, and anyone working the file should be able to do that the
 * moment they notice something, without waiting for someone with authority.
 */

/** db/494's own spelling. */
const PILLARS = ['recency', 'ownership', 'exit'];
const HUMAN_VERDICTS = ['confirmed', 'rejected', 'needs_doc'];
const AUTO_VERDICTS = ['proved', 'contradicted', 'no_data', 'too_recent'];

/** The question each pillar asks, in the words a reviewer would use. */
const PILLAR_CLAIM = {
  recency: 'The project finished within the last 3 years',
  ownership: 'The borrower owned this property',
  exit: 'The project really was sold, rented or refinanced',
};

/** What the machine's answer MEANS, per pillar. `no_data` and `too_recent` are
 *  the two that must never read as a failure. */
const AUTO_MEANING = {
  proved: {
    recency: 'The records show it finished inside the window.',
    ownership: 'The records show the borrower, or their company, as the buyer on the deed.',
    exit: 'The records show the property leaving their hands.',
  },
  contradicted: {
    recency: 'The finish date is outside the 3-year window, so this project counts toward nothing.',
    ownership: 'The records name somebody else — or a reviewer decided the borrower does not control the company that held it.',
    exit: 'The records disagree with the exit that was claimed.',
  },
  no_data: {
    recency: 'There is no finished exit on this project yet.',
    ownership: 'Nothing was found in the public records for this property. That is a gap in the records, not a problem with the borrower.',
    exit: 'Nothing recording this exit was found. Some counties do not publish, and a lease is never public at all — that is a gap in the records, not a problem with the borrower.',
  },
  too_recent: {
    recency: 'The date given is in the future, so the project has not finished yet.',
    ownership: 'This is very recent. Counties normally take a few weeks to publish, so nothing found yet proves nothing — check again in a month.',
    exit: 'This is very recent. Counties normally take a few weeks to publish, so nothing found yet proves nothing — check again in a month.',
  },
};

/** Whether the machine's answer is GOOD, BAD or simply not an answer. Drives
 *  the icon and the border colour, and keeps neutral genuinely neutral. */
const AUTO_TONE = { proved: 'good', contradicted: 'bad', no_data: 'neutral', too_recent: 'neutral' };

const canSignOff = (role, can) => {
  if (typeof can === 'boolean') return can;
  return role === 'processor' || role === 'underwriter' || role === 'admin' || role === 'super_admin';
};

const str = (v) => String(v == null ? '' : v).trim();

/**
 * THE LADDER — the ONE next step for this pillar and this viewer.
 *
 * @param {object} p        a `track_record_pillars` row
 * @param {object} opts
 * @param {string} opts.role
 * @param {boolean} [opts.canSignOff]      overrides the role check
 * @param {boolean} [opts.hasOpenRequest]  a document has already been asked for
 * @returns {{key,label,tone,title,hint,verdict}}
 *
 * `tone` is 'primary' for the step that moves this forward, 'ghost' for an undo
 * or a step that is merely available. `verdict` is what to POST, or null when
 * the step is not a verdict (asking for a document is its own action).
 */
function pillarNextStep(p, opts = {}) {
  const pil = PILLARS.includes(p && p.pillar) ? p.pillar : 'ownership';
  const human = HUMAN_VERDICTS.includes(p && p.human_verdict) ? p.human_verdict : null;
  const auto = AUTO_VERDICTS.includes(p && p.auto_verdict) ? p.auto_verdict : null;
  const signer = canSignOff(opts.role, opts.canSignOff);
  const asked = !!opts.hasOpenRequest;

  // Already answered by a person. The only move left is to take it back, and
  // only somebody with the authority to have made it may.
  if (human) {
    if (!signer && human === 'confirmed') {
      return {
        key: 'confirmed_locked', label: 'Confirmed', tone: 'ghost', verdict: null,
        title: 'Somebody with sign-off confirmed this',
        hint: 'This was confirmed by someone with sign-off. Only they can take it back.',
      };
    }
    return {
      key: 'undo', label: 'Undo', tone: 'ghost', verdict: null,
      title: 'Put this check back to unanswered',
      hint: human === 'confirmed'
        ? 'You confirmed this. Undo puts it back to unanswered and takes the project out of the count until somebody answers again.'
        : human === 'rejected'
          ? 'You rejected this. Undo puts it back to unanswered.'
          : 'You asked for a document. Undo puts this back to unanswered.',
    };
  }

  // THE MACHINE PROVED IT — the one case where Confirm leads.
  if (auto === 'proved') {
    if (!signer) {
      return {
        key: 'needs_signoff', label: 'Ask for a document', tone: 'ghost', verdict: 'needs_doc',
        title: 'Only someone with sign-off can confirm a check',
        hint: 'The records already prove this. Confirming it is a sign-off step, so someone with sign-off finishes it — you can still ask for a document if something looks wrong.',
      };
    }
    return {
      key: 'confirm', label: 'Confirm', tone: 'primary', verdict: 'confirmed',
      title: 'Agree with what the records show',
      hint: 'The records prove this one. Confirming it is what lets this project count once all three checks are answered.',
    };
  }

  // EVERYWHERE ELSE, ASKING LEADS. Including a contradiction — a disagreement
  // belongs in front of the borrower, not quietly written off.
  if (asked) {
    return {
      key: 'awaiting_doc', label: 'Waiting on the borrower', tone: 'ghost', verdict: null,
      title: 'A document has already been asked for',
      hint: 'A document was already requested for this check. It will come back on the conditions list — nothing else is needed here until it does.',
    };
  }

  const meaning = (AUTO_MEANING[auto] && AUTO_MEANING[auto][pil]) || null;
  return {
    key: 'ask_doc', label: 'Ask for a document', tone: 'primary', verdict: null,
    title: 'Ask the borrower for something that settles this',
    hint: auto === 'contradicted'
      ? 'The records disagree with what was entered. Ask for the document that settles it before deciding — rejecting outright takes the project out of the count.'
      : auto === 'too_recent'
        ? 'This is too recent for the records to show anything yet. Ask for the document, or come back in a month.'
        : meaning && auto === 'no_data'
          ? 'Nothing was found in the records, which proves nothing either way. A document from the borrower is what settles this.'
          : 'Nothing has been checked yet. Asking for the document is the fastest way to settle it.',
  };
}

/**
 * The other two moves, offered as secondary. Kept here rather than in the
 * screen so "what may this viewer do" has ONE answer that the route can also
 * read — a button the server refuses is the failure this file exists to avoid.
 */
function pillarOtherSteps(p, opts = {}) {
  const next = pillarNextStep(p, opts);
  const signer = canSignOff(opts.role, opts.canSignOff);
  const human = HUMAN_VERDICTS.includes(p && p.human_verdict) ? p.human_verdict : null;
  if (human) return [];

  const out = [];
  if (next.key !== 'confirm' && signer) {
    out.push({
      key: 'confirm', label: 'Confirm', tone: 'ghost', verdict: 'confirmed',
      title: 'Confirm this check anyway',
      hint: 'Only do this if you have seen something outside PILOT that settles it — say what in the note.',
    });
  }
  out.push({
    key: 'reject', label: 'Reject', tone: 'ghost', verdict: 'rejected',
    title: 'This check cannot be met',
    hint: 'Rejecting takes this project out of the experience count. Say why in the note — a reviewer months from now has to be able to see it.',
  });
  if (next.key !== 'ask_doc' && next.key !== 'awaiting_doc') {
    out.push({
      key: 'ask_doc', label: 'Ask for a document', tone: 'ghost', verdict: null,
      title: 'Ask the borrower for something that settles this',
      hint: 'Posts a real condition on the file, and the borrower is told what to send.',
    });
  }
  return out;
}

/**
 * The evidence card, in the four parts §8.1 requires every time:
 * the claim → the source with its confidence and date → the VERBATIM snippet →
 * the actions.
 *
 * THE SNIPPET IS MANDATORY. A card that says only "verified by Elementix" asks
 * a reviewer to trust a vendor name, which is not review — it is rubber-
 * stamping. When there is genuinely nothing to quote, this says so plainly
 * rather than dressing an absence up as evidence.
 */
function evidenceCard(p, opts = {}) {
  const pil = PILLARS.includes(p && p.pillar) ? p.pillar : 'ownership';
  const auto = AUTO_VERDICTS.includes(p && p.auto_verdict) ? p.auto_verdict : null;
  const ev = (p && p.auto_evidence) || {};
  const human = HUMAN_VERDICTS.includes(p && p.human_verdict) ? p.human_verdict : null;

  const snippet = str(ev.snippet) || str(ev.why) || '';
  const source = str(p && p.auto_source);
  const when = str(ev.recordingDate) || str(ev.exitDate) || str(p && p.auto_checked_at).slice(0, 10);

  return {
    /* The ROW id, not the pillar name — this is what a decision is posted to,
       and leaving the screen to find it separately is how a screen ends up
       posting to the wrong one. */
    pillarId: (p && p.id) || null,
    pillar: pil,
    claim: PILLAR_CLAIM[pil],
    answered: !!human,
    humanVerdict: human,
    autoVerdict: auto,
    tone: human === 'confirmed' ? 'good' : human === 'rejected' ? 'bad' : (AUTO_TONE[auto] || 'unknown'),
    /* NEUTRAL IS NOT FAILURE — the flag the screen keys its icon and colour on,
       so "nothing found" can never be painted the same as "contradicted". */
    neutral: auto === 'no_data' || auto === 'too_recent',
    meaning: (AUTO_MEANING[auto] && AUTO_MEANING[auto][pil]) || 'This has not been checked yet.',
    source: source || null,
    confidence: str(p && p.auto_confidence) || null,
    grade: str(p && p.auto_grade) || null,
    when: when || null,
    snippet: snippet || null,
    /* Said out loud when there is nothing to quote, so an empty card can never
       be mistaken for a checked one. */
    snippetNote: snippet ? null : 'Nothing was quoted here — so there is nothing yet for a reviewer to read.',
    carriedFromEntity: !!(p && p.satisfied_by_llc_id),
    satisfiedByLlcId: (p && p.satisfied_by_llc_id) || null,
    next: pillarNextStep(p, opts),
    other: pillarOtherSteps(p, opts),
  };
}

/**
 * MAY A BULK "CONFIRM EVERYTHING THE MACHINE PROVED" TOUCH THIS LINE?
 *
 * The blueprint is explicit that the SERVER must refuse this, not just the
 * screen — so this is exported as a pure rule the route enforces and the screen
 * merely displays, and the DB test asserts the route refuses even when the
 * screen is bypassed entirely.
 *
 * A line is eligible only when EVERY pillar is machine-proved and unanswered.
 * One contradiction or one unchecked pillar and the whole line goes to a human,
 * because bulk is for the boring case and this is not it.
 *
 * @returns {{ok:boolean, reason:string|null, pillars:string[]}}
 */
function bulkConfirmRefusal(pillars) {
  const list = Array.isArray(pillars) ? pillars : [];
  if (list.length < PILLARS.length) {
    return { ok: false, reason: 'This project does not have all three checks yet.', pillars: [] };
  }
  const bad = list.filter((p) => p.auto_verdict === 'contradicted');
  if (bad.length) {
    return {
      ok: false,
      reason: `The records disagree on ${bad.length === 1 ? 'one check' : `${bad.length} checks`} here (${bad.map((p) => p.pillar).join(', ')}). Open the project and read it.`,
      pillars: bad.map((p) => p.pillar),
    };
  }
  const unproved = list.filter((p) => p.auto_verdict !== 'proved');
  if (unproved.length) {
    return {
      ok: false,
      reason: `${unproved.length === 1 ? 'One check has' : `${unproved.length} checks have`} nothing proving them (${unproved.map((p) => p.pillar).join(', ')}). Bulk confirm only covers checks the records already proved.`,
      pillars: unproved.map((p) => p.pillar),
    };
  }
  const already = list.filter((p) => p.human_verdict);
  if (already.length === list.length) {
    return { ok: false, reason: 'Somebody has already answered every check on this project.', pillars: [] };
  }
  return { ok: true, reason: null, pillars: list.filter((p) => !p.human_verdict).map((p) => p.pillar) };
}

/** What still stands between this line and being verifiable, in one sentence. */
function lineReadiness(pillars) {
  const list = Array.isArray(pillars) ? pillars : [];
  const answered = list.filter((p) => p.human_verdict);
  const confirmed = list.filter((p) => p.human_verdict === 'confirmed');
  const rejected = list.filter((p) => p.human_verdict === 'rejected');
  if (rejected.length) {
    return { ready: false, answered: answered.length, of: PILLARS.length,
      message: `Rejected on ${rejected.map((p) => p.pillar).join(', ')} — this project cannot count.` };
  }
  if (confirmed.length === PILLARS.length) {
    return { ready: true, answered: answered.length, of: PILLARS.length,
      message: 'All three checks are confirmed — this project can be verified.' };
  }
  const left = PILLARS.filter((n) => !list.some((p) => p.pillar === n && p.human_verdict === 'confirmed'));
  return { ready: false, answered: answered.length, of: PILLARS.length,
    message: `Still waiting on ${left.join(', ')}. All three have to be confirmed before this project can be verified.` };
}

module.exports = {
  pillarNextStep,
  pillarOtherSteps,
  evidenceCard,
  bulkConfirmRefusal,
  lineReadiness,
  PILLARS,
  HUMAN_VERDICTS,
  AUTO_VERDICTS,
  PILLAR_CLAIM,
  AUTO_MEANING,
  AUTO_TONE,
  _internals: { canSignOff },
};
