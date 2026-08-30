import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
// The shared formatters — two screens drawing the same loans must not each carry
// their own idea of a dollar or a date.
import { money, day } from './format.js';

/**
 * The long-term ARCHIVE — files Encompass itself has deleted (its "(Trash)"
 * folder). Owner-directed 2026-08-23: they are out of the pipeline entirely, out
 * of every filter, "totaled in the archive folder, and you can click over there to
 * delete it permanently."
 *
 * The permanent delete removes PILOT's copy only — Encompass is read-only to
 * PILOT, and the Encompass copy is already in Encompass's own trash. The server
 * refuses the delete for anyone but a super-admin, and refuses it structurally for
 * any file that is not in the trash; the buttons here just say so up front.
 *
 * Colours are explicit darks — every `--ink*` token in this palette is a LIGHT
 * paper colour and would render white-on-white.
 */
export default function LtArchive() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  // Deleting asks ONCE, on the button itself (this side may not import RTL's
  // dialog helper, and a browser confirm() is banned app-wide).
  const [confirmId, setConfirmId] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);

  const load = () => {
    setErr('');
    ltApi.archive().then(setData).catch((e) => setErr(e.message || 'Could not load the archive.'));
  };
  useEffect(load, []);

  const removeOne = async (id) => {
    if (confirmId !== id) { setConfirmId(id); setConfirmAll(false); return; }
    setBusy(id); setNote('');
    try {
      const out = await ltApi.archiveDelete(id);
      setNote(`Deleted ${out.deleted && out.deleted.loanNumber ? out.deleted.loanNumber : 'the file'} from PILOT permanently.`);
      setConfirmId('');
      load();
    } catch (e) { setErr(e.message || 'Could not delete that file.'); }
    finally { setBusy(''); }
  };

  const removeAll = async () => {
    if (!confirmAll) { setConfirmAll(true); setConfirmId(''); return; }
    setBusy('all'); setNote('');
    try {
      const out = await ltApi.archiveDeleteAll();
      setNote(`Deleted ${out.deleted} file${out.deleted === 1 ? '' : 's'} from PILOT permanently${
        out.failed && out.failed.length ? ` — ${out.failed.length} could not be deleted` : ''}.`);
      setConfirmAll(false);
      load();
    } catch (e) { setErr(e.message || 'Could not empty the archive.'); }
    finally { setBusy(''); }
  };

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: '#4B585C', fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap' };
  const td = { padding: '10px', fontSize: 14, color: '#141B22', borderTop: '1px solid #EAE4D7' };

  return (
    <LtLayout title="Archive — deleted in Encompass">
      <div className="lt-card" style={{ color: '#4B585C', fontSize: 13, marginBottom: 12 }}>
        Two kinds of file live here, and neither is part of the pipeline: files sitting in
        Encompass&rsquo;s own trash folder (test files, training files &mdash; deleted there), and
        stale <em>archived copies</em> of a live file &mdash; a duplicate record Encompass itself
        has archived out of sight, superseded by the real one. Deleting one below removes
        PILOT&rsquo;s copy <strong style={{ color: '#141B22' }}>permanently</strong>; the Encompass
        copy stays where it is in Encompass, and restoring it there brings the file back here on
        the next sync. <Link to="/internal/lt" style={{ color: '#2F7F86' }}>Back to the pipeline</Link>
      </div>

      {err && <div className="lt-card" style={{ color: '#8A2D2D', marginBottom: 12 }}>{err}</div>}
      {note && <div className="lt-card" style={{ color: '#1F5F3F', marginBottom: 12 }}>{note}</div>}

      {data && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ color: '#141B22' }}>{data.count} file{data.count === 1 ? '' : 's'} in the archive</strong>
          {data.count > 0 && (
            <button type="button" className="btn ghost" disabled={busy === 'all'}
              style={{ padding: '4px 12px', fontSize: 13, color: confirmAll ? '#8A2D2D' : undefined }}
              onClick={removeAll}>
              {busy === 'all' ? 'Deleting…' : confirmAll ? 'Really delete every one, permanently?' : 'Delete all permanently'}
            </button>
          )}
        </div>
      )}

      {data && data.count === 0 && (
        <div className="lt-card" style={{ color: '#141B22' }}>The archive is empty.</div>
      )}

      {data && data.count > 0 && (
        <div className="lt-card lt-card-flush" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead><tr>
              <th style={th}>Loan #</th><th style={th}>Borrower</th><th style={th}>Program</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Milestone</th>
              <th style={th}>Last touched in Encompass</th><th style={th}>ClickUp card</th><th style={th} />
            </tr></thead>
            <tbody>
              {data.loans.map((l) => (
                <tr key={l.id}>
                  <td style={{ ...td, fontWeight: 600 }}>
                    {l.loan_number || '—'}
                    {l.reason === 'archived_duplicate' ? (
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#8A6A17' }}>
                        archived copy of a live file
                      </div>
                    ) : null}
                  </td>
                  <td style={td}>{l.borrower_name || '—'}</td>
                  <td style={td}>{l.program_name || '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(l.loan_amount)}</td>
                  <td style={td}>{l.milestone_label || l.milestone_name || '—'}</td>
                  <td style={td}>{day(l.encompass_last_modified)}</td>
                  <td style={td}>{l.clickup_custom_id || (l.clickup_task_id ? 'linked' : '—')}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn ghost" disabled={!!busy}
                      style={{ padding: '3px 10px', fontSize: 12, color: '#8A2D2D' }}
                      onClick={() => removeOne(l.id)}>
                      {busy === l.id ? 'Deleting…' : confirmId === l.id ? 'Really delete permanently?' : 'Delete permanently'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </LtLayout>
  );
}
