import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { askConfirm, askPrompt } from '../lib/dialog.js';

/* THE TRACK-RECORD WORKSPACE — ONE screen, replacing the two stacked track
   records the back office had.

   ── EVERY VERDICT COMES FROM THE SERVER ──────────────────────────────────
   This screen renders `next` / `other` / `readiness` / `bulk` exactly as they
   arrive from `src/lib/track-record/pillar-actions.js`. It never decides which
   button is primary, never writes its own hint, and never pre-judges a refusal.
   That is what stops the screen offering something the server refuses — the
   failure mode `condition-actions.js` documents at length.

   ── IT REPLACES THE OLD REVIEW QUEUE, AND CARRIES ITS VERBS ──────────────
   The old tab had two live bugs the moment phase 4 landed: its "Documentation
   required" button set the status with no ask, which the server now refuses
   outright, and its "Ask for a document" refused whenever the borrower had no
   open loan file — a rule the server had just dropped. Both are gone here: the
   ask is typed, and it needs no file.

   ── COLOURS ──────────────────────────────────────────────────────────────
   Explicit darks. In this palette every `--ink*` token is a LIGHT paper colour,
   so `color: var(--ink)` renders white on white — the exact bug that made a
   whole staff card invisible in July. Text is #141B22 / #4B585C, never a token. */

const INK = '#141B22';
const MUTED = '#4B585C';

