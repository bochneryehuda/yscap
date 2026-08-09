import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, S, num } from '../lib/research.js';

/* ADD APPRAISAL DATA FILES TO THE RESEARCH DATABASE — one, or a whole folder.

   The database fills itself from every appraisal that comes in on a loan file.
   This is the other way in: drop in appraisal data files (the .xml the appraiser
   sends with the report) and every comparable sale on them becomes a property you
   can search.

   THREE THINGS THIS SCREEN HAS TO GET RIGHT, and they are all about honesty:

   1. NOTHING IS SILENTLY DROPPED. A big drop is sent in SIZE-BOUNDED batches
      (one appraisal data file carries the whole report PDF inside it, so a handful
      of them is already tens of megabytes and a single request would be refused by
      the server before it read anything). Every batch's answer is added to the same
      running total, and every file is listed with what happened to it.

   2. "ALREADY HERE" IS NOT A FAILURE. A report that came in on a loan file, or one
      dropped in twice, is skipped on purpose — that is the database refusing to
      count the same house twice. It reads as its own outcome, not as an error.

   3. THE OFFICER SEES PROGRESS. Reading a hundred reports takes a minute or two,
      so the count moves as it goes rather than the screen sitting still. */

// Kept comfortably under the server's request-size limit (~25 MB), with room for
// the base64/JSON overhead of the request itself.
const BATCH_BYTES = 12 * 1024 * 1024;
// A single file bigger than this is not an appraisal data file; the server refuses
// it anyway, but saying so here saves the upload.
const MAX_ONE = 40 * 1024 * 1024;

const readText = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(new Error(`${file.name} could not be read off your computer.`));
  fr.onload = () => resolve(String(fr.result || ''));
  fr.readAsText(file);
});

