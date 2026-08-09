import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth.jsx';
import { askPrompt } from '../lib/dialog.js';

/**
 * Encompass sync — the live, full data-comparison screen (READ-ONLY sync).
 *
 * Shows EVERY mapped field side-by-side: our file's value vs the value read live
 * from Encompass, with a plain-language status. Owner-directed 2026-07-26: this
 * section PASSES only when EVERY field MATCHES — a difference, an advisory
 * difference, or a "no data to compare" (Encompass doesn't have it yet) all count
 * as NOT passing, and a term sheet cannot be issued until the section passes. When
 * a file has no loan number, staff type it right here and it syncs on the spot.
 * A mismatch a user wants to fix our-side can be pulled from Encompass with one
 * click ("Use Encompass value") — one direction only, Encompass → us. Staff-only.
 */

// Short, human labels (falls back to a prettified key for anything not listed).
const LABELS = {
  ys_loan_number: 'Loan number', property_type: 'Property type', units: '# of units',
  deal_type: 'Deal / project type', exit_plan: 'Exit plan', loan_to_be_vested: 'Vesting (entity / individual)',
  vesting_title_role: 'Vesting title role (Officer / Individual · field 4008)',
  vesting_llc: 'Subject LLC / vesting', capital_provider: 'Note buyer / capital provider',
  // Borrower + co-borrower identity + subject address
  id_borrower_name: 'Borrower name', id_dob: 'Date of birth', id_email: 'Email',
  id_phone: 'Phone', id_property_address: 'Property address',
  id_ssn: 'Social Security number',
  id_coborrower_name: 'Co-borrower name', id_coborrower_dob: 'Co-borrower date of birth',
  id_coborrower_email: 'Co-borrower email', id_coborrower_phone: 'Co-borrower phone',
  id_coborrower_ssn: 'Co-borrower Social Security number',
  loan_amount: 'Loan amount', max_total_loan: 'Max total loan', final_initial_loan: 'Initial advance',
  rehab_budget: 'Rehab / construction budget', financed_rehab_budget: 'Financed rehab',
  purchase_price: 'Purchase price', effective_purchase: 'Effective purchase price', contract_price: 'Seller / contract price',
  assignment_fee: 'Assignment fee', financed_interest_reserve: 'Financed interest reserve', total_cost: 'Total cost',
  as_is_value: 'As-is value', arv: 'ARV (dollars)', actual_arv_ltv: 'Actual ARV-LTV %', actual_ltc: 'Actual LTC %',
  actual_initial_ltv: 'Actual initial LTV %', max_initial_ltv: 'Max initial LTV %', max_arv_ltv: 'Max ARV-LTV %',
  max_ltc: 'Max LTC %', note_rate: 'Interest rate %', origination_pct: 'Origination fee %', term_months: 'Term (months)',
  maturity_date: 'Maturity date', total_experience_deals: 'Experience (deals)', rehab_type: 'Rehab type',
  accrual_type: 'Accrual type', ref_cash_to_close: 'Est. cash to close', ref_down_payment: 'Down payment',
  ref_table_funder: 'Table funder', ref_cross_collateralized: 'Cross-collateralized', ref_multi_property: 'Multi-property',
};
const CATEGORY_LABEL = {
  program: 'Program & identity', identity: 'Borrower & property', loan: 'Loan & terms', interest: 'Loan & terms',
  valuation: 'Valuation', sizing: 'Sizing & leverage', cost: 'Purchase & cost', rehab: 'Rehab', experience: 'Experience',
};
// A few fields carry no category on the server — pin them to a group by key.
const KEY_GROUP = {
  property_type: 'Program & identity', units: 'Program & identity', deal_type: 'Program & identity',
  exit_plan: 'Program & identity', loan_to_be_vested: 'Program & identity', ys_loan_number: 'Program & identity',
};
const GROUP_ORDER = ['Program & identity', 'Borrower & property', 'Loan & terms', 'Valuation', 'Sizing & leverage', 'Purchase & cost', 'Rehab', 'Experience', 'Other'];
function groupOf(f) { return CATEGORY_LABEL[f.category] || KEY_GROUP[f.key] || 'Other'; }

