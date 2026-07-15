import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { subscribeChat } from '../lib/chatEvents.js';
import StaticToolFrame from '../components/StaticToolFrame.jsx';

// Ask every embedded Track Record tool on the page to pull the server's fresh
// truth in (#112 live cross-user refresh). The tool ignores this while the local
// user is mid-edit, so it never clobbers in-progress work.
function reloadTrackRecordFrames() {
  document.querySelectorAll('iframe').forEach((f) => {
    try { if (f.contentWindow) f.contentWindow.postMessage({ type: 'ys-tr-reload' }, window.location.origin); }
    catch { /* cross-origin frame — not ours */ }
  });
}

/* The borrower's general Track Record section — one live record per borrower,
   not tied to any single file. It IS the static Track Record builder, served
   from /tools and bridged to the portal API (track-record-portal.js): every
   add / edit / delete saves to the server as you go, refreshes the saved
   static HTML copy on the profile, and each loan file's experience condition
   reads from this same record.

   It opens as the SAME full-screen tool sheet as the Rehab Budget: an
   edge-to-edge page takeover with a slim sticky header, the requirement chips
   in a sub-bar, and a Done button that saves and returns — whether you arrive
   from a file's condition (?app=<id>, Done also submits that condition) or
   from the Profile / nav. */

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

  // #112 live cross-user refresh: when a staffer changes THIS borrower's track
  // record, the server pushes a track_record:updated event. Reload the embedded
  // tool and refresh the requirement counts so the borrower sees it without a
  // page reload. (Our own edits are excluded server-side, so this never fires on
  // top of what we just typed — and the tool defers if a form is open.)
  useEffect(() => {
    const unsub = subscribeChat((event) => {
      if (event !== 'track_record:updated') return;
      api.trackRecords().then((rows) => {
        const c = { flips: 0, holds: 0, ground: 0, total: 0 };
        for (const r of rows || []) { c[bucketOf(r.deal_type)]++; c.total++; }
        setCounts(c);
      }).catch(() => {});
      reloadTrackRecordFrames();
    });
    return unsub;
  }, []);

  // The sheet takes the page over — the portal chrome behind it must not scroll.
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') done(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
    /* eslint-disable-next-line */
  }, [appId]);

  async function done() {
    if (busy) return;
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
    <div className="toolsheet" role="dialog" aria-modal="true" aria-label="Borrower track record">
      <header className="toolsheet-head">
        <button className="toolsheet-back" aria-label={appId ? 'Save and go back to your file' : 'Save and go back to your dashboard'}
          disabled={busy} onClick={done}>←</button>
        <div className="toolsheet-titles">
          <strong>Track record &amp; experience</strong>
          <span className="muted small">Every change saves automatically — one record, linked to every loan file.</span>
        </div>
        <button className="btn primary toolsheet-done" disabled={busy} onClick={done}>
          {busy ? 'Saving…' : appId ? 'Done — back to my file' : 'Done'}
        </button>
      </header>
      {(counts || note) && (
        <div className="toolsheet-sub">
          {note && <span className="small" style={{ color: 'var(--ok)' }}>{note}</span>}
          {counts && (hasReq ? (
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
          ))}
        </div>
      )}
      <div className="toolsheet-body scroll">
        <div className="toolsheet-inner">
          <StaticToolFrame
            title="Borrower track record"
            src="/tools/track-record.html?portal=1&embed=1"
            minHeight={560}
          />
        </div>
      </div>
    </div>
  );
}
