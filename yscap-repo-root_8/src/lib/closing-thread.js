/**
 * THE CLOSING EMAIL CHAIN (owner-directed 2026-07-28).
 *
 * WHAT PROBLEM THIS SOLVES. Every other reply-to in this app assumes the outside
 * party REPLIES to us: `file+<appId>@` fans a reply out to the team, `title+<appId>@`
 * files a vendor's returned documents onto the title order. A closing attorney does
 * not behave that way. They take the closing-prep request, and then they open a
 * BRAND-NEW email chain — their own subject, their own recipient list (title
 * company, settlement agent, realtor, borrower's counsel, our team) — and the
 * entire closing is worked there. Under the old model that chain is invisible to
 * the file: a new subject means a new thread at best, and nothing at all if they
 * never hit reply.
 *
 * SO THE ADDRESS IS THE HOOK, NOT THE REPLY. The closing-prep email prints a
 * unique address and asks the attorney to KEEP IT ON THE CHAIN:
 *     closing+<token>@<CHAT_REPLY_DOMAIN>
 * The inbound webhook already reads To + Cc + Bcc + envelope recipients, so a
 * merely-CC'd address is enough. From then on every message on that chain — and
 * every document attached to it — reaches this file, no matter who sent it or what
 * they called the subject.
 *
 * THE THREAD KEY IS STORED, NOT DERIVED. `email-log.threadKeyFor` normally keys a
 * thread on (file, normalized subject) — exactly the wrong thing here, since the
 * attorney's subject is unknown and may change mid-chain. `closing_threads.thread_key`
 * is a stable, stored key, and every capture on this chain is filed under it. That
 * is what makes the file's Closing tab show ONE conversation.
 *
 * OUR OWN LATER MESSAGES MUST LAND *INSIDE* THAT CONVERSATION. The executed term
 * sheet, a new expected closing date and clear-to-close are all sent onto the same
 * chain, never as fresh emails. Two mechanisms, deliberately belt-and-suspenders,
 * because no single one is reliable across providers:
 *   1. RFC threading headers — we mint our own Message-ID per send and reference
 *      the chain's root + previous ids (In-Reply-To / References).
 *   2. The SAME subject, `Re:`-prefixed. Gmail and Outlook both fall back to the
 *      subject, which covers the case where the provider rewrites our Message-ID
 *      (Resend may; Graph always does — see the provider notes in email/graph.js).
 *
 * AND THEY MUST NEVER DOUBLE-SEND. An e-sign webhook is redelivered, a status
 * route is double-clicked, a boot sweep re-runs. So a system message is CLAIMED
 * before it is sent: the row goes in first, carrying a `dedupe_key` under a unique
 * index, and losing that race means somebody already sent it. Claim-then-act, the
 * same ordering `file-inbox` uses for inbound deliveries.
 *
 * Best-effort by contract: nothing in here may break a caller. `sendOnThread`
 * reports what happened; it does not throw on a send failure, and every counter
 * update is swallowed.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const { closingReplyTo, UUID_RE, CLOSING_TOKEN_RE } = require('./file-address');

// 10 bytes = 20 lowercase hex chars = 80 bits. Short enough for an attorney to
// retype off the page, far too large to guess.
const TOKEN_BYTES = 10;
const MAX_TOKEN_TRIES = 5;

/** How long a claimed-but-unsent message may sit before it is treated as
    abandoned. Well above any provider timeout (Resend aborts at 15s, Graph far
    sooner) and above the slowest realistic 20 MB upload, so this can only ever
    catch a process that died mid-send — never a message still on its way. */
const CLAIM_STALE_MIN = 15;

/** The system messages that may ride this chain. Adding another one is a single
    entry here plus the migration's CHECK — the send path itself is generic, which
    is the owner's "build up the logic that we can potentially add more emails". */
const EVENT_KINDS = ['order', 'followup', 'executed_term_sheet', 'closing_date', 'clear_to_close', 'manual', 'cancel'];

