import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';
import { subscribeChat } from '../lib/chatEvents.js';
import StaticToolFrame from '../components/StaticToolFrame.jsx';
import ConfirmFoundProperties from '../components/ConfirmFoundProperties.jsx';

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
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState('');   // the server's own borrower-safe summary
  const [confirmKey, setConfirmKey] = useState(0);    // remounts ConfirmFoundProperties after a search

  const refreshCounts = () => api.trackRecords().then((rows) => {
    const c = { flips: 0, holds: 0, ground: 0, total: 0 };
    for (const r of rows || []) { c[bucketOf(r.deal_type)]++; c.total++; }
    setCounts(c);
  }).catch(() => {});

  useEffect(() => {
    refreshCounts();
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
      refreshCounts();
      reloadTrackRecordFrames();
    });
    return unsub;
    /* eslint-disable-next-line */
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

  /* The borrower's own public-records search (owner-directed 2026-08-19: "also
     on the borrower side, they can click the search button on themselves and
     import their entire track record"). One button: the server runs the SAME
     records search our team runs (never a bare personal-name lookup — the
     server enforces that), imports what it can, and stages the rest in the
     confirm section below. The note shown afterwards is the server's own
     borrower-safe summary — this screen never words an outcome itself. */
  async function runRecordsSearch() {
    if (searching) return;
    const go = await askConfirm(
      'We will look through the county public records for past projects connected to you and your '
      + 'companies, and add what we find to your track record. Anything we are not sure about will '
      + 'wait below for you to confirm.\n\nRun the search now?',
      { title: 'Search the public records', confirmLabel: 'Search the records' },
    );
    if (!go) return;
    setSearching(true);
    setSearchNote('');
    try {
      const out = await api.borrowerTrackRecordSearch();
      setSearchNote((out && out.summary) || 'The search finished.');
      if (out && out.ran) {
        reloadTrackRecordFrames();
        refreshCounts();
        setConfirmKey((k) => k + 1);
      }
    } catch (e) {
      setSearchNote((e && e.message) || 'The search could not run right now — please try again in a few minutes.');
    } finally {
      setSearching(false);
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
          {/* Properties our team found in the public records, for the borrower
              to confirm (§9.4). It sits ABOVE the builder and the builder is
              NOT touched — blueprint §12 keeps the borrower's own tool as it is,
              so this is an addition alongside it, never a rewrite. Answering
              writes a line server-side, so the tool below is told to re-read
              rather than being edited from here. It renders nothing at all when
              there is nothing to confirm, which is the ordinary case. */}
          {/* The borrower's own records search — a card, above the confirm
              section it feeds. Explicit dark text per the hard rule. */}
          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <strong style={{ color: '#141B22' }}>Fill in my track record from the public records</strong>
                <p className="muted small" style={{ margin: '4px 0 0' }}>
                  We check the county public records for past projects connected to you and your
                  companies and add them here — anything we are not sure about waits for you to confirm.
                </p>
              </div>
              <button className="btn primary" disabled={searching} onClick={runRecordsSearch}>
                {searching ? 'Searching the records…' : 'Search the records for my projects'}
              </button>
            </div>
            {searchNote && (
              <div className="notice" style={{ marginTop: 8 }}>
                <span style={{ color: '#141B22' }}>{searchNote}</span>
              </div>
            )}
          </div>
          <ConfirmFoundProperties key={`cfp-${confirmKey}`} onChanged={() => {
            reloadTrackRecordFrames();
            refreshCounts();
          }} />
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
