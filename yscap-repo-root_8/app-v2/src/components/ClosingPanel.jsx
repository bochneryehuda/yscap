import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/* THE CLOSING WORKSPACE (owner-directed 2026-07-26). The closer's desk inside a
   loan file: deal details, the actual cash-to-close money gate against verified
   liquidity + reserves, document quick-links, closing conditions (HUD / package /
   tracking), the warehouse line + collateral tracking, closer checklists, TPR +
   investor-delivery sign-offs, the 3-system reconciliation gate, and notes.

   Closer-grade actions gate on `can('manage_closings')`; the shared answers
   (investor CTC'd, closing-date-confirmed) are open to anyone on the file.

   props: { appId, app, can, onDownloadDoc(doc), onPreview(doc), onChanged() } */

const money0 = (v) => (v == null || v === '' ? '—' : '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const money2 = (v) => (v == null || v === '' ? '—' : '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (v) => (v ? String(v).slice(0, 10) : '—');

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const STAGE_LABEL = {
  estimated: 'Submitted to closing', ready_for_docs: 'Ready for docs', wire_sent: 'Wire sent',
  fully_closed: 'Closed (funded)', fully_reconciled: 'Reconciled', in_purchasing: 'In purchasing',
};
const QUICKLINK_LABEL = {
  term_sheet: 'Term sheet', insurance: 'Insurance', contract: 'Purchase contract',
  assignment: 'Assignment of contract', llc: 'LLC documents', bank_statement: 'Bank statements', title: 'Title',
};
// The signed/executed final term sheet vs the draft — labeled so the closer can
// tell which link is the executed one.
const tsTag = (d) => (d.doc_kind === 'term_sheet_signed' ? 'Executed' : d.doc_kind === 'term_sheet' ? 'Draft' : '');

export default function ClosingPanel({ appId, app, can, onDownloadDoc, onPreview, onChanged }) {
  const [ws, setWs] = useState(null);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState('');
  const isCloser = can ? can('manage_closings') : false;

  const load = useCallback(() => api.closingWorkspace(appId).then((d) => { setWs(d); setErr(''); }).catch((e) => setErr((e && e.message) || 'Could not load the closing view.')), [appId]);
  useEffect(() => { load(); }, [load]);
  const say = (m) => { setFlash(m); setTimeout(() => setFlash(''), 5000); };
  const refresh = async () => { await load(); if (onChanged) onChanged(); };

  const run = async (key, fn, okMsg) => {
    setBusy(key); setErr('');
    try { await fn(); if (okMsg) say(okMsg); await refresh(); }
    catch (e) { setErr((e && e.data && (e.data.reason || e.data.error)) || (e && e.message) || 'That did not work.'); }
    finally { setBusy(''); }
  };

  if (err && !ws) return <div className="notice err">{err}</div>;
  if (!ws) return <div className="muted small">Loading the closing view…</div>;

  const cw = ws.closing || {};
  const money = ws.money || {};
  const rec = ws.reconciliation || {};

  return (
    <div className="closing-workspace">
      {flash && <div className="notice ok" style={{ marginBottom: 10 }}>{flash}</div>}
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}<button className="btn link small" onClick={() => setErr('')}>Dismiss</button></div>}

      {/* Stage + shared answers */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-h"><h3 style={{ margin: 0 }}>Closing status</h3>
          <span className="pill">{STAGE_LABEL[cw.stage] || 'Not in closing yet'}</span></div>
        <div className="panel-b">
          <div className="cl-grid">
            <ToggleRow label="Investor has issued CTC" hint="The note buyer cleared the file to close."
              on={!!cw.investor_ctc} busy={busy === 'ctc'}
              onToggle={(v) => run('ctc', () => api.closingUpdate(appId, { investorCtc: v }), 'Saved.')} />
            <ToggleRow label="Closing date confirmed with all parties" hint="Title, borrower, and seller all confirmed."
              on={!!cw.closing_date_confirmed} busy={busy === 'conf'}
              onToggle={(v) => run('conf', () => api.closingUpdate(appId, { closingDateConfirmed: v }), 'Saved.')} />
          </div>
          <div className="cl-dates muted small" style={{ marginTop: 8 }}>
            Estimated closing: <b>{day(cw.est_closing_date || ws.expected_closing)}</b> · Funded date: <b>{day(ws.funded_date)}</b>
            {ws.closer && <> · Closer on file: <b>{ws.closer.name}</b></>}
          </div>
        </div>
      </div>

      {/* Deal details */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-h"><h3 style={{ margin: 0 }}>Deal details</h3>
          {app && <a className="btn ghost small" href={`#/internal/app/${appId}`}>Open full file</a>}</div>
        <div className="panel-b">
          <div className="cl-facts">
            <Fact k="Borrower" v={app ? `${app.first_name || app.borrower_first_name || ''} ${app.last_name || app.borrower_last_name || ''}`.trim() || '—' : '—'} />
            <Fact k="Property" v={fmtAddr(app && app.property_address)} />
            <Fact k="Investor (note buyer)" v={(app && app.lender) || '—'} />
            <Fact k="Program" v={(app && (app.registered_program || app.program)) || '—'} />
            <Fact k="Loan amount" v={money0(app && app.loan_amount)} />
            <Fact k="Original purchase price" v={money0(app && (app.underlying_contract_price || app.purchase_price))} />
            <Fact k="Assignment fee" v={app && app.is_assignment ? money0(app.assignment_fee) : '—'} />
            <Fact k="Rehab budget" v={money0(app && app.rehab_budget)} />
            <Fact k="Financed interest reserve" v={money0(app && (app.requested_ir_amount))} />
            <Fact k="Loan coordinator" v={(app && app.loan_officer_name) || '—'} />
          </div>
        </div>
      </div>

      {/* Money: estimate + actual cash-to-close + verified liquidity */}
      <MoneySection appId={appId} money={money} isCloser={isCloser} busy={busy} run={run}
        onDownloadDoc={onDownloadDoc} />

      {/* Document quick-links */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-h"><h3 style={{ margin: 0 }}>Documents at a glance</h3>
          <span className="muted small">Open what you need to verify the file.</span></div>
        <div className="panel-b">
          <div className="cl-quicklinks">
            {Object.keys(QUICKLINK_LABEL).map((k) => {
              const docs = (ws.quickLinks && ws.quickLinks[k]) || [];
              return (
                <div key={k} className="cl-ql-group">
                  <div className="cl-ql-head">{QUICKLINK_LABEL[k]} <span className="muted small">({docs.length})</span></div>
                  {docs.length === 0 ? <div className="muted small">{k === 'term_sheet' ? 'No term sheet on file yet' : 'None on file'}</div>
                    : docs.map((d) => (
                      <button key={d.id} className="btn link small cl-ql-doc" title={d.filename}
                        onClick={() => (onPreview ? onPreview(d) : onDownloadDoc && onDownloadDoc(d))}>
                        <span className="cl-ql-name">{d.filename}</span>
                        {k === 'term_sheet' && tsTag(d)
                          ? <span className={`cl-ts-tag ${d.doc_kind === 'term_sheet_signed' ? 'on' : ''}`}>{tsTag(d)}</span>
                          : null}</button>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Closing conditions (uploads) */}
      <ConditionsSection appId={appId} conditions={ws.conditions || []} isCloser={isCloser}
        onPreview={onPreview} onDownloadDoc={onDownloadDoc} onUploaded={refresh} setErr={setErr} />

      {/* Funding: warehouse + collateral tracking + funded date */}
      <FundingSection appId={appId} cw={cw} ws={ws} isCloser={isCloser} busy={busy} run={run} />

      {/* Checklists */}
      <ChecklistsSection appId={appId} checklists={ws.checklists || []} isCloser={isCloser} onChanged={refresh} setErr={setErr} />

      {/* Sign-offs + reconciliation */}
      <SignoffSection appId={appId} cw={cw} rec={rec} isCloser={isCloser} busy={busy} run={run} />

      {/* Notes */}
      <NotesSection appId={appId} notes={ws.notes || []} onChanged={refresh} setErr={setErr} />
    </div>
  );
}

function fmtAddr(a) {
  if (!a) return '—';
  if (typeof a === 'string') return a;
  const parts = [a.line1 || a.street, a.city, a.state, a.zip].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

function Fact({ k, v }) {
  return <div className="cl-fact"><span className="cl-fact-k">{k}</span><span className="cl-fact-v">{v}</span></div>;
}

function ToggleRow({ label, hint, on, busy, onToggle }) {
  return (
    <label className="cl-toggle">
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onToggle(e.target.checked)} />
      <span className="cl-toggle-text"><b>{label}</b>{hint && <span className="muted small"> — {hint}</span>}</span>
    </label>
  );
}

function MoneySection({ appId, money, isCloser, busy, run, onDownloadDoc }) {
  const [amt, setAmt] = useState('');
  useEffect(() => { setAmt(money && money.actualCashToClose != null ? String(money.actualCashToClose) : ''); }, [money && money.actualCashToClose]);
  const shortfall = money && !money.ok && money.actualCashToClose != null;
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 style={{ margin: 0 }}>Cash to close &amp; liquidity</h3></div>
      <div className="panel-b">
        <div className="cl-money-tiles">
          <Tile k="Estimated cash to close" v={money2(money.estimateCashToClose)} />
          <Tile k="Required reserves" v={money2(money.reserve)} sub={money.reserveBasis} />
          <Tile k="Verified liquidity" v={money2(money.verified)} sub="From bank statements on file" />
        </div>

        <div className="cl-actual">
          <label className="field" style={{ margin: 0, maxWidth: 280 }}>
            <span className="small muted">Actual cash to close (from the ALTA / final HUD)</span>
            <input className="input" inputMode="decimal" value={amt} disabled={!isCloser}
              placeholder="e.g. 118500" onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} />
          </label>
          {isCloser && (
            <button className="btn primary small" disabled={busy === 'ctc2'} style={{ alignSelf: 'end' }}
              onClick={() => run('ctc2', () => api.closingCashToClose(appId, amt === '' ? null : Number(amt)), 'Checked against verified liquidity.')}>
              Check funds
            </button>
          )}
        </div>

        {money.actualCashToClose != null && (
          money.ok
            ? <div className="notice ok" style={{ marginTop: 10 }}>Verified liquidity ({money2(money.verified)}) covers the actual cash to close ({money2(money.actualCashToClose)}) plus reserves ({money2(money.reserve)}).</div>
            : <div className="notice err" style={{ marginTop: 10 }}>
                <b>⚠ Not enough verified liquidity.</b> This file needs {money2(money.required)} (actual cash to close {money2(money.actualCashToClose)} + reserves {money2(money.reserve)}), but only {money2(money.verified)} is verified{shortfall ? <> — short by <b>{money2(money.shortfall)}</b></> : ''}. {!money.haveCountable && ' No countable bank statement is tied to the borrower yet.'}
              </div>
        )}

        {/* The verified liquidity table with direct links to the statements */}
        <div className="cl-table-wrap" style={{ marginTop: 12 }}>
          <table className="cl-table">
            <thead><tr><th>Account holder</th><th>Bank</th><th>Account</th><th>Ending balance</th><th>Counts?</th><th></th></tr></thead>
            <tbody>
              {(money.accounts || []).length === 0
                ? <tr><td colSpan={6} className="muted small">No bank statements analyzed yet.</td></tr>
                : (money.accounts || []).map((a, i) => (
                  <tr key={i} className={a.tied ? '' : 'cl-row-muted'}>
                    <td>{a.holder || '—'}{a.holderIsBusiness ? ' (business)' : ''}</td>
                    <td>{a.bankName || '—'}</td>
                    <td>{a.accountNumber || '—'}</td>
                    <td>{money2(a.ending)}</td>
                    <td>{a.tied ? <span className="pill ok">Counts</span> : <span className="pill warn">Not tied</span>}</td>
                    <td>{a.document_id && <button className="btn link small" onClick={() => onDownloadDoc && onDownloadDoc({ id: a.document_id, filename: (a.holder || 'bank') + ' statement' })}>Open</button>}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Tile({ k, v, sub }) {
  return <div className="cl-tile"><div className="cl-tile-k">{k}</div><div className="cl-tile-v">{v}</div>{sub && <div className="cl-tile-sub muted small">{sub}</div>}</div>;
}

function ConditionsSection({ appId, conditions, isCloser, onPreview, onDownloadDoc, onUploaded, setErr }) {
  const refs = useRef({});
  const [busy, setBusy] = useState('');
  async function upload(itemId, file) {
    if (!file) return;
    setBusy(itemId);
    try {
      const dataBase64 = await fileToBase64(file);
      await api.staffUploadAppDoc(appId, { checklistItemId: itemId, filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64 });
      await onUploaded();
    } catch (e) { setErr((e && e.message) || 'Upload failed.'); }
    finally { setBusy(''); }
  }
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 style={{ margin: 0 }}>Closing conditions</h3>
        <span className="muted small">Upload the balanced final HUD, the closed package, and the tracking label.</span></div>
      <div className="panel-b">
        {conditions.length === 0 ? <div className="muted small">These appear once the file is submitted to closing.</div>
          : conditions.map((c) => (
            <div key={c.id} className="cl-cond">
              <div className="cl-cond-main">
                <div><b>{c.label}</b> {c.signed_off_at ? <span className="pill ok">Signed off</span> : c.documents.length ? <span className="pill">Uploaded</span> : <span className="pill warn">Needed</span>}</div>
                {c.documents.map((d) => (
                  <button key={d.id} className="btn link small" onClick={() => (onPreview ? onPreview(d) : onDownloadDoc && onDownloadDoc(d))}>{d.filename}</button>
                ))}
              </div>
              {isCloser && (
                <div>
                  <input type="file" hidden ref={(el) => { refs.current[c.id] = el; }} onChange={(e) => upload(c.id, e.target.files && e.target.files[0])} />
                  <button className="btn ghost small" disabled={busy === c.id} onClick={() => refs.current[c.id] && refs.current[c.id].click()}>{busy === c.id ? 'Uploading…' : 'Upload'}</button>
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

function FundingSection({ appId, cw, ws, isCloser, busy, run }) {
  const [wh, setWh] = useState(cw.warehouse || '');
  const [track, setTrack] = useState(cw.collateral_tracking_number || '');
  const [carrier, setCarrier] = useState(cw.collateral_tracking_carrier || '');
  const [funded, setFunded] = useState(ws.funded_date || '');
  useEffect(() => { setWh(cw.warehouse || ''); setTrack(cw.collateral_tracking_number || ''); setCarrier(cw.collateral_tracking_carrier || ''); setFunded(ws.funded_date || ''); }, [cw.warehouse, cw.collateral_tracking_number, cw.collateral_tracking_carrier, ws.funded_date]);
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 style={{ margin: 0 }}>Funding &amp; collateral</h3></div>
      <div className="panel-b">
        <div className="cl-grid">
          <label className="field" style={{ margin: 0 }}>
            <span className="small muted">Warehouse line</span>
            <select className="input" value={wh} disabled={!isCloser} onChange={(e) => { setWh(e.target.value); run('wh', () => api.closingUpdate(appId, { warehouse: e.target.value || null }), 'Warehouse saved.'); }}>
              <option value="">— select a warehouse —</option>
              {(ws.warehouses || []).map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span className="small muted">Funded date (our system)</span>
            <input className="input" type="date" value={funded} disabled={!isCloser}
              onChange={(e) => setFunded(e.target.value)}
              onBlur={() => isCloser && funded !== (ws.funded_date || '') && run('fd', () => api.closingUpdate(appId, { fundedDate: funded || null }), 'Funded date saved.')} />
          </label>
        </div>
        <div className="cl-grid" style={{ marginTop: 10 }}>
          <label className="field" style={{ margin: 0 }}>
            <span className="small muted">Collateral tracking # (collateral → our warehouse)</span>
            <input className="input" value={track} disabled={!isCloser} placeholder="Tracking from the collateral to our warehouse"
              onChange={(e) => setTrack(e.target.value)}
              onBlur={() => isCloser && track !== (cw.collateral_tracking_number || '') && run('tk', () => api.closingUpdate(appId, { collateralTrackingNumber: track || null }), 'Tracking saved.')} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span className="small muted">Carrier (optional)</span>
            <input className="input" value={carrier} disabled={!isCloser} placeholder="FedEx / UPS…"
              onChange={(e) => setCarrier(e.target.value)}
              onBlur={() => isCloser && carrier !== (cw.collateral_tracking_carrier || '') && run('cr', () => api.closingUpdate(appId, { collateralTrackingCarrier: carrier || null }))} />
          </label>
        </div>
        {!isCloser && <div className="muted small" style={{ marginTop: 8 }}>Only the closer can set the warehouse, tracking, or funded date.</div>}
      </div>
    </div>
  );
}

function ChecklistsSection({ appId, checklists, isCloser, onChanged, setErr }) {
  const [templates, setTemplates] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [newProvider, setNewProvider] = useState('');
  const [tplId, setTplId] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { if (isCloser) api.closingChecklistTemplates(appId).then(setTemplates).catch(() => {}); }, [appId, isCloser]);
  const act = async (key, fn) => { setBusy(key); try { await fn(); await onChanged(); } catch (e) { setErr((e && e.message) || 'That did not work.'); } finally { setBusy(''); } };
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 style={{ margin: 0 }}>Closing checklists</h3>
        <span className="muted small">Build your own steps — a general list or one per capital provider.</span></div>
      <div className="panel-b">
        {checklists.length === 0 && <div className="muted small" style={{ marginBottom: 8 }}>No checklists yet.</div>}
        {checklists.map((cl) => (
          <div key={cl.id} className="cl-checklist">
            <div className="cl-checklist-h"><b>{cl.title}</b>{cl.provider && <span className="pill">{cl.provider}</span>}</div>
            {cl.items.map((it) => (
              <label key={it.id} className="cl-check-item">
                <input type="checkbox" checked={it.checked} disabled={!isCloser || busy === it.id}
                  onChange={(e) => act(it.id, () => api.closingToggleChecklistItem(appId, it.id, e.target.checked))} />
                <span className={it.checked ? 'cl-checked' : ''}>{it.label}</span>
              </label>
            ))}
            {isCloser && <AddItem onAdd={(label) => act('add' + cl.id, () => api.closingAddChecklistItem(appId, cl.id, label))} />}
          </div>
        ))}
        {isCloser && (
          <div className="cl-new-checklist">
            <select className="input" value={tplId} onChange={(e) => setTplId(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">Blank checklist</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}{t.provider ? ` (${t.provider})` : ''}</option>)}
            </select>
            <input className="input" placeholder="Title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} style={{ maxWidth: 200 }} />
            <input className="input" placeholder="Capital provider (optional)" value={newProvider} onChange={(e) => setNewProvider(e.target.value)} style={{ maxWidth: 200 }} />
            <button className="btn primary small" disabled={busy === 'newcl'}
              onClick={() => act('newcl', () => api.closingCreateChecklist(appId, { templateId: tplId || undefined, title: newTitle || undefined, provider: newProvider || undefined }).then(() => { setNewTitle(''); setNewProvider(''); setTplId(''); }))}>
              Add checklist
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddItem({ onAdd }) {
  const [v, setV] = useState('');
  return (
    <div className="cl-add-item">
      <input className="input" placeholder="Add a step…" value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { onAdd(v.trim()); setV(''); } }} />
      <button className="btn ghost small" disabled={!v.trim()} onClick={() => { onAdd(v.trim()); setV(''); }}>Add</button>
    </div>
  );
}

function SignoffSection({ appId, cw, rec, isCloser, busy, run }) {
  const recOk = rec && rec.ok;
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 style={{ margin: 0 }}>Sign-offs &amp; reconciliation</h3></div>
      <div className="panel-b">
        <div className="cl-signoffs">
          <SignRow label="TPR needed on this file" done={!!cw.tpr_required} isToggle
            isCloser={isCloser} busy={busy === 'tprreq'}
            onToggle={(v) => run('tprreq', () => api.closingUpdate(appId, { tprRequired: v }))} />
          {cw.tpr_required && <>
            <SignRow label="Uploaded to TPR" done={!!cw.tpr_uploaded_at} isCloser={isCloser} busy={busy === 'tprup'}
              onSign={(on) => run('tprup', () => api.closingSignOff(appId, 'tpr_uploaded', on))} />
            <SignRow label="TPR signed off" done={!!cw.tpr_signed_off_at} isCloser={isCloser} busy={busy === 'tpr'}
              onSign={(on) => run('tpr', () => api.closingSignOff(appId, 'tpr', on))} />
          </>}
          {/* TABLE FUNDING sits directly ABOVE the investor-delivery sign-off,
              because it is the question you answer BEFORE you sign it off: a
              table-funded loan was sold right at closing, so it skips the
              purchasing desk entirely. */}
          <label className="cl-signrow cl-tf">
            <input type="checkbox" checked={!!cw.table_funded} disabled={!isCloser || busy === 'tf'}
              onChange={(e) => run('tf', () => api.closingUpdate(appId, { tableFunded: e.target.checked }))} />
            <span className="cl-tf-main">
              <b>Table funded — sold at closing</b>
              <span className="cl-tf-hint">
                {cw.table_funded
                  ? 'This loan was sold at closing, so it will not go to purchasing.'
                  : 'Tick this before you sign off investor delivery if the loan was sold right at closing. Otherwise the file goes to the purchasing desk.'}
              </span>
            </span>
          </label>
          <SignRow label="Investor delivery signed off" done={!!cw.investor_delivery_signed_off_at} isCloser={isCloser} busy={busy === 'inv'}
            onSign={(on) => run('inv', () => api.closingSignOff(appId, 'investor_delivery', on))} />
          {!!cw.investor_delivery_signed_off_at && (
            <div className="muted small" style={{ paddingTop: 2 }}>
              {cw.table_funded
                ? 'Sold at closing — this file is not on the purchasing desk.'
                : 'This file is on the purchasing desk.'}
            </div>
          )}
        </div>

        <div className="cl-recon" style={{ marginTop: 12 }}>
          <div className="cl-recon-head"><b>Funded date reconciliation</b></div>
          <div className="cl-recon-grid">
            <ReconCell k="PILOT" v={day(rec.ours)} />
            <ReconCell k="ClickUp" v={day(rec.clickup)} />
            <ReconCell k="Encompass" v={rec.encStatus === 'na' ? 'Not in Encompass' : day(rec.encompass)} status={rec.encStatus} />
          </div>
          {recOk
            ? <div className="notice ok" style={{ marginTop: 8 }}>PILOT and ClickUp agree on the funded date{rec.encStatus === 'match' ? ' (Encompass too)' : ''}.</div>
            : <div className="notice warn" style={{ marginTop: 8 }}>{rec.reason || 'The funded date does not match across systems yet.'}</div>}
          {rec.advisory && <div className="muted small" style={{ marginTop: 6 }}>Note: {rec.advisory}</div>}
          {isCloser && cw.stage && cw.stage !== 'fully_reconciled' && cw.stage !== 'in_purchasing' && (
            <button className="btn primary small" style={{ marginTop: 8 }} disabled={busy === 'recon' || !recOk}
              onClick={() => run('recon', () => api.advanceClosing(appId, 'fully_reconciled'), 'Marked fully reconciled.')}>
              Mark file reconciled
            </button>
          )}
          {/* A table-funded loan was sold at closing — it must never be pushed to
              purchasing (the server refuses it too). Say so instead of offering
              a button that 422s. */}
          {isCloser && cw.stage === 'fully_reconciled' && !cw.table_funded && (
            <button className="btn primary small" style={{ marginTop: 8 }} disabled={busy === 'purch' || !cw.investor_delivery_signed_off_at}
              onClick={() => run('purch', () => api.advanceClosing(appId, 'in_purchasing'), 'Sent to purchasing.')}>
              Send to purchasing
            </button>
          )}
          {isCloser && cw.stage === 'fully_reconciled' && !!cw.table_funded && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Table funded — this loan was sold at closing, so it does not go to purchasing.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SignRow({ label, done, isCloser, busy, onSign, onToggle, isToggle }) {
  if (isToggle) {
    return (
      <label className="cl-signrow">
        <input type="checkbox" checked={done} disabled={!isCloser || busy} onChange={(e) => onToggle(e.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  return (
    <div className="cl-signrow">
      <span>{done ? '✓ ' : '○ '}{label}</span>
      {isCloser && <button className="btn ghost small" disabled={busy} onClick={() => onSign(!done)}>{done ? 'Undo' : 'Sign off'}</button>}
    </div>
  );
}

function ReconCell({ k, v, status }) {
  const tone = status === 'mismatch' || status === 'missing' ? 'err' : status === 'match' ? 'ok' : '';
  return <div className={`cl-recon-cell ${tone}`}><div className="muted small">{k}</div><div className="cl-recon-v">{v}</div></div>;
}

function NotesSection({ appId, notes, onChanged, setErr }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  async function add() {
    if (!v.trim()) return;
    setBusy(true);
    try { await api.closingAddNote(appId, v.trim()); setV(''); await onChanged(); }
    catch (e) { setErr((e && e.message) || 'Could not add the note.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="panel">
      <div className="panel-h"><h3 style={{ margin: 0 }}>Closing notes</h3></div>
      <div className="panel-b">
        <div className="cl-note-add">
          <input className="input" placeholder="Add a note or confirmation…" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="btn primary small" disabled={busy || !v.trim()} onClick={add}>Add</button>
        </div>
        <div className="cl-notes">
          {notes.length === 0 ? <div className="muted small">No notes yet.</div>
            : notes.map((n) => (
              <div key={n.id} className="cl-note">
                <div className="cl-note-body">{n.body}</div>
                <div className="muted small">{n.author_name || 'Someone'}{n.created_at ? ` · ${new Date(n.created_at).toLocaleString()}` : ''}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
