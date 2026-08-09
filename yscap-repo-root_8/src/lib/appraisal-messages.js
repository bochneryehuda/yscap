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

module.exports = { sendFailMessage, nackMessage };
