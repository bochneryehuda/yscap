import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { OrderCard } from './LtOrders.jsx';

/**
 * AN ORDER CONDITION IS THE ORDER, not a box to upload the answer into.
 *
 * Owner-reported 2026-08-31: *"Title ordered and insurance ordered now have a
 * file upload. This is a different kind of condition. This condition should be
 * directly linked to the order button, where you can click Order, and it follows
 * the exact thing that happens in the order section: it actually pops up the
 * draft and stuff like that, following the file context that you put in and all
 * the settings that we set for the orders."*
 *
 * ROOT CAUSE OF WHAT WAS THERE: `LtFileConditions` never read `kind`. The
 * library has said `kind: 'order'` on these six conditions since it was written
 * — the renderer drew every condition the same way, so an order, a form and a
 * document all got a drop zone.
 *
 * ── THREE THINGS ARE DELIBERATE ─────────────────────────────────────────────
 *
 * 1. IT MOUNTS `OrderCard` — the orders desk's OWN card, imported, not copied.
 *    Everything the owner listed (the draft preview built by the same builder
 *    the send uses, the recipients off the file contacts, the settings, the
 *    Gmail-style thread, follow-up, stand-down) comes with it and can never
 *    drift from the desk, because there is only one of it.
 *
 * 2. A CONDITION WHOSE ORDER DOES NOT BELONG TO THIS FILE IS GREYED, NOT GONE
 *    — *"It should be visible that it's not for this file."* The reason comes
 *    from the server (`order.enabled` / `order.disabledReason`), so the card and
 *    this notice can never explain the same fact two different ways.
 *
 * 3. AN UNREADABLE DESK SAYS SO. A failed read renders the reason, never an
 *    empty space that reads as "there is nothing to order here" — which is a
 *    claim, and would be the wrong one.
 */

const MUTED = '#4B585C';
const RED = '#8A2D2D';
const AMBER = '#8A6A17';
const LINE = '#E6E1D6';

export default function LtConditionOrder({ loanId, condition, onChanged }) {
  const kind = condition && condition.config && condition.config.orderType;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    if (!kind) return;
    setErr(null);
    ltApi.orders(loanId)
      .then(setData)
      .catch((e) => setErr((e && e.message) || 'Could not read this order just now.'));
  }, [loanId, kind]);
  useEffect(load, [load]);

  // Self-hiding: every other kind of condition renders nothing from here, so an
  // ordinary document row is untouched.
  if (!kind) return null;

  if (err) {
    return (
      <div style={{ marginTop: 12, fontSize: 13, color: RED, lineHeight: 1.5 }}>
        {err}{' '}
        <button type="button" className="btn ghost small" onClick={load} style={{ marginLeft: 6 }}>Try again</button>
      </div>
    );
  }
  if (!data) return <div style={{ marginTop: 12, fontSize: 13, color: MUTED }}>Reading this order…</div>;

  const order = (data.orders || []).find((o) => o.kind === kind) || null;
  if (!order) {
    /* The condition names an order the desk does not carry. That is a wiring
       mistake of ours and it is SAID rather than hidden — an order condition
       with nothing under it reads as a broken screen. */
    return (
      <div style={{ marginTop: 12, fontSize: 13, color: AMBER, lineHeight: 1.5 }}>
        This condition is set up to order “{kind}”, and the orders desk on this loan does not
        carry that order. Nobody can send it from here until that is corrected.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
        color: MUTED, fontWeight: 700, marginBottom: 6 }}>The order</div>
      <OrderCard loanId={loanId} order={order} onChanged={() => { load(); if (onChanged) onChanged(); }} />
      <p style={{ margin: '8px 2px 0', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
        This is the same order that appears on the Orders desk — one order, shown in both places.
        {order.docCondition ? ' What comes back is filed on the matching documents condition.' : ''}
      </p>
      <div style={{ borderTop: `1px solid ${LINE}`, marginTop: 12 }} />
    </div>
  );
}
