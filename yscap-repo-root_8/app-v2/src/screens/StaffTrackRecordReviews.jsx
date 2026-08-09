import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { askPrompt } from '../lib/dialog.js';

/* TRACK RECORD — WAITING FOR REVIEW (owner-directed 2026-08-03: "if the borrower
   is entering the track record, it should go to the processing queue to review
   the track record that the borrower imported, and this should be pending review
   … till they review it and they provide documentation, then it should go for
   verified").

   Every deal a borrower types is self-reported until somebody reads the closing
   statement / deed / lease behind it. Nothing was ever marked verified in the
   database — but there was nowhere to SEE what was waiting, so the only way to
   find a borrower's new deals was to open their profile and look.

   A tab of the Approvals hub, not a new nav link: this is a queue waiting on a
   human decision, which is exactly what that hub is for (the same reasoning that
   folded five separate AI screens into the AI Command Center).

   GROUPED BY PERSON, because that is the unit of work — a borrower who has just
   filled in their record produces eight lines at once and they are read together,
   against one set of documents.

   THE VERDICTS ARE THE SERVER'S, NOT THIS SCREEN'S. Marking a line verified (or
   limited) COUNTS it toward the file's experience tier and signs off the
   experience condition, so the route refuses it without `sign_off_conditions`
   and refuses it outright on a deal with no completed exit, a future exit, or an
   exit older than three years. This screen never pre-judges any of that: it
   sends the verdict and shows what came back. */

const STATUS_LABEL = {
  pending: 'Pending review',
  docs: 'Documentation required',
  verified: 'Verified',
  limited: 'Limited verification',
};

