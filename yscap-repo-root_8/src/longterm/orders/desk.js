'use strict';
/**
 * LONG-TERM — THE ORDERS DESK.
 *
 * Reading the desk, placing an order, chasing it, and standing one down. The LETTER
 * and the RECIPIENT RULE are shared with the short-term desk; the tables, the
 * bookkeeping and the vendor links are this product's own.
 *
 * ── THE CLAIM COMES FIRST AND THE SEND SECOND ───────────────────────────────
 *
 * `place` writes the order row and sends inside ONE transaction, and a failed send
 * ROLLS THE ROW BACK. That is what makes an order exactly-once: nothing is recorded
 * that did not happen, and nothing that happened goes unrecorded. The short-term
 * desk arrived at this shape the hard way and the reasoning is identical here — a
 * title company that was never asked, on a desk that shows a healthy placed order,
 * is the worst failure this feature has, because nobody chases it.
 *
 * ── AMBIGUOUS IS NOT FAILED ─────────────────────────────────────────────────
 *
 * A provider that stops responding mid-send may well have taken the message. Calling
 * that "not sent" is what makes an operator press Order again and the vendor receive
 * it twice. An ambiguous failure KEEPS the row, says so plainly, and asks a person
 * to look before re-sending.
 *
 * ── THE THREAD IS THE POINT ─────────────────────────────────────────────────
 *
 * Every message on an order lands on the SAME conversation in the vendor's inbox:
 * the original subject with one "Re:" (the load-bearing half — a provider may
 * rewrite our Message-ID and the subject is what mail clients fall back to) plus the
 * RFC threading headers where we know the parent.
 *
 * SEPARATION: writes `lt_*` only. Reads the authorized shared directory and roster.
 * Sends with `_skipCapture`, so the short-term Email Center is never written — the
 * long-term thread is `lt_order_events`.
 */

const db = require('../db');
const cfg = require('../config');
const email = require('../../lib/email');
const orderEmail = require('../../lib/order-email');
const { ltOrderReplyTo } = require('../../lib/file-address');
const sendAs = require('../../lib/send-as');
const kinds = require('./kinds');
const data = require('./data');
const letter = require('./letter');

/** A Message-ID we own for a long-term order email. Unique per send; the left side
    names the order so a thread can be traced from a raw header. */
