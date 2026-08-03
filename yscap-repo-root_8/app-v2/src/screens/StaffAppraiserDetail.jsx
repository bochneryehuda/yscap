import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { INK, MUTED, GOLD, S, money, sqft, num, day, pct } from '../lib/research.js';
import ResearchNav from '../components/ResearchNav.jsx';

/* ONE APPRAISER — their profile, everything we have ever been told about how to
   reach them, every file they appraised for us, every report of theirs we hold,
   and every property they have ever put in front of us.

   THE PROPERTIES LIST IS ONE ROW PER PROPERTY, NOT PER REPORT. An appraiser who
   used the same house as a comparable on four different reports is telling us
   something about that house, and it belongs on one line saying "used 4 times" —
   four identical rows would read as four houses.

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
      <ResearchNav />
      <div style={{ marginBottom: 10 }}>
        <Link to="/internal/research/appraisers" style={{ color: MUTED, fontSize: 13 }}>← Back to Appraisers</Link>
      </div>

      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 2px', color: INK, fontSize: 24 }}>{a.name}</h1>
        {a.company && <div style={{ color: MUTED, fontSize: 15 }}>{a.company}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <span style={S.tag}>{num(a.file_count)} file{a.file_count === 1 ? '' : 's'} for us</span>
          <span style={S.tag}>{num(a.appraisal_count)} report{a.appraisal_count === 1 ? '' : 's'} on files</span>
          {a.import_count > 0 && (
            <span style={S.tag}>{num(a.import_count)} report{a.import_count === 1 ? '' : 's'} added by hand</span>
          )}
          {/* The server's own count, not the length of a list it capped at 2000. */}
          <span style={S.tag}>
            {num((d.totals && d.totals.properties) ?? (d.properties || []).length)}
            {' '}propert{((d.totals && d.totals.properties) ?? (d.properties || []).length) === 1 ? 'y' : 'ies'}
          </span>
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
      </section>

      {/* ---- reports of theirs that are not on a loan file ---- */}
      {(d.imports || []).length > 0 && (
        <section style={{ ...S.panel, marginTop: 14 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>
            Other reports of theirs we hold ({num((d.totals && d.totals.imports) ?? d.imports.length)})
            {(d.totals && d.totals.imports > d.imports.length) && (
              <span style={{ color: MUTED, fontWeight: 400, fontSize: 13 }}> — showing the most recent {num(d.imports.length)}</span>
            )}
          </h2>
          <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
            Reports added straight to the research database — no loan file behind them.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead><tr>
                <th style={S.th}>Date</th><th style={S.th}>Property</th>
                <th style={S.th}>Form</th><th style={S.th}>Comps</th><th style={S.th}>Added from</th>
              </tr></thead>
              <tbody>
                {d.imports.map((r) => (
                  <tr key={r.id}>
                    <td style={S.cell}>{r.effective_date ? day(r.effective_date) : '—'}</td>
                    <td style={S.cell}>
                      {r.subject_property_id
                        ? <Link to={`/internal/research/property/${r.subject_property_id}`} style={{ color: INK }}>
                          {[r.subject_address, r.subject_city, r.subject_state].filter(Boolean).join(', ') || 'the property'}
                        </Link>
                        : [r.subject_address, r.subject_city, r.subject_state].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td style={S.cell}>{r.form_type || '—'}</td>
                    <td style={S.cell}>{num(r.comparables_seen)}</td>
                    <td style={{ ...S.cell, color: MUTED, wordBreak: 'break-all' }}>{r.filename || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---- every property they have ever put in front of us ---- */}
      <PropertiesSection rows={d.properties || []} total={d.totals && d.totals.properties} />
    </div>
  );
}

/* Every property this appraiser has ever described to us, and HOW — as the subject
   of their own report, or as a comparable sale supporting somebody else's value.
   Long lists are the norm here (one busy appraiser can reach a few thousand), so
   the list filters and pages in the browser rather than dumping everything. */
// `total` is the server's real count. `rows` is capped at 2000, and the filter
// and "Show more" below operate inside whatever survived that cap — so the
// heading has to say when it is showing a slice rather than everything.
function PropertiesSection({ rows, total }) {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [shown, setShown] = useState(50);

  const filtered = rows.filter((p) => {
    if (role === 'subject' && !p.as_subject) return false;
    if (role === 'comparable' && !p.as_comparable) return false;
    if (!q.trim()) return true;
    const hay = `${p.display_address || ''} ${p.city || ''} ${p.state || ''} ${p.zip || ''}`.toLowerCase();
    return q.trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  });

  return (
    <section style={{ ...S.panel, marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>
            Every property they have shown us ({num(total ?? rows.length)})
            {(total != null && total > rows.length) && (
              <span style={{ color: MUTED, fontWeight: 400, fontSize: 13 }}> — showing the {num(rows.length)} most recent</span>
            )}
          </h2>
          <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
            Their own subject properties and every comparable sale they have used, across all their reports.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...S.input, width: 200 }} placeholder="Filter by address or town"
            value={q} onChange={(e) => { setQ(e.target.value); setShown(50); }} />
          <select style={{ ...S.input, width: 160 }} value={role}
            onChange={(e) => { setRole(e.target.value); setShown(50); }}>
            <option value="">Subject or comparable</option>
            <option value="subject">Their subjects only</option>
            <option value="comparable">Used as a comparable</option>
          </select>
        </div>
      </div>

      {filtered.length === 0
        ? <div style={{ color: MUTED, fontSize: 13 }}>
          {rows.length === 0 ? 'Nothing has been read in from their reports yet.' : 'Nothing matches that filter.'}
        </div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800 }}>
              <thead><tr>
                <th style={S.th}>Property</th><th style={S.th}>Type</th><th style={S.th}>Beds</th>
                <th style={S.th}>Baths</th><th style={S.th}>Size</th><th style={S.th}>Built</th>
                <th style={S.th}>Condition</th><th style={S.th}>Last sale</th>
                <th style={S.th}>How they used it</th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, shown).map((p) => (
                  <tr key={p.id}>
                    <td style={S.cell}>
                      <Link to={`/internal/research/property/${p.id}`} style={{ color: INK, fontWeight: 600 }}>
                        {p.display_address}
                      </Link>
                      {p.photo_count > 0 && <span style={{ ...S.tag, marginLeft: 6 }}>{p.photo_count} photo{p.photo_count === 1 ? '' : 's'}</span>}
                    </td>
                    <td style={S.cell}>{p.property_type || '—'}{p.units > 1 ? ` · ${p.units} units` : ''}</td>
                    <td style={S.cell}>{p.beds == null ? '—' : p.beds}</td>
                    <td style={S.cell}>{p.baths_total == null ? '—' : Number(p.baths_total)}</td>
                    <td style={S.cell}>{p.gla ? sqft(p.gla) : '—'}</td>
                    <td style={S.cell}>{p.year_built || '—'}</td>
                    <td style={S.cell}>{p.condition_uad || '—'}</td>
                    <td style={S.cell}>
                      {p.last_sale_price ? money(p.last_sale_price) : '—'}
                      {p.last_sale_date && <div style={{ color: MUTED, fontSize: 12 }}>{day(p.last_sale_date)}</div>}
                    </td>
                    <td style={S.cell}>
                      {p.as_subject > 0 && <span style={S.tag}>their subject{p.as_subject > 1 ? ` ×${p.as_subject}` : ''}</span>}
                      {p.as_comparable > 0 && (
                        <span style={{ ...S.tag, marginLeft: p.as_subject > 0 ? 4 : 0 }}>
                          comparable{p.as_comparable > 1 ? ` ×${p.as_comparable}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > shown && (
              <div style={{ marginTop: 10 }}>
                <button className="btn ghost small" onClick={() => setShown((n) => n + 100)}>
                  Show more ({num(filtered.length - shown)} left)
                </button>
              </div>
            )}
          </div>
        )}
    </section>
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
