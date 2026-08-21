'use strict';
/**
 * CAN THIS PACKAGE BE NUDGED, AND IF NOT, WHAT DO I DO INSTEAD?
 *
 * Owner-reported 2026-08-21: "Make sure the Resend Draw form works if the borrower
 * hasn't seen it for a long time or the form has expired. The Resend button
 * actually works by the Draw section."
 *
 * WHAT ACTUALLY HAPPENS. A resend re-notifies the SAME DocuSign envelope; it never
 * creates a new one. But an envelope does not live for ever -- DocuSign expires one
 * that has sat unsigned (120 days on a default account) and VOIDS it. So the exact
 * case the owner describes -- a borrower who never opened it for months -- is the
 * case where the envelope is gone and a resend is impossible by construction.
 *
 * The old refusal said `envelope already voided`. That is TRUE and it is a DEAD END:
 * it names a state, not an action, and the person reading it is the one who could fix
 * it in one click. This module is the one place that turns the state into the action,
 * so the draw section, the term-sheet section and any future package all say the same
 * thing about the same situation.
 *
 * TWO CALLERS, ONE ANSWER. The route asks BEFORE the wire (`resendProblem`) and again
 * if DocuSign itself refuses (`docusignRefusal`) -- because our stored status can lag
 * reality: the envelope may have expired on their side while our row still reads
 * 'sent' and no webhook has landed. Both paths must produce the same sentence and the
 * same machine-readable `code`, or the screen would offer the way forward in one case
 * and a "server error" in the other.
 *
 * PURE. No database, no network, never throws.
 */

/* A package that is no longer out for signature cannot be re-notified. */
const TERMINAL = new Set(['completed', 'declined', 'voided']);

/* What a person calls each package, and what "start again" means for it. The draw
   form has a one-click re-issue on its own section; the others go through void +
   re-issue on the e-sign panel. Wording lives HERE so the two doors can never
   describe the same situation differently. */
const PACKAGE = {
  draw_request: {
    what: 'draw request form',
    // The Draws section owns a "send a fresh one" button, so name that.
    fix: 'Send a fresh draw form — it goes out as a brand-new form the borrower can sign.',
    reissue: 'draw_request',
  },
  term_sheet_package: {
    what: 'term sheet package',
    fix: 'Clear the package on the e-sign panel and issue a new one.',
    reissue: null,
  },
  heter_iska: {
    what: 'Heter Iska',
    fix: 'Void it on the e-sign panel and issue a new one.',
    reissue: null,
  },
  noo_affidavit: {
    what: 'non-owner-occupied certification',
    fix: 'Void it on the e-sign panel and issue a new one.',
    reissue: null,
  },
};
const packageOf = (purpose) => PACKAGE[String(purpose || '')] || { what: 'package', fix: 'Void it on the e-sign panel and issue a new one.', reissue: null };

/** Plain-language reason a terminal envelope is terminal. */
function terminalReason(status, what) {
  if (status === 'completed') return `This ${what} has already been signed, so there is nothing to remind anyone about.`;
  if (status === 'declined') return `The signer declined this ${what}, so it can’t be re-sent.`;
  // 'voided' is the expiry case as well: DocuSign voids an envelope that has sat
  // unsigned past the account's expiry window, which is exactly "they never looked
  // at it for a long time".
  return `This ${what} is no longer live — it was voided, or it expired because it sat unsigned too long. A reminder can’t revive it.`;
}

/**
 * Is this envelope row nudge-able?
 * @param {object} row  esign_envelopes row: { status, envelope_id, purpose }
 * @returns {null | {status:number, code:string, error:string, reissue:string|null}}
 *   null when a resend may proceed; otherwise the refusal, ALWAYS naming the way through.
 */