function newMessageId(loanId, kind) {
  const crypto = require('crypto');
  const domain = cfg.chatReplyDomain || 'orders.yscapgroup.com';
  return `<ltorder.${kind}.${String(loanId).replace(/[^a-z0-9-]/gi, '')}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;
}

/** The order row for a loan+kind, or null. */
async function findOrder(loanId, kind, client = db) {
  const { rows } = await client.query(
    `SELECT * FROM lt_file_orders WHERE loan_id = $1::uuid AND kind = $2`,
    [String(loanId), String(kind)],
  );
  return rows[0] || null;
}

/**
 * THE WHOLE DESK for one loan: every kind, its order, what still blocks it, and who
 * it would go to. Read-only and never throws — a desk that 500s on one unreadable
 * vendor card is worse than one that says which card it could not read.
 */
async function desk(loanId, client = db) {
  const d = await data.getOrderData(loanId, client);
  if (!d) return null;

  let orders = [];
  let degraded = null;
  try {
    const { rows } = await client.query(
      `SELECT o.*, 
              (SELECT count(*) FROM lt_order_events e WHERE e.order_id = o.id) AS event_count,
              (SELECT max(occurred_at) FROM lt_order_events e WHERE e.order_id = o.id AND e.direction = 'inbound') AS last_inbound_at
         FROM lt_file_orders o WHERE o.loan_id = $1::uuid`,
      [String(loanId)],
    );
    orders = rows;
  } catch (e) {
    degraded = String((e && e.message) || e).slice(0, 300);
  }
  const byKind = new Map(orders.map((o) => [o.kind, o]));

  const list = kinds.ORDER_KIND_KEYS.map((k) => {
    const def = kinds.orderKind(k);
    const row = byKind.get(k) || null;
    const blocks = data.blockers(k, d);
    const card = (d.vendors || {})[k] || null;
    return {
      kind: k,
      label: def.label,
      enabled: def.enabled !== false,
      disabledReason: def.enabled === false ? (def.disabledReason || null) : null,
      condition: def.condition,
      docCondition: def.docCondition || null,
      letterKind: letter.letterKeyFor(k, d),
      vendorKind: def.vendorKind,
      vendorLabel: kinds.VENDOR_KINDS[def.vendorKind] || def.vendorKind,
      vendor: card,
      vendorExtra: (d.vendorsExtra || {})[k] || [],
      to: card && !card.missing ? data.vendorEmails(k, d) : [],
      blockers: blocks,
      blockerText: blocks.map((b) => data.blockerText(b)),
      canOrder: blocks.length === 0,
      status: row ? row.status : 'not_ordered',
      orderId: row ? row.id : null,
      orderedAt: row ? row.ordered_at : null,
      lastFollowupAt: row ? row.last_followup_at : null,
      subject: row ? row.subject : null,
      replyTo: row ? row.reply_to : ltOrderReplyTo(loanId, k),
      messages: row ? Number(row.event_count) || 0 : 0,
      lastInboundAt: row ? row.last_inbound_at : null,
      cancelReason: row ? row.cancel_reason : null,
    };
  });

  return { loanId: String(loanId), file: d, orders: list, degraded, unreadable: d.unreadable || [] };
}

/** One order's whole thread, newest last, for the Gmail-style box. */
async function thread(loanId, kind, client = db) {
  const order = await findOrder(loanId, kind, client);
  if (!order) return { order: null, events: [] };
  const { rows } = await client.query(
    `SELECT id, direction, msg_type, subject, from_email, to_emails, cc_emails,
            body_text, message_id, in_reply_to, sender_auth, attachments, skipped,
            status, staff_id, occurred_at
       FROM lt_order_events WHERE order_id = $1::uuid ORDER BY occurred_at ASC, id ASC`,
    [order.id],
  );
  return { order, events: rows };
}

/**
 * PUT A LETTER ON THE WIRE, and say plainly what happened. NEVER THROWS.
 *
 * @returns {{ok:true, messageId, to, cc} | {ok:false, reason, message, ambiguous?}}
 */
async function sendLetter({ loanId, kind, built, to, cc, replyTo, from, threadState, attachments }) {
  const toList = (to || []).filter(Boolean);
  const ccList = (cc || []).filter(Boolean);
  if (!toList.length) {
    return { ok: false, reason: 'contact', message: 'There is nobody to send this to — add the contact on the file first.' };
  }
  const isReply = !!threadState;
  const parent = threadState && (threadState.last || threadState.root);
  const messageId = newMessageId(loanId, kind);
  const subject = isReply
    ? (orderEmail.replyOrderSubject(threadState.subject || built.subject) || built.subject)
    : built.subject;

  // The Message-ID and an X- marker always ride. Microsoft Graph carries only X-
  // headers (it drops the RFC threading ones), so the SUBJECT reuse above is what
  // threads a Graph-sent chain; In-Reply-To/References are added only when we know
  // the parent, for Resend.
  const headers = { 'Message-ID': messageId, 'X-Pilot-Lt-Order-Thread': `${loanId}:${kind}` };
  if (parent) {
    headers['In-Reply-To'] = parent;
    headers.References = (threadState.root && threadState.root !== parent) ? `${threadState.root} ${parent}` : parent;
  }

  /* THE ORDER COMES FROM THE PERSON WHO PLACED IT (owner-directed 2026-08-30). The
     rule — and the reason a person on another domain is sent FOR rather than AS — is
     `lib/send-as.js`; this only supplies the person and the configuration. The order's
     own reply address always wins over theirs, because that address is what files the
     documents they send back onto the right condition. */
  const sender = sendAs.senderFor(from || {}, {
    notifyFrom: cfg.notifyFrom,
    domains: sendAs.sendingDomains({ notifyFrom: cfg.notifyFrom, configured: cfg.emailSendingDomains }),
    enabled: cfg.sendAsUser,
    provider: cfg.emailProvider,
    replyTo: replyTo || cfg.replyToDefault || null,
  });

  const payload = {
    to: toList,
    cc: ccList,
    subject,
    html: built.html,
    text: built.text,
    headers,
    ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    replyTo: sender.replyTo,
    from: sender.from || undefined,
    // The long-term thread is `lt_order_events`; the short-term Email Center is
    // never written by a long-term send (rule 4).
    _skipCapture: true,
    _ctx: { type: `lt_order_${kind}`, audience: 'staff' },
  };

  let res;
  try {
    try {
      res = await email.sendMail(payload);
    } catch (first) {
      /* UNDER GRAPH a From that is not a real mailbox in the tenant does not degrade —
         the whole send FAILS. A failed order is worse than one from the company
         address, so a send-as-user attempt is retried ONCE as the company with their
         name on it. Only when the rule itself asked for the fallback, and never on an
         ambiguous failure: the provider may already have taken the first message, and
         retrying would deliver the order twice. */
      if (!sender.fallbackOnFailure || orderEmail.isAmbiguousSendFailure(first)) throw first;
      const asCompany = sendAs.senderFor(from || {}, {
        notifyFrom: cfg.notifyFrom, domains: [], enabled: cfg.sendAsUser,
        replyTo: replyTo || cfg.replyToDefault || null,
      });
      console.warn(`[lt-orders] sending as ${sender.from} failed (${(first && first.message) || first}) — retrying from the company address.`);
      res = await email.sendMail({ ...payload, from: asCompany.from || undefined, replyTo: asCompany.replyTo });
      sender.mode = 'company_fallback';
      sender.why = 'The provider refused a send from that person’s own address, so this went from the company address under their name.';
    }
  } catch (e) {
    if (orderEmail.isAmbiguousSendFailure(e)) {
      return {
        ok: false, ambiguous: true, reason: 'send_unconfirmed', messageId, to: toList, cc: ccList,
        message: 'The order may or may not have gone out — the email provider stopped responding while we were sending. '
          + 'Look at the thread before sending it again, so the vendor does not get it twice.',
      };
    }
    return { ok: false, reason: 'send_failed', message: 'Could not send it — the email provider rejected the message.' };
  }
  const verdict = orderEmail.sendVerdict(res);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, message: verdict.message };
  return { ok: true, messageId, to: toList, cc: ccList, subject, sentAs: { mode: sender.mode, from: sender.from, why: sender.why } };
}

/** Record one message on an order's thread. Best-effort by design at the CALLER's
    discretion — a failure here must never be reported as a failed send. */
async function recordEvent(client, order, ev) {
  const { rows } = await client.query(
    `INSERT INTO lt_order_events
       (order_id, loan_id, direction, msg_type, subject, from_email, to_emails, cc_emails,
        body_text, body_html, message_id, in_reply_to, inbound_id, sender_auth,
        attachments, skipped, status, staff_id)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13,
             $14::jsonb,$15::jsonb,$16::jsonb,$17,$18)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [order.id, order.loan_id, ev.direction, ev.msgType || 'message', ev.subject || null,
      ev.fromEmail || null, ev.to || [], ev.cc || [], ev.text || null, ev.html || null,
      ev.messageId || null, ev.inReplyTo || null, ev.inboundId || null,
      JSON.stringify(ev.senderAuth || null), JSON.stringify(ev.attachments || []),
      JSON.stringify(ev.skipped || []), ev.status || null, ev.staffId || null],
  );
  return rows[0] ? rows[0].id : null;
}

