import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';

/* The borrower's general Track Record section — one live record per borrower,
   not tied to any single file. It IS the static Track Record builder, served
   from /tools and bridged to the portal API (track-record-portal.js): every
   add / edit / delete saves to the server as you go, and each loan file's
   experience condition reads from this same record.

   Opened from a file's condition (?app=<id>), "Done — back to my file" also
   submits the track record for that file's condition and returns to it. */
export default function TrackRecordScreen() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const appId = params.get('app');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

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

  return (
    <>
      <div className="row" style={{ marginBottom: 10, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1>Track record</h1>
          <p className="muted small">
            Your investment experience, documented once and linked to every loan file.
            Every change saves automatically; your loan team verifies each deal from the documents you attach.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn primary" disabled={busy} onClick={done}>
          {busy ? 'Saving…' : appId ? 'Done — back to my file' : 'Done — back to dashboard'}
        </button>
      </div>
      {note && <div className="notice ok">{note}</div>}
      <iframe
        title="Borrower track record"
        src="/tools/track-record.html?portal=1&embed=1"
        style={{ width: '100%', height: 'calc(100vh - 190px)', minHeight: 640, border: '1px solid var(--line, rgba(127,169,176,.25))', borderRadius: 12, background: 'transparent' }}
      />
    </>
  );
}
