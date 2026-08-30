import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
// ONE way to write a value down, shared with every other long-term screen — never a
// second copy here. The census and the pipeline show the same loans, so a `money`
// written twice is two screens quoting one loan two ways.
import { money } from './format.js';

/**
 * THE BOOK — the owner's census, on a screen.
 *
 * Their words: *"give me a breakdown of each and every file that is in our system,
 * only on the long-term side … every file, which folder it sits in, which status it
 * sits in, which milestone it sits in."* The server has answered that since
 * `GET /api/lt/book` shipped; nothing rendered it, so the answer could only be read
 * by downloading a spreadsheet. This is the screen.
 *
 * EVERY FILE IS ACCOUNTED FOR, AND THAT IS THE POINT. A census that quietly drops
 * the rows it could not place is not a smaller answer, it is a wrong one — so the
 * three other buckets (short-term, on the 36-month line, and no program and no
 * term) are shown beside the long-term count with their own tabs, and the four
 * always add up to what was read. Same reason the cap says so out loud.
 *
 * THE STATUS IS OUR NAME FOR IT, never the stored key. The server sends the list
 * (`stages`) it sends the pipeline, so the two screens can never call one stage two
 * things, and renaming a status is a settings change rather than a deploy — which
 * is exactly what the owner asked for next: *"rephrase this in our system with our
 * own statuses, more user-friendly."*
 *
 * READ-ONLY. Nothing here changes a file, a link or a mapping; the two decisions
 * this census measures are made on the People and Borrowers screens.
 */

const TABS = [
  { key: 'longTerm', label: 'Long-term', note: 'Term over 36 months. This is the book.' },
  { key: 'shortTerm', label: 'Short-term (excluded)', note: 'A Flip program, or a term under 36 months. Counted so the totals reconcile.' },
  { key: 'boundary', label: 'Exactly 36 months', note: 'The rule covers under 36 and over 36 — not 36 itself. These need your answer.' },
  { key: 'unknown', label: 'No program, no term', note: 'Nothing on the file says which product it is.' },
];

