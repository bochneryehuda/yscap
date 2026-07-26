import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';

/**
 * Pipeline V2 (owner-directed 2026-07-26) — staff-only "Pipeline (shadow)" console.
 *
 * A read-only window into the new evidence-first pipeline while it runs in SHADOW beside the
 * current path: which document vendors are reachable (health), and — per document the new line
 * processed — the controlled stages it completed, which reader it chose and why, and the cost.
 * Nothing here changes a loan, a borrower surface, or an underwriting decision; it's the evidence
 * used to compare V2 vs V1 before promoting a document family. Everything is fed by
 * GET /api/admin/pipeline/health and /shadow[/:jobId] (staff-only, read-only).
 */

function fmtDate(v) {
  if (!v) return '';
  try { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(); } catch (_) { return String(v); }
}
function money(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n === 0) return '$0';
  return `$${(n / 100).toFixed(2)}`;
}

const STAGE_LABEL = {
  intake: 'Intake', packet_control: 'Packet control', ocr_layout: 'Reading (OCR)',
  classification: 'Sorting', extraction: 'Extract', grounding: 'Grounding',
};

// How much we trust each fact the pipeline read (Stage 5 "canonical truth").
const EVIDENCE_STATUS = {
  verified: { label: 'Verified', cls: 'pill-ok' },
  partially_verified: { label: 'Partly verified', cls: 'pill-warn' },
  unverified: { label: 'Not checked', cls: 'pill-warn' },
  contradicted: { label: 'Disagreed', cls: 'pill-bad' },
  superseded: { label: 'Replaced', cls: 'pill-muted' },
  manual_verified: { label: 'Confirmed by a person', cls: 'pill-ok' },
};

