import React, { useState } from 'react';
import { api } from '../../lib/api.js';

/* DOWNLOAD THE BORROWER'S TRACK RECORD — Excel or PDF, in one of three scopes
   (owner-directed 2026-08-21, item 7).

   The owner: *"the regular export button (PDF or Excel) should only export the
   verified ones. There should be an extra option to export the PDF or an Excel
   from the unverified ones, but everything that is unverified should have a
   stamp that it's not verified yet, and it still needs to go through
   verification."*

   ONE CONTROL, MOUNTED WHEREVER THE RECORD IS SHOWN — the loan file's Track
   record section, the borrower profile's Track record tab, and the full-screen
   workspace. Three surfaces, one component: an option added here appears on all
   three at once, so they can never offer different exports of one record.

   THE VERIFIED EXPORT IS THE REGULAR ONE and leads, exactly as the owner
   described it. The other two sit behind the same disclosure rather than in the
   header row: six look-alike buttons across a header is the "row of identical
   buttons is not a design" shape this repo bans.

   THE WORDING BELOW IS A MIRROR of `src/lib/track-record/export-scope.js`
   SCOPE_META (a browser file cannot require server code — the lib/payoff.js
   arrangement). `scripts/test-export-scope-pure.js` reads BOTH files and fails
   the moment they disagree, so the button a staffer presses can never promise
   something different from what the document says about itself. */

/* MIRROR — keep in step with SCOPE_META (button + note), in the order a chooser
   should offer them (SCOPES). */
const SCOPES = [
  {
    key: 'verified',
    button: 'Verified only',
    note: 'This report contains only the projects the loan team has verified.',
  },
  {
    key: 'all',
    button: 'Export all',
    note: 'This report contains every project on the borrower’s record. Projects that have not been verified are marked.',
  },
  {
    key: 'unverified',
    button: 'Unverified only',
    note: 'This report contains only the projects that have NOT been verified yet.',
  },
];

const INK = '#141B22';
const MUTED = '#4B585C';

export default function ExportRecord({ borrowerId, className = '' }) {
  const [busy, setBusy] = useState('');       // '<scope>:<format>' while that one runs
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  if (!borrowerId) return null;

  async function run(scope, format) {
    setErr('');
    setBusy(`${scope}:${format}`);
    try { await api.staffTrackRecordExport(borrowerId, { scope, format }); }
    catch (e) { setErr((e && e.message) || 'Could not build that export.'); }
    finally { setBusy(''); }
  }

  const pair = (scope, primary) => (
    <span className="act-group">
      <button type="button" className={`btn ${primary ? 'primary' : 'soft'} small`}
        disabled={!!busy} onClick={() => run(scope, 'xlsx')}
        title={`Excel — ${SCOPES.find((s) => s.key === scope).note}`}>
        {busy === `${scope}:xlsx` ? '…' : 'Excel'}
      </button>
      <button type="button" className="btn soft small"
        disabled={!!busy} onClick={() => run(scope, 'pdf')}
        title={`PDF — ${SCOPES.find((s) => s.key === scope).note}`}>
        {busy === `${scope}:pdf` ? '…' : 'PDF'}
      </button>
    </span>
  );

  return (
    <div className={`tr-export ${className}`.trim()}>
      {/* SAY WHAT THIS IS. Without it the control reads as a bare row of Excel/PDF buttons under
          an uppercase eyebrow, and nothing on the screen says the word "export". */}
      <div className="tr-export-title" style={{ color: INK }}>Export the track record</div>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="act-label" style={{ color: MUTED }}>{SCOPES[0].button}</span>
        {pair('verified', true)}
        <button type="button" className="btn link small" onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title="Export every project, or only the ones still to be verified — each line is stamped NOT VERIFIED.">
          {open ? 'Fewer options' : 'More export options'}
        </button>
      </div>
      <div className="small" style={{ color: MUTED, marginTop: 2 }}>{SCOPES[0].note}</div>

      {open && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {SCOPES.slice(1).map((s) => (
            <div key={s.key} style={{ marginBottom: 8 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="act-label" style={{ color: MUTED }}>{s.button}</span>
                {pair(s.key, false)}
              </div>
              <div className="small" style={{ color: MUTED, marginTop: 2 }}>{s.note}</div>
            </div>
          ))}
          <div className="small" style={{ color: INK }}>
            Every project that has not been verified carries a <strong>NOT VERIFIED</strong> stamp on its own
            row, and the report says so at the top.
          </div>
        </div>
      )}
      {err && <div className="notice err small" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}
