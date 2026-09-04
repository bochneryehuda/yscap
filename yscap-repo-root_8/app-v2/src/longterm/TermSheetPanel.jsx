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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ltApi from './api.js';
import AddressField from './AddressField.jsx';
import { memberForQuote } from './cartMatch.js';
// ⛔ THE BOARD STAYS WHERE IT IS WHEN A ROW'S CONTROL CHANGES ITS HEIGHT.
import { keepPlaceOnClick } from './keepScroll.js';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, PAPER, CAUTION, segTrack, segBtn } from './ppeStyles.js';

const NUM = { fontVariantNumeric: 'tabular-nums' };

/** The owner's own sentence for why the issue button is greyed, in ONE place — the
 *  hover, and nothing else, so it can never disagree with itself. */
const RATIO_BLOCK_HINT = 'Because the ratio is low, you need to reprice before you can issue the term sheet.';

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

/* ⛔ A BUTTON THAT CANNOT BE PRESSED MUST NOT LOOK LIKE ONE THAT CAN (owner-reported
   2026-08-31: *"it sounds like the Issue Term Sheet button is a real button, but when
   I try to click it, nothing happens because it's black. This is a real problem with
   that button."*).

   The button was ALREADY `disabled` for the ratio case — the refusal worked. What was
   wrong is that it kept `btn('primary')`: full gold, white text, `cursor: pointer`. So
   it advertised itself as the primary action, swallowed the click, and said nothing.
   An officer reasonably reads that as the screen being broken.

   Greying is only half: `cursor: not-allowed` is what answers the press itself, at the
   moment of the press, before any reading. */
const btnBlocked = () => ({
  ...btn(),
  background: 'rgba(20,27,34,.06)',
  color: '#8A9096',
  border: '1px solid rgba(20,27,34,.12)',
  cursor: 'not-allowed',
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
 * EVENING OUT A PRICE — one control, all three documents (§40).
 *
 * The owner (2026-08-31): *"you should be able to manually even out the numbers by
 * manually adding a charge or manually giving a concession. The system should
 * automatically give suggestions which should help you even it out to straight
 * numbers ... let's say if you type -0.1, it's going to bring it down from a 101.1
 * to a 101.0."* And, on what actually moves: *"either reducing our compensation or
 * increasing our compensation to even it out."*
 *
 * ⛔ IT COMPUTES NO MONEY, and that is the whole reason the suggestions are a round
 * trip. The compensation an adjustment comes out of is the SERVER's own resolution
 * and is deliberately never sent to the browser; a board that worked the
 * suggestions out for itself would need that number and would then be a second
 * place our compensation is decided. Every figure and every refusal here is the
 * server's, shown verbatim.
 *
 * ⛔ ONE CONTROL, THREE DOCUMENTS. A single term sheet, a pricing comparison and a
 * scenario comparison all reach it, because the owner asked for it on all three and
 * three copies would be three answers to "what may I give away here".
 *
 * ⛔ IT REPORTS POINTS UPWARDS AND NOTHING ELSE. The parent puts `priceAdjustment`
 * on the selection it was already sending; the server re-derives every figure from
 * it when the sheet is previewed and again when it is issued. Nothing this screen
 * calculated is ever stored.
 */
function PriceAdjuster({ mode, rawPrice, value, onChange, compact }) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState(value == null ? '' : String(value));
  const [state, setState] = React.useState(null);   // the server's answer
  const [err, setErr] = React.useState(null);

  const adjustable = mode === 'borrowerPaid' || mode === 'lenderPaid';

  /* Asked of the server whenever the box changes, debounced — an undebounced
     effect would post once per character typed. The TYPED value rides along so
     the answer carries what that exact adjustment would do, from the same
     function the issue will use. */
  React.useEffect(() => {
    if (!open || !adjustable) return undefined;
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const r = await ltApi.termSheetPriceAdjust({ mode, rawPrice, deltaPoints: typed === '' ? null : typed });
        if (!dead) { setState(r); setErr(null); }
      } catch (e) {
        if (!dead) setErr((e && (e.message || e.error)) || 'Could not work that adjustment out.');
      }
    }, 300);
    return () => { dead = true; clearTimeout(t); };
  }, [open, adjustable, mode, rawPrice, typed]);

  if (!adjustable) return null;

  function choose(points) {
    const next = points === null || points === '' ? null : Number(points);
    setTyped(next == null ? '' : String(next));
    onChange(next != null && Number.isFinite(next) && next !== 0 ? next : null);
  }

  const applied = state && state.applied;
  const set = value != null && value !== 0;

  if (!open) {
    return (
      <div style={{ marginTop: compact ? 0 : 8 }}>
        <button type="button" style={{ ...btn(), padding: '4px 9px', minHeight: 26, fontSize: 12 }}
          onClick={() => setOpen(true)}>
          {set ? `Price evened out by ${value > 0 ? '+' : ''}${value}` : 'Even out the price'}
        </button>
      </div>
    );
  }

  return (
    <div style={{
      // Opened, it takes the whole line beneath a collected row (a wrapping flex row);
      // in the single-sheet form there is no flex parent and this is simply a block.
      flexBasis: '100%', marginTop: 8, padding: 10, borderRadius: 8,
      background: PAPER, border: '1px solid rgba(20,27,34,.10)',
    }}>
      <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>
        Even out the price
        {state && state.priceNow != null
          ? <span style={{ color: INK, ...NUM }}>{` — it reads ${Number(state.priceNow).toFixed(3)} now`}</span>
          : null}
      </div>

      {/* THE SUGGESTIONS ARE THE SERVER'S. Each one names what it costs us, because
          the point of a suggestion here is not the round number — it is knowing what
          the round number is worth. */}
      {state && Array.isArray(state.suggestions) && state.suggestions.length ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
          {state.suggestions.map((sg) => (
            <button key={sg.key} type="button" title={sg.detail}
              style={{ ...btn(), padding: '4px 9px', minHeight: 26, fontSize: 12 }}
              onClick={() => choose(sg.deltaPoints)}>
              {sg.label}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6 }}>
          {state ? 'That price is already on a round number.' : 'Working out what it could round to…'}
        </div>
      )}

      <div style={{ marginTop: 9 }}>
        <label style={fieldLabel()} htmlFor={`ts-adj-${mode}-${rawPrice}`}>
          Or type it, in points
        </label>
        <input
          id={`ts-adj-${mode}-${rawPrice}`}
          type="text"
          inputMode="decimal"
          style={{ ...field(), ...NUM }}
          value={typed}
          placeholder="-0.1"
          onChange={(e) => choose(e.target.value.trim() === '' ? null : e.target.value)}
        />
      </div>

      {/* WHAT IT DOES TO THE MONEY, in the server's own sentence — or its refusal,
          verbatim. "That is capped at 2 points" is something a person can act on;
          a bare failure is not. */}
      {err ? (
        <div style={{ fontSize: 12, color: '#8A2A2A', marginTop: 7, lineHeight: 1.5 }}>{err}</div>
      ) : null}
      {applied && applied.ok === false ? (
        <div style={{ fontSize: 12, color: '#8A2A2A', marginTop: 7, lineHeight: 1.5 }}>{applied.message}</div>
      ) : null}
      {applied && applied.ok ? (
        <div style={{ fontSize: 12, color: INK, marginTop: 7, lineHeight: 1.5, ...NUM }}>{applied.summary}</div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 9 }}>
        <button type="button" style={btn('primary')} onClick={() => setOpen(false)}>Done</button>
        {set ? (
          <button type="button" style={btn()} onClick={() => { choose(null); }}>
            Put it back
          </button>
        ) : null}
      </div>
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 7, lineHeight: 1.5 }}>
        The rate and the investor&rsquo;s own price never move — this comes out of our
        compensation, and the sheet is priced on it when it is issued.
      </div>
    </div>
  );
}

