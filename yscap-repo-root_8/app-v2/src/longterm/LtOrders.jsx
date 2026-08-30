import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ltApi } from './api.js';
import { stamp } from './format.js';

/**
 * THE ORDERS DESK, on one loan.
 *
 * Every vendor a long-term file has to ask for something — the title company, the
 * insurance agent, the flood agent, a New York settlement agent, the servicer being
 * paid off, the condo association, the landlord — with the whole conversation on the
 * card, in the Gmail-style box the owner asked for.
 *
 * ── SIX THINGS HERE ARE DELIBERATE ──────────────────────────────────────────
 *
 * 1. THE PREVIEW IS THE LETTER. It is fetched from the SAME builder the send uses,
 *    over the same data, so what is on screen is what the vendor receives. A preview
 *    drawn any other way is a preview of a different letter.
 *
 * 2. A REFUSAL IS THE SERVER'S OWN SENTENCE, printed verbatim, on the card that
 *    caused it. Each blocker means a different thing to do — "nobody is on the file"
 *    sends you to the contacts, "the company is no longer in the directory" sends
 *    you to the vendors screen, "this is switched off" is nobody's to clear — so
 *    collapsing them into "that did not work" throws away the only useful part.
 *
 * 3. A SWITCHED-OFF ORDER IS GREYED WITH ITS REASON, never hidden. The owner asked
 *    for appraisal ordering that way; a feature that silently disappears reads as
 *    one that broke.
 *
 * 4. NOTHING IS EVER SILENTLY DROPPED. A returned document that could not be filed
 *    appears on the message it came in on, with its reason, and the two reasons are
 *    kept apart: a cap means somebody must ask the vendor again, an error means we
 *    are retrying and nobody should.
 *
 * 5. SENDING ASKS FIRST. There is no shared confirm host on this side (that is an
 *    unauthorized crossing, and a second overlay in one app is worse than either),
 *    so the confirmation is INLINE on the card — which is where this repo's own rule
 *    puts a refusal anyway.
 *
 * 6. EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. `--ink*` is a LIGHT paper colour in
 *    this palette — the names are legacy and they lie.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GOLD = '#AE8746';
const GREEN = '#2F6B4F';
const AMBER = '#8A6A17';
const RED = '#8A2D2D';

const STATUS = {
  not_ordered: { label: 'Not ordered', colour: INK, tone: '#FFFFFF' },
  ordered: { label: 'Ordered', colour: AMBER, tone: '#FDF8EC' },
  documents_in: { label: 'Documents in', colour: GREEN, tone: '#F1F7F3' },
  completed: { label: 'Done', colour: GREEN, tone: '#F1F7F3' },
  cancelled: { label: 'Stood down', colour: MUTED, tone: '#F6F5F2' },
};

/* A sender verdict is SHOWN, never a gate. A legitimate reply relayed through a
   list fails SPF routinely, and losing a real title commitment is the expensive
   direction — but the one moment the warning is worth anything is BEFORE somebody
   opens the attachment, so it sits above the message rather than in a detail pane. */
const AUTH_TONE = { pass: GREEN, fail: RED, unknown: MUTED };
const AUTH_WORDS = {
  pass: 'The sender checks out.',
  fail: 'This did NOT pass the sender checks. Look at who it is really from before opening anything.',
  unknown: 'The mail server told us nothing about the sender, so we cannot say either way.',
};

const card = { background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 10, padding: 14, marginBottom: 12 };
const btn = {
  border: `1px solid ${LINE}`, background: '#FFFFFF', color: INK, borderRadius: 8,
  padding: '6px 12px', fontSize: 13, fontWeight: 550, cursor: 'pointer', minHeight: 32,
};
const btnPrimary = { ...btn, background: '#2F7F86', borderColor: '#2F7F86', color: '#FFFFFF' };
const input = {
  width: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: '8px 10px',
  fontSize: 16, color: INK, background: '#FFFFFF', boxSizing: 'border-box',
};

function Pill({ status }) {
  const s = STATUS[status] || STATUS.not_ordered;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 12,
      fontWeight: 600, color: s.colour, background: s.tone, border: `1px solid ${LINE}`,
    }}
    >
      {s.label}
    </span>
  );
}

