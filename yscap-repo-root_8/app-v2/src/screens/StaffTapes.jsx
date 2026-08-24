import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, saveBlob } from '../lib/api.js';
import TapeQuestionsModal from '../components/TapeQuestionsModal.jsx';
import { useAuth } from '../lib/auth.jsx';
import { askPrompt } from '../lib/dialog.js';

/* Data Tapes — the provider-centric export hub, plus the SELECTION WORKFLOW the
   owner asked for on 2026-08-23:

     *"the bulk tape needs to be enhanced so that we can export any kind of tape
     that we currently have for different investors. We can import and select
     different loans to be included in that tape. We should have a few workflows:
       · We can search loans by loan numbers and by address.
       · We can check mark which loans should be included in the tape that we want
         to export.
       · We can export it either way we want, and just populate every loan on
         another line on the Excel sheet that is being exported.
     … I can include any kind of loans that I want."*

   WHAT WAS ACTUALLY MISSING, AND WHAT WAS NOT. The bulk export already put one
   loan per row on the provider's workbook — that half worked. What did not exist
   was any way to CHOOSE the loans: the picker listed only the loans already
   assigned to this provider, so a loan you wanted on the tape and had not
   assigned yet simply was not on the screen, and there was nothing to search.

   And no rule needed relaxing to fix it. An admin/super-admin has always been
   able to export any provider's tape for any loan (buyer-rule.js `exportGate` —
   `if (isAdmin) return { ok: true }`); a non-admin has always needed the provider
   and program to line up. The defect was that the PICKER could not show a loan
   the gate would happily have exported. So this screen searches everything the
   staffer may see and stamps each row with whether THEY can export it — nothing
   hidden, nothing silently permitted.

   THE BASKET IS THE POINT. A selection survives changing the search, so the real
   workflow — paste eight loan numbers, find a ninth by address, add a tenth from
   the provider's own list — builds ONE export. A basket that emptied on every
   search would be a search box, not a workflow.

   The provider's Excel workbook is preserved exactly; we only fill the data rows. */