/**
 * SEND IT TO THE BORROWER — one control, mounted wherever a sheet has been issued.
 *
 * The owner (2026-08-31): *"we should be able to put in an email address from a
 * borrower, which should deliver them the PDF and the nice email ... It should
 * deliver it from the loan officer's email address and from the loan officer's
 * name."*
 *
 * ⛔ ONE DEFINITION, THREE MOUNTS. There are three places on this screen where a
 * sheet reports itself as issued, and each already offers the download. Copying an
 * address box into all three would be three answers to "may I send this, and to
 * whom" — and the copy that drifts is the one somebody presses.
 *
 * ⛔ IT DECIDES NOTHING. Whether the address is usable, whether the note may go out,
 * and who it comes from are the SERVER's answers — the refusal it sends back is the
 * sentence shown here, verbatim. A screen that pre-judged any of them would have to
 * carry a second copy of a rule (rule 10 among them), and the copy that drifts is
 * the one that leaks.
 *
 * ⛔ IT SAYS WHO IT HAS ALREADY GONE TO, before offering to send it again. "Did she
 * get it?" answered by sending another copy is the failure this avoids.
 *
 * Every colour is an explicit dark on white — an `--ink*` token is a LIGHT paper
 * colour in this palette and renders white on white.
 */
function SendToBorrower({ code }) {
  const [open, setOpen] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);      // {tone:'ok'|'bad', text}
  const [past, setPast] = React.useState(null);    // null = not looked yet

  const load = React.useCallback(async () => {
    if (!code) return;
    try {
      const r = await ltApi.termSheetDeliveries(code);
      setPast(Array.isArray(r && r.deliveries) ? r.deliveries : []);
    } catch (_) {
      // A history we cannot read must never stop somebody sending the document.
      setPast([]);
    }
  }, [code]);

  React.useEffect(() => { load(); }, [load]);

  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await ltApi.termSheetEmail(code, { to, note: note.trim() || undefined });
      setMsg({ tone: 'ok', text: `Sent to ${(r && r.sent && r.sent.to) || to}.` });
      setTo('');
      setNote('');
      setOpen(false);
      await load();
    } catch (e) {
      /* THE SERVER'S OWN SENTENCE, verbatim. Every refusal here is something a
         person fixes and tries again — a mistyped address, a note naming the
         investor — and replacing it with "could not send" would take away the one
         thing that says what to do about it. */
      setMsg({ tone: 'bad', text: (e && (e.message || e.error)) || 'Could not send it.' });
    } finally { setBusy(false); }
  }

  const already = Array.isArray(past) && past.length > 0;

  return (
    <div style={{ marginTop: 10 }}>
      {already ? (
        <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
          {past.length === 1 ? 'Already sent to ' : `Already sent ${past.length} times — most recently to `}
          <strong style={{ color: INK }}>{past[0].to_email}</strong>
          {past[0].created_at ? ` on ${new Date(past[0].created_at).toLocaleDateString()}` : ''}.
        </div>
      ) : null}

      {msg ? (
        <div style={{
          marginTop: 6, fontSize: 12, lineHeight: 1.5,
          color: msg.tone === 'bad' ? '#8A2A2A' : '#1F5E3A',
        }}>
          {msg.text}
        </div>
      ) : null}

      {!open ? (
        <button type="button" style={{ ...btn(), marginTop: 7 }} onClick={() => { setOpen(true); setMsg(null); }}>
          {already ? 'Send it again' : 'Email it to the borrower'}
        </button>
      ) : (
        <div style={{
          marginTop: 8, padding: 10, borderRadius: 8,
          background: PAPER, border: '1px solid rgba(20,27,34,.10)',
        }}>
          <label style={fieldLabel()} htmlFor={`ts-email-${code}`}>Borrower’s email address</label>
          <input
            id={`ts-email-${code}`}
            type="email"
            style={field()}
            value={to}
            placeholder="name@example.com"
            onChange={(e) => setTo(e.target.value)}
          />
          <div style={{ marginTop: 8 }}>
            <label style={fieldLabel()} htmlFor={`ts-note-${code}`}>A note to go with it (optional)</label>
            <textarea
              id={`ts-note-${code}`}
              rows={2}
              style={{ ...field(), resize: 'vertical' }}
              value={note}
              placeholder="Here is the pricing we discussed…"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
            It goes out from your own name and address, with the PDF attached and the
            expiry stated. One borrower at a time.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 9 }}>
            <button type="button" style={btn('primary')} disabled={busy || !to.trim()} onClick={send}>
              {busy ? 'Sending…' : 'Send it'}
            </button>
            <button type="button" style={btn()} disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
  // ONE key for the two name boxes, because either one satisfies the gate — the
  // server reports it that way for exactly this reason (owner-directed
  // 2026-08-30: *"a name of the person and/or a name of the entity"*), and two
  // separate shortfalls for one requirement would read as two jobs.
  partyName: "the borrower's name or the vesting entity",
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
export function QuoteTermSheetActions({ sel, enabled, mode, onAdded, cartCount, issue }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [open, setOpen] = useState(false);
  const [gate, setGate] = useState(null);      // the SERVER's verdict — never re-derived here
  /* §40 — how many POINTS this one option's price was evened out by, or null. It
     rides on the selection and nothing else: the server re-derives every figure
     from it, at preview and again at issue, so the screen never holds a price. */
  const [adjust, setAdjust] = useState(null);
  /**
   * WHAT IS THIS SHEET STILL MISSING? — asked of the SERVER, never worked out here.
   *
   * ⛔ ONE DEFINITION OF COMPLETE. `snapshot.exportGate` decides it, the issue
   * route enforces it, and this asks the same function through `/preview` — so
   * the panel can never show a green button the server would refuse, nor ask for
   * a field the server does not want. A local copy of the rule is exactly how a
   * screen and its server drift apart.
   *
   * ⛔ ABOVE THE EARLY RETURN, AND THAT PLACEMENT IS LOAD-BEARING. `enabled`
   * flips at runtime — the board learns whether term sheets are switched on from
   * the SAME cart read that tells it what is collected, so this component really
   * does render `false` first and `true` a moment later. A hook below the return
   * would be called on the second render and not the first, and React answers
   * that with "Rendered more hooks than during the previous render" and takes the
   * whole page down. Caught by `scripts/test-react-hook-order.js`, which is the
   * guard that exists for exactly this and which found it here.
   */
  const ask = useCallback(async () => {
    if (!issue) return null;
    try {
      const r = await ltApi.termSheetPreview({
        selections: [{ ...issue.selectionNow(), priceAdjustment: adjust }], prepared: issue.prepared,
      });
      setGate(r && r.gate ? r.gate : null);
      return r && r.gate ? r.gate : null;
    } catch (e) {
      // A preview that cannot be had is not a refusal to issue — the issue door
      // re-checks the gate itself. Say so and let them press.
      setGate(null);
      setNote({ tone: 'bad', text: (e && (e.message || e.error)) || 'Could not check what is still needed.' });
      return null;
    }
  }, [issue, adjust]);

  const [issued, setIssued] = useState(null);

  if (!enabled) return null;

  const issuable = mode === 'borrowerPaid' || mode === 'lenderPaid';
  // The board hands down the deal's own facts. Without them the panel cannot ask
  // for anything, so the control falls back to the collect-and-compare flow it
  // has always had rather than offering a button that could not finish.
  const canIssue = issuable && !!issue;

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


  /** Press one: complete deals issue immediately, incomplete ones open the boxes. */
  async function startIssue() {
    setBusy('gate'); setNote(null);
    const g = await ask();
    setBusy(null);
    // ⛔ THE OWNER'S RULE, IN ONE LINE: *"if you enter the full scenario, you can
    // right away issue the term sheet. And if not, you need to enter the numbers
    // over there."* A ready deal must not be made to open a form it would only
    // press through unchanged.
    if (g && g.ok) { await doIssue(); return; }
    setOpen(true);
  }

  async function doIssue() {
    setBusy('issue'); setNote(null);
    try {
      const r = await ltApi.termSheetIssue({
        selections: [{ ...issue.selectionNow(), priceAdjustment: adjust }], prepared: issue.prepared,
      });
      setIssued(r);
      setOpen(false);
      if (onAdded) onAdded();
    } catch (e) {
      // The server names every missing field at once; carry its sentence through
      // and re-open the boxes so each one can be filled where it is refused.
      setNote({ tone: 'bad', text: (e && (e.message || e.error)) || 'Could not issue that term sheet.' });
      setOpen(true);
      await ask();
    } finally { setBusy(null); }
  }

  if (issued && issued.code) {
    return (
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(20,27,34,.10)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{`Term sheet issued — ${issued.code}`}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 7 }}>
          <button type="button" style={btn('primary')} onClick={() => ltApi.termSheetPdf(issued.code)}>
            Download the PDF
          </button>
          <button type="button" style={btn()} onClick={() => { setIssued(null); setGate(null); }}>
            Issue another
          </button>
        </div>
        <SendToBorrower code={issued.code} />
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(20,27,34,.10)' }}>
      {!issuable ? (
        <div style={{ fontSize: 12, color: CAUTION, lineHeight: 1.5 }}>
          Raw pricing is the vendor&rsquo;s own numbers before our compensation, so it never goes
          on a term sheet. Switch to borrower-paid or lender-paid to build one.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* ⛔ ISSUING THIS ONE OPTION IS THE PRIMARY ACTION. Owner-directed
                2026-08-30: *"where that button is, you should be able to issue a
                term sheet. Which means you can only select one option."* A term
                sheet IS one option, so it is issued from the option — collecting
                several is the other workflow and stays the quieter button. */}
            {canIssue ? (
              <button type="button" style={btn('primary')} disabled={busy != null} onClick={startIssue}>
                {busy === 'gate' ? 'Checking…' : busy === 'issue' ? 'Issuing…' : 'Issue term sheet'}
              </button>
            ) : null}
            <button type="button" style={btn()} disabled={busy === 'add'} onClick={add}>
              {busy === 'add' ? 'Adding…' : 'Add to comparison'}
            </button>
            <span style={{ fontSize: 11.5, color: MUTED }}>
              {cartCount ? `${cartCount} collected` : 'Collect options across searches to compare them.'}
            </span>
          </div>
          {open && canIssue ? (
            <IssueFields issue={issue} gate={gate} onChanged={ask}
              busy={busy} onIssue={doIssue} onCancel={() => setOpen(false)}
              mode={mode} adjust={adjust} onAdjust={setAdjust} />
          ) : null}
        </>
      )}
      <Note tone={note && note.tone}>{note && note.text}</Note>
    </div>
  );
}

