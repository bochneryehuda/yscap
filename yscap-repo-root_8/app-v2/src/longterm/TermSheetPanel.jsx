/* ──────────────────────────────────────────────────────────────────────────
   LONG-TERM — THE TERM SHEET CONTROLS ON THE PRICING BOARD.

   Two things, and they are deliberately separate actions: put a quote in the
   COMPARISON (which spans searches — the owner's *"you do one search and click
   start comparison, you check-mark two programs from that search, and then you
   go back into another search"*), or ISSUE a term sheet from what is collected.

   ⛔ THIS SCREEN COMPUTES NO MONEY. Every figure on a term sheet is worked out
   by the SERVER from the compensation plan the server itself resolved; the board
   posts the vendor's raw price and the officer's choices and nothing else. That
   is what makes the officer's copy and the borrower's copy provably the same
   document — and it is why a preview is a round trip rather than a local render.

   ⛔ RAW PRICING CANNOT BE ISSUED. The control says so in place rather than
   disappearing: a button that vanishes teaches nobody why.

   ⛔ EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. The palette's `--ink*` tokens are
   LIGHT paper colours whose names lie; a `color: var(--ink)` renders white on
   white. These come from `ppeStyles`, which is the one place they are defined.
   ────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import ltApi from './api.js';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, PAPER, CAUTION } from './ppeStyles.js';

const NUM = { fontVariantNumeric: 'tabular-nums' };

const btn = (kind) => ({
  border: kind === 'primary' ? `1px solid ${GOLD}` : '1px solid rgba(20,27,34,.18)',
  background: kind === 'primary' ? GOLD : '#fff',
  color: kind === 'primary' ? '#fff' : SLATE,
  borderRadius: 8,
  padding: '6px 11px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  minHeight: 30,
});

/**
 * A text box on this panel. Every colour is an explicit DARK on white — the
 * `--ink*` tokens are LIGHT paper colours in this palette and would render the
 * typed text white on white. 16px on purpose: iOS Safari zooms the whole page on
 * focus of any control under 16px, which throws a panel off screen on a phone.
 */
const field = () => ({
  width: '100%', boxSizing: 'border-box', marginTop: 3,
  border: '1px solid rgba(20,27,34,.18)', borderRadius: 8, padding: '7px 9px',
  fontSize: 16, color: INK, background: '#fff',
});
const fieldLabel = () => ({ fontSize: 11.5, color: MUTED, fontWeight: 600 });

/**
 * THE THREE DOCUMENTS, in the officer's words. Owner-directed 2026-08-30:
 * *"A term sheet should only have one option. It should be a comparison sheet,
 * which should be the same scenario, different options. There should be a
 * scenario sheet, which is different scenarios and different options broken
 * down."* The kind is DERIVED on the server from the options collected; this
 * only names what the server decided, so the strip can never promise a document
 * the issue then refuses to write.
 */
const KIND_TITLE = {
  term_sheet: 'Term sheet',
  comparison: 'Comparison sheet',
  scenario_comparison: 'Scenario comparison',
};
const KIND_BLURB = {
  term_sheet: 'One program, stated in full — it expires, and it can be signed.',
  comparison: 'The same loan priced several ways · everything is compared against the one you mark',
  scenario_comparison: 'Different scenarios side by side · everything is compared against the one you mark',
};
const KIND_ACTION = {
  term_sheet: 'term sheet',
  comparison: 'comparison sheet',
  scenario_comparison: 'scenario comparison',
};
/** The gate's keys, in the words the officer sees on their own screen. */
const GATE_WORDS = {
  rentMonthly: 'the monthly rent',
  taxMonthly: 'the monthly property taxes',
  insuranceMonthly: 'the monthly insurance',
  dscr: 'the calculated DSCR',
  borrowerName: "the borrower's name",
  propertyAddress: 'the full property address',
};

