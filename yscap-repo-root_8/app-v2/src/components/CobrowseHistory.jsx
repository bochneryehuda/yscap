import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* THE CO-BROWSE REGISTER (owner-directed 2026-09-02; Phase C). Who watched whose
   screen, when, whether they were let in, whether they were given control, and how
   it ended. Read from GET /api/cobrowse/history — a super admin sees everything,
   everybody else only the sessions they were party to (the server decides; this
   screen only draws). Nothing here is the screen itself: the register holds counts.

   Text colours are explicit darks per the HARD RULE. */
const INK = '#141B22', MUTED = '#4B585C';

const STATUS = {
  requested: 'Waiting for an answer', active: 'Live now', declined: 'Declined', expired: 'Not answered', ended: 'Ended',
};
const END = {
  stopped_by_guest: 'they stopped it', stopped_by_viewer: 'the viewer ended it', guest_left: 'they closed PILOT',
  viewer_left: 'the viewer left', expired: 'time limit / restart', request_expired: 'no answer', superseded: 'replaced by a newer session',
  signed_out: 'they signed out', revoked: 'revoked',
};
const RELEASE = {
  guest_moved: 'they took it back by moving', guest_stop: 'they pressed Take back / Stop', viewer_release: 'the viewer handed it back',
  request_expired: 'control request not answered', session_ended: 'session ended', guest_refused: 'they said no',
};

function when(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}
function mins(a, b) {
  if (!a || !b) return null;
  const m = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return m < 1 ? '<1 min' : `${m} min`;
}

export default function CobrowseHistory({ limit = 50 }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.cobrowseHistory(limit).then((r) => { if (alive) setRows((r && r.sessions) || []); }).catch((e) => { if (alive) setErr(e.message || 'Could not read the register.'); });
    return () => { alive = false; };
  }, [limit]);

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-h">
        <h3>Co-browse register</h3>
        <span className="small" style={{ color: MUTED }}>Who watched whose screen, with whose consent, and how it ended. The screen itself is never kept.</span>
      </div>
      <div className="panel-b" style={{ overflowX: 'auto' }}>
        {err && <div className="notice err">{err}</div>}
        {rows == null && !err && <div className="muted small">Loading…</div>}
        {rows && !rows.length && <div className="small" style={{ color: MUTED }}>Nobody has co-browsed yet.</div>}
        {rows && rows.length > 0 && (
          <table className="table" style={{ minWidth: 720, color: INK }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Asked</th>
                <th style={{ textAlign: 'left' }}>Viewer</th>
                <th style={{ textAlign: 'left' }}>Watched</th>
                <th style={{ textAlign: 'left' }}>Outcome</th>
                <th style={{ textAlign: 'left' }}>Control</th>
                <th style={{ textAlign: 'right' }}>Length</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="small">{when(s.requestedAt)}</td>
                  <td>{s.viewer && s.viewer.name}</td>
                  <td>{s.watched && s.watched.name} <span className="small" style={{ color: MUTED }}>({s.watched && s.watched.kind === 'borrower' ? 'borrower' : 'team'})</span></td>
                  <td className="small">
                    {STATUS[s.status] || s.status}
                    {s.endReason ? ` — ${END[s.endReason] || s.endReason}` : ''}
                    {s.redactionDrops ? ` · ${s.redactionDrops} frame${s.redactionDrops === 1 ? '' : 's'} held back` : ''}
                  </td>
                  <td className="small">
                    {s.controlGrants ? `given ${s.controlGrants}× · ${s.controlEvents} action${s.controlEvents === 1 ? '' : 's'}${s.controlReleaseReason ? ` · ${RELEASE[s.controlReleaseReason] || s.controlReleaseReason}` : ''}` : 'watch only'}
                  </td>
                  <td className="small" style={{ textAlign: 'right' }}>{mins(s.consentedAt || s.startedAt, s.endedAt) || (s.status === 'active' ? 'live' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
