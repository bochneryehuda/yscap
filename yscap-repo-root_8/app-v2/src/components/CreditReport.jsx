import React, { useEffect, useState, useCallback } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { fileToBase64 } from '../lib/files.js';
import DocPreview from './DocPreview.jsx';
import { askConfirm } from '../lib/dialog.js';

/**
 * Credit report (Xactus import) — the internal "Credit report" condition
 * (rtl_cond_credit). Renders inside the staff file's `Item` when
 * it.template_code === 'rtl_cond_credit'.
 *
 *   • "Import credit" opens a review screen that SHOWS the exact borrower info
 *     that will be transmitted, defaults to Soft pull + tri-merge + v3.4, with
 *     manual toggles to Hard / brand-new, and requires a permissible-purpose
 *     attestation (the server enforces it too).
 *   • pulls/reissues via ONE shared company login (no per-user credential),
 *     files the PDF + the source data file, and imports every detail into a
 *     full credit-details section (hero score + KPIs + tradelines) for
 *     underwriting.
 *
 * Every identifier here is an import, a local, a prop, or a browser global — no
 * eslint no-undef traps in the esbuild JSX bundle.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// tz-safe: never `new Date('YYYY-MM-DD')` on a date-only value (repo date rule).
function fmtDay(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(s);
}
function fmtWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts || ''); }
}
function money(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = reject;
    r.readAsText(file);
  });
}
function initials(first, last) {
  const a = (first || '').trim(), b = (last || '').trim();
  const s = ((a[0] || '') + (b[0] || '')).toUpperCase();
  return s || '—';
}
// FICO/score bands → a label + a tone key that drives the semantic color.
// A null/blank score is "No score" (neutral) — NOT "Poor". Guard first: Number(null)
// and Number('') are 0 (a finite number that would wrongly read as a red "Poor").
function scoreBand(v) {
  if (v == null || v === '') return { label: 'No score', tone: 'none' };
  const n = Number(v);
  if (!Number.isFinite(n)) return { label: 'No score', tone: 'none' };
  if (n >= 800) return { label: 'Exceptional', tone: 'good' };
  if (n >= 740) return { label: 'Very good', tone: 'good' };
  if (n >= 670) return { label: 'Good', tone: 'ok' };
  if (n >= 580) return { label: 'Fair', tone: 'fair' };
  return { label: 'Poor', tone: 'poor' };
}
// Marker position on a 300–850 gauge, clamped to the track.
function gaugePct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, ((n - 300) / 550) * 100));
}

// Lock the background page scroll while a modal/overlay is open AND preserve the
// scroll position (owner-reported 2026-07-23: closing the full report flew the
// page back to the top of the file). `overflow:hidden` can clamp the page scroll
// to 0, so we capture window.scrollY on open and restore it on close — the user
// stays exactly where they were. Also closes on Escape when onClose is given.
function useScrollLock(onClose) {
  useEffect(() => {
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = onClose ? (e) => { if (e.key === 'Escape') onClose(); } : null;
    if (onKey) window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      if (onKey) window.removeEventListener('keydown', onKey);
      window.scrollTo(0, scrollY);
    };
  }, [onClose]);
}

// Small line icons for the KPI badges (inline SVG, stroke = currentColor).
function KIcon({ name }) {
  const p = {
    accounts: <><rect x="2.5" y="4" width="11" height="8" rx="1.5" /><path d="M2.5 6.8h11" /></>,
    balance: <><rect x="2.5" y="4.5" width="11" height="7" rx="1.2" /><circle cx="8" cy="8" r="1.6" /></>,
    payment: <><rect x="2.5" y="3.5" width="11" height="9.5" rx="1.5" /><path d="M2.5 6.4h11M5.5 2.4v2M10.5 2.4v2" /></>,
    alert: <><path d="M8 2.6 14 12.5H2z" /><path d="M8 6.8v2.6M8 11h.01" /></>,
    flag: <><path d="M4 2.6v11" /><path d="M4 3.4h7l-1.3 2.2L11 7.8H4z" /></>,
    record: <><path d="M2.6 13h10.8M3.6 6.4h8.8M8 2.4 13 5.4H3z" /><path d="M4.8 6.6v5.4M11.2 6.6v5.4" /></>,
    search: <><circle cx="7" cy="7" r="3.6" /><path d="m10 10 3 3" /></>,
  }[name] || null;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>
  );
}

// A modern segmented control (namespaced .crx-seg so it never collides with the
// global .seg used elsewhere). Each option can carry a helper line.
function Seg({ value, onChange, options }) {
  return (
    <div className="crx-seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value}
          className={'crx-seg-btn' + (value === o.value ? ' on' : '')}
          onClick={() => onChange(o.value)}>
          <span className="crx-seg-lbl">{o.label}</span>
          {o.sub && <span className="crx-seg-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

// One bureau's score tile with a band-colored mini-bar.
function BureauTile({ s }) {
  const band = scoreBand(s && s.value);
  return (
    <div className={'crx-bureau tone-' + band.tone}>
      <div className="crx-bureau-top">
        <span className="crx-bureau-name">{(s && s.bureau) || 'Score'}</span>
        <span className="crx-bureau-val">{s && s.value != null ? s.value : '—'}</span>
      </div>
      <div className="crx-bureau-bar"><i style={{ width: gaugePct(s && s.value) + '%' }} /></div>
      {s && s.model ? <div className="crx-bureau-model" title={s.model}>{s.model}</div> : null}
    </div>
  );
}

// A KPI tile: icon badge + number + label. `tone` tints the badge for attention.
function KpiTile({ icon, tone, value, label }) {
  return (
    <div className="crx-kpi">
      <span className={'crx-kpi-ic' + (tone ? ' ' + tone : '')}><KIcon name={icon} /></span>
      <div className="crx-kpi-body">
        <div className="crx-kpi-num">{value}</div>
        <div className="crx-kpi-lbl">{label}</div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── import modal ───
// `scopeBorrowerId` pins the import to ONE borrower — that is how the co-borrower's
// own credit condition imports their report without touching the primary's.
function CreditImportModal({ appId, onClose, onDone, scopeBorrowerId }) {
  const [pre, setPre] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pullType, setPullType] = useState('soft');
  const [requestType, setRequestType] = useState('reissue');
  const [version, setVersion] = useState('3.4');
  // A reissue reference identifies ONE report at Xactus, so each borrower has their
  // own box. Keyed by borrowerId.
  const [reissueRefs, setReissueRefs] = useState({});
  // How a LIVE order for several borrowers goes out to Xactus:
  //   'joint'    — ONE order covering everybody, ONE reference number
  //   'separate' — one order per borrower, each with its own reference
  const [orderShape, setOrderShape] = useState('joint');
  const [jointRef, setJointRef] = useState('');
  const [consent, setConsent] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [xmlFile, setXmlFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);
  // How a downloaded report covers the borrowers:
  //   merged   — ONE file covering both (PILOT splits it and scores each borrower)
  //   separate — a different file for each borrower, imported in one go
  //   one      — one borrower's report only
  const [uploadMode, setUploadMode] = useState('one');
  const [perFiles, setPerFiles] = useState({});     // borrowerId → { xml, pdf }
  const [selected, setSelected] = useState(null);   // Set of borrowerIds to pull; null until preview loads
  const [reuseBusy, setReuseBusy] = useState(null);  // borrowerId currently being reused-from-profile

  useEffect(() => {
    let alive = true;
    api.staffCreditPreview(appId)
      .then((d) => {
        if (!alive) return;
        setPre(d);
        if (d) {
          if (d.defaults) { setPullType(d.defaults.pullType); setRequestType(d.defaults.requestType); setVersion(d.defaults.version || '3.4'); }
          const list = d.borrowers || [];
          // Each borrower's reissue box starts on THEIR OWN last report — never the
          // other borrower's reference (which Xactus would reissue as the wrong report).
          const refs = {};
          list.forEach((b) => { refs[b.borrowerId] = b.reissueReportId || ''; });
          setReissueRefs(refs);
          setJointRef(d.jointReissueReportId || '');
          // Default to the shape the file already used: a joint reference on file
          // means this file's credit is ordered jointly.
          setOrderShape(d.jointReissueReportId ? 'joint' : (list.length > 1 ? 'joint' : 'separate'));
          // Default: every borrower on the file in one action — unless this condition
          // is one borrower's own, in which case only they are imported.
          const inScope = scopeBorrowerId && list.some((b) => b.borrowerId === scopeBorrowerId);
          setSelected(new Set(inScope ? [scopeBorrowerId] : list.map((x) => x.borrowerId)));
          setUploadMode(list.length > 1 && !inScope ? 'merged' : 'one');
        }
      })
      .catch((e) => alive && setErr(e.message || 'Could not load the borrower info.'));
    return () => { alive = false; };
  }, [appId, scopeBorrowerId]);

  // Lock the background scroll AND preserve the scroll position while the modal is
  // open; also close on Escape (so the page doesn't jump to the top on close).
  useScrollLock(onClose);

  const providerReady = pre && pre.provider && pre.provider.configured;
  const roster = (pre && pre.borrowers) || [];
  const hasMulti = roster.length > 1;
  // A merged report covers everyone on the file by definition — the per-borrower
  // checkboxes don't apply, so they're shown ticked and locked.
  const mergedMode = showUpload && uploadMode === 'merged' && hasMulti;
  const sel = selected || new Set();
  const isSel = (id) => (mergedMode ? true : sel.has(id));
  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev || []);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selBorrowers = mergedMode ? roster : roster.filter((x) => isSel(x.borrowerId));
  const selMissing = Array.from(new Set(selBorrowers.flatMap((x) => x.missing || [])));
  // A co-borrower on the file who is NOT selected: they'll get their own condition.
  const droppedCo = hasMulti && !mergedMode && roster.some((x) => x.role === 'co' && !isSel(x.borrowerId));
  // A JOINT order is only on the table for a live order covering 2+ borrowers.
  const jointMode = !showUpload && hasMulti && orderShape === 'joint';
  const refOf = (id) => String(reissueRefs[id] || '').trim();
  const setRef = (id, v) => setReissueRefs((prev) => ({ ...prev, [id]: v }));
  const fileOf = (id) => perFiles[id] || {};
  const setPerFile = (id, key, f) => setPerFiles((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: f } }));
  const perFileCount = roster.filter((b) => fileOf(b.borrowerId).xml || fileOf(b.borrowerId).pdf).length;
  // Borrowers selected for a reissue with no reference number to reissue against.
  // A JOINT reissue needs exactly ONE reference for the whole order.
  const jointJoined = jointMode && selBorrowers.length > 1;
  const needRef = requestType !== 'reissue' ? []
    : (jointJoined ? (jointRef.trim() ? [] : [{ name: 'the joint report' }]) : selBorrowers.filter((b) => !refOf(b.borrowerId)));

  // #16 — reuse a report the borrower already has on ANOTHER file (still inside the
  // 120-day window), with NO new Xactus inquiry. One click; the same report is
  // re-filed on this file's credit condition carrying its original date.
  async function reuseProfileReport(bb) {
    setErr(''); setReuseBusy(bb.borrowerId);
    try {
      const out = await api.staffCreditReuse(appId, {
        borrowerId: bb.borrowerId,
        sourceReportId: bb.profileReport && bb.profileReport.sourceReportId,
      });
      onDone(out);
    } catch (e) {
      setErr(e.message || 'Could not reuse that report.');
      setReuseBusy(null);
    }
  }

  async function runImport(kind) {
    setErr(''); setBusy(true);
    try {
      const body = { pullType, requestType, version };
      if (kind === 'live') {
        body.consent = consent;    // permissible-purpose attestation (server enforces too)
        body.borrowerIds = selBorrowers.map((x) => x.borrowerId);   // which borrowers to pull
        if (jointJoined) {
          // ONE joint order covering everybody, with ONE reference number.
          body.joint = true;
          if (requestType === 'reissue') body.jointReissueReportId = jointRef.trim();
        } else if (requestType === 'reissue') {
          // A separate order per borrower — each reissues THEIR OWN reference.
          const map = {};
          selBorrowers.forEach((b) => { if (refOf(b.borrowerId)) map[b.borrowerId] = refOf(b.borrowerId); });
          body.reissueReportIds = map;
          if (selBorrowers.length === 1) body.reissueReportId = refOf(selBorrowers[0].borrowerId);
        }
      }
      if (kind === 'upload') {
        if (uploadMode === 'separate') {
          // A separate downloaded report per borrower, imported in one action.
          const files = [];
          for (const b of roster) {
            const f = fileOf(b.borrowerId);
            if (!f.xml && !f.pdf) continue;
            files.push({
              borrowerId: b.borrowerId,
              xml: f.xml ? await readFileText(f.xml) : undefined,
              pdfBase64: f.pdf ? await fileToBase64(f.pdf) : undefined,
            });
          }
          if (!files.length) throw new Error('Choose the downloaded file for at least one borrower.');
          body.files = files;
        } else {
          if (!xmlFile && !pdfFile) throw new Error('Choose the credit data file (XML) and/or the PDF to import.');
          if (uploadMode === 'merged') {
            body.merged = true;                                   // one file, both borrowers
            body.borrowerIds = roster.map((x) => x.borrowerId);
          } else {
            if (selBorrowers.length !== 1) throw new Error('A report for one borrower — select exactly one, or switch to a merged report.');
            body.merged = false;
            body.borrowerId = selBorrowers[0].borrowerId;
          }
          if (xmlFile) body.xml = await readFileText(xmlFile);
          if (pdfFile) body.pdfBase64 = await fileToBase64(pdfFile);
        }
      }
      const out = await api.staffCreditImport(appId, body);
      // Nothing pulled (every selected borrower failed) — keep the modal open and
      // show why, rather than closing on a silent non-success.
      if (out && out.ok === false) {
        const errs = (out.results || []).filter((r) => r.ok === false).map((r) => `${r.name}: ${r.error || 'failed'}`);
        throw new Error(errs.length ? errs.join(' · ') : 'The import did not go through.');
      }
      onDone(out);
    } catch (e) {
      setErr(e.message || 'The import did not go through.');
      setBusy(false);
    }
  }

  // The primary action lives in a STICKY FOOTER so it's always reachable — the
  // body scrolls independently. The button adapts to the active mode (live pull
  // vs an uploaded file); a hint explains any disabled state so it's never a
  // dead, unexplained button.
  // A Reissue needs a reference number — EACH borrower's own. On a borrower's first
  // pull there is none, so the live button is held until their reference is entered
  // or the order is switched to Brand-new (rather than sending a reissue Xactus will
  // reject). Naming the borrower matters: reissuing the co-borrower on their own used
  // to fail with no way to see whose reference was missing.
  const reissueReady = needRef.length === 0;
  const canLive = providerReady && consent && selBorrowers.length > 0 && selBorrowers.every((x) => (x.missing || []).length === 0) && reissueReady;
  const liveLabel = requestType === 'new' ? 'Order & import' : 'Reissue & import';
  const liveLabelN = hasMulti && selBorrowers.length > 1
    ? (jointJoined ? `${liveLabel} (joint · ${selBorrowers.length})` : `${liveLabel} (${selBorrowers.length})`)
    : liveLabel;
  const uploadReady = uploadMode === 'separate'
    ? perFileCount > 0
    : !!((xmlFile || pdfFile) && (uploadMode === 'merged' ? hasMulti : selBorrowers.length === 1));
  const uploadLabel = uploadMode === 'separate'
    ? `Import ${perFileCount > 1 ? perFileCount + ' reports' : 'the report'}`
    : (uploadMode === 'merged' ? 'Import the merged report' : 'Import the file');
  const primaryLabel = busy ? 'Working…' : (showUpload ? uploadLabel : liveLabelN);
  const primaryDisabled = busy || (showUpload ? !uploadReady : !canLive);
  let footerHint = '';
  if (!busy) {
    if (showUpload) {
      if (uploadMode === 'separate') {
        if (!perFileCount) footerHint = 'Choose each borrower’s downloaded file below.';
        else if (perFileCount < roster.length) footerHint = `Only ${perFileCount} of ${roster.length} borrowers have a file — the rest keep their own credit condition, ready to import later.`;
      } else if (!xmlFile && !pdfFile) footerHint = 'Choose the downloaded data file (XML) and/or the PDF.';
      else if (uploadMode === 'one' && selBorrowers.length !== 1) footerHint = 'Tick exactly one borrower for a single-borrower report, or switch to “One merged report”.';
    }
    else if (!providerReady) footerHint = 'Live pull isn’t set up yet — use “Import a downloaded report”.';
    else if (selBorrowers.length === 0) footerHint = 'Select at least one borrower to pull.';
    else if (selMissing.length) footerHint = `Add the ${selMissing.join(', ')} to pull the selected borrower${selBorrowers.length > 1 ? 's' : ''}.`;
    else if (!consent) footerHint = 'Check the authorization box above to enable the pull.';
    else if (needRef.length) {
      footerHint = jointJoined
        ? 'Enter the joint report’s reference number, or switch to “Brand-new” for a fresh joint order.'
        : `Enter the reissue reference number for ${needRef.map((b) => b.name).join(' and ')}, or switch to “Brand-new” for a first report.`;
    }
  }

  return (
    <div className="cv-modal-back crx-back" onClick={onClose}>
      <div className="cv-modal crx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crx-modal-head">
          <div>
            <h3 className="crx-modal-title">Import credit</h3>
            <p className="crx-modal-sub">Pull a tri-merge report through the shared Xactus login.</p>
          </div>
          <button className="crx-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="crx-modal-body">
          {!pre && !err && <div className="crx-loading">Loading the borrower’s information…</div>}
          {/* Load-time failure shows here (the whole modal failed to load). An
              IMPORT failure shows in the sticky footer so it's always visible. */}
          {!pre && err && <div className="crx-alert danger">{err}</div>}

          {pre && (<>
            {/* Recipient(s) / what we transmit — one card per borrower on the file.
                With a co-borrower, both are shown and pulled by default; unchecking
                one drops it from this pull and opens its own credit condition. */}
            <section className="crx-recipient">
              <div className="crx-recip-eyebrow">{hasMulti ? 'Identities we’ll send to Xactus' : 'Identity we’ll send to Xactus'}</div>
              {roster.map((bb) => {
                const addr = bb.address || {};
                const addrLine = [addr.line1, addr.line2, [addr.city, addr.state].filter(Boolean).join(', '), addr.zip].filter(Boolean).join(' · ');
                const on = isSel(bb.borrowerId);
                return (
                  <div key={bb.borrowerId} className={'crx-recip-card' + (hasMulti && !on ? ' crx-off' : '')}>
                    <div className="crx-recip-head">
                      {hasMulti && (
                        <input type="checkbox" className="crx-recip-check" checked={on} disabled={mergedMode}
                          onChange={() => toggle(bb.borrowerId)}
                          title={mergedMode ? 'A merged report covers everyone on the file' : undefined}
                          aria-label={`Include ${bb.name} in this import`} />
                      )}
                      <span className="crx-mono" aria-hidden="true">{initials(bb.firstName, bb.lastName)}</span>
                      <div>
                        <div className="crx-recip-name">{bb.name || (bb.role === 'co' ? 'Co-borrower' : 'Borrower')}
                          {hasMulti && <span className={'crx-role-tag' + (bb.role === 'co' ? ' co' : '')}>{bb.role === 'co' ? 'Co-borrower' : 'Primary'}</span>}</div>
                        {/* The un-ticked state goes HERE, not on the name line: a long
                            name plus two tags pushed the card wider than the screen and
                            made the whole panel scroll sideways (owner-reported). */}
                        <div className={'crx-recip-eyebrow' + (hasMulti && !on ? ' crx-off' : '')}>
                          {hasMulti && !on ? 'Not in this import' : (bb.canPull ? 'Ready to pull' : 'Missing info for a live pull')}</div>
                      </div>
                    </div>
                    <div className="crx-recip-grid">
                      <div className="crx-field"><span>Date of birth</span><b>{bb.dob ? fmtDay(bb.dob) : '—'}</b></div>
                      <div className="crx-field"><span>Social Security #</span><b>{bb.ssnMasked || (bb.hasSsn ? 'on file' : '— not on file')}</b></div>
                      <div className="crx-field crx-field-wide"><span>Current address</span><b>{addrLine || '—'}</b></div>
                    </div>
                    {(bb.missing || []).length > 0 && (
                      <div className="crx-note warn">Add the {bb.missing.join(', ')} on the file before a live pull{hasMulti ? ` for ${bb.name}` : ''}. You can still import a downloaded report below.</div>
                    )}
                    {/* #16 — this borrower already has a recent report on another file.
                        Reuse it here with NO new inquiry (and no cost). */}
                    {bb.profileReport && (!hasMulti || on) && (
                      <div className="crx-note reuse" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ flex: '1 1 240px' }}>
                          {hasMulti ? bb.name + ' has' : 'This borrower has'} a credit report from{' '}
                          <b>{bb.profileReport.ageDays != null ? bb.profileReport.ageDays + ' days ago' : 'a recent file'}</b>
                          {bb.profileReport.middleScore != null ? <> (middle score <b>{bb.profileReport.middleScore}</b>)</> : null}
                          {bb.profileReport.fromLoanNumber ? <> on file <b>{bb.profileReport.fromLoanNumber}</b></> : null}. It’s still current — reuse it here, no new pull.
                        </span>
                        <button type="button" className="crx-btn ghost"
                          disabled={reuseBusy === bb.borrowerId}
                          onClick={() => reuseProfileReport(bb)}>
                          {reuseBusy === bb.borrowerId ? 'Reusing…' : 'Reuse this report'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {/* One fixed note line — it changes wording, never the card sizes, so
                  ticking a borrower off doesn't shuffle the screen around. */}
              <div className="crx-note-slot">
                {mergedMode
                  ? <div className="crx-note">A merged report covers <b>everyone on this file</b>. PILOT reads each borrower out of the one file and gives each their own scores.</div>
                  : droppedCo
                    ? <div className="crx-note">Only the ticked borrower is imported now. The other borrower gets their own <b>Credit report</b> condition so their credit is still required and can be imported separately.</div>
                    : (selMissing.length === 0
                      ? <div className="crx-note secure"><span className="crx-lock" aria-hidden="true">🔒</span> Sent securely over an encrypted connection — a tri-merge of all three bureaus{hasMulti ? ', one report per borrower' : ''}.</div>
                      : <div className="crx-note">Fill in what’s missing above for a live pull — or import a downloaded report below.</div>)}
              </div>
            </section>

            {/* Options */}
            <section className="crx-options">
              <div className="crx-opt">
                <label className="crx-opt-label">Type of pull</label>
                <Seg value={pullType} onChange={setPullType} options={[
                  { value: 'soft', label: 'Soft', sub: 'Pre-application' },
                  { value: 'hard', label: 'Hard', sub: 'Full report' },
                ]} />
                <div className="crx-opt-hint">{pullType === 'hard'
                  ? 'A hard inquiry — a full credit report that can affect the borrower’s score.'
                  : 'A soft inquiry — a pre-application check that does not affect the score.'}</div>
              </div>

              {/* With more than one borrower, Xactus takes EITHER one joint order
                  covering both (a single reference number) OR a separate order per
                  borrower (a reference each). Both are real — this is the choice. */}
              {hasMulti && !showUpload && selBorrowers.length > 1 && (
                <div className="crx-opt">
                  <label className="crx-opt-label">How to order for {selBorrowers.length} borrowers</label>
                  <Seg value={orderShape} onChange={setOrderShape} options={[
                    { value: 'joint', label: 'One joint order', sub: 'One reference #' },
                    { value: 'separate', label: 'Separate orders', sub: 'A reference # each' },
                  ]} />
                  <div className="crx-opt-hint">{orderShape === 'joint'
                    ? 'One request carrying both borrowers, and one report reference covering them both. PILOT reads each borrower out of the report and gives each their own scores.'
                    : 'One request per borrower — each is its own report with its own reference number.'}</div>
                </div>
              )}

              <div className="crx-opt">
                <label className="crx-opt-label">Order</label>
                <Seg value={requestType} onChange={setRequestType} options={[
                  { value: 'reissue', label: 'Reissue', sub: 'Existing report' },
                  { value: 'new', label: 'Brand-new', sub: 'Fresh pull' },
                ]} />
                {requestType === 'reissue' && (
                  // ONE reference box PER BORROWER. A reference points at one specific
                  // report at Xactus, so the co-borrower can never be reissued off the
                  // primary's number — that used to be the only reference sent, which
                  // made importing the co-borrower on their own impossible.
                  <div className="crx-reissue">
                    {selBorrowers.length === 0 && <div className="crx-opt-hint">Tick a borrower above to enter their reissue reference.</div>}
                    {/* A JOINT report has ONE reference number covering both borrowers. */}
                    {jointJoined ? (
                      <div className="crx-reissue-row">
                        <label className="crx-opt-label">Joint report reference #</label>
                        <input className="crx-input" value={jointRef} onChange={(e) => setJointRef(e.target.value)}
                          placeholder="Xactus joint report reference" />
                        <div className="crx-opt-hint">{pre.jointReissueReportId
                          ? 'Pre-filled from the last joint report on this file — one reference covers both borrowers.'
                          : 'One reference number for the joint report covering both borrowers. If each borrower has their own report instead, switch to “Separate orders” above.'}</div>
                      </div>
                    ) : selBorrowers.map((bb) => (
                      <div key={bb.borrowerId} className="crx-reissue-row">
                        {hasMulti && <label className="crx-opt-label">{bb.name}’s reissue reference #</label>}
                        {!hasMulti && <label className="crx-opt-label">Reissue reference #</label>}
                        <input className="crx-input" value={reissueRefs[bb.borrowerId] || ''}
                          onChange={(e) => setRef(bb.borrowerId, e.target.value)}
                          placeholder="Xactus report reference" />
                        <div className="crx-opt-hint">{bb.reissueReportId
                          ? `Pre-filled from ${hasMulti ? bb.name + '’s' : 'the'} last report on this file — change it to re-pull a different one.`
                          : `${hasMulti ? bb.name + ' has' : 'This file has'} no earlier report to reissue. Enter the reference from Xactus, or switch the order to “Brand-new”.`}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="crx-meta-row">
                <div className="crx-meta">
                  <label className="crx-opt-label">Bureaus</label>
                  <div className="crx-tri">
                    {['Equifax', 'Experian', 'TransUnion'].map((x) => (
                      <span key={x} className="crx-tri-chip"><span className="crx-tri-dot" aria-hidden="true" />{x}</span>
                    ))}
                  </div>
                </div>
                <div className="crx-meta crx-meta-ver">
                  <label className="crx-opt-label">Version</label>
                  {/* Frozen — the report interface version is fixed (owner-directed);
                      staff cannot change it. Set only via XACTUS_INTERFACE_VERSION. */}
                  <span className="crx-tri-chip crx-frozen" title="Fixed report version — cannot be changed">
                    MISMO {version} <span className="crx-lock" aria-hidden="true">🔒</span>
                  </span>
                </div>
              </div>
            </section>

            {/* Consent — arms the primary action */}
            <label className={'crx-consent' + (consent ? ' on' : '')}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span><b>{selBorrowers.length > 1 ? 'The borrowers have authorized this credit pull.' : 'The borrower has authorized this credit pull.'}</b> Permissible purpose is on file (required to pull).</span>
            </label>

            {!providerReady && (
              <div className="crx-alert warn">
                The shared Xactus login isn’t set up yet, so a live pull isn’t available. Once the company login is added in the system settings this turns on — you can import a downloaded report below in the meantime.
              </div>
            )}

            {showUpload && (
              <section className="crx-upload">
                <div className="crx-upload-title">Import a report you already downloaded from Xactus</div>

                {/* With two borrowers, say HOW the downloaded report(s) cover them:
                    one merged file for both, a file each, or just one borrower. */}
                {hasMulti && (
                  <div className="crx-upload-mode">
                    <Seg value={uploadMode} onChange={setUploadMode} options={[
                      { value: 'merged', label: 'One merged report', sub: 'Both borrowers in one file' },
                      { value: 'separate', label: 'A file for each', sub: 'Two separate reports' },
                      { value: 'one', label: 'One borrower', sub: 'Just the ticked borrower' },
                    ]} />
                    <div className="crx-opt-hint">{uploadMode === 'merged'
                      ? 'One file covering both borrowers. PILOT reads each borrower out of it, gives each their own scores, and files the one report on the one credit condition.'
                      : uploadMode === 'separate'
                        ? 'Each borrower has their own downloaded report. Pick both here and they are imported together — one credit condition, a report each.'
                        : 'A report for the ticked borrower only. The other borrower keeps their own credit condition to import later.'}</div>
                  </div>
                )}

                {uploadMode === 'separate' && hasMulti ? (
                  roster.map((bb) => (
                    <div key={bb.borrowerId} className="crx-upload-person">
                      <div className="crx-upload-person-name">{bb.name}
                        <span className={'crx-role-tag' + (bb.role === 'co' ? ' co' : '')}>{bb.role === 'co' ? 'Co-borrower' : 'Primary'}</span></div>
                      <div className="crx-upload-row"><span>Data file (XML)</span>
                        <input type="file" accept=".xml,text/xml,application/xml"
                          onChange={(e) => setPerFile(bb.borrowerId, 'xml', e.target.files[0] || null)} /></div>
                      <div className="crx-upload-row"><span>Report (PDF)</span>
                        <input type="file" accept="application/pdf,.pdf"
                          onChange={(e) => setPerFile(bb.borrowerId, 'pdf', e.target.files[0] || null)} /></div>
                    </div>
                  ))
                ) : (
                  <>
                    <div className="crx-upload-row"><span>Data file (XML)</span>
                      <input type="file" accept=".xml,text/xml,application/xml" onChange={(e) => setXmlFile(e.target.files[0] || null)} /></div>
                    <div className="crx-upload-row"><span>Report (PDF)</span>
                      <input type="file" accept="application/pdf,.pdf" onChange={(e) => setPdfFile(e.target.files[0] || null)} /></div>
                  </>
                )}
                <p className="crx-upload-hint">The data file (XML) builds the credit-details section{mergedMode ? ' and is what lets PILOT split a merged report between the two borrowers' : ''}; the PDF is filed on the loan.{mergedMode && !xmlFile && pdfFile ? ' With only the PDF, the same report is filed for both borrowers but there are no scores until a data file is imported.' : ''}</p>
              </section>
            )}
          </>)}
        </div>

        {/* Sticky footer — the primary action is ALWAYS visible + reachable,
            regardless of how far the body has scrolled. */}
        {pre && (
          <div className="crx-modal-foot">
            {err && <div className="crx-alert danger" style={{ margin: 0 }}>{err}</div>}
            {footerHint && <div className="crx-foot-hint">{footerHint}</div>}
            <div className="crx-foot-actions">
              <button className="crx-btn primary" disabled={primaryDisabled}
                onClick={() => runImport(showUpload ? 'upload' : 'live')}>{primaryLabel}</button>
              <button className="crx-btn ghost" onClick={() => setShowUpload((v) => !v)}>
                {showUpload ? 'Cancel downloaded import' : 'Import a downloaded report'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── details section ──
function CreditDetails({ report }) {
  const p = report;
  const s = p.summary || {};
  const kpis = [
    { icon: 'accounts', value: s.tradelineCount != null ? s.tradelineCount : '—', label: 'Accounts' },
    { icon: 'balance', value: money(s.totalBalance), label: 'Total balances' },
    { icon: 'payment', value: money(s.totalMonthlyPayments), label: 'Monthly' },
    { icon: 'alert', value: s.delinquentCount != null ? s.delinquentCount : '—', label: 'Delinquent', tone: (s.delinquentCount || 0) > 0 ? 'danger' : '' },
    { icon: 'flag', value: s.collectionCount != null ? s.collectionCount : '—', label: 'Collections', tone: (s.collectionCount || 0) > 0 ? 'danger' : '' },
    { icon: 'record', value: s.publicRecordCount != null ? s.publicRecordCount : '—', label: 'Public records', tone: (s.publicRecordCount || 0) > 0 ? 'danger' : '' },
    { icon: 'search', value: s.inquiryCount != null ? s.inquiryCount : '—', label: 'Inquiries' },
  ];
  return (
    <div className="crx-details">
      {p.parseError && <div className="crx-alert warn">The data file was saved, but some details couldn’t be read automatically ({p.parseError}).{p.pdfDocumentId ? ' The PDF is on the file.' : ''}</div>}

      {/* This report is ONE borrower's side of a merged (joint) report — say so, so
          the missing accounts read as "the other borrower's", not as a gap. */}
      {p.mergedSource && (
        <div className="crx-alert info">
          This is <b>{p.mergedSource.borrowerName || 'this borrower'}</b>’s side of one merged credit report covering {p.mergedSource.borrowerCount || 2} borrowers
          {(p.mergedSource.otherBorrowers || []).length ? ` (also ${p.mergedSource.otherBorrowers.join(', ')})` : ''}.
          {(p.mergedSource.sharedItems && p.mergedSource.sharedItems.liabilities)
            ? ` ${p.mergedSource.sharedItems.liabilities} joint account${p.mergedSource.sharedItems.liabilities > 1 ? 's are' : ' is'} shown on both borrowers.`
            : ''}
        </div>
      )}

      <div className="crx-kpis">
        {kpis.map((k, i) => <KpiTile key={i} icon={k.icon} tone={k.tone} value={k.value} label={k.label} />)}
      </div>

      {Array.isArray(p.liabilities) && p.liabilities.length > 0 && (
        <details className="crx-sec" open>
          <summary>Accounts / tradelines <span className="crx-count">{p.liabilities.length}</span></summary>
          <div className="crx-table-wrap">
            <table className="crx-table">
              <thead><tr><th>Creditor</th><th>Type</th><th>Status</th><th className="r">Balance</th><th className="r">Limit / high</th><th className="r">Payment</th><th className="r">Past due</th><th>Opened</th><th>Late 30/60/90</th></tr></thead>
              <tbody>
                {p.liabilities.filter(Boolean).map((l, i) => (
                  <tr key={i} className={l.isCollection ? 'crx-bad' : ((l.pastDue || 0) > 0 ? 'crx-warn' : '')}>
                    <td>{l.creditor || '—'}</td>
                    <td>{l.accountType || '—'}</td>
                    <td>{l.status || (l.open === false ? 'Closed' : l.open ? 'Open' : '—')}</td>
                    <td className="r">{money(l.balance)}</td>
                    <td className="r">{money(l.creditLimit != null ? l.creditLimit : l.highCredit)}</td>
                    <td className="r">{money(l.monthlyPayment)}</td>
                    <td className="r">{(l.pastDue || 0) > 0 ? money(l.pastDue) : '—'}</td>
                    <td>{fmtDay(l.dateOpened)}</td>
                    <td>{`${l.late30 || 0}/${l.late60 || 0}/${l.late90 || 0}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {Array.isArray(p.publicRecords) && p.publicRecords.length > 0 && (
        <details className="crx-sec">
          <summary>Public records <span className="crx-count">{p.publicRecords.length}</span></summary>
          <div className="crx-table-wrap"><table className="crx-table">
            <thead><tr><th>Type</th><th>Filed</th><th className="r">Amount</th><th>Status</th><th>Court</th></tr></thead>
            <tbody>{p.publicRecords.filter(Boolean).map((r, i) => (
              <tr key={i} className="crx-bad"><td>{r.type || '—'}</td><td>{fmtDay(r.date)}</td><td className="r">{money(r.amount)}</td><td>{r.status || '—'}</td><td>{r.court || '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}

      {Array.isArray(p.inquiries) && p.inquiries.length > 0 && (
        <details className="crx-sec">
          <summary>Inquiries <span className="crx-count">{p.inquiries.length}</span>
            {(s.hardInquiryCount || 0) > 0 && <span className="crx-muted crx-inq-note">{s.hardInquiryCount} hard</span>}
          </summary>
          <div className="crx-table-wrap"><table className="crx-table">
            <thead><tr><th>Who</th><th>Date</th><th>Bureau</th><th>Purpose</th><th>Type</th></tr></thead>
            <tbody>{p.inquiries.filter(Boolean).map((q, i) => (
              <tr key={i}>
                <td title={q.address || undefined}>{q.name || '—'}</td>
                <td>{fmtDay(q.date)}</td>
                <td>{q.bureau || '—'}</td>
                <td>{q.purpose ? <span className={'crx-inq ' + q.purpose}>{q.purpose === 'hard' ? 'Hard' : 'Soft'}</span> : '—'}</td>
                <td>{q.business || '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </details>
      )}

      {p.borrower && (
        <details className="crx-sec">
          <summary>Identity on the report</summary>
          <div className="crx-id">
            <div className="crx-field"><span>Name</span><b>{[p.borrower.firstName, p.borrower.middleName, p.borrower.lastName].filter(Boolean).join(' ') || '—'}</b></div>
            {p.borrower.dob && <div className="crx-field"><span>Date of birth</span><b>{fmtDay(p.borrower.dob)}</b></div>}
            {p.borrower.ssnLast4 && <div className="crx-field"><span>SSN</span><b>•••-••-{p.borrower.ssnLast4}</b></div>}
            {(p.borrower.addresses || []).filter(Boolean).map((a, i) => (
              <div className="crx-field crx-field-wide" key={i}><span>Address {i + 1}</span><b>{[a.street, a.city, a.state, a.zip].filter(Boolean).join(', ')}</b></div>
            ))}
            {(p.borrower.employers || []).length > 0 && <div className="crx-field crx-field-wide"><span>Employers</span><b>{p.borrower.employers.join(' · ')}</b></div>}
          </div>
        </details>
      )}
    </div>
  );
}

// The hero block (big middle score + gauge + bureau tiles) — shown at the top of
// the full-screen report overlay.
function CreditHero({ report }) {
  const band = scoreBand(report.middleScore);
  return (
    <div className={'crx-hero tone-' + band.tone}>
      <div className="crx-hero-main">
        <div className="crx-hero-score">{report.middleScore != null ? report.middleScore : '—'}</div>
        <div className="crx-hero-meta">
          <span className={'crx-band tone-' + band.tone}>{band.label}</span>
          <div className="crx-hero-lbl">Middle score</div>
          <div className="crx-gauge">
            <div className="crx-gauge-track">
              {report.middleScore != null && <span className="crx-gauge-mark" style={{ left: gaugePct(report.middleScore) + '%' }} />}
            </div>
            <div className="crx-gauge-scale"><span>300</span><span>850</span></div>
          </div>
        </div>
      </div>
      <div className="crx-hero-bureaus">
        {(report.scores || []).length
          ? report.scores.filter(Boolean).map((sc, i) => <BureauTile key={i} s={sc} />)
          : <span className="crx-muted">No numeric scores were read from the data file.</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────── the full-screen report overlay ────────
// The entire report, laid out with the whole screen (owner-directed 2026-07-23):
// opens on import and from the condition's "Open full report" button, closeable.
function CreditReportOverlay({ report, history, justImported, onClose, onDownload }) {
  // "Open PDF" DOWNLOADED the file (owner-reported 2026-08-06 about the manual
  // upload: "you only have a button open that does not preview the document — it
  // downloads it. It should be a regular preview button"). The manual-upload panel
  // was fixed first; this is the SAME class on the imported-report overlay, so it
  // reads the report inline through the same DocPreview and keeps Download as its
  // own explicit action. Local state — the overlay owns its own preview.
  const [previewDoc, setPreviewDoc] = useState(null);
  // Scroll-locked + position-preserving + Escape-to-close (see useScrollLock).
  useScrollLock(onClose);

  return (
    <div className="crx-overlay-back" onClick={onClose}>
      <div className="crx-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="crx-overlay-head">
          <div className="crx-overlay-title">
            <h3 className="crx-modal-title">Credit report</h3>
            <p className="crx-modal-sub">
              {report.pullType === 'hard' ? 'Hard pull' : 'Soft pull'} · {report.requestType === 'new' ? 'new order' : 'reissue'}
              {report.reportDate ? ` · dated ${fmtDay(report.reportDate)}` : ''} · imported {fmtWhen(report.pulledAt)}
              {report.source === 'upload' ? ' · from an uploaded file' : ''}
            </p>
          </div>
          <div className="crx-overlay-tools">
            {report.pdfDocumentId && <button className="crx-btn ghost sm" onClick={() => setPreviewDoc({ id: report.pdfDocumentId, filename: 'credit-report.pdf', content_type: 'application/pdf' })}>Preview</button>}
            {report.pdfDocumentId && <button className="crx-btn ghost sm" onClick={() => onDownload(report.pdfDocumentId, 'credit-report.pdf')}>Download PDF</button>}
            {report.xmlDocumentId && <button className="crx-btn ghost sm" onClick={() => onDownload(report.xmlDocumentId, 'credit-report.xml')}>Download data (XML)</button>}
            <button className="crx-x" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <div className="crx-overlay-body">
          {justImported && <div className="crx-alert ok" style={{ marginTop: 0 }}>Credit report imported successfully ✓</div>}
          <CreditHero report={report} />
          <CreditDetails report={report} />
          {Array.isArray(history) && history.length > 1 && (
            <details className="crx-sec" style={{ marginTop: 12 }}>
              <summary>Import history <span className="crx-count">{history.length}</span></summary>
              <div className="crx-table-wrap"><table className="crx-table">
                <thead><tr><th>When</th><th>Type</th><th>Order</th><th className="r">Middle</th><th>Source</th></tr></thead>
                <tbody>{history.filter(Boolean).map((h) => (
                  <tr key={h.id}><td>{fmtWhen(h.pulledAt)}</td><td>{h.pullType === 'hard' ? 'Hard' : 'Soft'}</td><td>{h.requestType === 'new' ? 'New' : 'Reissue'}</td><td className="r">{h.middleScore != null ? h.middleScore : '—'}</td><td>{h.source === 'upload' ? 'uploaded' : 'pulled'}</td></tr>
                ))}</tbody>
              </table></div>
            </details>
          )}
        </div>
      </div>
      {previewDoc && (
        <DocPreview
          title="Credit report"
          filename={previewDoc.filename}
          contentType={previewDoc.content_type}
          load={() => api.staffDownloadDoc(previewDoc.id)}
          onDownload={() => onDownload(previewDoc.id, previewDoc.filename)}
          onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}

// ───────────────────────── credit report from ANOTHER source + the waiver ────
/**
 * The second way a credit condition gets satisfied (owner-directed 2026-08-03):
 * the borrower already has a current report from somewhere else and nobody wants
 * to re-pull it (a fresh inquiry, at cost, for a report we already hold). So:
 * upload the PDF onto this condition, get it accepted, and request an exception
 * an admin approves — then the condition can be signed off with no import.
 *
 * The IMPORT rule above is untouched and is still the default. Both halves are
 * required before the sign-off gate lets go: an ACCEPTED report here AND an
 * APPROVED exception. The panel says which half is still outstanding rather than
 * leaving anyone to guess.
 *
 * The PDF rides the ORDINARY staff document door, so it dedupes, reopens the
 * condition's evidence, pushes the condition's status to ClickUp, mirrors to
 * SharePoint and — once accepted — ships in the TPR export, exactly like every
 * other document on the file.
 */
const WAIVER_REASON_ORDER = ['report_from_elsewhere', 'avoid_new_inquiry', 'vendor_unavailable', 'other'];

function ExternalCreditPanel({ appId, itemId, scopeKind, onChanged, onDownload, showFlash }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('report_from_elsewhere');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(null);   // doc being previewed inline

  const q = itemId ? { itemId } : { scope: scopeKind === 'co' ? 'co' : 'primary' };
  const load = useCallback(() => api.creditWaiverGet(appId, q)
    .then(setState)
    .catch(() => setState(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appId, itemId, scopeKind]);
  useEffect(() => { load(); }, [load]);

  const docs = (state && state.documents) || [];
  const waiver = state && state.waiver;
  const exception = state && state.exception;
  const reasons = (state && state.reasons) || {};
  const accepted = docs.filter((d) => d.review_status === 'accepted');

  // WHICH condition the report is filed on. Never guess: a document uploaded with
  // no condition would land loose on the file, and the waiver — which is keyed on
  // the condition — would never see it.
  const targetItemId = (state && state.itemId) || itemId || null;

  async function upload(file) {
    if (!file) return;
    if (!targetItemId) { setErr('This credit condition could not be identified — reload the page and try again.'); return; }
    setErr(''); setBusy(true);
    try {
      const dataBase64 = await fileToBase64(file);
      await api.staffUploadAppDoc(appId, {
        filename: file.name, contentType: file.type || 'application/pdf', dataBase64,
        checklistItemId: targetItemId,
        slot: 'Credit report (uploaded)',
      });
      await load();
      showFlash && showFlash('Credit report PDF uploaded ✓ — accept it, then request an exception if you are not importing credit.', 'ok');
      onChanged && onChanged();
    } catch (e) { setErr(e.message || 'The upload did not go through.'); }
    setBusy(false);
  }

  async function review(doc, action) {
    setErr('');
    let why = '';
    if (action === 'reject') {
      why = window.prompt('Why is this credit report being rejected? The reason is recorded on the file.') || '';
      if (!why.trim()) return;
    }
    setBusy(true);
    try {
      await api.staffReviewDoc(doc.id, action, why.trim() || undefined);
      await load();
      onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Could not update the document.'); }
    setBusy(false);
  }

  // Permanent delete — for a document uploaded by mistake. Removes it for good
  // (bytes + row) and keeps it out of SharePoint, exactly like the file screen's
  // own delete. Distinct from Reject, which keeps a rejected copy on the file.
  async function del(doc) {
    if (!(await askConfirm(`Permanently delete "${doc.filename || 'this credit report'}"?\n\nThis removes it for good and it will NOT be synced to SharePoint. Use this only for a document uploaded by mistake.`))) return;
    setErr(''); setBusy(true);
    try {
      await api.staffDeleteDoc(doc.id);
      if (preview && preview.id === doc.id) setPreview(null);
      await load();
      onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Could not delete the document.'); }
    setBusy(false);
  }

  async function requestException() {
    setErr('');
    if (!note.trim()) { setErr('Add a short note saying where the credit report came from — an admin reads it.'); return; }
    setBusy(true);
    try {
      await api.creditWaiverRequest(appId, {
        reason, note: note.trim(), itemId: targetItemId,
        scope: scopeKind === 'co' ? 'co' : 'primary',
      });
      setAsking(false); setNote('');
      await load();
      showFlash && showFlash('Exception requested ✓ — an admin approves it on the Exceptions screen, and then this condition can be signed off without importing credit.', 'ok');
      onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Could not request the exception.'); }
    setBusy(false);
  }

  async function withdraw() {
    if (!(await askConfirm('Withdraw the exception request? The credit condition goes back to needing an imported report.'))) return;
    setErr(''); setBusy(true);
    try {
      await api.creditWaiverRemove(appId, { itemId: targetItemId, scope: scopeKind === 'co' ? 'co' : 'primary' });
      await load();
      onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Could not withdraw the request.'); }
    setBusy(false);
  }

  // No credit condition resolved (a file that somehow carries none) — render nothing
  // rather than a panel whose buttons could not work.
  if (state && !state.itemId) return null;

  const status = waiver && waiver.exceptionStatus;
  const effective = !!(waiver && waiver.effective);

  return (
    <section className="crx-ext">
      <div className="crx-ext-head">
        <div>
          <div className="crx-ext-title">Credit report from another source</div>
          <div className="crx-ext-sub">
            Got the report somewhere else and not re-pulling it? Upload the PDF here, accept it, then request an
            exception — an admin approves it and this condition can be signed off with no credit imported.
          </div>
        </div>
        <label className={'crx-btn ghost sm' + (busy || !targetItemId ? ' crx-disabled' : '')}>
          {busy ? 'Working…' : '⬆ Upload credit report PDF'}
          <input type="file" accept="application/pdf,.pdf" style={{ display: 'none' }} disabled={busy || !targetItemId}
            onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; upload(f); }} />
        </label>
      </div>

      {err && <div className="crx-alert danger">{err}</div>}

      {docs.length === 0 ? (
        <div className="crx-ext-empty">No uploaded credit report on this condition yet.</div>
      ) : (
        <div className="crx-ext-docs">
          {docs.map((d) => (
            <div className="crx-ext-doc" key={d.id}>
              <span className="crx-ext-doc-name" title={d.filename}>{d.filename}</span>
              <span className={'crx-pill crx-rev-' + d.review_status}>{d.review_status}</span>
              <button className="crx-btn ghost sm" onClick={() => setPreview(d)}>Preview</button>
              <button className="crx-btn ghost sm" onClick={() => onDownload(d.id, d.filename)}>Download</button>
              {d.review_status !== 'accepted' && (
                <button className="crx-btn ghost sm" disabled={busy} onClick={() => review(d, 'accept')}>Accept</button>
              )}
              {d.review_status !== 'rejected' && (
                <button className="crx-btn ghost sm" disabled={busy} onClick={() => review(d, 'reject')}>Reject</button>
              )}
              <button className="crx-btn ghost sm danger" disabled={busy} onClick={() => del(d)}>Delete</button>
            </div>
          ))}
          <div className="crx-ext-note">
            An accepted report is what goes out in the TPR export and the SharePoint sync — a report nobody
            has accepted never leaves the building.
          </div>
        </div>
      )}

      {/* The exception itself. */}
      {waiver ? (
        <div className={'crx-alert ' + (effective ? 'ok' : status === 'denied' ? 'danger' : 'warn')}>
          <b>
            {effective ? 'Exception approved — this condition can be signed off without importing credit.'
              : status === 'approved' ? 'Exception approved — waiting on the uploaded report to be accepted.'
              : status === 'denied' ? 'Exception denied.'
              : status === 'withdrawn' ? 'Exception withdrawn.'
              : 'Exception requested — waiting for an admin to approve it.'}
          </b>
          {exception && exception.exception_seq ? <span className="crx-muted"> · EX-{exception.exception_seq}</span> : null}
          <div className="crx-ext-why">
            {reasons[waiver.reason] || waiver.reason}{waiver.note ? ` — ${waiver.note}` : ''}
          </div>
          {exception && exception.decision_note ? <div className="crx-ext-why">Decision: {exception.decision_note}</div> : null}
          {!effective && status === 'approved' && !accepted.length && (
            <div className="crx-ext-why">Accept the uploaded credit report above and this condition is ready to sign off.</div>
          )}
          <div style={{ marginTop: 6 }}>
            <button className="crx-btn ghost sm" disabled={busy} onClick={withdraw}>Withdraw the request</button>
          </div>
        </div>
      ) : asking ? (
        <div className="crx-ext-ask">
          <label className="crx-opt-label">Why is credit not being imported here?</label>
          <select className="crx-input" value={reason} onChange={(e) => setReason(e.target.value)}>
            {WAIVER_REASON_ORDER.filter((k) => reasons[k]).map((k) => <option key={k} value={k}>{reasons[k]}</option>)}
          </select>
          <label className="crx-opt-label" style={{ marginTop: 8 }}>Where did this report come from?</label>
          <textarea className="crx-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. The borrower's broker pulled a tri-merge on 12 May and sent us the PDF — it is 3 weeks old and we are not re-pulling." />
          <div className="crx-foot-actions" style={{ marginTop: 8 }}>
            <button className="crx-btn primary sm" disabled={busy} onClick={requestException}>
              {busy ? 'Working…' : 'Request the exception'}
            </button>
            <button className="crx-btn ghost sm" disabled={busy} onClick={() => { setAsking(false); setErr(''); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="crx-ext-actions">
          <button className="crx-btn ghost sm" disabled={busy || !docs.length}
            title={docs.length ? undefined : 'Upload the credit report PDF first — the exception is a request to sign off on that report.'}
            onClick={() => setAsking(true)}>
            Request an exception (sign off without importing credit)
          </button>
          {!docs.length && <span className="crx-muted small">Upload the PDF first.</span>}
        </div>
      )}

      {preview && (
        <DocPreview
          title="Credit report"
          filename={preview.filename}
          contentType={preview.content_type}
          load={() => api.staffDownloadDoc(preview.id)}
          onDownload={() => onDownload(preview.id, preview.filename)}
          onClose={() => setPreview(null)} />
      )}
    </section>
  );
}

// One compact score tile for the condition summary (primary / co-borrower / higher).
function ScoreCell({ value, label, tone, emphasis }) {
  const band = scoreBand(value);
  return (
    <div className={'crx-scorecell' + (emphasis ? ' emphasis' : '') + ' tone-' + (tone || band.tone)}>
      <div className="crx-scorecell-num">{value != null ? value : '—'}</div>
      <div className="crx-scorecell-lbl">{label}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────── the condition surface ───
/**
 * `fieldKey` is the condition's own marker. A file can carry TWO credit conditions —
 * the file-level one and a co-borrower's own (field_key 'cob_credit') — and both used
 * to render this whole section for the WHOLE file, so the same scores, warnings and
 * buttons appeared twice (owner-reported 2026-07-27). The co-borrower's condition now
 * shows THEIR report, their history, their last attempt, and imports for them alone.
 */
export function CreditCondition({ appId, canPull, onChanged, fieldKey, itemId }) {
  const [data, setData] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [justImported, setJustImported] = useState(false);
  const [flash, setFlash] = useState('');
  const [flashTone, setFlashTone] = useState('ok');
  const scopeKind = fieldKey === 'cob_credit' ? 'co' : 'file';

  const loadCredit = useCallback(() => {
    return api.staffCredit(appId, scopeKind).then(setData).catch(() => setData({ hasReport: false, provider: {}, report: null, history: [], borrowers: null }));
  }, [appId, scopeKind]);

  useEffect(() => { loadCredit(); }, [loadCredit]);

  const report = data && data.report;
  const provider = (data && data.provider) || {};
  // Prefer the server's real permission (pull_credit) once loaded; fall back to
  // the capability prop for the brief moment before the fetch returns.
  const canImport = data && typeof data.canImport === 'boolean' ? data.canImport : canPull;

  const showFlash = (msg, tone) => {
    setFlashTone(tone || 'ok'); setFlash(msg);
    window.setTimeout(() => setFlash(''), 8000);
  };

  const onImported = (out) => {
    setShowModal(false);
    // #16 — a report reused from the borrower's profile (no new inquiry).
    if (out && out.reused) {
      const bits = [];
      if (out.ageDays != null) bits.push(`dated ${out.ageDays} days ago`);
      if (out.middleScore != null) bits.push(`middle score ${out.middleScore}`);
      if (out.ficoWritten != null) bits.push(`FICO set to ${out.ficoWritten}`);
      const tone = (out.ficoMismatch || out.ficoUnverified) ? 'warn' : 'ok';
      if (out.ficoMismatch) bits.push('FICO not auto-set — the report named a different person');
      if (out.ficoUnverified) bits.push('identity not confirmed by SSN (no SSN on file) — add the borrower’s SSN to verify');
      showFlash('Reused the borrower’s existing credit report ✓ — no new pull' + (bits.length ? ' — ' + bits.join(' · ') : ''), tone);
      setJustImported(true);
      loadCredit().then(() => setShowOverlay(true));
      if (onChanged) onChanged();
      return;
    }
    const results = (out && Array.isArray(out.results)) ? out.results : [];
    // Three outcomes per borrower:
    //   withData — the report parsed (scores/tradelines): a real, full report.
    //   pdfOnly  — no readable data BUT a PDF was filed (a PDF-only upload, or a
    //              live pull that returned a PDF but unreadable data): a real
    //              artifact, just no scores — NOT a failure.
    //   failed   — nothing usable (no data, no PDF): a true failure.
    const withData = results.filter((r) => r.ok !== false && !r.parseError);
    const pdfOnly = results.filter((r) => r.ok !== false && r.parseError && r.hasPdf);
    const failed = results.filter((r) => r.ok === false || (r.parseError && !r.hasPdf));
    const multi = results.length > 1;
    const isUpload = !!(out && out.source === 'upload');

    const mergedOut = out && out.merged;
    if (withData.length > 0) {
      // SUCCESS — confirm it and auto-open the full report on the whole screen.
      const bits = [];
      if (multi) {
        withData.forEach((r) => bits.push(`${r.name}: ${r.middleScore != null ? 'middle ' + r.middleScore : 'no score'}`));
        results.filter((r) => r.ok === false || r.parseError).forEach((r) => bits.push(`${r.name}: ${r.error || r.parseError || 'not read'}`));
      } else {
        if (out.middleScore != null) bits.push(`middle score ${out.middleScore}`);
        if (out.ficoWritten != null) bits.push(`FICO set to ${out.ficoWritten}`);
        if (out.ficoMismatch) bits.push('FICO not auto-set — the report named a different person');
        if (out.ficoUnverified) bits.push('identity not confirmed by SSN (no SSN on file) — add the borrower’s SSN to verify');
      }
      // A merged report is one document read for several people — say who it covered,
      // and name anyone it did NOT (never let that pass silently).
      if (mergedOut && mergedOut.unmatchedInReport && mergedOut.unmatchedInReport.length) {
        bits.push(`the report also covered ${mergedOut.unmatchedInReport.join(', ')}, who ${mergedOut.unmatchedInReport.length > 1 ? 'are' : 'is'} not on this file`);
      }
      if (mergedOut && mergedOut.unmatchedOnFile && mergedOut.unmatchedOnFile.length) {
        bits.push(`${mergedOut.unmatchedOnFile.join(', ')} was not in this report — import theirs separately`);
      }
      if (out.coConditionOpened) bits.push('opened a separate credit condition for the co-borrower');
      if (out.coConditionClosed) bits.push('both borrowers are now on the one credit condition');
      const tone = (failed.length || pdfOnly.length || out.ficoMismatch || out.ficoUnverified
        || (mergedOut && ((mergedOut.unmatchedInReport || []).length || (mergedOut.unmatchedOnFile || []).length))) ? 'warn' : 'ok';
      if (out.joint && out.joint.reference) bits.push(`joint report ${out.joint.reference}`);
      const msg = out.importMode === 'joint'
        ? `Ordered ONE joint report for ${withData.length} borrowers ✓`
        : out.importMode === 'merged' && multi
          ? `Imported one merged report for ${withData.length} borrowers ✓`
        : out.importMode === 'separate'
          ? `Imported a separate report for ${withData.length} of ${results.length} borrowers ✓`
          : (multi ? `Imported credit for ${withData.length} of ${results.length} borrowers ✓` : 'Credit report imported successfully ✓');
      showFlash(msg + (bits.length ? ' — ' + bits.join(' · ') : ''), tone);
      setJustImported(true);
      loadCredit().then(() => setShowOverlay(true));
    } else if (pdfOnly.length > 0) {
      // A PDF was filed, but the data file couldn't be read → no scores. It's a real
      // artifact (surfaced on the condition), not a failure; don't open an empty report.
      showFlash('Credit report PDF filed ✓ — but the data file (XML) couldn’t be read, so there are no scores yet. The PDF is on the condition below. Import the XML data file too (or re-pull) to get the scores.', 'warn');
      loadCredit();
    } else {
      // Nothing usable — no data and no PDF. Say what to do next, worded for how the
      // import was attempted (an upload never touched the Xactus connection).
      const reason = (failed[0] && (failed[0].error || failed[0].parseError)) || (out && out.parseError) || 'no credit data was recognized';
      const advice = isUpload
        ? 'The file couldn’t be read as a credit report — double-check you picked the right data file (XML) and/or PDF from Xactus.'
        : 'This usually means the Xactus connection needs attention (double-check the web address, or run the “Test connection” on the API Health page). You can also import a report you downloaded from Xactus.';
      showFlash(`The import didn’t produce a report — ${reason}. ${advice}`, 'warn');
      loadCredit();
    }
    if (onChanged) onChanged();
  };

  const download = async (docId, fallback) => {
    try { const { blob, filename } = await api.staffDownloadDoc(docId); saveBlob(blob, filename || fallback); }
    catch (e) { showFlash('Download failed: ' + (e.message || 'please try again'), 'warn'); }
  };

  // Stable close handlers (so the scroll-lock effect doesn't churn on re-render);
  // closing the overlay also clears the just-imported success banner.
  const closeOverlay = useCallback(() => { setShowOverlay(false); setJustImported(false); }, []);
  const closeModal = useCallback(() => setShowModal(false), []);

  const borrowers = (data && data.borrowers) || null;
  const scope = (data && data.scope) || null;
  // A condition scoped to ONE borrower (the co-borrower's own) shows only their
  // score — the file-level condition keeps the whole roster + the higher-of-two.
  const scoped = !!(scope && scope.borrowerId);
  const scopedBorrower = scoped && borrowers
    ? (borrowers.coBorrower && borrowers.coBorrower.borrowerId === scope.borrowerId ? borrowers.coBorrower : borrowers.primary)
    : null;
  const hasCo = !scoped && !!(borrowers && borrowers.hasCoBorrower);
  const primaryScore = borrowers && borrowers.primary ? borrowers.primary.middleScore : (report ? report.middleScore : null);
  // A borrower's summary sub-label: pulled-with-score, pulled-but-no-score (a
  // thin/no-hit file — NOT "not pulled"), or genuinely not pulled yet.
  const cellSuffix = (b) => (!b || !b.hasReport) ? ' · not pulled yet' : (b.middleScore != null ? ' · middle' : ' · no score');
  const who = scoped && scope.name ? scope.name : null;

  return (
    <div className="crx-wrap">
      <div className="crx-bar">
        {canImport
          ? <button className="crx-btn primary sm" onClick={() => setShowModal(true)}>
            {report ? '↻ Import again' : '⬇ Import credit'}{who ? ` for ${who}` : ''}</button>
          : !report && <span className="crx-muted">The loan officer or a processor can import the credit report here.</span>}
        {canImport && !provider.configured && <span className="crx-pill" title="The shared Xactus login is not set yet">Live pull: not set up</span>}
        <span className="crx-bar-spacer" />
        {report && report.pdfDocumentId && (
          <button className="crx-btn ghost sm" onClick={() => download(report.pdfDocumentId, 'credit-report.pdf')}>Open / download PDF</button>
        )}
      </div>

      {flash && <div className={'crx-alert ' + (flashTone === 'warn' ? 'warn' : 'ok')}>{flash}</div>}

      {/* A most-recent attempt that FAILED (no readable data) is surfaced here so
          staff know it didn't work — WITHOUT hiding the good report already on file.
          Skipped when the only thing on file is a filed-PDF attempt (the PDF card
          below explains that case). Worded for how it was attempted (an upload never
          touched the Xactus connection). */}
      {data && data.lastAttempt && (report || !data.lastAttempt.pdfDocumentId) && (
        <div className="crx-alert warn">
          Your last credit {data.lastAttempt.source === 'upload' ? 'import' : 'pull'}{data.lastAttempt.pulledAt ? ' on ' + fmtWhen(data.lastAttempt.pulledAt) : ''} didn’t return a readable report{data.lastAttempt.reason ? ` — ${data.lastAttempt.reason}` : ''}.{report ? ' The report below is the last good one on file.' : ''} {data.lastAttempt.source === 'upload'
            ? 'Check the file you selected, or import the data file (XML) too.'
            : 'Check the Xactus connection (or run the “Test connection” on the API Health page), or import a report you downloaded from Xactus.'}
        </div>
      )}

      {/* Compact summary that ALWAYS sits at the bottom of the condition: the
          middle score (and, with a co-borrower, the higher-of-two that prices the
          deal) + a button to open the whole report on the full screen. */}
      {report ? (
        <div className="crx-cond-summary">
          <div className="crx-scoreline">
            <ScoreCell value={scoped ? (scopedBorrower ? scopedBorrower.middleScore : report.middleScore) : primaryScore}
              label={scoped
                ? `${(scopedBorrower && scopedBorrower.name) || who || 'Borrower'}${cellSuffix(scopedBorrower)}`
                : (hasCo && borrowers.primary
                  ? `${borrowers.primary.name}${cellSuffix(borrowers.primary)}`
                  : (primaryScore != null ? 'Middle score' : 'Middle score · no score'))}
              emphasis={!hasCo} />
            {hasCo && borrowers.coBorrower && (
              <ScoreCell value={borrowers.coBorrower.middleScore}
                label={borrowers.coBorrower.name + cellSuffix(borrowers.coBorrower)} />
            )}
            {hasCo && (
              <ScoreCell value={borrowers.higher}
                label={borrowers.higherReady ? 'Higher — prices the deal' : 'Higher so far · co-borrower pending'}
                emphasis={borrowers.higherReady} />
            )}
          </div>

          <div className="crx-sub">
            {report.pullType === 'hard' ? 'Hard pull' : 'Soft pull'} · {report.requestType === 'new' ? 'new order' : 'reissue'}
            {report.reportDate ? ` · dated ${fmtDay(report.reportDate)}` : ''} · imported {fmtWhen(report.pulledAt)}
            {report.source === 'upload' ? ' · from an uploaded file' : ''}
            {report.vendorReportId ? ` · ref ${report.vendorReportId}` : ''}
          </div>

          <div className="crx-summary-actions">
            <button className="crx-btn primary sm" onClick={() => setShowOverlay(true)}>⛶ Open full credit report</button>
            {report.pdfDocumentId
              ? <button className="crx-btn ghost sm" onClick={() => download(report.pdfDocumentId, 'credit-report.pdf')}>📄 Open credit report PDF</button>
              : <span className="crx-muted" title="This report had no PDF in the response">No PDF on this report</span>}
            {report.xmlDocumentId && <button className="crx-btn ghost sm" onClick={() => download(report.xmlDocumentId, 'credit-report.xml')}>Data file (XML)</button>}
          </div>
        </div>
      ) : (data && data.lastAttempt && data.lastAttempt.pdfDocumentId) ? (
        // A PDF was filed but the data file couldn't be read (no scores) — keep the
        // PDF reachable instead of orphaning it behind the empty state.
        <div className="crx-cond-summary">
          <div className="crx-sub">
            A credit report PDF is filed{data.lastAttempt.pulledAt ? ' (' + fmtWhen(data.lastAttempt.pulledAt) + ')' : ''}, but the data file couldn’t be read automatically{data.lastAttempt.reason ? ` — ${data.lastAttempt.reason}` : ''}, so there are no scores yet. Import the data file (XML) too — or re-pull — to read the scores.
          </div>
          <div className="crx-summary-actions">
            <button className="crx-btn ghost sm" onClick={() => download(data.lastAttempt.pdfDocumentId, 'credit-report.pdf')}>📄 Open credit report PDF</button>
            {data.lastAttempt.xmlDocumentId && <button className="crx-btn ghost sm" onClick={() => download(data.lastAttempt.xmlDocumentId, 'credit-report.xml')}>Data file (XML)</button>}
          </div>
        </div>
      ) : (
        <div className="crx-empty">No credit report imported {who ? `for ${who} ` : ''}yet. Click <b>Import credit</b> to pull a tri-merge report{hasCo ? ' for both borrowers (or import one merged report covering both)' : ''} or import one you downloaded.</div>
      )}

      {/* The second, exception-backed way this condition clears — a report from
          another source. Always rendered: it is also where an already-uploaded
          report and an in-flight exception are seen. */}
      <ExternalCreditPanel appId={appId} itemId={itemId} scopeKind={scopeKind}
        onChanged={onChanged} onDownload={download} showFlash={showFlash} />

      {showModal && (
        <CreditImportModal appId={appId} onClose={closeModal} onDone={onImported}
          scopeBorrowerId={scoped ? scope.borrowerId : null} />
      )}
      {showOverlay && report && (
        <CreditReportOverlay report={report} history={data && data.history} justImported={justImported} onClose={closeOverlay} onDownload={download} />
      )}
    </div>
  );
}

export default CreditCondition;