// EXPLICIT dark colors — never `var(--x)` here. The portal is white-first, and
// leaning on CSS variables rendered this whole panel white-on-white (owner report
// 2026-07-26) because `--ink`/`--muted`/… resolved light in this container. Per
// the CLAUDE.md hard rule, all portal text is dark on white — so every text color
// below is a concrete dark value that can never render light. `line`/`paper` and
// the *Bg values are the only light values (borders / subtle pill backgrounds).
const V = {
  ink: '#141B22', muted: '#3A4550', line: '#D9D2C4', paper: '#F4F1E9',
  good: '#2E6B4A', crit: '#A83A2F', amber: '#7A5510', teal: '#25636A',
  critBg: '#F7E7E4', amberBg: '#F6EEDD', goodBg: '#E6F0EA',
};

function label(f) { return LABELS[f.key] || f.key.replace(/^id_/, '').replace(/_/g, ' '); }

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

// The status pill for one field. Owner-directed 2026-07-26: everything must MATCH,
// so a difference OR a "no data to compare" both read as attention-needed — only a
// real match is green.
function statusOf(f) {
  if (f.status === 'match') return { fg: V.good, bg: V.goodBg, text: f.resolution === 'replaced' ? 'Matches (pulled)' : 'Matches' };
  if (f.status === 'reference') return { fg: V.muted, bg: V.paper, text: 'Reference (not checked)' };
  // A super-admin granted an exception on this field — it passes the gate. A pending
  // request is awaiting the super admin and still blocks.
  if (f.excepted) return { fg: V.teal, bg: '#E3EEF0', text: 'Exception granted' };
  if (f.exceptionRequested) return { fg: V.amber, bg: V.amberBg, text: 'Exception requested' };
  // NOT APPLICABLE — this field can't exist on this kind of loan (an exit plan on a
  // bridge / ground-up deal). There is nothing to go and enter, and the section does
  // NOT wait on it, so it must not look like an attention-needed "no data" row.
  if (f.status === 'incomparable' && f.naWhenOursMissing && (f.oursNorm === null || f.oursNorm === undefined || f.oursNorm === '')) {
    return { fg: V.muted, bg: V.paper, text: "Doesn't apply to this loan" };
  }
  if (f.status === 'incomparable') return { fg: V.amber, bg: V.amberBg, text: 'No data to compare' };
  // mismatch — any difference now needs to be fixed so the two sides match
  if (f.resolution === 'accepted') return { fg: V.crit, bg: V.critBg, text: 'Still differs' };
  return { fg: V.crit, bg: V.critBg, text: "Doesn't match" };
}

function Pill({ s }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 800, color: s.fg, background: s.bg, border: `1px solid ${s.fg}55`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>
      {s.text}
    </span>
  );
}

// A short plain-language legend so staff know what each status means.
function Legend() {
  const item = (fg, bg, title, desc) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 3 }}>
      <span style={{ flex: '0 0 auto', fontSize: 11, fontWeight: 800, color: fg, background: bg, border: `1px solid ${fg}55`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>{title}</span>
      <span style={{ color: V.muted, fontSize: 11.5 }}>{desc}</span>
    </div>
  );
  return (
    <details style={{ marginBottom: 10, background: V.paper, border: `1px solid ${V.line}`, borderRadius: 8, padding: '8px 11px' }}>
      <summary style={{ cursor: 'pointer', color: V.ink, fontWeight: 700, fontSize: 12 }}>What these mean</summary>
      <div style={{ marginTop: 7 }}>
        {item(V.good, V.goodBg, 'Matches', 'Our file and Encompass agree on this — good.')}
        {item(V.crit, V.critBg, "Doesn't match", 'The two do not agree. Fix it (on either side) so they match — this holds the term sheet.')}
        {item(V.amber, V.amberBg, 'No data to compare', 'Encompass has nothing entered for this. Add it in Encompass so it can be checked — an empty field is NOT a pass.')}
        {item(V.teal, '#E3EEF0', 'Exception granted', 'A super admin decided this field doesn’t need to match, with a reason — it no longer holds the term sheet. (It re-blocks on its own if the values later change.)')}
        {item(V.muted, V.paper, 'Reference', 'Shown for context only — not checked, never holds the term sheet.')}
        <div style={{ color: V.ink, fontSize: 11.5, fontWeight: 700, marginTop: 6 }}>
          Every checked field must say “Matches” (or have a super-admin exception) before a term sheet can be issued.
        </div>
        <div style={{ color: V.muted, fontSize: 11, marginTop: 4 }}>
          Can’t make a field match? Use “Escalate to super admin” — a super admin can grant an exception so it stops holding the term sheet.
        </div>
      </div>
    </details>
  );
}


