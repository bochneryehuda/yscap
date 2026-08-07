'use strict';
/**
 * EVERYONE WHO IS ON THIS CONVERSATION — including the people the OTHER SIDE added.
 *
 * Owner-directed 2026-08-07, marked extremely important: "When title or insurance is
 * looping a second party on the email thread it should save on Pilot and keep them
 * looped in when replying thru Pilot. This is by the closing prep, by the title order,
 * and by the insurance — or they're looping in their assistant. Our system is looping
 * them back out. If our system is replying on top of it, either manually or
 * automatically, it should always stay looped in on everybody that is any other body
 * looped, and this is extremely important."
 *
 * ROOT CAUSE, and it is the same shape at all three desks: every reply and follow-up
 * RE-DERIVED its recipient list from OUR OWN records instead of from the conversation.
 *   · the TITLE / INSURANCE order (`orders.recipientsFor`) rebuilds To/Cc from the
 *     file's vendor contact plus the officer and processor — a party the vendor added
 *     is not in that data at all, so every follow-up and every Email-Center reply
 *     silently dropped them;
 *   · the CLOSING chain (`closing-prep.lastRecipients`) reads
 *     `closing_thread_messages WHERE status='sent'` — the messages WE sent — so the
 *     assistant counsel CC'd on their reply was never a candidate either.
 * In both cases the address WAS captured: `email-log.captureInbound` stores the
 * inbound `to_emails` / `cc_emails`. Nothing read them. So the information was never
 * missing — it was in a table nobody joined, and the reply confidently addressed the
 * subset of the room we happened to know about.
 *
 * THE CLASS: a reply that composes its recipients from the SENDER'S records rather than
 * from the THREAD will always drop whoever the other side added, and it will do so
 * silently, because the send succeeds.
 *
 * READ AT SEND TIME, DELIBERATELY. No migration and no back-fill: a thread that has
 * been running for weeks picks its extra participants up on the very next reply, which
 * is the standing "previous AND future" rule satisfied for free. `email_messages` is
 * already the durable record of who was on each inbound message.
 *
 * ── WHAT MAY NEVER BE ADDED ───────────────────────────────────────────────────────
 * This function's whole risk is ADDING A RECIPIENT, so every exclusion below is
 * load-bearing and none may be relaxed casually:
 *
 *  1. **OURSELVES.** Our own reply-to boxes (`file+`, `title+`, `insurance+`,
 *     `closing+`, `chat+`, `draw+`) appear on every one of these threads by design.
 *     Mailing one back is a loop: the address is an INBOUND webhook, so the reply
 *     re-enters PILOT, gets forwarded, and the pair amplify. Anything on our own
 *     reply domain or notification sender is dropped.
 *  2. **THE BORROWER.** A closing chain carries lender-to-counsel correspondence —
 *     pricing, the entity file. `routes/staff.js` already documents that leaking it to
 *     the borrower is the exact trap the closing reply branch exists to prevent, and a
 *     vendor who CC's the borrower must not turn that into policy. Callers pass the
 *     borrower addresses in `never`.
 *  3. **AUTOMATED SENDERS.** `mailer-daemon`, `postmaster`, `no-reply`, bounce and
 *     autoresponder boxes reply to nothing and produce loops. A ticketing address
 *     ("support+ABC123@") is deliberately KEPT — that is a real party.
 *  4. **AN INSURANCE CONTACT ON A CLOSING CHAIN.** A hard rule of the closing-prep
 *     order; the caller passes those addresses in `never` too.
 *
 * PURE except for the one SELECT, never throws, and FAILS TOWARD THE BASE LIST: if the
 * lookup breaks, the reply still goes to everyone we already knew about. Dropping a
 * participant is the bug being fixed; refusing to send is worse.
 */

const db = require('../db');
const cfg = require('../config');

/** How many inbound messages back to look. A conversation's participant set is
    established early and only grows; scanning the whole history of a long chain to
    re-find the same three addresses is wasted work. */
const LOOKBACK = 40;
/** Total extra participants we will ever add. A runaway list-serv on a thread must not
    turn one reply into a hundred recipients. */
const MAX_EXTRA = 25;

/** Our OWN structured reply-to local parts. Anything of the form `<prefix>+…@` on our
    reply domain is a PILOT inbound webhook, never a person. */
const OUR_LOCAL_PREFIXES = ['file', 'title', 'insurance', 'closing', 'chat', 'draw', 'order'];

/** Local parts that are machinery, not people. Matched as the WHOLE local part or as
    its `+`-stripped base, so `no-reply+abc@x` is caught and `support+ABC123@x` is not. */
const AUTOMATED_LOCALS = new Set([
  'mailer-daemon', 'mailerdaemon', 'postmaster', 'no-reply', 'noreply', 'do-not-reply',
  'donotreply', 'bounce', 'bounces', 'autoreply', 'auto-reply', 'notifications',
  'notification', 'devnull', 'null',
]);

