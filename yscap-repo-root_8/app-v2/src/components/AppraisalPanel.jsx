import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../lib/api.js';

/* The PILOT property report. Imports the appraisal XML (staff), renders the property profile
   built from it — hero + value story, photo gallery, collateral snapshot, comparable sales — and
   drives the PILOT findings workflow (appraisal vs the loan file). Dual-side: staff can act on
   findings; the borrower sees everything read-only and can take no action. Every value shown comes
   straight from the appraisal — nothing is guessed — and missing fields render as "—". */

const money = (n) => (n == null || n === '' ? '—' : '$' + Number(n).toLocaleString('en-US'));
const or = (v) => (v == null || v === '' ? '—' : v);
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[,$%\s]/g, '')); return Number.isFinite(n) ? n : null; };
const pct = (v) => (v == null || v === '' ? '—' : `${Number(v)}%`);

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',').pop()); // strip the data: prefix
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const SEV = {
  fatal: { bg: 'var(--crit-bg,#F6E7E4)', fg: 'var(--crit,#B4483C)', label: 'Fatal' },
  warning: { bg: 'var(--amber-bg,#F6EEDD)', fg: 'var(--amber,#B7791F)', label: 'Warning' },
  info: { bg: 'rgba(47,127,134,.14)', fg: 'var(--teal-deep,#256168)', label: 'Info' },
};

function btn(primary, danger) {
  return {
    fontSize: 12.5, fontWeight: 600, borderRadius: 8, padding: '7px 13px', cursor: 'pointer',
    border: '1px solid ' + (primary ? 'var(--teal,#2F7F86)' : danger ? 'color-mix(in srgb,var(--crit,#B4483C) 35%,var(--line,#E7E1D3))' : 'var(--line,#E7E1D3)'),
    background: primary ? 'var(--teal,#2F7F86)' : 'transparent',
    color: primary ? '#fff' : danger ? 'var(--crit,#B4483C)' : 'var(--ink,#141B22)',
  };
}

function Fact({ label, value, sub }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--serif,Georgia,serif)', overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>{sub}</div>}
    </div>
  );
}

// A C1–C6 / Q1–Q6 rating rendered as a filled 1–6 pip scale (C5 → 5 of 6 filled).
function Pips({ label, code }) {
  const m = /^[CQ]?\s*([1-6])/i.exec(String(code || ''));
  const n = m ? Number(m[1]) : 0;
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} style={{ width: 13, height: 7, borderRadius: 3, background: n && i <= n ? 'var(--teal,#2F7F86)' : 'var(--line,#E7E1D3)' }} />
        ))}
        <span style={{ fontSize: 12.5, fontWeight: 600, marginLeft: 6, fontFamily: 'var(--serif,Georgia,serif)' }}>{code ? String(code).toUpperCase() : '—'}</span>
      </div>
    </div>
  );
}

// The value story: As-Is and ARV as bars scaled to the larger of the two, with the uplift called out.
function ValueStory({ a }) {
  const asIs = num(a.as_is_value), arv = num(a.arv_value), appr = num(a.appraised_value);
  const contract = num(a.contract_price);
  const top = Math.max(asIs || 0, arv || 0, appr || 0, 1);
  const Bar = ({ label, val, color, chip }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{label}{chip}</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--serif,Georgia,serif)' }}>{money(val)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 6, background: 'var(--line,#E7E1D3)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(2, Math.round(((val || 0) / top) * 100))}%`, background: color, borderRadius: 6 }} />
      </div>
    </div>
  );
  const uplift = asIs != null && arv != null ? arv - asIs : null;
  return (
    <div>
      {contract != null && <Bar label="Purchase / contract" val={contract} color="var(--muted,#8a94997a)" />}
      <Bar label="As-Is value" val={asIs} color="var(--gold,#AE8746)" />
      <Bar label="After-repair value (ARV)" val={arv} color="var(--teal,#2F7F86)" />
      {uplift != null && uplift > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--teal-deep,#256168)', marginTop: 2 }}>
          Repair value-add: <b>{money(uplift)}</b>{asIs ? ` (+${Math.round((uplift / asIs) * 100)}%)` : ''}
        </div>
      )}
    </div>
  );
}