function isAppId(v) { return UUID_RE.test(String(v || '').trim().toLowerCase()); }

function newToken() { return crypto.randomBytes(TOKEN_BYTES).toString('hex'); }

/** The stable Email Center thread key for a closing chain. Deliberately carries a
    `#` so it can never collide with a subject-derived key (`<appId>:<subject>`)
    even if someone titles an email "closing#abc". */
function threadKeyOf(applicationId, token) {
  return `${String(applicationId).toLowerCase()}:closing#${token}`.slice(0, 400);
}

/** A Message-ID we own, in the shape a mail server expects (angle-bracketed, a
    domain on the right). Unique per send: the token identifies the chain, the
    random tail the message. */
function newMessageId(token) {
  const domain = cfg.chatReplyDomain || 'closing.yscapgroup.com';
  return `<closing.${token}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;
}

/** The threading headers for one send. `X-Pilot-Closing-Thread` is the only part
    Microsoft Graph can carry (it rejects non-`X-` headers), so it doubles as the
    human-traceable marker when reading a raw message. */
function headersFor(thread, messageId) {
  const h = {};
  if (messageId) h['Message-ID'] = messageId;
  const parent = thread && (thread.last_message_id || thread.root_message_id);
  if (parent) {
    h['In-Reply-To'] = parent;
    const root = thread.root_message_id && thread.root_message_id !== parent
      ? `${thread.root_message_id} ${parent}` : parent;
    h.References = root;
  }
  if (thread && thread.token) h['X-Pilot-Closing-Thread'] = thread.token;
  return h;
}

/* ------------------------------------------------------------------ the thread */

/** The file's closing chain, or null when one was never opened. */
async function threadFor(applicationId) {
  if (!isAppId(applicationId)) return null;
  try {
    const r = await db.query(`SELECT * FROM closing_threads WHERE application_id=$1`, [applicationId]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

/**
 * Open the file's closing chain, or return the existing one. One per file
 * (UNIQUE application_id), so this is safe to call from anywhere and races
 * resolve to the same row.
 *
 * The token is generated here and retried on the (astronomically unlikely)
 * collision, so a unique-violation can never surface to a caller as a 500.
 */
async function ensureThread(applicationId, { staffId = null, subject = null } = {}) {
  if (!isAppId(applicationId)) return null;
  const existing = await threadFor(applicationId);
  if (existing) {
    // Fill in the canonical subject the first time we actually know it (the
    // thread can be opened by a read before any email has been composed).
    if (subject && !existing.subject) {
      try {
        const up = await db.query(
          `UPDATE closing_threads SET subject=$2, updated_at=now()
            WHERE id=$1 AND subject IS NULL RETURNING *`, [existing.id, String(subject).slice(0, 500)]);
        if (up.rows[0]) return up.rows[0];
      } catch (_) { /* keep the row we have */ }
    }
    return existing;
  }
  for (let i = 0; i < MAX_TOKEN_TRIES; i++) {
    const token = newToken();
    try {
      const r = await db.query(
        `INSERT INTO closing_threads (application_id, token, thread_key, subject, opened_at, opened_by)
         VALUES ($1,$2,$3,$4,now(),$5)
         ON CONFLICT (application_id) DO NOTHING
         RETURNING *`,
        [applicationId, token, threadKeyOf(applicationId, token),
         subject ? String(subject).slice(0, 500) : null, staffId]);
      if (r.rows[0]) return r.rows[0];
      // Another request opened it first — that row is the answer.
      const again = await threadFor(applicationId);
      if (again) return again;
    } catch (e) {
      // 23505 on the TOKEN unique index: try another token. Anything else is real.
      if (e && e.code === '23505') continue;
      return null;
    }
  }
  return null;
}

/** Resolve an inbound `closing+<token>@` address to its file. */
async function resolveByToken(token) {
  const t = String(token || '').trim().toLowerCase();
  // The SHARED pattern that mints and parses these addresses — never a second copy.
  // A private duplicate here would let a widened token format build addresses that
  // resolve nowhere, so a whole closing chain would go quietly uncaptured.
  if (!CLOSING_TOKEN_RE.test(t)) return null;
  try {
    const r = await db.query(
      `SELECT ct.*, a.deleted_at
         FROM closing_threads ct
         JOIN applications a ON a.id = ct.application_id
        WHERE ct.token = $1`, [t]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      applicationId: row.application_id,
      threadId: row.id,
      threadKey: row.thread_key,
      token: row.token,
      archived: !!row.deleted_at,
      thread: row,
    };
  } catch (_) { return null; }
}

/** The printable address for a thread (null when no inbound domain is configured —
    then the feature degrades to a plain, un-captured email, never to an error). */
function addressFor(thread) {
  return thread ? closingReplyTo(thread.token) : null;
}

/* ------------------------------------------------------------------ the chain */

/**
 * CLAIM a system message before sending it. Returns the claimed row, or null when
 * this exact event was already put on the chain (the unique index refused it).
 * A null return means "someone else already sent this" — never an error.
 *
 * A `dedupeKey` of null is a deliberate manual re-send and is always allowed.
 */
async function claimMessage({ threadId, applicationId, eventKind, dedupeKey = null, subject = null, staffId = null }) {
  if (!threadId || !isAppId(applicationId)) return null;
  if (!EVENT_KINDS.includes(eventKind)) return null;

  // RELEASE AN ABANDONED CLAIM FIRST.
  //
  // A claim is committed BEFORE the send, so a process killed between the two
  // (Render redeploys on every merge) leaves a 'claimed' row holding the key with
  // nothing on its way. Nothing else in the system would ever touch that row: the
  // backstop sweep re-selects the event, re-claims, loses to the held key and
  // reports `already_sent` — forever. The executed term sheet would simply never
  // reach the attorney, and the desk would show a healthy chain.
  //
  // A claim older than CLAIM_STALE_MIN cannot still be in flight (the provider
  // clients cap out far below it), so it is demoted to a permanent 'abandoned' row
  // — kept for the audit trail, key freed — and this attempt takes the event.
  if (dedupeKey) {
    try {
      await db.query(
        `UPDATE closing_thread_messages
            SET status='abandoned', dedupe_key=NULL,
                error=COALESCE(error,'claimed but never sent (process ended mid-send)')
          WHERE thread_id=$1 AND dedupe_key=$2 AND status='claimed'
            AND created_at < now() - ($3 || ' minutes')::interval`,
        [threadId, dedupeKey, String(CLAIM_STALE_MIN)]);
    } catch (_) { /* best-effort: the claim below still decides the outcome */ }
  }

  // A DB failure here must NOT read as "already sent" — see the throw below.
  const seq = await db.query(
    `SELECT COALESCE(MAX(seq),0) + 1 AS n FROM closing_thread_messages WHERE thread_id=$1`, [threadId]);
  const r = await db.query(
    `INSERT INTO closing_thread_messages
       (thread_id, application_id, seq, event_kind, dedupe_key, subject, status, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,'claimed',$7)
     ON CONFLICT (thread_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [threadId, applicationId, seq.rows[0].n, eventKind, dedupeKey,
     subject ? String(subject).slice(0, 500) : null, staffId]);
  // null ONLY ever means "the unique index refused it — somebody already sent this".
  // Every other failure THROWS, because swallowing it here told the operator their
  // closing-prep request had already gone out when in fact nothing was sent.
  return r.rows[0] || null;
}

