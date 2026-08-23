import React, { useCallback, useEffect, useRef, useState } from 'react';
import PdfViewer from './PdfViewer.jsx';
import { saveBlob } from '../lib/api.js';

/* =====================================================================
   ReportOpener — opening a draw report without a blank page.

   THE DEFECT (owner-reported 2026-08-23): *"When I'm clicking on the draw
   center to open up our draw report … it's going to a blank page. It takes a
   very long time, and sometimes it's not even opening. … it should not sit on
   a blank page. It should not make it seem like it's an error. If it needs
   time, in the pilot, you should see that it takes time loading … Once it's
   finished, you should see that it is actually doing anything and it should
   populate right away."*

   WHY IT LOOKED BROKEN — and it is worth being exact, because the old shape
   looks reasonable until you time it:

       const w = window.open('', '_blank');        // ← a blank tab, RIGHT NOW
       await api.sitewireDrawReport(...)           // ← 5–40s: render + download
       w.location.href = blobUrl;                  // ← the tab finally fills

   The tab is opened first on purpose (a popup blocker rejects a `window.open`
   that is not inside the click). But that means the very first thing the user
   sees is an empty white page owned by the BROWSER, not by PILOT — so there is
   nowhere to put a spinner, a percentage, or an error. Every one of the
   owner's three complaints is that one decision: it is blank, it looks broken,
   and if the request fails the tab just sits there forever.

   WHAT THIS DOES INSTEAD. It stays in PILOT and shows the work:

     1. ASK FIRST. A cheap status probe answers "is this report already built?"
        before any bytes move. Already built → the panel opens in well under a
        second. Not built → we know a render is coming AND how big it is, so
        the panel can say "Building the report — 43 photos across 12 lines"
        instead of implying something is stuck.
     2. SHOW REAL PROGRESS, AND ONLY REAL PROGRESS. Two honest phases. While
        the server renders, no byte has arrived, so there is no percentage to
        report — the bar is indeterminate and a timer counts up. Once bytes
        start arriving the same bar becomes a true percentage from
        Content-Length. A bar that creeps to 90% and waits is a lie, and it is
        the lie that makes people think a system is broken.
     3. RENDER IT HERE. The finished PDF opens in the app's own PDF.js viewer,
        so there is no popup to be blocked and nothing to navigate back from.
        "Open in a new tab" and "Download" are still there for whoever wants
        them — now as a choice rather than the only path.
     4. FAIL OUT LOUD. A failure shows the server's own reason with a Try again
        button, in the panel. It never leaves a white rectangle behind.

   The server side of this fix is in src/sitewire/draw-report.js: two clicks on
   the same report now share ONE render instead of starting two, which is what
   "sometimes it's not even opening" actually was — a synchronous PDF render
   holding the event loop while a second identical one queued behind it.
   ===================================================================== */

const fmtBytes = (n) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Drives one report open. Returns `{ start, node, busy }`:
 *   start({ status, fetch, title, subtitle })  — both are async functions;
 *                                                `status` may be omitted.
 *   node                                        — render this once in the tree.
 */
export function useReportOpener() {
  const [job, setJob] = useState(null);
  // { title, subtitle, phase, pct, received, total, startedAt, error, blob, filename, retry }
  const tickRef = useRef(null);
  const [, forceTick] = useState(0);

  // A visible elapsed-seconds counter while the server renders. This is the only
  // honest thing to show in that phase, and showing SOMETHING that moves is the
  // difference between "working" and "broken" to the person watching.
  useEffect(() => {
    if (job && !job.blob && !job.error) {
      tickRef.current = setInterval(() => forceTick((n) => n + 1), 500);
      return () => clearInterval(tickRef.current);
    }
    return undefined;
  }, [job && !!job.blob, job && !!job.error, job && job.startedAt]);

  const run = useCallback(async (spec) => {
    const startedAt = Date.now();
    setJob({
      title: spec.title || 'Report', subtitle: spec.subtitle || '',
      phase: 'checking', pct: null, received: 0, total: null,
      startedAt, error: null, blob: null, filename: null, spec,
    });
    try {
      // 1 — the cheap probe. A failure here is NOT fatal: it only costs us the
      // nicer message, so fall through and fetch anyway rather than refuse.
      let st = null;
      if (spec.status) { try { st = await spec.status(); } catch (_) { st = null; } }
      if (st && st.exists === false) {
        setJob((j) => (j && j.startedAt === startedAt ? { ...j, phase: 'error', error: st.reason || 'There is nothing to report on yet.' } : j));
        return;
      }
      setJob((j) => (j && j.startedAt === startedAt
        ? { ...j, phase: st && st.ready ? 'opening' : 'building', ready: !!(st && st.ready), photos: st ? st.photos : null, lines: st ? st.lines : null, total: st && st.sizeBytes ? st.sizeBytes : null }
        : j));

      // 2 — the bytes, with progress.
      const { blob, filename } = await spec.fetch((p) => {
        setJob((j) => {
          if (!j || j.startedAt !== startedAt) return j;
          // Only move OFF "building" once a byte has actually arrived. Until then
          // the server is still rendering and there is nothing to be a percentage of.
          const phase = p.phase === 'receiving' ? 'receiving' : j.phase;
          return { ...j, phase, pct: p.pct, received: p.received, total: p.total != null ? p.total : j.total };
        });
      });
      setJob((j) => (j && j.startedAt === startedAt ? { ...j, phase: 'ready', pct: 100, blob, filename } : j));
    } catch (e) {
      const msg = (e && e.data && (e.data.error || e.data.message)) || (e && e.message) || 'The report could not be opened.';
      setJob((j) => (j && j.startedAt === startedAt ? { ...j, phase: 'error', error: msg } : j));
    }
  }, []);

  const close = useCallback(() => setJob(null), []);
  const node = job ? <ReportPanel job={job} onClose={close} onRetry={() => run(job.spec)} /> : null;
  return { start: run, node, busy: !!job && !job.blob && !job.error };
}