export default function LtBook() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('longTerm');
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    setErr(null);
    ltApi.book().then(setData).catch((e) => setErr(e.message || 'Could not read the long-term book.'));
  }, []);
  useEffect(load, [load]);

  // A stage is STORED as a key and READ as a name — the pipeline's own rule, and
  // the list comes from the same place, so the two can never disagree. A key the
  // list does not carry falls back to the key: an unmapped status is a fact worth
  // seeing on the one screen whose job is that nothing is unaccounted for.
  const statusName = useCallback((key) => {
    const s = (data && data.stages ? data.stages : []).find((x) => x.key === key);
    return (s && s.label) || key || '—';
  }, [data]);

  const rows = useMemo(() => {
    const list = (data && data[tab]) || [];
    const q = search.trim().toLowerCase();
    return list.filter((r) => {
      if (folder && (r.folder || '(no folder)') !== folder) return false;
      if (!q) return true;
      return [r.file, r.borrowerName, r.folder, r.milestone, r.programName, r.officerName]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
  }, [data, tab, search, folder]);

  const download = async () => {
    setBusy(true);
    setNote('');
    try { await ltApi.bookCsv(); }
    catch (e) { setNote(e.message || 'Could not build the spreadsheet.'); }
    finally { setBusy(false); }
  };

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: '#4B585C', fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap' };
  const td = { padding: '9px 10px', fontSize: 14, color: '#141B22', borderTop: '1px solid #EAE4D7', verticalAlign: 'top' };

  const counts = (data && data.counts) || {};
  const activeTab = TABS.find((t) => t.key === tab) || TABS[0];

  return (
    <LtLayout title="The book">
      <p style={{ margin: '0 0 14px', color: '#4B585C', maxWidth: 760, lineHeight: 1.55 }}>
        Every long-term file, with the folder it sits in, the status it sits in and the
        milestone it sits at. A loan program with <strong>Flip</strong> in its name is
        short-term, and so is a term under 36 months — everything else is here.
      </p>

      {err && <div className="lt-card" style={{ color: '#141B22' }}>{err}</div>}
      {note && <div className="lt-card" style={{ color: '#141B22', marginBottom: 12 }}>{note}</div>}
      {!data && !err && <div className="lt-card" style={{ color: '#4B585C' }}>Reading the book…</div>}

      {data && (
        <>
          {/* WHAT THE RULE DID WITH THE WHOLE BOOK. Four numbers that add up to what
              was read, so nothing can go missing between the pipeline and this page. */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            {TABS.map((t) => {
              const on = tab === t.key;
              return (
                <button key={t.key} onClick={() => { setTab(t.key); setFolder(''); }} title={t.note}
                  style={{
                    textAlign: 'left', cursor: 'pointer', minWidth: 150,
                    padding: '10px 14px', borderRadius: 10,
                    border: on ? '1px solid #AE8746' : '1px solid #EAE4D7',
                    background: on ? '#FBF6EC' : '#FFFFFF',
                  }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#141B22', lineHeight: 1.1 }}>
                    {counts[t.key] == null ? '—' : counts[t.key]}
                  </div>
                  <div style={{ fontSize: 12, color: '#4B585C', marginTop: 2 }}>{t.label}</div>
                </button>
              );
            })}
          </div>

          <div className="lt-card" style={{ marginBottom: 14, color: '#141B22', lineHeight: 1.55 }}>
            <div style={{ color: '#4B585C', fontSize: 13 }}>{activeTab.note}</div>
            <div style={{ marginTop: 8, fontSize: 13, color: '#4B585C' }}>
              Read {counts.read == null ? '—' : counts.read} of {counts.total == null ? '—' : counts.total} files.
              {' '}Of the long-term ones, <strong style={{ color: '#141B22' }}>{counts.longTermBorrowerLinked ?? '—'}</strong>{' '}
              are matched to a borrower profile and{' '}
              <strong style={{ color: '#141B22' }}>{counts.longTermOfficerLinked ?? '—'}</strong>{' '}
              to a loan officer.
            </div>
            {/* A SILENT CAP ON A CENSUS IS A WRONG ANSWER, so it is said in words. */}
            {data.capped && (
              <div style={{ marginTop: 8, fontSize: 13, color: '#8A2A2A' }}>
                This is the first {counts.read} files of {counts.total}. The rest are in the spreadsheet.
              </div>
            )}
            {data.disagreements && data.disagreements.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 13, color: '#8A6A17' }}>
                {data.disagreements.length} file{data.disagreements.length === 1 ? '' : 's'} disagree with
                {' '}themselves — a Flip program carrying a long term. The program wins, so they are counted
                {' '}as short-term; they are worth a look.
              </div>
            )}
          </div>

          {/* BY FOLDER, which is how the owner reads it. Clicking one filters the
              list below rather than opening a second screen. Long-term only —
              these are the folders the answer is about. */}
          {tab === 'longTerm' && data.byFolder && data.byFolder.length > 0 && (
            <div className="lt-card lt-card-flush" style={{ marginBottom: 14, padding: 0, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                <thead><tr>
                  <th style={th}>Folder</th><th style={th}>Files</th><th style={th}>Statuses inside it</th>
                </tr></thead>
                <tbody>
                  {data.byFolder.map((f) => (
                    <tr key={f.folder}
                      style={{ background: folder === f.folder ? '#FBF6EC' : undefined, cursor: 'pointer' }}
                      onClick={() => setFolder(folder === f.folder ? '' : f.folder)}>
                      <td style={{ ...td, fontWeight: 600 }}>{f.folder}</td>
                      <td style={td}>{f.count}</td>
                      <td style={{ ...td, color: '#4B585C', fontSize: 13 }}>
                        {f.statuses.map((s) => `${statusName(s.status)} (${s.count})`).join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a file, borrower, folder or milestone" style={{ maxWidth: 320 }} />
            {folder && (
              <button className="btn small ghost" onClick={() => setFolder('')}>
                Folder: {folder} ✕
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={download} disabled={busy}>
              {busy ? 'Building…' : 'Download the spreadsheet'}
            </button>
          </div>

          <div className="lt-card lt-card-flush" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
              <thead><tr>
                <th style={th}>File</th><th style={th}>Borrower</th><th style={th}>Folder</th>
                <th style={th}>Status</th><th style={th}>Milestone</th>
                <th style={th}>Term</th><th style={th}>Program</th><th style={th}>Amount</th>
                <th style={th}>Mapped to</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.file}</td>
                    <td style={td}>{r.borrowerName || <span style={{ color: '#4B585C' }}>—</span>}</td>
                    <td style={td}>{r.folder || <span style={{ color: '#4B585C' }}>—</span>}</td>
                    <td style={td}>{statusName(r.status)}</td>
                    <td style={td}>{r.milestone || <span style={{ color: '#4B585C' }}>—</span>}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {r.termMonths == null ? <span style={{ color: '#4B585C' }}>—</span> : `${r.termMonths} mo`}
                    </td>
                    <td style={{ ...td, fontSize: 13 }}>{r.programName || <span style={{ color: '#4B585C' }}>—</span>}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{money(r.loanAmount)}</td>
                    <td style={{ ...td, fontSize: 13 }}>
                      {/* The two links the mapping work is measured by, said in words
                          rather than as ticks — "no borrower" is the reason a client
                          cannot see their own file, and that should read as a to-do. */}
                      <div style={{ color: r.borrowerLinked ? '#1F6F43' : '#8A6A17' }}>
                        {r.borrowerLinked ? 'Borrower matched' : 'No borrower yet'}
                      </div>
                      {/* THREE ANSWERS, NOT TWO. "Encompass names nobody" and
                          "Encompass names somebody PILOT has not matched" are
                          different jobs — the first is a question for the loan
                          team, the second is one click on the people map — so a
                          file whose officer we cannot match SAYS WHO IT IS
                          instead of reading as an empty file. */}
                      <div style={{ color: r.officerLinked ? '#1F6F43' : '#8A6A17' }}>
                        {r.officerLinked
                          ? (r.officerName || 'Officer matched')
                          : (r.officerName ? `${r.officerName} — not matched` : 'No officer yet')}
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td style={{ ...td, color: '#4B585C' }} colSpan={9}>
                    Nothing here{search || folder ? ' with that filter' : ''}.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </LtLayout>
  );
}