/** Finish a claimed message: record what was actually sent, advance the chain's
    reference point, and bump the thread's counters. Best-effort. */
async function settleMessage(msgId, { messageId, inReplyTo, to = [], cc = [], attachments = [], status = 'sent', error = null, releaseKey = null } = {}) {
  if (!msgId) return;
  // A DEFINITELY-FAILED send RELEASES THE DEDUPE KEY while keeping the row.
  //
  // This is load-bearing, not tidiness. The key is the "already sent" proof, so a
  // failed row that keeps it makes one two-second provider blip permanent: every
  // later attempt at that event, from any door and from the backstop sweep,
  // answers `already_sent` and the closing attorney is never told the term sheet
  // was executed. The row stays for the audit trail; only its claim is freed.
  //
  // BUT AN AMBIGUOUS FAILURE MUST NOT RELEASE IT. `email.sendMail` also rethrows on
  // a client-side ABORT — Resend gives up at 15 seconds, and the default closing
  // package is 20 MB raw (~27 MB base64), which routinely takes longer than that to
  // push. The provider may well have accepted it. Releasing there means the next
  // attempt re-sends the entire package to outside counsel and everyone they have
  // copied, twice. So an ambiguous failure is settled 'unknown' and KEEPS the key;
  // the card shows it as needing a human decision, and the operator's explicit
  // "force re-send" (dedupeKey null) is the deliberate way through.
  const release = releaseKey === null ? (status === 'error') : !!releaseKey;
  try {
    await db.query(
      `UPDATE closing_thread_messages
          SET message_id=$2, in_reply_to=$3, to_emails=$4::jsonb, cc_emails=$5::jsonb,
              attachments=$6::jsonb, status=$7, error=$8, sent_at=now(),
              dedupe_key = CASE WHEN $9 THEN NULL ELSE dedupe_key END
        WHERE id=$1`,
      [msgId, messageId || null, inReplyTo || null,
       JSON.stringify((to || []).slice(0, 100)), JSON.stringify((cc || []).slice(0, 100)),
       JSON.stringify((attachments || []).slice(0, 50)), status,
       error ? String(error).slice(0, 400) : null, release]);
  } catch (_) { /* best-effort */ }
  if (status !== 'sent' || !messageId) return;
  try {
    // root_message_id is set ONCE (the first message is the References root);
    // last_message_id always advances so the next send replies to this one.
    await db.query(
      `UPDATE closing_threads
          SET root_message_id = COALESCE(root_message_id, $2),
              last_message_id = $2,
              outbound_count  = outbound_count + 1,
              last_activity_at = now(),
              updated_at = now()
        WHERE id = (SELECT thread_id FROM closing_thread_messages WHERE id=$1)`,
      [msgId, messageId]);
  } catch (_) { /* best-effort */ }
}