/** Group files into batches no bigger than the server will accept in one request. */
function batchBySize(files, cap = BATCH_BYTES) {
  const out = [];
  let cur = [], size = 0;
  for (const f of files) {
    // A file larger than the whole cap goes on its own — never dropped, never
    // merged into a batch it would blow past.
    if (cur.length && size + f.size > cap) { out.push(cur); cur = []; size = 0; }
    cur.push(f); size += f.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

const EMPTY_SUM = { total: 0, ok: 0, skipped: 0, failed: 0, properties: 0, observations: 0, sales: 0, comparables: 0, salvaged: 0 };

export default function ResearchImportPanel({ onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);   // {done, total}
  const [summary, setSummary] = useState(null);
  const [results, setResults] = useState([]);
  const [err, setErr] = useState('');
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadHistory = useCallback(() => {
    api.researchImports({ limit: 100 })
      .then((d) => { if (alive.current) setHistory(d.rows || []); })
      .catch(() => { if (alive.current) setHistory([]); });
  }, []);

  useEffect(() => { if (showHistory && history === null) loadHistory(); }, [showHistory, history, loadHistory]);

  async function send(fileList) {
    const files = [...fileList].filter(Boolean);
    if (!files.length) return;
    setBusy(true); setErr(''); setSummary(null); setResults([]);
    setProgress({ done: 0, total: files.length });

    const running = { ...EMPTY_SUM };
    const all = [];
    // The oversized ones never leave the browser — say so plainly and carry on
    // with the rest rather than failing the whole drop.
    const tooBig = files.filter((f) => f.size > MAX_ONE);
    const usable = files.filter((f) => f.size <= MAX_ONE);
    for (const f of tooBig) {
      running.total++; running.failed++;
      all.push({ filename: f.name, status: 'error', reason: 'That file is too big to be an appraisal data file, so it was not sent.' });
    }

    try {
      for (const batch of batchBySize(usable)) {
        const payload = [];
        for (const f of batch) {
          try {
            payload.push({ filename: f.name, xml: await readText(f) });
          } catch (e) {
            running.total++; running.failed++;
            all.push({ filename: f.name, status: 'error', reason: e.message });
          }
        }
        if (!payload.length) continue;
        const d = await api.researchImportXml({ files: payload });
        const s = d.summary || {};
        // Accumulate over the KNOWN NUMERIC KEYS, not over `running`'s own keys —
        // `running` also carries the non-numeric fields below, and `+=` on a note
        // string would concatenate NaN onto it.
        for (const k of Object.keys(EMPTY_SUM)) running[k] += Number(s[k] || 0);
        // NOTHING IS SILENTLY DROPPED — this panel's own first rule. The server
        // caps a batch and reports the overflow as `dropped` + a plain-language
        // `note`; neither is a key on EMPTY_SUM, so both used to be thrown away
        // and the summary could never show them. Batches are sized by BYTES, so
        // the cap is genuinely reachable: ~240 × 50 KB files land in one batch
        // and 140 of them were discarded without a word.
        if (Number(s.dropped)) {
          running.dropped = Number(running.dropped || 0) + Number(s.dropped);
          if (s.note) running.note = s.note;
        }
        all.push(...(d.results || []));
        if (!alive.current) return;
        setProgress({ done: Math.min(all.length, files.length), total: files.length });
        setSummary({ ...running });
        setResults([...all]);
      }
      if (!alive.current) return;
      setSummary({ ...running });
      setResults(all);
      setHistory(null);            // it changed; re-read it if the list is open
      if (showHistory) loadHistory();
      if (onDone) onDone(running);
    } catch (e) {
      if (alive.current) setErr(e.message || 'That upload could not be finished.');
    } finally {
      if (alive.current) { setBusy(false); setProgress(null); }
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function onDrop(e) {
    e.preventDefault(); setDrag(false);
    if (busy) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) send(files);
  }

  if (!open) {
    return (
      <div style={{ ...S.panel, marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong style={{ color: INK }}>Add appraisal files to the database</strong>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>
            Drop in the appraisal data files (.xml) from any report — one or a whole folder — and every
            comparable sale on them becomes a property you can search here.
          </div>
        </div>
        <button className="btn" onClick={() => setOpen(true)}>Add appraisal files</button>
      </div>
    );
  }

  return (
    <div style={{ ...S.panel, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ color: INK }}>Add appraisal files to the database</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost small" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide what has been added' : 'What has been added'}
          </button>
          <button className="btn ghost small" onClick={() => setOpen(false)} disabled={busy}>Close</button>
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${drag ? GOLD : '#D8D2C4'}`,
          borderRadius: 10, padding: '22px 16px', textAlign: 'center',
          background: drag ? 'rgba(174,135,70,0.06)' : '#FBFAF7',
          color: MUTED, transition: 'border-color .12s, background .12s',
        }}
      >
        <div style={{ color: INK, fontWeight: 600, marginBottom: 4 }}>
          {busy ? 'Reading the files…' : 'Drop appraisal data files here'}
        </div>
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          These are the <b>.xml</b> files that come with an appraisal report. You can select a whole folder at once.
        </div>
        <input ref={inputRef} type="file" accept=".xml,text/xml,application/xml" multiple
          style={{ display: 'none' }}
          onChange={(e) => send(e.target.files)} />
        <button className="btn" disabled={busy} onClick={() => inputRef.current && inputRef.current.click()}>
          {busy ? 'Working…' : 'Choose files'}
        </button>
        {progress && (
          <div style={{ marginTop: 10, fontSize: 13, color: INK }}>
            {num(progress.done)} of {num(progress.total)} read…
          </div>
        )}
      </div>

      <p style={{ color: MUTED, fontSize: 12.5, margin: '10px 0 0' }}>
        Nothing here touches a loan file. It only adds properties and sales to this research database —
        no file is created, no condition is opened, nobody is emailed.
      </p>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A', marginTop: 10 }}>{err}</div>}

      {summary && <Summary s={summary} />}
      {results.length > 0 && <ResultList rows={results} />}

      {showHistory && (
        <div style={{ marginTop: 14, borderTop: '1px solid #EDE8DC', paddingTop: 12 }}>
          <strong style={{ color: INK, fontSize: 13 }}>Everything added this way</strong>
          {history === null && <div style={{ color: MUTED, fontSize: 13, marginTop: 6 }}>Loading…</div>}
          {history !== null && history.length === 0 && (
            <div style={{ color: MUTED, fontSize: 13, marginTop: 6 }}>Nothing has been added by hand yet.</div>
          )}
          {history !== null && history.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: MUTED }}>
                    <th style={TH}>File</th><th style={TH}>Came from</th>
                    <th style={TH}>Property</th><th style={TH}>Appraiser</th>
                    <th style={TH}>Comps</th><th style={TH}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} style={{ borderTop: '1px solid #F0ECE2' }}>
                      <td style={TD}>{h.filename || '—'}</td>
                      {/* WHERE IT CAME FROM (db/462). Every appraisal XML that enters
                          PILOT now feeds this database — a borrower attaching the data
                          file, a staffer filing it on any condition, a vendor emailing
                          it back on an order, the sweep over what was already on the
                          files — and without this column the one question that makes
                          that visible ("did the reports on our loan files come in?")
                          cannot be answered from the screen. NULL on every row that
                          predates the column, and on the Encompass catcher's rows. */}
                      <td style={{ ...TD, color: MUTED }}>{h.source || '—'}</td>
                      <td style={TD}>
                        {h.subject_property_id
                          ? <Link to={`/internal/research/property/${h.subject_property_id}`} style={{ color: INK }}>
                            {h.subject_address || 'the property'}
                          </Link>
                          : (h.subject_address || '—')}
                        {h.subject_city ? <span style={{ color: MUTED }}>, {h.subject_city}</span> : null}
                      </td>
                      <td style={TD}>
                        {h.appraiser_id
                          ? <Link to={`/internal/research/appraiser/${h.appraiser_id}`} style={{ color: INK }}>{h.appraiser_name}</Link>
                          : (h.appraiser_name || '—')}
                      </td>
                      <td style={TD}>
                        {h.comparables_seen == null ? '—' : num(h.comparables_seen)}
                        {h.rows_skipped
                          ? <div style={{ color: GOLD, fontSize: 12, cursor: h.skip_reasons ? 'help' : 'default' }}
                              title={skipTip(h.skip_reasons)}>
                            {num(h.rows_skipped)} left out
                          </div>
                          : null}
                      </td>
                      <td style={TD}><Outcome status={h.status} reason={h.error} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TH = { padding: '4px 8px 6px', fontWeight: 600, whiteSpace: 'nowrap' };
const TD = { padding: '6px 8px', color: INK, verticalAlign: 'top' };

/* WHAT WAS LEFT OUT, AND WHY — never just a count.
   A comparable is left out only when its address cannot identify a property (no
   house number, no state, or no town/ZIP). The reviewer needs to see WHICH sale
   and WHAT was missing so they can open the appraisal and fix it — so each one is
   named with its stated address and the exact reason. Other, internal skips (a
   roll-up that could not recompute) carry no address and are only counted. */
function SkippedList({ items }) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return null;
  const addr = rows.filter((s) => s && (s.role === 'comparable' || s.role === 'rental_comparable') && s.address);
  const other = rows.length - addr.length;
  if (!addr.length && !other) return null;
  return (
    <div style={{ color: GOLD, fontSize: 12.5, marginTop: 3 }}>
      {addr.length > 0 && (
        <>
          <div style={{ fontWeight: 600 }}>
            {addr.length} comparable{addr.length === 1 ? '' : 's'} left out — the address could not be used:
          </div>
          <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
            {addr.map((s, i) => (
              <li key={i} style={{ marginTop: 1 }}>
                <span style={{ color: INK }}>{s.address}</span>
                {s.why ? <span style={{ color: MUTED }}> — {s.why}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {other > 0 && (
        <div style={{ marginTop: addr.length ? 3 : 0, color: MUTED }}>
          {other} other item{other === 1 ? '' : 's'} on this report could not be filed.
        </div>
      )}
    </div>
  );
}

/* WHAT WE KEPT DESPITE A THIN ADDRESS.
   A comparable is no longer dropped just because the appraiser wrote a short
   address: one missing only its town borrows the subject's town (kind
   'inherited_town'); one we still cannot pin down is saved for review (kind
   'needs_review'). The reviewer sees these were KEPT, not lost. */
const TEAL_OK = '#2F7F86';
function KeptList({ items }) {
  const rows = Array.isArray(items) ? items : [];
  const kept = rows.filter((s) => s && s.address && (s.kind === 'inherited_town' || s.kind === 'needs_review'));
  if (!kept.length) return null;
  const label = (k) => (k === 'inherited_town'
    ? 'town filled in from the subject'
    : 'saved for review — held out of the comp search until the address is checked');
  return (
    <div style={{ color: TEAL_OK, fontSize: 12.5, marginTop: 3 }}>
      <div style={{ fontWeight: 600 }}>
        {kept.length} comparable{kept.length === 1 ? '' : 's'} kept despite a thin address:
      </div>
      <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
        {kept.map((s, i) => (
          <li key={i} style={{ marginTop: 1 }}>
            <span style={{ color: INK }}>{s.address}</span>
            <span style={{ color: MUTED }}> — {label(s.kind)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A one-line-per-skip summary for a hover tooltip in the compact history table. */
function skipTip(rows) {
  if (!Array.isArray(rows)) return '';
  return rows
    .filter((s) => s && s.address)
    .map((s) => `${s.address}${s.why ? ' — ' + s.why : ''}`)
    .join('\n');
}

function Summary({ s }) {
  const line = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
  return (
    <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: '#F6F3EC', color: INK }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {s.ok > 0
          ? `Added ${line(s.ok, 'report')} — ${line(s.properties, 'property').replace('propertys', 'properties')} and ${line(s.comparables, 'comparable sale')}.`
          : 'Nothing new was added.'}
      </div>
      <div style={{ fontSize: 13, color: MUTED }}>
        {s.skipped > 0 && <span>{line(s.skipped, 'file')} skipped — already in the database. </span>}
        {s.salvaged > 0 && <span style={{ color: '#2F7F86' }}>{line(s.salvaged, 'comparable')} kept despite a thin address (details below). </span>}
        {s.failed > 0 && <span style={{ color: '#B4423A' }}>{line(s.failed, 'file')} could not be read (listed below). </span>}
        {s.dropped > 0 && <span style={{ color: GOLD }}>{s.note}</span>}
      </div>
    </div>
  );
}

function Outcome({ status, reason }) {
  const map = {
    ok: { label: 'Added', color: '#2F7F86' },
    skipped: { label: 'Already here', color: MUTED },
    error: { label: 'Not read', color: '#B4423A' },
    pending: { label: 'Working…', color: MUTED },
  };
  const m = map[status] || map.pending;
  return (
    <span>
      <b style={{ color: m.color }}>{m.label}</b>
      {reason ? <div style={{ color: MUTED, fontSize: 12.5, marginTop: 2, maxWidth: 460 }}>{reason}</div> : null}
    </span>
  );
}

function ResultList({ rows }) {
  // The ones that need reading come first — nobody scrolls a hundred green lines
  // to find the one that failed.
  const order = { error: 0, skipped: 1, ok: 2 };
  const sorted = [...rows].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  return (
    <div style={{ marginTop: 10, maxHeight: 320, overflowY: 'auto', border: '1px solid #EDE8DC', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={`${r.filename || 'file'}-${i}`} style={{ borderTop: i ? '1px solid #F0ECE2' : 'none' }}>
              <td style={{ ...TD, width: '34%', wordBreak: 'break-all' }}>{r.filename || '(no name)'}</td>
              <td style={TD}>
                {r.subjectAddress || '—'}
                {r.comparables ? <span style={{ color: MUTED }}> · {num(r.comparables)} comps</span> : null}
                <KeptList items={r.salvaged} />
                <SkippedList items={r.skipped} />
              </td>
              <td style={{ ...TD, width: '32%' }}><Outcome status={r.status} reason={r.reason} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
