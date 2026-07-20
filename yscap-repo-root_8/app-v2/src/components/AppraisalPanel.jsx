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
    color: primary ? '#fff' : danger ? 'var(--crit,#B4483C)' : 'var(--text,#141B22)',
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

// Which finding fields can be previewed against the pricing engine, and the engine override key
// each maps to. property_type is excluded (its finding value is a form code, not a portal type).
const PREVIEW_KEY = { as_is_value: 'asIsValue', arv: 'arv', purchase_price: 'purchasePrice', units: 'units' };

function Finding({ appId, f, onChange, readOnly }) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [preview, setPreview] = useState(null);   // {loading}|{err}|{base,whatif,val}
  const s = SEV[f.severity] || SEV.info;
  const act = async (action, value) => {
    setBusy(true);
    try { await api.appraisalResolveFinding(appId, f.id, { action, value, note: '' }); onChange && onChange(); }
    catch (e) { alert(e.message || 'Could not resolve'); }
    finally { setBusy(false); }
  };
  const canWriteBack = ['arv', 'as_is_value', 'purchase_price', 'units', 'property_type'].includes(f.field);
  // A dry-run "what-if": price the file WITH the appraisal's value as an override and compare to
  // the current terms — NON-persisting (reuses the /pricing/quote engine, nothing is written).
  const previewKey = PREVIEW_KEY[f.field];
  const previewVal = previewKey ? Number(String(f.appraisal_value == null ? '' : f.appraisal_value).replace(/[^0-9.-]/g, '')) : null;
  const canPreview = !readOnly && previewKey && Number.isFinite(previewVal) && previewVal > 0;
  const doPreview = async () => {
    setPreview({ loading: true });
    try {
      const [base, whatif] = await Promise.all([
        api.staffPricingQuote(appId, {}),
        api.staffPricingQuote(appId, { [previewKey]: previewVal }),
      ]);
      setPreview({ base, whatif, val: previewVal });
    } catch (e) { setPreview({ err: e.message || 'Could not preview the re-price' }); }
  };
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
        <div className="appr-noprint" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {canWriteBack && <button disabled={busy} onClick={() => act('replace')} style={btn(true)}>Replace with appraisal · re-prices</button>}
          {canPreview && <button disabled={busy || (preview && preview.loading)} onClick={doPreview} style={btn()} title="See how this would re-price the loan — without changing anything">↻ Preview the re-price</button>}
          <button disabled={busy} onClick={() => act('keep')} style={btn()}>Keep file value</button>
          {canWriteBack && <button disabled={busy} onClick={() => setShowCustom((v) => !v)} style={btn()}>Enter custom…</button>}
          <button disabled={busy} onClick={() => act('dismiss')} style={btn()}>Dismiss</button>
          {f.severity === 'fatal' && <button disabled={busy} onClick={() => { if (confirm('Decline this file?')) act('decline'); }} style={btn(false, true)}>Decline file</button>}
        </div>
      )}
      {/* What-if re-price preview — dry-run only, nothing is written to the file. */}
      {!readOnly && preview && (
        <div style={{ marginTop: 10, background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5 }}>
          {preview.loading ? (
            <span style={{ color: 'var(--muted,#4B585C)' }}>Calculating the re-price…</span>
          ) : preview.err ? (
            <span style={{ color: 'var(--crit,#B4483C)' }}>{preview.err}</span>
          ) : (
            <div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>If you replace with {money(preview.val)} <span style={{ fontWeight: 400, color: 'var(--muted,#4B585C)' }}>— preview only, nothing changes yet</span></div>
              {['standard', 'gold'].map((pg) => {
                const b = preview.base && preview.base[pg], w = preview.whatif && preview.whatif[pg];
                if (!b || !w) return null;
                const bl = b.sizing && b.sizing.totalLoan, wl = w.sizing && w.sizing.totalLoan;
                if (bl == null && wl == null) return null;
                const d = (wl || 0) - (bl || 0);
                const label = (w.programLabel || b.programLabel || pg);
                return (
                  <div key={pg} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0' }}>
                    <span style={{ minWidth: 92, color: 'var(--muted,#4B585C)' }}>{label}</span>
                    {!w.eligible ? <span style={{ color: 'var(--amber,#B7791F)' }}>ineligible with this value{w.status ? ` (${w.status})` : ''}</span> : (
                      <span>{money(bl)} <span style={{ color: 'var(--muted,#4B585C)' }}>→</span> <b>{money(wl)}</b>
                        {d !== 0 && <span style={{ marginLeft: 6, color: d > 0 ? 'var(--good,#3F7A5B)' : 'var(--crit,#B4483C)', fontWeight: 700 }}>{d > 0 ? '▲ +' : '▼ '}{money(Math.abs(d))}</span>}
                      </span>
                    )}
                  </div>
                );
              })}
              <div style={{ marginTop: 6, color: 'var(--muted,#4B585C)' }}>To actually apply it, use “Replace with appraisal”.</div>
            </div>
          )}
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

// When true (provided by the full-report overlay), every ApprSection is forced
// OPEN so the "whole report" view and the printed/saved PDF contain every
// section — collapsing is only for the on-screen scan. This must FORCE the
// <details open> attribute, not just CSS: modern Chromium hides a closed
// <details> via content-visibility on ::details-content, which a `display:block`
// override on the body cannot defeat (verified). Forcing `open` is the reliable
// fix; the print CSS on ::details-content is belt-and-suspenders for a plain
// Ctrl+P from the inline view.
const ApprOpenCtx = React.createContext(false);

// Collapsible report section (owner-directed 2026-07-20): the appraisal report is
// long, so each big section collapses to just its header — scan the headers, open
// the one you want. Native <details> = auto-collapsed by default (unless
// defaultOpen or the overlay forces it), toggles on click, works identically for
// staff and the borrower. The header reuses SecHead so the look is unchanged.
function ApprSection({ eyebrow, title, extra, children, defaultOpen = false }) {
  const forceOpen = React.useContext(ApprOpenCtx);
  return (
    <details className="appr-sec appr-avoid" {...((forceOpen || defaultOpen) ? { open: true } : {})}>
      <summary className="appr-sec-sum">
        <SecHead eyebrow={eyebrow} title={title} extra={extra} />
        <span className="appr-sec-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="appr-sec-body">{children}</div>
    </details>
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
          <div style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 20, fontWeight: 600, marginTop: 3, color: i === 0 ? 'var(--teal-deep,#256168)' : 'var(--text,#141B22)' }}>{money(v)}</div>
        </div>
      ))}
    </div>
  );
}

// Humanize a MISMO enum token for display (Over75Percent → "Over 75%").
function human(v) {
  if (!v) return null;
  const direct = { REOSale: 'REO sale', ShortSale: 'Short sale', EstateSale: 'Estate sale', CourtOrderedSale: 'Court-ordered sale', ArmsLengthSale: 'Arm’s-length', Listing: 'Active listing',
    Over75Percent: 'Over 75%', '25To75Percent': '25–75%', Under25Percent: 'Under 25%', UnderTwentyFivePercent: 'Under 25%',
    OverSupply: 'Over-supply', InBalance: 'In balance', Shortage: 'Shortage',
    UnderThreeMonths: 'Under 3 months', ThreeToSixMonths: '3–6 months', OverSixMonths: 'Over 6 months' };
  if (direct[v]) return direct[v];
  return String(v)
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)(\d)/g, '$1 $2')
    .replace(/(\d+)\s*Percent/i, '$1%').replace(/Percent/i, '%')
    .trim();
}
const chip = (label, tone) => (
  <span key={label} style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 999, marginRight: 6, marginBottom: 6,
    background: tone === 'bad' ? 'rgba(180,72,60,.10)' : tone === 'warn' ? 'rgba(174,135,70,.12)' : tone === 'good' ? 'rgba(63,122,91,.10)' : 'var(--paper,#F6F3EC)',
    border: `1px solid ${tone === 'bad' ? 'var(--crit,#B4483C)' : tone === 'warn' ? 'var(--gold,#AE8746)' : tone === 'good' ? 'var(--good,#3F7A5B)' : 'var(--line,#E7E1D3)'}`,
    color: tone === 'bad' ? 'var(--crit,#B4483C)' : 'var(--text,#141B22)' }}>{label}</span>
);

