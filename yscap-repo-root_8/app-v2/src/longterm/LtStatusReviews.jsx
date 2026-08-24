import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
import { day } from './format.js';
import { ltApi } from './api.js';

/**
 * WHERE CLICKUP AND ENCOMPASS DISAGREE ABOUT A FILE'S STATUS.
 *
 * Owner-directed 2026-08-24: *"You can open up a general sync review … That should
 * have every Encompass status that does not match with ClickUp status, which means
 * that we need to go and maybe update Encompass, or we need to go manually and
 * update ClickUp."*
 *
 * THE LIST WAS BUILT AND HAD NO SCREEN. `GET /api/lt/clickup/status-reviews` has
 * been recording and serving these rows; nothing rendered them, so the answer
 * existed and no one could reach it — a back end is not a feature.
 *
 * PILOT DOES NOT DECIDE THESE, and the screen says so rather than offering a
 * button that quietly picks a side. A disagreement means either Encompass is
 * behind (fix it there and the next sync carries it) or somebody moved the ClickUp
 * card by hand (fix it there). Both are decisions about the LOAN, not about the
 * sync, and PILOT has no way to tell which happened — so it reports and stops.
 *
 * IT IS WHAT PILOT HAS SEEN, NOT A LIVE SWEEP. The rows are written by the push
 * pass, which already reads each card before writing, so this costs no ClickUp
 * calls and cannot be rate-limited into being wrong — and a file PILOT has not
 * pushed since the disagreement began is simply ABSENT rather than guessed at.
 * That is the honest failure, and the note from the server says it in words.
 *
 * Every colour here is an explicit dark or the brand gold: in this palette every
 * `--ink*` token is a LIGHT paper colour, so one used as a text colour renders
 * white on white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';

export default function LtStatusReviews() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.clickupStatusReviews()
      .then(setData)
      .catch((e) => setErr((e && e.message) || 'Could not read the status disagreements.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <LtLayout title="Status disagreements">
        <div className="card" style={{ color: '#8A2D2D' }}>{err}</div>
        <button type="button" className="btn ghost" style={{ marginTop: 10 }} onClick={load}>Try again</button>
      </LtLayout>
    );
  }
  if (!data) {
    return (
      <LtLayout title="Status disagreements">
        <div className="card" style={{ color: INK }}>Loading…</div>
      </LtLayout>
    );
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];

  return (
    <LtLayout title="Status disagreements">
      <div className="card" style={{ color: INK, marginBottom: 12 }}>
        <p style={{ margin: 0, color: MUTED, fontSize: 13, lineHeight: 1.55 }}>{data.note}</p>
        {/* NO SILENT CAPS. A truncated list that does not say so reads as the
            whole answer. */}
        {data.truncated && (
          <p style={{ margin: '8px 0 0', color: '#8A6A22', fontSize: 12, fontWeight: 600 }}>
            Only the newest {rows.length} are shown — there are more.
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ color: INK }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Nothing disagrees</h2>
          <p style={{ margin: 0, color: MUTED, fontSize: 13, lineHeight: 1.55 }}>
            Every file PILOT has looked at has the same status in ClickUp that its Encompass
            milestones say it should. A file PILOT has not pushed since a disagreement began would
            not be here — this is what we have seen, not a fresh comparison of the whole book.
          </p>
        </div>
      ) : (
        <div className="card" style={{ color: INK, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                {['Loan', 'Borrower', 'ClickUp says', 'Encompass says', 'Milestone', 'Noticed'].map((h) => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '10px 12px', fontSize: 10, fontWeight: 700,
                    letterSpacing: '.12em', textTransform: 'uppercase', color: MUTED,
                    borderBottom: '1px solid rgba(20,27,34,.12)', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={cell}>
                    <Link to={`/internal/lt/loan/${encodeURIComponent(r.loan_id)}`}
                      style={{ color: '#256168', fontWeight: 700, textDecoration: 'underline' }}>
                      {r.loan_number || 'no loan number'}
                    </Link>
                  </td>
                  <td style={cell}>{r.borrower_name || '—'}</td>
                  {/* The two sides side by side, each in its own colour so the eye
                      lands on the difference rather than reading two similar words. */}
                  <td style={{ ...cell, color: '#8A2D2D', fontWeight: 650 }}>{r.clickup_status || '—'}</td>
                  <td style={{ ...cell, color: INK, fontWeight: 750 }}>{r.encompass_status || '—'}</td>
                  <td style={{ ...cell, color: MUTED }}>{r.milestone_name || '—'}</td>
                  <td style={{ ...cell, color: MUTED, whiteSpace: 'nowrap' }}>{day(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ margin: '12px 0 0', color: MUTED, fontSize: 12, lineHeight: 1.55 }}>
        PILOT does not settle these on its own. If Encompass is right, move the ClickUp card by
        hand; if the card is right, the milestone in Encompass needs correcting — and the next
        sync carries it across.
      </p>
    </LtLayout>
  );
}

const cell = {
  padding: '10px 12px', fontSize: 13, color: INK,
  borderBottom: '1px solid rgba(20,27,34,.06)', verticalAlign: 'top',
};