// SUPER-ADMIN troubleshooting view (owner-directed 2026-07-26). Shows the RAW data
// Encompass actually sent for this file, what each piece maps to, and a plain
// sentence for why a row isn't matching — so a wrong/missing field id is obvious
// instead of guessed at. Read-only; SSN values are redacted server-side.
function RawTroubleshoot({ appId }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setD(await api.encompassRaw(appId)); }
    catch (e) { setErr(e && e.message ? e.message : 'Could not load the raw data.'); }
    finally { setBusy(false); }
  }, [appId]);
  const th = { textAlign: 'left', padding: '5px 8px', color: V.muted, fontWeight: 800, fontSize: 11, borderBottom: `1px solid ${V.line}`, whiteSpace: 'nowrap' };
  const td = { padding: '5px 8px', color: V.ink, fontSize: 11.5, borderBottom: `1px solid ${V.line}`, verticalAlign: 'top' };
  return (
    <div style={{ marginTop: 14, border: `1px solid ${V.line}`, borderRadius: 8, background: V.paper }}>
      <button
        type="button"
        onClick={() => { const n = !open; setOpen(n); if (n && !d && !busy) load(); }}
        style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer', padding: '9px 11px', color: V.ink, fontWeight: 800, fontSize: 12 }}
      >
        {open ? '▾' : '▸'} Troubleshoot — show the raw Encompass data (super-admin)
      </button>
      {open && (
        <div style={{ padding: '0 11px 11px' }}>
          <div style={{ color: V.muted, fontSize: 11.5, marginBottom: 8 }}>
            Exactly what Encompass sent us for this file, what each value maps to, and why a row isn’t matching.
            Read-only. Social Security numbers are never shown here.
          </div>
          {busy && <div style={{ color: V.muted, fontSize: 12 }}>Loading…</div>}
          {err && <div style={{ color: V.crit, fontSize: 12 }}>{err}</div>}
          {d && (
            <>
              <div style={{ color: V.ink, fontSize: 11.5, marginBottom: 6 }}>
                Encompass returned <b>{d.rawFieldCount}</b> mapped field(s).{' '}
                {d.missingFromEncompass && d.missingFromEncompass.length > 0 && (
                  <span style={{ color: V.amber }}>
                    <b>{d.missingFromEncompass.length}</b> field(s) came back empty — see “Nothing came back” below.
                  </span>
                )}
              </div>
              {d.missingFromEncompass && d.missingFromEncompass.length > 0 && (
                <details style={{ marginBottom: 10 }}>
                  <summary style={{ cursor: 'pointer', color: V.ink, fontWeight: 700, fontSize: 12 }}>
                    Nothing came back from Encompass ({d.missingFromEncompass.length})
                  </summary>
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6, background: '#fff' }}>
                    <thead><tr><th style={th}>Field</th><th style={th}>Encompass field id</th><th style={th}>Our value</th></tr></thead>
                    <tbody>
                      {d.missingFromEncompass.map((r) => (
                        <tr key={r.key}>
                          <td style={td}>{LABELS[r.key] || r.label || r.key}</td>
                          <td style={td}><code>{r.encompassFieldId || '—'}</code></td>
                          <td style={td}>{r.ours == null || r.ours === '' ? '—' : String(r.ours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
              <details style={{ marginBottom: 10 }}>
                <summary style={{ cursor: 'pointer', color: V.ink, fontWeight: 700, fontSize: 12 }}>
                  Raw values Encompass sent ({d.rawFieldCount})
                </summary>
                <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
                    <thead><tr><th style={th}>Encompass field</th><th style={th}>Raw value</th><th style={th}>Maps to</th></tr></thead>
                    <tbody>
                      {d.raw.map((r) => (
                        <tr key={r.encompassFieldId}>
                          <td style={td}><code>{r.encompassFieldId}</code></td>
                          <td style={{ ...td, wordBreak: 'break-word' }}>{typeof r.rawValue === 'object' ? JSON.stringify(r.rawValue) : String(r.rawValue)}</td>
                          <td style={td}>{r.mapsToField ? (LABELS[r.mapsToField] || r.mapsToField) : <span style={{ color: V.muted }}>not mapped</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              <details>
                <summary style={{ cursor: 'pointer', color: V.ink, fontWeight: 700, fontSize: 12 }}>
                  Why each field is / isn’t matching ({d.rows.length})
                </summary>
                <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
                    <thead><tr><th style={th}>Field</th><th style={th}>Ours</th><th style={th}>Encompass</th><th style={th}>After tidying up</th><th style={th}>Why</th></tr></thead>
                    <tbody>
                      {d.rows.map((r) => (
                        <tr key={r.key}>
                          <td style={td}>{LABELS[r.key] || r.label || r.key}<div style={{ color: V.muted, fontSize: 10 }}><code>{r.encompassFieldId || '—'}</code></div></td>
                          <td style={td}>{r.ours == null || r.ours === '' ? '—' : String(r.ours)}</td>
                          <td style={td}>{r.theirs == null || r.theirs === '' ? '—' : String(r.theirs)}</td>
                          <td style={{ ...td, color: V.muted }}>{String(r.oursNorm ?? '—')} vs {String(r.theirsNorm ?? '—')}</td>
                          <td style={td}>{r.why}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function EncompassSyncPanel({ appId }) {
  const { role } = useAuth();
  const isSuper = role === 'super_admin';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');       // fieldKey being replaced, 'refresh', or 'loan'
  const [flash, setFlash] = useState('');
  const [loanInput, setLoanInput] = useState('');

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

  // Any assigned staffer escalates a not-matching / "no data" field to a super admin.
  const requestException = useCallback(async (fieldKey) => {
    const reason = await askPrompt('Why should this field be excepted? A short note for the super admin.');
    if (reason == null) return;                          // cancelled
    if (!reason.trim()) { setErr('Add a short reason to request an exception.'); return; }
    setBusy(fieldKey); setErr(''); setFlash('');
    try { await api.encompassRequestException(appId, fieldKey, reason.trim()); await load(); setFlash('Exception requested — a super admin will review it.'); }
    catch (e) { setErr(e.message || 'Could not request an exception.'); }
    finally { setBusy(''); }
  }, [appId, load]);

  // Super admin grants / denies / revokes a field exception.
  const decideException = useCallback(async (fieldKey, decision) => {
    let reason = '';
    if (decision === 'grant') {
      const r = await askPrompt('Reason for granting this exception (recorded on the file):');
      if (r == null) return;
      if (!r.trim()) { setErr('Add a short reason to grant an exception.'); return; }
      reason = r.trim();
    }
    setBusy(fieldKey); setErr(''); setFlash('');
    try {
      await api.encompassDecideException(appId, fieldKey, decision, reason);
      await load();
      setFlash(decision === 'grant'
        ? 'Exception granted — this field no longer holds the term sheet.'
        : (decision === 'revoke' ? 'Exception removed — this field must match again.' : 'Exception denied.'));
    } catch (e) { setErr(e.message || 'Could not update the exception.'); }
    finally { setBusy(''); }
  }, [appId, load]);

  // Type the loan number → set it (the server saves it AND pulls Encompass) → reload.
  const submitLoan = useCallback(async () => {
    const v = (loanInput || '').trim();
    if (!v) return;
    setBusy('loan'); setErr(''); setFlash('');
    try {
      await api.staffSetLoanNumber(appId, v);
      await load();  // the set-loan-number route pulls Encompass, so the results appear
      setLoanInput('');
      setFlash('Loan number saved — syncing with Encompass.');
    } catch (e) {
      setErr(e.message || 'Could not set the loan number.');
    } finally { setBusy(''); }
  }, [appId, loanInput, load]);

  if (loading) return <div style={{ color: V.muted, fontSize: 13 }}>Loading the Encompass comparison…</div>;

  const fields = (data && Array.isArray(data.fields)) ? data.fields : [];
  const sum = (data && data.summary) || {};
  const hasLoan = !!(data && data.hasLoan);
  const notPassing = Number(sum.notPassing || 0);

  // Gate banner.
  let banner = null;
  if (hasLoan && notPassing > 0) {
    banner = { fg: V.crit, bg: V.critBg, text: `${notPassing} field${notPassing === 1 ? '' : 's'} must match Encompass (or have their data entered in Encompass) before a term sheet can be issued.` };
  } else if (hasLoan) {
    banner = { fg: V.good, bg: V.goodBg, text: 'Everything matches Encompass — this section is passed. A term sheet can be issued.' };
  }

  // Split reference-only fields to the bottom.
  const compareFields = fields.filter((f) => f.compare !== 'reference');
  const refFields = fields.filter((f) => f.compare === 'reference');

  return (
    <div style={{ fontSize: 13, color: V.ink }}>
      {/* header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 12, color: V.muted }}>
            {data && data.loanNumber ? <>Loan #<b style={{ color: V.ink }}>{data.loanNumber}</b> · </> : null}
            {hasLoan ? <>read from Encompass {fmtAgo(data.pulledAt)}</> : 'no Encompass loan pulled yet'}
            {data && data.priced === false ? ' · file not yet priced (some fields will show no data)' : ''}
          </div>
        </div>
        {hasLoan && (
          <button onClick={refresh} disabled={!!busy}
            style={{ fontSize: 12, fontWeight: 700, color: V.teal, background: 'transparent', border: `1px solid ${V.teal}66`, borderRadius: 8, padding: '5px 11px', cursor: busy ? 'default' : 'pointer' }}>
            {busy === 'refresh' ? 'Refreshing…' : '↻ Refresh from Encompass'}
          </button>
        )}
      </div>

      {banner && (
        <div style={{ fontSize: 12.5, fontWeight: 700, color: banner.fg, background: banner.bg, border: `1px solid ${banner.fg}55`, borderRadius: 8, padding: '8px 11px', marginBottom: 10 }}>
          {banner.text}
        </div>
      )}
      {flash && <div style={{ fontSize: 12, color: V.good, marginBottom: 8 }}>{flash}</div>}
      {err && <div style={{ fontSize: 12, color: V.crit, marginBottom: 8 }}>{err}</div>}

      {hasLoan && <Legend />}

      {data && !hasLoan && (
        <div style={{ color: V.ink, fontSize: 12.5, background: V.paper, border: `1px solid ${V.line}`, borderRadius: 8, padding: '12px 13px' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>No Encompass loan is linked to this file yet.</div>
          <div style={{ color: V.muted, marginBottom: 9 }}>Type the loan number below — it saves and syncs with Encompass right away, and the comparison appears here.</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input
              value={loanInput}
              onChange={(e) => setLoanInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitLoan(); }}
              placeholder="Loan number (e.g. YSCAP…)"
              disabled={busy === 'loan'}
              style={{ flex: '1 1 220px', minWidth: 180, fontSize: 15, color: V.ink, background: '#fff', border: `1px solid ${V.line}`, borderRadius: 8, padding: '8px 10px' }}
            />
            <button onClick={submitLoan} disabled={busy === 'loan' || !loanInput.trim()}
              style={{ fontSize: 13, fontWeight: 700, color: '#fff', background: V.teal, border: 'none', borderRadius: 8, padding: '9px 15px', cursor: (busy === 'loan' || !loanInput.trim()) ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
              {busy === 'loan' ? 'Syncing…' : 'Sync with Encompass'}
            </button>
          </div>
          {data.lastError ? <div style={{ marginTop: 8, color: V.crit, fontSize: 12 }}>Last attempt: {data.lastError}</div> : null}
        </div>
      )}

      {hasLoan && (
        <>
          {/* summary chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, fontSize: 11, alignItems: 'baseline' }}>
            <span style={{ color: V.muted }}>{sum.compared} checked:</span>
            <span style={{ color: V.good, fontWeight: 700 }}>{sum.matched} match</span>
            {sum.mismatched - (sum.resolved || 0) > 0 && <span style={{ color: V.crit, fontWeight: 700 }}>· {sum.mismatched - (sum.resolved || 0)} don&apos;t match</span>}
            {sum.resolved > 0 && <span style={{ color: V.crit, fontWeight: 700 }}>· {sum.resolved} still differ</span>}
            {sum.incomparable > 0 && <span style={{ color: V.amber, fontWeight: 700 }}>· {sum.incomparable} no data</span>}
            {sum.excepted > 0 && <span style={{ color: V.teal, fontWeight: 700 }}>· {sum.excepted} excepted</span>}
          </div>

          <ComparisonTable fields={compareFields} busy={busy} onReplace={replace}
            isSuper={isSuper} onRequestException={requestException} onDecide={decideException} withActions />
          {refFields.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: V.muted, margin: '0 0 4px' }}>
                Reference (read from Encompass, not checked)
              </div>
              <ComparisonTable fields={refFields} busy={busy} onReplace={replace} withActions={false} />
            </div>
          )}
          {isSuper && <RawTroubleshoot appId={appId} />}
        </>
      )}
    </div>
  );
}

// One comparison row.
function Row({ f, busy, onReplace, withActions, isSuper = false, onRequestException = () => {}, onDecide = () => {} }) {
  const s = statusOf(f);
  const canReplace = withActions && f.writable && f.status === 'mismatch' && f.open && f.theirs != null && f.theirs !== '';
  // "Doesn't apply to this loan" fields never block, so they are not escalatable.
  const naDoesntApply = f.status === 'incomparable' && f.naWhenOursMissing && (f.oursNorm === null || f.oursNorm === undefined || f.oursNorm === '');
  const isBlocking = !f.excepted && (f.status === 'mismatch' || (f.status === 'incomparable' && !naDoesntApply));
  const rowBusy = busy === f.key;
  const outBtn = (color) => ({ fontSize: 11, fontWeight: 700, color, background: 'transparent', border: `1px solid ${color}66`, borderRadius: 7, padding: '4px 9px', cursor: rowBusy ? 'default' : 'pointer', whiteSpace: 'nowrap' });
  return (
    <tr style={{ borderTop: `1px solid ${V.line}` }}>
      <td style={{ padding: '7px 10px', color: V.ink }}>
        {label(f)}
        {f.excepted && (
          <div style={{ color: V.teal, fontSize: 10 }}>Excepted{f.exceptionNote ? ` — ${f.exceptionNote}` : ''}</div>
        )}
        {f.exceptionRequested && (
          <div style={{ color: V.amber, fontSize: 10 }}>Exception requested{f.exceptionNote ? ` — ${f.exceptionNote}` : ''}</div>
        )}
      </td>
      <td style={{ padding: '7px 10px', color: V.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtVal(f, 'ours')}</td>
      <td style={{ padding: '7px 10px', color: V.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtVal(f, 'theirs')}</td>
      <td style={{ padding: '7px 10px' }}><Pill s={s} /></td>
      {withActions && (
        <td style={{ padding: '7px 10px', textAlign: 'right' }}>
          <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            {canReplace && (
              <button onClick={() => onReplace(f.key)} disabled={!!busy}
                style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: V.teal, border: 'none', borderRadius: 7, padding: '4px 9px', cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
                {rowBusy ? 'Pulling…' : 'Use Encompass value'}
              </button>
            )}
            {/* A blocking field with no pending request: a super admin grants directly;
                any other staffer escalates it to a super admin. */}
            {isBlocking && !f.exceptionRequested && (
              isSuper ? (
                <button onClick={() => onDecide(f.key, 'grant')} disabled={!!busy} style={outBtn(V.teal)}>
                  {rowBusy ? '…' : 'Grant exception'}
                </button>
              ) : (
                <button onClick={() => onRequestException(f.key)} disabled={!!busy} style={outBtn(V.amber)}>
                  {rowBusy ? '…' : 'Escalate to super admin'}
                </button>
              )
            )}
            {/* A pending request: the super admin grants or denies; others just wait. */}
            {f.exceptionRequested && (
              isSuper ? (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  <button onClick={() => onDecide(f.key, 'grant')} disabled={!!busy} style={{ ...outBtn(V.teal), color: '#fff', background: V.teal, border: 'none' }}>{rowBusy ? '…' : 'Grant'}</button>
                  <button onClick={() => onDecide(f.key, 'deny')} disabled={!!busy} style={outBtn(V.crit)}>Deny</button>
                </span>
              ) : (
                <span style={{ color: V.amber, fontSize: 11, fontWeight: 700 }}>Awaiting super admin</span>
              )
            )}
            {/* A granted exception: only a super admin can remove it. */}
            {f.excepted && isSuper && (
              <button onClick={() => onDecide(f.key, 'revoke')} disabled={!!busy} style={outBtn(V.crit)}>
                {rowBusy ? '…' : 'Remove exception'}
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

// The comparison table. With actions, fields are COLLECTED into display groups
// (each subheader appears once, in GROUP_ORDER); the reference table is flat.
function ComparisonTable({ fields, busy, onReplace, withActions, isSuper = false, onRequestException = () => {}, onDecide = () => {} }) {
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
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560, color: V.ink }}>
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
                <tr><td colSpan={cols} style={{ padding: '8px 10px 3px', fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: V.muted, background: V.paper }}>{g}</td></tr>
              )}
              {byGroup[g].map((f) => <Row key={f.key} f={f} busy={busy} onReplace={onReplace} withActions={withActions} isSuper={isSuper} onRequestException={onRequestException} onDecide={onDecide} />)}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