/** A note the officer can act on. Never a bare code. */
function Note({ tone, children }) {
  if (!children) return null;
  const color = tone === 'bad' ? '#8A2A2A' : (tone === 'warn' ? CAUTION : MUTED);
  return <div style={{ fontSize: 11.5, color, marginTop: 6, lineHeight: 1.45 }}>{children}</div>;
}

/**
 * The two per-quote controls, rendered inside a quote's own detail panel.
 *
 * `sel` is the selection the board has already assembled — the raw price, the
 * scenario, the consumer label, the mode and the waive. It is passed WHOLE to
 * the server; this component neither builds nor checks it.
 */
export function QuoteTermSheetActions({ sel, enabled, mode, onAdded, cartCount }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  if (!enabled) return null;

  const issuable = mode === 'borrowerPaid' || mode === 'lenderPaid';

  async function add() {
    setBusy('add'); setNote(null);
    try {
      const r = await ltApi.termSheetCartAdd(sel);
      setNote({ tone: 'ok', text: `Added — ${(r && r.position != null ? r.position + 1 : (cartCount || 0) + 1)} in the comparison.` });
      if (onAdded) onAdded();
    } catch (e) {
      // The server's own sentence, which names what is wrong and what to do
      // about it. A generic "could not add" sends nobody anywhere.
      setNote({ tone: 'bad', text: (e && (e.message || e.error)) || 'Could not add that option.' });
    } finally { setBusy(null); }
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(20,27,34,.10)' }}>
      {!issuable ? (
        <div style={{ fontSize: 12, color: CAUTION, lineHeight: 1.5 }}>
          Raw pricing is the vendor&rsquo;s own numbers before our compensation, so it never goes
          on a term sheet. Switch to borrower-paid or lender-paid to build one.
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" style={btn()} disabled={busy === 'add'} onClick={add}>
            {busy === 'add' ? 'Adding…' : 'Add to comparison'}
          </button>
          <span style={{ fontSize: 11.5, color: MUTED }}>
            {cartCount ? `${cartCount} collected` : 'Collect options across searches, then issue one sheet.'}
          </span>
        </div>
      )}
      <Note tone={note && note.tone}>{note && note.text}</Note>
    </div>
  );
}

/**
 * The comparison strip: what has been collected, which option everything is
 * compared against, and the one button that issues the sheet.
 *
 * It SURVIVES A SEARCH because it lives on the server — reloading the board, or
 * running a completely different scenario, does not empty it. That is the whole
 * point of the cart the owner described.
 */