/** A bare lowercase address out of `Name <a@b>` / `{email}` / a plain string. */
function bare(v) {
  if (!v) return '';
  if (typeof v === 'object') return bare(v.email || v.address || v.value || '');
  const s = String(v).trim();
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Does this address look like a real, mailable person/company address? */
function looksMailable(addr) {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(addr);
}

/** The domains that are OURS — anything here is PILOT machinery or our own staff
    notification plumbing, never an external party to keep looped in. */
function ourDomains() {
  const out = new Set();
  const add = (v) => {
    const d = String(v || '').trim().toLowerCase().replace(/^.*@/, '');
    if (d) out.add(d);
  };
  add(cfg.chatReplyDomain);
  add(cfg.notifyFrom);
  add(cfg.replyToDefault);
  return out;
}

/**
 * Is this one of OUR OWN addresses (a reply-to webhook or a notification sender)?
 * Exported for the test — this is the exclusion whose failure creates a mail loop.
 */
function isOurAddress(addr, domains) {
  const a = bare(addr);
  if (!a) return true;                       // nothing is not a participant
  const [local, domain] = a.split('@');
  if (!domain) return true;
  const doms = domains || ourDomains();
  if (!doms.has(domain)) return false;
  // On OUR domain: a structured reply-to box is machinery. A plain human address on our
  // domain (a staffer) is handled by the caller's own team list, so it is not an
  // "extra participant" either — dropping it here cannot lose anybody, because the
  // caller always composes its own team.
  const base = local.split('+')[0];
  if (OUR_LOCAL_PREFIXES.includes(base) && local.includes('+')) return true;
  return true;
}

/** Is this an automated sender that cannot be a participant? */
function isAutomated(addr) {
  const a = bare(addr);
  const local = a.split('@')[0] || '';
  if (AUTOMATED_LOCALS.has(local)) return true;
  const base = local.split('+')[0];
  return AUTOMATED_LOCALS.has(base);
}

/**
 * Everyone the OTHER SIDE has added to this conversation, beyond the addresses we
 * already have.
 *
 * @param {object} a
 * @param {string} a.applicationId  the file
 * @param {string[]} [a.msgTypes]   which captured inbound kinds belong to this thread
 *                                  (e.g. ['title_message'] or ['closing_message',
 *                                  'attorney_message']). Omit to take every inbound
 *                                  message on the file.
 * @param {string} [a.threadKey]    narrow to ONE stored thread (the closing chain's
 *                                  key), so two closings on one file never cross.
 * @param {string[]} [a.known]      addresses we already have (To + Cc we will send to)
 * @param {string[]} [a.never]      addresses that must NEVER be added (the borrower;
 *                                  the insurance contact on a closing chain)
 * @returns {Promise<string[]>} extra addresses, lowercased, de-duped, capped
 */
async function extraParticipants({ applicationId, msgTypes = null, threadKey = null, known = [], never = [] } = {}) {
  if (!applicationId) return [];
  const seen = new Set();
  for (const k of [...(known || []), ...(never || [])]) {
    const a = bare(k);
    if (a) seen.add(a);
  }
  const doms = ourDomains();
  const out = [];
  try {
    const params = [applicationId];
    let where = `application_id = $1 AND direction = 'inbound'`;
    if (Array.isArray(msgTypes) && msgTypes.length) {
      params.push(msgTypes);
      where += ` AND msg_type = ANY($${params.length}::text[])`;
    }
    if (threadKey) {
      params.push(threadKey);
      where += ` AND thread_key = $${params.length}`;
    }
    params.push(LOOKBACK);
    const r = await db.query(
      `SELECT from_email, to_emails, cc_emails
         FROM email_messages
        WHERE ${where}
        ORDER BY occurred_at DESC NULLS LAST, id DESC
        LIMIT $${params.length}`, params);
    for (const row of r.rows) {
      // The SENDER counts: on a chain the other side runs, a reply may come from an
      // assistant who is not on any To/Cc we hold.
      const candidates = [row.from_email];
      for (const v of [row.to_emails, row.cc_emails]) {
        if (Array.isArray(v)) for (const x of v) candidates.push(x);
      }
      for (const c of candidates) {
        const a = bare(c);
        if (!a || seen.has(a)) continue;
        seen.add(a);                                  // decided once, either way
        if (!looksMailable(a)) continue;
        if (isOurAddress(a, doms)) continue;
        if (isAutomated(a)) continue;
        if (out.length >= MAX_EXTRA) break;
        out.push(a);
      }
      if (out.length >= MAX_EXTRA) break;
    }
  } catch (_) {
    // FAIL TOWARD THE BASE LIST — the reply still reaches everyone we already knew.
    return [];
  }
  return out;
}

/**
 * The To/Cc for a reply, with the other side's additions kept in.
 *
 * The extras always go to **Cc**, never To: To is who the message is ADDRESSED to (the
 * vendor, counsel), and promoting a CC'd assistant to To changes who the reply is
 * for. It also means the base To can never be diluted.
 *
 * @returns {Promise<{to:string[], cc:string[], added:string[]}>}
 */
async function replyRecipients({ applicationId, msgTypes, threadKey, to = [], cc = [], never = [] } = {}) {
  const norm = (list) => {
    const seen = new Set(); const out = [];
    for (const v of list || []) { const a = bare(v); if (a && !seen.has(a)) { seen.add(a); out.push(a); } }
    return out;
  };
  const baseTo = norm(to);
  const baseCc = norm(cc).filter((a) => !baseTo.includes(a));
  const added = await extraParticipants({
    applicationId, msgTypes, threadKey,
    known: [...baseTo, ...baseCc], never,
  });
  return { to: baseTo, cc: baseCc.concat(added), added };
}

module.exports = {
  extraParticipants, replyRecipients,
  _internals: { bare, looksMailable, isOurAddress, isAutomated, ourDomains, LOOKBACK, MAX_EXTRA,
    OUR_LOCAL_PREFIXES, AUTOMATED_LOCALS },
};