/** Is this gate key outstanding? A null gate (nothing asked yet, or the ask
 *  failed) marks nothing — guessing at a shortfall would put a red box under a
 *  field somebody has already filled. */
const outstanding = (gate, key) => !!(gate && Array.isArray(gate.missing) && gate.missing.includes(key));

/**
 * THE BOXES A TERM SHEET STILL NEEDS, ON THE ROW IT IS ABOUT.
 *
 * Owner-directed 2026-08-30: *"you need to enter the numbers over there. You need
 * to enter the monthly rent and the monthly or the yearly property tax and
 * optional HOA. The same way you enter by the Calculate … and it verifies that
 * the ratio that you're searching is the correct ratio."*
 *
 * ⛔ THE HOUSING FIGURES ARE THE BOARD'S, NOT THIS PANEL'S. They write straight
 * into the same calculator state the DSCR panel and the PITI column read, so a
 * rent typed here lights up the column, moves the ratio and reaches the sheet —
 * one set of facts about one property. A private copy here would let the sheet
 * state a payment the board beside it disagrees with.
 *
 * ⛔ AND THE FIELDS DO NOT COME AND GO AS THEY ARE FILLED. Every box is drawn,
 * with the outstanding ones marked: a form that reflows under the cursor as each
 * answer lands is a form people lose their place in.
 */