function resendProblem(row) {
  const r = row || {};
  const meta = packageOf(r.purpose);
  if (!r.envelope_id) {
    return {
      status: 409, code: 'not_sent', reissue: meta.reissue,
      error: `This ${meta.what} hasn’t gone out yet, so there is nothing to resend. Send it first.`,
    };
  }
  const st = String(r.status || '').toLowerCase();
  if (TERMINAL.has(st)) {
    return {
      status: 409,
      // ONE code for every "it is over" state, so a screen has one branch to write.
      // The `status` field below says which one it actually was.
      code: 'envelope_not_live', envelopeStatus: st, reissue: meta.reissue,
      error: `${terminalReason(st, meta.what)}${st === 'completed' ? '' : ` ${meta.fix}`}`,
    };
  }
  return null;
}

/* DocuSign's own words for "this envelope is not in a state you can resend".
   Matched on MEANING rather than an exact string, because their message text is
   theirs to change; the codes are the stable half and are listed first. */
const NOT_LIVE_RE = /(ENVELOPE_(?:CANNOT_BE_MODIFIED|IS_)?(?:VOIDED|COMPLETED|DECLINED|EXPIRED)|INVALID_ENVELOPE_STATUS|ENVELOPE_NOT_IN_SENT_STATE|is not in a state|has been voided|has expired|already (?:completed|voided|declined))/i;

/**
 * DocuSign refused the resend. Was it because the envelope is no longer live?
 *
 * This is the half that catches the case our own row cannot: an envelope that
 * expired on DocuSign's side while no webhook has yet told us. Without it that path
 * answers "server error", which is the least useful thing a person can be told about
 * a form they were trying to nudge.
 *
 * @returns the same shape as `resendProblem`, or null when the failure was something
 *   else (a network blip, an outage) and should be reported as the transient it is.
 */
function docusignRefusal(err, row) {
  if (!err) return null;
  const meta = packageOf(row && row.purpose);
  const text = `${(err && err.errorCode) || ''} ${(err && err.message) || ''} ${(err && err.body) || ''}`;
  if (!NOT_LIVE_RE.test(text)) return null;
  return {
    status: 409, code: 'envelope_not_live', envelopeStatus: 'voided', reissue: meta.reissue,
    error: `The signing service says this ${meta.what} is no longer live — it was voided, or it expired because it sat unsigned too long. ${meta.fix}`,
  };
}

/**
 * How stale is a package that IS still live? Used to warn before a nudge that is
 * very likely to be pointless, and to explain a nudge that produced nothing.
 * Calendar days, tz-safe, and null rather than a guess when the date is unreadable.
 */
function daysSinceSent(sentAt, now) {
  if (!sentAt) return null;
  const t = sentAt instanceof Date ? sentAt.getTime() : Date.parse(sentAt);
  if (!Number.isFinite(t)) return null;
  const ms = (now ? (now instanceof Date ? now.getTime() : Date.parse(now)) : Date.now()) - t;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86400000);
}

/* DocuSign's default expiry. Only ever used to WARN — never to refuse, because the
   account's real window is theirs to set and refusing on our guess would block a
   nudge that would have worked. */
const DEFAULT_EXPIRY_DAYS = 120;

/**
 * A heads-up for a live-but-old package. Returns null when there is nothing to say.
 * Deliberately advisory: the resend still goes out.
 */
function staleNotice(row, now) {
  const days = daysSinceSent(row && (row.sent_at || row.created_at), now);
  if (days == null || days < 30) return null;
  const meta = packageOf(row && row.purpose);
  if (days >= DEFAULT_EXPIRY_DAYS) {
    return `This ${meta.what} went out ${days} days ago. DocuSign usually expires one after about ${DEFAULT_EXPIRY_DAYS} days, so if the reminder doesn’t reach them, send a fresh form instead.`;
  }
  return `This ${meta.what} went out ${days} days ago and still isn’t signed.`;
}

module.exports = {
  resendProblem, docusignRefusal, staleNotice, daysSinceSent,
  DEFAULT_EXPIRY_DAYS,
  _internal: { PACKAGE, TERMINAL, NOT_LIVE_RE, packageOf, terminalReason },
};
