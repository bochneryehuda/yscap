import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage, askConfirm, askPrompt } from '../lib/dialog.js';
import { fmtDay } from '../lib/dates.js';
import { US_STATES } from '../components/LlcManager.jsx';

/**
 * THE BULK PROPERTY WORKBENCH (blueprint §9.5, owner-directed 2026-08-09)
 *
 * The owner: *"Staff should not go in only one at a time. They should have a
 * view where they can just search and see all the properties that come in …
 * They can select which properties they want to import and then review the
 * information for each and every property for accuracy."*
 *
 * ═══ TICKING AND READING ARE TWO DIFFERENT JOBS ════════════════════════════
 * Ticking is cheap and can be done in bulk. READING is expensive and is the
 * step that carries the risk, so it is always per property. THE TICK THEREFORE
 * IMPORTS NOTHING — it builds a REVIEW RUN, and the run is walked one property
 * at a time. That is the owner's own sentence ("review the information for each
 * and every property for accuracy"), and independently it is what photo
 * culling, e-discovery review and bank reconciliation all converged on.
 *
 * ═══ BULK DECLINE YES, BULK IMPORT NEVER ══════════════════════════════════
 * The same asymmetry `pillar-actions.js` already runs on: an action that only
 * WITHHOLDS credit is safe to do in bulk; one that ADDS it is not. Declining
 * forty properties that are not this borrower's is a chore with no downside.
 * Importing forty unread ones puts forty unchecked deals on somebody's record
 * and prices a loan on them.
 *
 * ═══ NO CONFIDENCE NUMBER ON A ROW, EVER ══════════════════════════════════
 * The band is `exact` / `near` / `none` and the row shows the REASON, never a
 * score. A percentage would be describing county coverage and would read as a
 * judgement about the borrower — the same rule the workspace's evidence card
 * follows.
 *
 * ═══ ASYMMETRIC DEFAULTS ══════════════════════════════════════════════════
 * A candidate that MATCHES a line already on the record pre-selects "match"
 * (conservative: it joins what is there rather than adding). A NEW candidate
 * pre-selects NOTHING — adding a property to somebody's record is not a default.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';
const AMBER = '#8A6D1F';

/* The three deal types, worded plainly, for the deal-type dropdown. The values
   are the canonical forms the server's `canonicalDealType` accepts. */
const DEAL_TYPES = [
  ['flip', 'Fix & flip — bought, fixed, sold'],
  ['hold', 'Fix & hold / rental — kept it'],
  ['ground-up', 'Ground-up — built it'],
];
/* Map whatever the records happen to carry to one of the three dropdown values
   (the SAME buckets the server sorts by), so a candidate that already implies a
   type pre-selects it; anything unrecognised leaves the dropdown on "Choose…". */
const canonDealType = (v) => {
  const s = String(v || '').toLowerCase();
  if (s.includes('ground') || s.includes('construction')) return 'ground-up';
  if (s.includes('hold') || s.includes('rental') || s.includes('rent')) return 'hold';
  if (s.includes('flip')) return 'flip';
  return '';
};
/* THE CHOSEN deal type: the reviewer's own pick if they made one (including a
   deliberate blank), else the server's Elementix-derived SUGGESTION, else
   whatever the records already implied. `??` (not `||`) so an explicit "Choose…"
   clears the default instead of snapping back to it. */
const chosenTypeOf = (c, dealChoice) => dealChoice[c.id] ?? c.dealTypeDerived ?? canonDealType(c.dealType);
/* Does the records-carried data already say how it exited? A sale (the flip's
   exit) OR a refinance OR a lease (the hold's exit). When none is on record and
   the deal is a hold/ground-up, the workbench asks the reviewer for one. */
