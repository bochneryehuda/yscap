import React, { useCallback, useEffect, useState } from 'react';
import { subscribeChat } from '../../lib/chatEvents.js';
import { arena } from '../../lib/arena.js';

/* WHO IS IN THE ROOM — live, along the top of the stage.
 *
 * The owner: "a 'who's in the room' bar showing who's checked in and online,
 * live." It is the cheapest thing in the whole Arena and it does more for the
 * feeling of a live event than anything else on the screen: a spin with a bar
 * that says fourteen people are watching is an event; the same spin with no bar
 * is a web page.
 *
 * ── THE TWO STATES ARE DIFFERENT THINGS, AND THE BAR SAYS SO ───────────────
 *   IN THE SPIN   they checked in and a super admin approved it — they are on
 *                 the wheel, whether or not they are at their desk right now.
 *   HERE          the Arena is open on a screen of theirs this second.
 * Somebody can be either without the other, and rolling them into one number
 * would quietly tell the room a lie about who is actually in the draw. So the
 * chip carries a tick for the first and a dot for the second, and the counts
 * are stated separately.
 *
 * ── WHY IT POLLS ───────────────────────────────────────────────────────────
 * Everything else here is driven by the live stream, but nobody BROADCASTS
 * "I opened a tab" — presence is derived from the open connections themselves.
 * So this refreshes on every Arena frame (a check-in, a spin, a landing) AND on
 * a slow timer for the presence half. Twenty seconds is often enough to feel
 * live and rare enough to cost nothing.
 */
export default function ArenaRoomBar({ sessionId }) {
  const [room, setRoom] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try { setRoom(await arena.room(sessionId)); } catch (_) { /* the bar is never the reason a screen breaks */ }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeChat((event) => {
    if (event.startsWith('arena:') || event === 'reconnect') load();
  }), [load]);
  useEffect(() => {
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  if (!room || !room.people || !room.people.length) return null;
  const c = room.counts || {};
  // The bar shows a face-up row; the rest is one click away rather than a wall
  // of names on a screen whose main job is a wheel.
  const shown = open ? room.people : room.people.slice(0, 12);
  const more = room.people.length - shown.length;

  return (
    <div className="arena-roombar">
      <div className="arena-roombar-head">
        <strong>
          <span className="arena-roombar-dot" aria-hidden="true" />
          {c.here} here
        </strong>
        <span>{c.checkedIn} in the spin</span>
        {c.waitingOnApproval > 0 && (
          <span className="arena-roombar-wait">{c.waitingOnApproval} waiting to be waved in</span>
        )}
        <button type="button" className="linklike" onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show everyone (${room.people.length})`}
        </button>
      </div>
      <ul className="arena-roombar-list">
        {shown.map((p) => (
          <li
            key={p.id}
            className={`arena-roombar-chip${p.here ? ' here' : ''}${p.checkedIn ? ' in' : ''}`}
            title={`${p.name}${p.checkedIn ? ' — in the spin' : ''}${p.here ? ' — here now' : ''}`}
          >
            {p.checkedIn && <span className="arena-roombar-tick" aria-hidden="true">✓</span>}
            {p.name}
          </li>
        ))}
        {more > 0 && <li className="arena-roombar-chip more">+{more}</li>}
      </ul>
    </div>
  );
}
