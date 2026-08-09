'use strict';
/**
 * WHAT THE PERSON AT THE APPRAISAL DESK IS TOLD WHEN A SEND FAILS — one definition,
 * both vendors.
 *
 * This started as four byte-identical copies pasted into four modules, in a change whose
 * dominant failure mode across ten audit passes has been *a fix applied to one of two
 * sibling paths*. The Class side already showed how that ends: the same sentence written
 * out four times by hand, and one of the four saying "nothing was sent" on a screen whose
 * button says "Check for replies".
 *
 * THE RULE THESE ENCODE:
 *  • The exception's own text never reaches a screen. "AMC CreateAppraisal -> 502",
 *    "AMC_DISABLED: …", "connect ECONNREFUSED 10.0.0.4:443", a Postgres code — all of it
 *    is written for us, and a non-developer reading it learns nothing and can act on
 *    nothing. It goes to the journal and the log, which every caller already writes.
 *  • The states a person CAN act on are told apart, because the right next step differs:
 *    a switch that is off will never fix itself by retrying, and an unreachable vendor
 *    usually will.
 *  • The VERB matches what they asked for. Telling somebody "nothing was sent" when they
 *    pressed a button that only reads is its own small lie.
 */

// `subject` is the thing, as a capitalised noun phrase — "The order", "The documents",
// "Your message". THE SENTENCE PUTS IT FIRST on purpose: the obvious shape,
// `so ${what} was not sent`, forces a verb to agree with a subject the caller chose, and
// it produced "so the documents was not sent" and "so the replies was not fetched" the
// moment a plural was passed. Leading with the subject sidesteps agreement entirely.
function sendFailMessage(e, subject, opts = {}) {
  const verb = opts.reading ? 'could not be fetched' : 'could not be sent';
  const code = e && e.code ? String(e.code) : '';
  // Both vendors' clients raise a distinct code when a SWITCH is off rather than when
  // the vendor is unreachable — the AMC master switch (AMC_DISABLED), its write gate
  // (AMC_OUTBOUND_DISABLED), and the Class equivalents. The two need different next
  // steps: retrying will never turn a switch on.
  if (/_DISABLED$/.test(code) || code === 'disabled') {
    const which = /OUTBOUND/.test(code)
      ? 'sending to the appraisal company is switched off'
      : 'the appraisal company connection is switched off';
    return `${subject} ${verb} — ${which}.`;
  }
  return `${subject} ${verb} — the appraisal company could not be reached. `
    + 'Please try again in a moment.';
}

/**
 * THE VENDOR'S OWN REFUSAL IS WORTH SHOWING — "Loan number already exists" tells the
 * person exactly what to do, unlike a transport error. But it is THEIR text, so it is
 * bounded and framed rather than pasted, and a bare numeric code (which says nothing to
 * anybody) is replaced by plain words.
 */
function nackMessage(err, what) {
  const d = err && err.description != null ? String(err.description).trim() : '';
  if (!d) return `The appraisal company would not accept ${what}.`;
  return `The appraisal company would not accept ${what}: ${d.slice(0, 300)}`;
}

/**
 * WHAT GETS WRITTEN ONTO THE ROW when a send fails — and it is not the same job as
 * `sendFailMessage`, which answers the person who just pressed the button.
 *
 * A stored note is PERMANENT and is read later, by somebody who was not there. Both
 * desks were storing `String(e.message)` — "Class addNote failed: HTTP 502",
 * "connect ECONNREFUSED 10.0.0.4:443" — into a column, which put the exception's own
 * text one render away from the screen forever. So the interpreting happens HERE, once,
 * at the moment of writing, where the exception still is; the column then holds a
 * sentence, and a panel showing it needs no rule of its own.
 *
 * THE THREE STATES ARE CHOSEN BY WHAT THE READER SHOULD DO NEXT, which is the only
 * thing the distinction is for:
 *   • a switch of ours is off — retrying forever will not turn it on;
 *   • they ANSWERED and refused — sending the identical thing again cannot work, so
 *     saying "it will be retried" sends somebody to wait for a thing that never happens;
 *   • anything else — it did not get there, and trying again is exactly right.
 * Nothing here ever claims an automatic retry. Nothing retries these rows: a person
 * presses the button again, and the note says so.
 */
const TEST_MODE_PREFIX = 'TEST MODE — ';

// Codes raised by OUR OWN pre-flight checks, before anything is sent. Lower-case by
// convention here, which is what tells them apart from the transports' SHOUTY gate codes
// — but the list is explicit as well, because a convention is not a guarantee.
const LOCAL_REFUSAL = new Set(['class_version_unknown']);

