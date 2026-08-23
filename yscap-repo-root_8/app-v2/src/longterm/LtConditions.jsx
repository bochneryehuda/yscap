import React, { useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

/**
 * The Condition Center — SET ASIDE.
 *
 * Owner-directed 2026-08-14: "put the condition center in side for now that center
 * should say colming soom continie building the rest non stop."
 *
 * The screen exists and says so plainly rather than the nav entry vanishing, so
 * nobody hunts for a section they were told about. What it shows is driven by the
 * `conditions.enabled` SETTING, not by a comment in this file — lifting the
 * deferral is a settings change, not a deploy.
 */
export default function LtConditions() {
  const [me, setMe] = useState(null);
  useEffect(() => {
    let alive = true;
    ltApi.me().then((m) => { if (alive) setMe(m); }).catch(() => { if (alive) setMe({}); });
    return () => { alive = false; };
  }, []);

  // Switched ON: the centre itself lives on each LOAN, because a condition is
  // about one file and there is no such thing as a condition list across the
  // book. Rather than leave a nav entry that goes nowhere, this says where it is
  // and takes you there.
  if (me && me.conditionsEnabled) {
    return (
      <LtLayout title="Condition Center">
        <div className="card" style={{ color: '#141B22' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#141B22' }}>It lives on the loan</h2>
          <p style={{ margin: '0 0 12px', color: '#4B585C', lineHeight: 1.55, maxWidth: 560 }}>
            Open a long-term file and pick <strong>Conditions</strong>. You get that loan’s
            conditions with the documents that answer each one, plus its eFolder needs list —
            which is where the work actually is on a live file, since every condition on this
            Encompass instance sits on a loan that has already closed and been sold.
          </p>
          <p style={{ margin: '0 0 14px', color: '#4B585C', lineHeight: 1.55, maxWidth: 560, fontSize: 13 }}>
            It is read-only in both directions: nothing there writes to Encompass, and filing a
            document into the eFolder from PILOT is not switched on.
          </p>
          <a className="btn" href="#/internal/lt">Open the pipeline</a>
        </div>
      </LtLayout>
    );
  }

  return (
    <LtLayout title="Condition Center">
      <div className="card" style={{ textAlign: 'center', padding: '46px 24px', color: '#141B22' }}>
        <div style={{ fontSize: 34, marginBottom: 10 }}>🚧</div>
        <h2 style={{ margin: '0 0 8px', fontSize: 20, color: '#141B22' }}>Coming soon</h2>
        <p style={{ margin: '0 auto', maxWidth: 460, color: '#4B585C', lineHeight: 1.55 }}>
          The Condition Center is set aside while the rest of the long-term side is built.
          Nothing is waiting on it: on this Encompass instance, conditions only ever appear
          on loans that have already closed and been sold — not one active file has any.
        </p>
      </div>
    </LtLayout>
  );
}
