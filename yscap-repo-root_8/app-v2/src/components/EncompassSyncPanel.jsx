import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

/**
 * WO-D — Encompass sync: a live, full data-comparison screen (READ-ONLY sync).
 *
 * Shows EVERY mapped field side-by-side: our file's value vs the value read live
 * from Encompass, with a status (matches / doesn't match / no data to compare /
 * reference). A mismatch a user wants to adopt can be pulled into our column with
 * one click ("Use Encompass value") — one direction only, Encompass → us, never
 * the reverse. A red banner shows when open mismatches are blocking the term
 * sheet; advisory differences surface but never block. Staff-only surface.
 */

// Short, human labels (the registry `note` is verbose) — falls back to a
// prettified key for anything not listed.
const LABELS = {
  ys_loan_number: 'Loan number', property_type: 'Property type', deal_type: 'Deal / project type',
  exit_plan: 'Exit plan', loan_to_be_vested: 'Vesting (entity / individual)', vesting_llc: 'Subject LLC / vesting',
  loan_amount: 'Loan amount', max_total_loan: 'Max total loan', final_initial_loan: 'Initial advance',
  rehab_budget: 'Rehab / construction budget', financed_rehab_budget: 'Financed rehab',
  purchase_price: 'Purchase price', effective_purchase: 'Effective purchase price', contract_price: 'Seller / contract price',
  assignment_fee: 'Assignment fee', financed_interest_reserve: 'Financed interest reserve', total_cost: 'Total cost',
  as_is_value: 'As-is value', arv: 'ARV (dollars)', actual_arv_ltv: 'Actual ARV-LTV %', actual_ltc: 'Actual LTC %',
  actual_initial_ltv: 'Actual initial LTV %', max_initial_ltv: 'Max initial LTV %', max_arv_ltv: 'Max ARV-LTV %',
  max_ltc: 'Max LTC %', note_rate: 'Interest rate %', origination_pct: 'Origination fee %', term_months: 'Term (months)',
  maturity_date: 'Maturity date', total_experience_deals: 'Experience (deals)', rehab_type: 'Rehab type',
  accrual_type: 'Accrual type', ref_pitia: 'PITIA', ref_cash_to_close: 'Est. cash to close', ref_down_payment: 'Down payment',
  ref_table_funder: 'Table funder', ref_cross_collateralized: 'Cross-collateralized', ref_multi_property: 'Multi-property',
};
const CATEGORY_LABEL = {
  program: 'Program & identity', identity: 'Program & identity', loan: 'Loan & terms', interest: 'Loan & terms',
  valuation: 'Valuation', sizing: 'Sizing & leverage', cost: 'Purchase & cost', rehab: 'Rehab', experience: 'Experience',
};
// A few fields carry no category on the server — pin them to a group by key.
const KEY_GROUP = {
  property_type: 'Program & identity', deal_type: 'Program & identity', exit_plan: 'Program & identity',
  loan_to_be_vested: 'Program & identity', ys_loan_number: 'Program & identity',
};
const GROUP_ORDER = ['Program & identity', 'Loan & terms', 'Valuation', 'Sizing & leverage', 'Purchase & cost', 'Rehab', 'Experience', 'Other'];
function groupOf(f) { return CATEGORY_LABEL[f.category] || KEY_GROUP[f.key] || 'Other'; }

const V = {
  ink: 'var(--ink,#141B22)', muted: 'var(--muted,#4B585C)', line: 'var(--line,#E7E1D3)', paper: 'var(--paper,#F6F3EC)',
  good: 'var(--good,#3F7A5B)', crit: 'var(--crit,#B4483C)', amber: 'var(--amber,#B7791F)', teal: 'var(--teal,#2F7F86)',
};

function label(f) { return LABELS[f.key] || f.key.replace(/_/g, ' '); }

function fmtVal(f, which) {
  const v = f[which];
  if (v === null || v === undefined || v === '') return '—';
  if (f.compare === 'money') {
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v);
  }
  if (f.compare === 'percent') {
    const n = Number(String(v).replace(/[%\s]/g, ''));
    return Number.isFinite(n) ? n + '%' : String(v);
  }
  return String(v);
}

function fmtAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// The status pill for one field.
function statusOf(f) {
  if (f.status === 'match') return { fg: V.good, bg: 'rgba(63,122,91,.10)', text: f.resolution ? 'Matches (pulled)' : 'Matches' };
  if (f.status === 'reference') return { fg: V.muted, bg: V.paper, text: 'Reference' };
  if (f.status === 'incomparable') return { fg: V.muted, bg: V.paper, text: 'No data to compare' };
  // mismatch
  if (!f.open) return { fg: V.good, bg: 'rgba(63,122,91,.10)', text: f.resolution === 'replaced' ? 'Resolved (pulled)' : 'Resolved' };
  if (f.gate === 'advisory') return { fg: V.amber, bg: 'var(--amber-bg,#F6EEDD)', text: 'Differs (advisory)' };
  return { fg: V.crit, bg: 'var(--crit-bg,#F6E7E4)', text: "Doesn't match" };
}

function Pill({ s }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 800, color: s.fg, background: s.bg, border: `1px solid ${s.fg}44`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>
      {s.text}
    </span>
  );
}

export default function EncompassSyncPanel({ appId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');       // fieldKey being replaced, or 'refresh'
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try { setData(await api.encompassFindings(appId)); }
    catch (e) { setErr(e.message || 'Could not load the Encompass comparison.'); }
    finally { setLoading(false); }
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setBusy('refresh'); setErr(''); setFlash('');
    try { setData(await api.encompassRefresh(appId)); setFlash('Refreshed from Encompass.'); }
    catch (e) { setErr(e.message || 'Refresh failed.'); }
    finally { setBusy(''); }
  }, [appId]);

  const replace = useCallback(async (fieldKey) => {
    setBusy(fieldKey); setErr(''); setFlash('');
    try { await api.encompassReplace(appId, fieldKey); await load(); setFlash('Pulled the Encompass value into your file.'); }
    catch (e) { setErr(e.message || 'Could not pull this value.'); }
    finally { setBusy(''); }
  }, [appId, load]);

  if (loading) return <div style={{ color: V.muted, fontSize: 13 }}>Loading the Encompass comparison…</div>;

  const fields = (data && Array.isArray(data.fields)) ? data.fields : [];
  const sum = (data && data.summary) || {};
  const hasLoan = !!(data && data.hasLoan);

  // Gate banner.
  let banner = null;
  if (hasLoan && sum.openBlocking > 0) {
    banner = { fg: V.crit, bg: 'var(--crit-bg,#F6E7E4)', text: `${sum.openBlocking} field${sum.openBlocking === 1 ? '' : 's'} must match (or be resolved) before a term sheet can be issued.` };
  } else if (hasLoan) {
    banner = { fg: V.good, bg: 'rgba(63,122,91,.10)', text: 'Encompass findings are clear — nothing here is blocking the term sheet.' };
  }

  // Split reference-only fields to the bottom.
  const compareFields = fields.filter((f) => f.compare !== 'reference');
  const refFields = fields.filter((f) => f.compare === 'reference');

  return (
    <div style={{ fontSize: 13 }}>
      {/* header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 12, color: V.muted }}>
            {data && data.loanNumber ? <>Loan #<b style={{ color: V.ink }}>{data.loanNumber}</b> · </> : null}
            {hasLoan ? <>read from Encompass {fmtAgo(data.pulledAt)}</> : 'no Encompass loan pulled yet'}
            {data && data.priced === false ? ' · file not yet priced (some fields deferred)' : ''}
          </div>
        </div>
        <button onClick={refresh} disabled={!!busy}
          style={{ fontSize: 12, fontWeight: 700, color: V.teal, background: 'transparent', border: `1px solid ${V.teal}66`, borderRadius: 8, padding: '5px 11px', cursor: busy ? 'default' : 'pointer' }}>
          {busy === 'refresh' ? 'Refreshing…' : '↻ Refresh from Encompass'}
        </button>
      </div>

      {banner && (
        <div style={{ fontSize: 12.5, fontWeight: 700, color: banner.fg, background: banner.bg, border: `1px solid ${banner.fg}44`, borderRadius: 8, padding: '8px 11px', marginBottom: 10 }}>
          {banner.text}
        </div>
      )}
      {flash && <div style={{ fontSize: 12, color: V.good, marginBottom: 8 }}>{flash}</div>}
      {err && <div style={{ fontSize: 12, color: V.crit, marginBottom: 8 }}>{err}</div>}

      {data && !hasLoan && (
        <div style={{ color: V.muted, fontSize: 12.5, background: V.paper, border: `1px solid ${V.line}`, borderRadius: 8, padding: '10px 12px' }}>
          No Encompass loan is linked to this file yet. Set the file's loan number (it pulls automatically), or press “Refresh from Encompass”.
          {data.lastError ? <div style={{ marginTop: 5, color: V.crit }}>Last attempt: {data.lastError}</div> : null}
        </div>
      )}

      {hasLoan && (
        <>
          {/* summary chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, fontSize: 11 }}>
            <span style={{ color: V.muted }}>{sum.compared} compared:</span>
            <span style={{ color: V.good, fontWeight: 700 }}>{sum.matched} match</span>
            {sum.openBlocking > 0 && <span style={{ color: V.crit, fontWeight: 700 }}>· {sum.openBlocking} don't match</span>}
            {sum.openAdvisory > 0 && <span style={{ color: V.amber, fontWeight: 700 }}>· {sum.openAdvisory} advisory</span>}
            {sum.resolved > 0 && <span style={{ color: V.good, fontWeight: 700 }}>· {sum.resolved} resolved</span>}
            {sum.incomparable > 0 && <span style={{ color: V.muted }}>· {sum.incomparable} no data</span>}
          </div>

          <ComparisonTable fields={compareFields} busy={busy} onReplace={replace} withActions />
          {refFields.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: V.muted, margin: '0 0 4px' }}>
                Reference (read from Encompass, not matched)
              </div>
              <ComparisonTable fields={refFields} busy={busy} onReplace={replace} withActions={false} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One comparison row.
function Row({ f, busy, onReplace, withActions }) {
  const s = statusOf(f);
  const canReplace = withActions && f.writable && f.status === 'mismatch' && f.open && f.theirs != null && f.theirs !== '';
  return (
    <tr style={{ borderTop: `1px solid ${V.line}` }}>
      <td style={{ padding: '7px 10px', color: V.ink }}>{label(f)}</td>
      <td style={{ padding: '7px 10px', color: V.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtVal(f, 'ours')}</td>
      <td style={{ padding: '7px 10px', color: f.status === 'mismatch' && f.open ? V.ink : V.muted, fontVariantNumeric: 'tabular-nums' }}>{fmtVal(f, 'theirs')}</td>
      <td style={{ padding: '7px 10px' }}><Pill s={s} /></td>
      {withActions && (
        <td style={{ padding: '7px 10px', textAlign: 'right' }}>
          {canReplace ? (
            <button onClick={() => onReplace(f.key)} disabled={!!busy}
              style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: V.teal, border: 'none', borderRadius: 7, padding: '4px 9px', cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
              {busy === f.key ? 'Pulling…' : 'Use Encompass value'}
            </button>
          ) : null}
        </td>
      )}
    </tr>
  );
}

// The comparison table. With actions, fields are COLLECTED into display groups
// (each subheader appears once, in GROUP_ORDER); the reference table is flat.
function ComparisonTable({ fields, busy, onReplace, withActions }) {
  const cols = withActions ? 5 : 4;
  // Collect into groups (registry order preserved within each group).
  const byGroup = {};
  for (const f of fields) {
    const g = withActions ? groupOf(f) : '__flat';
    (byGroup[g] = byGroup[g] || []).push(f);
  }
  const order = withActions
    ? GROUP_ORDER.filter((g) => byGroup[g]).concat(Object.keys(byGroup).filter((g) => !GROUP_ORDER.includes(g)))
    : ['__flat'];
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${V.line}`, borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: V.muted, fontSize: 11 }}>
            <th style={{ padding: '6px 10px', fontWeight: 700 }}>Field</th>
            <th style={{ padding: '6px 10px', fontWeight: 700 }}>Our file</th>
            <th style={{ padding: '6px 10px', fontWeight: 700 }}>Encompass</th>
            <th style={{ padding: '6px 10px', fontWeight: 700 }}>Status</th>
            {withActions && <th style={{ padding: '6px 10px', fontWeight: 700 }} />}
          </tr>
        </thead>
        <tbody>
          {order.map((g) => (
            <React.Fragment key={g}>
              {withActions && (
                <tr><td colSpan={cols} style={{ padding: '8px 10px 3px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: V.muted, background: V.paper }}>{g}</td></tr>
              )}
              {byGroup[g].map((f) => <Row key={f.key} f={f} busy={busy} onReplace={onReplace} withActions={withActions} />)}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
