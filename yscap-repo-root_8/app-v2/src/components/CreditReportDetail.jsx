import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* CreditReportDetail — the "View full report" screen (E3). Opens over a file's
   credit section and shows EVERYTHING the bureau reported beyond the score:
   per-borrower tabs, per-bureau scores, a prominent Alerts / Risk panel, and the
   tradelines / inquiries / public records / collections / reported identity that
   import.js parsed into blocks. Read-only. Account numbers are masked last-4 (the
   server never sends the full number). */

const money = (v) => (v == null || v === '' ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
const day = (v) => (v ? String(v).slice(0, 10) : '—');

const ALERT_LABEL = {
  fraud_alert: 'Fraud alert', active_duty: 'Active-duty military', deceased: 'Deceased / Death Master',
  ofac: 'OFAC / SDN match', ssn_alert: 'SSN alert', address_discrepancy: 'Address discrepancy',
  high_risk_score: 'High-risk fraud score', security_freeze: 'Security freeze',
  consumer_statement: 'Consumer statement', other: 'Credit-file alert',
};
const FATAL_ALERT = new Set(['fraud_alert', 'active_duty', 'deceased', 'ofac', 'ssn_alert', 'address_discrepancy']);

function Section({ title, count, children }) {
  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{title}</strong>
        {count != null && <span className="muted small">{count}</span>}
      </div>
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="panel" style={{ padding: '6px 10px', minWidth: 110 }}>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 16, color: tone ? `var(--${tone})` : undefined }}><strong>{value}</strong></div>
    </div>
  );
}

/* Advisory RISK SUMMARY — an at-a-glance digest of the report for the
   underwriter (utilization, derogatories, collections, inquiries, thin-file). It
   never blocks; the alerts above are the gate. */