function ReportPanel({ job, onClose, onRetry }) {
  const [data, setData] = useState(null);          // ArrayBuffer for PdfViewer
  const [viewerFailed, setViewerFailed] = useState(false);
  const shellRef = useRef(null);

  useEffect(() => {
    let alive = true;
    if (job.blob) { job.blob.arrayBuffer().then((b) => { if (alive) setData(b); }).catch(() => { if (alive) setViewerFailed(true); }); }
    return () => { alive = false; };
  }, [job.blob]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev; };
  }, [onClose]);

  const secs = Math.floor((Date.now() - job.startedAt) / 1000);
  const determinate = job.phase === 'receiving' && job.pct != null;
  const done = job.phase === 'ready';

  let line;
  if (job.phase === 'error') line = job.error;
  else if (done) line = `Ready${job.total ? ` · ${fmtBytes(job.total)}` : ''}`;
  else if (job.phase === 'receiving') line = job.pct != null
    ? `Downloading — ${job.pct}%` : `Downloading — ${fmtBytes(job.received)}`;
  else if (job.phase === 'building') line = job.photos
    ? `Building the report — ${job.photos} photo${job.photos === 1 ? '' : 's'} across ${job.lines} line${job.lines === 1 ? '' : 's'}. This can take a moment.`
    : 'Building the report. This can take a moment.';
  else if (job.phase === 'opening') line = 'Opening the report…';
  else line = 'Checking the report…';

  function openInTab() {
    if (!job.blob) return;
    const url = URL.createObjectURL(job.blob);
    const w = window.open(url, '_blank');
    if (!w) saveBlob(job.blob, job.filename || 'report.pdf');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  return (
    <div className="rpt-backdrop" role="dialog" aria-modal="true" aria-label={job.title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rpt-shell" ref={shellRef}>
        <div className="rpt-head">
          <div className="rpt-head-text">
            <div className="rpt-title">{job.title}</div>
            {job.subtitle ? <div className="rpt-sub">{job.subtitle}</div> : null}
          </div>
          {done && (
            <>
              <button type="button" className="btn btn-sm ghost" onClick={openInTab}>Open in a new tab</button>
              <button type="button" className="btn btn-sm ghost" onClick={() => saveBlob(job.blob, job.filename || 'report.pdf')}>Download</button>
            </>
          )}
          <button type="button" className="rpt-x" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </div>

        {/* THE PROGRESS LINE — always present until the document is on screen, so
            there is never a blank rectangle where the report should be. */}
        {!done && (
          <div className={`rpt-progress${job.phase === 'error' ? ' is-error' : ''}`}>
            <div className="rpt-progress-row">
              <span className="rpt-progress-text">{line}</span>
              {job.phase !== 'error' && <span className="rpt-progress-secs">{secs}s</span>}
            </div>
            {job.phase !== 'error' && (
              <div className={`rpt-bar${determinate ? '' : ' is-indeterminate'}`} role="progressbar"
                aria-valuenow={determinate ? job.pct : undefined} aria-valuemin={0} aria-valuemax={100}
                aria-label={line}>
                <div className="rpt-bar-fill" style={determinate ? { width: `${job.pct}%` } : undefined} />
              </div>
            )}
            {job.phase === 'error' && (
              <div className="rpt-actions">
                <button type="button" className="btn btn-sm primary" onClick={onRetry}>Try again</button>
                <button type="button" className="btn btn-sm ghost" onClick={onClose}>Close</button>
              </div>
            )}
          </div>
        )}

        <div className="rpt-body">
          {done && data && !viewerFailed && <PdfViewer data={data} onError={() => setViewerFailed(true)} />}
          {done && viewerFailed && (
            <div className="rpt-msg">
              <div className="rpt-msg-h">The report was built, but it can’t be shown here.</div>
              <div className="rpt-msg-p">Open it in a new tab or download it — the file itself is fine.</div>
              <div className="rpt-actions">
                <button type="button" className="btn btn-sm primary" onClick={openInTab}>Open in a new tab</button>
                <button type="button" className="btn btn-sm ghost" onClick={() => saveBlob(job.blob, job.filename || 'report.pdf')}>Download</button>
              </div>
            </div>
          )}
          {done && !data && !viewerFailed && <div className="rpt-msg"><div className="rpt-spin" /><div className="rpt-msg-p">Rendering…</div></div>}
        </div>
      </div>
    </div>
  );
}

export default ReportPanel;