/**
 * Did this send fail in a way that leaves it UNKNOWN whether the provider took the
 * message? A refusal (bad address, 4xx, rejected payload) is definite: nothing was
 * delivered, so the event is safe to retry. A client-side abort/timeout/socket
 * error is not — the request may have been fully received and queued. On a message
 * carrying the whole closing package to outside counsel, re-sending on a maybe is
 * the worse mistake, so these are settled 'unknown' and keep their claim.
 */
function isAmbiguousSendFailure(err) {
  const s = `${(err && err.message) || ''} ${(err && err.code) || ''} ${(err && err.name) || ''}`.toLowerCase();
  return /timed out|timeout|abort|econnreset|econnaborted|etimedout|epipe|socket hang up|network|fetch failed/.test(s);
}

/** Drop a claim that never went out, so a later retry can claim the event again.
    Without this, a send that failed BEFORE reaching the provider would be
    permanently "already sent". Only ever removes a row we just claimed. */
async function releaseClaim(msgId) {
  if (!msgId) return;
  try { await db.query(`DELETE FROM closing_thread_messages WHERE id=$1 AND status='claimed'`, [msgId]); }
  catch (_) { /* best-effort */ }
}

/** Record inbound activity on the chain (an email, and any documents it carried). */
/**
 * Record inbound activity on a chain.
 *
 * `countMessage` exists because a message with a TRANSIENT save failure is
 * deliberately left un-marked so Resend redelivers it (see file-inbox), and this
 * runs once per delivery. Counting the MESSAGE every time inflated `inbound_count`
 * ("4 received" for one email retried 3 times). `docs_count` must still accumulate
 * each pass — the content-hash dedupe means every pass adds only the documents that
 * newly landed — so only the message tally is gated: incremented once, on the pass
 * that finally handles the message (the terminal, marker-setting pass).
 */
