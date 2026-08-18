// LT PPE — onboard an investor, and load its rate sheet.
//
// THE DEFECT THIS SCREEN CLOSES. Every rate-sheet writer in `ppe/store.js` had zero callers anywhere
// in `src/` until the console routes landed, and until this card there was still nothing a person
// could open: onboarding an investor was an API call. That is the fifth instance in this workstream
// of complete, tested machinery reachable by nobody.
//
// FIVE THINGS THIS SCREEN REFUSES TO DO, each of which would be easier:
//
//   1. IT NEVER SHOWS AN EMPTY LIST AS "NOTHING TO DO". A read that FAILED says so; a read that
//      succeeded and found nothing says that instead. They are different facts and they send a
//      person to different places.
//   2. IT PREVIEWS THE PASTE BEFORE IT IS SENT. `ratesheetPaste.js` reports every line it could not
//      use, with its line number and a reason, and this card renders them ALL. A sheet quietly
//      missing its top rate band is the failure worth spending a screen on.
//   3. IT SAYS WHETHER PUBLISH WILL BE REFUSED BEFORE IT IS PRESSED. The sheet read carries the
//      agreement gate's verdict, so the button is not a coin toss.
//   4. IT NEVER HIDES A CONTROL THE SERVER MIGHT REFUSE. Everything here is admin-only on the
//      server; a hidden button is indistinguishable from a broken one, so the refusal is shown
//      instead — the rule the findings queue on this screen already follows.
//   5. IT NEVER OFFERS TO RECORD AN AGREEMENT RUN. There is no such route on purpose: a typed
//      "agreed on 240 scenarios" would satisfy the gate with nothing compared. Publishing anyway is
//      the OVERRIDE, which asks for a reason and is recorded with the person's name on it.
//
// Dark text on the white PILOT canvas throughout — never a `--ink*` token (a LIGHT paper colour in
// this palette, which renders white-on-white).

import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { parseBasePrices, parseAdjustments, points } from './ratesheetPaste.js';
import { INK, MUTED, SLATE, DANGER, CAUTION, card, h2, sub, eyebrow, input, mono, label } from './ppeStyles.js';
import AgreementRecord from './AgreementRecord.jsx';
import PriceLimitCard from './PriceLimitCard.jsx';

const row = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 };
const field = { flex: '1 1 180px', minWidth: 0 };

/** Every line the parser could not use — all of them, never a "and 12 more". */
function Problems({ problems }) {
  if (!problems || !problems.length) return null;
  return (
    <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'rgba(138,47,47,.06)', border: '1px solid rgba(138,47,47,.25)' }}>
      <div style={{ ...eyebrow, color: DANGER, marginBottom: 6 }}>
        {problems.length} line{problems.length === 1 ? '' : 's'} could not be used
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: SLATE }}>
        {problems.map((p) => (
          <li key={p.line} style={{ marginBottom: 3 }}>
            <strong>Line {p.line}</strong> — {p.why}
            <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: MUTED }}>{p.text}</div>
          </li>
        ))}
      </ul>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: SLATE }}>
        These are listed rather than skipped: a sheet quietly missing a rate band looks exactly like a
        sheet that was loaded correctly. Fix them in the paste and read it again.
      </p>
    </div>
  );
}