// Photo gallery — fetches each stored photo as an authorated blob, shows a grid + a full-screen
// lightbox. Object URLs are revoked on unmount so nothing leaks.
function PhotoGallery({ photos, readOnly }) {
  const [urls, setUrls] = useState({});   // documentId -> objectURL
  const [failed, setFailed] = useState({}); // documentId -> true (fetch failed)
  const [open, setOpen] = useState(-1);
  const madeRef = useRef([]);
  // Key on the SET of document ids, not the array identity — so resolving a finding (which
  // reloads `data` and rebuilds the photos array with the SAME ids) does not revoke + refetch
  // every image. Only a real change to the photo set (a re-import) re-runs the effect.
  const photoKey = photos.map((p) => p.document_id).join(',');
  useEffect(() => {
    let alive = true;
    const fetcher = readOnly ? api.appraisalPhotoBlobBorrower : api.appraisalPhotoBlob;
    (async () => {
      for (const p of photos) {
        if (!alive) break;
        if (!p.document_id) continue;
        try {
          const blob = await fetcher(p.document_id);
          if (!alive) break;
          const u = URL.createObjectURL(blob);
          madeRef.current.push(u);
          setUrls((prev) => ({ ...prev, [p.document_id]: u }));
        } catch (_) { if (alive) setFailed((prev) => ({ ...prev, [p.document_id]: true })); }
      }
    })();
    return () => { alive = false; madeRef.current.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) { /* noop */ } }); madeRef.current = []; };
    // deps: photoKey (the id set) not `photos` (new array each load) — avoids needless refetch.
  }, [photoKey, readOnly]);

  if (!photos || !photos.length) return null;
  const withUrl = photos.filter((p) => urls[p.document_id]);
  return (
    <div style={{ marginTop: 22 }}>
      <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>Photographs <span style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', fontWeight: 400 }}>({photos.length})</span></h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
        {photos.map((p, i) => (
          <button key={p.id} onClick={() => urls[p.document_id] && setOpen(i)} title="View" style={{
            padding: 0, border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, overflow: 'hidden', cursor: urls[p.document_id] ? 'pointer' : 'default',
            aspectRatio: '4 / 3', background: 'var(--line-soft,#EFEADD)', display: 'block' }}>
            {urls[p.document_id]
              ? <img src={urls[p.document_id]} alt={p.caption || 'Appraisal photo'} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              : <span style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--muted,#4B585C)' }}>{failed[p.document_id] ? 'unavailable' : 'loading…'}</span>}
          </button>
        ))}
      </div>
      {open >= 0 && withUrl.length > 0 && (() => {
        const list = photos.filter((p) => urls[p.document_id]);
        const idx = Math.max(0, list.findIndex((p) => p === photos[open]));
        const cur = list[idx] || list[0];
        const go = (d) => setOpen(photos.indexOf(list[(idx + d + list.length) % list.length]));
        return (
          <div onClick={() => setOpen(-1)} style={{ position: 'fixed', inset: 0, background: 'rgba(20,27,34,.86)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <button onClick={(e) => { e.stopPropagation(); go(-1); }} style={lightBtn('left')}>‹</button>
            <img src={urls[cur.document_id]} alt={cur.caption || 'Appraisal photo'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: '92%', maxHeight: '88%', objectFit: 'contain', borderRadius: 6, boxShadow: '0 8px 40px rgba(0,0,0,.5)' }} />
            <button onClick={(e) => { e.stopPropagation(); go(1); }} style={lightBtn('right')}>›</button>
            <button onClick={() => setOpen(-1)} style={{ ...lightBtn('right'), right: 18, top: 18, transform: 'none', width: 40, height: 40 }}>✕</button>
          </div>
        );
      })()}
    </div>
  );
}
function lightBtn(side) {
  return { position: 'fixed', top: '50%', [side]: 22, transform: 'translateY(-50%)', width: 48, height: 48, borderRadius: '50%',
    border: 'none', background: 'rgba(255,255,255,.16)', color: '#fff', fontSize: 26, cursor: 'pointer', lineHeight: 1 };
}

function Finding({ appId, f, onChange, readOnly }) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const s = SEV[f.severity] || SEV.info;
  const act = async (action, value) => {
    setBusy(true);
    try { await api.appraisalResolveFinding(appId, f.id, { action, value, note: '' }); onChange && onChange(); }
    catch (e) { alert(e.message || 'Could not resolve'); }
    finally { setBusy(false); }
  };
  const canWriteBack = ['arv', 'as_is_value', 'purchase_price', 'units', 'property_type'].includes(f.field);
  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${s.fg}`, borderRadius: 12, background: 'var(--card,#fff)', padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: s.fg, background: s.bg, padding: '3px 8px', borderRadius: 6 }}>{s.label}</span>
        <strong style={{ fontSize: 14 }}>{f.title}</strong>
      </div>
      {f.appraisal_value != null && (
        <div style={{ display: 'flex', gap: 24, fontSize: 13, margin: '6px 0' }}>
          <span>Appraisal: <b style={{ color: 'var(--teal-deep,#256168)' }}>{f.appraisal_value}</b></span>
          {f.file_value != null && <span>Our file: <b>{f.file_value}</b></span>}
        </div>
      )}
      {f.how_to && <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: readOnly ? 0 : 10 }}>{f.how_to}</div>}
      {/* Borrowers SEE every finding but never act on it — the actions are our team's. */}
      {!readOnly && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {canWriteBack && <button disabled={busy} onClick={() => act('replace')} style={btn(true)}>Replace with appraisal · re-prices</button>}
          <button disabled={busy} onClick={() => act('keep')} style={btn()}>Keep file value</button>
          {canWriteBack && <button disabled={busy} onClick={() => setShowCustom((v) => !v)} style={btn()}>Enter custom…</button>}
          <button disabled={busy} onClick={() => act('dismiss')} style={btn()}>Dismiss</button>
          {f.severity === 'fatal' && <button disabled={busy} onClick={() => { if (confirm('Decline this file?')) act('decline'); }} style={btn(false, true)}>Decline file</button>}
        </div>
      )}
      {!readOnly && showCustom && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="new value" style={{ padding: '7px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, fontSize: 14 }} />
          <button disabled={busy || !custom} onClick={() => act('custom', custom)} style={btn(true)}>Save · re-prices</button>
        </div>
      )}
    </div>
  );
}

// Derive the honest set of collateral quality signals from the appraisal (never a fabricated
// score) — valuation confidence, comp support, condition, and open review status.
function riskChips(a, comps, sum) {
  const chips = [];
  const fz = String(a.flood_zone || '').toUpperCase();
  if (/^(A|V)/.test(fz)) chips.push({ t: `Flood zone ${fz}`, tone: 'amber' });
  if (/^C6/i.test(a.condition_uad || '')) chips.push({ t: 'Condition C6 — may be ineligible', tone: 'crit' });
  if (/^Q6/i.test(a.quality_uad || '')) chips.push({ t: 'Quality Q6', tone: 'amber' });
  if (a.as_is_confidence && a.as_is_confidence !== 'definite') chips.push({ t: 'As-Is read from narrative — verify', tone: 'amber' });
  if (/nonconform|legal.?non/i.test(a.zoning_compliance || '')) chips.push({ t: 'Legal non-conforming zoning', tone: 'amber' });
  if ((comps || []).length && (comps || []).length < 3) chips.push({ t: `Only ${comps.length} comparable sale${comps.length === 1 ? '' : 's'}`, tone: 'amber' });
  if (sum && sum.fatal > 0) chips.push({ t: `${sum.fatal} open fatal finding${sum.fatal === 1 ? '' : 's'}`, tone: 'crit' });
  return chips;
}

// A section heading — gold eyebrow + serif title (mockup .sec-head).
function SecHead({ eyebrow, title, extra }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, margin: '30px 0 14px', flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)', marginBottom: 4 }}>{eyebrow}</div>
        <h2 style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 22, margin: 0, fontWeight: 600, lineHeight: 1.1 }}>{title}</h2>
      </div>
      {extra}
    </div>
  );
}

// A titled dossier card (mockup .card + h3).
function DCard({ title, tag, children, dashed }) {
  return (
    <div className="appr-avoid" style={{ background: 'var(--card,#fff)', border: `1px ${dashed ? 'dashed' : 'solid'} var(--line,#E7E1D3)`, borderRadius: 14, padding: 18, minWidth: 0 }}>
      <h3 style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 15.5, margin: '0 0 12px', fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span>{title}</span>
        {tag && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)' }}>{tag}</span>}
      </h3>
      {children}
    </div>
  );
}

