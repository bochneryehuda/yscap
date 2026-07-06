import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import StaticToolFrame from '../components/StaticToolFrame.jsx';

/* The borrower's general Track Record section — one live record per borrower,
   not tied to any single file. It IS the static Track Record builder, served
   from /tools and bridged to the portal API (track-record-portal.js): every
   add / edit / delete saves to the server as you go, refreshes the saved
   static HTML copy on the profile, and each loan file's experience condition
   reads from this same record.

   The builder sits in a seamless auto-height frame (no box, no inner
   scrollbar) and posts live counts up to this page, so the requirement chips
   update as deals are added — no save, no reload.

   Opened from a file's condition (?app=<id>), "Done — back to my file" also
   submits the track record for that file's condition and returns to it. */

const bucketOf = (dealType) => {
  const t = String(dealType || '').toLowerCase();
  if (t.includes('ground')) return 'ground';
  if (t.includes('flip')) return 'flips';
  return 'holds';
};

export default function TrackRecordScreen() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const appId = params.get('app');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [req, setReq] = useState(null);      // this file's experience requirement
  const [counts, setCounts] = useState(null); // live counts (server rows, then tool sync events)

  useEffect(() => {
    api.trackRecords().then(rows => {
      const c = { flips: 0, holds: 0, ground: 0, total: 0 };
      for (const r of rows || []) { c[bucketOf(r.deal_type)]++; c.total++; }
      setCounts(c);
    }).catch(() => {});
    if (appId) {
      api.application(appId).then(a => setReq({
        flips: Number(a.requested_exp_flips) || 0,
        holds: Number(a.requested_exp_holds) || 0,
        ground: Number(a.requested_exp_ground) || 0,
      })).catch(() => {});
    }
    // The tool reports every server sync — counts stay live while you work.
    const onMsg = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data && e.data.type === 'ys-tr-sync' && e.data.counts) setCounts(e.data.counts);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [appId]);

  async function done() {
    if (!appId) { nav('/dashboard'); return; }
    setBusy(true);
    try {
      // Everything is already autosaved — this also submits the file's
      // track-record condition when the requirement is met.
      const items = await api.checklist(appId).catch(() => []);
      const it = (items || []).find(x => x.tool_key === 'track_record');
      if (it) {
        try { await api.completeTool(appId, it.id, { tool: 'track_record', completedAt: new Date().toISOString() }); }
        catch (e) {
          if (e.status === 422) setNote('Saved — this file still needs more matching experience before the condition clears.');
          // saved either way; head back to the file
        }
      }
    } finally {
      nav(`/app/${appId}`);
    }
  }

  const hasReq = req && (req.flips + req.holds + req.ground > 0);
  const chip = (label, have, need) => {
    const met = have >= need;
    return <span key={label} className={`reqchip ${met ? 'met' : 'short'}`}>{met ? '✓' : ''} {have}/{need} {label}</span>;
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 10, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1>Track record</h1>
          <p className="muted small">
            Your investment experience, documented once and linked to every loan file.
            Every change saves automatically — and keeps a static HTML copy of your record on your profile.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn primary" disabled={busy} onClick={done}>
          {busy ? 'Saving…' : appId ? 'Done — back to my file' : 'Done — back to dashboard'}
        </button>
      </div>
      {counts && (
        <div className="reqchips" style={{ marginBottom: 12 }}>
          {hasReq ? (
            <>
              <span className="muted small">This file needs:</span>
              {req.flips > 0 && chip(`flip${req.flips === 1 ? '' : 's'}`, counts.flips, req.flips)}
              {req.holds > 0 && chip(`hold${req.holds === 1 ? '' : 's'}`, counts.holds, req.holds)}
              {req.ground > 0 && chip('ground-up', counts.ground, req.ground)}
            </>
          ) : (
            <>
              <span className={`reqchip ${counts.total ? 'met' : ''}`}>{counts.total} deal{counts.total === 1 ? '' : 's'} on record</span>
              {counts.flips > 0 && <span className="reqchip">{counts.flips} flip{counts.flips === 1 ? '' : 's'}</span>}
              {counts.holds > 0 && <span className="reqchip">{counts.holds} hold{counts.holds === 1 ? '' : 's'}</span>}
              {counts.ground > 0 && <span className="reqchip">{counts.ground} ground-up</span>}
            </>
          )}
        </div>
      )}
      {note && <div className="notice ok">{note}</div>}
      <StaticToolFrame
        title="Borrower track record"
        src="/tools/track-record.html?portal=1&embed=1"
        minHeight={560}
      />
    </>
  );
}
