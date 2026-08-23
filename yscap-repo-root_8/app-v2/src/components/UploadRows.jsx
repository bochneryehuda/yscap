import React, { useEffect, useState } from 'react';
import { subscribe, rowsFor, dismissUpload } from '../lib/upload-progress.js';

/* =====================================================================
   UploadRows — the document, on its bar, before it has finished uploading.

   THE ASK (owner-reported 2026-08-23): *"in the condition center, you upload a
   document. It waits till it actually uploads a document, and only then does it
   populate. The professional system works that way: the second you upload a
   document, while the system is working to upload, it already has the document
   over there with a bar and a percentage. You should see that the system is
   actually doing work for you. … It's on the same bar where the document will
   land afterwards. You can put the name of the document already on the bar,
   with the percentage of where the document is up to."*

   So this is deliberately NOT a toast, a corner spinner, or a modal. It is a row
   that looks like a document row and sits EXACTLY where the finished document
   will appear, carrying the file's real name from the moment it is chosen. The
   bar fills behind the name rather than beside it, so the row is the progress
   indicator instead of merely containing one — the document arrives in place and
   fills in, which is what makes it read as work rather than as a wait.

   USING IT is one line at each upload surface:

       <UploadRows target={`condition:${item.id}`} />

   placed where the document list renders. The transport (lib/api.js →
   lib/upload-progress.js) files each row under a target derived from the
   upload's own metadata, so nothing else has to be passed and no upload site has
   to remember to report anything.

   HONESTY RULES, because a progress bar that lies is worse than none:
     · The percentage is real bytes sent, from XMLHttpRequest.
     · It stops at 99% when the last byte leaves this machine. The server has not
       stored the file yet, so the row switches to "Saving…" instead of claiming
       100% and then sitting there — a bar parked at 100% reads as stuck.
     · 100% means the server said yes. The row lingers a moment so it can be seen,
       then gets out of the way of the real document row.
     · A FAILURE stays on screen with the server's own reason until it is
       dismissed. A silent failure is the same defect as a silent upload.
   ===================================================================== */

const fmtSize = (n) => (!n ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function UploadRows({ target, className = '' }) {
  const [all, setAll] = useState([]);
  useEffect(() => subscribe(setAll), []);
  const rows = rowsFor(target, all);
  if (!rows.length) return null;
  return (
    <div className={`upr-list ${className}`.trim()} aria-live="polite">
      {rows.map((r) => <UploadRow key={r.id} row={r} />)}
    </div>
  );
}

function UploadRow({ row }) {
  const failed = row.status === 'error';
  const done = row.status === 'done';
  const saving = row.status === 'processing';
  const pct = row.pct;
  const determinate = pct != null && !failed;

  let note;
  if (failed) note = row.error;
  else if (done) note = 'Uploaded';
  else if (saving) note = 'Saving…';
  else if (determinate) note = `${pct}%${row.size ? ` of ${fmtSize(row.size)}` : ''}`;
  else note = 'Uploading…';

  return (
    <div className={`upr-row${failed ? ' is-error' : ''}${done ? ' is-done' : ''}`}>
      {/* the fill sits BEHIND the content, so the row itself is the bar */}
      <div className={`upr-fill${determinate ? '' : ' is-indeterminate'}`}
        style={determinate ? { width: `${done ? 100 : pct}%` } : undefined} aria-hidden="true" />
      <div className="upr-body">
        <span className="upr-icon" aria-hidden="true">{failed ? '!' : done ? '✓' : '↑'}</span>
        <span className="upr-name" title={row.filename}>{row.filename}</span>
        <span className="upr-note">{note}</span>
        {failed && (
          <button type="button" className="upr-x" onClick={() => dismissUpload(row.id)}
            title="Dismiss" aria-label="Dismiss this failed upload">✕</button>
        )}
      </div>
      {/* The screen-reader announcement is the row's meaning, not its geometry. */}
      <span className="sr-only">
        {failed ? `Upload of ${row.filename} failed: ${row.error}`
          : done ? `${row.filename} uploaded`
          : determinate ? `Uploading ${row.filename}, ${pct} percent`
          : `Uploading ${row.filename}`}
      </span>
    </div>
  );
}