// A key/value list (mockup dl.kv) — rows are [label, value, sub?]; falsy rows are skipped so a
// caller can inline `cond && ['x', y]`. Never invents a value — missing renders as "—".
function KV({ rows }) {
  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '9px 14px', fontSize: 13.5, alignItems: 'baseline' }}>
      {rows.filter(Boolean).map(([k, v, sub], i) => (
        <React.Fragment key={i}>
          <dt style={{ color: 'var(--muted,#4B585C)', whiteSpace: 'nowrap' }}>{k}</dt>
          <dd style={{ margin: 0, textAlign: 'right', fontWeight: 600, overflowWrap: 'anywhere' }}>
            {v == null || v === '' ? '—' : v}
            {sub && <span style={{ display: 'block', fontWeight: 400, fontSize: 11.5, color: 'var(--muted,#4B585C)' }}>{sub}</span>}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

// The three valuation approaches as tiles (mockup .approaches). Only shows tiles the appraisal
// actually carried a value for.
function Approaches({ a }) {
  const tiles = [
    ['Sales comparison', 'reconciled opinion', a.value_sales_approach],
    ['Cost approach', 'replacement', a.value_cost_approach],
    ['Income approach', a.grm ? `GRM ${a.grm}` : 'rental basis', a.value_income_approach],
  ].filter((t) => t[2] != null);
  if (!tiles.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginTop: 4 }}>
      {tiles.map(([k, sub, v], i) => (
        <div key={i} className="appr-avoid" style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted,#4B585C)' }}>{k}<span style={{ fontWeight: 400 }}> · {sub}</span></div>
          <div style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 20, fontWeight: 600, marginTop: 3, color: i === 0 ? 'var(--teal-deep,#256168)' : 'var(--ink,#141B22)' }}>{money(v)}</div>
        </div>
      ))}
    </div>
  );
}

// "Prepared by" — the appraiser + firm + license, and (staff only) the client/lender and
// AMC/vendor. The borrower payload has these scrubbed, but we also gate on readOnly so a
// capital-partner name can never render on the borrower side even if one slipped through.
function PreparedBy({ a, readOnly }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 16 }}>
      <div className="appr-avoid" style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 18 }}>
        <div style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 18, fontWeight: 600 }}>{or(a.appraiser_name)}</div>
        <div style={{ color: 'var(--muted,#4B585C)', fontSize: 13, marginBottom: 12 }}>{or(a.appraiser_company)}</div>
        <KV rows={[
          ['License #', a.license_id],
          ['State', a.license_state],
          a.license_type && ['License type', a.license_type],
          ['Expires', a.license_exp],
          a.appraiser_phone && ['Phone', a.appraiser_phone],
          a.appraiser_email && ['Email', a.appraiser_email],
          a.supervisor_name && ['Supervisor', a.supervisor_name],
          !readOnly && a.lender_name && ['Client / lender', a.lender_name],
          !readOnly && a.amc_name && ['AMC / vendor', a.amc_name],
        ]} />
      </div>
      <div className="appr-avoid" style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', marginBottom: 10 }}>Report dates</div>
        <KV rows={[
          ['Effective date', a.effective_date],
          ['Report signed', a.report_signed_date],
          ['Inspection date', a.inspection_date],
          a.condition_of_appraisal && ['Made as', a.condition_of_appraisal],
          ['Form', a.form_type],
        ]} />
      </div>
    </div>
  );
}