export function IssueFields({ issue, gate, onChanged, busy, onIssue, onCancel, mode, adjust, onAdjust }) {
  const c = issue.calc;
  const set = (k) => (v) => issue.setCalc((p) => ({ ...p, [k]: v }));
  const setBasis = (k, val) => issue.setCalc((p) => ({ ...p, [k]: val }));
  const setP = (k) => (v) => issue.setPrepared((p) => ({ ...p, [k]: v }));

  /* Re-ask the server once the officer stops changing things, so the marks and
     the sentence follow what is actually in the boxes.

     ⛔ KEYED ON THE VALUES, NEVER ON THE CALLBACK. The board rebuilds `issue`
     (and therefore this `onChanged`) on every render, so a dependency on its
     identity would fire the ask on every render — and the ask sets state, which
     renders again. That is an endless round trip to the server, not a debounce.
     The live function is held in a ref instead, which is the same discipline the
     board's own auto-ask loop uses. */
  const askRef = useRef(onChanged);
  askRef.current = onChanged;
  useEffect(() => {
    const t = setTimeout(() => { askRef.current(); }, 400);
    return () => clearTimeout(t);
  }, [c.rent, c.tax, c.taxBasis, c.insurance, c.insBasis, c.hoa,
    issue.prepared.borrowerName, issue.prepared.entityName, issue.prepared.propertyAddress]);

  const check = issue.ratioCheck();
  // A ratio BELOW the one the price was obtained at is the money rule, and it is
  // the server's to enforce — this is the screen agreeing with it.
  const ratioBlocks = !!(check && check.state === 'differs');
  const mark = (key) => (outstanding(gate, key)
    ? { color: CAUTION, fontWeight: 700 } : null);

  return (
    <div style={{
      marginTop: 10, border: `1px solid ${GOLD}55`, borderRadius: 10, background: PAPER,
    }}>
      <div style={{
        padding: '7px 11px', borderBottom: `1px solid ${GOLD}33`, fontSize: 11,
        letterSpacing: '.07em', textTransform: 'uppercase', fontWeight: 700, color: GOLD_TEXT,
      }}>
        What this term sheet still needs
      </div>
      <div style={{ padding: 11, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <label style={{ flex: '1 1 140px', minWidth: 130 }}>
          <span style={{ ...fieldLabel(), ...(mark('rentMonthly') || {}) }}>Monthly rent</span>
          <input style={field()} inputMode="decimal" value={c.rent}
            onChange={(e) => set('rent')(e.target.value)} aria-label="Monthly rent" />
        </label>

        <label style={{ flex: '1 1 170px', minWidth: 160 }}>
          <span style={{ ...fieldLabel(), ...(mark('taxMonthly') || {}) }}>Property tax</span>
          <Basis value={c.taxBasis} onChange={(v) => setBasis('taxBasis', v)} />
          <input style={field()} inputMode="decimal" value={c.tax}
            onChange={(e) => set('tax')(e.target.value)} aria-label="Property tax" />
        </label>

        <label style={{ flex: '1 1 170px', minWidth: 160 }}>
          <span style={{ ...fieldLabel(), ...(mark('insuranceMonthly') || {}) }}>Hazard insurance</span>
          <Basis value={c.insBasis} onChange={(v) => setBasis('insBasis', v)} />
          <input style={field()} inputMode="decimal" value={c.insurance}
            onChange={(e) => set('insurance')(e.target.value)} aria-label="Hazard insurance" />
        </label>

        {/* THE ONE FIELD WITH A DEFAULT, and it is the owner's: blank means none. */}
        <label style={{ flex: '1 1 130px', minWidth: 120 }}>
          <span style={fieldLabel()}>Monthly HOA</span>
          <input style={field()} inputMode="decimal" value={c.hoa}
            onChange={(e) => set('hoa')(e.target.value)} aria-label="Monthly HOA" />
          <span style={{ fontSize: 11, color: MUTED }}>Blank means none</span>
        </label>

        <label style={{ flex: '1 1 100%' }}>
          <span style={{ ...fieldLabel(), ...(mark('propertyAddress') || {}) }}>Property address</span>
          <AddressField id="ts-addr" value={issue.prepared.propertyAddress}
            onChange={setP('propertyAddress')} style={{ marginTop: 3 }} />
        </label>

        {/* ⛔ EITHER NAME WILL DO, and the panel says so rather than marking both
            red. Owner-directed: *"a name of the person and/or a name of the
            entity."* The server reports the shortfall under ONE key for exactly
            this reason — two red boxes for one requirement reads as two jobs. */}
        <label style={{ flex: '1 1 220px', minWidth: 200 }}>
          <span style={{ ...fieldLabel(), ...(mark('partyName') || {}) }}>Borrower&rsquo;s name</span>
          <input style={field()} value={issue.prepared.borrowerName}
            onChange={(e) => setP('borrowerName')(e.target.value)} aria-label="Borrower's name" />
        </label>
        <label style={{ flex: '1 1 220px', minWidth: 200 }}>
          <span style={{ ...fieldLabel(), ...(mark('partyName') || {}) }}>Vesting entity</span>
          <input style={field()} value={issue.prepared.entityName}
            onChange={(e) => setP('entityName')(e.target.value)} aria-label="Vesting entity" />
          <span style={{ fontSize: 11, color: MUTED }}>Either name is enough</span>
        </label>
      </div>

      {/* §40 — the price may be evened out out of OUR compensation before the sheet
          is issued. Above the ratio check on purpose: it changes what the document
          will say, so it belongs with the fields that do, not with the actions. */}
      {onAdjust ? (
        <div style={{ padding: '0 11px 4px' }}>
          <PriceAdjuster
            mode={mode}
            rawPrice={(issue.selectionNow ? issue.selectionNow() : {} || {}).rawPrice}
            value={adjust}
            onChange={onAdjust}
          />
        </div>
      ) : null}

      <RatioCheck check={check} onReprice={issue.onReprice} busy={busy} />

      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
        padding: '9px 11px', borderTop: `1px solid ${GOLD}33`,
      }}>
        {/* ⛔ THE ONE THING THIS BUTTON IS DISABLED FOR. Everything else the gate
            refuses is a box on this panel, so a greyed button would explain
            nothing that the sentence beside it does not already say — but a
            ratio below the one the price was bought at is not a box anybody can
            fill, it is a re-price, and the button for that is right above. The
            SERVER refuses it either way (`dscr_below_priced`); this only stops
            an officer pressing something that cannot succeed.

            ⛔ THE TITLE SITS ON THE WRAPPER, NOT ON THE BUTTON, and that is the
            whole reason the wrapper exists. A DISABLED control receives no mouse
            events in several browsers, so a `title` on the button itself is a
            tooltip that never appears — which would have left the owner's actual
            request ("hovering on top of it should come up and say...") quietly
            unimplemented while looking done in the source. The wrapper is not
            disabled, so it always gets the hover.

            The wording is the owner's own, so the button, the sentence beside it
            and the panel above cannot drift into three descriptions of one rule. */}
        <span title={ratioBlocks ? RATIO_BLOCK_HINT : undefined} style={{ display: 'inline-flex' }}>
          <button type="button" style={ratioBlocks ? btnBlocked() : btn('primary')}
            disabled={busy != null || ratioBlocks}
            aria-disabled={ratioBlocks} onClick={onIssue}>
            {busy === 'issue' ? 'Issuing…' : 'Issue the term sheet'}
          </button>
        </span>
        <button type="button" style={btn()} disabled={busy != null} onClick={onCancel}>Not now</button>
        {/* ⛔ THE BUTTON IS NEVER DISABLED ON THE GATE. The server refuses and
            names every missing field at once; a greyed button explains nothing
            and a person cannot ask it why. */}
        <span style={{ fontSize: 11.5, color: gate && gate.ok ? MUTED : CAUTION, flex: '1 1 180px' }}>
          {ratioBlocks ? 'Re-price at the ratio these figures produce, then issue.'
            : gate && gate.ok ? 'Everything a term sheet needs is here.'
              : (gate && gate.message) || 'Fill these in and it will issue.'}
        </span>
      </div>
    </div>
  );
}

/**
 * The monthly/yearly switch that rides tax and insurance.
 *
 * ⛔ IT IS THE PRODUCT'S OWN SEGMENTED CONTROL (`segTrack`/`segBtn`), not a
 * lookalike. This first shipped as a hand-rolled copy with a GOLD selected
 * state, and MEASURING it in a real browser is what caught the problem: white
 * on gold is 3.31:1, under the 4.5:1 that normal-sized text needs, while the
 * shared control's near-black selected state is about 16:1. It was also simply
 * a different-looking switch from the one on the DSCR calculator two panels
 * away, doing the identical job — and the owner's whole ask here was that this
 * work "the same way you enter by the Calculate".
 */
export function Basis({ value, onChange }) {
  const tab = (v, label) => (
    <button type="button" onClick={() => onChange(v)} aria-pressed={value === v}
      style={segBtn(value === v)}>{label}</button>
  );
  return (
    <span style={{ ...segTrack, marginLeft: 6, verticalAlign: 'middle' }}>
      {tab('monthly', 'Mo')}{tab('yearly', 'Yr')}
    </span>
  );
}

/**
 * DOES THE RATIO THESE FIGURES PRODUCE MATCH THE ONE THIS WAS PRICED AT?
 *
 * Owner-directed 2026-08-30: *"it verifies that the ratio that you're searching
 * is the correct ratio."* The price on this row was obtained at the DSCR in the
 * search form; the sheet prints the rent, taxes and insurance typed here. If
 * those produce a different ratio, the document would state one figure and carry
 * a price fetched at another.
 *
 * ⛔ IT REPORTS, IT DOES NOT REFUSE. Whether a sheet may go out on a ratio the
 * price was not obtained at is a business decision, and refusing would leave an
 * officer who knows better with no way through. So it is said plainly, in front
 * of the button, and the officer decides.
 *
 * ⛔ AND IT SAYS NOTHING IT CANNOT PROVE. A half-filled scenario, a missing rate
 * or a missing term yields no verdict at all — never a confident "they match".
 */