export default function RateSheetConsole() {
  const [investors, setInvestors] = useState(null);
  const [investorsError, setInvestorsError] = useState('');
  const [programs, setPrograms] = useState(null);
  const [programsError, setProgramsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const loadLists = useCallback(() => {
    ltApi.ppeInvestors()
      .then((r) => { setInvestors(r); setInvestorsError(''); })
      // Rule 1: a failed read is SAID. Falling back to [] renders as "no investors yet", which is
      // the one thing it must never be mistaken for.
      .catch((e) => { setInvestors(null); setInvestorsError(e.message || 'Could not read the investors.'); });
    ltApi.ppePrograms()
      .then((r) => { setPrograms(r); setProgramsError(''); })
      .catch((e) => { setPrograms(null); setProgramsError(e.message || 'Could not read the programs.'); });
  }, []);
  useEffect(loadLists, [loadLists]);

  // ---- create an investor -------------------------------------------------
  const [invCode, setInvCode] = useState('');
  const [invName, setInvName] = useState('');
  const [invError, setInvError] = useState('');

  const createInvestor = async () => {
    setBusy(true); setInvError(''); setNote('');
    try {
      const r = await ltApi.ppeCreateInvestor({ code: invCode.trim(), name: invName.trim() });
      setInvCode(''); setInvName('');
      setNote(`Added ${r.investor.name}.`);
      loadLists();
    } catch (e) {
      // The server names WHICH rule was broken — a blank code, a name already taken, not an
      // administrator. A generic "that didn't work" would leave a person unable to tell them apart.
      setInvError(e.message || 'That was refused.');
    } finally { setBusy(false); }
  };

  // ---- create a program ---------------------------------------------------
  const [prgInvestor, setPrgInvestor] = useState('');
  const [prgCode, setPrgCode] = useState('');
  const [prgName, setPrgName] = useState('');
  const [prgError, setPrgError] = useState('');

  const createProgram = async () => {
    setBusy(true); setPrgError(''); setNote('');
    try {
      const r = await ltApi.ppeCreateProgram({ investorId: prgInvestor, code: prgCode.trim(), name: prgName.trim() });
      setPrgCode(''); setPrgName('');
      setNote(`Added ${r.program.name}. ${r.note || ''}`.trim());
      loadLists();
    } catch (e) { setPrgError(e.message || 'That was refused.'); } finally { setBusy(false); }
  };

  // ---- the sheet ----------------------------------------------------------
  const [sheetProgram, setSheetProgram] = useState('');
  const [sheet, setSheet] = useState(null);
  const [sheetError, setSheetError] = useState('');

  const openDraft = async () => {
    setBusy(true); setSheetError(''); setNote('');
    try {
      const r = await ltApi.ppeCreateRateSheet(sheetProgram, {});
      const full = await ltApi.ppeRateSheet(r.version.id);
      setSheet(full);
      setNote(`Opened draft version ${r.version.versionNo}.`);
    } catch (e) { setSheetError(e.message || 'Could not open a draft.'); } finally { setBusy(false); }
  };

  const reloadSheet = async (id) => {
    try { setSheet(await ltApi.ppeRateSheet(id)); setSheetError(''); } catch (e) { setSheetError(e.message || 'Could not read the sheet.'); }
  };

  // ---- the pastes ---------------------------------------------------------
  const [gridText, setGridText] = useState('');
  const [adjText, setAdjText] = useState('');
  const grid = parseBasePrices(gridText);
  const adj = parseAdjustments(adjText);

  const saveGrid = async () => {
    setBusy(true); setSheetError(''); setNote('');
    try {
      const r = await ltApi.ppeSetBasePrices(sheet.version.id, grid.rows);
      setNote(`Loaded ${r.rows} price${r.rows === 1 ? '' : 's'}.`);
      setGridText('');
      await reloadSheet(sheet.version.id);
    } catch (e) { setSheetError(e.message || 'The grid was refused.'); } finally { setBusy(false); }
  };

  const saveAdjustments = async () => {
    setBusy(true); setSheetError(''); setNote('');
    try {
      const r = await ltApi.ppeSetAdjustments(sheet.version.id, adj.rows);
      setNote(`Loaded ${r.rows} adjustment${r.rows === 1 ? '' : 's'}.`);
      setAdjText('');
      await reloadSheet(sheet.version.id);
    } catch (e) { setSheetError(e.message || 'The adjustments were refused.'); } finally { setBusy(false); }
  };

  // ---- publish, and the gate ---------------------------------------------
  const [refusal, setRefusal] = useState(null);
  const [overrideReason, setOverrideReason] = useState('');

  const publish = async (override) => {
    setBusy(true); setSheetError(''); setNote('');
    try {
      const body = override ? { override: true, overrideReason } : {};
      const r = await ltApi.ppePublishRateSheet(sheet.version.id, body);
      setRefusal(null); setOverrideReason('');
      setNote(`Published version ${r.version.versionNo}. Quotes on this program price from it now.`);
      await reloadSheet(sheet.version.id);
    } catch (e) {
      // A 409 from the gate is the EXPECTED answer on a sheet nobody has measured, not a breakage —
      // so it is shown as the gate speaking, with the two ways forward the server itself named.
      setRefusal({ message: e.message || 'Publishing was refused.' });
    } finally { setBusy(false); }
  };

  // ---- the two checks, and they are not interchangeable -------------------
  //
  // COVERAGE is free and offline — which of this sheet's own cells can nothing ever reach. THE RUN
  // prices the whole canonical battery against Lender Price and records the verdict; it costs money,
  // and it is the only thing that can open the publish gate by measurement. Both are shown, in that
  // order, with the cost said out loud: a person about to spend a battery on a sheet with a
  // transposed band should be told there is a free check first.
  const [coverage, setCoverage] = useState(null);
  const [coverageError, setCoverageError] = useState('');
  const [run, setRun] = useState(null);
  const [runError, setRunError] = useState('');

  const checkCoverage = async () => {
    setBusy(true); setCoverageError(''); setCoverage(null); setNote('');
    try { setCoverage(await ltApi.ppeRateSheetCoverage(sheet.version.id)); } catch (e) {
      setCoverageError(e.message || 'The cell check could not run.');
    } finally { setBusy(false); }
  };

  const runAgreement = async () => {
    setBusy(true); setRunError(''); setRun(null); setNote('');
    try {
      const r = await ltApi.ppeRunRateSheetAgreement(sheet.version.id);
      setRun(r);
      // The gate's verdict rides on the sheet read, so the card above must be re-read or it would go
      // on showing "never measured" beside a run that just finished.
      await reloadSheet(sheet.version.id);
    } catch (e) {
      // A 503 here is the ORDINARY state until the Lender Price login is rotated, not a breakage, and
      // it is shown as the upstream speaking rather than as the button being broken.
      setRunError(e.message || 'The agreement run could not start.');
    } finally { setBusy(false); }
  };

  const programList = (programs && Array.isArray(programs.programs)) ? programs.programs : [];
  const investorList = (investors && Array.isArray(investors.investors)) ? investors.investors : [];

  return (
    <div style={card}>
      <h2 style={h2}>Onboard an investor, and load its rate sheet</h2>
      <p style={sub}>
        An investor holds programs; a program holds rate sheets; a sheet is a grid of prices plus its
        adjustments and its price limits. A new sheet is a DRAFT and can be edited freely. Publishing
        is what makes it the sheet every quote on that program prices from — and publishing asks the
        Lender Price agreement gate first.
      </p>
      {note && <p style={{ ...sub, color: '#256168' }}>{note}</p>}

      {/* ---- investor ---- */}
      <div style={{ ...eyebrow, marginBottom: 6 }}>1 · The investor</div>
      {investorsError && <p style={{ ...sub, color: DANGER }}>{investorsError}</p>}
      {!investorsError && investors && investorList.length === 0 && (
        <p style={{ ...sub, color: CAUTION }}>No investors yet — the first one goes in here.</p>
      )}
      <div style={row}>
        <div style={field}>
          <label style={label} htmlFor="rsc-inv-code">Short code</label>
          <input id="rsc-inv-code" style={input} value={invCode} onChange={(e) => setInvCode(e.target.value)} placeholder="DHVN" />
        </div>
        <div style={{ ...field, flex: '2 1 260px' }}>
          <label style={label} htmlFor="rsc-inv-name">Full name</label>
          <input id="rsc-inv-name" style={input} value={invName} onChange={(e) => setInvName(e.target.value)} placeholder="Deephaven Mortgage" />
        </div>
        <button className="btn" disabled={busy} onClick={createInvestor}>Add investor</button>
      </div>
      {invError && <p style={{ ...sub, color: DANGER }}>{invError}</p>}

      {/* ---- program ---- */}
      <div style={{ ...eyebrow, margin: '14px 0 6px' }}>2 · The program</div>
      <div style={row}>
        <div style={{ ...field, flex: '2 1 240px' }}>
          <label style={label} htmlFor="rsc-prg-inv">Investor</label>
          <select id="rsc-prg-inv" style={input} value={prgInvestor} onChange={(e) => setPrgInvestor(e.target.value)}>
            <option value="">Choose…</option>
            {investorList.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label} htmlFor="rsc-prg-code">Short code</label>
          <input id="rsc-prg-code" style={input} value={prgCode} onChange={(e) => setPrgCode(e.target.value)} placeholder="DSCR30" />
        </div>
        <div style={{ ...field, flex: '2 1 220px' }}>
          <label style={label} htmlFor="rsc-prg-name">Full name</label>
          <input id="rsc-prg-name" style={input} value={prgName} onChange={(e) => setPrgName(e.target.value)} placeholder="DSCR 30yr fixed" />
        </div>
        <button className="btn" disabled={busy || !prgInvestor} onClick={createProgram}>Add program</button>
      </div>
      {prgError && <p style={{ ...sub, color: DANGER }}>{prgError}</p>}

      {/* ---- the sheet ---- */}
      <div style={{ ...eyebrow, margin: '14px 0 6px' }}>3 · The rate sheet</div>
      {programsError && <p style={{ ...sub, color: DANGER }}>{programsError}</p>}
      <div style={row}>
        <div style={{ ...field, flex: '3 1 300px' }}>
          <label style={label} htmlFor="rsc-sheet-prg">Program</label>
          <select id="rsc-sheet-prg" style={input} value={sheetProgram} onChange={(e) => setSheetProgram(e.target.value)}>
            <option value="">Choose…</option>
            {programList.map((p) => (
              <option key={p.id} value={p.id}>{p.investorName || p.investorCode || '—'} · {p.name || p.code}</option>
            ))}
          </select>
        </div>
        <button className="btn" disabled={busy || !sheetProgram} onClick={openDraft}>Open a new draft</button>
      </div>
      {sheetError && <p style={{ ...sub, color: DANGER }}>{sheetError}</p>}

      {sheet && (
        <div style={{ borderTop: '1px solid rgba(20,27,34,.10)', paddingTop: 12, marginTop: 4 }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 10 }}>
            <strong style={{ color: INK, fontSize: 14 }}>Version {sheet.version.versionNo}</strong>
            <span style={{ fontSize: 13, color: MUTED }}>{sheet.version.status}</span>
            <span style={{ fontSize: 13, color: MUTED }}>
              {sheet.basePrices.length} price{sheet.basePrices.length === 1 ? '' : 's'} ·{' '}
              {sheet.adjustments.length} adjustment{sheet.adjustments.length === 1 ? '' : 's'} ·{' '}
              {sheet.priceLimit ? 'limits set' : 'no limits yet'}
            </span>
          </div>

          {!sheet.editable && (
            <p style={{ ...sub, color: CAUTION }}>
              This version is {sheet.version.status}, so its grid can no longer be edited — live quotes
              price from it. Open a NEW draft on the same program instead; a published sheet is
              superseded by a new version, never rewritten underneath the quotes using it.
            </p>
          )}

          {sheet.editable && (
            <>
              <label style={label} htmlFor="rsc-grid">
                Prices — paste rate, lock days, price (and an optional product) straight from the sheet
              </label>
              <textarea id="rsc-grid" style={mono} value={gridText} onChange={(e) => setGridText(e.target.value)}
                placeholder={'7.000\t30\t101.500\n7.125\t30\t102.850'} />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: SLATE }}>
                  {grid.rows.length} price{grid.rows.length === 1 ? '' : 's'} read
                  {grid.headerSkipped ? ' (header row skipped)' : ''}
                </span>
                <button className="btn" disabled={busy || !grid.rows.length || grid.problems.length > 0} onClick={saveGrid}>
                  Load these prices
                </button>
                {grid.problems.length > 0 && (
                  <span style={{ fontSize: 12, color: DANGER }}>Fix the lines below first — nothing is loaded while any line is unreadable.</span>
                )}
              </div>
              <Problems problems={grid.problems} />

              <label style={{ ...label, marginTop: 14 }} htmlFor="rsc-adj">
                Adjustments — code, dimension (fico / ltv / dscr), band start, band end, points
              </label>
              <textarea id="rsc-adj" style={mono} value={adjText} onChange={(e) => setAdjText(e.target.value)}
                placeholder={'dscr_115\tdscr\t1.000\t1.250\t0.250'} />
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: SLATE }}>
                  {adj.rows.length} adjustment{adj.rows.length === 1 ? '' : 's'} read
                  {adj.headerSkipped ? ' (header row skipped)' : ''}
                </span>
                <button className="btn" disabled={busy || !adj.rows.length || adj.problems.length > 0} onClick={saveAdjustments}>
                  Load these adjustments
                </button>
              </div>
              <Problems problems={adj.problems} />
            </>
          )}

          {/* ---- the sheet's MONEY RULES, and the control that had no button ---- */}
          <PriceLimitCard
            version={sheet.version}
            priceLimit={sheet.priceLimit}
            history={sheet.priceLimitHistory}
            editable={sheet.editable}
            status={sheet.version.status}
            onSaved={() => reloadSheet(sheet.version.id)}
          />

          {/* ---- the two checks: the free one first, then the paid one ---- */}
          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(20,27,34,.03)', border: '1px solid rgba(20,27,34,.10)' }}>
            <div style={{ ...eyebrow, marginBottom: 6 }}>Check this sheet</div>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: SLATE }}>
              Two different questions. <strong>Its own cells</strong> asks whether any band on this sheet
              is one no loan can ever land in — it is free, it runs here, and a transposed band is worth
              fixing before anything is spent. <strong>Measure against Lender Price</strong> prices the
              whole battery at the vendor and records the verdict; that is what opens the publish gate
              without an override, and it costs a real battery every time it is pressed.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn ghost" disabled={busy} onClick={checkCoverage}>Check its own cells (free)</button>
              <button className="btn ghost" disabled={busy} onClick={runAgreement}>Measure against Lender Price</button>
            </div>

            {coverageError && <p style={{ margin: '10px 0 0', fontSize: 13, color: DANGER }}>{coverageError}</p>}
            {coverage && (
              <div style={{ marginTop: 10, fontSize: 13, color: SLATE }}>
                <div>
                  {coverage.rules.reachable} of {coverage.rules.total} cell{coverage.rules.total === 1 ? '' : 's'} reached
                  and applied, over {coverage.scenarios.generated} generated scenario{coverage.scenarios.generated === 1 ? '' : 's'}.
                </div>
                {coverage.rules.unreachable.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: DANGER }}>
                    {coverage.rules.unreachable.map((u) => (
                      <li key={u.code || u.reason}><strong>{u.code || '(unnamed cell)'}</strong> — {u.reason}</li>
                    ))}
                  </ul>
                )}
                {coverage.rules.disagreed.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: CAUTION }}>
                    {coverage.rules.disagreed.map((d) => (
                      <li key={d.code || d.reason}><strong>{d.code || '(unnamed cell)'}</strong> — {d.reason}</li>
                    ))}
                  </ul>
                )}
                {/* A scenario our own engine cannot price is a defect in its own right, so it is shown
                    here rather than left to be inferred from a coverage number. */}
                {coverage.scenarios.errorCount > 0 && (
                  <div style={{ marginTop: 6, color: DANGER }}>
                    {coverage.scenarios.errorCount} scenario{coverage.scenarios.errorCount === 1 ? '' : 's'} could
                    not be priced by our own engine — for example: {coverage.scenarios.errors[0].error}
                  </div>
                )}
                <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED }}>{coverage.note}</p>
              </div>
            )}

            {runError && (
              <p style={{ margin: '10px 0 0', fontSize: 13, color: CAUTION }}>
                {runError}
                {/* The ordinary state until the vendor login is rotated — said as the upstream
                    speaking, never as this button being broken. */}
              </p>
            )}
            {run && (
              <div style={{ marginTop: 10, fontSize: 13, color: SLATE }}>
                <div>
                  Measured {run.scenarios} scenario{run.scenarios === 1 ? '' : 's'}:{' '}
                  {run.summary.agreed} agreed, {run.summary.disagreed} disagreed, {run.summary.errors} errored,{' '}
                  {run.summary.comparable} comparable.
                  {run.truncated > 0 && ` ${run.truncated} scenario${run.truncated === 1 ? '' : 's'} were not run (over the per-run limit).`}
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: run.gate.proven ? SLATE : CAUTION }}>{run.gate.message}</p>
                {run.recorded === false && (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: DANGER }}>
                    The verdict was NOT recorded ({run.recordError}), so the publish gate still reads this
                    sheet as unmeasured.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ---- the gate, said BEFORE Publish is pressed ---- */}
          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(20,27,34,.03)', border: '1px solid rgba(20,27,34,.10)' }}>
            <div style={{ ...eyebrow, marginBottom: 6 }}>Lender Price agreement</div>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: SLATE }}>
              {sheet.agreement ? sheet.agreement.message : 'The agreement record could not be read.'}
            </p>

            {/* THE EVIDENCE, not just the verdict. The one-line message above says whether the sheet may
                be published; this says WHICH scenarios disagreed and WHERE, which is the only thing that
                tells somebody which cell to fix. It was stored from the first paid run and displayed
                nowhere — `ppeRateSheetAgreement` had no caller at all. `reloadKey` re-reads it after a
                measurement so the panel can never sit on a verdict the run above just replaced. */}
            <AgreementRecord versionId={sheet.version.id} reloadKey={run ? run.recordedAt || 'ran' : ''} />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn" disabled={busy || sheet.version.status !== 'draft'} onClick={() => publish(false)}>
                Publish
              </button>
              {sheet.agreement && !sheet.agreement.proven && (
                <span style={{ fontSize: 12, color: CAUTION }}>
                  This will be refused until the sheet has been measured — the button is left enabled so
                  the reason is shown rather than hidden.
                </span>
              )}
            </div>

            {refusal && (
              <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'rgba(138,47,47,.06)', border: '1px solid rgba(138,47,47,.25)' }}>
                <p style={{ margin: '0 0 8px', fontSize: 13, color: INK }}>{refusal.message}</p>
                <p style={{ margin: '0 0 8px', fontSize: 12, color: SLATE }}>
                  Either run the Lender Price agreement harness against this sheet — that records a run,
                  and if it agrees the gate opens on its own — or publish it anyway and say why. An
                  override is recorded against this version with your name on it, and it never counts as
                  proof the sheet agrees. A run cannot be typed in here, deliberately: a typed result
                  would satisfy the gate with nothing compared.
                </p>
                <label style={label} htmlFor="rsc-override">Why publish it unmeasured?</label>
                <input id="rsc-override" style={input} value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. onboarding before the harness has credentials" />
                <button className="btn ghost" style={{ marginTop: 8 }}
                  disabled={busy || overrideReason.trim().length < 8}
                  onClick={() => publish(true)}>
                  Publish anyway, and record why
                </button>
              </div>
            )}
          </div>

          {sheet.basePrices.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 13, color: SLATE, cursor: 'pointer' }}>
                What is on this sheet now ({sheet.basePrices.length} prices)
              </summary>
              <div style={{ maxHeight: 220, overflowY: 'auto', overflowX: 'auto', marginTop: 8 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 13, color: SLATE }}>
                  <thead>
                    <tr>
                      {['Rate', 'Lock', 'Product', 'Price'].map((c) => (
                        <th key={c} style={{ textAlign: 'left', padding: '4px 12px 4px 0', color: MUTED, fontWeight: 600 }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.basePrices.map((b, i) => (
                      <tr key={i}>
                        {/* milli read back the way a person writes it — printing the raw value would
                            report a 101.500 price as "101500". */}
                        <td style={{ padding: '3px 12px 3px 0', fontVariantNumeric: 'tabular-nums' }}>{points(b.note_rate_milli_pct)}</td>
                        <td style={{ padding: '3px 12px 3px 0', fontVariantNumeric: 'tabular-nums' }}>{b.lock_days}</td>
                        <td style={{ padding: '3px 12px 3px 0' }}>{b.product || '—'}</td>
                        <td style={{ padding: '3px 12px 3px 0', fontVariantNumeric: 'tabular-nums' }}>{points(b.price_milli)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