// The source-document tiles (staff only — the borrower payload drops the document ids). Opens
// the stored PDF / XML in a new tab through the authed download (a plain link can't send the token).
function SourceDocs({ a }) {
  const [busy, setBusy] = useState('');
  const openDoc = async (id) => {
    setBusy(id);
    try {
      const { blob } = await api.staffDownloadDoc(id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { alert(e.message || 'Could not open the document'); }
    finally { setBusy(''); }
  };
  const docs = [];
  if (a.pdf_document_id) docs.push(['PDF', 'Full appraisal report', 'The complete PDF pulled from the appraisal file — every photo, sketch and map.', a.pdf_document_id]);
  if (a.source_xml_document_id) docs.push(['XML', 'Appraisal data file (MISMO)', 'The machine-readable file this whole profile was built from.', a.source_xml_document_id]);
  if (!docs.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 14 }}>
      {docs.map(([kind, title, sub, id]) => (
        <div key={id} className="appr-avoid appr-noprint" style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 16 }}>
          <div style={{ flex: 'none', width: 46, height: 46, borderRadius: 10, background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: 'var(--teal-deep,#256168)', letterSpacing: '.04em' }}>{kind}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>{sub}</div>
          </div>
          <button onClick={() => openDoc(id)} disabled={busy === id} style={{ ...btn(true), flex: 'none' }}>{busy === id ? 'Opening…' : `Open ${kind}`}</button>
        </div>
      ))}
    </div>
  );
}

