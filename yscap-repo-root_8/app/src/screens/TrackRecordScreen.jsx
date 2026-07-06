import React from 'react';

/* The borrower's general Track Record section — one live record per borrower,
   not tied to any single file. It IS the static Track Record builder, served
   from /tools and bridged to the portal API (track-record-portal.js): every
   add / edit / delete saves to the server, and each loan file's experience
   condition reads from this same record. */
export default function TrackRecordScreen() {
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div>
          <h1>Track record</h1>
          <p className="muted small">
            Your investment experience, documented once and linked to every loan file.
            Changes save automatically; your loan team verifies each deal from the documents you attach.
          </p>
        </div>
      </div>
      <iframe
        title="Borrower track record"
        src="/tools/track-record.html?portal=1&embed=1"
        style={{ width: '100%', height: 'calc(100vh - 190px)', minHeight: 'min(640px, 78vh)', border: '1px solid var(--line, rgba(127,169,176,.25))', borderRadius: 12, background: 'transparent' }}
      />
    </>
  );
}