async function noteInbound(threadId, { docs = 0, countMessage = true } = {}) {
  if (!threadId) return;
  try {
    await db.query(
      `UPDATE closing_threads
          SET inbound_count = inbound_count + $3,
              docs_count = docs_count + $2,
              last_activity_at = now(), updated_at = now()
        WHERE id = $1`, [threadId, Math.max(0, Number(docs) || 0), countMessage ? 1 : 0]);
  } catch (_) { /* best-effort */ }
}

/* ---------------------------------------------------------------- the one send */

/** `Re:`-prefix a subject exactly once. Our continuation messages reuse the
    chain's subject so a provider that rewrites Message-ID still threads. */
function replySubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return '';
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * THE chokepoint for putting a message on a file's closing chain. Every caller —
 * the closing-prep order, the executed term sheet, a new closing date,
 * clear-to-close, and whatever is added next — goes through here, so threading,
 * idempotency, the Email Center capture and the audit row can never drift between
 * them.
 *
 * @param p.applicationId
 * @param p.eventKind   one of EVENT_KINDS
 * @param p.dedupeKey   stable id for an automatic event; null for a manual send
 * @param p.build       ({ address, isFirst, threadSubject }) => { subject, html, text }
 *                      Called only AFTER the claim succeeds, so a deduped event
 *                      costs nothing to render.
 * @param p.to / p.cc   recipient arrays
 * @param p.attachments [{filename, contentType, content(base64)}]
 * @param p.fromName    display name for the From: (the portal user who sent it)
 * @param p.msgType     Email Center msg_type (e.g. 'closing_order')
 * @returns {Promise<{ok, skipped?, reason?, thread, address, to, cc, subject, messageId, attachments}>}
 */