function RiskSummary({ s }) {
  if (!s) return null;
  const util = s.revolvingUtilizationPct;
  const utilTone = util == null ? undefined : util >= 50 ? 'danger' : util >= 30 ? 'gold' : 'teal';
  const flagTone = (sev) => (sev === 'high' ? 'danger' : sev === 'medium' ? 'gold' : 'teal');
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Stat label="Own accounts" value={`${s.openTradelineCount} open / ${s.tradelineCount}`} />
        <Stat label="Total balance" value={money(s.totalBalance)} />
        <Stat label="Revolving use" value={util == null ? '—' : `${util}%`} tone={utilTone} />
        <Stat label="Derogatory" value={s.derogatoryCount} tone={s.derogatoryCount > 0 ? 'danger' : undefined} />
        <Stat label="Collections" value={s.collectionsCount > 0 ? `${s.collectionsCount} (${money(s.collectionsTotal)})` : '0'} tone={s.collectionsCount > 0 ? 'danger' : undefined} />
        <Stat label="Public records" value={s.publicRecordCount} tone={s.publicRecordCount > 0 ? 'danger' : undefined} />
        <Stat label="Inquiries (6mo)" value={s.recentInquiries6mo} tone={s.recentInquiries6mo >= 4 ? 'gold' : undefined} />
        <Stat label="Late 30/60/90" value={`${s.late30Count}/${s.late60Count}/${s.late90Count}`} tone={(s.late60Count + s.late90Count) > 0 ? 'danger' : s.late30Count > 0 ? 'gold' : undefined} />
        {s.oldestAccountMonths != null && <Stat label="Oldest account" value={`${Math.floor(s.oldestAccountMonths / 12)}y ${Math.round(s.oldestAccountMonths % 12)}m`} />}
      </div>
      {s.flags && s.flags.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {s.flags.map((f) => (
            <span key={f.key} className="tchip" style={{ borderColor: `var(--${flagTone(f.severity)})` }}>{f.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function AlertsPanel({ alerts }) {
  if (!alerts || !alerts.length) {
    return <div className="notice ok" style={{ marginTop: 8 }}>No fraud, OFAC, freeze, or address alerts on this report.</div>;
  }
  const fatal = alerts.filter((a) => FATAL_ALERT.has(a.category));
  return (
    <div className={`notice ${fatal.length ? 'err' : ''}`} style={{ marginTop: 8, borderLeft: `4px solid var(--${fatal.length ? 'danger' : 'gold'})` }} role="alert">
      <strong>{fatal.length ? `⚠ ${alerts.length} alert${alerts.length > 1 ? 's' : ''} on this credit file` : `ⓘ ${alerts.length} alert${alerts.length > 1 ? 's' : ''} on this credit file`}</strong>
      <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
        {alerts.map((a) => (
          <div key={a.id} style={{ borderLeft: `3px solid var(--${FATAL_ALERT.has(a.category) ? 'danger' : 'gold'})`, paddingLeft: 8 }}>
            <span className="tchip" style={{ borderColor: FATAL_ALERT.has(a.category) ? 'var(--danger)' : 'var(--gold)', marginRight: 6 }}>
              {ALERT_LABEL[a.category] || a.category}
            </span>
            {a.bureau && <span className="muted small">{a.bureau}</span>}
            {a.message_text && <div className="small" style={{ marginTop: 2 }}>{a.message_text}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreStrip({ scores }) {
  if (!scores || !scores.length) return <div className="muted small">No scores on this report.</div>;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {scores.map((s, i) => (
        <div key={i} className="panel" style={{ padding: '6px 10px', minWidth: 120 }}>
          <div className="muted small">{s.bureau}</div>
          <div style={{ fontSize: 18 }}><strong>{s.usable && s.value != null ? s.value : '—'}</strong></div>
          <div className="muted small">{s.model || ''}</div>
          {!s.usable && (s.exclusion_reason || s.reason) && <div className="small" style={{ color: 'var(--danger)' }}>{s.exclusion_reason || s.reason}</div>}
        </div>
      ))}
    </div>
  );
}

function TradelineTable({ tradelines }) {
  if (!tradelines || !tradelines.length) return <div className="muted small">No tradelines.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl small" style={{ width: '100%', minWidth: 640 }}>
        <thead><tr>
          <th style={{ textAlign: 'left' }}>Creditor</th><th>Type</th><th>Owner</th><th>Status</th>
          <th>Account</th><th style={{ textAlign: 'right' }}>Balance</th><th style={{ textAlign: 'right' }}>Limit</th>
          <th>Opened</th><th>30/60/90</th><th>Bureau</th>
        </tr></thead>
        <tbody>
          {tradelines.map((t) => (
            <tr key={t.id} style={t.is_collection || t.derogatory_indicator ? { color: 'var(--danger)' } : undefined}>
              <td style={{ textAlign: 'left' }}>
                <strong>{t.creditor_name || '—'}</strong>
                {t.is_collection && <span className="tchip" style={{ marginLeft: 6, borderColor: 'var(--danger)' }}>Collection</span>}
                {t.is_authorized_user && <span className="tchip" style={{ marginLeft: 6 }}>Auth. user</span>}
              </td>
              <td>{t.account_type || '—'}</td>
              <td>{t.account_ownership_type || '—'}</td>
              <td>{t.account_status_type || '—'}</td>
              <td>{t.account_identifier_masked || '—'}</td>
              <td style={{ textAlign: 'right' }}>{money(t.unpaid_balance)}</td>
              <td style={{ textAlign: 'right' }}>{money(t.credit_limit)}</td>
              <td>{day(t.date_opened)}</td>
              <td>{[t.late_30_count, t.late_60_count, t.late_90_count].map((n) => (n == null ? 0 : n)).join('/')}</td>
              <td>{t.bureau || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IdentityBlock({ identities }) {
  if (!identities || !identities.length) return <div className="muted small">No reported identity on file.</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {identities.map((id) => (
        <div key={id.id} className="panel" style={{ padding: 8 }}>
          <div className="muted small">{id.bureau || 'Bureau'}</div>
          <div><strong>{id.reported_name || '—'}</strong>{id.ssn_masked ? <span className="muted small"> · SSN •••-••-{id.ssn_masked}</span> : null}{id.dob ? <span className="muted small"> · DOB {day(id.dob)}</span> : null}</div>
          {id.current_address && <div className="small">Address: {typeof id.current_address === 'string' ? id.current_address : JSON.stringify(id.current_address)}</div>}
          {Array.isArray(id.aliases) && id.aliases.length > 0 && <div className="small muted">Also known as: {id.aliases.join('; ')}</div>}
          {Array.isArray(id.former_addresses) && id.former_addresses.length > 0 && <div className="small muted">Former: {id.former_addresses.join(' · ')}</div>}
          {Array.isArray(id.employers) && id.employers.length > 0 && <div className="small muted">Employer: {id.employers.join('; ')}</div>}
        </div>
      ))}
    </div>
  );
}

export default function CreditReportDetail({ reportId, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState(null);

  useEffect(() => {
    let live = true;
    setData(null); setErr('');
    api.creditReportDetail(reportId).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [reportId]);

  const body = () => {
    if (err) return <div className="notice err">{err}</div>;
    if (!data) return <div className="muted">Loading the full report…</div>;
    const { report, scores, tradelines, inquiries, publicRecords, collections, identities, alerts, borrowerNames, riskSummary, riskByBorrower } = data;
    const borrowerIds = [...new Set([...(scores || []), ...(tradelines || []), ...(identities || [])].map((x) => x.borrower_id).filter(Boolean))];
    const tabs = borrowerIds.length > 1
      ? [{ id: '__all__', name: 'All borrowers' }, ...borrowerIds.map((id) => ({ id, name: borrowerNames[id] || 'Borrower' }))]
      : borrowerIds.map((id) => ({ id, name: borrowerNames[id] || 'Borrower' }));
    const active = tab || (tabs[0] && tabs[0].id) || '__all__';
    const forB = (arr) => (active === '__all__' ? (arr || []) : (arr || []).filter((x) => x.borrower_id === active));

    const tls = forB(tradelines);
    return (
      <>
        <div className="muted small">
          {report.action_type || 'Order'} · {report.other_description || report.report_type || 'Credit report'}
          {report.first_issued_date ? ` · ${day(report.first_issued_date)}` : ''}
          {report.mismo_version ? ` · MISMO ${report.mismo_version}` : ''}
          {report.representative_score != null ? ` · Representative FICO ${report.representative_score} (${report.representative_bracket || '—'})` : ''}
        </div>

        {/* Alerts / risk — always at the top, report-level. */}
        <AlertsPanel alerts={alerts} />

        {tabs.length > 1 && (
          <div className="seg" role="tablist" style={{ display: 'inline-flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {tabs.map((t) => (
              <button key={t.id} className={`btn small ${active === t.id ? 'primary' : 'ghost'}`} onClick={() => setTab(t.id)}>{t.name}</button>
            ))}
          </div>
        )}

        <Section title="Risk summary" count={active === '__all__' ? 'all borrowers' : null}>
          <RiskSummary s={active === '__all__' ? riskSummary : (riskByBorrower && riskByBorrower[active])} />
        </Section>

        <Section title="Scores by bureau">
          <ScoreStrip scores={forB(scores)} />
        </Section>

        <Section title="Tradelines" count={tls.length}>
          <TradelineTable tradelines={tls} />
        </Section>

        <Section title="Collections" count={forB(collections).length}>
          {forB(collections).length === 0 ? <div className="muted small">None.</div> : (
            <ul className="small" style={{ margin: '0 0 0 18px' }}>
              {forB(collections).map((c) => (
                <li key={c.id}>{c.collection_agency_name || 'Collection'} — {money(c.amount)} {c.status ? `· ${c.status}` : ''} {c.date_reported ? `· ${day(c.date_reported)}` : ''} <span className="muted">({c.bureau || '—'})</span></li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Public records" count={forB(publicRecords).length}>
          {forB(publicRecords).length === 0 ? <div className="muted small">None.</div> : (
            <ul className="small" style={{ margin: '0 0 0 18px' }}>
              {forB(publicRecords).map((p) => (
                <li key={p.id} style={{ color: 'var(--danger)' }}>{p.record_type || 'Record'} — filed {day(p.filed_date)} {p.amount != null ? `· ${money(p.amount)}` : ''} {p.disposition_type ? `· ${p.disposition_type}` : ''} {p.court_name ? `· ${p.court_name}` : ''}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent inquiries" count={forB(inquiries).length}>
          {forB(inquiries).length === 0 ? <div className="muted small">None.</div> : (
            <ul className="small" style={{ margin: '0 0 0 18px' }}>
              {forB(inquiries).map((q) => (
                <li key={q.id}>{day(q.inquiry_date)} — {q.inquiring_party_name || 'Inquiry'} {q.business_type ? `· ${q.business_type}` : ''} <span className="muted">({q.bureau || '—'})</span></li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Identity as reported by the bureau">
          <IdentityBlock identities={forB(identities)} />
        </Section>
      </>
    );
  };

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ maxWidth: 1040, width: '96%', height: '92vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '2px 2px 10px' }}>
          <h3 style={{ margin: 0 }}>Full credit report</h3>
          <button className="btn ghost small" onClick={onClose}>Close ✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {body()}
        </div>
      </div>
    </div>
  );
}
