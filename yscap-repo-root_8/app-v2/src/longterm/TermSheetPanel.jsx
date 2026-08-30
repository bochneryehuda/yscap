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

  async function issue() {
    setBusy('issue'); setNote(null);
    try {
      const selections = members.map((m) => ({
        label: m.label,
        consumerLabel: (m.program || {}).consumerLabel,
        product: (m.program || {}).product,
        mode: m.mode,
        waiveLenderFees: m.waive_lender_fees,
        ratePct: (m.program || {}).ratePct,
        rawPrice: (m.program || {}).rawPrice,
        vendorMonthlyPI: (m.program || {}).monthlyPI,
        scenario: m.scenario,
        pricedAt: m.priced_at,
      }));
      const r = await ltApi.termSheetIssue({ selections, anchorIndex: anchor, cartId: cart && cart.id });
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
  return (
    <div style={{ background: PAPER, border: '1px solid rgba(20,27,34,.12)', borderRadius: 10, padding: 12, marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>Comparison</div>
        <div style={{ fontSize: 11.5, color: MUTED }}>
          {n === 0 ? 'Nothing collected yet.' : `${n} ${n === 1 ? 'option' : 'options'} · everything is compared against the one you mark`}
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
                <button type="button" onClick={() => setAnchor(m.position)} disabled={busy === `a${m.position}`}
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
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <button type="button" style={btn('primary')} disabled={!n || busy === 'issue' || outerBusy} onClick={issue}>
          {busy === 'issue' ? 'Issuing…' : (n > 1 ? 'Issue the comparison term sheet' : 'Issue the term sheet')}
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