/**
 * PLACE AN ORDER.
 *
 * Claim + send inside one transaction; a failed send rolls the claim back. An
 * ambiguous send KEEPS the claim, because the vendor may already have it.
 *
 * @returns never throws; one of
 *   { ok:true, to, cc }
 *   { ok:true, ambiguous:true, warning }
 *   { ok:false, status, error, blockers? }
 */
async function place(loanId, kind, opts = {}) {
  const def = kinds.orderKind(kind);
  if (!def) return { ok: false, status: 404, error: 'There is no such order.' };

  const d = await data.getOrderData(loanId);
  if (!d) return { ok: false, status: 404, error: 'That loan is not here.' };

  const existing = await findOrder(loanId, kind);
  if (existing && existing.status === 'ordered' && !opts.force) {
    return { ok: false, status: 409, error: 'This has already been ordered. Use Follow up, or re-send deliberately.' };
  }

  const blocks = data.blockers(kind, d);
  if (blocks.length) {
    return { ok: false, status: 422, error: data.blockerText(blocks[0]), blockers: blocks, blockerText: blocks.map(data.blockerText) };
  }

  const template = opts.template || null;
  const built = letter.buildLetter(kind, d, { note: opts.note || '', template });
  const replyTo = ltOrderReplyTo(loanId, kind);
  const recips = orderEmail.recipientsFor(kind, d, {
    ccBorrower: opts.ccBorrower,
    ccHelper: opts.ccHelper,
    extraCc: opts.extraCc || [],
    replyTo,
  });

  const client = await db.getClient();
  let claimed = null;
  let sent = null;
  try {
    await client.query('BEGIN');
    const card = (d.vendors || {})[kind];
    const { rows } = await client.query(
      `INSERT INTO lt_file_orders
         (loan_id, kind, status, vendor_contact_id, subject, reply_to,
          cc_borrower, cc_helper, ordered_at, ordered_by, condition_id, meta)
       VALUES ($1::uuid,$2,'ordered',$3::uuid,$4,$5,$6,$7,now(),$8::uuid,$9::uuid,$10::jsonb)
       ON CONFLICT (loan_id, kind) DO UPDATE
         SET status = 'ordered', vendor_contact_id = EXCLUDED.vendor_contact_id,
             subject = EXCLUDED.subject, reply_to = EXCLUDED.reply_to,
             cc_borrower = EXCLUDED.cc_borrower, cc_helper = EXCLUDED.cc_helper,
             ordered_at = now(), ordered_by = EXCLUDED.ordered_by,
             cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL,
             condition_id = COALESCE(EXCLUDED.condition_id, lt_file_orders.condition_id),
             updated_at = now()
       RETURNING *`,
      [String(loanId), kind, (card && card.id) || null, built.subject, replyTo,
        recips.ccBorrower, recips.ccHelper, opts.staffId || null, opts.conditionId || null,
        JSON.stringify({ letterKind: letter.letterKeyFor(kind, d) })],
    );
    claimed = rows[0];

    sent = await sendLetter({
      loanId, kind, built, to: recips.to, cc: recips.cc, replyTo,
      // The person who pressed the button, falling back to the file's own officer —
      // the vendor must always have a real person to answer, and an unattributed
      // order is what makes a title company reply to nobody.
      from: opts.from || { name: opts.fromName || (d.officer && d.officer.name) || null,
        email: opts.fromEmail || (d.officer && d.officer.email) || null },
      threadState: null,
    });
    if (!sent.ok && !sent.ambiguous) {
      await client.query('ROLLBACK');
      return { ok: false, status: 502, error: sent.message, reason: sent.reason };
    }

    await client.query(
      `UPDATE lt_file_orders SET root_message_id = $2, last_message_id = $2, updated_at = now()
        WHERE id = $1::uuid`, [claimed.id, sent.messageId || null]);
    await recordEvent(client, claimed, {
      direction: 'outbound', msgType: 'order', subject: built.subject,
      to: recips.to, cc: recips.cc, text: built.text, html: built.html,
      messageId: sent.messageId, status: sent.ambiguous ? 'unconfirmed' : 'sent',
      staffId: opts.staffId || null,
    });
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the connection is going back either way */ }
    return { ok: false, status: 500, error: `Could not place the order: ${String((e && e.message) || e).slice(0, 200)}` };
  } finally {
    client.release();
  }

  // The condition this order answers moves to 'received' — it has been asked for,
  // which is not the same as satisfied. Best-effort AFTER the commit: a condition
  // that did not move must never un-send an order that went out.
  await markConditionAsked(loanId, def.condition).catch(() => {});

  if (sent.ambiguous) return { ok: true, ambiguous: true, warning: sent.message, to: sent.to, cc: sent.cc };
  return { ok: true, to: sent.to, cc: sent.cc, subject: sent.subject, sentAs: sent.sentAs };
}