const money = (n) => (n == null || n === '' ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'));
const day = (d) => (d ? String(d).slice(0, 10) : null);
const addrOf = (a) => {
  const x = a || {};
  return x.oneLine
    || [x.line1 || x.street || x.address, x.city, x.state].filter(Boolean).join(', ')
    || 'A past project';
};
const dealLabel = (t) => {
  const s = String(t || '').toLowerCase();
  if (s.includes('ground')) return 'Ground-up';
  if (s.includes('hold') || s.includes('rental')) return 'Fix & Hold';
  return 'Fix & Flip';
};
// The exit is what the 3-year experience window is counted from — a flip exits on
// its sale, a hold on its lease or refinance. Showing it here is the difference
// between "I can judge this line" and "I have to open the profile".
const exitOf = (r) => (dealLabel(r.deal_type) === 'Fix & Flip'
  ? (day(r.sale_date) ? `Sold ${day(r.sale_date)}` : null)
  : (day(r.rent_date) ? `Leased ${day(r.rent_date)}` : (day(r.refi_date) ? `Refinanced ${day(r.refi_date)}` : null)));

export default function StaffTrackRecordReviews() {
  const { can } = useAuth();
  const [lines, setLines] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const mayVerify = can('sign_off_conditions');

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 9000); };

  const load = () => api.staffTrackRecordReviews()
    .then((d) => setLines(Array.isArray(d && d.lines) ? d.lines : []))
    .catch((e) => { setLines([]); flash(false, (e && e.message) || 'could not load the review queue'); });

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function setStatus(row, status) {
    setBusy(row.id);
    try {
      await api.staffVerifyTrackRecord(row.id, { status });
      flash(true, `${addrOf(row.property_address)} — ${STATUS_LABEL[status] || status}.`);
      await load();
    } catch (e) {
      // The refusals here are real underwriting rules (no completed exit, a
      // future exit, an exit outside the 3-year window, or not being a
      // processor) and each one says exactly what to do instead — so the
      // server's own wording is shown verbatim rather than summarised.
      flash(false, (e && e.message) || 'could not update that line');
    } finally { setBusy(''); }
  }

  async function askForDoc(row) {
    const files = Array.isArray(row.files) ? row.files : [];
    if (!files.length) {
      flash(false, 'This borrower has no open loan file — a document request becomes a condition on a file, so there is nowhere to put it yet.');
      return;
    }
    const label = await askPrompt(`Ask for a document on "${addrOf(row.property_address)}" — which document do you need? (the borrower sees this)`);
    if (label == null || !label.trim()) return;
    setBusy(row.id);
    try {
      await api.staffRequestTrackRecordDoc(row.id, files[0].id, label.trim());
      flash(true, 'Requested — it is now a condition on their file, and the line is marked documentation required.');
      await load();
    } catch (e) { flash(false, (e && e.message) || 'could not request the document'); }
    finally { setBusy(''); }
  }

  async function openDoc(d) {
    try { const { blob, filename } = await api.staffDownloadDoc(d.id); saveBlob(blob, filename || d.filename); }
    catch (e) { flash(false, (e && e.message) || 'could not open that document'); }
  }

  if (lines == null) return <div className="wrap"><p className="muted">Loading…</p></div>;

  // One group per person: a borrower's lines are read together, against one set
  // of documents. Insertion order follows the query's newest-first sort.
  const groups = [];
  const byBorrower = new Map();
  for (const r of lines) {
    if (!byBorrower.has(r.borrower_id)) {
      const g = { borrowerId: r.borrower_id, name: r.borrower_name || 'Borrower', rows: [] };
      byBorrower.set(r.borrower_id, g);
      groups.push(g);
    }
    byBorrower.get(r.borrower_id).rows.push(r);
  }

  return (
    <div className="wrap" style={{ maxWidth: 1000 }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Track record — waiting for review</h1>
        {lines.length > 0 && <span className="ts-badge warn">{lines.length} {lines.length === 1 ? 'deal' : 'deals'}</span>}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Deals a borrower entered themselves that nobody has verified yet. Nothing here counts toward a file&rsquo;s
        experience until it is marked verified — read the closing statement, deed or lease behind each one first,
        or ask for it.
      </p>

      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      {!lines.length && (
        <div className="panel" style={{ marginTop: 12 }}>
          <p className="muted small" style={{ margin: 0 }}>
            Nothing is waiting. A deal appears here the moment a borrower adds or changes a line on their track record.
          </p>
        </div>
      )}

      {groups.map((g) => (
        <div className="panel" key={g.borrowerId} style={{ marginTop: 14 }}>
          <div className="row" style={{ alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <h3 style={{ margin: 0, color: '#141B22' }}>{g.name}</h3>
            <span className="pill small">{g.rows.length} {g.rows.length === 1 ? 'deal' : 'deals'}</span>
            <div className="spacer" />
            <Link className="btn ghost small" to={`/internal/borrowers/${g.borrowerId}`}>Open their profile</Link>
          </div>

          {g.rows.map((r) => {
            const docs = Array.isArray(r.docs) ? r.docs : [];
            const files = Array.isArray(r.files) ? r.files : [];
            const facts = [
              dealLabel(r.deal_type),
              r.owned_personally ? 'Personal name' : (r.entity_name || null),
              money(r.purchase_price) ? `Bought ${money(r.purchase_price)}${day(r.purchase_date) ? ` · ${day(r.purchase_date)}` : ''}` : null,
              money(r.rehab_amount) ? `Rehab ${money(r.rehab_amount)}` : null,
              money(r.sale_price) ? `Sold ${money(r.sale_price)}` : null,
              money(r.rent_amount) ? `Rent ${money(r.rent_amount)}/mo` : null,
              exitOf(r),
            ].filter(Boolean);
            return (
              <div key={r.id} style={{ padding: '10px 0', borderTop: '1px solid rgba(127,169,176,.18)' }}>
                <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <strong style={{ color: '#141B22' }}>{addrOf(r.property_address)}</strong>
                  <span className="pill small">{STATUS_LABEL[r.verification_status] || 'Pending review'}</span>
                  {r.entered_at && <span className="muted small">entered {day(r.entered_at)}</span>}
                </div>
                <div className="small" style={{ color: '#4B585C', marginTop: 3 }}>{facts.join(' · ') || 'No figures entered yet'}</div>

                {/* THE DOCUMENTS ARE THE REVIEW. Opening them from here is the
                    whole point — otherwise this is a list that sends you
                    somewhere else to do the actual work. */}
                <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  {docs.length
                    ? docs.map((d) => (
                      <button key={d.id} className="btn ghost small" onClick={() => openDoc(d)}
                        title={d.slot_label || d.filename}>{d.filename}</button>
                    ))
                    : <span className="small" style={{ color: '#8A6D3B' }}>No documentation on this deal yet.</span>}
                </div>

                <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <button className="btn primary small" disabled={busy === r.id || !mayVerify}
                    title={mayVerify
                      ? 'Confirmed against the documents — this deal counts toward experience'
                      : 'Only a processor can verify a deal — it signs off the experience condition. Ask for a document or mark it documentation required instead.'}
                    onClick={() => setStatus(r, 'verified')}>Verified</button>
                  <button className="btn small" disabled={busy === r.id || !mayVerify}
                    title={mayVerify
                      ? 'Confirmed online / public record, no documentation on file — still counts'
                      : 'Only a processor can set a counting status.'}
                    onClick={() => setStatus(r, 'limited')}>Limited verification</button>
                  <button className="btn ghost small" disabled={busy === r.id}
                    title="Keep it out of the experience count until documentation arrives"
                    onClick={() => setStatus(r, 'docs')}>Documentation required</button>
                  <button className="btn ghost small" disabled={busy === r.id}
                    title={files.length
                      ? 'Ask the borrower for a specific document — it becomes a condition on their loan file'
                      : 'They have no open loan file, so there is nowhere to put the request yet'}
                    onClick={() => askForDoc(r)}>Ask for a document</button>
                  <div className="spacer" />
                  {files.map((f) => (
                    <Link key={f.id} className="btn ghost small" to={`/internal/app/${f.id}`}>
                      {f.ys_loan_number || addrOf(f.property_address)}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