// Neighborhood & market — the appraiser's own read of the exit market (can they sell/refi at ARV,
// and how fast). All never-guessed enums + the neighborhood price band.
const LAND_USE_LABEL = { SingleFamily: 'single-family', TwoToFourFamily: '2–4 unit', Apartment: 'apartment', Commercial: 'commercial', Vacant: 'vacant', Industrial: 'industrial', Agricultural: 'agricultural', Other: 'other' };
// The appraiser's market-conditions / 1004MC-reconciliation narratives, collapsible (own hook so
// NeighborhoodCard's early return stays hook-safe). Only concrete text reaches here (the backend
// rejects "See 1004MC" pointers).
function MarketNarrative({ a }) {
  const [open, setOpen] = useState(false);
  const items = [
    a.market_conditions_comment && ['Market conditions', a.market_conditions_comment],
    a.market_reconciliation_comment && ['1004MC reconciliation', a.market_reconciliation_comment],
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 10 }} className="appr-noprint">
      <button onClick={() => setOpen((v) => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted,#4B585C)', fontSize: 12.5, textDecoration: 'underline' }}>{open ? 'Hide' : 'Show'} appraiser’s market notes</button>
      {open && items.map(([k, v], i) => (
        <p key={i} style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', margin: '8px 0 0', lineHeight: 1.45 }}><b style={{ color: 'var(--text,#141B22)' }}>{k}: </b>{v}</p>
      ))}
    </div>
  );
}
function NeighborhoodCard({ a }) {
  const hasMc = a.mc_months_supply != null || a.mc_median_dom != null || a.mc_sale_to_list_pct != null || a.mc_price_trend != null;
  const landUse = (Array.isArray(a.present_land_use) ? a.present_land_use : (() => { try { return JSON.parse(a.present_land_use || '[]'); } catch { return []; } })())
    .filter((u) => u && u.type && u.percent != null).slice().sort((x, y) => y.percent - x.percent);
  const has = [a.nbhd_value_trend, a.nbhd_demand_supply, a.nbhd_marketing_time, a.nbhd_location_type, a.nbhd_price_predominant, a.nbhd_builtup, a.nbhd_boundaries, a.market_conditions_comment, a.market_reconciliation_comment].some((x) => x != null);
  if (!has && !hasMc && !landUse.length) return null;
  const band = (a.nbhd_price_low != null || a.nbhd_price_high != null || a.nbhd_price_predominant != null)
    ? `${money(a.nbhd_price_low)}–${money(a.nbhd_price_high)}${a.nbhd_price_predominant != null ? ` · predominant ${money(a.nbhd_price_predominant)}` : ''}` : null;
  return (
    <DCard title="Neighborhood & market" tag="Exit read">
      <div style={{ marginBottom: band ? 10 : 0 }}>
        {a.nbhd_value_trend && chip(`Values ${human(a.nbhd_value_trend)}`, a.nbhd_value_trend === 'Declining' ? 'bad' : a.nbhd_value_trend === 'Increasing' ? 'good' : null)}
        {a.nbhd_demand_supply && chip(human(a.nbhd_demand_supply), a.nbhd_demand_supply === 'OverSupply' ? 'bad' : a.nbhd_demand_supply === 'Shortage' ? 'good' : null)}
        {a.nbhd_marketing_time && chip(`Sells in ${human(a.nbhd_marketing_time)}`, a.nbhd_marketing_time === 'OverSixMonths' ? 'warn' : null)}
        {a.nbhd_location_type && chip(human(a.nbhd_location_type))}
        {a.nbhd_builtup && chip(`${human(a.nbhd_builtup)} built-up`)}
        {a.nbhd_growth && chip(`${human(a.nbhd_growth)} growth`, a.nbhd_growth === 'Slow' ? 'warn' : a.nbhd_growth === 'Rapid' ? 'good' : null)}
        {a.nbhd_adverse_financing === true && chip('Adverse financing', 'warn')}
        {a.nbhd_foreclosure_activity === true && chip('Foreclosure activity', 'warn')}
      </div>
      {band && <KV rows={[['Neighborhood price range', band], a.nbhd_age_predominant != null && ['Predominant age', `${a.nbhd_age_predominant} yrs`]]} />}
      {landUse.length > 0 && (
        <div style={{ marginTop: band ? 10 : 0, fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>
          <b style={{ color: 'var(--text,#141B22)' }}>Land use: </b>
          {landUse.map((u) => `${u.percent}% ${LAND_USE_LABEL[u.type] || human(u.type).toLowerCase()}`).join(' · ')}
        </div>
      )}
      {a.nbhd_boundaries && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted,#4B585C)', lineHeight: 1.4 }}>
          <b style={{ color: 'var(--text,#141B22)' }}>Boundaries: </b>{a.nbhd_boundaries}
        </div>
      )}
      {hasMc && (
        <div style={{ marginTop: band || has ? 12 : 0, paddingTop: band || has ? 12 : 0, borderTop: band || has ? '1px solid var(--line-soft,#EFEADD)' : 'none' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', marginBottom: 8 }}>Market conditions (1004MC · last 3 months)</div>
          <div style={{ marginBottom: 8 }}>
            {a.mc_price_trend && chip(`Prices ${human(a.mc_price_trend)}`, a.mc_price_trend === 'Declining' ? 'bad' : a.mc_price_trend === 'Increasing' ? 'good' : null)}
            {a.mc_months_supply != null && a.mc_months_supply > 6 && chip('Buyer’s market', 'warn')}
            {a.mc_sale_to_list_pct != null && a.mc_sale_to_list_pct < 95 && chip('Sellers conceding', 'warn')}
          </div>
          <KV rows={[
            a.mc_months_supply != null && ['Months of supply', `${Number(a.mc_months_supply).toLocaleString('en-US')} mo`, a.mc_months_supply > 6 ? 'over 6 months — a buyer’s market' : null],
            a.mc_median_dom != null && ['Median days on market', `${a.mc_median_dom} days`],
            a.mc_sale_to_list_pct != null && ['Sale-to-list', `${Number(a.mc_sale_to_list_pct).toLocaleString('en-US')}%`, a.mc_sale_to_list_pct < 95 ? 'homes selling below list' : null],
          ]} />
          <MarketTrendsGrid mt={a.market_trends} />
        </div>
      )}
      <MarketNarrative a={a} />
    </DCard>
  );
}

// The full 1004MC grid (all metrics × the three periods + trend), collapsible — it is detail an
// underwriter may want but shouldn't dominate the card. Renders only the metrics that carried data.
const MC_ROWS = [
  ['MedianSalesPrice', 'Median sale price', 'money'], ['MedianListPrice', 'Median list price', 'money'],
  ['MedianSalesDOM', 'Median sale DOM', 'days'], ['MedianListDOM', 'Median list DOM', 'days'],
  ['TotalSales', 'Total sales', 'num'], ['TotalListings', 'Total listings', 'num'],
  ['Supply', 'Months of supply', 'num'], ['AbsorptionRate', 'Absorption rate', 'num'],
  ['MedianSalesToListRatio', 'Sale-to-list', 'pct'],
];
function MarketTrendsGrid({ mt }) {
  const [open, setOpen] = useState(false);
  const grid = !mt ? null : (typeof mt === 'string' ? (() => { try { return JSON.parse(mt); } catch { return null; } })() : mt);
  if (!grid || !Object.keys(grid).length) return null;
  const fmt = (v, kind) => v == null ? '—' : kind === 'money' ? money(v) : kind === 'pct' ? `${Number(v).toLocaleString('en-US')}%` : Number(v).toLocaleString('en-US');
  const rows = MC_ROWS.filter(([k]) => grid[k] && (grid[k].prior712 != null || grid[k].prior46 != null || grid[k].last3 != null));
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 10 }} className="appr-noprint">
      <button onClick={() => setOpen((v) => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted,#4B585C)', fontSize: 12.5, textDecoration: 'underline' }}>{open ? 'Hide' : 'Show'} full 1004MC grid</button>
      {open && (
        <div style={{ marginTop: 8, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ textAlign: 'right', color: 'var(--muted,#4B585C)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Metric</th><th style={th}>Prior 7–12 mo</th><th style={th}>Prior 4–6 mo</th><th style={th}>Last 3 mo</th><th style={{ ...th, textAlign: 'center' }}>Trend</th>
            </tr></thead>
            <tbody>
              {rows.map(([k, label, kind]) => (
                <tr key={k} style={{ borderTop: '1px solid var(--line-soft,#EFEADD)' }}>
                  <td style={{ ...td, textAlign: 'left' }}>{label}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmt(grid[k].prior712, kind)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmt(grid[k].prior46, kind)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmt(grid[k].last3, kind)}</td>
                  <td style={{ ...td, textAlign: 'center', color: grid[k].trend === 'Declining' ? 'var(--crit,#B4483C)' : grid[k].trend === 'Increasing' ? 'var(--good,#3F7A5B)' : 'inherit' }}>{grid[k].trend ? human(grid[k].trend) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Systems, condition & renovation signals — the flip-lender view of what the property is and what
// the rehab has to (or already did) address.
function SystemsCard({ a }) {
  const updates = Array.isArray(a.updates) ? a.updates : (() => { try { return JSON.parse(a.updates || '[]'); } catch { return []; } })();
  const amenities = Array.isArray(a.amenities) ? a.amenities : (() => { try { return JSON.parse(a.amenities || '[]'); } catch { return []; } })();
  const utilities = Array.isArray(a.utilities) ? a.utilities : (() => { try { return JSON.parse(a.utilities || '[]'); } catch { return []; } })();
  const actualAge = a.year_built ? 2026 - Number(a.year_built) : null;
  const has = [a.effective_age, a.remaining_economic_life, a.heating_type, a.cooling, a.roof_description, a.foundation_type, a.occupancy_status, updates.length].some((x) => x != null && x !== 0 || (Array.isArray(x) && x.length));
  if (!has && !updates.length && !utilities.length) return null;
  // A utility the appraiser marked non-public (well / septic / propane) is a flip cost/exit signal.
  const nonPublic = utilities.filter((u) => u.public === false).map((u) => u.type);
  return (
    <DCard title="Systems, condition & renovation signals" tag="Collateral">
      <div style={{ marginBottom: 10 }}>
        {a.occupancy_status && chip(human(a.occupancy_status) === 'Tenant Occupied' ? 'Tenant-occupied' : human(a.occupancy_status), a.occupancy_status === 'TenantOccupied' ? 'warn' : a.occupancy_status === 'Vacant' ? 'good' : null)}
        {a.physical_deficiency === true && chip('Physical deficiency', 'bad')}
        {a.adverse_site_conditions === true && chip('Adverse site condition', 'bad')}
        {a.updated_last_15yr === true && chip('Updated in last 15 yrs', 'good')}
        {a.attic === true && chip('Attic')}
        {a.has_adu === true && chip('Accessory unit')}
        {nonPublic.length > 0 && nonPublic.some((t) => /well|septic|propane|oil/i.test(t)) && chip(`Non-public: ${nonPublic.join(', ')}`, 'warn')}
      </div>
      {a.physical_deficiency === true && a.physical_deficiency_note && (
        <p style={{ fontSize: 12.5, color: 'var(--crit,#B4483C)', margin: '0 0 10px', lineHeight: 1.4 }}>{a.physical_deficiency_note}</p>
      )}
      <KV rows={[
        a.effective_age != null && ['Effective age', `${a.effective_age} yrs`, actualAge != null ? `actual ~${actualAge} yrs` : null],
        a.remaining_economic_life != null && ['Remaining economic life', `${a.remaining_economic_life} yrs`],
        a.heating_type && ['Heating', [a.heating_type, a.heating_fuel].filter(Boolean).join(' · ')],
        a.cooling && ['Cooling', a.cooling],
        a.roof_description && ['Roof', a.roof_description],
        a.foundation_type && ['Foundation', a.foundation_type],
        a.basement_sqft != null && ['Basement', `${Number(a.basement_sqft).toLocaleString('en-US')} sqft${a.basement_finished_pct != null ? ` · ${a.basement_finished_pct}% finished` : ''}`],
        (a.garage_type || a.garage_spaces != null) && ['Garage', [a.garage_type, a.garage_spaces != null ? `${a.garage_spaces} space${a.garage_spaces === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')],
        a.below_grade_sqft != null && ['Below-grade area', `${Number(a.below_grade_sqft).toLocaleString('en-US')} sqft${a.below_grade_finished_sqft != null ? ` · ${Number(a.below_grade_finished_sqft).toLocaleString('en-US')} finished` : ''}`],
        utilities.length > 0 && ['Utilities', utilities.map((u) => `${u.type}${u.public === false ? ' (non-public)' : ''}`).join(', ')],
      ]} />
      {updates.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', marginBottom: 6 }}>Recent updates</div>
          {updates.map((u, i) => chip(`${u.area}: ${human(u.level)}${u.timeframe ? ` (${human(u.timeframe)})` : ''}`, /Remodel|Updat/i.test(u.level) ? 'good' : null))}
        </div>
      )}
      {amenities.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>
          <b style={{ color: 'var(--text,#141B22)' }}>Amenities: </b>{amenities.map((x) => x.type + (x.description ? ` (${x.description})` : '')).join(', ')}
        </div>
      )}
    </DCard>
  );
}

// How the value was concluded — purpose, the reconciliation, what the value is subject to, and the
// appraiser's addendum (collapsible; it can be long).
function ValueConcludedCard({ a }) {
  const [open, setOpen] = useState(false);
  if (!a.reconciliation_comment && !a.conditions_comment && !a.addendum_text) return null;
  return (
    <DCard title="How the value was concluded" tag="Reconciliation">
      <KV rows={[
        a.appraisal_purpose && ['Purpose', a.appraisal_purpose === 'Other' && a.appraisal_purpose_other ? a.appraisal_purpose_other : human(a.appraisal_purpose)],
        a.uspap_report_type && ['Report type', a.uspap_report_type],
      ]} />
      {a.reconciliation_comment && <p style={{ fontSize: 13, lineHeight: 1.5, margin: '10px 0 0' }}>{a.reconciliation_comment}</p>}
      {a.conditions_comment && (
        <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 10, background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', fontSize: 12.5 }}>
          <b>Subject to: </b>{a.conditions_comment}
        </div>
      )}
      {a.addendum_text && (
        <div style={{ marginTop: 10 }} className="appr-noprint">
          <button onClick={() => setOpen((v) => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted,#4B585C)', fontSize: 12.5, textDecoration: 'underline' }}>{open ? 'Hide' : 'Show'} appraiser addendum</button>
          {open && <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted,#4B585C)', whiteSpace: 'pre-wrap', marginTop: 8 }}>{a.addendum_text}</p>}
        </div>
      )}
    </DCard>
  );
}

// Cost approach detail — the depreciation economics behind the cost-approach value (useful on a
// rehab: how much life the effective age vs remaining life implies).
function CostApproachCard({ a }) {
  if (a.value_cost_approach == null && a.cost_new_total == null) return null;
  return (
    <DCard title="Cost approach" tag="Replacement basis">
      <KV rows={[
        a.value_cost_approach != null && ['Indicated value', money(a.value_cost_approach)],
        a.dwelling_cost_new != null && ['Dwelling cost-new', `${money(a.dwelling_cost_new)}${a.dwelling_price_per_sqft != null ? ` · ${money(a.dwelling_price_per_sqft)}/sqft` : ''}`,
          a.dwelling_sqft != null ? `${Number(a.dwelling_sqft).toLocaleString('en-US')} sqft` : null],
        a.cost_new_total != null && ['Total cost-new', money(a.cost_new_total)],
        a.depreciation_total != null && ['Depreciation', money(a.depreciation_total),
          [a.depreciation_physical != null ? `physical ${money(a.depreciation_physical)}` : null,
           a.depreciation_functional != null ? `functional ${money(a.depreciation_functional)}` : null,
           a.depreciation_external != null ? `external ${money(a.depreciation_external)}` : null].filter(Boolean).join(' · ') || null],
        a.depreciated_cost_improvements != null && ['Depreciated improvements', money(a.depreciated_cost_improvements)],
        a.site_improvements_value != null && ['Site improvements (as-is)', money(a.site_improvements_value)],
        a.site_value != null && ['Site value', money(a.site_value)],
        a.remaining_economic_life != null && ['Remaining economic life', `${a.remaining_economic_life} yrs`],
        a.cost_data_source && ['Cost source', [a.cost_data_source, a.cost_quality_rating ? `quality ${a.cost_quality_rating}` : null].filter(Boolean).join(' · ')],
      ]} />
    </DCard>
  );
}

// Sale contract & terms — sale type, concessions, and the flip/wholesale flags.
function ContractCard({ a, readOnly }) {
  const flags = [];
  if (a.sale_type && a.sale_type !== 'ArmsLengthSale') flags.push(chip(human(a.sale_type), 'warn'));
  if (a.seller_is_owner === false) flags.push(chip('Seller ≠ owner of record', 'warn'));
  if (a.contract_reviewed === false) flags.push(chip('Contract not analyzed', 'warn'));
  if (a.concession_indicator === true || (a.concession_amount != null && a.concession_amount > 0)) flags.push(chip(`Concessions ${a.concession_amount ? money(a.concession_amount) : ''}`.trim(), 'warn'));
  const has = flags.length || a.contract_data_source || a.listing_history || a.concession_description || a.contract_review_comment || a.sales_agreement_analysis;
  if (!has) return null;
  return (
    <DCard title="Sale contract & terms">
      {flags.length > 0 && <div style={{ marginBottom: 10 }}>{flags}</div>}
      <KV rows={[
        a.sale_type && ['Sale type', human(a.sale_type)],
        a.concession_amount != null && ['Seller concessions', money(a.concession_amount)],
        a.concession_description && ['Concession detail', a.concession_description],
        a.contract_data_source && ['Contract source', a.contract_data_source],
        a.listed_within_year != null && ['Listed in last 12 mo', a.listed_within_year ? 'Yes' : 'No'],
      ]} />
      {a.contract_review_comment && <p style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', margin: '8px 0 0', lineHeight: 1.4 }}><b style={{ color: 'var(--text,#141B22)' }}>Appraiser’s contract note: </b>{a.contract_review_comment}</p>}
      {a.sales_agreement_analysis && <p style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', margin: '8px 0 0', lineHeight: 1.4 }}><b style={{ color: 'var(--text,#141B22)' }}>Transfer history: </b>{a.sales_agreement_analysis}</p>}
      {a.listing_history && <p style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', margin: '8px 0 0', lineHeight: 1.4 }}>{a.listing_history}</p>}
    </DCard>
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
        <div style={{ color: 'var(--muted,#4B585C)', fontSize: 13, marginBottom: 12 }}>{or(a.appraiser_company)}{a.appraiser_company_address ? ` · ${a.appraiser_company_address}` : ''}</div>
        <KV rows={[
          ['License #', a.license_id],
          ['State', a.license_state],
          a.license_type && ['License type', a.license_type],
          ['Expires', a.license_exp],
          a.appraiser_phone && ['Phone', a.appraiser_phone],
          a.appraiser_email && ['Email', a.appraiser_email],
          a.supervisor_name && ['Supervisor', a.supervisor_name, [a.supervisor_license_id && `Lic ${a.supervisor_license_id}`, a.supervisor_license_state, a.supervisor_license_exp && `exp ${a.supervisor_license_exp}`].filter(Boolean).join(' · ') || null],
          !readOnly && a.lender_name && ['Client / lender', a.lender_name, !readOnly ? a.lender_address : null],
          !readOnly && a.amc_name && ['AMC / vendor', a.amc_name],
        ]} />
      </div>
      <div className="appr-avoid" style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', marginBottom: 10 }}>Report dates</div>
        <KV rows={[
          ['Effective date', a.effective_date],
          ['Report signed', a.report_signed_date],
          ['Inspection date', a.inspection_date],
          a.inspection_type && ['Inspection', a.inspection_type === 'None' ? 'Desktop — no inspection' : a.inspection_type],
          a.condition_of_appraisal && ['Made as', a.condition_of_appraisal],
          a.appraisal_purpose && ['Purpose', a.appraisal_purpose === 'Other' && a.appraisal_purpose_other ? a.appraisal_purpose_other : a.appraisal_purpose],
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
  const bdba = [c.beds, c.baths].some((x) => x != null && x !== '') ? `${c.beds != null ? c.beds : '—'}/${c.baths != null && c.baths !== '' ? c.baths : '—'}` : '—';
  const distress = c.sale_type && c.sale_type !== 'ArmsLengthSale' ? ({ REOSale: 'REO', EstateSale: 'Estate', ShortSale: 'Short', Listing: 'Listing', CourtOrderedSale: 'Court' }[c.sale_type] || null) : null;
  // Round-6 comp facts (view/location UAD ratings, basement, data source). The row expands when it
  // has adjustments OR any of these facts.
  const compFacts = [
    c.view_rating && ['View', c.view_rating],
    (c.location_rating || c.location_type) && ['Location', [c.location_rating, c.location_type ? human(c.location_type) : null].filter(Boolean).join(' · ')],
    c.below_grade_sqft != null && ['Basement', `${Number(c.below_grade_sqft).toLocaleString('en-US')} sqft${c.below_grade_finished_sqft != null ? ` · ${Number(c.below_grade_finished_sqft).toLocaleString('en-US')} finished` : ''}`],
    c.data_source && ['Source', c.data_source],
  ].filter(Boolean);
  const hasDetail = adj.length > 0 || compFacts.length > 0;
  const adverse = (c.view_rating === 'Adverse' ? 'view' : null) || (c.location_rating === 'Adverse' ? 'location' : null);
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--line-soft,#EFEADD)', background: c.is_subject ? 'var(--paper,#F6F3EC)' : undefined, cursor: hasDetail ? 'pointer' : 'default' }} onClick={() => hasDetail && setOpen((v) => !v)}>
        <td style={td}>{c.is_subject ? 'Subj' : c.seq}</td>
        <td style={td}>{or(c.address)}{c.city ? `, ${c.city} ${c.state || ''}` : ''}
          {c.sale_status && c.sale_status !== 'closed' && (
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)', border: '1px solid var(--gold,#AE8746)', borderRadius: 4, padding: '0 4px' }}>
              {c.sale_status === 'pending' ? 'Pending' : 'Active'}
            </span>
          )}
          {distress && (
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--crit,#B4483C)', border: '1px solid var(--crit,#B4483C)', borderRadius: 4, padding: '0 4px' }}>{distress}</span>
          )}
          {adverse && (
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)', border: '1px solid var(--gold,#AE8746)', borderRadius: 4, padding: '0 4px' }} title={`Appraiser rated this comp's ${adverse} adverse`}>Adv {adverse}</span>
          )}
          {c.prior_sale_amount != null && (
            <span style={{ display: 'block', fontSize: 11, color: 'var(--muted,#4B585C)' }}>Prior sale {money(c.prior_sale_amount)}{c.prior_sale_date ? ` · ${c.prior_sale_date}` : ''}</span>
          )}
          {hasDetail ? <span style={{ color: 'var(--muted,#4B585C)', fontSize: 11 }}> {open ? '▲' : '▼'}</span> : null}</td>
        <td style={td}>{or(c.proximity)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.gla ? Number(c.gla).toLocaleString('en-US') : '—'}</td>
        <td style={{ ...td, textAlign: 'center' }}>{bdba}</td>
        <td style={{ ...td, textAlign: 'center' }}>{cq}</td>
        <td style={{ ...td, textAlign: 'right' }}>{or(c.sale_date)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.days_on_market != null && c.days_on_market !== '' ? c.days_on_market : '—'}</td>
        <td style={{ ...td, textAlign: 'right' }}>{money(c.sale_price)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.price_per_gla != null ? money(c.price_per_gla) : '—'}</td>
        <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(c.adjusted_price)}</td>
        <td style={{ ...td, textAlign: 'right' }}>{c.net_adj_pct != null ? pct(c.net_adj_pct) : (c.net_adjustment != null ? money(c.net_adjustment) : '—')}</td>
      </tr>
      {open && hasDetail && (
        <tr style={{ background: 'var(--paper,#F6F3EC)' }}>
          <td />
          <td colSpan={11} style={{ padding: '4px 10px 12px' }}>
            {compFacts.length > 0 && (
              <div style={{ marginBottom: adj.length ? 10 : 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', margin: '4px 0 6px' }}>Comparable detail</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: '4px 18px' }}>
                  {compFacts.map(([k, v], i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--muted,#4B585C)' }}>{k}</span>
                      <span style={{ color: String(v).startsWith('Adverse') ? 'var(--crit,#B4483C)' : 'inherit' }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {adj.length > 0 && (<>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', margin: '4px 0 6px' }}>Adjustments applied</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: '4px 18px' }}>
                {adj.filter((x) => x && x.amount != null && Number(x.amount) !== 0).map((x, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
                    <span style={{ color: 'var(--muted,#4B585C)' }}>{x.type || 'Adjustment'}{x.description ? ` (${x.description})` : ''}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: Number(x.amount) < 0 ? 'var(--crit,#B4483C)' : 'var(--good,#3F7A5B)' }}>{Number(x.amount) > 0 ? '+' : ''}{money(x.amount)}</span>
                  </div>
                ))}
              </div>
            </>)}
          </td>
        </tr>
      )}
    </>
  );
}

// The comparable-grid column header (shared by every grid so the two grids line up identically).
function CompHead() {
  return (
    <thead>
      <tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)', background: 'var(--paper,#F6F3EC)' }}>
        <th style={th}>#</th><th style={th}>Address</th><th style={th}>Proximity</th>
        <th style={{ ...th, textAlign: 'right' }}>GLA</th><th style={{ ...th, textAlign: 'center' }}>Bd/Ba</th><th style={{ ...th, textAlign: 'center' }}>C / Q</th>
        <th style={{ ...th, textAlign: 'right' }}>Sale date</th><th style={{ ...th, textAlign: 'right' }}>DOM</th>
        <th style={{ ...th, textAlign: 'right' }}>Sale price</th><th style={{ ...th, textAlign: 'right' }}>$/GLA</th>
        <th style={{ ...th, textAlign: 'right' }}>Adjusted</th><th style={{ ...th, textAlign: 'right' }}>Net adj</th>
      </tr>
    </thead>
  );
}

// Adjusted-price support for a set of comps vs a value — the bracket (min–max), the median, and
// whether the value sits inside the range. This is computed WITHIN one grid, so an As-Is value is
// never checked against ARV comps and vice-versa (the correctness the two-grid split delivers).
function gridSupport(rows, value) {
  // Bracket against CLOSED sales only — an active/pending listing's adjusted price is off an asking
  // price, not a settled sale, so it never sets the range (matches the backend review checks).
  const closedRows = rows.filter((c) => c.sale_status == null || c.sale_status === 'closed');
  const adj = closedRows.map((c) => Number(c.adjusted_price)).filter((n) => Number.isFinite(n) && n > 0);
  if (!adj.length) return null;
  const s = [...adj].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const v = Number(value);
  const hasV = Number.isFinite(v) && v > 0;
  return { lo: s[0], hi: s[s.length - 1], median: Math.round(median), n: adj.length, value: hasV ? v : null, bracketed: hasV ? (v >= s[0] && v <= s[s.length - 1]) : null };
}

// One labeled comparable grid (ARV / As-Is / Unclassified) with its own value-support line. A
// renovation appraisal renders TWO of these — the ARV grid supporting the after-repair value and
// the As-Is grid supporting the as-is value — never one mixed grid.
function CompGrid({ title, subtitle, rows, value, tone }) {
  if (!rows.length) return null;
  const sup = gridSupport(rows, value);
  const accent = tone === 'arv' ? 'var(--teal,#2F7F86)' : tone === 'as_is' ? 'var(--gold,#AE8746)' : 'var(--muted,#4B585C)';
  return (
    <div className="appr-avoid" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: accent, alignSelf: 'center' }} />
        <strong style={{ fontSize: 14.5 }}>{title}</strong>
        <span style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)' }}>{rows.length} comp{rows.length === 1 ? '' : 's'}{subtitle ? ` · ${subtitle}` : ''}</span>
      </div>
      {sup && (
        <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: 6 }}>
          Adjusted range <strong style={{ color: 'var(--text,#141B22)' }}>{money(sup.lo)}–{money(sup.hi)}</strong> · median {money(sup.median)}
          {sup.value != null && (
            <> · value {money(sup.value)}{' '}
              <span style={{ fontWeight: 700, color: sup.bracketed ? 'var(--good,#3F7A5B)' : 'var(--crit,#B4483C)' }}>
                {sup.bracketed ? '✓ within range' : '⚠ outside range'}
              </span>
            </>
          )}
        </div>
      )}
      <div style={{ overflowX: 'auto', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, borderTop: `3px solid ${accent}` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 780 }}>
          <CompHead />
          <tbody>{rows.map((c) => <CompRow key={c.id} c={c} />)}</tbody>
        </table>
      </div>
    </div>
  );
}

// The custom branded print. A print-only stylesheet that ISOLATES the report card (hides the
// rest of the page + the overlay chrome), lays it out for paper with page-break control, keeps
// the brand colors (print-color-adjust:exact), and reveals a print-only masthead. This is the
// "our own print", not a raw browser dump — the design lives here. Only rendered while the
// full-screen report is open, so printing from anywhere else is unaffected.
const PRINT_CSS = `
/* The full-report overlay shows the WHOLE report — force every collapsible
   section open inside it (and hide the toggle chevrons), on screen and on paper. */
.appr-print-root .appr-sec > .appr-sec-body { display: block !important; }
.appr-print-root .appr-sec-chev { display: none !important; }
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
  /* Wide comp tables carry an inline min-width for the screen's horizontal scroll; on paper that
     clips off the right edge. Drop the min-width, let the scroll container overflow visibly, and
     tighten the type so the full grid (both the As-Is and ARV grids) fits the page width. */
  .appr-print-root [style*="overflow"] { overflow: visible !important; }
  .appr-print-root table { min-width: 0 !important; width: 100% !important; font-size: 9.5px !important; table-layout: fixed !important; }
  .appr-print-root td, .appr-print-root th { padding: 3px 4px !important; overflow-wrap: anywhere !important; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

// Compass bearing → degrees clockwise from North.
const DIRS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
// Parse a MISMO proximity string ("0.35 miles SW") → { miles, dir }. Returns null if it can't be
// read as an explicit mile distance (never guessed — a "2 blocks" description maps to nothing).
function parseProximity(s) {
  const t = String(s || '').toUpperCase();
  const m = /(\d+(?:\.\d+)?)\s*(?:MI\b|MILE)/.exec(t);
  if (!m) return null;
  const miles = Number(m[1]);
  const dm = /(NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|NE|SE|SW|NW|N|E|S|W)\s*$/.exec(t.replace(/MILES?/g, '').trim());
  return { miles: Number.isFinite(miles) ? miles : null, dir: dm ? dm[1] : null };
}

// Comp location map — the subject at centre, each comparable plotted by its distance (radius) and
// compass direction from the appraisal's proximity field. Pure SVG, no tiles, no network, no deps.
function CompMap({ comps }) {
  const pts = (comps || []).filter((c) => !c.is_subject)
    .map((c) => ({ c, p: parseProximity(c.proximity) }))
    .filter((x) => x.p && x.p.miles != null && x.p.dir && DIRS[x.p.dir] != null);
  if (pts.length < 2) return null;                       // not enough mappable comps to be useful
  const maxMi = Math.max(0.5, ...pts.map((x) => x.p.miles));
  const SIZE = 280, cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 26;
  const rFor = (mi) => (mi / maxMi) * R;
  const xy = (mi, dir) => { const rad = (DIRS[dir] * Math.PI) / 180; const r = rFor(mi); return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)]; };
  const rings = [maxMi / 2, maxMi];
  const line = 'var(--line,#E7E1D3)', muted = 'var(--muted,#4B585C)';
  const unmapped = (comps || []).filter((c) => !c.is_subject).length - pts.length;
  return (
    <div className="appr-avoid" style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 16, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ flex: 'none', maxWidth: '100%' }} role="img" aria-label="Map of comparable sales relative to the subject">
        {rings.map((mi, i) => <circle key={i} cx={cx} cy={cy} r={rFor(mi)} fill="none" stroke={line} strokeDasharray="3 3" />)}
        {rings.map((mi, i) => <text key={`l${i}`} x={cx + 3} y={cy - rFor(mi) + 12} fontSize="9.5" fill={muted}>{mi.toFixed(mi < 1 ? 2 : 1)} mi</text>)}
        {['N', 'E', 'S', 'W'].map((d) => { const [x, y] = xy(maxMi, d); return <text key={d} x={x} y={y} fontSize="10" fontWeight="700" fill={muted} textAnchor="middle" dominantBaseline="middle">{d}</text>; })}
        {/* subject */}
        <circle cx={cx} cy={cy} r={6} fill="var(--gold,#AE8746)" />
        <text x={cx} y={cy - 10} fontSize="10.5" fontWeight="700" fill="var(--text,#141B22)" textAnchor="middle">Subject</text>
        {/* comps */}
        {pts.map(({ c, p }) => {
          const [x, y] = xy(p.miles, p.dir);
          return (
            <g key={c.id}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke={line} />
              <circle cx={x} cy={y} r={5} fill="var(--teal,#2F7F86)" />
              <text x={x} y={y - 8} fontSize="10" fontWeight="700" fill="var(--teal-deep,#256168)" textAnchor="middle">{c.seq}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ minWidth: 160, flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)', marginBottom: 8 }}>Comp locations</div>
        <div style={{ display: 'grid', gap: 5, fontSize: 12.5 }}>
          {pts.map(({ c, p }) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ flex: 'none', width: 18, height: 18, borderRadius: '50%', background: 'var(--teal,#2F7F86)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{c.seq}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{or(c.address)} <span style={{ color: muted }}>· {p.miles} mi {p.dir}</span></span>
            </div>
          ))}
        </div>
        {unmapped > 0 && <div style={{ fontSize: 11.5, color: muted, marginTop: 8 }}>{unmapped} comp{unmapped === 1 ? '' : 's'} had no mappable distance/direction.</div>}
      </div>
    </div>
  );
}

// Three-cap loan-sizing panel (staff only). Fetches the current pricing quote (frozen engine, no
// persistence) and shows where the loan lands on each leverage measure — As-Is/acquisition LTV,
// loan-to-cost, ARV LTV — and which one is binding. Renders nothing if pricing is unavailable.
function ThreeCapPanel({ appId }) {
  const [state, setState] = useState(null);   // null=loading | {err} | {data}
  useEffect(() => {
    let live = true;
    api.staffPricing(appId).then((r) => { if (live) setState({ data: r }); }).catch((e) => { if (live) setState({ err: e && e.message }); });
    return () => { live = false; };
  }, [appId]);
  if (!state || state.err) return null;                       // quiet while loading / if unavailable
  const d = state.data || {};
  const quote = d.quote || {};
  const prog = d.current && d.current.program;
  const pick = (prog && quote[prog] && quote[prog].eligible) ? quote[prog]
    : (quote.standard && quote.standard.eligible) ? quote.standard
      : (quote.gold && quote.gold.eligible) ? quote.gold : null;
  if (!pick || !pick.sizing) return null;
  const s = pick.sizing;
  const b = String(s.binding || '').toLowerCase();
  const caps = [
    { label: 'As-Is / acquisition LTV', pct: s.acqLtvPct, key: 'acq' },
    { label: 'Loan-to-cost', pct: s.ltcPct, key: 'ltc' },
    { label: 'ARV LTV', pct: s.arvPct, key: 'arv' },
  ].filter((c) => c.pct != null);
  if (!caps.length) return null;
  const isBinding = (k) => (k === 'acq' && /acq|as.?is|ltv/.test(b) && !/arv/.test(b)) || (k === 'ltc' && /ltc|cost/.test(b)) || (k === 'arv' && /arv/.test(b));
  return (
    <div className="appr-avoid" style={{ marginTop: 14, background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)' }}>Loan sizing — leverage by measure</span>
        {s.totalLoan != null && <span style={{ fontSize: 13 }}>Sized loan <b style={{ fontFamily: 'var(--serif,Georgia,serif)' }}>{money(s.totalLoan)}</b>{pick.programLabel ? <span style={{ color: 'var(--muted,#4B585C)' }}> · {pick.programLabel}</span> : null}</span>}
      </div>
      <div style={{ display: 'grid', gap: 9 }}>
        {caps.map((c) => {
          const pct = Math.max(0, Math.min(100, Number(c.pct)));
          const bind = isBinding(c.key);
          return (
            <div key={c.key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 3 }}>
                <span style={{ color: 'var(--muted,#4B585C)' }}>{c.label}{bind && <span style={{ color: 'var(--teal-deep,#256168)', fontWeight: 700 }}> · binding</span>}</span>
                <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(1)}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 6, background: 'var(--line,#E7E1D3)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: bind ? 'var(--teal,#2F7F86)' : 'var(--gold,#AE8746)', borderRadius: 6 }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)', marginTop: 8 }}>Where this loan lands on each leverage measure at today's file values — the binding one sets the size. Live preview, nothing saved.</div>
    </div>
  );
}

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

export default function AppraisalPanel({ appId, readOnly = false, onSummary, reloadSignal = 0 }) {
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
    // reloadSignal is bumped by the parent when an appraisal is imported elsewhere
    // (e.g. an XML dropped on the appraisal-documents condition), so the findings
    // appear here immediately without a separate re-import.
  }, [appId, onSummary, readOnly, reloadSignal]);

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

  const [undoing, setUndoing] = useState(false);
  const undoImport = async () => {
    if (!window.confirm('Remove this appraisal? This clears its findings and the imported appraisal data and restores the file to what it was before the import — so you can upload the correct appraisal fresh. This cannot be undone.')) return;
    setUndoing(true); setErr('');
    try {
      await api.appraisalUndoImport(appId);
      await load();
    } catch (e4) { setErr(e4.message || 'Could not remove the appraisal'); }
    finally { setUndoing(false); }
  };

  const [pulling, setPulling] = useState(false);
  const pullPhotos = async () => {
    setPulling(true); setErr('');
    try {
      const r = await api.appraisalRefreshPhotos(appId);
      await load();
      if (!r || !r.stored) setErr('No photos could be pulled — the appraisal PDF may not be on file yet. Upload the PDF to the appraisal condition, then try again.');
    } catch (e3) { setErr(e3.message || 'Could not pull photos'); }
    finally { setPulling(false); }
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
          {a && (
            <button type="button" onClick={undoImport} disabled={undoing || importing}
              style={{ ...btn(false), color: 'var(--crit,#B4483C)', borderColor: 'var(--crit,#B4483C)' }}
              title="Remove this appraisal — clears the findings + imported data and restores the file, so you can upload the correct appraisal fresh">
              {undoing ? 'Removing…' : 'Remove / undo this appraisal'}
            </button>
          )}
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
                <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginTop: 8 }}>Appraised value on the report: <b style={{ color: 'var(--text,#141B22)' }}>{money(a.appraised_value)}</b></div>
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
          {photos.length > 0 ? (
            <PhotoGallery photos={photos} readOnly={readOnly} />
          ) : (
            <div className="appr-avoid appr-noprint" style={{ background: 'var(--paper,#F6F3EC)', border: '1px dashed var(--line,#E7E1D3)', borderRadius: 14, padding: 18, marginTop: 6, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 15, fontWeight: 600 }}>Photographs</div>
                <div style={{ fontSize: 13, color: 'var(--muted,#4B585C)', marginTop: 2 }}>
                  {readOnly ? 'The property photos will appear here once the appraisal PDF has been processed.'
                    : 'No photos yet — they’re pulled from the appraisal PDF. If the PDF is on file, pull them now; otherwise upload the PDF to the appraisal condition.'}
                </div>
              </div>
              {!readOnly && <button className="appr-noprint" onClick={pullPhotos} disabled={pulling} style={{ ...OPEN_BTN, marginLeft: 0 }}>{pulling ? 'Pulling photos…' : '⤓ Pull photos from the PDF'}</button>}
            </div>
          )}

          {/* ===== PROPERTY DETAILS — the dossier cards ===== */}
          <ApprSection eyebrow="The subject" title="Property details">
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
                a.building_status && a.building_status !== 'Existing' && ['Building status',
                  <span style={{ color: 'var(--crit,#B4483C)' }}>{human(a.building_status)}</span>],
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
                ['Lot size', or(a.lot_area), a.lot_dimensions || null],
                a.lot_shape && ['Lot shape', a.lot_shape],
                a.view_rating && ['View', a.view_rating],
                // Property rights — surfaced only to FLAG the exception (nearly always FeeSimple).
                a.property_rights && a.property_rights !== 'FeeSimple' && ['Property rights',
                  <span style={{ color: 'var(--crit,#B4483C)' }}>{human(a.property_rights)}</span>],
                ['Zoning', or(a.zoning_id), or(a.zoning_desc) !== '—' ? a.zoning_desc : null],
                ['Zoning compliance', or(a.zoning_compliance), a.zoning_compliance_note || null],
                ['Flood zone', or(a.flood_zone), a.fema_panel_id ? `FEMA panel ${a.fema_panel_id}` : null],
                a.special_flood_hazard === true && ['Special flood hazard area',
                  <span style={{ color: 'var(--crit,#B4483C)' }}>Yes — inside SFHA</span>],
                // FEMA cross-check — shown only once we've actually checked (never a guess).
                a.fema_flood_checked_at && ['FEMA flood map',
                  <span style={{ color: a.fema_flood_agrees === false ? 'var(--crit,#B4483C)' : a.fema_flood_agrees ? 'var(--good,#3F7A5B)' : 'inherit' }}>
                    {a.fema_flood_zone ? `Zone ${a.fema_flood_zone}` : 'No zone mapped'}{a.fema_flood_agrees === true ? ' · agrees' : a.fema_flood_agrees === false ? ' · differs' : ''}
                  </span>,
                  a.fema_flood_agrees === false ? a.fema_flood_note : null],
                // Off-site improvements — street/alley + a Public/Private ownership flag (a private
                // street means shared maintenance/access, a flip cost signal).
                (() => {
                  const os = (Array.isArray(a.off_site_improvements) ? a.off_site_improvements
                    : (() => { try { return JSON.parse(a.off_site_improvements || '[]'); } catch { return []; } })())
                    .filter((o) => o && o.type);
                  if (!os.length) return null;
                  const priv = os.some((o) => o.ownership === 'Private');
                  return ['Street / access',
                    <span style={{ color: priv ? 'var(--crit,#B4483C)' : 'inherit' }}>
                      {os.map((o) => `${o.type}${o.ownership ? ` (${o.ownership.toLowerCase()})` : ''}`).join(' · ')}
                    </span>,
                    priv ? 'private — confirm a road-maintenance agreement' : null];
                })(),
                ['Site value (cost)', a.site_value != null ? money(a.site_value) : '—'],
                a.property_tax_amount != null && ['Annual property tax',
                  `${money(a.property_tax_amount)}${a.property_tax_year != null ? ` (${a.property_tax_year})` : ''}`],
              ]} />
            </DCard>

            {(a.value_income_approach != null || a.grm != null || a.est_market_monthly_rent != null || (data.units || []).length > 0) && (
              <DCard title="Income & rents" tag={a.form_type === 'FNM1025' ? '1025' : null}>
                <KV rows={(() => {
                  const units = data.units || [];
                  const mkt = units.reduce((s, u) => s + (num(u.market_rent) || 0), 0);
                  const act = units.reduce((s, u) => s + (num(u.actual_rent) || 0), 0);
                  const rentUtils = Array.isArray(a.rent_included_utilities) ? a.rent_included_utilities : (() => { try { return JSON.parse(a.rent_included_utilities || '[]'); } catch { return []; } })();
                  const valForYield = num(a.value_income_approach) != null ? num(a.value_income_approach)
                    : num(a.as_is_value) != null ? num(a.as_is_value) : num(a.appraised_value);
                  const yieldPct = (mkt > 0 && valForYield) ? (mkt * 12) / valForYield * 100 : null;
                  return [
                    mkt > 0 && ['Market rent', `${money(mkt)} / mo`, `${money(mkt * 12)} / yr`],
                    act > 0 && ['Actual rent', `${money(act)} / mo`],
                    a.est_market_monthly_rent != null && ['Est. market rent (appraiser)', `${money(a.est_market_monthly_rent)} / mo`],
                    ['Gross rent multiplier', a.grm != null ? Number(a.grm).toLocaleString('en-US') : '—'],
                    ['Value — income approach', a.value_income_approach != null ? money(a.value_income_approach) : '—'],
                    yieldPct != null && ['Gross yield (market)', `${yieldPct.toFixed(1)}%`, 'annual market rent ÷ value'],
                    rentUtils.length > 0 && ['Rent includes', `${rentUtils.join(', ')} (landlord-paid)`],
                  ];
                })()} />
                {(data.units || []).length > 0 && (
                  <div style={{ marginTop: 12, overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                      <thead><tr style={{ textAlign: 'left', color: 'var(--muted,#4B585C)' }}>
                        <th style={th}>Unit</th><th style={{ ...th, textAlign: 'center' }}>Bd/Ba</th><th style={{ ...th, textAlign: 'right' }}>SqFt</th>
                        <th style={th}>Lease</th><th style={{ ...th, textAlign: 'right' }}>Actual</th><th style={{ ...th, textAlign: 'right' }}>Market</th>
                      </tr></thead>
                      <tbody>
                        {(data.units || []).map((u) => (
                          <tr key={u.id} style={{ borderTop: '1px solid var(--line-soft,#EFEADD)' }}>
                            <td style={td}>{u.unit_seq != null ? `Unit ${u.unit_seq}` : '—'}</td>
                            <td style={{ ...td, textAlign: 'center' }}>{(u.beds != null || u.baths != null) ? `${u.beds != null ? u.beds : '—'}/${u.baths != null && u.baths !== '' ? u.baths : '—'}` : '—'}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{u.sqft != null ? Number(u.sqft).toLocaleString('en-US') : '—'}</td>
                            <td style={td}>{u.lease_status ? human(u.lease_status).replace('Month To Month', 'MTM') : '—'}</td>
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
                {(() => {
                  const oo = (a.condo_units_sold > 0 && a.condo_owner_occupied != null) ? Math.round(a.condo_owner_occupied / a.condo_units_sold * 100) : null;
                  return (<>
                    {(oo != null || a.condo_developer_control === true || a.condo_concentrated_ownership === true || a.condo_commercial_space === true) && (
                      <div style={{ marginBottom: 10 }}>
                        {oo != null && chip(`${oo}% owner-occupied`, oo < 50 ? 'bad' : 'good')}
                        {a.condo_developer_control === true && chip('Developer-controlled', 'warn')}
                        {a.condo_concentrated_ownership === true && chip('Concentrated ownership', 'warn')}
                        {a.condo_commercial_space === true && chip('Commercial space', 'warn')}
                      </div>
                    )}
                    <KV rows={[
                      ['Project', or(a.condo_project_name)],
                      ['Type', or(a.condo_project_type)],
                      ['Unit / floor', `${or(a.condo_unit_identifier)} · ${or(a.condo_floor)}`],
                      ['HOA fee', a.hoa_fee_amount != null ? `${money(a.hoa_fee_amount)} / ${(a.hoa_fee_period || '').toLowerCase() || 'mo'}` : '—'],
                      a.condo_units_sold != null && ['Units sold', `${a.condo_units_sold}${a.condo_units_planned != null ? ` of ${a.condo_units_planned} planned` : ''}`],
                      a.condo_units_completed != null && ['Units completed', `${a.condo_units_completed}${a.condo_total_phases != null ? ` · ${a.condo_total_phases} phase${a.condo_total_phases === 1 ? '' : 's'}` : ''}`],
                      a.condo_units_rented != null && a.condo_units_rented > 0 && ['Units rented', a.condo_units_rented],
                      a.condo_units_for_sale != null && a.condo_units_for_sale > 0 && ['Units for sale', a.condo_units_for_sale],
                      a.condo_management_type && ['Management', human(a.condo_management_type)],
                      a.condo_parking_spaces != null && ['Parking spaces', a.condo_parking_spaces],
                      a.condo_common_elements && ['Common elements', a.condo_common_elements],
                    ]} />
                  </>);
                })()}
              </DCard>
            )}

            <NeighborhoodCard a={a} />
            <SystemsCard a={a} />
            <ContractCard a={a} readOnly={readOnly} />
          </div>
          </ApprSection>

          {/* ===== WHAT IT'S WORTH ===== */}
          <ApprSection eyebrow="Valuation" title="What it's worth">
          <Approaches a={a} />
          {/* The appraiser's OWN researched market bracket (from the appraisal's research block) —
              context alongside our independent comp check below. */}
          {(() => {
            const cr = typeof a.comp_research === 'string' ? (() => { try { return JSON.parse(a.comp_research); } catch { return null; } })() : a.comp_research;
            if (!cr) return null;
            const parts = [];
            if (cr.salesLow != null && cr.salesHigh != null) parts.push(`${cr.salesCount != null ? `${cr.salesCount} ` : ''}comparable sales ${money(cr.salesLow)}–${money(cr.salesHigh)}`);
            if (cr.listingsLow != null && cr.listingsHigh != null) parts.push(`${cr.listingsCount != null ? `${cr.listingsCount} ` : ''}active listings ${money(cr.listingsLow)}–${money(cr.listingsHigh)}`);
            if (!parts.length) return null;
            return (
              <div className="appr-avoid" style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, padding: '12px 14px', fontSize: 13 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)' }}>Appraiser’s research</span>
                <span style={{ color: 'var(--muted,#4B585C)' }}>The appraiser researched {parts.join(' · ')} in the subject’s market.</span>
              </div>
            );
          })()}
          {/* Independent second opinion — what the comps themselves imply (not the appraiser's
              reconciliation). Shown only when we have enough comps to form one. */}
          {data.score && data.score.impliedValue && (
            <div className="appr-avoid" style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', background: 'var(--card,#fff)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, padding: '12px 14px', fontSize: 13 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gold,#AE8746)' }}>Independent comp check</span>
              <span>The comps imply <b style={{ fontFamily: 'var(--serif,Georgia,serif)', fontSize: 16 }}>{money(data.score.impliedValue.median)}</b>
                <span style={{ color: 'var(--muted,#4B585C)' }}> (median of {data.score.impliedValue.n} adjusted comps; range {money(data.score.impliedValue.low)}–{money(data.score.impliedValue.high)}{data.score.impliedValue.perGlaValue ? `; $/sqft implies ${money(data.score.impliedValue.perGlaValue)}` : ''})</span>
              </span>
            </div>
          )}
          <div className="appr-avoid" style={{ marginTop: 14, background: 'var(--paper,#F6F3EC)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 12, padding: '14px 16px', fontSize: 13.5 }}>
            <span style={{ fontWeight: 700, color: 'var(--teal-deep,#256168)' }}>Value basis:&nbsp;</span>
            {isArvBasis
              ? <>The headline value reflects the <b>After-Repair Value</b> — this appraisal is made <b>subject to completion</b> of the repairs described in the report. The <b>As-Is value</b> is stored separately so pricing never confuses the two.</>
              : <>This is the <b>current As-Is market value</b> of the property, as reconciled by the appraiser from the sales-comparison approach.</>}
            {a.as_is_confidence && a.as_is_confidence !== 'definite' && <> The As-Is figure was read from the report’s narrative — PILOT opens a task for an officer to confirm it rather than guess.</>}
          </div>

          {/* How the value was concluded + the cost-approach depreciation detail. */}
          {(a.reconciliation_comment || a.conditions_comment || a.addendum_text || a.cost_new_total != null) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, marginTop: 16 }}>
              <ValueConcludedCard a={a} />
              <CostApproachCard a={a} />
            </div>
          )}

          {/* Three-cap loan sizing — staff only (uses the pricing quote, no persistence). */}
          {!readOnly && <ThreeCapPanel appId={appId} />}
          </ApprSection>

          {/* ===== COMPARABLE SALES — split into the As-Is grid and the ARV grid ===== */}
          {comps.length > 0 && (() => {
            const real = comps.filter((c) => !c.is_subject);
            const arvC = real.filter((c) => c.comp_set === 'arv');
            const asisC = real.filter((c) => c.comp_set === 'as_is');
            const unkC = real.filter((c) => c.comp_set === 'unknown' || !c.comp_set);
            const twoGrid = arvC.length > 0 && asisC.length > 0;
            const splitHow = { narrative: 'grids read from the appraiser’s narrative', proximity: 'grids inferred from comp pricing', single_grid: null, undetermined: null }[a.comp_split_confidence];
            return (
              <ApprSection eyebrow="Evidence" title={twoGrid ? 'Comparable sales — As-Is & ARV grids' : 'Comparable sales'}
                extra={<span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted,#4B585C)' }}>{real.length} comps{twoGrid && splitHow ? ` · ${splitHow}` : twoGrid ? ' · two grids support two values' : ' · tap a row for the detail'}</span>}>
                {a.comp_split_needs_review && (
                  <div className="appr-avoid" style={{ margin: '2px 0 12px', padding: '9px 12px', borderRadius: 10, fontSize: 12.5,
                    background: 'rgba(174,135,70,.10)', border: '1px solid var(--gold,#AE8746)', color: 'var(--text,#141B22)' }}>
                    <strong>Comp grids need a look.</strong> Some comparables could not be confidently sorted into the As-Is vs After-Repair grid, so the automatic value-bracketing was held back for those. Confirm which comps support which value.
                  </div>
                )}
                <div style={{ marginBottom: 14 }}><CompMap comps={comps} /></div>
                {twoGrid ? (
                  <>
                    <CompGrid title="After-Repair (ARV) comparables" subtitle="support the after-repair value" rows={arvC} value={a.arv_value} tone="arv" />
                    <CompGrid title="As-Is comparables" subtitle="support the as-is value" rows={asisC} value={a.as_is_value} tone="as_is" />
                    {unkC.length > 0 && <CompGrid title="Unclassified — needs review" subtitle="not confidently assigned to a grid" rows={unkC} value={null} tone="unknown" />}
                  </>
                ) : (
                  <CompGrid
                    title={arvC.length ? 'After-Repair (ARV) comparables' : asisC.length ? 'As-Is comparables' : 'Comparable sales'}
                    subtitle={arvC.length ? 'support the after-repair value' : asisC.length ? 'support the as-is value' : null}
                    rows={[...arvC, ...asisC, ...unkC]}
                    value={arvC.length ? a.arv_value : a.as_is_value}
                    tone={arvC.length ? 'arv' : 'as_is'} />
                )}
              </ApprSection>
            );
          })()}

          {/* ===== PREPARED BY ===== */}
          <ApprSection eyebrow="Provenance" title="Prepared by">
          <PreparedBy a={a} readOnly={readOnly} />
          </ApprSection>

          {/* ===== ORIGINAL APPRAISAL (staff only — needs the source document ids) ===== */}
          {!readOnly && (a.pdf_document_id || a.source_xml_document_id) && (
            <ApprSection eyebrow="Source document" title="Original appraisal">
              <SourceDocs a={a} />
            </ApprSection>
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
            <ApprOpenCtx.Provider value={true}>{body}</ApprOpenCtx.Provider>
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