export function RatioCheck({ check, onReprice, busy }) {
  if (!check || check.state === 'unknown') return null;
  const agree = check.state === 'agree';
  return (
    <div style={{
      padding: '9px 11px', borderTop: `1px solid ${GOLD}33`,
      fontSize: 12.5, lineHeight: 1.5, color: agree ? SLATE : CAUTION,
    }}>
      {agree ? (
        `These figures work out to a DSCR of ${check.computed} — the same band this was priced in, so it issues.`
      ) : (
        <>
          {/* ⛔ SHORT, AND IT SAYS WHICH WAY IT WENT — owner-directed: *"make sure it's very
              easy."* Downward is the money case; upward means the borrower qualifies for better
              pricing than the paper shows. Neither is an accusation and both are one press to fix. */}
          <div style={{ fontWeight: 700 }}>
            {check.direction === 'above'
              ? `These figures come to ${check.computed} — a higher DSCR band than the ${check.priced} this was priced in.`
              : `These figures come to ${check.computed} — a lower DSCR band than the ${check.priced} this was priced in.`}
          </div>
          {/* ⛔ THE REMEDY IS IN THE WORDS, not only on the button. The button is only drawn when
              a re-price handler is wired, so a surface without one would otherwise state a refusal
              and offer nothing — a dead end. Caught by the render suite when this sentence was
              dropped in a rewrite. */}
          <div style={{ marginTop: 3 }}>
            {check.direction === 'above'
              ? 'The borrower qualifies for better pricing than this sheet shows, so it cannot be issued '
                + 'as it stands. Re-price at the true ratio and issue from the new price.'
              : 'The rate on this row was bought in a band the loan no longer reaches, so it cannot be '
                + 'issued as it stands. Re-price at the true ratio and issue from the new price.'}
          </div>
          {onReprice ? (
            <button type="button" style={{ ...btn('primary'), marginTop: 7 }}
              disabled={!!busy} onClick={() => onReprice(check.computed)}>
              {`Re-price at ${check.computed}`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}


/**
 * THE ADD-TO-COMPARISON BUTTON ON A PROGRAMME'S OWN ROW.
 *
 * Owner-directed 2026-09-02: *"You don't need to click Details and go down and click Add.
 * You should be able to do that right away… It can just be a button, but it needs to be
 * very clean, modern, user-friendly, and simple. Next to each and every quote."* And, of
 * the tick-box it replaces: *"it needs to have something clear: what it is and what you
 * do with that."*
 *
 * ⛔ IT SAYS WHAT IT DOES IN WORDS. A 17-pixel box with "ADD" beside it answered "is this
 * in?" and left "in what?" to a tooltip. The button reads *Add to comparison* and, once
 * pressed, *In comparison* — the words the rail at the bottom of the board uses — so a
 * person who has never opened the rail knows what the press did and where to look.
 *
 * ⛔ ONE CONTROL, TWO STATES, ONE PRESS EACH WAY. Pressed once it collects; pressed again
 * it takes the option back out. `aria-pressed` carries the state and the title spells
 * out what the NEXT press does, because a toggle whose two faces differ only by colour
 * is a control people press twice to find out.
 *
 * ⛔ IT ANSWERS FROM THE CART, never from a list kept here. `memberForQuote` matches on
 * what the offer IS (programme, product, rate, comp position, fee waive), so a re-run
 * search still marks the right rows — and nothing is remembered on this screen that the
 * server does not hold.
 *
 * ⛔ THE SAME HEIGHT AS THE DETAILS BUTTON BESIDE IT (the portal's `.btn` is 44px), so the
 * two read as one pair of controls rather than a button and a chip. The colours are the
 * measured pairs — gold text on white, ink on the gold-tinted paper — never white on
 * gold, which measured 3.31:1 on this very board.
 */
export function CompareButton({ quote, comp, members, busy, onAdd, onRemove }) {
  const mine = memberForQuote(members, quote, comp);
  const on = !!mine;
  const next = on ? 'Remove this program from the comparison' : 'Add this program to the comparison';
  /* ⛔ THE PRESS SAYS WHAT IT DID, ON THE ROW (owner-reported 2026-09-04: *"when you
     click Add to Comparison, it just gives a blink and maybe adds it, but this gives
     a blink and nothing happens. It doesn't sound like it works."*).

     The option really was collected — the collection lives at the BOTTOM of the
     board, and so did the only confirmation, so from a row near the top the whole
     press read as a flicker. The outcome is now stated beside the control that
     caused it. It is a WITNESS to what this button just did, never a second opinion
     about what is in the comparison: the label above still answers that from the
     cart alone (`memberForQuote`), so this can never claim a state the server does
     not hold. It clears itself, and a new press replaces it.

     ⛔ AND THE WITNESS REMEMBERS WHICH WAY IT WENT, WHICH IS THE WHOLE OF THE FIX
     (owner-reported 2026-09-04: *"when you click Add to Comparison, right now it pops
     up something like 'Taken out of the comparison'. Really, it should pop up 'Added
     to comparison'."*).

     It used to read `on` at the moment `busy` fell back to false — that is, it asked
     "is this row in the comparison NOW?" and used the answer to describe a press that
     had already happened. Those are two different questions, and they disagree for
     exactly as long as it takes the reloaded cart to arrive: on the tick `busy` clears,
     `members` is still the list from BEFORE the add, so `on` is false and an add
     announced itself as a removal. Every single Add said "Taken out of the comparison".

     So the direction is captured AT THE CLICK, from the state the click acted on, and
     the effect only decides WHEN to say it. A press cannot be misdescribed by a list
     that has not caught up, because the list is no longer consulted. `sending` doubles
     as the in-flight verb, so "Adding…"/"Removing…" cannot disagree with the sentence
     that follows it either — which is the same bug one tick earlier. */
  const [said, setSaid] = React.useState(null);
  const sending = React.useRef(null);   // 'add' | 'remove' — what the press in flight is doing
  const wasBusy = React.useRef(false);
  const [verb, setVerb] = React.useState(null);
  React.useEffect(() => {
    // The press is FINISHED when busy falls back to false, which is the only moment
    // the server has actually answered — saying it on the click would announce an
    // outcome the server has not agreed to yet.
    if (wasBusy.current && !busy) {
      setSaid(sending.current === 'remove' ? 'Removed from comparison'
        : (sending.current === 'add' ? 'Added to comparison' : null));
      sending.current = null;
      setVerb(null);
    }
    wasBusy.current = !!busy;
  }, [busy]);
  React.useEffect(() => {
    if (!said) return undefined;
    const t = setTimeout(() => setSaid(null), 4000);
    return () => clearTimeout(t);
  }, [said]);
  const press = () => {
    // Recorded BEFORE the handler runs, off the state the press is acting on.
    sending.current = on ? 'remove' : 'add';
    setVerb(sending.current);
    if (on) onRemove(mine); else onAdd();
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
    <button
      type="button"
      aria-pressed={on}
      aria-label={next}
      title={busy ? 'One moment…' : next}
      disabled={!!busy}
      onClick={(e) => keepPlaceOnClick(e, press)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap',
        font: 'inherit', fontSize: 12, fontWeight: 700, letterSpacing: '.01em', lineHeight: 1,
        padding: '0 14px', minHeight: 44, borderRadius: 999,
        cursor: busy ? 'progress' : 'pointer',
        border: `1px solid ${on ? GOLD : `${GOLD}99`}`,
        background: on ? PAPER : '#fff',
        color: on ? INK : GOLD_TEXT,
        opacity: busy ? 0.7 : 1,
        transition: 'background .12s ease, border-color .12s ease, color .12s ease',
      }}
    >
      {/* The glyph is decoration for a sighted reader; the words carry the meaning. */}
      <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>{on ? '\u2713' : '+'}</span>
      {/* ⛔ TWO FACES, AND THE SECOND ONE NAMES THE NEXT PRESS — owner-directed 2026-09-04:
          *"you should have a button. The button should toggle between 'Add' and 'Remove' so
          you can play around with adding and removing."* The face it used to show when a row
          was in was "In comparison", which states the STATE and leaves the reader to guess
          that pressing it again takes the row back out. `aria-pressed` and the gold fill
          still carry the state; the words now carry the ACTION, which is what a person
          playing two programs off against each other is reaching for. */}
      {busy
        ? ((verb === 'remove' || (verb == null && on)) ? 'Removing\u2026' : 'Adding\u2026')
        : (on ? 'Remove from comparison' : 'Add to comparison')}
    </button>
    {said && !busy && (
      /* Live, so a reader who never looks at the button hears the outcome too. */
      <span role="status" style={{ fontSize: 11.5, fontWeight: 600, color: SLATE, whiteSpace: 'nowrap' }}>
        {said}
      </span>
    )}
    </span>
  );
}

/**
 * THE TWO COMPARISON DOCUMENTS, CHOSEN BY NAME — the board's own area for them.
 *
 * Owner-directed 2026-08-30: *"on top, somewhere, we should create a new workflow. It should be
 * two options … 1. Study price in comparison: you have to do the correct research for the wording,
 * or present a scenario comparison. 2. Present a price in comparison: you can only do one scenario,
 * so select a few of that scenario."* Asked where it should live, the owner chose a separate area
 * on the pricing board rather than a page of its own.
 *
 * ⛔ THE TWO OPTIONS ARE THE TWO DOCUMENTS THAT ALREADY EXIST. The server has produced three kinds
 * since term sheets shipped — a TERM SHEET (one option), a COMPARISON (one scenario, several
 * options) and a SCENARIO COMPARISON (different scenarios) — and `comparison.detectWorkflow`
 * already tells them apart for the break-even arithmetic. So this invents no document and no
 * endpoint; what was missing was that the officer could not SAY which one they were building, and
 * had to infer it from whatever they happened to collect.
 *
 * ⛔ THE CHOICE IS AN INTENT, NEVER THE ANSWER. The document's kind is DERIVED on the server from
 * what is actually in it — a comparison of two different scenarios IS a scenario comparison
 * whatever anybody meant — because the one thing a document must never do is describe itself
 * wrongly. What the choice earns is a plain warning when the two disagree, which is the thing a
 * person cannot see for themselves: options collected across two searches look identical in a list.
 *
 * ⛔ AND IT IS HELD IN THE BROWSER, deliberately. An intent is not a fact about the sheet, so it
 * needs no column and no migration — and a stored intent could go stale against a cart that moved
 * under it, which is the one failure this panel exists to catch.
 */
export const COMPARISON_WORKFLOWS = [
  {
    key: 'prices',
    // The owner's "present a price in comparison … you can only do one scenario, so select a few
    // of that scenario". Named for what the reader gets, not for what the officer does.
    title: 'Compare prices on one deal',
    blurb: 'One scenario, several programs side by side. Price the deal, then collect the options '
      + 'worth showing.',
    docKind: 'comparison',
  },
  {
    key: 'scenarios',
    // The owner's "study price in comparison … or present a scenario comparison" — the wording
    // they asked to have researched. This is the industry's "what-if": the same property at
    // different loan amounts, terms or leverage, so the reader can see what each choice costs.
    title: 'Compare different deals',
    blurb: 'Different scenarios side by side — change the loan amount, the term or the leverage and '
      + 'show what each one costs.',
    docKind: 'scenario_comparison',
  },
];

const WORKFLOW_OF_KIND = { comparison: 'prices', scenario_comparison: 'scenarios' };

/**
 * Does what has been collected match what the officer said they were building?
 *
 * PURE, and it answers `null` — never a guess — whenever it cannot know: nothing chosen, nothing
 * collected, or a kind the server has not reported yet. A warning nobody can act on is worse than
 * none, and a warning that fires on an empty cart fires on every first visit.
 *
 * HONEST NOTE, MEASURED rather than assumed: the `!docKind` half of the first guard is REDUNDANT
 * today — an unreported kind is not in `WORKFLOW_OF_KIND` either, so it already falls out at
 * `!is`. It was mutated away and the suite stayed green. It is kept because reading "no kind, no
 * verdict" off the first line is what makes the rest of the function safe to read, and because a
 * kind added to that map later would make it load-bearing at once. The BEHAVIOUR is pinned either
 * way (F2), which is the thing that matters; do not read the guard as a check that bites.
 */
export function workflowMismatch(chosen, docKind) {
  if (!chosen || !docKind) return null;
  // One option is a TERM SHEET whatever was intended — that is the other workflow entirely, and
  // the row's own button is where it belongs. Saying so beats a silent nothing.
  if (docKind === 'term_sheet') {
    return 'Only one option is collected, so this would come out as a term sheet. Collect another, '
      + 'or issue the one from its own row.';
  }
  const is = WORKFLOW_OF_KIND[docKind];
  if (!is || is === chosen) return null;
  if (chosen === 'prices') {
    return 'These options were priced on different scenarios, so this would come out as a comparison '
      + 'of DEALS rather than of prices. Remove the odd one out, or switch to comparing deals.';
  }
  return 'These options were all priced on the same scenario, so this would come out as a comparison '
    + 'of PRICES rather than of deals. Price a different scenario and add one, or switch to comparing prices.';
}

/**
 * The board's comparison area: pick what you are building, see what you have, issue it.
 *
 * ⛔ IT RENDERS WHETHER OR NOT ANYTHING IS COLLECTED. It is the entry point the owner asked for
 * ("on top, somewhere"), and an entry point that appears only once you have already started is not
 * an entry point. The STRIP below it is the opposite and stays that way — a list of collected
 * options is furniture when there are none.
 */
export function ComparisonWorkflowPanel({
  enabled, chosen, onChoose, count, docKind, children, note, offBoard, initialOpen,
}) {
  /* ⛔ EVERY HOOK IS ABOVE THE EARLY RETURN. `enabled` flips at runtime (the cart hook
     resolves after the first paint), so a hook below it renders a different number of
     hooks on the second pass and React throws. Guarded by test-react-hook-order. */
  /* ⛔ THE BODY FOLDS AWAY, AND IT OPENS ITSELF WHEN SOMETHING IS COLLECTED.
     Before anybody has chosen a workflow the body is two option cards explaining a
     choice — 130 points of it — and the header bar alone already says what this area
     is and how much is in it. So the bar is always there and the body is not, which
     is the difference between an entry point and a wall.
     It OPENS on the first thing collected, which is the owner's 2026-08-30 *"pop up
     each and every thing that you are adding to the comparisons"*; the toggle then
     belongs to the person, so a deliberate Hide is not undone by the next tick. */
  const [open, setOpen] = useState(() => !!initialOpen || !!chosen || (count || 0) > 0);
  const lastCount = useRef(count || 0);
  useEffect(() => {
    const n = count || 0;
    if (n > lastCount.current) setOpen(true);
    lastCount.current = n;
  }, [count]);

  /* ⛔ `--lt-comp-h` IS GONE, AND NOTHING REPLACES IT. This rail used to publish its own
     measured height so the search strip below could be pushed down by exactly that much,
     because the rail was PINNED above it. The two pins plus the app header held 442
     points of the viewport at all times (owner-reported 2026-09-01: *"three separate
     sections stacked on top of each other … you can't even access it to see rates, and
     you can't scroll"*), so the rail moved below the board and stopped pinning.

     A clearing effect was written and then removed rather than kept as insurance: the
     stylesheet and this component ship in ONE bundle, so there is no state in which a
     sheet still reads the variable while this code no longer writes it — and the sheet's
     own `var(--lt-comp-h, 0px)` fallback is gone with it. A guard that cannot bite is
     not worth the line that implies it does. */

  if (!enabled) return null;
  const warn = workflowMismatch(chosen, docKind);
  const picked = COMPARISON_WORKFLOWS.find((w) => w.key === chosen) || null;
  return (
    <div id="lt-comparison" className="lt-comp-rail" style={{
      border: `1px solid ${GOLD}55`, borderRadius: 12, background: '#fff', marginBottom: 12,
    }}>
      <div style={{
        padding: '9px 13px', borderBottom: `1px solid ${GOLD}33`, background: PAPER,
        borderRadius: '12px 12px 0 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: 11, letterSpacing: '.07em', textTransform: 'uppercase', fontWeight: 700, color: GOLD_TEXT,
        }}>
          Build a comparison
        </span>
        <span style={{ fontSize: 11.5, color: count ? INK : MUTED, fontWeight: count ? 700 : 400 }}>
          {count ? `${count} option${count === 1 ? '' : 's'} collected` : 'Nothing collected yet'}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost" style={{ fontSize: 12 }}
          aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : (count ? 'Show what is collected' : 'Start a comparison')}
        </button>
      </div>
      {open && (
      <div className="lt-comp-body">
      {/* ⛔ THE CHOOSER COLLAPSES ONCE IT HAS BEEN ANSWERED — two paragraphs explaining a
          choice already made are the first thing that should fold away. (This used to
          reason from the rail being PINNED; it no longer is, and the rule stands on its
          own: nobody re-reads the explanation of a decision they have taken.) */}
      {picked ? (
        <div style={{
          padding: '9px 13px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>{picked.title}</span>
          <button type="button" onClick={() => onChoose(null)} style={{
            border: 0, background: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
            fontSize: 12, fontWeight: 700, color: GOLD_TEXT, textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}>change</button>
        </div>
      ) : (
      <div style={{ padding: 11, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {COMPARISON_WORKFLOWS.map((w) => {
          const on = chosen === w.key;
          return (
            <button
              key={w.key}
              type="button"
              aria-pressed={on}
              onClick={() => onChoose(on ? null : w.key)}
              style={{
                flex: '1 1 260px', minWidth: 240, textAlign: 'left', cursor: 'pointer',
                border: on ? `1px solid ${GOLD}` : '1px solid rgba(20,27,34,.14)',
                background: on ? PAPER : '#fff', borderRadius: 10, padding: '9px 11px',
              }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{w.title}</div>
              <div style={{ fontSize: 12, color: SLATE, lineHeight: 1.5, marginTop: 3 }}>{w.blurb}</div>
            </button>
          );
        })}
      </div>
      )}
      {/* ⛔ SAY WHAT PICKING ONE DOES, in the panel that offers it. Owner-reported
          2026-08-30: *"I can't figure it out."* A chooser that silently turns on
          tick-boxes elsewhere on the page teaches nobody where to look next. */}
      <div style={{
        padding: '8px 13px', borderTop: `1px solid ${GOLD}33`,
        fontSize: 12.5, lineHeight: 1.5, color: chosen ? INK : MUTED,
      }}>
        {chosen
          ? 'Now tick the programs below to put them in. Untick one to take it out.'
          : 'Pick one of the two above, then tick the programs you want on the board below.'}
      </div>
      {/* WHAT THE LAST TICK DID — the owner's *"what you selected and what you
          removed"*. A tick that changes nothing visible leaves somebody
          wondering whether it saved. */}
      {note && note.text ? (
        <div style={{
          padding: '7px 13px', borderTop: `1px solid ${GOLD}33`, fontSize: 12.5,
          color: note.tone === 'bad' ? CAUTION : GOLD_TEXT, fontWeight: 600,
        }}>{note.text}</div>
      ) : null}
      {warn ? (
        <div style={{
          padding: '8px 13px', borderTop: `1px solid ${GOLD}33`,
          fontSize: 12.5, lineHeight: 1.5, color: CAUTION,
        }}>{warn}</div>
      ) : null}
      {/* ⛔ THE CART SPANS SEARCHES, SO SAY SO. An officer looking at four
          collected options and three ticks would otherwise read the fourth as a
          tick that failed — it is simply not on the board in front of them. */}
      {offBoard > 0 ? (
        <div style={{
          padding: '7px 13px', borderTop: `1px solid ${GOLD}33`, fontSize: 12,
          color: MUTED, lineHeight: 1.5,
        }}>
          {`${offBoard} of these ${offBoard === 1 ? 'was' : 'were'} priced in an earlier search, `
            + 'so there is no row to tick on this board. They are still in — remove them below.'}
        </div>
      ) : null}
      {children}
      </div>
      )}
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
export function ComparisonStrip({ open, cart, members, onChange, onIssued, onPlan, busy: outerBusy }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [issued, setIssued] = useState(null);
  // ⛔ THE OFFICER ISSUING IT PUTS THE PERSON AND THE PROPERTY ON IT. The owner
  // asked for exactly this: *"We need to give the availability for the one
  // issuing it to put in the full property address and the person's name as
  // well."* A TERM SHEET is refused without them — it is a formal offer with a
  // signature block, and a signature line over a blank "Prepared for" is a
  // defective document. A comparison needs neither.
  const [prepared, setPrepared] = useState({ borrowerName: '', entityName: '', propertyAddress: '' });
  // A program the white-label sheet has not named yet, named here by the officer.
  const [names, setNames] = useState({});
  /* §40 — how many POINTS each collected option's price is evened out by, keyed on
     the member the same way `names` is. Held here rather than on the cart row on
     purpose: the adjustment is a decision about the DOCUMENT being assembled, and
     the server re-derives every figure from it at preview and again at issue, so
     nothing half-decided is ever written down as priced. */
  const [adjusts, setAdjusts] = useState({});
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
    // db/651 — the cart is where a comparison is assembled, so the staff-only
    // record of who funds each option has to survive the round trip: an option
    // parked here and issued an hour later must name the same investor as one
    // issued straight off the board. It is stored on the cart member and handed
    // straight back; nothing here reads or reshapes it.
    internal: m.internal,
    pricedAt: m.priced_at,
    // §40 — evened out of OUR compensation. The server re-prices the whole option
    // from it; nothing about the money is worked out on this screen.
    priceAdjustment: adjusts[m.id] == null ? null : adjusts[m.id],
  })), [members, names, adjusts]);

  // ⛔ WHICH DOCUMENT THIS IS, AND WHAT IS STILL MISSING, COME FROM THE SERVER.
  // The kind is derived from the options and the gate is the same function the
  // issue enforces, so the strip can never promise a term sheet the issue then
  // refuses. Asked when the collected options change — not on every keystroke in
  // the two text boxes, whose own emptiness is visible without a round trip.
  useEffect(() => {
    let dead = false;
    if (!open || !members.length) { setPlan(null); if (onPlan) onPlan(null); return undefined; }
    // DEBOUNCED, because `names` is in the dependencies and it changes on every
    // keystroke in the manual program-name box — an undebounced effect would
    // post a preview per character typed.
    const t = setTimeout(async () => {
      try {
        const r = await ltApi.termSheetPreview({ selections: selectionsOf(), anchorIndex: anchor });
        if (!dead) setPlan({ docKind: r.docKind, gate: r.gate, expiryHours: r.expiryHours });
        // ⛔ THE KIND IS REPORTED UP, NEVER RE-DERIVED ABOVE. The workflow panel needs to
        // know what this cart would actually produce, and there is exactly one place that
        // knows: the server. A second reading on the board could tell the officer their
        // collection matches an intent it does not.
        if (!dead && onPlan) onPlan(r.docKind || null);
      } catch (e) {
        // A preview that cannot be built is not a refusal to issue — the issue
        // will say so itself, in the server's own words.
        if (!dead) setPlan({ error: (e && (e.message || e.error)) || null });
      }
    }, 350);
    return () => { dead = true; clearTimeout(t); };
  }, [open, members, names, adjusts, anchor, selectionsOf]);

  async function issue() {
    setBusy('issue'); setNote(null);
    try {
      const r = await ltApi.termSheetIssue({
        selections: selectionsOf(),
        anchorIndex: anchor,
        cartId: cart && cart.id,
        prepared: {
          borrowerName: prepared.borrowerName || null,
          entityName: prepared.entityName || null,
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
          {/* Tells the BOARD as well, or an empty strip would stay mounted for ever on a
              parent that keeps it up while there is a result to show. */}
          <button type="button" style={btn()}
            onClick={() => { setIssued(null); if (onIssued) onIssued(null); }}>Start another</button>
        </div>
        <SendToBorrower code={issued.code} />
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
      // EITHER name clears the party line, which is the gate's own rule — judged
      // here only so typing clears the sentence without a round trip. The server
      // refuses either way; this is what the officer reads, not what decides.
      .filter((k) => (k === 'partyName'
        ? !(prepared.borrowerName.trim() || prepared.entityName.trim())
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
                {/* ⛔ THE PRICE, WHICH THIS ROW NEVER SHOWED (owner-directed 2026-08-31:
                    *"It also needs to come up with how much the program is, like how many
                    points it is, 101, 98, whatever."*).

                    A rate alone does not say what an option COSTS, so two rows at the same
                    rate read as the same deal while one is at 98 and the other at 101.5 —
                    which is precisely the comparison this strip exists to make.

                    ⛔ IT IS THE PRICE AFTER OUR COMPENSATION, read off the member's OWN
                    stored `charges` (`overlay.quoteCharges` → `displayPrice`), never
                    recomputed here and never the raw vendor price. The raw price is the
                    number before our compensation; showing it beside a borrower-facing
                    rate would put two different stories on one line, and it is also the
                    figure §40's adjuster moves AGAINST. One number, one source. */}
                <span style={{ fontSize: 12, color: INK, fontWeight: 600, ...NUM }}
                  title="The price after our compensation">
                  {m.charges && m.charges.displayPrice != null
                    ? Number(m.charges.displayPrice).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
                    : '—'}
                </span>
                <span style={{ fontSize: 11.5, color: MUTED }}>{p.consumerLabel || ''}</span>
                <span style={{ fontSize: 11.5, color: MUTED }}>
                  {m.mode === 'lenderPaid' ? 'lender paid' : 'borrower paid'}{m.waive_lender_fees ? ' · fees waived' : ''}
                </span>
                <span style={{ flex: 1 }} />
                {/* §40 — PER OPTION, because a comparison is several offers and the
                    owner rounds them one at a time. The mode is this member's own:
                    three framings of one deal legitimately sit side by side, and the
                    compensation an adjustment comes out of is different in each.

                    ⛔ ON THE ROW'S OWN LINE, closed. It used to sit in a full-width wrapper
                    under every row, so each collected option was two lines tall and a cart
                    of eight ran to a screen and a half (owner-reported 2026-09-02: the rail
                    "gets very tightened up"). Closed it is one small button and belongs
                    beside Remove; opened, the panel takes the whole line below by itself
                    (`flexBasis: 100%` on its open root), so nothing here has to know which
                    state it is in. Remove stays last — the destructive action at the end. */}
                <PriceAdjuster
                  compact
                  mode={m.mode}
                  rawPrice={(m.program || {}).rawPrice}
                  value={adjusts[m.id] == null ? null : adjusts[m.id]}
                  onChange={(pts) => setAdjusts((st) => ({ ...st, [m.id]: pts }))}
                />
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
            {/* ⛔ TWO BOXES, NOT ONE. This was a single "Borrower or entity name",
                which is precisely the muddle the owner's *"and/or"* resolves: the
                two are different parties who sign different lines — on a DSCR loan
                the entity is the BORROWER and the person GUARANTEES it — so one
                box put whichever was typed on whichever line the sheet drew. */}
            <label style={{ display: 'block' }}>
              <span style={fieldLabel()}>Borrower&rsquo;s name</span>
              <input value={prepared.borrowerName} style={field()}
                onChange={(e) => setPrepared((s) => ({ ...s, borrowerName: e.target.value }))}
                placeholder="Jonathan Reyes" />
            </label>
            <label style={{ display: 'block' }}>
              <span style={fieldLabel()}>Vesting entity</span>
              <input value={prepared.entityName} style={field()}
                onChange={(e) => setPrepared((s) => ({ ...s, entityName: e.target.value }))}
                placeholder="Riverbend Holdings LLC" />
              <span style={{ fontSize: 11, color: MUTED }}>Either name is enough</span>
            </label>
            <label style={{ display: 'block' }}>
              <span style={fieldLabel()}>Full property address</span>
              <AddressField id="cs-addr" value={prepared.propertyAddress}
                onChange={(v) => setPrepared((s) => ({ ...s, propertyAddress: v }))}
                placeholder="218 Forest Avenue, Lakewood, NJ 08701" style={{ marginTop: 3 }} />
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
            <SendToBorrower code={d.code} />
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
/**
 * `active` defaults to TRUE, so every existing caller behaves exactly as it always has. A board
 * with no term-sheet cart passes false and this never asks the server for one — which is the
 * honest thing as well as the cheap one: an engine under audit must not issue a document a
 * borrower reads, so it has no business holding a cart at all.
 */
export function useTermSheetCart(active = true) {
  const [state, setState] = useState({ enabled: false, cart: null, members: [] });
  /* THE SHEET THAT WAS JUST ISSUED, HELD ABOVE THE CART (owner-reported 2026-08-30: *"when you
     add a few things and then you export, it doesn't work. It doesn't download anything, and it
     disappears. Everything."*).

     ISSUING EMPTIES THE CART — the server clears it, correctly, because the sheet has been made.
     But the board mounted the strip only while the cart HAD something in it, and the strip is
     where the issued card lives. So the ID and the Download button were destroyed in the same
     tick they were created: the sheet was written, the officer saw nothing, and the collected
     options vanished with it. The result therefore cannot live inside the thing the result
     empties. Held here, the board can keep the strip up until the person is done with it. */
  const [issued, setIssued] = useState(null);
  const reload = useCallback(async () => {
    // Not asked for: leave the state exactly as it started. Writing the same shape back would be
    // a second render for nothing.
    if (!active) return;
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
  }, [active]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, count: state.members.length, issued, setIssued };
}