export function ComparisonStrip({ open, cart, members, onChange, onIssued, busy: outerBusy }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [issued, setIssued] = useState(null);
  // ⛔ THE OFFICER ISSUING IT PUTS THE PERSON AND THE PROPERTY ON IT. The owner
  // asked for exactly this: *"We need to give the availability for the one
  // issuing it to put in the full property address and the person's name as
  // well."* A TERM SHEET is refused without them — it is a formal offer with a
  // signature block, and a signature line over a blank "Prepared for" is a
  // defective document. A comparison needs neither.
  const [prepared, setPrepared] = useState({ borrowerName: '', propertyAddress: '' });
  // A program the white-label sheet has not named yet, named here by the officer.
  const [names, setNames] = useState({});
  const [plan, setPlan] = useState(null);   // { docKind, gate } from the server

  const anchor = cart && Number.isFinite(cart.anchor_position) ? cart.anchor_position : 0;

  const remove = useCallback(async (id) => {
    setBusy(id); setNote(null);
    try { await ltApi.termSheetCartRemove(id); if (onChange) onChange(); }
    catch (e) { setNote({ tone: 'bad', text: (e && e.message) || 'Could not remove that option.' }); }
    finally { setBusy(null); }
  }, [onChange]);

  const setAnchor = useCallback(async (position) => {
    setBusy(`a${position}`); setNote(null);
    try { await ltApi.termSheetCartAnchor(position); if (onChange) onChange(); }
    catch (e) { setNote({ tone: 'bad', text: (e && e.message) || 'Could not set the comparison.' }); }
    finally { setBusy(null); }
  }, [onChange]);

  // ONE definition of what is sent, so what the preview judged and what the
  // issue writes can never be two different documents.
  const selectionsOf = useCallback(() => members.map((m) => ({
    label: m.label,
    consumerLabel: (m.program || {}).consumerLabel,
    manualProgramName: names[m.id] || null,
    product: (m.program || {}).product,
    mode: m.mode,
    waiveLenderFees: m.waive_lender_fees,
    ratePct: (m.program || {}).ratePct,
    rawPrice: (m.program || {}).rawPrice,
    vendorMonthlyPI: (m.program || {}).monthlyPI,
    scenario: m.scenario,
    pricedAt: m.priced_at,
  })), [members, names]);

  // ⛔ WHICH DOCUMENT THIS IS, AND WHAT IS STILL MISSING, COME FROM THE SERVER.
  // The kind is derived from the options and the gate is the same function the
  // issue enforces, so the strip can never promise a term sheet the issue then
  // refuses. Asked when the collected options change — not on every keystroke in
  // the two text boxes, whose own emptiness is visible without a round trip.
  useEffect(() => {
    let dead = false;
    if (!open || !members.length) { setPlan(null); return undefined; }
    // DEBOUNCED, because `names` is in the dependencies and it changes on every
    // keystroke in the manual program-name box — an undebounced effect would
    // post a preview per character typed.
    const t = setTimeout(async () => {
      try {
        const r = await ltApi.termSheetPreview({ selections: selectionsOf(), anchorIndex: anchor });
        if (!dead) setPlan({ docKind: r.docKind, gate: r.gate, expiryHours: r.expiryHours });
      } catch (e) {
        // A preview that cannot be built is not a refusal to issue — the issue
        // will say so itself, in the server's own words.
        if (!dead) setPlan({ error: (e && (e.message || e.error)) || null });
      }
    }, 350);
    return () => { dead = true; clearTimeout(t); };
  }, [open, members, names, anchor, selectionsOf]);

  async function issue() {
    setBusy('issue'); setNote(null);
    try {
      const r = await ltApi.termSheetIssue({
        selections: selectionsOf(),
        anchorIndex: anchor,
        cartId: cart && cart.id,
        prepared: {
          borrowerName: prepared.borrowerName || null,
          propertyAddress: prepared.propertyAddress || null,
        },
      });
      setIssued(r);
      if (onIssued) onIssued(r);
      if (onChange) onChange();
    } catch (e) {
      setNote({ tone: 'bad', text: (e && (e.message || e.error)) || 'Could not issue that term sheet.' });
    } finally { setBusy(null); }
  }

  if (!open) return null;

  if (issued) {
    return (
      <div style={{ background: '#fff', border: `1px solid ${GOLD}`, borderRadius: 10, padding: 14, marginTop: 10 }}>
        <div style={{ fontSize: 13, color: INK, fontWeight: 700 }}>Term sheet issued</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: GOLD_TEXT, ...NUM, marginTop: 4 }}>{issued.code}</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
          Keep this ID. Anyone here can pull up this exact sheet with it — what was priced, what
          was quoted, and the day it was issued.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button type="button" style={btn('primary')} onClick={() => ltApi.termSheetPdf(issued.code)}>
            Download the PDF
          </button>
          <button type="button" style={btn()} onClick={() => setIssued(null)}>Start another</button>
        </div>
      </div>
    );
  }

  const n = members.length;
  const kind = (plan && plan.docKind) || (n > 1 ? 'comparison' : 'term_sheet');
  const isTermSheet = kind === 'term_sheet';
  // The scenario-side blockers come from the server's own gate; the two name
  // fields are judged here only so typing into them clears the line without a
  // round trip. The ISSUE is refused by the server either way — this is what the
  // officer reads, not what decides.
  const serverMissing = (plan && plan.gate && !plan.gate.ok ? plan.gate.missing : []) || [];
  const stillMissing = isTermSheet
    ? serverMissing
      .filter((k) => (k === 'borrowerName' ? !prepared.borrowerName.trim()
        : k === 'propertyAddress' ? !prepared.propertyAddress.trim() : true))
      .map((k) => GATE_WORDS[k] || k)
    : [];

  return (
    <div style={{ background: PAPER, border: '1px solid rgba(20,27,34,.12)', borderRadius: 10, padding: 12, marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{KIND_TITLE[kind] || 'Comparison'}</div>
        <div style={{ fontSize: 11.5, color: MUTED }}>
          {n === 0 ? 'Nothing collected yet.' : KIND_BLURB[kind] || `${n} options`}
        </div>
      </div>

      {n > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {members.map((m) => {
            const p = m.program || {};
            const isAnchor = m.position === anchor;
            return (
              <div key={m.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                background: '#fff', border: `1px solid ${isAnchor ? GOLD : 'rgba(20,27,34,.10)'}`,
                borderRadius: 8, padding: '7px 10px',
              }}>
                {/* WHICH OPTION EVERYTHING IS MEASURED AGAINST — the one choice this
                    sheet is really asking for, so on a phone it is given a real target
                    to hit (`.ltq-tap`, phone-only). At `padding: 0` it rendered 12px
                    tall, which is a quarter of what a thumb can reliably land on. */}
                <button type="button" onClick={() => setAnchor(m.position)} disabled={busy === `a${m.position}`}
                  className="ltq-tap"
                  title={isAnchor ? 'Everything is compared against this one' : 'Compare everything against this one'}
                  style={{
                    border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
                    fontSize: 11.5, fontWeight: 700, color: isAnchor ? GOLD_TEXT : MUTED, minWidth: 76, textAlign: 'left',
                  }}>
                  {isAnchor ? '● compared against' : '○ compare to'}
                </button>
                <span style={{ fontSize: 13, color: INK, fontWeight: 600 }}>{m.label || '—'}</span>
                <span style={{ fontSize: 12, color: SLATE, ...NUM }}>
                  {p.ratePct != null ? `${Number(p.ratePct).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%` : '—'}
                </span>
                <span style={{ fontSize: 11.5, color: MUTED }}>{p.consumerLabel || ''}</span>
                <span style={{ fontSize: 11.5, color: MUTED }}>
                  {m.mode === 'lenderPaid' ? 'lender paid' : 'borrower paid'}{m.waive_lender_fees ? ' · fees waived' : ''}
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" style={{ ...btn(), padding: '4px 8px', minHeight: 26 }}
                  disabled={busy === m.id} onClick={() => remove(m.id)}>Remove</button>
                {!p.consumerLabel && (
                  // ⛔ THE PROGRAM HAS NO CLIENT-FACING NAME, SO THE OFFICER GIVES
                  // IT ONE — and is warned off the one name they must not use.
                  // The warning is advice; the REFUSAL is the control, and it
                  // lives on the server, where a name that names an investor is
                  // checked against the registry rather than against a memory.
                  <div style={{ flexBasis: '100%', marginTop: 6 }}>
                    <div style={{ fontSize: 11.5, color: CAUTION, lineHeight: 1.5 }}>
                      This program has no client-facing name yet, so it cannot go on a sheet as it stands.
                      Give it one a borrower can read — <strong>never the investor&rsquo;s own name</strong>.
                    </div>
                    <input
                      value={names[m.id] || ''}
                      onChange={(e) => setNames((s) => ({ ...s, [m.id]: e.target.value }))}
                      placeholder="e.g. 30-Year Rental Select"
                      style={field()}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {n > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(20,27,34,.10)' }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: GOLD_TEXT, letterSpacing: '.06em' }}>
            WHO IT IS FOR
          </div>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(min(16rem, 100%), 1fr))', marginTop: 6 }}>
            <label style={{ display: 'block' }}>
              <span style={fieldLabel()}>Borrower or entity name</span>
              <input value={prepared.borrowerName} style={field()}
                onChange={(e) => setPrepared((s) => ({ ...s, borrowerName: e.target.value }))}
                placeholder="Riverbend Holdings LLC" />
            </label>
            <label style={{ display: 'block' }}>
              <span style={fieldLabel()}>Full property address</span>
              <input value={prepared.propertyAddress} style={field()}
                onChange={(e) => setPrepared((s) => ({ ...s, propertyAddress: e.target.value }))}
                placeholder="218 Forest Avenue, Lakewood, NJ 08701" />
            </label>
          </div>
          {isTermSheet && (
            <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
              A term sheet states one program in full, expires in {plan && plan.expiryHours ? `${plan.expiryHours} hours` : '24 hours'}, and
              carries a signature block — so it needs both of these and the full scenario.
            </div>
          )}
          {stillMissing.length > 0 && (
            <div style={{ fontSize: 12, color: CAUTION, marginTop: 8, lineHeight: 1.55 }}>
              <strong>Still needed for a term sheet:</strong> {stillMissing.join(', ')}.
              {' '}Add the rest to the scenario, or collect a second option and export a comparison instead —
              a comparison simply leaves out the taxes, the insurance and the total monthly payment.
            </div>
          )}
        </div>
      )}

      {/* ⛔ THE REFUSAL IS SHOWN BEFORE THE BUTTON IS PRESSED, NOT AFTER. The
          server refuses an option it cannot name on a borrower's document, and
          the officer finding that out only when they click has already told
          somebody the sheet was on its way. The name box above is where they fix
          it; this is the sentence that says so, in the server's own words. */}
      {plan && plan.error && <Note tone="warn">{plan.error}</Note>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <button type="button" style={btn('primary')} disabled={!n || busy === 'issue' || outerBusy} onClick={issue}>
          {busy === 'issue' ? 'Issuing…' : `Issue the ${KIND_ACTION[kind] || 'term sheet'}`}
        </button>
        {n > 0 && (
          <button type="button" style={btn()} disabled={!!busy}
            onClick={async () => { await ltApi.termSheetCartClear(); if (onChange) onChange(); }}>
            Clear
          </button>
        )}
      </div>
      <Note tone={note && note.tone}>{note && note.text}</Note>
    </div>
  );
}

/**
 * Pull up a term sheet by its ID — the owner's *"put in the term sheet ID and
 * pull up the exact scenario that was searched."*
 *
 * It shows what was ISSUED, from the stored snapshot. It never re-prices on its
 * own: a term sheet is a promise about a moment, and quietly showing today's
 * numbers under a code somebody was given would be the opposite of a record.
 */
export function TermSheetLookup() {
  const [code, setCode] = useState('');
  const [state, setState] = useState({ status: 'idle' });

  async function look(e) {
    if (e) e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setState({ status: 'loading' });
    try {
      const r = await ltApi.termSheetGet(c);
      setState({ status: 'ok', data: r });
    } catch (err) {
      setState({ status: 'error', message: (err && (err.message || err.error)) || 'Could not pull up that term sheet.' });
    }
  }

  const d = state.status === 'ok' ? state.data : null;
  const members = d && d.snapshot && Array.isArray(d.snapshot.members) ? d.snapshot.members : [];

  return (
    <div style={{ background: '#fff', border: '1px solid rgba(20,27,34,.12)', borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>Pull up a term sheet</div>
      <form onSubmit={look} style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <input
          value={code}
          onChange={(ev) => setCode(ev.target.value)}
          placeholder="TS-4K7P2M"
          aria-label="Term sheet ID"
          style={{
            /* 16px is not a style choice: iOS Safari zooms the whole page on
               focus of any control under it, which throws the panel off screen. */
            fontSize: 16, padding: '7px 10px', borderRadius: 8, minWidth: 160,
            border: '1px solid rgba(20,27,34,.20)', color: INK, background: '#fff', ...NUM,
          }} />
        <button type="submit" style={btn('primary')} disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Looking…' : 'Pull it up'}
        </button>
      </form>

      {state.status === 'error' && <Note tone="bad">{state.message}</Note>}

      {d && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ fontSize: 20, fontWeight: 800, color: GOLD_TEXT, ...NUM }}>{d.code}</span>
            {/* WHICH of the three documents this was, read off the stored
                snapshot. A sheet issued before the three documents existed
                carries no `docKind`, so it falls back to the rendering shape —
                which is exactly what this line has always shown. */}
            <span style={{ fontSize: 12, fontWeight: 700, color: INK }}>
              {KIND_TITLE[(d.snapshot && d.snapshot.docKind)
                || (d.issued && d.issued.kind === 'comparison' ? 'comparison' : 'term_sheet')] || 'Term sheet'}
            </span>
            <span style={{ fontSize: 12, color: MUTED }}>
              {d.issued && d.issued.borrowerName ? `for ${d.issued.borrowerName} · ` : ''}
              issued {String(d.issued && d.issued.at || '').slice(0, 10)}
            </span>
            {d.expired && (
              <span style={{ fontSize: 11.5, fontWeight: 700, color: CAUTION }}>
                expired {String(d.issued && d.issued.expiresAt || '').slice(0, 10)}
              </span>
            )}
          </div>

          {/* SAID, NEVER SWALLOWED. A sheet whose stored bytes no longer hash to
              what we recorded is not the document we sent, and presenting it as
              authoritative would be the one thing this feature must not do. */}
          {d.integrity && !d.integrity.ok && (
            <div style={{
              marginTop: 8, padding: '8px 10px', borderRadius: 8,
              background: '#FBF3F3', border: '1px solid #E3C4C4', color: '#8A2A2A', fontSize: 12, lineHeight: 1.5,
            }}>
              This stored term sheet no longer matches the record we took when it was issued
              ({d.integrity.reason}). Treat what is shown below as unconfirmed and re-issue before
              sending anything.
            </div>
          )}

          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            {members.map((m, i) => (
              <div key={i} style={{
                display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline',
                border: '1px solid rgba(20,27,34,.10)', borderRadius: 8, padding: '7px 10px',
              }}>
                <span style={{ fontSize: 13, color: INK, fontWeight: 600 }}>{m.label}</span>
                <span style={{ fontSize: 12, color: SLATE, ...NUM }}>
                  {m.ratePct != null ? `${Number(m.ratePct).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%` : '—'}
                </span>
                <span style={{ fontSize: 11.5, color: MUTED }}>{m.consumerLabel}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: INK, ...NUM }}>
                  {m.closing && Number.isFinite(m.closing.cashToCloseDollars)
                    ? `$${Math.round(m.closing.cashToCloseDollars).toLocaleString('en-US')} to close` : ''}
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10 }}>
            <button type="button" style={btn('primary')} onClick={() => ltApi.termSheetPdf(d.code)}>
              Download the PDF
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The cart, loaded once and kept in step.
 *
 * A hook rather than state inside the strip, because the per-quote buttons and
 * the strip both have to agree about how many options are collected — two copies
 * of that count is how a screen tells somebody they have three when they have
 * four.
 */
export function useTermSheetCart() {
  const [state, setState] = useState({ enabled: false, cart: null, members: [] });
  const reload = useCallback(async () => {
    try {
      const r = await ltApi.termSheetCart();
      setState({
        // ONE reading of whether term sheets are switched on, and it is the
        // SERVER's — a screen that decided for itself would offer a button the
        // server refuses. It is OFF unless the answer is exactly true, so a
        // failed read never opens a feature the owner has not opened.
        enabled: r && r.enabled === true,
        cart: (r && r.cart) || null,
        members: r && Array.isArray(r.members) ? r.members : [],
      });
    } catch {
      // A cart that cannot be read is an empty strip and a working board — never
      // an error over the whole pricing screen, and never an open feature.
      setState({ enabled: false, cart: null, members: [] });
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, count: state.members.length };
}