const money = (v) => (v == null || v === '' ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
const STATUS_LABEL = {
  new: 'New', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting',
  approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded',
  on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn',
};
/* OUR loan number identifies the file, ALWAYS — the investor's own number is kept
   in the back (owner-directed 2026-08-24: "we always prefer our loan number and
   keep the investor's loan number somewhere else in the back").

   This screen used to lead with `investor_loan_number`, so a file the pipeline,
   search and its own header all call YSCAP258134680 appeared here as "32536" —
   the number the INVESTOR uses, pulled from ClickUp's separate "Investor Loan No"
   field (clickup/mapper.js, dir:'pull'). On the one screen where you tick which
   loans to send to a capital provider, a row you cannot match to your own file is
   worse than cosmetic. `ys_loan_number` is what every other surface identifies a
   loan by, so it is what this one shows too. */
const loanNo = (l) => l.ys_loan_number || l.investor_loan_number || '—';
/* The investor's own number, shown as quiet secondary context — and only when it
   ADDS something (present, and not simply a repeat of ours). */
const investorNo = (l) => {
  const inv = l.investor_loan_number;
  return inv && inv !== l.ys_loan_number ? inv : null;
};
const borrower = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ');

export default function StaffTapes() {
  const { can } = useAuth();
  const mayExport = can('export_data_tapes');
  const [tapes, setTapes] = useState(null);
  const [active, setActive] = useState(null);   // tapeKey
  const [loans, setLoans] = useState(null);     // the provider's own list
  const [loadingLoans, setLoadingLoans] = useState(false);
  const [busyBulk, setBusyBulk] = useState(false);
  const [busyRow, setBusyRow] = useState(null);
  const [pending, setPending] = useState(null); // { loanId, tapeName, questions } — questionnaire modal
  const [adminOnly, setAdminOnly] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  /* THE BASKET — id → the loan row, so a selection made in one search still shows
     its loan number and address after the search that found it is gone. A bare Set
     of ids could not render the review list, which is the thing that makes a
     multi-search selection trustworthy. */
  const [basket, setBasket] = useState(() => new Map());
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);   // null = no search run yet
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState('');
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!mayExport) return;
    api.staffTapesList().then((d) => {
      setTapes(d.tapes || []);
      if ((d.tapes || []).length) setActive(d.tapes[0].key);
    }).catch((e) => setErr(e.message || 'Could not load tape types'));
  }, [mayExport]);

  const loadLoans = useCallback((tapeKey) => {
    if (!tapeKey) return;
    setLoadingLoans(true); setLoans(null); setErr(''); setMsg(''); setAdminOnly(false);
    api.staffTapeLoans(tapeKey)
      .then((d) => { setLoans(d.loans || []); setAdminOnly(!!d.adminOnly); })
      .catch((e) => { setLoans([]); setErr(e.message || 'Could not load loans'); })
      .finally(() => setLoadingLoans(false));
  }, []);

  /* THE BASKET SURVIVES A REFRESH, PER PROVIDER. A tape request is 40 loan numbers
     from an investor; losing that selection to a stray reload — or to flipping to
     another provider and back — would make the workflow not worth using. Ids are
     kept per tape key; the ROWS are re-fetched from the server on load, which also
     re-checks each loan's eligibility, so a stored basket can never render a stale
     claim about what may be exported.

     Per provider, and never shared: a Fidelis selection is not a Blue Lake
     selection, and silently carrying one across is the kind of quiet mistake that
     ends up in an investor's inbox. */
  const basketKey = active ? `ys-tape-basket:${active}` : null;
  useEffect(() => {
    setBasket(new Map()); setResults(null); setQ(''); setSearchNote('');
    loadLoans(active);
    if (!active) return undefined;
    let alive = true;
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem(`ys-tape-basket:${active}`) || '[]'); } catch (_) { stored = []; }
    if (!Array.isArray(stored) || !stored.length) return undefined;
    api.staffTapeSelected(active, stored)
      .then((d) => {
        if (!alive) return;
        // Only what the server confirms this staffer can still SEE goes back in —
        // never an id we cannot describe on screen.
        const next = new Map();
        for (const l of (d.loans || [])) next.set(l.id, l);
        setBasket(next);
      })
      .catch(() => { /* a basket that cannot be restored simply starts empty */ });
    return () => { alive = false; };
  }, [active, loadLoans]);

  // Persist on every change, so the stored list is the list on screen.
  useEffect(() => {
    if (!basketKey) return;
    try { localStorage.setItem(basketKey, JSON.stringify(Array.from(basket.keys()))); } catch (_) { /* private mode */ }
  }, [basketKey, basket]);

  const activeTape = (tapes || []).find((t) => t.key === active);

  function toggle(loan) {
    setBasket((cur) => {
      const next = new Map(cur);
      if (next.has(loan.id)) next.delete(loan.id); else next.set(loan.id, loan);
      return next;
    });
  }
  function addAll(list) {
    setBasket((cur) => { const next = new Map(cur); for (const l of list) next.set(l.id, l); return next; });
  }
  function removeAll(list) {
    setBasket((cur) => { const next = new Map(cur); for (const l of list) next.delete(l.id); return next; });
  }

  async function runSearch(e) {
    if (e) e.preventDefault();
    const text = q.trim();
    if (text.length < 2) { setSearchNote('Type at least two characters — a loan number, an address, or a borrower name.'); setResults(null); return; }
    const seq = ++searchSeq.current;
    setSearching(true); setSearchNote(''); setErr('');
    try {
      const d = await api.staffTapeSearch(active, text);
      if (seq !== searchSeq.current) return;          // a later search already answered
      setResults(d.loans || []);
      setSearchNote(d.hint || (d.truncated ? 'Showing the first 200 matches — narrow the search to see more.' : ''));
    } catch (e2) {
      if (seq !== searchSeq.current) return;
      setResults([]); setSearchNote(e2.message || 'Search failed.');
    } finally { if (seq === searchSeq.current) setSearching(false); }
  }

  async function startRow(loanId, tapeName) {
    setBusyRow(loanId); setErr(''); setMsg('');
    try {
      const qn = await api.staffTapeQuestions(loanId, active);
      const questions = (qn && qn.questions) || [];
      const seasoned = qn && qn.seasoned && qn.seasoned.isSeasoned ? qn.seasoned : null;
      if (questions.length || seasoned) { setPending({ loanId, tapeName, questions, seasoned, supplementalMissing: (qn && qn.supplementalMissing) || 0 }); setBusyRow(null); return; }
      await exportRow(loanId, tapeName, undefined);
    } catch (e) { setErr((e.data && e.data.message) || e.message || 'Export failed'); setBusyRow(null); }
  }
  async function exportRow(loanId, tapeName, answers) {
    setBusyRow(loanId); setErr(''); setMsg('');
    try {
      const { blob, filename } = await api.staffTapeExport(loanId, active, answers);
      saveBlob(blob, filename);
      setMsg(`Exported ${tapeName} tape.`);
      setPending(null);
    } catch (e) {
      const d = (e && e.data) || {};
      // Encompass reconciliation gate (owner-directed 2026-07-26; tightened 2026-08-02):
      // NOBODY may self-override. A super admin can allow it inline with a reason;
      // everyone else asks a super admin for an exception (recorded per file).
      if (d.code === 'encompass_override_reason_required' && d.canOverride) {
        const reason = await askPrompt(`${d.message || 'This loan doesn’t fully match Encompass yet.'}\n\nAs a super admin you can allow it — type a short reason (this is logged):`, { defaultValue: '' });
        if (reason && reason.trim()) { setBusyRow(null); await exportRow(loanId, tapeName, { ...(answers || {}), encompassOverrideReason: reason.trim() }); return; }
        setBusyRow(null); return;
      }
      if (d.code === 'encompass_exception_required' || d.code === 'encompass_unreconciled') {
        if (d.canRequestException) {
          const note = await askPrompt(`${d.message || 'This loan doesn’t fully match Encompass yet.'}\n\nAsk a super admin to allow it — say why the tape needs to go out now:`, { defaultValue: '' });
          if (note && note.trim()) {
            try { await api.requestTapeException(loanId, { reasonNote: note.trim() }); setMsg('Sent a request to a super admin. They can allow the tape from the Exceptions box.'); }
            catch (e2) { setErr((e2.data && e2.data.error) || e2.message || 'Could not send the request.'); }
          }
        } else {
          setErr(d.message || 'This loan isn’t reconciled with Encompass yet. A super admin has to allow it, or reconcile it first.');
        }
        setBusyRow(null); return;
      }
      setErr(d.message || e.message || 'Export failed');
    }
    finally { setBusyRow(null); }
  }

  async function exportBulk(overrideReason) {
    if (!basket.size) return;
    setBusyBulk(true); setErr(''); setMsg('');
    try {
      const { blob, filename } = await api.staffTapeBulkExport(active, Array.from(basket.keys()), overrideReason);
      saveBlob(blob, filename);
      setMsg(`Exported a bulk ${activeTape ? activeTape.name : ''} tape — ${basket.size} loan${basket.size === 1 ? '' : 's'}, one per row.`);
    } catch (e) {
      const d = (e && e.data) || {};
      if (d.code === 'encompass_override_reason_required' && d.canOverride) {
        const reason = await askPrompt(`${d.message || 'Some selected loans don’t fully match Encompass yet.'}\n\nAs a super admin you can allow them — type a short reason (this is logged):`, { defaultValue: '' });
        if (reason && reason.trim()) { setBusyBulk(false); await exportBulk(reason.trim()); return; }
        setBusyBulk(false); return;
      }
      if (d.code === 'encompass_exception_required' || d.code === 'encompass_unreconciled') {
        setErr(d.message || 'Some selected loans aren’t reconciled with Encompass yet. A super admin has to allow those (open each file to request it), or reconcile them first.');
        setBusyBulk(false); return;
      }
      // The export gate refused one or more loans — name each one and why, rather
      // than a count. The staffer has to remove them, and cannot without knowing which.
      if (d.error === 'bulk_gate_failed' || d.error === 'buyer_mismatch') {
        const lines = (d.mismatches || []).map((m) => `· ${m.loanNo || m.id}${m.reason ? ` — ${m.reason}` : ''}`);
        setErr([d.message || 'Some selected loans can’t go on this tape.', ...lines].join('\n'));
        setBusyBulk(false); return;
      }
      setErr(d.message || e.message || 'Bulk export failed');
    }
    finally { setBusyBulk(false); }
  }

  if (!mayExport) {
    return (
      <div className="wrap">
        <div className="dd-wrap">
          <div className="dd-head"><div><h1 className="dd-title">Data tapes</h1></div></div>
          <div className="empty" style={{ marginTop: 16 }}>
            You don’t have access to capital-provider data tapes. Ask an admin to turn on
            “Export capital-provider data tapes” for you on the Team screen.
          </div>
        </div>
      </div>
    );
  }

  const basketList = Array.from(basket.values());
  const blocked = basketList.filter((l) => l.eligible === false);

  return (
    <div className="wrap">
      <div className="dd-wrap">
        <div className="dd-head">
          <div>
            <h1 className="dd-title">Data tapes</h1>
            <div className="dd-sub">
              Export a capital provider’s loan tape — their Excel workbook, filled with each loan’s figures so their
              pricing tab recalculates. Pick the provider, then build the tape: start from the loans already assigned
              to them, search for any others by loan number or address, tick what belongs on this tape, and export.
              Every selected loan lands on its own row.
            </div>
          </div>
        </div>

        {tapes == null ? <div className="panel">Loading…</div> : tapes.length === 0 ? (
          <div className="panel">No tape types are configured yet.</div>
        ) : (
          <>
            {/* 1 — which investor's tape */}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {tapes.map((t) => (
                <button key={t.key} className={`btn ${active === t.key ? 'primary' : 'ghost'}`} onClick={() => setActive(t.key)}>
                  {t.name}
                </button>
              ))}
            </div>

            {err && <div className="panel" style={{ borderColor: 'var(--danger, #b3261e)', marginBottom: 10, whiteSpace: 'pre-wrap' }}>{err}</div>}
            {msg && <div className="panel" style={{ borderColor: 'var(--teal)', marginBottom: 10 }}>{msg}</div>}

            {/* 2 — THE BASKET. Above the lists, because it is the thing being built:
                   what is on the tape, and the one button that produces it. */}
            <div className="panel tape-basket" style={{ marginBottom: 12 }}>
              <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>
                  On this tape: {basket.size} loan{basket.size === 1 ? '' : 's'}
                </h3>
                <div className="spacer" />
                {basket.size > 0 && (
                  <button className="btn ghost small" onClick={() => setBasket(new Map())}>Clear</button>
                )}
                <button className="btn primary" onClick={() => exportBulk()} disabled={!basket.size || busyBulk}>
                  {busyBulk ? 'Building…' : `Export ${activeTape ? activeTape.name : ''} tape (${basket.size})`}
                </button>
              </div>

              {basket.size === 0 ? (
                <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                  Nothing selected yet. Tick loans below, or search for a loan by its number or address.
                </p>
              ) : (
                <>
                  {blocked.length > 0 && (
                    <div className="tape-warn" role="status">
                      <b>{blocked.length} of these can’t go on the {activeTape ? activeTape.name : ''} tape with your access.</b>
                      <div style={{ marginTop: 3 }}>
                        {blocked.slice(0, 4).map((l) => (
                          <div key={l.id} className="small">· {loanNo(l)} — {l.ineligibleReason}</div>
                        ))}
                        {blocked.length > 4 && <div className="small">· …and {blocked.length - 4} more.</div>}
                      </div>
                      <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => removeAll(blocked)}>
                        Remove those {blocked.length}
                      </button>
                    </div>
                  )}
                  <div className="tape-chips">
                    {basketList.map((l) => (
                      <span key={l.id} className={`tape-chip${l.eligible === false ? ' is-blocked' : ''}`} title={l.address || ''}>
                        <span className="tape-chip-no">{loanNo(l)}</span>
                        {l.address ? <span className="tape-chip-addr">{l.address}</span> : null}
                        {l.buyerMatches === false && <span className="tape-chip-flag" title={`Capital provider is “${l.lender || 'not set'}” — not ${activeTape ? activeTape.name : 'this provider'}`}>other provider</span>}
                        <button type="button" className="tape-chip-x" aria-label={`Remove ${loanNo(l)}`} onClick={() => toggle(l)}>✕</button>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* 3 — SEARCH ANY LOAN. Not limited to this provider's own list, which is
                   the whole point: "I can include any kind of loans that I want." */}
            <div className="panel" style={{ marginBottom: 12 }}>
              <form className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }} onSubmit={runSearch}>
                <input className="input" style={{ flex: 1, minWidth: 260 }} value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search any loan — loan number, address, borrower name. Paste a list of loan numbers to find them all at once."
                  aria-label="Search loans to add to this tape" />
                <button className="btn" type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
                {results != null && (
                  <button className="btn ghost" type="button" onClick={() => { setResults(null); setQ(''); setSearchNote(''); }}>Clear search</button>
                )}
              </form>
              {searchNote && <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>{searchNote}</p>}

              {results != null && (
                results.length === 0
                  ? <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>No loans matched. Try a loan number, part of the address, or the borrower’s name.</p>
                  : (
                    <>
                      <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="muted small">{results.length} match{results.length === 1 ? '' : 'es'}</span>
                        <div className="spacer" />
                        <button className="btn ghost small" onClick={() => addAll(results)}>Add all {results.length}</button>
                      </div>
                      <LoanTable rows={results} basket={basket} onToggle={toggle} tapeName={activeTape ? activeTape.name : ''} />
                    </>
                  )
              )}
            </div>

            {/* 4 — the provider's own loans, still the default starting point */}
            <div className="panel">
              <div className="row" style={{ alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
                <h3 style={{ margin: 0 }}>
                  Assigned to {activeTape ? activeTape.name : ''} — {loans ? loans.length : 0} loan{(loans && loans.length === 1) ? '' : 's'}
                </h3>
                <div className="spacer" />
                {loans && loans.length > 0 && (
                  <>
                    <button className="btn ghost small" onClick={() => addAll(loans)}>Add all</button>
                    <button className="btn ghost small" onClick={() => removeAll(loans)}>Remove all</button>
                  </>
                )}
              </div>

              {loadingLoans || loans == null ? <p className="muted small">Loading loans…</p> : adminOnly ? (
                <p className="muted small">
                  {activeTape ? activeTape.name : 'This provider'} tapes are admin-only right now — its program isn’t live yet,
                  so only an admin can export them. An admin can export from an individual loan file.
                </p>
              ) : loans.length === 0 ? (
                <p className="muted small">
                  No loans you can export are assigned to {activeTape ? activeTape.fullName : 'this provider'} yet. A loan appears
                  here once it’s registered with the matching program and its capital provider is set to {activeTape ? activeTape.name : 'this provider'}.
                  You can still search for any other loan above and put it on this tape.
                </p>
              ) : (
                <LoanTable rows={loans} basket={basket} onToggle={toggle} tapeName={activeTape ? activeTape.name : ''}
                  onExportRow={(l) => startRow(l.id, activeTape ? activeTape.name : 'tape')} busyRow={busyRow} />
              )}
            </div>
          </>
        )}
      </div>
      {pending && (
        <TapeQuestionsModal
          title={pending.questions.length ? `${activeTape ? activeTape.name : ''} tape — a few details` : `${activeTape ? activeTape.name : ''} tape — confirm current numbers`}
          subtitle={pending.questions.length
            ? (pending.supplementalMissing > 0
                ? "This is a ground-up loan. Fill in these details — they're saved on the file and pre-filled here every time you export."
                : "These details are saved on the file and pre-filled here. Review or change anything, then export.")
            : undefined}
          questions={pending.questions}
          seasoned={pending.seasoned}
          busy={busyRow === pending.loanId}
          onCancel={() => setPending(null)}
          onSubmit={(answers) => exportRow(pending.loanId, pending.tapeName, answers)}
        />
      )}
    </div>
  );
}

/* One table, used by BOTH lists — the provider's own loans and the search results.
   Two copies would drift the moment one gained a column, and the two lists are the
   same decision ("is this loan on the tape?") asked about different rows. */
function LoanTable({ rows, basket, onToggle, tapeName, onExportRow, busyRow }) {
  const allIn = rows.length > 0 && rows.every((l) => basket.has(l.id));
  const someIn = rows.some((l) => basket.has(l.id));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line, #ddd)' }}>
            <th style={{ padding: '6px 8px', width: 32 }}>
              <input type="checkbox"
                ref={(el) => { if (el) el.indeterminate = someIn && !allIn; }}
                checked={allIn}
                onChange={() => rows.forEach((l) => { if (allIn === basket.has(l.id)) onToggle(l); })}
                aria-label="Select all in this list" />
            </th>
            <th style={{ padding: '6px 8px' }}>Loan #</th>
            <th style={{ padding: '6px 8px' }}>Property</th>
            <th style={{ padding: '6px 8px' }}>Borrower</th>
            <th style={{ padding: '6px 8px' }}>Provider</th>
            <th style={{ padding: '6px 8px' }}>Status</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Loan amount</th>
            {onExportRow && <th style={{ padding: '6px 8px' }} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const picked = basket.has(l.id);
            return (
              <tr key={l.id} className={picked ? 'tape-row-on' : undefined} style={{ borderBottom: '1px solid var(--line, #eee)' }}>
                <td style={{ padding: '6px 8px' }}>
                  <input type="checkbox" checked={picked} onChange={() => onToggle(l)}
                    aria-label={`Put ${loanNo(l)} on the ${tapeName} tape`} />
                </td>
                <td style={{ padding: '6px 8px', fontWeight: picked ? 700 : 400 }}>
                  {loanNo(l)}
                  {/* the investor's own number, in the back */}
                  {investorNo(l) && (
                    <div className="small" style={{ fontWeight: 400, color: '#4B585C' }}
                      title="The capital provider’s own loan number for this file">
                      Investor #{investorNo(l)}
                    </div>
                  )}
                </td>
                <td style={{ padding: '6px 8px' }}>{l.address || '—'}</td>
                <td style={{ padding: '6px 8px' }}>{borrower(l) || '—'}</td>
                <td style={{ padding: '6px 8px' }}>
                  {l.lender || <span className="muted">not set</span>}
                  {/* Say it on the row, not after the export fails. */}
                  {l.eligible === false && (
                    <span className="tape-flag" title={l.ineligibleReason}>can’t export</span>
                  )}
                </td>
                <td style={{ padding: '6px 8px' }}>{STATUS_LABEL[l.status] || l.status || '—'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{money(l.loan_amount)}</td>
                {onExportRow && (
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <button className="btn small ghost" disabled={busyRow === l.id} onClick={() => onExportRow(l)}>
                      {busyRow === l.id ? 'Building…' : 'Export'}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
