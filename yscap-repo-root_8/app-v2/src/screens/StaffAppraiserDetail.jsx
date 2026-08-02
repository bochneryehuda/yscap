import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, S, money, sqft, num, day, pct } from '../lib/research.js';

/* ONE APPRAISER — their profile, everything we have ever been told about how to
   reach them, and every file they appraised for us.

   The "how they work" block is something only we can compute, because we hold
   many reports from the same person: how many comparables they typically use,
   how hard they adjust, whether they lean on listings. It is descriptive, not a
   grade — there is deliberately no score, because a fair scorecard needs far more
   reports per appraiser than most of them have filed with us. */

export default function StaffAppraiserDetail() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setD(null); setErr('');
    api.researchAppraiser(id).then(setD).catch((e) => setErr(e.message || 'Could not load that appraiser'));
  }, [id]);

  if (err) return <div className="card" style={{ borderColor: '#B4423A', color: '#B4423A' }}>{err}</div>;
  if (!d) return <div className="card" style={{ color: MUTED }}>Loading…</div>;

  const a = d.appraiser;
  const w = d.work || {};
  const byKind = (k) => (d.contacts || []).filter((c) => c.kind === k);

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <Link to="/internal/research/appraisers" style={{ color: MUTED, fontSize: 13 }}>← Back to Appraisers</Link>
      </div>

      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 2px', color: INK, fontSize: 24 }}>{a.name}</h1>
        {a.company && <div style={{ color: MUTED, fontSize: 15 }}>{a.company}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <span style={S.tag}>{num(a.file_count)} file{a.file_count === 1 ? '' : 's'} for us</span>
          <span style={S.tag}>{num(a.appraisal_count)} report{a.appraisal_count === 1 ? '' : 's'}</span>
          {a.first_report_date && <span style={S.tag}>first {day(a.first_report_date)}</span>}
          {a.last_report_date && <span style={S.tag}>last {day(a.last_report_date)}</span>}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 14 }}>
        {/* ---- how to reach them ---- */}
        <section style={S.panel}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>How to reach them</h2>
          <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
            Read straight off their reports. Everything they have ever used is kept — the one at the top
            is the most recent.
          </p>
          <Contacts title="Email" rows={byKind('email')} mailto />
          <Contacts title="Phone" rows={byKind('phone')} />
          <Contacts title="Firm" rows={byKind('company')} />
          <Contacts title="Office address" rows={byKind('address')} />
          <Contacts title="Supervisor" rows={byKind('supervisor')} />
        </section>

        {/* ---- licences ---- */}
        <section style={S.panel}>
          <h2 style={{ margin: '0 0 10px', fontSize: 16, color: INK }}>Licences</h2>
          {(d.licenses || []).length === 0
            ? <div style={{ color: MUTED, fontSize: 13 }}>No licence number appeared on their reports.</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={S.th}>State</th><th style={S.th}>Number</th>
                  <th style={S.th}>Type</th><th style={S.th}>Expires</th>
                </tr></thead>
                <tbody>
                  {d.licenses.map((l, i) => (
                    <tr key={i}>
                      <td style={S.cell}>{l.license_state || '—'}</td>
                      <td style={{ ...S.cell, fontWeight: 700 }}>{l.license_id || '—'}</td>
                      <td style={S.cell}>{l.license_type || '—'}</td>
                      <td style={S.cell}>{l.license_exp ? day(l.license_exp) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </section>

        {/* ---- how they work ---- */}
        <section style={S.panel}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>How they work</h2>
          <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
            Patterns across everything they have filed with us. This describes their reports — it is not a rating.
          </p>
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: 0 }}>
            <Stat k="Comparable sales used" v={num(w.comps_used)} />
            <Stat k="Different properties" v={num(w.distinct_properties)} />
            <Stat k="Typical total adjusting" v={w.avg_gross_adj_pct == null ? '—' : pct(w.avg_gross_adj_pct, 0)}
              hint="How much they move a comparable's price up and down in total. Under about 25% is unremarkable." />
            <Stat k="Typical net change" v={w.avg_net_adj_pct == null ? '—' : pct(w.avg_net_adj_pct, 0)} />
            <Stat k="Listings used as comps" v={num(w.listings_used)}
              hint="A property still for sale is an asking price, not a proven sale." />
            <Stat k="Reports read in" v={num(w.observations)} />
          </dl>
        </section>
      </div>

      {/* ---- every file ---- */}
      <section style={S.panel}>
        <h2 style={{ margin: '0 0 10px', fontSize: 16, color: INK }}>
          Files they appraised for us ({(d.files || []).length})
        </h2>
        {(d.files || []).length === 0
          ? <div style={{ color: MUTED, fontSize: 13 }}>No reports on file.</div>
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                <thead><tr>
                  <th style={S.th}>Date</th><th style={S.th}>Property</th><th style={S.th}>Form</th>
                  <th style={S.th}>As-is</th><th style={S.th}>After repair</th>
                  <th style={S.th}>Size</th><th style={S.th}>Comps</th><th style={S.th}>File</th>
                </tr></thead>
                <tbody>
                  {d.files.map((f) => (
                    <tr key={f.appraisal_id} style={f.superseded ? { opacity: 0.55 } : undefined}>
                      <td style={S.cell}>{day(f.effective_date || f.report_signed_date)}</td>
                      <td style={S.cell}>
                        {[f.subject_address, f.subject_city, f.subject_state].filter(Boolean).join(', ')}
                        {f.superseded && <span style={{ ...S.tag, marginLeft: 6 }}>replaced</span>}
                      </td>
                      <td style={S.cell}>{f.form_type || '—'}</td>
                      <td style={S.cell}>{money(f.as_is_value || f.appraised_value)}</td>
                      <td style={S.cell}>{f.arv_value ? money(f.arv_value) : '—'}</td>
                      <td style={S.cell}>{f.gla ? sqft(f.gla) : '—'}</td>
                      <td style={S.cell}>{f.comp_count}</td>
                      <td style={S.cell}>
                        {f.application_id && !f.file_deleted
                          ? <Link to={`/internal/app/${f.application_id}`} style={{ color: GOLD }}>
                            {f.ys_loan_number || 'open file'} →
                          </Link>
                          : <span style={{ color: MUTED }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <div style={{ marginTop: 12 }}>
          <Link className="btn ghost small" to={`/internal/research?appraiser_id=${a.id}`}>
            See every property they have shown us →
          </Link>
        </div>
      </section>
    </div>
  );
}

function Contacts({ title, rows, mailto }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={S.label}>{title}</div>
      {rows.map((c, i) => (
        <div key={i} style={{ fontSize: 14, color: INK, display: 'flex', gap: 8, alignItems: 'baseline' }}>
          {mailto ? <a href={`mailto:${c.value}`} style={{ color: GOLD }}>{c.value}</a> : <span>{c.value}</span>}
          {i > 0 && <span style={{ fontSize: 11, color: MUTED }}>(older)</span>}
          {c.times_seen > 1 && <span style={{ fontSize: 11, color: MUTED }}>seen {c.times_seen}×</span>}
        </div>
      ))}
    </div>
  );
}

function Stat({ k, v, hint }) {
  return (
    <div>
      <dt style={{ fontSize: 11, color: MUTED, fontWeight: 700, textTransform: 'uppercase' }} title={hint}>{k}</dt>
      <dd style={{ margin: '2px 0 0', fontSize: 18, fontWeight: 700, color: INK }}>{v}</dd>
      {hint && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}