export default function StaffPipelineShadow() {
  const [health, setHealth] = useState(null);
  const [flags, setFlags] = useState(null);
  const [summary, setSummary] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [detail, setDetail] = useState(null);
  const [openId, setOpenId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const [h, s] = await Promise.all([api.pipelineHealth(), api.pipelineShadow()]);
      setHealth((h && h.providers) || []);
      setFlags((h && h.flags) || (s && s.flags) || null);
      setSummary((s && s.summary) || null);
      setJobs((s && s.jobs) || []);
    } catch (e) { setErr((e && e.message) || 'Failed to load.'); setJobs([]); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openJob = useCallback(async (jobId) => {
    if (openId === jobId) { setOpenId(''); setDetail(null); return; }
    setOpenId(jobId); setDetail(null);
    try { setDetail(await api.pipelineShadowJob(jobId)); } catch (_) { setDetail({ error: true }); }
  }, [openId]);

  const shadowOn = !!(flags && (flags.v2Shadow || flags.v2Enabled));

  return (
    <div className="wrap" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <h1>Pipeline (shadow)</h1>
        <button className="btn" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <p className="muted" style={{ marginTop: -6 }}>
        A read-only look at the new document pipeline running quietly beside the current one. Nothing here
        is shown to borrowers and no loan decision is affected — it's here to compare the new path with the
        current one before turning any document type on for real.
      </p>

      {err && <div className="banner banner-error" role="alert">{err}</div>}

      {/* Status banner */}
      <div className={`card ${shadowOn ? 'card-ok' : ''}`} style={{ marginBottom: 16 }}>
        <strong>{shadowOn ? 'Shadow mode is ON' : 'Shadow mode is OFF'}</strong>
        {flags && (
          <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
            Exposed pipeline: <b>V1</b> <span className="muted">(the new pipeline runs in shadow only)</span>
            {' · '}Families in shadow: <b>{(flags.v2Families && flags.v2Families.length) ? flags.v2Families.join(', ') : '(none)'}</b>
            {' · '}Background worker: <b>{flags.workerEnabled ? 'on' : 'off'}</b>
          </div>
        )}
        {!shadowOn && <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          To try it, set the shadow switches in the hosting dashboard (nothing borrower- or staff-facing changes).
        </div>}
      </div>

      {/* Vendor health */}
      <h2 style={{ fontSize: 16 }}>Vendor connections</h2>
      <div className="card" style={{ marginBottom: 20, padding: 0 }}>
        <table className="tbl">
          <thead><tr><th>Vendor</th><th>Role</th><th>Model</th><th>Key entered</th><th>Reachable</th><th>Detail</th></tr></thead>
          <tbody>
            {(health || []).map((p) => (
              <tr key={`${p.provider}/${p.service}`}>
                <td>{p.name || `${p.provider}/${p.service}`}</td>
                <td className="muted">{p.role || ''}</td>
                <td className="muted">{p.model || '—'}</td>
                <td>{p.configured ? '✓' : '—'}</td>
                <td><span className={p.ok ? 'pill pill-ok' : 'pill pill-warn'}>{p.ok ? 'reachable' : 'no'}</span></td>
                <td className="muted" style={{ fontSize: 12 }}>{p.detail || ''}</td>
              </tr>
            ))}
            {(!health || health.length === 0) && <tr><td colSpan={6} className="muted">No vendors reported.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Shadow jobs */}
      <h2 style={{ fontSize: 16 }}>
        Documents on the new line
        {summary && <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> — {summary.total} total</span>}
      </h2>
      <div className="card" style={{ padding: 0 }}>
        <table className="tbl">
          <thead><tr><th>When</th><th>Type</th><th>Status</th><th>Steps done</th><th>Reader chosen</th><th>Cost</th><th></th></tr></thead>
          <tbody>
            {(jobs || []).map((j) => (
              <React.Fragment key={j.id}>
                <tr>
                  <td className="muted" style={{ fontSize: 12 }}>{fmtDate(j.createdAt)}</td>
                  <td>{j.family || '—'}</td>
                  <td>{j.status}</td>
                  <td>{j.stageCompleted}/{j.stageTotal}</td>
                  <td>{j.route ? `${j.route.provider}${j.route.challenger ? ` (+${j.route.challenger})` : ''}` : '—'}</td>
                  <td>{money(j.costCents)}</td>
                  <td><button className="btn btn-sm" onClick={() => openJob(j.id)}>{openId === j.id ? 'Hide' : 'View'}</button></td>
                </tr>
                {openId === j.id && (
                  <tr><td colSpan={7} style={{ background: 'var(--paper, #f6f3ec)' }}>
                    {!detail && <span className="muted">Loading…</span>}
                    {detail && detail.error && <span className="muted">Could not load this document’s detail.</span>}
                    {detail && !detail.error && (
                      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '6px 2px' }}>
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>Steps</div>
                          {(detail.stages || []).map((s, i) => (
                            <div key={i} className="muted" style={{ fontSize: 13 }}>
                              <b>{STAGE_LABEL[s.stage] || s.stage}</b>: {s.status}
                            </div>
                          ))}
                          {(!detail.stages || detail.stages.length === 0) && <div className="muted">No steps recorded yet.</div>}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>Reader choice</div>
                          {(detail.routes || []).map((r, i) => (
                            <div key={i} className="muted" style={{ fontSize: 13, maxWidth: 480 }}>
                              <b>{r.provider}{r.service ? ` · ${r.service}` : ''}</b>
                              {r.challengerProvider ? ` (backup: ${r.challengerProvider})` : ''}
                              {' — '}{r.reason || 'no reason recorded'}
                              <div>Outcome: {r.outcome} · latency {r.latencyMs ?? 0} ms · cost {money(r.costCents)}{r.confidence != null ? ` · confidence ${r.confidence}` : ''}</div>
                            </div>
                          ))}
                          {(!detail.routes || detail.routes.length === 0) && <div className="muted">No reader choice recorded yet.</div>}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>What we read</div>
                          {(detail.evidence || []).map((ev, i) => {
                            const s = EVIDENCE_STATUS[ev.status] || { label: ev.status, cls: 'pill-muted' };
                            return (
                              <div key={i} className="muted" style={{ fontSize: 13, maxWidth: 480 }}>
                                <b>{ev.fieldLabel || ev.fieldKey}</b>: {ev.valueText || '—'}
                                {' '}<span className={`pill ${s.cls}`}>{s.label}</span>
                                {ev.reason ? <span> — {ev.reason}</span> : null}
                              </div>
                            );
                          })}
                          {(!detail.evidence || detail.evidence.length === 0) && <div className="muted">Nothing read on the new line yet.</div>}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>
                            Verified facts
                            {detail.canonicalFacts && detail.canonicalFacts.contestedCount > 0
                              ? <span className="pill pill-warn" style={{ marginLeft: 6 }}>{detail.canonicalFacts.contestedCount} disagree</span>
                              : null}
                          </div>
                          {((detail.canonicalFacts && detail.canonicalFacts.facts) || []).map((f, i) => {
                            const s = EVIDENCE_STATUS[f.status] || { label: f.status, cls: 'pill-muted' };
                            return (
                              <div key={i} className="muted" style={{ fontSize: 13, maxWidth: 480 }}>
                                <b>{f.fieldLabel || f.fieldKey}</b>: {f.value || '—'}
                                {' '}<span className={`pill ${s.cls}`}>{s.label}</span>
                                {f.pageNumber ? <span> · p.{f.pageNumber}</span> : null}
                                {f.contested ? <span className="pill pill-warn" style={{ marginLeft: 4 }}>reader disagreement</span> : null}
                                {f.alternativesCount > 0 ? <span> · {f.alternativesCount} other read{f.alternativesCount === 1 ? '' : 's'}</span> : null}
                              </div>
                            );
                          })}
                          {(!detail.canonicalFacts || !detail.canonicalFacts.facts || detail.canonicalFacts.facts.length === 0) && <div className="muted">No settled facts yet.</div>}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>
                            Old line vs new line
                            {detail.v1v2Diff && detail.v1v2Diff.counts && detail.v1v2Diff.counts.disagree > 0
                              ? <span className="pill pill-bad" style={{ marginLeft: 6 }}>{detail.v1v2Diff.counts.disagree} differ</span>
                              : null}
                          </div>
                          {detail.v1v2Diff && detail.v1v2Diff.docType && (detail.v1v2Diff.docType.v1 || detail.v1v2Diff.docType.v2) ? (
                            <div className="muted" style={{ fontSize: 13, maxWidth: 480 }}>
                              <b>Document type</b>: old “{detail.v1v2Diff.docType.v1 || '—'}” vs new “{detail.v1v2Diff.docType.v2 || '—'}”
                              {detail.v1v2Diff.docType.agreement === 'disagree' ? <span className="pill pill-bad" style={{ marginLeft: 4 }}>differ</span>
                                : detail.v1v2Diff.docType.agreement === 'agree' ? <span className="pill pill-ok" style={{ marginLeft: 4 }}>match</span> : null}
                            </div>
                          ) : null}
                          {((detail.v1v2Diff && detail.v1v2Diff.fields) || []).map((f, i) => {
                            const cls = f.agreement === 'disagree' ? 'pill-bad' : f.agreement === 'agree' ? 'pill-ok' : 'pill-muted';
                            const label = f.agreement === 'disagree' ? 'differ' : f.agreement === 'agree' ? 'match' : f.agreement === 'v1_only' ? 'old only' : 'new only';
                            return (
                              <div key={i} className="muted" style={{ fontSize: 13, maxWidth: 480 }}>
                                <b>{f.key}</b>: old “{f.v1Value || '—'}” vs new “{f.v2Value || '—'}”
                                {' '}<span className={`pill ${cls}`}>{label}</span>
                              </div>
                            );
                          })}
                          {(!detail.v1v2Diff || !detail.v1v2Diff.fields || detail.v1v2Diff.fields.length === 0) && <div className="muted">No comparable results yet (the old line hasn’t read this document, or the new line hasn’t either).</div>}
                        </div>
                      </div>
                    )}
                  </td></tr>
                )}
              </React.Fragment>
            ))}
            {(!jobs || jobs.length === 0) && <tr><td colSpan={7} className="muted">
              No documents have gone through the new line yet{shadowOn ? '' : ' (shadow mode is off)'}.
            </td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
