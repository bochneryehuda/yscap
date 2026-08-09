'use strict';
/**
 * WHO ALREADY HAS THIS EMAIL IN THEIR OWN INBOX — so PILOT never sends them a
 * second copy of something they were on.
 *
 * Owner-directed 2026-08-09, marked very important: *"people that are looped in
 * into the email are also getting notified by our system … if they're anyway
 * looped into the email then why should I also get a notification from our
 * system? … It should still be logged into the system, but they don't need to
 * get the notification because they're looped in. In case somebody is not
 * clicking Reply All … if people are not looped in, then our system should send
 * out notifications of the replies."*
 *
 * THE RULE, in one sentence: a notification that exists BECAUSE an inbound email
 * arrived (a vendor answering an order, a reply on the file thread, a message on
 * the closing chain, an email reply into a chat) is suppressed — AS AN EMAIL
 * ONLY — for anybody who was on that email themselves (the sender, a To, a Cc,
 * a Bcc the provider exposes), because their own inbox already holds the
 * message. The IN-APP row always writes, so the portal record stays complete
 * and the file's email history shows everything; and anybody who was NOT on the
 * email is notified exactly as before. One event, one copy, for everyone.
 *
 * WHY A SHARED MODULE and not a check at each desk: the bombardment was the
 * same shape at every inbound family (orders, closing, file thread, chat), and
 * a rule copied four times drifts four ways. This is the one vocabulary all of
 * them — and `notify.js`'s own chokepoints — read, so the next inbound family
 * added gets the rule for free by passing the same `alreadyEmailed` list.
 *
 * WHAT THIS MODULE MUST NEVER DO is widen: it only ever REMOVES an email
 * recipient, never adds one, and it fails toward SENDING — a malformed list, a
 * null, an address that won't parse all leave the recipient list untouched.
 * Losing a notification is the expensive direction; a duplicate is only noise.
 *
 * Pure — no DB, no config — so every consumer (and the truth-table test) can
 * exercise it without a harness.
 */

/** A bare lowercase address out of `Name <a@b>` / `{email}` / a plain string.
    Same extraction shape as thread-participants/file-inbox: anchored to the
    LAST angle-bracket group so a display name containing angle brackets can't
    spoof it. */
function bareAddress(v) {
  if (!v) return '';
  if (typeof v === 'object') return bareAddress(v.email || v.address || v.value || '');
  const s = String(v).trim();
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Does this look like a real address at all? Looser than a full RFC check on
    purpose — this set only ever SUPPRESSES a duplicate, so a false negative
    (keeping a recipient) is safe and a strict parser buys nothing. */
function looksLikeAddress(a) {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(a);
}

/**
 * Normalize any caller-supplied `alreadyEmailed` value (array of strings /
 * objects / a Set / null) into a Set of bare lowercase addresses. An empty or
 * absent value yields an empty Set — the no-op that keeps every existing call
 * site byte-identical in behavior.
 */
function toSet(v) {
  const out = new Set();
  if (!v) return out;
  const list = v instanceof Set ? [...v] : (Array.isArray(v) ? v : [v]);
  for (const item of list) {
    const a = bareAddress(item);
    if (a && looksLikeAddress(a)) out.add(a);
  }
  return out;
}

/**
 * Everyone an inbound email already reached: its sender plus every recipient
 * the webhook names (To + Cc + Bcc + envelope). Our own machinery addresses
 * (file+/title+/… on the reply domain) ride along harmlessly — no staff or
 * borrower address can ever equal one, and filtering them here would couple
 * this module to config for zero benefit.
 *
 * @param {object} p
 * @param {string} [p.from]        the inbound email's sender
 * @param {Array}  [p.recipients]  every recipient the event names (any shape)
 * @returns {Set<string>} bare lowercase addresses
 */
function alreadyOnEmailSet({ from, recipients } = {}) {
  const out = toSet(recipients);
  const f = bareAddress(from);
  if (f && looksLikeAddress(f)) out.add(f);
  return out;
}

/**
 * The addresses that still need OUR email — the input list minus anybody who
 * already has the message in their own inbox. The workhorse every chokepoint
 * calls. Order-preserving; never adds; empty/absent `alreadyEmailed` returns
 * the input list unchanged (same array contents, so existing behavior is
 * untouched wherever the option isn't passed).
 *
 * @param {string[]} addrs           candidate recipients (any casing/shape)
 * @param {Array|Set|null} alreadyEmailed  who the inbound email already reached
 * @returns {string[]} the recipients to actually email
 */
function withoutAlreadyEmailed(addrs, alreadyEmailed) {
  const list = Array.isArray(addrs) ? addrs : (addrs ? [addrs] : []);
  const suppress = toSet(alreadyEmailed);
  if (!suppress.size) return list;
  return list.filter((a) => !suppress.has(bareAddress(a)));
}

/** Is this one address already on the email? (Sugar over toSet for call sites
    that decide per-person rather than filter a list.) */
function isOnEmail(alreadyEmailed, addr) {
  const a = bareAddress(addr);
  if (!a) return false;
  const s = alreadyEmailed instanceof Set ? alreadyEmailed : toSet(alreadyEmailed);
  return s.has(a);
}

module.exports = { bareAddress, toSet, alreadyOnEmailSet, withoutAlreadyEmailed, isOnEmail };