function storedFailNote(e) {
  const code = e && e.code ? String(e.code) : '';
  if (/_NOT_CONFIGURED$/.test(code)) {
    return 'Not sent — the appraisal company connection is not set up yet.';
  }
  if (/_DISABLED$/.test(code) || code === 'disabled') {
    return /OUTBOUND/.test(code)
      ? 'Not sent — sending to the appraisal company is switched off. Switch it on, then send it again.'
      : 'Not sent — the appraisal company connection is switched off. Switch it on, then send it again.';
  }
  // WE NEVER GOT AS FAR AS SENDING IT. Our own pre-flight guards throw before a request
  // is made — an order whose form version we cannot resolve — and reporting that as
  // "could not be reached, you can send it again" is false twice over.
  //
  // THE SHAPE OF A CODE IS NOT EVIDENCE, and inferring from it was wrong in both
  // directions. `!/^[A-Z0-9_]+$/` was meant to mean "ours, not a SHOUTY gate code", but
  // the class includes digits, so every Postgres SQLSTATE (`23505`, `22P02`, `57014`)
  // slipped past it and was reported as the appraisal company being unreachable — on a
  // path where the message HAD been delivered and only our own write of the receipt
  // failed, so "you can send it again" would duplicate it at the vendor. In the other
  // direction a vendor NACK code like `-100` was claimed as our own problem. The list is
  // explicit now, and anything unrecognised is described without blaming either end.
  const status = Number(e && e.status);
  if (LOCAL_REFUSAL.has(code)) {
    return 'Not sent — something on our side stopped this before it went out. '
      + 'Sending it again will not help until it is looked at.';
  }
  // THEIR END TURNED OUR LOGIN AWAY — a different person fixes a credential from a
  // rejected document, so the two must not read alike.
  //
  // 401 ONLY, NOT 403. `status` is the status of the BUSINESS call, not of the token
  // call, so a 403 is the vendor answering "not allowed" about the thing we sent — a
  // closed order, a product our org may not add a form to. Reading it as a credential
  // problem sends somebody to rotate a perfectly good secret and hides the fact that
  // they answered at all; it falls through to the refusal branch below, where it belongs.
  if (/_REJECTED$/.test(code) || status === 401) {
    return 'Not sent — the appraisal company did not accept our login. '
      + 'The connection needs to be checked before this can go.';
  }
  // THEY ANSWERED AND SAID NO. `retryable` is what the transport sets for exactly this
  // question, on BOTH desks, so it is read rather than re-derived — and it must be a
  // real `false`, never a missing one, or every network failure would be reported as a
  // permanent refusal.
  //
  // IT IS DELIBERATELY NOT PAIRED WITH A 4xx RANGE. Class puts `success:false` inside an
  // HTTP **200** (their own guide, and the transport says so where it throws), which is
  // their ORDINARY refusal — "Loan number already exists". Gating on 4xx skipped it and
  // wrote "could not be reached. You can send it again." onto the row: they were
  // reached, they answered, and sending the identical thing again cannot work. That is
  // both halves of the sentence false on the most common failure this desk has.
  if (e && e.retryable === false) {
    return 'Not sent — the appraisal company would not accept it. Sending the same thing again will not help.';
  }
  // A NETWORK failure is the honest "could not be reached"; anything else unrecognised is
  // described WITHOUT claiming which end failed, because claiming the vendor was down
  // when our own database refused the write is how "you can send it again" ends up
  // duplicating a message that already arrived.
  if (e && e.retryable === true) {
    return 'Not sent — the appraisal company could not be reached. You can send it again.';
  }
  if (!code && !Number.isFinite(status)) {
    return 'Not sent — the appraisal company could not be reached. You can send it again.';
  }
  return 'Not sent — this did not go through. Try once more, and tell an administrator if '
    + 'it keeps happening.';
}

/**
 * A NACK stored on a row. Their refusal is worth keeping in their own words (a bare
 * code says nothing to anybody), bounded and framed — the same rule `nackMessage`
 * applies to the live answer, so the row and the button never disagree.
 */
function storedNackNote(err, what, opts = {}) {
  const d = err && err.description != null ? String(err.description).trim() : '';
  const subject = what || 'it';
  // THE VERB MATCHES WHAT WAS ASKED FOR — the rule this file's own header states, and
  // the prefix broke it at two of three callers. A status poll and a document read SEND
  // NOTHING, so "Not sent — …" is a plain untruth on the row a person later reads.
  const lead = opts.reading ? 'Could not be read' : 'Not sent';
  // IT CARRIES THE SAME OPENING AS EVERY OTHER STORED SENTENCE, and that opening is a
  // CONTRACT, not decoration: a panel showing one of these columns tells our wording
  // from a legacy raw exception by exactly this prefix (see ClassAppraisalPanel's
  // `failNote`). Without it, a NACK — the one failure carrying the vendor's own
  // actionable words — would be thrown away and replaced with "you can send it again",
  // which is the opposite of what to do about a refusal.
  if (!d) return `${lead} — the appraisal company answered with a refusal about ${subject}.`;
  return `${lead} — the appraisal company answered with a refusal about ${subject}: ${d.slice(0, 300)}`;
}

module.exports = {
  sendFailMessage, nackMessage, storedFailNote, storedNackNote, TEST_MODE_PREFIX,
};