const day = (d) => (d ? String(d).slice(0, 10) : null);
const money = (n) => (n == null || n === '' ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'));

const dealLabel = (t) => {
  const s = String(t || '').toLowerCase();
  if (s.includes('ground')) return 'Ground-up';
  if (s.includes('hold') || s.includes('rental')) return 'Fix & Hold';
  return 'Fix & Flip';
};

/* The state a reviewer reads at a glance. `neutral` is deliberately its own
   thing: "nothing found" painted the same as "contradicted" tells a reviewer —
   and through them a borrower — that we could not verify them, when the truth is
   usually that the county does not publish. */
const TONE_STYLE = {
  good: { mark: '✓', color: '#1F6B3F', border: '#1F6B3F' },
  bad: { mark: '✗', color: '#8A2B2B', border: '#8A2B2B' },
  neutral: { mark: '–', color: '#4B585C', border: '#AE8746' },
  unknown: { mark: '?', color: '#4B585C', border: '#C9CFD3' },
};

const PILLAR_TITLE = { recency: 'Finished in the last 3 years', ownership: 'They owned it', exit: 'The exit really happened' };

export default function StaffTrackRecordWorkspace() {
  const { can } = useAuth();
  const maySignOff = can('sign_off_conditions');

  const [queue, setQueue] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [rowErr, setRowErr] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [ask, setAsk] = useState(null);          // the typed request sheet
  const [docTypes, setDocTypes] = useState([]);

  /* An error goes in the banner AND on the row. In a long queue the banner is
     off-screen by the time you have scrolled to the row you clicked, and a
     failed action that shows nothing reads as the click not registering. */
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 12000); };
  const rowError = (id, text) => {
    setRowErr((m) => ({ ...m, [id]: text }));
    setTimeout(() => setRowErr((m) => { const n = { ...m }; delete n[id]; return n; }), 12000);
  };

  const loadQueue = () => api.staffTrackRecordWorkspace({ filter: showAll ? 'all' : 'open' })
    .then((d) => setQueue(d && Array.isArray(d.groups) ? d : { groups: [], totals: {} }))
    .catch((e) => { setQueue({ groups: [], totals: {} }); flash(false, (e && e.message) || 'could not load the queue'); });

  const loadDetail = (id) => {
    if (!id) { setDetail(null); return Promise.resolve(); }
    return api.staffTrackRecordLine(id)
      .then(setDetail)
      .catch((e) => { setDetail(null); flash(false, (e && e.message) || 'could not open that project'); });
  };

  useEffect(() => { loadQueue(); }, [showAll]);
  useEffect(() => { loadDetail(selected); }, [selected]);
  useEffect(() => { api.staffTrackRecordDocTypes().then((d) => setDocTypes((d && d.docTypes) || [])).catch(() => {}); }, []);

  const flatLines = useMemo(
    () => (queue && queue.groups ? queue.groups.flatMap((g) => g.lines) : []),
    [queue]);

  // Pick the first thing worth looking at, once.
  useEffect(() => {
    if (!selected && flatLines.length) setSelected(flatLines[0].id);
  }, [flatLines, selected]);

  /* J / K move through the queue; 1-3 are left to the cards' own buttons rather
     than stealing keystrokes from the note box. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      const i = flatLines.findIndex((l) => l.id === selected);
      const next = k === 'j' ? Math.min(i + 1, flatLines.length - 1) : Math.max(i - 1, 0);
      if (flatLines[next]) { setSelected(flatLines[next].id); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flatLines, selected]);

  async function decide(card, verdict) {
    const pillarId = card.pillarId;
    setBusy(pillarId);
    try {
      let note = null;
      if (verdict === 'rejected') {
        // The server REQUIRES a reason on a rejection, so ask for it here rather
        // than letting the click fail.
        note = await askPrompt('Why can this check not be met? The next person to read this file sees your answer.', { multiline: true });
        if (note == null) { setBusy(''); return; }
      }
      const out = await api.staffDecidePillar(pillarId, { verdict, note });
      flash(true, out && out.readiness ? out.readiness.message : 'Saved.');
      await Promise.all([loadDetail(selected), loadQueue()]);
    } catch (e) {
      const t = (e && e.message) || 'that did not save';
      flash(false, t); rowError(pillarId, t);
    } finally { setBusy(''); }
  }

  async function undo(card) {
    setBusy(card.pillarId);
    try {
      await api.staffDecidePillar(card.pillarId, { verdict: '' });
      await Promise.all([loadDetail(selected), loadQueue()]);
    } catch (e) { const t = (e && e.message) || 'could not undo that'; flash(false, t); rowError(card.pillarId, t); }
    finally { setBusy(''); }
  }

  async function verify(line, status) {
    setBusy(line.id);
    try {
      const out = await api.staffVerifyTrackRecord(line.id, { status });
      flash(true, `${line.address} — ${status === 'limited' ? 'verified from public records' : 'verified'}.`);
      if (out && out.requestError) flash(false, out.requestError);
      await Promise.all([loadDetail(selected), loadQueue()]);
    } catch (e) {
      // Real underwriting refusals — no completed exit, a future exit, an exit
      // outside the 3-year window, or not having sign-off. Each says exactly
      // what to do instead, so it is shown word for word.
      const t = (e && e.message) || 'that did not save';
      flash(false, t); rowError(line.id, t);
    } finally { setBusy(''); }
  }

  async function bulkConfirm(line) {
    if (!line.bulk || !line.bulk.ok) { rowError(line.id, line.bulk && line.bulk.reason); return; }
    if (!(await askConfirm(`Confirm all three checks on ${line.address}? The records already prove each one.`))) return;
    setBusy(line.id);
    try {
      const out = await api.staffBulkConfirmPillars(line.id);
      flash(true, `${line.address} — ${out.confirmed} check${out.confirmed === 1 ? '' : 's'} confirmed. ${out.readiness.message}`);
      await Promise.all([loadDetail(selected), loadQueue()]);
    } catch (e) {
      // The server refuses this on a contradicted or unproved pillar, and its
      // wording says which — show it verbatim rather than summarising.
      const t = (e && e.message) || 'that did not save';
      flash(false, t); rowError(line.id, t);
    } finally { setBusy(''); }
  }

  async function postRequest() {
    if (!ask || !ask.docType) return;
    setBusy('ask');
    try {
      const out = await api.staffRequestTrackRecordDocTyped(ask.trackRecordId, {
        docType: ask.docType, pillar: ask.pillar, llcId: ask.llcId || undefined,
        customLabel: ask.customLabel || undefined, internalNote: ask.internalNote || undefined,
      });
      setAsk(null);
      flash(true, out.scope === 'borrower_profile'
        ? 'Asked. It is on their profile and moves onto their next loan file automatically.'
        : 'Asked. It is now a condition on the loan file and the borrower has been told.');
      await Promise.all([loadDetail(selected), loadQueue()]);
    } catch (e) { flash(false, (e && e.message) || 'could not post that request'); }
    finally { setBusy(''); }
  }

  function openAsk(pillar) {
    if (!detail) return;
    const t = docTypes.find((d) => d.pillars.includes(pillar)) || docTypes[0];
    setAsk({
      trackRecordId: detail.line.id, pillar,
      docType: t ? t.slug : '', llcId: detail.line.llcId || '',
      customLabel: '', internalNote: '', preview: '',
    });
  }

  async function openDoc(d) {
    try { const { blob, filename } = await api.staffDownloadDoc(d.id); saveBlob(blob, filename || d.filename); }
    catch (e) { flash(false, (e && e.message) || 'could not open that document'); }
  }

  async function addNote() {
    const body = await askPrompt('Internal note on this project — staff only, the borrower never sees it.', { multiline: true });
    if (body == null || !body.trim()) return;
    try {
      await api.staffAddTrackRecordNote({ subjectKind: 'property', subjectId: detail.line.id, body });
      await loadDetail(selected);
    } catch (e) { flash(false, (e && e.message) || 'could not save that note'); }
  }

  if (queue == null) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const totals = queue.totals || {};

  return (
    <div className="wrap" style={{ maxWidth: 1240 }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0, color: INK }}>Track record verification</h1>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          {totals.contradicted > 0 && <span className="ts-badge warn">{totals.contradicted} disagree with the records</span>}
          {totals.waiting > 0 && <span className="pill small">{totals.waiting} waiting</span>}
          <button className="btn ghost small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Only unfinished' : 'Show everything'}
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Every past project has three checks: it finished in the last 3&nbsp;years, they really owned it, and the exit
        really happened. All three have to be confirmed by a person before a project counts toward experience.
        Press <strong>J</strong> and <strong>K</strong> to move down and up the list.
      </p>

      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      <div className="ec-split" style={{ marginTop: 12 }}>
        {/* ── THE QUEUE, GROUPED BY PERSON ─────────────────────────────── */}
        <div>
          {!queue.groups.length && (
            <div className="panel"><p className="muted small" style={{ margin: 0 }}>
              Nothing is waiting. A project appears here the moment somebody adds one to a borrower&rsquo;s record.
            </p></div>
          )}
          {queue.groups.map((g) => (
            <div className="panel" key={g.borrowerId} style={{ marginBottom: 10, padding: 10 }}>
              <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong style={{ color: INK }}>{g.borrowerName}</strong>
                <span className="pill small">{g.lines.length}</span>
                {g.contradicted > 0 && <span className="ts-badge warn small">{g.contradicted} disagree</span>}
                <div className="spacer" />
                <Link className="btn ghost small" to={`/internal/borrowers/${g.borrowerId}`}>Profile</Link>
              </div>
              {g.lines.map((l) => {
                const done = l.readiness && l.readiness.ready;
                return (
                  <div key={l.id}>
                    <button
                      className="btn ghost"
                      onClick={() => setSelected(l.id)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', marginTop: 6,
                        borderLeft: `3px solid ${l.urgency === 0 ? '#8A2B2B' : done ? '#1F6B3F' : '#AE8746'}`,
                        background: l.id === selected ? 'rgba(47,127,134,.10)' : undefined,
                      }}>
                      <span style={{ color: INK, fontWeight: 600 }}>{l.address || 'A past project'}</span>
                      <span style={{ display: 'block', color: MUTED, fontSize: 12, marginTop: 2 }}>
                        {[dealLabel(l.dealType), l.countsFrom ? `exit ${day(l.countsFrom)}` : 'no exit yet',
                          l.entityName || null].filter(Boolean).join(' · ')}
                      </span>
                      <span style={{ display: 'block', color: MUTED, fontSize: 12, marginTop: 2 }}>
                        {(l.pillars || []).map((p) => {
                          const tone = p.human_verdict === 'confirmed' ? 'good'
                            : p.human_verdict === 'rejected' ? 'bad'
                              : p.auto_verdict === 'proved' ? 'good'
                                : p.auto_verdict === 'contradicted' ? 'bad'
                                  : p.auto_verdict ? 'neutral' : 'unknown';
                          return (
                            <span key={p.pillar} title={`${PILLAR_TITLE[p.pillar]} — ${p.human_verdict || p.auto_verdict || 'not checked'}`}
                              style={{ color: TONE_STYLE[tone].color, marginRight: 6, fontWeight: 700 }}>
                              {TONE_STYLE[tone].mark}
                            </span>
                          );
                        })}
                        {l.openRequests > 0 && <span style={{ color: '#8A6D3B' }}>· {l.openRequests} asked</span>}
                        {l.isVerified && <span style={{ color: '#1F6B3F' }}>· verified</span>}
                      </span>
                    </button>
                    {rowErr[l.id] && <div className="notice err small" style={{ marginTop: 4 }}>{rowErr[l.id]}</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* ── THE PROJECT ──────────────────────────────────────────────── */}
        <div>
          {!detail && <div className="panel"><p className="muted small" style={{ margin: 0 }}>Pick a project on the left.</p></div>}
          {detail && (
            <>
              <div className="panel" style={{ marginBottom: 10 }}>
                <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, color: INK, fontSize: 18 }}>{detail.line.address}</h2>
                  <span className="pill small">{dealLabel(detail.line.dealType)}</span>
                  {detail.line.entityName && (
                    <span className="pill small" title={detail.line.entityDocsVerified ? 'This company’s documents are complete' : 'This company’s documents are not complete yet'}>
                      {detail.line.entityName}{detail.line.entityDocsVerified ? ' ✓' : ''}
                    </span>
                  )}
                  {detail.line.isVerified && <span className="ts-badge ok">Verified</span>}
                </div>
                <div className="small" style={{ color: MUTED, marginTop: 4 }}>
                  {[money(detail.line.purchasePrice) ? `Bought ${money(detail.line.purchasePrice)}${day(detail.line.purchaseDate) ? ` on ${day(detail.line.purchaseDate)}` : ''}` : null,
                    money(detail.line.rehabAmount) ? `Rehab ${money(detail.line.rehabAmount)}` : null,
                    money(detail.line.salePrice) ? `Sold ${money(detail.line.salePrice)}` : null,
                    detail.line.countsFrom ? `Counts from ${day(detail.line.countsFrom)}` : 'No completed exit yet',
                    detail.line.holdDays != null ? `Held ${detail.line.holdDays} days` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                <div className="notice" style={{ marginTop: 8, background: 'rgba(47,127,134,.08)' }}>
                  <strong style={{ color: INK }}>{detail.readiness.answered} of {detail.readiness.of} answered.</strong>{' '}
                  <span style={{ color: MUTED }}>{detail.readiness.message}</span>
                </div>
                <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {/* VERIFYING IS THE ACT THAT MAKES A PROJECT COUNT, and it is
                      separate from confirming the three checks on purpose: the
                      checks are the evidence, this is the decision. The server
                      refuses it without sign-off, and refuses it outright on a
                      project with no completed exit, a future exit, or one
                      outside the 3-year window — so its wording is shown
                      verbatim rather than pre-judged here. */}
                  <button className="btn primary small" disabled={busy === detail.line.id || !maySignOff}
                    title={maySignOff
                      ? 'Confirmed against the documents — this project counts toward experience'
                      : 'Only somebody with sign-off can verify a project. You can still reject a check or ask for a document.'}
                    onClick={() => verify(detail.line, 'verified')}>Verify this project</button>
                  <button className="btn small" disabled={busy === detail.line.id || !maySignOff}
                    title={maySignOff
                      ? 'Confirmed from public records only, with no documents on file — still counts'
                      : 'Only somebody with sign-off can set a counting status.'}
                    onClick={() => verify(detail.line, 'limited')}>Public records only</button>
                  <button className="btn small" disabled={busy === detail.line.id || !detail.bulk.ok || !maySignOff}
                    title={detail.bulk.ok
                      ? 'Confirm all three at once — only offered when the records already prove every one'
                      : detail.bulk.reason}
                    onClick={() => bulkConfirm({ ...detail.line, bulk: detail.bulk })}>
                    Confirm all three
                  </button>
                  <button className="btn ghost small" onClick={addNote}>Add an internal note</button>
                  {/* There is no standalone entity screen — the company's
                      documents live on the borrower's profile — so the link says
                      where it actually goes rather than promising a screen that
                      does not exist. */}
                  <Link className="btn ghost small" to={`/internal/borrowers/${detail.line.borrowerId}`}>
                    Open their profile
                  </Link>
                </div>
                {!detail.bulk.ok && (
                  <p className="small" style={{ color: MUTED, marginTop: 6, marginBottom: 0 }}>{detail.bulk.reason}</p>
                )}
              </div>

              {/* THE THREE EVIDENCE CARDS */}
              {detail.cards.map((c, i) => {
                const tone = TONE_STYLE[c.tone] || TONE_STYLE.unknown;
                const pillarId = c.pillarId;
                const card = c;
                return (
                  <div className="panel" key={c.pillar}
                    style={{ marginBottom: 10, borderLeft: `3px solid ${tone.border}` }}>
                    <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ color: tone.color, fontWeight: 700, fontSize: 16 }}>{tone.mark}</span>
                      <strong style={{ color: INK }}>{i + 1} · {PILLAR_TITLE[c.pillar]}</strong>
                      {c.humanVerdict && <span className="pill small">{c.humanVerdict === 'confirmed' ? 'Confirmed by a person' : c.humanVerdict === 'rejected' ? 'Rejected' : 'Document asked for'}</span>}
                      {!c.humanVerdict && c.neutral && <span className="pill small">Nothing found — not a problem with the borrower</span>}
                    </div>

                    <p className="small" style={{ color: MUTED, margin: '6px 0 0' }}>{c.meaning}</p>

                    {/* THE SNIPPET IS MANDATORY. A card that says only "verified
                        by Elementix" asks a reviewer to trust a vendor name,
                        which is not review. */}
                    {c.snippet
                      ? (
                        <blockquote style={{
                          margin: '8px 0 0', padding: '8px 10px', borderLeft: '2px solid #C9CFD3',
                          background: 'rgba(0,0,0,.03)', color: INK, fontSize: 13, overflowWrap: 'anywhere',
                        }}>{c.snippet}</blockquote>
                      )
                      : <p className="small" style={{ color: '#8A6D3B', margin: '8px 0 0' }}>{c.snippetNote}</p>}

                    <div className="small" style={{ color: MUTED, marginTop: 6 }}>
                      {[c.source ? `Source: ${c.source}` : null,
                        c.confidence ? `confidence ${c.confidence}` : null,
                        c.grade ? `evidence ${c.grade}` : null,
                        c.when ? c.when : null,
                        c.carriedFromEntity ? 'carried from the company' : null,
                      ].filter(Boolean).join(' · ') || 'Not checked yet'}
                    </div>

                    <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {c.next.key === 'undo' || c.next.key === 'confirmed_locked'
                        ? (
                          <button className="btn ghost small" disabled={busy === pillarId || c.next.key === 'confirmed_locked'}
                            title={c.next.title} onClick={() => undo(card)}>{c.next.label}</button>
                        )
                        : c.next.key === 'ask_doc'
                          ? <button className="btn primary small" title={c.next.title} onClick={() => openAsk(c.pillar)}>{c.next.label}</button>
                          : c.next.key === 'awaiting_doc'
                            ? <button className="btn ghost small" disabled title={c.next.title}>{c.next.label}</button>
                            : (
                              <button className={`btn ${c.next.tone === 'primary' ? 'primary' : 'ghost'} small`}
                                disabled={busy === pillarId} title={c.next.title}
                                onClick={() => (c.next.verdict ? decide(card, c.next.verdict) : openAsk(c.pillar))}>
                                {c.next.label}
                              </button>
                            )}
                      {c.other.map((o) => (
                        <button key={o.key} className="btn ghost small" disabled={busy === pillarId} title={o.title}
                          onClick={() => (o.verdict ? decide(card, o.verdict) : openAsk(c.pillar))}>{o.label}</button>
                      ))}
                    </div>
                    <p className="small" style={{ color: MUTED, margin: '6px 0 0' }}>{c.next.hint}</p>
                    {rowErr[pillarId] && <div className="notice err small" style={{ marginTop: 6 }}>{rowErr[pillarId]}</div>}
                  </div>
                );
              })}

              {/* DOCUMENTS, REQUESTS, FINDINGS, NOTES */}
              <div className="panel" style={{ marginBottom: 10 }}>
                <strong style={{ color: INK }}>Documents</strong>
                <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {detail.documents.length
                    ? detail.documents.map((d) => (
                      <button key={d.id} className="btn ghost small" onClick={() => openDoc(d)} title={d.doc_type || d.filename}>
                        {d.filename}{d.review_status === 'accepted' ? ' ✓' : d.review_status === 'rejected' ? ' ✗' : ''}
                      </button>
                    ))
                    : <span className="small" style={{ color: '#8A6D3B' }}>Nothing has been uploaded on this project.</span>}
                </div>

                {detail.requests.length > 0 && (
                  <>
                    <strong style={{ color: INK, display: 'block', marginTop: 10 }}>Asked for</strong>
                    {detail.requests.map((r) => (
                      <div key={r.id} className="small" style={{ color: MUTED, marginTop: 4 }}>
                        <span className="pill small" style={{ marginRight: 6 }}>{r.status}</span>
                        {r.label}
                        {r.scope === 'borrower_profile' && <span style={{ color: '#8A6D3B' }}> · on their profile until a file opens</span>}
                      </div>
                    ))}
                  </>
                )}

                {detail.findings.length > 0 && (
                  <>
                    <strong style={{ color: INK, display: 'block', marginTop: 10 }}>Problems found</strong>
                    {detail.findings.map((f) => (
                      <div key={f.id} className="notice err small" style={{ marginTop: 4 }}>{f.title || f.code}</div>
                    ))}
                  </>
                )}

                {detail.notes.length > 0 && (
                  <>
                    <strong style={{ color: INK, display: 'block', marginTop: 10 }}>Internal notes</strong>
                    <p className="small" style={{ color: MUTED, margin: '2px 0 0' }}>Staff only — the borrower never sees these.</p>
                    {detail.notes.map((n) => (
                      <div key={n.id} className="small" style={{ color: n.retracted_at ? MUTED : INK, marginTop: 4, textDecoration: n.retracted_at ? 'line-through' : 'none' }}>
                        {n.body}
                        <span style={{ color: MUTED }}> — {n.author_name || 'staff'}, {day(n.created_at)}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── THE TYPED ASK ────────────────────────────────────────────── */}
      {ask && (
        <div className="cv-modal-back" onClick={() => setAsk(null)}>
          <div className="cv-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 style={{ marginTop: 0, color: INK }}>Ask for a document</h3>
            <label className="small" style={{ color: MUTED, display: 'block', marginTop: 8 }}>What do you need?</label>
            <select className="input" value={ask.docType}
              onChange={(e) => setAsk({ ...ask, docType: e.target.value })}>
              {docTypes.filter((d) => d.pillars.includes(ask.pillar)).map((d) => (
                <option key={d.slug} value={d.slug}>{d.label}</option>
              ))}
            </select>
            {ask.docType === 'other' && (
              <input className="input" style={{ marginTop: 6 }} placeholder="Name the document"
                value={ask.customLabel} onChange={(e) => setAsk({ ...ask, customLabel: e.target.value })} />
            )}
            <label className="small" style={{ color: MUTED, display: 'block', marginTop: 8 }}>
              Internal note (staff only — the borrower never sees this)
            </label>
            <textarea className="input" rows={3} value={ask.internalNote}
              onChange={(e) => setAsk({ ...ask, internalNote: e.target.value })} />
            <p className="small" style={{ color: MUTED, marginTop: 8 }}>
              This becomes a real condition. If the borrower has no open loan file it sits on their profile and moves
              onto their next one automatically.
            </p>
            <div className="row" style={{ gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
              <button className="btn ghost small" onClick={() => setAsk(null)}>Cancel</button>
              <button className="btn primary small" disabled={busy === 'ask' || !ask.docType} onClick={postRequest}>
                Post the condition
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
