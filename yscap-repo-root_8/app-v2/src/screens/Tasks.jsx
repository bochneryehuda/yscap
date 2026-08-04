import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import ActionNeeded from '../components/ActionNeeded.jsx';

/* The borrower's own Tasks page (owner-directed second-wave: "move the task list
   off the homepage into its own Tasks section"). The home page is now a clean
   loans view; everything the borrower must DO — signatures, fixes, documents —
   lives here on one screen. <ActionNeeded> already loads /api/borrower/action-items
   in ONE call and renders nothing when there's nothing outstanding, so this screen
   owns the empty state (a plain "all caught up" card) and the framing around it. */
export default function Tasks() {
  const [empty, setEmpty] = useState(null);   // null = loading, true/false once known

  useEffect(() => {
    let live = true;
    api.actionItems()
      .then((d) => { if (live) setEmpty(!(d && Array.isArray(d.items) && d.items.length)); })
      .catch(() => { if (live) setEmpty(true); });   // a failed load shows the calm empty card, never a blank screen
    return () => { live = false; };
  }, []);

  return (
    <>
      <div className="row" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1>Your tasks</h1>
          <p className="muted small">Everything waiting on you, across all your loans, in one place.</p>
        </div>
      </div>

      {/* ActionNeeded renders the task list (and nothing when the list is empty). */}
      <ActionNeeded />

      {empty === true && (
        <div className="panel" style={{ textAlign: 'center', padding: '32px 22px' }}>
          <div style={{ fontSize: 28, marginBottom: 6 }} aria-hidden="true">✓</div>
          <h3 style={{ margin: '0 0 6px' }}>You're all caught up</h3>
          <p className="muted" style={{ margin: '0 0 16px' }}>
            Nothing needs your attention right now. We'll let you know the moment something does.
          </p>
          <Link className="btn ghost" to="/dashboard">Back to your loans</Link>
        </div>
      )}

      {empty === null && <div className="panel muted">Loading…</div>}
    </>
  );
}