async function sendOnThread(p = {}) {
  const email = require('./email');
  const appId = String(p.applicationId || '').toLowerCase();
  if (!isAppId(appId)) return { ok: false, reason: 'bad_application' };

  const thread = await ensureThread(appId, { staffId: p.staffId || null, subject: p.subject || null });
  if (!thread) return { ok: false, reason: 'no_thread' };

  const isFirst = !thread.root_message_id;
  const address = addressFor(thread);

  // A DB failure while claiming must never be reported as "already sent" — that
  // told the operator their closing-prep request had gone out when nothing had.
  let claim;
  try {
    claim = await claimMessage({
      threadId: thread.id, applicationId: appId, eventKind: p.eventKind,
      dedupeKey: p.dedupeKey || null, staffId: p.staffId || null,
    });
  } catch (e) {
    return { ok: false, reason: 'claim_failed', error: e && e.message, thread, address };
  }
  if (!claim) return { ok: true, skipped: true, reason: 'already_sent', thread, address };

  let built;
  try {
    built = await p.build({ address, isFirst, threadSubject: thread.subject || null });
  } catch (e) {
    await releaseClaim(claim.id);
    return { ok: false, reason: 'build_failed', error: e && e.message, thread, address };
  }
  if (!built || !built.subject) {
    await releaseClaim(claim.id);
    return { ok: false, reason: 'nothing_built', thread, address };
  }

  // The chain's canonical subject is whatever the FIRST message used; every later
  // message reuses it (Re:-prefixed) rather than inventing its own.
  let subject = built.subject;
  if (isFirst) {
    if (!thread.subject) {
      try {
        await db.query(`UPDATE closing_threads SET subject=$2, updated_at=now() WHERE id=$1 AND subject IS NULL`,
          [thread.id, String(subject).slice(0, 500)]);
        thread.subject = subject;
      } catch (_) { /* the send is what matters */ }
    }
  } else if (thread.subject) {
    subject = replySubject(thread.subject);
  }

  const messageId = newMessageId(thread.token);
  const headers = headersFor(thread, messageId);
  const inReplyTo = headers['In-Reply-To'] || null;
  const to = (p.to || []).filter(Boolean);
  const cc = (p.cc || []).filter(Boolean);
  const attachments = Array.isArray(p.attachments) ? p.attachments : [];
  const attachMeta = attachments.map((a) => ({
    filename: a.filename,
    size: typeof a.content === 'string' ? Math.round(a.content.length * 0.75) : null,
  }));

  if (!to.length) {
    await settleMessage(claim.id, { to, cc, attachments: attachMeta, status: 'error', error: 'no recipient' });
    return { ok: false, reason: 'no_recipient', thread, address };
  }

  let res;
  try {
    res = await email.sendMail({
      to, cc,
      subject, html: built.html, text: built.text,
      // The chain's own address is the Reply-To, so a reply that DOES come back
      // lands on this chain rather than the generic file inbox.
      replyTo: address || require('./file-address').fileReplyTo(appId) || cfg.replyToDefault || null,
      from: p.fromName && email.fromWithName ? email.fromWithName(p.fromName) : undefined,
      headers,
      attachments: attachments.length ? attachments : undefined,
      _ctx: {
        applicationId: appId,
        type: p.msgType || 'closing_message',
        audience: 'staff',
        recipientKind: 'external',
        // Pin the capture to the CHAIN, not to this message's subject — the whole
        // point of a stored thread key.
        threadKey: thread.thread_key,
        // WHAT THIS MESSAGE COULD NOT CARRY (db/550) — a closing package that goes to outside
        // counsel one document short must be answerable months later, not only on the card.
        omitted: p.omitted, attachSummary: p.attachSummary,
      },
    });
  } catch (e) {
    // Ambiguous (timed out / aborted mid-upload) → the provider may have taken it,
    // so keep the key and let a human decide. Definite rejection → free the key so
    // the next attempt, or the backstop sweep, can retry on its own.
    const ambiguous = isAmbiguousSendFailure(e);
    await settleMessage(claim.id, {
      messageId, inReplyTo, to, cc, attachments: attachMeta,
      status: ambiguous ? 'unknown' : 'error', error: e && e.message, releaseKey: !ambiguous,
    });
    return {
      ok: false, reason: ambiguous ? 'send_unconfirmed' : 'send_failed',
      error: e && e.message, thread, address, to, cc, subject,
    };
  }

  // THE PROVIDER'S ANSWER DECIDES, not the absence of a throw. `email/noop.js`
  // returns {ok:false, skipped:true} WITHOUT throwing, and the provider silently
  // falls back to 'none' when its API key is missing — so recording 'sent' here
  // meant a rotated key turned every closing update into a delivered-and-deduped
  // message that no attorney ever received, with the desk showing a healthy chain.
  if (!res || res.ok !== true) {
    const skipped = !!(res && res.skipped);
    await settleMessage(claim.id, {
      messageId, inReplyTo, to, cc, attachments: attachMeta,
      status: skipped ? 'skipped' : 'error',
      error: skipped ? 'email sending is turned off in this environment' : 'the email provider did not accept the message',
      // Not delivered and worth retrying once email is working again.
      releaseKey: true,
    });
    return {
      ok: false, reason: skipped ? 'email_disabled' : 'send_failed',
      thread, address, to, cc, subject,
    };
  }

  await settleMessage(claim.id, { messageId, inReplyTo, to, cc, attachments: attachMeta, status: 'sent' });
  return { ok: true, thread, address, to, cc, subject, messageId, attachments: attachMeta, isFirst };
}

module.exports = {
  EVENT_KINDS,
  ensureThread, threadFor, resolveByToken, addressFor,
  threadKeyOf, newMessageId, newToken, headersFor, replySubject,
  claimMessage, settleMessage, releaseClaim, noteInbound,
  sendOnThread,
  // exported for tests — the rules that decide whether a failed send may be retried
  _internals: { isAmbiguousSendFailure, CLAIM_STALE_MIN },
};