/**
 * CHASE AN ORDER — the lighter message, on the same thread.
 *
 * A follow-up stays on the FOOTING of the order it follows (the stored Cc choices),
 * because a vendor chain whose recipient list changes halfway is a chain that splits.
 */
async function followUp(loanId, kind, opts = {}) {
  const def = kinds.orderKind(kind);
  if (!def) return { ok: false, status: 404, error: 'There is no such order.' };
  const order = await findOrder(loanId, kind);
  if (!order || order.status === 'not_ordered') {
    return { ok: false, status: 409, error: 'Nothing has been ordered here yet, so there is nothing to follow up.' };
  }
  if (order.status === 'cancelled') {
    return { ok: false, status: 409, error: 'This order was stood down. Place it again if it is needed.' };
  }
  const d = await data.getOrderData(loanId);
  if (!d) return { ok: false, status: 404, error: 'That loan is not here.' };

  const built = letter.buildLetter(kind, d, { followup: true, note: opts.note || '', template: opts.template || null });
  const replyTo = order.reply_to || ltOrderReplyTo(loanId, kind);
  const recips = orderEmail.recipientsFor(kind, d, {
    ccBorrower: order.cc_borrower, ccHelper: order.cc_helper, extraCc: opts.extraCc || [], replyTo,
  });
  const sent = await sendLetter({
    loanId, kind, built, to: recips.to, cc: recips.cc, replyTo,
    from: opts.from || { name: opts.fromName || (d.officer && d.officer.name) || null,
      email: opts.fromEmail || (d.officer && d.officer.email) || null },
    threadState: { root: order.root_message_id, last: order.last_message_id, subject: order.subject },
    attachments: opts.attachments,
  });
  if (!sent.ok && !sent.ambiguous) return { ok: false, status: 502, error: sent.message, reason: sent.reason };

  try {
    await db.query(
      `UPDATE lt_file_orders SET last_message_id = COALESCE($2, last_message_id),
              last_followup_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [order.id, sent.messageId || null]);
    await recordEvent(db, order, {
      direction: 'outbound', msgType: opts.msgType || 'followup', subject: sent.subject || built.subject,
      to: recips.to, cc: recips.cc, text: built.text, html: built.html,
      messageId: sent.messageId, inReplyTo: order.last_message_id || order.root_message_id || null,
      status: sent.ambiguous ? 'unconfirmed' : 'sent', staffId: opts.staffId || null,
    });
  } catch (_) { /* the message went out; the record is a courtesy and is retried by the thread read */ }

  if (sent.ambiguous) return { ok: true, ambiguous: true, warning: sent.message };
  return { ok: true, to: sent.to, cc: sent.cc, sentAs: sent.sentAs };
}

/**
 * STAND AN ORDER DOWN, with a reason.
 *
 * 'cancelled' is a DECISION, and it is deliberately not 'not_ordered': the two look
 * alike on a screen and mean opposite things to whoever reads the file next — one
 * says nobody has got to it, the other says somebody decided it is not needed and
 * wrote down why.
 */
async function cancel(loanId, kind, opts = {}) {
  const reason = String(opts.reason == null ? '' : opts.reason).trim();
  if (reason.length < 4) {
    return { ok: false, status: 400, error: 'Say why this is being stood down — a few words is enough, and it is what somebody reads a year from now.' };
  }
  const { rows } = await db.query(
    `UPDATE lt_file_orders
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3::uuid,
            cancel_reason = $4, updated_at = now()
      WHERE loan_id = $1::uuid AND kind = $2 RETURNING id, status`,
    [String(loanId), String(kind), opts.staffId || null, reason.slice(0, 500)]);
  if (!rows.length) return { ok: false, status: 404, error: 'There is no such order on this loan.' };
  return { ok: true, order: rows[0] };
}

/** Move an order's condition to 'received' — asked for, not satisfied. Silent when
    the condition is not on the file; an order can be placed before the condition
    engine has run, and refusing on that would be refusing on our own timing. */
async function markConditionAsked(loanId, code) {
  if (!code) return;
  await db.query(
    `UPDATE lt_file_conditions
        SET status = 'received', updated_at = now()
      WHERE loan_id = $1::uuid AND code = $2 AND status = 'outstanding'`,
    [String(loanId), code]);
}

module.exports = {
  desk, thread, place, followUp, cancel, findOrder, sendLetter, recordEvent,
  markConditionAsked, newMessageId,
};