const hasExitFigure = (c) => !!(c.saleDate || money(c.salePrice) || c.refiDate || money(c.refiAmount)
  || c.rentDate || money(c.rentAmount));

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};
/* THE DATE IS THE REPO'S ONE FORMAT — never a private one written here.
   This function used to be `${d}/${m}/${yy}`, which is DAY/MONTH and reads as a
   different date to everybody who uses this: on a real reviewer's screen a sale
   on 2 March 2025 printed "02/03/25", which an American reads as 3 February.
   Found by opening the screen in a browser and looking at it — every source
   guard passed the whole time, because the bug was that the digits were in the
   wrong ORDER, not that they were missing.

   It is worse than a lone wrong format: `StaffBorrowerDetail` renders the
   borrower's EXISTING record with `fmtDay` (MM/DD/YYYY, locale pinned to en-US)
   directly BELOW this list, so one screen showed the same day two ways and
   invited a reviewer to compare them. Dates decide whether a deal falls inside
   the frozen 36-month window, so a misread here is not cosmetic.

   `fmtDay` also pins the locale, which a hand-rolled `toLocaleDateString()`
   does not — that would silently re-order itself on a machine set to en-GB. */
const day = (d) => fmtDay(d) || null;

/** The band, in words. Never a number — see the header. */
const BAND = {
  exact: { label: 'Already on the record', color: TEAL,
    hint: 'Both address comparisons agree this is a line you already have.' },
  near: { label: 'Not sure', color: AMBER,
    hint: 'This resembles a line you already have, but we are not certain it is the same property.' },
  none: { label: 'New', color: MUTED, hint: 'Nothing on the record looks like this one.' },
};

/* The exit the reviewer entered, in the shape the import route whitelists. Null
   when they picked no exit or nothing was typed — importNew fills a blank only,
   so a null / empty pair is a safe no-op. */
const exitPayloadOf = (draft) => {
  if (!draft || !draft.mode) return null;
  if (draft.mode === 'refi') return { refiAmount: draft.refiAmount || null, refiDate: draft.refiDate || null };
  if (draft.mode === 'rent') return { rentAmount: draft.rentAmount || null, rentDate: draft.rentDate || null };
  return null;
};

/**
 * THE GUIDED EXIT (owner-directed 2026-08-10) — for a rental / ground-up the
 * county records did not carry an exit for. A hold counts toward experience only
 * once it has an exit date, so this is where a refinance or a lease is entered.
 * GUIDED, not a free-text box (#8): buttons pick the path; the two fields are a
 * dollar amount and a date, which genuinely have to be typed. Optional — the
 * reviewer can leave it and fill it in on the line later.
 */
function ExitPrompt({ draft, setDraft }) {
  const mode = (draft && draft.mode) || null;
  const seg = (m, label) => (
    <button type="button" className={mode === m ? 'btn primary small' : 'btn ghost small'}
      style={{ minHeight: 38, color: mode === m ? undefined : INK }}
      onClick={() => setDraft({ mode: mode === m ? null : m })}>
      {label}
    </button>
  );
  const field = (label, val, onChange, type, placeholder) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13, color: INK }}>
      <span style={{ color: MUTED }}>{label}</span>
      <input className="input" type={type} value={val || ''} placeholder={placeholder || ''}
        onChange={(e) => onChange(e.target.value)}
        style={{ minHeight: 40, fontSize: 16, minWidth: 150, color: INK, background: '#fff' }} />
    </label>
  );
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #EAE4D7' }}>
      <div style={{ color: INK, fontSize: 13, marginBottom: 6 }}>
        The records don’t show how this one exited. A rental counts toward experience once it’s been
        leased up or refinanced — add it now, or leave it and fill it in later.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {seg('refi', 'It was refinanced')}
        {seg('rent', 'It was leased up')}
      </div>
      {mode === 'refi' ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          {field('Refinance amount ($)', draft && draft.refiAmount, (v) => setDraft({ refiAmount: v }), 'number', 'e.g. 240000')}
          {field('Refinance date', draft && draft.refiDate, (v) => setDraft({ refiDate: v }), 'date')}
        </div>
      ) : null}
      {mode === 'rent' ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          {field('Monthly rent ($)', draft && draft.rentAmount, (v) => setDraft({ rentAmount: v }), 'number', 'e.g. 2200')}
          {field('Date it was leased', draft && draft.rentDate, (v) => setDraft({ rentDate: v }), 'date')}
        </div>
      ) : null}
    </div>
  );
}