/** One message on the thread — ours or theirs. */
function Message({ ev }) {
  const inbound = ev.direction === 'inbound';
  const auth = ev.sender_auth && ev.sender_auth.verdict;
  const filed = Array.isArray(ev.attachments) ? ev.attachments : [];
  const skipped = Array.isArray(ev.skipped) ? ev.skipped : [];
  return (
    <div style={{
      borderLeft: `3px solid ${inbound ? GOLD : LINE}`, paddingLeft: 10, marginBottom: 12,
    }}
    >
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 2 }}>
        {inbound ? `From ${ev.from_email || 'the vendor'}` : `We sent this${ev.msg_type === 'followup' ? ' (follow-up)' : ''}`}
        {' · '}
        {stamp(ev.occurred_at)}
        {ev.status === 'unconfirmed' ? ' · the provider never confirmed this one' : ''}
      </div>
      {inbound && auth ? (
        <div style={{ fontSize: 12, color: AUTH_TONE[auth] || MUTED, marginBottom: 4 }}>
          {AUTH_WORDS[auth] || AUTH_WORDS.unknown}
        </div>
      ) : null}
      <div style={{ fontSize: 13, color: INK, fontWeight: 550 }}>{ev.subject || '(no subject)'}</div>
      {ev.body_text ? (
        <div style={{ fontSize: 13, color: INK, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 4 }}>
          {ev.body_text}
        </div>
      ) : null}
      {filed.length ? (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
          Filed:
          {' '}
          {filed.map((a) => `${a.filename}${a.slot ? ` → ${a.slot}` : ''}`).join(', ')}
        </div>
      ) : null}
      {skipped.length ? (
        <div style={{ fontSize: 12, color: AMBER, marginTop: 4 }}>
          {skipped.map((sk, i) => (
            <div key={i}>
              {sk.filename ? `${sk.filename}: ` : ''}
              {sk.why}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OrderCard({ loanId, order, onChanged }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [thread, setThread] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [cancelReason, setCancelReason] = useState('');

  const loadDetail = useCallback(() => {
    setErr(null);
    ltApi.orderPreview(loanId, order.kind, { followup: order.status === 'ordered' })
      .then(setPreview)
      .catch((e) => setErr(e.message || 'Could not build the letter.'));
    if (order.orderId) {
      ltApi.orderThread(loanId, order.kind)
        .then(setThread)
        .catch(() => setThread(null));
    }
  }, [loanId, order.kind, order.orderId, order.status]);

  useEffect(() => { if (open) loadDetail(); }, [open, loadDetail]);

  const run = async (fn, okWords) => {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fn();
      setOk(r && r.warning ? r.warning : okWords);
      setConfirming(null);
      loadDetail();
      onChanged();
    } catch (e) {
      setErr(e.message || 'That did not work.');
    } finally { setBusy(false); }
  };

  const disabled = !order.enabled;
  return (
    <div style={{ ...card, opacity: disabled ? 0.72 : 1 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>{order.label}</div>
          <div style={{ fontSize: 12, color: MUTED }}>
            {order.vendorLabel}
            {order.vendor && !order.vendor.missing
              ? ` · ${order.vendor.company_name || order.vendor.contact_name || 'on the file'}`
              : ' · nobody on the file yet'}
            {order.messages ? ` · ${order.messages} message${order.messages === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Pill status={order.status} />
          <button type="button" style={btn} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Open'}
          </button>
        </div>
      </div>

      {disabled ? (
        <div style={{ fontSize: 13, color: MUTED, marginTop: 8 }}>{order.disabledReason}</div>
      ) : null}

      {!disabled && order.blockerText.length ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: AMBER }}>
          {order.blockerText.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      ) : null}

      {order.status === 'cancelled' && order.cancelReason ? (
        <div style={{ fontSize: 13, color: MUTED, marginTop: 8 }}>
          Stood down —
          {' '}
          {order.cancelReason}
        </div>
      ) : null}

      {open ? (
        <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
          {err ? <div style={{ fontSize: 13, color: RED, marginBottom: 8 }}>{err}</div> : null}
          {ok ? <div style={{ fontSize: 13, color: GREEN, marginBottom: 8 }}>{ok}</div> : null}

          {preview ? (
            <>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
                To:
                {' '}
                {preview.to.join(', ') || '—'}
                {preview.cc.length ? ` · Cc: ${preview.cc.join(', ')}` : ''}
                {preview.replyTo ? ` · replies come back to ${preview.replyTo}` : ''}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>{preview.subject}</div>
              <div style={{
                border: `1px solid ${LINE}`, borderRadius: 8, padding: 10, background: '#FBFAF7',
                fontSize: 13, color: INK, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                maxHeight: 320, overflowY: 'auto',
              }}
              >
                {preview.text}
              </div>
            </>
          ) : <div style={{ fontSize: 13, color: MUTED }}>Building the letter…</div>}

          <label htmlFor={`note-${order.kind}`} style={{ display: 'block', fontSize: 12, color: MUTED, margin: '10px 0 4px' }}>
            Anything to add? (this replaces the opening line)
          </label>
          <textarea
            id={`note-${order.kind}`}
            style={{ ...input, minHeight: 60 }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {order.status === 'not_ordered' || order.status === 'cancelled' ? (
              confirming === 'place' ? (
                <>
                  <span style={{ fontSize: 13, color: INK, alignSelf: 'center' }}>Send this to the vendor now?</span>
                  <button
                    type="button"
                    style={btnPrimary}
                    disabled={busy}
                    onClick={() => run(() => ltApi.orderPlace(loanId, order.kind, { note }), 'Ordered.')}
                  >
                    Yes, send it
                  </button>
                  <button type="button" style={btn} onClick={() => setConfirming(null)}>Not yet</button>
                </>
              ) : (
                <button
                  type="button"
                  style={btnPrimary}
                  disabled={busy || !order.canOrder}
                  onClick={() => setConfirming('place')}
                >
                  Order it
                </button>
              )
            ) : (
              <button
                type="button"
                style={btnPrimary}
                disabled={busy}
                onClick={() => run(() => ltApi.orderFollowUp(loanId, order.kind, { note }), 'Follow-up sent.')}
              >
                {note.trim() ? 'Send this reply' : 'Follow up'}
              </button>
            )}

            {order.status !== 'cancelled' ? (
              confirming === 'cancel' ? (
                <>
                  <input
                    style={{ ...input, width: 260 }}
                    placeholder="Why is this being stood down?"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                  <button
                    type="button"
                    style={btn}
                    disabled={busy}
                    onClick={() => run(() => ltApi.orderCancel(loanId, order.kind, cancelReason), 'Stood down.')}
                  >
                    Stand it down
                  </button>
                  <button type="button" style={btn} onClick={() => setConfirming(null)}>Keep it</button>
                </>
              ) : (
                <button type="button" style={btn} onClick={() => setConfirming('cancel')}>Stand it down</button>
              )
            ) : null}
          </div>

          {thread && thread.events && thread.events.length ? (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
                The conversation
              </div>
              {thread.events.map((ev) => <Message key={ev.id} ev={ev} />)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function LtOrders({ loanId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.orders(loanId)
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not read the orders on this loan.'));
  }, [loanId]);
  useEffect(load, [load]);

  const ready = useMemo(() => (data ? data.orders.filter((o) => o.enabled) : []), [data]);
  const off = useMemo(() => (data ? data.orders.filter((o) => !o.enabled) : []), [data]);

  if (err) return <div style={{ fontSize: 13, color: RED }}>{err}</div>;
  if (!data) return <div style={{ fontSize: 13, color: MUTED }}>Reading the orders…</div>;

  return (
    <div>
      {/* A DEGRADED READ IS NOT AN EMPTY DESK. An empty list reads as "there is
          nothing to order here", which is a claim and would be a wrong one. */}
      {data.degraded ? (
        <div style={{ fontSize: 13, color: AMBER, marginBottom: 10 }}>
          PILOT could not read every order on this loan just now, so some of this may be incomplete.
        </div>
      ) : null}
      {data.unreadable && data.unreadable.length ? (
        <div style={{ fontSize: 13, color: AMBER, marginBottom: 10 }}>
          Some of this loan could not be read:
          {' '}
          {data.unreadable.map((u) => u.what).join(', ')}
          . Orders are held until it can be.
        </div>
      ) : null}

      {ready.map((o) => <OrderCard key={o.kind} loanId={loanId} order={o} onChanged={load} />)}

      {off.length ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
            Built and switched off
          </div>
          {off.map((o) => <OrderCard key={o.kind} loanId={loanId} order={o} onChanged={load} />)}
        </div>
      ) : null}
    </div>
  );
}
