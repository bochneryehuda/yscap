import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, S, num, day } from '../lib/research.js';
import ResearchNav from '../components/ResearchNav.jsx';

/* THE APPRAISER DIRECTORY — every appraiser who has ever filed a report with us,
   built automatically out of the reports themselves. Nobody types any of this in:
   the name, firm, licence, phone and email are read off each appraisal as it is
   imported, and the same person's reports are folded together on their licence
   number (or on their name and firm when a report carries no licence). */

export default function StaffAppraisers() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [q, setQ] = useState(params.get('q') || '');
  const [err, setErr] = useState('');

  const sort = params.get('sort') || 'files';

  useEffect(() => {
    setRows(null); setErr('');
    const f = {};
    for (const [k, v] of params.entries()) f[k] = v;
    api.researchAppraisers(f)
      .then((d) => { setRows(d.rows || []); setMeta({ total: d.total, page: d.page, pages: d.pages }); })
      .catch((e) => { setRows([]); setErr(e.message || 'Could not load the appraiser list'); });
  }, [params]);

  function apply(next) {
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    Object.assign(out, next);
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    setParams(out);
  }

  return (
    <div>
      <ResearchNav />
      <div style={{ marginBottom: 10 }}>
        <Link to="/internal/research" style={{ color: MUTED, fontSize: 13 }}>← Back to Property Research</Link>
      </div>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ margin: '0 0 4px', color: INK }}>Appraisers</h1>
        <p style={{ margin: 0, color: MUTED, maxWidth: 720 }}>
          Everyone who has ever appraised a property for us, with their licence, phone and email as
          written on their reports. Click a name to see their full profile and every file they appraised.
        </p>
      </header>

      {err && <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A', marginBottom: 12 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input style={{ ...S.input, maxWidth: 320 }} value={q} placeholder="Name, firm, licence or email"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply({ q, page: '' }); }} />
        <button className="btn ghost small" onClick={() => apply({ q, page: '' })}>Search</button>
        <select style={{ ...S.input, width: 'auto' }} value={sort} onChange={(e) => apply({ sort: e.target.value })}>
          <option value="files">Most files for us</option>
          <option value="recent">Most recent report</option>
          <option value="name">By name</option>
          <option value="company">By firm</option>
        </select>
        <span style={{ alignSelf: 'center', color: MUTED, fontSize: 13 }}>
          {rows == null ? 'Loading…' : `${num(meta.total)} appraiser${meta.total === 1 ? '' : 's'}`}
        </span>
      </div>

      {rows && rows.length === 0 && (
        <div className="card" style={{ color: MUTED }}>
          No appraisers yet. They appear here automatically as appraisal reports are imported.
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {(rows || []).map((a) => (
          <div key={a.id} style={{ ...S.panel, padding: 12, display: 'grid',
            gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'start' }}>
            <div>
              <Link to={`/internal/research/appraiser/${a.id}`}
                style={{ color: INK, fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
                {a.name}
              </Link>
              {a.company && <div style={{ color: MUTED, fontSize: 13 }}>{a.company}</div>}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 13, color: MUTED }}>
                {a.license_id && <span>Licence {a.license_id}{a.license_state ? ` (${a.license_state})` : ''}</span>}
                {a.license_type && <span>{a.license_type}</span>}
                {a.phone && <span>{a.phone}</span>}
                {a.email && <a href={`mailto:${a.email}`} style={{ color: GOLD }}>{a.email}</a>}
              </div>
            </div>
            <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>{num(a.file_count)}</div>
              <div style={{ color: MUTED, fontSize: 12 }}>file{a.file_count === 1 ? '' : 's'} for us</div>
              <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>last {day(a.last_report_date)}</div>
            </div>
          </div>
        ))}
      </div>

      {meta.pages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
          <button className="btn ghost small" disabled={meta.page <= 1}
            onClick={() => apply({ page: String(meta.page - 1) })}>← Previous</button>
          <span style={{ color: MUTED, fontSize: 13, alignSelf: 'center' }}>{meta.page} / {meta.pages}</span>
          <button className="btn ghost small" disabled={meta.page >= meta.pages}
            onClick={() => apply({ page: String(meta.page + 1) })}>Next →</button>
        </div>
      )}
    </div>
  );
}