export default function StaffPropertyWorkbench({ borrowerId, borrowerName }) {
  const [q, setQ] = useState(null);
  const [busy, setBusy] = useState(false);
  const [searchMsg, setSearchMsg] = useState(null);
  const [ticked, setTicked] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [run, setRun] = useState(null);      // the review run: ids, in order
  const [runAt, setRunAt] = useState(0);     // where we are in it
  const [compare, setCompare] = useState(null);
  /* THE DEAL TYPE IS A DROPDOWN, NEVER A TYPE-IN (owner-directed 2026-08-10:
     "we should not need to type because then it can be a mess"). Kept per
     candidate id (like ConfirmFoundProperties' `kind`), so moving between
     properties never carries one property's answer onto another. */
  const [dealChoice, setDealChoice] = useState({});
  /* THE EXIT the reviewer confirms for a hold the records did not carry one for
     (owner-directed 2026-08-10: "if refinanced, collect missing details … when
     it was leased and for how much"). Kept per candidate id, shape
     { mode:'refi'|'rent', refiAmount, refiDate, rentAmount, rentDate }, so a
     figure typed for one property never rides onto another. A hold with no exit
     date counts toward nothing (the frozen rule), so collecting it here is what
     lets a refinanced or leased rental actually reach the tier. */
  const [exitDraft, setExitDraft] = useState({});
  /* WHICH STATES TO PULL (owner-directed 2026-08-09: "make a drop-down to
     select which states we want to pull in — we should be able to pull each
     and every state separately for that person"). The records service files
     companies AND people BY STATE, so a picked state makes the exact matchers
     usable; none picked is the general search, which can only answer "found
     in more than one state — pick one". */
  const [pickStates, setPickStates] = useState(() => new Set());
  const statesRef = useRef(null);   // the <details> popover — closed when a search starts
  /* THE BUDGET METER (mega-workspace phase F): what a search costs is visible
     BEFORE the button is pressed — lookups this hour against the office's
     shared hourly allowance, and paid contact credits this month against the
     owner's monthly cap. Read-only; the caps that actually refuse a call live
     server-side. Unknown reads as "unknown", never as zero. */
  const [usage, setUsage] = useState(null);
  const loadUsage = useCallback(() => {
    api.staffElementixUsage()
      .then((u) => setUsage(u && typeof u === 'object' ? u : null))
      .catch(() => setUsage(null));
  }, []);
  useEffect(() => { loadUsage(); }, [loadUsage]);

  const load = useCallback(async () => {
    if (!borrowerId) return;
    try { setQ(await api.staffTrackRecordCandidates(borrowerId)); }
    catch { setQ({ toReview: [], alreadyHere: [], declined: [] }); }
  }, [borrowerId]);
  useEffect(() => { load(); }, [load]);

  /* EVERY HOOK SITS ABOVE THE FIRST RETURN — and `current` and `openCompare`
     come with them, deliberately, even though they read better next to the
     review pane below.

     React counts hooks per render. A hook below the `if (!q)` guard is ONE hook
     on the first paint (while the list is still loading) and TWO on the next,
     which is the "Rendered more hooks than during the previous render" CRASH —
     the whole screen, not a warning. Moving the effect alone is not enough:
     `current` is a const, so when the guard returns early it is never
     initialised, and the effect would fire against its dead zone. The effect,
     the value it reads, and the function it calls travel together. */
  const current = q && run && run[runAt] ? (q.toReview || []).find((r) => r.id === run[runAt]) : null;

  async function openCompare(id) {
    try { setCompare(await api.staffCompareCandidate(id)); }
    catch { setCompare(null); }
  }
  useEffect(() => { if (current && current.matchTrackRecordId) openCompare(current.id); else setCompare(null);
    /* eslint-disable-next-line */ }, [run, runAt]);

  if (!q) return null;
  const rows = (q.toReview || []).filter((r) => {
    const t = filter.trim().toLowerCase();
    if (!t) return true;
    return `${r.address} ${r.entityName || ''}`.toLowerCase().includes(t);
  });

  /* SEARCHING SPENDS THE OFFICE'S SHARED HOURLY ALLOWANCE, so it is a deliberate
     click and never a page load, and the button says what it will do. */
  async function search() {
    if (busy) return;
    const states = [...pickStates];
    if (!(await askConfirm(
      'This looks the borrower up in the public records'
      + (states.length ? `, state by state (${states.join(', ')})` : '')
      + '. It uses part of the office\'s hourly lookup allowance, which is shared with everyone.',
      { confirmLabel: 'Search the records', cancelLabel: 'Not now' }))) return;
    if (statesRef.current) statesRef.current.open = false;
    setBusy(true); setSearchMsg(null);
    try {
      const out = await api.staffTrackRecordSearch(borrowerId, { states });
      /* The SERVER decides this sentence — two screens must not word "we found
         nothing" two different ways, and only one of the readings is about the
         borrower. */
      setSearchMsg({ text: out.summary, nothingToSearch: out.nothingToSearch === true,
        skips: out.skips || [] });
      await load();
      loadUsage();
    } catch (e) {
      await showMessage((e && e.message) || 'The search did not run.', { title: 'Not searched' });
    } finally { setBusy(false); }
  }

  function toggle(id) {
    setTicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleState(code) {
    setPickStates((s) => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  }
  function tickAllShown() {
    setTicked((s) => { const n = new Set(s); rows.forEach((r) => n.add(r.id)); return n; });
  }

  /* THE TICK IMPORTS NOTHING. It builds the run, and the run is walked.
     Starting a run also says "I am on these", so a colleague opening the same
     borrower is not re-reading the same deeds. That claim is ADVISORY — it is
     never checked before a decision, and a property somebody else is holding
     still goes into the run. We only SAY so. */
  async function startRun() {
    const ids = rows.filter((r) => ticked.has(r.id)).map((r) => r.id);
    if (!ids.length) return;
    setRun(ids); setRunAt(0); setCompare(null);
    try {
      const out = await api.staffClaimCandidates(borrowerId, { ids });
      const held = (out && out.heldByOthers) || [];
      if (held.length) {
        const names = [...new Set(held.map((h) => h.by))].join(', ');
        await showMessage(
          `${held.length === 1 ? 'One of these is' : `${held.length} of these are`} already being reviewed by ${names}.`
          + '\n\nYou can still review them — this is only so two people do not read the same deeds twice.',
          { title: 'Somebody else is on it' });
      }
      load();
    } catch { /* advisory — a failed claim never stops the review */ }
  }

  /* BULK DECLINE IS ALLOWED — it can only ever WITHHOLD credit. It still needs
     a reason, because the next search reads that reason to avoid re-raising the
     property, and "no reason given" would make the suppression unexplainable. */
  async function declineTicked() {
    const ids = rows.filter((r) => ticked.has(r.id)).map((r) => r.id);
    if (!ids.length) return;
    const why = await askPrompt(
      `Why are these ${ids.length} not this borrower's? The next search reads this, so it will not raise them again.`,
      { placeholder: 'e.g. a different Moses Weil', confirmLabel: 'Mark them not theirs' });
    if (why === null) return;
    if (!String(why).trim()) { await showMessage('Add a short reason — the next search reads it.'); return; }
    setBusy(true);
    let done = 0; const failed = [];
    for (const id of ids) {
      try { await api.staffDecideCandidate(id, { action: 'decline', note: why }); done += 1; }
      catch { failed.push(id); }
    }
    setBusy(false); setTicked(new Set());
    await load();
    /* NEVER a silent partial. */
    if (failed.length) {
      await showMessage(`${done} marked as not theirs. ${failed.length} did not save — they are still in the list.`,
        { title: 'Partly done' });
    }
  }

  async function decide(id, action, extra) {
    setBusy(true);
    try {
      await api.staffDecideCandidate(id, { action, ...(extra || {}) });
      setRunAt((n) => n + 1);
      await load();
    } catch (e) {
      /* THE CODE LIVES ON `e.data.code` — api.js sets `err.status` and
         `err.data`, never a bare `err.code`. Reading `e.code` here made BOTH
         branches unreachable (proven over real HTTP): the server's 409 said
         "Confirm if that is what you want" and the screen showed it in a box
         with one OK button — "Join it to the line we have" was a dead end on
         every verified line. Every other call site in app-v2 reads
         `e.data.code`; this one now does too. */
      const code = (e && (e.code || (e.data && e.data.code))) || null;
      if (code === 'would_reopen_verification') {
        if (await askConfirm(e.message, { confirmLabel: 'Yes, reopen it', cancelLabel: 'Leave it alone' })) {
          try { await api.staffDecideCandidate(id, { action, ...(extra || {}), confirmReopen: true });
            setRunAt((n) => n + 1); await load(); }
          catch (e2) { await showMessage((e2 && e2.message) || 'That did not save.'); }
        }
      } else if (code === 'deal_type_needed' || code === 'deal_type_unrecognized') {
        const why = (e && (e.why || (e.data && e.data.why))) || '';
        await showMessage(`${e.message}\n\n${why}`.trim(), { title: 'What kind of deal was it?' });
      } else {
        await showMessage((e && e.message) || 'That did not save.', { title: 'Not saved' });
      }
    } finally { setBusy(false); }
  }

  return (
    <section className="card" style={{ borderTop: `3px solid ${GOLD}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: INK }}>Properties from the public records</h3>
        <span style={{ color: MUTED, fontSize: 14 }}>
          {borrowerName ? `for ${borrowerName}` : ''}
        </span>
        <details ref={statesRef} style={{ position: 'relative', marginLeft: 'auto' }}>
          <summary className="btn ghost" style={{ listStyle: 'none', cursor: 'pointer', userSelect: 'none' }}>
            {pickStates.size ? `States: ${[...pickStates].join(', ')}` : 'States: any'} ▾
          </summary>
          <div style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 30, background: '#FFFFFF',
            border: '1px solid #EAE4D7', borderRadius: 10, boxShadow: '0 8px 24px rgba(20,27,34,.12)',
            padding: 12, width: 'min(340px, 90vw)',
          }}>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
              The public records file companies and people <strong>by state</strong>. Pick the state(s) you
              believe this borrower holds property in — each one is pulled separately. Nothing picked =
              a general search, which can only say “found in more than one state”.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {US_STATES.map((s) => (
                <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: INK, cursor: 'pointer' }}>
                  <input type="checkbox" checked={pickStates.has(s)} onChange={() => toggleState(s)} />{s}
                </label>
              ))}
            </div>
            {pickStates.size ? (
              <button type="button" className="btn ghost" style={{ marginTop: 8, fontSize: 13 }}
                onClick={() => setPickStates(new Set())}>
                Clear — search without a state
              </button>
            ) : null}
          </div>
        </details>
        <button type="button" className="btn ghost" onClick={search} disabled={busy}>
          {busy ? 'Working…' : 'Search the records'}
        </button>
      </div>

      {usage && (
        <div className="small" style={{ marginTop: 6, color: MUTED }}>
          Lookups this hour:{' '}
          <strong style={{ color: INK }}>
            {usage.ok ? `${usage.callsLastHour} of ${usage.hourCap}` : 'unknown'}
          </strong>
          {' '}(shared by the whole office) · Paid contact credits this month:{' '}
          <strong style={{ color: INK }}>
            {usage.ok ? `${usage.paidThisMonth} of ${usage.paidCap}` : 'unknown'}
          </strong>
        </div>
      )}

      {searchMsg ? (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 14, color: INK,
          background: searchMsg.nothingToSearch ? '#FDF6E3' : '#F4F1EA',
          border: `1px solid ${searchMsg.nothingToSearch ? GOLD : '#EAE4D7'}`,
        }}>
          {searchMsg.text}
          {searchMsg.skips && searchMsg.skips.length ? (
            <ul style={{ margin: '8px 0 0 18px', padding: 0, color: MUTED }}>
              {searchMsg.skips.slice(0, 8).map((s, i) => (
                <li key={i}>
                  {s.address ? `${s.address} — ` : (s.entity ? `${s.entity}${s.state ? ` (${s.state})` : ''} — ` : '')}
                  {s.why}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ── THE REVIEW RUN — one property at a time ───────────────────────── */}
      {run ? (
        <div style={{ marginTop: 16, border: `1px solid ${GOLD}`, borderRadius: 12, padding: 16, background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: MUTED, marginBottom: 10 }}>
            <span>Reviewing {Math.min(runAt + 1, run.length)} of {run.length}</span>
            <button type="button" className="linklike" onClick={() => { setRun(null); setTicked(new Set()); }}
              style={{ background: 'none', border: 0, color: TEAL, cursor: 'pointer', fontSize: 13 }}>
              Stop reviewing
            </button>
          </div>

          {!current ? (
            <div style={{ color: INK }}>
              <strong>That is all of them.</strong>
              <div style={{ color: MUTED, marginTop: 4, fontSize: 14 }}>
                Everything you brought on is on the record at <em>pending</em> — it counts toward nothing until each one is verified.
              </div>
              <button type="button" className="btn ghost" style={{ marginTop: 12 }}
                onClick={() => { setRun(null); setTicked(new Set()); }}>Back to the list</button>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 18, fontWeight: 650, color: INK }}>{current.address}</div>
              {/* EVERY FIGURE THE RECORDS CARRIED, pre-filled for the reviewer to
                  confirm (owner-directed 2026-08-10) — the purchase and sale a DEED
                  states, and the refinance and lease a MORTGAGE / MLS row states,
                  which are the hold's exit. */}
              <div style={{ marginTop: 5, color: MUTED, fontSize: 14 }}>
                {[current.purchaseDate ? `Bought ${day(current.purchaseDate)}${money(current.purchasePrice) ? ` for ${money(current.purchasePrice)}` : ''}` : null,
                  current.saleDate ? `sold ${day(current.saleDate)}${money(current.salePrice) ? ` for ${money(current.salePrice)}` : ''}` : null,
                  (current.refiDate || money(current.refiAmount)) ? `refinanced${current.refiDate ? ` ${day(current.refiDate)}` : ''}${money(current.refiAmount) ? ` for ${money(current.refiAmount)}` : ''}` : null,
                  (current.rentDate || money(current.rentAmount)) ? `leased${money(current.rentAmount) ? ` for ${money(current.rentAmount)}/mo` : ''}${current.rentDate ? ` (${day(current.rentDate)})` : ''}` : null,
                ].filter(Boolean).join(' · ') || 'The records did not give dates or figures.'}
              </div>
              {current.entityName ? (
                <div style={{ marginTop: 4, color: MUTED, fontSize: 14 }}>
                  Under <strong style={{ color: INK }}>{current.entityName}</strong>
                </div>
              ) : null}

              {/* The side-by-side, for a match. Conflicts are the decision; a
                  one-sided fill is informational. Rendered from the server's own
                  per-row note so the screen never re-decides one. */}
              {compare && compare.matched && compare.rows ? (
                <div style={{ marginTop: 12, border: '1px solid #EAE4D7', borderRadius: 8, overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#F4F1EA', color: INK, textAlign: 'left' }}>
                        <th style={{ padding: '6px 9px' }}>Field</th>
                        <th style={{ padding: '6px 9px' }}>On the record</th>
                        <th style={{ padding: '6px 9px' }}>In the records</th>
                        <th style={{ padding: '6px 9px' }}>What happens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compare.rows.map((r) => (
                        <tr key={r.field} style={{ borderTop: '1px solid #EAE4D7',
                          background: r.conflict ? '#FDF6E3' : 'transparent' }}>
                          <td style={{ padding: '6px 9px', color: MUTED }}>{r.field.replace(/_/g, ' ')}</td>
                          <td style={{ padding: '6px 9px', color: INK }}>{r.ours || <em style={{ color: MUTED }}>blank</em>}</td>
                          <td style={{ padding: '6px 9px', color: INK }}>{r.theirs || <em style={{ color: MUTED }}>blank</em>}</td>
                          <td style={{ padding: '6px 9px', color: r.conflict ? AMBER : MUTED }}>{r.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* ── CONFIRM THE DEAL (owner-directed 2026-08-10) — the type is
                  pre-selected from the records and the exit is pre-filled; the
                  reviewer confirms or changes it before bringing it on. ────── */}
              <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: '1px solid #EAE4D7', background: '#FAFAF7' }}>
                {/* THE DEAL TYPE IS A DROPDOWN, not a type-in (owner-directed
                    2026-08-10), pre-selected from the Elementix reading. */}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: INK, fontSize: 14, flexWrap: 'wrap' }}>
                  <span style={{ color: MUTED }}>Deal type</span>
                  <select className="input" style={{ minHeight: 44, minWidth: 240 }}
                    value={chosenTypeOf(current, dealChoice)}
                    onChange={(e) => setDealChoice((m) => ({ ...m, [current.id]: e.target.value }))}>
                    <option value="">Choose…</option>
                    {DEAL_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </label>
                {/* WHY the default was chosen — the server's own plain sentence,
                    so the reviewer confirms a suggestion, not a black box. */}
                {current.dealTypeWhy ? (
                  <div style={{ marginTop: 6, color: MUTED, fontSize: 13 }}>{current.dealTypeWhy}</div>
                ) : null}
                {/* THE GUIDED EXIT — only for a rental / ground-up the records did
                    not already show an exit for. A hold with no exit counts toward
                    nothing, so this is where a refinance or lease is added. */}
                {(chosenTypeOf(current, dealChoice) === 'hold' || chosenTypeOf(current, dealChoice) === 'ground-up') && !hasExitFigure(current) ? (
                  <ExitPrompt
                    draft={exitDraft[current.id]}
                    setDraft={(patch) => setExitDraft((m) => ({ ...m, [current.id]: { ...(m[current.id] || {}), ...patch } }))} />
                ) : null}
              </div>

              {/* ── THE ACTIONS ──────────────────────────────────────────────── */}
              <div className="act-bar" style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 12 }}>
                {current.matchTrackRecordId ? (
                  <button type="button" className="btn primary" disabled={busy}
                    onClick={() => decide(current.id, 'match_existing')} style={{ minHeight: 44 }}>
                    Join it to the line we have
                  </button>
                ) : null}
                <button type="button" className={current.matchTrackRecordId ? 'btn ghost' : 'btn primary'}
                  disabled={busy || !chosenTypeOf(current, dealChoice)}
                  title={chosenTypeOf(current, dealChoice) ? '' : 'Pick the kind of deal first'}
                  onClick={() => decide(current.id, 'import_new', {
                    dealType: chosenTypeOf(current, dealChoice),
                    exit: exitPayloadOf(exitDraft[current.id]),
                  })}
                  style={{ minHeight: 44 }}>
                  Bring it on as a new one
                </button>
                <button type="button" className="btn ghost" disabled={busy} style={{ minHeight: 44, color: INK }}
                  onClick={async () => {
                    const why = await askPrompt('Why is this not their property? The next search reads this.',
                      { confirmLabel: 'Not theirs' });
                    if (why === null) return;
                    if (!String(why).trim()) { await showMessage('Add a short reason — the next search reads it.'); return; }
                    decide(current.id, 'decline', { note: why });
                  }}>
                  Not theirs
                </button>
                <button type="button" className="btn soft" disabled={busy} style={{ minHeight: 44, color: INK }}
                  onClick={() => setRunAt((n) => n + 1)}>
                  Decide later
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ── THE LIST ───────────────────────────────────────────────────────── */}
      {!run ? (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 10px' }}>
            <input
              value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by address or company"
              style={{ flex: '1 1 220px', minWidth: 0, fontSize: 16, padding: '8px 10px',
                border: '1px solid #EAE4D7', borderRadius: 8, color: INK, background: '#fff' }}
            />
            <span style={{ color: MUTED, fontSize: 13 }}>
              {rows.length} waiting{ticked.size ? ` · ${ticked.size} ticked` : ''}
            </span>
          </div>

          {!rows.length ? (
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>
              Nothing is waiting. Press <strong>Search the records</strong> to look this borrower up.
            </p>
          ) : (
            <>
              <div style={{ border: '1px solid #EAE4D7', borderRadius: 10, overflow: 'hidden' }}>
                {rows.map((r) => {
                  const band = BAND[r.matchConfidence] || BAND.none;
                  return (
                    <label key={r.id} style={{
                      display: 'flex', gap: 11, alignItems: 'flex-start', padding: '11px 12px',
                      borderTop: '1px solid #EAE4D7', cursor: 'pointer', background: ticked.has(r.id) ? '#F4F1EA' : '#fff',
                    }}>
                      <input type="checkbox" checked={ticked.has(r.id)} onChange={() => toggle(r.id)}
                        style={{ marginTop: 3, width: 18, height: 18 }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', color: INK, fontWeight: 600 }}>{r.address}</span>
                        <span style={{ display: 'block', color: MUTED, fontSize: 13, marginTop: 2 }}>
                          {[r.purchaseDate ? `bought ${day(r.purchaseDate)}` : null,
                            r.saleDate ? `sold ${day(r.saleDate)}` : null,
                            r.entityName].filter(Boolean).join(' · ') || 'no dates in the records'}
                        </span>
                        {/* The REASON, never a score. */}
                        <span style={{ display: 'inline-block', marginTop: 5, fontSize: 12, color: band.color,
                          border: `1px solid ${band.color}`, borderRadius: 999, padding: '1px 8px' }}>
                          {band.label}
                        </span>
                        {r.matchConfidence === 'near' ? (
                          <span style={{ display: 'block', color: AMBER, fontSize: 12, marginTop: 4 }}>{band.hint}</span>
                        ) : null}
                        {/* SOMEBODY ELSE IS ON IT — advisory, and it names them:
                            "another reviewer" sends you hunting, a name ends it.
                            Never disables anything. */}
                        {r.claim && r.claim.held && !r.claim.mine ? (
                          <span style={{ display: 'block', color: MUTED, fontSize: 12, marginTop: 4 }}>
                            {r.claim.by} is reviewing this now
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="act-bar" style={{ marginTop: 12, display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" className="btn ghost" onClick={tickAllShown} disabled={busy} style={{ color: INK }}>
                  Tick all {rows.length} shown
                </button>
                {/* THE TICK IMPORTS NOTHING — this only opens the review. */}
                <button type="button" className="btn primary" onClick={startRun} disabled={busy || !ticked.size}>
                  Review {ticked.size || ''} one at a time
                </button>
                {/* Safe to do in bulk: it can only ever WITHHOLD credit. */}
                <button type="button" className="btn ghost" onClick={declineTicked} disabled={busy || !ticked.size}
                  style={{ color: INK }}>
                  Mark ticked as not theirs
                </button>
                <span style={{ color: MUTED, fontSize: 13, flexBasis: '100%' }}>
                  Ticking adds nothing to the record — it opens them for review one at a time. There is no bulk import,
                  on purpose: every property is read before it counts.
                </span>
              </div>
            </>
          )}

          {q.declined && q.declined.length ? (
            <details style={{ marginTop: 14 }}>
              <summary style={{ cursor: 'pointer', color: MUTED, fontSize: 14 }}>
                {q.declined.length} marked as not theirs
              </summary>
              <ul style={{ margin: '8px 0 0 18px', padding: 0, color: MUTED, fontSize: 13 }}>
                {q.declined.map((d) => (
                  <li key={d.id} style={{ marginBottom: 3 }}>
                    {d.address}
                    {d.decidedByBorrower ? (
                      <strong style={{ color: AMBER }}> — the borrower said this one is not theirs</strong>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