// One comparable-sales row with an expandable adjustment breakdown (the itemized grid the
// appraiser applied). `adjustments` is the jsonb list stored at import.
function CompRow({ c }) {
  const [open, setOpen] = useState(false);
  const adj = Array.isArray(c.adjustments) ? c.adjustments : (() => { try { return JSON.parse(c.adjustments || '[]'); } catch { return []; } })();
  const cq = [c.condition_uad, c.quality_uad].filter(Boolean).join(' / ') || '—';
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--line-soft,#EFEADD)', background: c.is_subject ? 'var(--paper,#F6F3EC)' : undefined, cursor: adj.length ? 'pointer' : 'default' }} onClick={() => adj.length && setOpen((v) => !v)}>
        <td style={td}>{c.is_subject ? 'Subj' : c.seq}</td>
        <td style={td}>{or(c.address)}{c.city ? `, ${c.city} ${c.state || ''}` : ''}{adj.length ? <span style={{ color: 'var(--muted,#4B585C)', fontSize: 11 }}> {open ? '▲' : '▼'}</span> : null}</td>
        <td style={td}>{or(c.proximity)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.gla ? Number(c.gla).toLocaleString('en-US') : '—'}</td>
        <td style={{ ...td, textAlign: 'center' }}>{cq}</td>
        <td style={{ ...td, textAlign: 'right' }}>{or(c.sale_date)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.days_on_market != null && c.days_on_market !== '' ? c.days_on_market : '—'}</td>
        <td style={{ ...td, textAlign: 'right' }}>{money(c.sale_price)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.price_per_gla != null ? money(c.price_per_gla) : '—'}</td>
        <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(c.adjusted_price)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.net_adj_pct != null ? pct(c.net_adj_pct) : (c.net_adjustment != null ? money(c.net_adjustment) : '—')}</td>
      </tr>
      {open && adj.length > 0 && (
        <tr style={{ background: 'var(--paper,#F6F3EC)' }}>
          <td />
          <td colSpan={10} style={{ padding: '4px 10px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', margin: '4px 0 6px' }}>Adjustments applied</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: '4px 18px' }}>
              {adj.filter((x) => x && x.amount != null && Number(x.amount) !== 0).map((x, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
                  <span style={{ color: 'var(--muted,#4B585C)' }}>{x.type || 'Adjustment'}{x.description ? ` (${x.description})` : ''}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: Number(x.amount) < 0 ? 'var(--crit,#B4483C)' : 'var(--good,#3F7A5B)' }}>{Number(x.amount) > 0 ? '+' : ''}{money(x.amount)}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// The custom branded print. A print-only stylesheet that ISOLATES the report card (hides the
// rest of the page + the overlay chrome), lays it out for paper with page-break control, keeps
// the brand colors (print-color-adjust:exact), and reveals a print-only masthead. This is the
// "our own print", not a raw browser dump — the design lives here. Only rendered while the
// full-screen report is open, so printing from anywhere else is unaffected.
const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; }
  body * { visibility: hidden !important; }
  .appr-print-root, .appr-print-root * { visibility: visible !important; }
  .appr-print-root { position: absolute !important; inset: 0 !important; z-index: 0 !important;
    background: #fff !important; padding: 0 !important; display: block !important; overflow: visible !important; }
  .appr-print-root > div { max-width: none !important; width: 100% !important; margin: 0 !important;
    border: 0 !important; border-radius: 0 !important; box-shadow: none !important; background: #fff !important; }
  .appr-noprint { display: none !important; }
  .appr-print-only { display: block !important; }
  .appr-avoid { break-inside: avoid; }
  h2, h3, h4 { break-after: avoid; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

// PILOT collateral read — a 1–5 roll-up + (staff) the ARV-defensibility cross-check. Honest and
// explainable: every factor that moved the score is listed on demand; nothing is fabricated. All
// advisory — it never changes the file or blocks a deal.
function ScoreCard({ score }) {
  const [open, setOpen] = useState(false);
  if (!score || (!score.collateral && !score.arv)) return null;
  const col = score.collateral;
  const arv = score.arv;
  const colTone = (n) => (n >= 4 ? { fg: 'var(--good,#3F7A5B)', bg: 'var(--good-bg,#E9F1EA)' }
    : n === 3 ? { fg: 'var(--teal-deep,#256168)', bg: 'rgba(47,127,134,.12)' }
      : n === 2 ? { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)' }
        : { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' });
  const arvToneMap = {
    strong: { fg: 'var(--good,#3F7A5B)', bg: 'var(--good-bg,#E9F1EA)' },
    moderate: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)' },
    thin: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' },
    no_uplift: { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)' },
    no_budget: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)' },
  };
  return (
    <div className="appr-avoid" style={{ display: 'grid', gridTemplateColumns: arv ? 'repeat(auto-fit,minmax(260px,1fr))' : '1fr', gap: 14, marginBottom: 18 }}>
      {col && (() => {
        const t = colTone(col.score);
        return (
          <div style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ flex: 'none', width: 58, height: 58, borderRadius: 12, background: t.bg, color: t.fg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--serif,Georgia,serif)', lineHeight: 1 }}>
                <span style={{ fontSize: 24, fontWeight: 700 }}>{col.score}</span>
                <span style={{ fontSize: 10, opacity: .8 }}>/ 5</span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)' }}>PILOT collateral read</div>
                <div style={{ fontSize: 17, fontWeight: 700, fontFamily: 'var(--serif,Georgia,serif)', color: t.fg }}>{col.band}</div>
                {col.factors && col.factors.length > 0 && (
                  <button onClick={() => setOpen((v) => !v)} style={{ marginTop: 2, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted,#4B585C)', fontSize: 12, textDecoration: 'underline' }}>
                    {open ? 'Hide why' : `Why — ${col.factors.length} factor${col.factors.length === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
            </div>
            {open && col.factors && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft,#EFEADD)', display: 'grid', gap: 7 }}>
                {col.factors.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
                    <span style={{ flex: 'none', width: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: f.effect > 0 ? 'var(--good,#3F7A5B)' : 'var(--crit,#B4483C)' }}>{f.effect > 0 ? '+' : ''}{f.effect}</span>
                    <span><b>{f.label}</b> — <span style={{ color: 'var(--muted,#4B585C)' }}>{f.detail}</span></span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginTop: 4 }}>An advisory read of the appraisal's own signals — it never changes the file.</div>
              </div>
            )}
          </div>
        );
      })()}
      {arv && (() => {
        const t = arvToneMap[arv.band] || arvToneMap.moderate;
        return (
          <div style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)', marginBottom: 6 }}>ARV defensibility</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: t.bg, color: t.fg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>{arv.verdict}</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>{arv.title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>{arv.detail}</div>
          </div>
        );
      })()}
    </div>
  );
}

export default function AppraisalPanel({ appId, readOnly = false, onSummary }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState(false);   // full-screen "open the whole report" view

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const d = readOnly ? await api.appraisalGetBorrower(appId) : await api.appraisalGet(appId);
      setData(d);
      if (onSummary) onSummary(d && d.appraisal ? (d.summary || null) : null);
    } catch (e) { setErr(e.message || 'Could not load the appraisal'); }
    finally { setLoading(false); }
  }, [appId, onSummary, readOnly]);

  useEffect(() => { load(); }, [load]);

  // Close the full-screen report on Esc — bound to the window so it fires the moment the
  // overlay opens, without needing the dialog to hold focus first.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true); setErr('');
    try {
      const xmlBase64 = await readFileAsBase64(file);
      await api.appraisalImport(appId, { xmlBase64, filename: file.name });
      await load();
    } catch (e2) { setErr(e2.message || 'Import failed'); }
    finally { setImporting(false); }
  };

  if (loading) return <p style={{ color: 'var(--muted,#4B585C)' }}>Loading the appraisal…</p>;

  const a = data && data.appraisal;
  const sum = (data && data.summary) || { fatal: 0, warning: 0, info: 0, blocksCtc: false };
  const findings = (data && data.findings) || [];
  const comps = (data && data.comparables) || [];
  const photos = (data && data.photos) || [];
  const hero = photos[0];

  // Value basis: an ARV present + a subject-to / hypothetical condition means the headline value
  // reflects the AFTER-REPAIR value. State it plainly so no one mis-sizes the loan.
  const isArvBasis = num(a && a.arv_value) != null && /subject|hypothetical|as.?repair|as.?complet/i.test(String((a && a.condition_of_appraisal) || ''));
  const chips = a ? riskChips(a, comps, sum) : [];

  const body = (
    <>
      {err && <p style={{ color: 'var(--crit,#B4483C)', fontSize: 13 }}>{err}</p>}

      {/* import row — staff only. Borrowers see the report, never the upload. */}
      {!readOnly ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <label style={{ ...btn(true), display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {importing ? 'Importing…' : a ? 'Re-import appraisal XML' : 'Import appraisal XML'}
            <input type="file" accept=".xml,text/xml,application/xml" onChange={onFile} disabled={importing} style={{ display: 'none' }} />
          </label>
          {a && <span style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>Form {or(a.form_type)} · effective {or(a.effective_date)} · imported {a.imported_at ? String(a.imported_at).slice(0, 10) : '—'}</span>}
          {a && !expanded && <button onClick={() => setExpanded(true)} style={OPEN_BTN} title="Open the full property report">⤢ Open full report</button>}
        </div>
      ) : (
        a && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>Form {or(a.form_type)} · effective {or(a.effective_date)}</span>
            {!expanded && <button onClick={() => setExpanded(true)} style={OPEN_BTN} title="Open the full property report">⤢ Open full report</button>}
          </div>
        )
      )}

      {!a && !importing && (
        <p style={{ color: 'var(--muted,#4B585C)' }}>{readOnly ? 'The appraisal report will appear here once it has been received and reviewed.' : 'No appraisal imported yet. Upload the appraisal XML — the property profile and the underwriting review are built from it automatically.'}</p>
      )}

      {a && (
        <>
          {/* ===== HERO: subject photo + address + the value story ===== */}
          <div style={{ display: 'grid', gridTemplateColumns: hero ? 'minmax(0,1.15fr) minmax(0,1fr)' : '1fr', gap: 16, alignItems: 'stretch', marginBottom: 18 }}>
            {hero && <HeroPhoto photo={hero} readOnly={readOnly} />}
            <div style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 18, minWidth: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 600, fontFamily: 'var(--serif,Georgia,serif)', lineHeight: 1.15 }}>{or(a.subject_address)}</div>
              <div style={{ color: 'var(--muted,#4B585C)', marginBottom: 14, fontSize: 13.5 }}>
                {[a.subject_city, a.subject_state, a.subject_zip].filter(Boolean).join(', ') || '—'}{a.subject_county ? ` · ${a.subject_county} County` : ''}
              </div>
              <ValueStory a={a} />
              {a.appraised_value != null && (
                <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginTop: 8 }}>Appraised value on the report: <b style={{ color: 'var(--ink,#141B22)' }}>{money(a.appraised_value)}</b></div>
              )}
            </div>
          </div>

          {/* value-basis banner — trust-critical */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: isArvBasis ? 'rgba(47,127,134,.10)' : 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '9px 14px', marginBottom: 16, fontSize: 13 }}>
            <span style={{ fontWeight: 700, color: 'var(--teal-deep,#256168)' }}>Value basis:</span>
            <span>{isArvBasis
              ? 'This valuation reflects the After-Repair Value (ARV) — subject to completion of the repairs described in the appraisal.'
              : 'This is the current As-Is market value of the property.'}</span>
          </div>

          {/* PILOT collateral read (1–5) + ARV-defensibility (staff only) */}
          <ScoreCard score={data.score} />

          {/* collateral snapshot + risk rail */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            <span style={{ fontSize: 12, fontWeight: 700, background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 999, padding: '5px 12px' }}>
              Valuation confidence: <span style={{ color: a.as_is_confidence === 'definite' ? 'var(--good,#3F7A5B)' : 'var(--amber,#B7791F)' }}>{a.as_is_confidence === 'definite' ? 'Definite' : (a.as_is_confidence ? 'From narrative' : '—')}</span>
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 999, padding: '5px 12px' }}>{comps.length} comparable sale{comps.length === 1 ? '' : 's'}</span>
            {chips.map((c, i) => (
              <span key={i} style={{ fontSize: 12, fontWeight: 700, borderRadius: 999, padding: '5px 12px',
                background: c.tone === 'crit' ? SEV.fatal.bg : SEV.warning.bg, color: c.tone === 'crit' ? SEV.fatal.fg : SEV.warning.fg }}>{c.t}</span>
            ))}
          </div>

          {/* ===== PILOT findings ===== */}
          {(sum.fatal > 0 || sum.warning > 0) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              {sum.fatal > 0 && <span style={{ fontWeight: 700, color: SEV.fatal.fg, background: SEV.fatal.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.fatal} fatal</span>}
              {sum.warning > 0 && <span style={{ fontWeight: 700, color: SEV.warning.fg, background: SEV.warning.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.warning} warning</span>}
              {sum.blocksCtc && <span style={{ fontSize: 12.5, color: SEV.fatal.fg }}>Clear-to-close is blocked until every fatal is resolved.</span>}
            </div>
          )}
          {findings.length > 0 ? (
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>PILOT findings — appraisal vs file</h4>
              {findings.map((f) => <Finding key={f.id} appId={appId} f={f} onChange={load} readOnly={readOnly} />)}
            </div>
          ) : (
            <p style={{ color: 'var(--good,#3F7A5B)', fontSize: 13, marginBottom: 20 }}>✓ No open findings — the appraisal matches the file.</p>
          )}

          {/* ===== PHOTO GALLERY ===== */}
          <PhotoGallery photos={photos} readOnly={readOnly} />

          {/* ===== PROPERTY DETAILS — the dossier cards ===== */}
          <SecHead eyebrow="The subject" title="Property details" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 16 }}>
            <DCard title="Identity & location">
              <KV rows={[
                ['Address', or(a.subject_address)],
                a.subject_unit && ['Unit', a.subject_unit],
                ['City / state', [a.subject_city, a.subject_state, a.subject_zip].filter(Boolean).join(', ') || '—'],
                ['County', or(a.subject_county)],
                ['Parcel / APN', or(a.apn)],
                ['Census tract', or(a.census_tract)],
                ['Neighborhood', or(a.neighborhood)],
                a.legal_description && ['Legal', a.legal_description],
              ]} />
            </DCard>

            <DCard title="Structure">
              <KV rows={[
                ['Design / style', or(a.design_style)],
                ['Property type', or(a.property_type)],
                ['Units', or(a.units)],
                ['Total rooms', or(a.rooms)],
                ['Beds / baths', `${or(a.beds)} / ${a.baths_full != null ? a.baths_full + (a.baths_half ? '.' + a.baths_half : '') : '—'}`],
                ['Stories', or(a.stories)],
                ['Gross living area', a.gla ? `${Number(a.gla).toLocaleString('en-US')} sf` : '—'],
                ['Year built', or(a.year_built)],
              ]} />
              {(a.condition_uad || a.quality_uad) && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line-soft,#EFEADD)', display: 'grid', gap: 12 }}>
                  <Pips label="Condition (UAD)" code={a.condition_uad} />
                  <Pips label="Quality (UAD)" code={a.quality_uad} />
                </div>
              )}
            </DCard>

            <DCard title="Site & zoning">
              <KV rows={[
                ['Lot size', or(a.lot_area)],
                ['Zoning', or(a.zoning_id), or(a.zoning_desc) !== '—' ? a.zoning_desc : null],
                ['Zoning compliance', or(a.zoning_compliance)],
                ['Flood zone', or(a.flood_zone)],
                ['Site value (cost)', a.site_value != null ? money(a.site_value) : '—'],
              ]} />
            </DCard>

            {(a.value_income_approach != null || a.grm != null || (data.units || []).length > 0) && (
              <DCard title="Income & rents" tag={a.form_type === 'FNM1025' ? '1025' : null}>
                <KV rows={[
                  ['Gross rent multiplier', a.grm != null ? Number(a.grm).toLocaleString('en-US') : '—'],
                  ['Value — income approach', a.value_income_approach != null ? money(a.value_income_approach) : '—'],
                ]} />
                {(data.units || []).length > 0 && (
                  <div style={{ marginTop: 12, overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                      <thead><tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
                        <th style={th}>Unit</th><th style={{ ...th, textAlign: 'right' }}>Actual</th><th style={{ ...th, textAlign: 'right' }}>Market</th>
                      </tr></thead>
                      <tbody>
                        {(data.units || []).map((u) => (
                          <tr key={u.id} style={{ borderTop: '1px solid var(--line-soft,#EFEADD)' }}>
                            <td style={td}>{u.unit_seq != null ? `Unit ${u.unit_seq}` : '—'}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{money(u.actual_rent)}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{money(u.market_rent)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </DCard>
            )}

            {a.condo_project_name && (
              <DCard title="Condo / association" tag="1073">
                <KV rows={[
                  ['Project', or(a.condo_project_name)],
                  ['Type', or(a.condo_project_type)],
                  ['Unit / floor', `${or(a.condo_unit_identifier)} · ${or(a.condo_floor)}`],
                  ['HOA fee', a.hoa_fee_amount != null ? `${money(a.hoa_fee_amount)} / ${(a.hoa_fee_period || '').toLowerCase() || 'mo'}` : '—'],
                ]} />
              </DCard>
            )}
          </div>

          {/* ===== WHAT IT'S WORTH ===== */}
          <SecHead eyebrow="Valuation" title="What it's worth" />
          <Approaches a={a} />
          <div className="appr-avoid" style={{ marginTop: 14, background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, padding: '14px 16px', fontSize: 13.5 }}>
            <span style={{ fontWeight: 700, color: 'var(--teal-deep,#256168)' }}>Value basis:&nbsp;</span>
            {isArvBasis
              ? <>The headline value reflects the <b>After-Repair Value</b> — this appraisal is made <b>subject to completion</b> of the repairs described in the report. The <b>As-Is value</b> is stored separately so pricing never confuses the two.</>
              : <>This is the <b>current As-Is market value</b> of the property, as reconciled by the appraiser from the sales-comparison approach.</>}
            {a.as_is_confidence && a.as_is_confidence !== 'definite' && <> The As-Is figure was read from the report’s narrative — PILOT opens a task for an officer to confirm it rather than guess.</>}
          </div>

          {/* ===== COMPARABLE SALES ===== */}
          {comps.length > 0 && (
            <>
              <SecHead eyebrow="Evidence" title="Comparable sales"
                extra={<span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted,#4B585C)' }}>{comps.filter((c) => !c.is_subject).length} comps · tap a row for the adjustment breakdown</span>} />
              <div style={{ overflowX: 'auto', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 780 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)', background: 'var(--paper,#F6F3EC)' }}>
                      <th style={th}>#</th><th style={th}>Address</th><th style={th}>Proximity</th>
                      <th style={{ ...th, textAlign: 'right' }}>GLA</th><th style={{ ...th, textAlign: 'center' }}>C / Q</th>
                      <th style={{ ...th, textAlign: 'right' }}>Sale date</th><th style={{ ...th, textAlign: 'right' }}>DOM</th>
                      <th style={{ ...th, textAlign: 'right' }}>Sale price</th><th style={{ ...th, textAlign: 'right' }}>$/GLA</th>
                      <th style={{ ...th, textAlign: 'right' }}>Adjusted</th><th style={{ ...th, textAlign: 'right' }}>Net adj</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comps.map((c) => <CompRow key={c.id} c={c} />)}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ===== PREPARED BY ===== */}
          <SecHead eyebrow="Provenance" title="Prepared by" />
          <PreparedBy a={a} readOnly={readOnly} />

          {/* ===== ORIGINAL APPRAISAL (staff only — needs the source document ids) ===== */}
          {!readOnly && (a.pdf_document_id || a.source_xml_document_id) && (
            <>
              <SecHead eyebrow="Source document" title="Original appraisal" />
              <SourceDocs a={a} />
            </>
          )}
        </>
      )}
    </>
  );

  // Full-screen "open the whole report" view — the same report, given room to breathe (and to
  // print / save as a branded PDF). Click the dimmed backdrop or Close to return. Esc-friendly.
  if (expanded) {
    return (
      <div
        className="appr-print-root"
        role="dialog" aria-modal="true"
        onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,27,34,.55)', display: 'flex', flexDirection: 'column', padding: 'clamp(8px,2vh,28px) clamp(8px,2vw,28px)', overflowY: 'auto' }}>
        <style>{PRINT_CSS}</style>
        <div style={{ maxWidth: 1080, width: '100%', margin: '0 auto', background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 16, boxShadow: '0 24px 70px rgba(0,0,0,.4)' }}>
          <div className="appr-noprint" style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--line,#E7E1D3)', background: 'var(--card,#fff)', borderRadius: '16px 16px 0 0' }}>
            <b style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Property report{a && a.subject_address ? ` — ${a.subject_address}` : ''}
            </b>
            <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
              <button onClick={() => window.print()} style={{ ...OPEN_BTN, marginLeft: 0 }} title="Print or save the report as a nicely formatted PDF">🖨 Print / Save PDF</button>
              <button onClick={() => setExpanded(false)} style={btn()}>✕ Close</button>
            </div>
          </div>
          <div style={{ padding: 'clamp(14px,2.4vw,26px)' }}>
            {/* Branded masthead — only appears on the printed / saved PDF, not on screen. */}
            <div className="appr-print-only" style={{ display: 'none', paddingBottom: 12, marginBottom: 14, borderBottom: '2px solid var(--gold,#AE8746)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
                <div>
                  <div style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 22, fontWeight: 600, letterSpacing: '.02em' }}>PILOT <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted,#4B585C)' }}>by YS Capital</span></div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>Property profile report</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 16, fontWeight: 600 }}>{a && a.subject_address ? a.subject_address : ''}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>{a ? [a.subject_city, a.subject_state, a.subject_zip].filter(Boolean).join(', ') : ''}{a && a.effective_date ? ` · effective ${a.effective_date}` : ''}</div>
                </div>
              </div>
            </div>
            {body}
          </div>
        </div>
      </div>
    );
  }
  return <div>{body}</div>;
}

// Hero photo tile — loads its own blob (independent of the gallery so the hero shows immediately).
function HeroPhoto({ photo, readOnly }) {
  const [url, setUrl] = useState('');
  const docId = photo && photo.document_id;
  useEffect(() => {
    let alive = true, made = '';
    const fetcher = readOnly ? api.appraisalPhotoBlobBorrower : api.appraisalPhotoBlob;
    (async () => {
      if (!docId) return;
      try { const blob = await fetcher(docId); if (!alive) return; made = URL.createObjectURL(blob); setUrl(made); }
      catch (_) { /* no hero image */ }
    })();
    return () => { alive = false; if (made) { try { URL.revokeObjectURL(made); } catch (_) { /* noop */ } } };
  }, [docId, readOnly]);
  return (
    <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line,#E7E1D3)', background: 'var(--line-soft,#EFEADD)', minHeight: 200, display: 'flex' }}>
      {url
        ? <img src={url} alt="Subject property" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', minHeight: 200 }} />
        : <span style={{ margin: 'auto', fontSize: 12, color: 'var(--muted,#4B585C)' }}>subject photo</span>}
    </div>
  );
}

const th = { padding: '6px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontVariantNumeric: 'tabular-nums' };

// The "Open full report" call-to-action — a bold, filled, always-readable button (the earlier
// ghost variant rendered near-invisible on the paper background). Same on staff + borrower.
const OPEN_BTN = {
  marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7,
  fontSize: 13.5, fontWeight: 700, borderRadius: 10, padding: '9px 17px', cursor: 'pointer',
  border: '1px solid var(--teal-deep,#256168)', background: 'var(--teal,#2F7F86)', color: '#fff',
  boxShadow: '0 1px 2px rgba(20,27,34,.08)',
};
