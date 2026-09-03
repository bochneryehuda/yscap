import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, CAUTION, DANGER, card, eyebrow, sub, input, label, LINE, WASH } from './ppeStyles.js';

/**
 * "THIS INVESTOR AND THIS INVESTOR ARE THE SAME" — the side-by-side, and the link.
 *
 * Owner-directed 2026-08-30:
 *
 *   "we need to be able to link a investor from lender price and loannex by if the name is a
 *    little different the system should still understand that it's the same investor… Those
 *    investors are spelled differently and have different names, but we need to be able to link it
 *    and say, 'This investor and this investor are the same.' … We should be able to link them
 *    together side by side and then select this one. Want to see from this program."
 *
 * WHAT WAS BROKEN, and it is why this screen exists at all: identity came from a hand-maintained
 * CODE registry and nothing else. A spelling the registry did not carry resolved to nothing, the
 * merge dropped that row, and the investor's WHOLE BOARD disappeared — with the only fix being a
 * code change. "A & D Mortgage - Delegated", a second channel of an investor already on the
 * board, was one of the names that vanished.
 *
 * ⛔ A SUGGESTION IS OFFERED, NEVER APPLIED. Nothing on this screen links anything on its own. An
 * automatic join would put one investor's pricing under ANOTHER investor's name, and that name is
 * the one thing a client may see.
 *
 * ⛔ THE LABEL ALWAYS COMES FROM THE CANONICAL INVESTOR. A link says which investor a spelling IS;
 * it can never invent an investor or rename one, which is why the pick-list is the server's and
 * there is no free-text investor field anywhere here.
 *
 * ⛔ THE WHOLE MAP IS SAVED, ALWAYS. A partial write cannot express a link somebody TOOK AWAY, and
 * a deleted link quietly surviving is the worst outcome on this screen.
 *
 * ⛔ NO ROSTER LIVES IN THIS FILE. The investors, the links and the suggestions all come from the
 * server, which derives them from the ONE effective roster — the code registry with the investors
 * somebody added by hand laid over it. A browser copy would be a second roster, and the one that
 * drifted is the one somebody would price a loan on. No investor is NAMED anywhere in this file
 * either: every name on this screen arrives from the server.
 *
 * `pairing` is OPTIONAL and is what the two boards ACTUALLY returned on the last price (the price
 * answer carries it). Given one, it is REMEMBERED for this browser session, so the settings screen
 * — where nothing has been priced — can still show the names that did not match and let somebody
 * fix them. It deliberately does NOT price anything to fill itself in: drawing a settings screen
 * must never cost two vendor calls.
 */

/** Where the last board's pairing is remembered, so the settings screen can use it. */
const PAIRING_CACHE_KEY = 'lt.combined.lastPairing';

/**
 * Remember the last board's pairing, and read it back.
 *
 * `sessionStorage` on purpose: it is this browser tab's own note about what it
 * last priced, not a fact about the company, and it must never outlive the
 * session and describe a board nobody has seen. Every access is wrapped —
 * private windows and locked-down browsers throw on the accessor itself, and a
 * settings screen may not fail to draw because of that.
 */
function rememberPairing(p) {
  try {
    if (p) window.sessionStorage.setItem(PAIRING_CACHE_KEY, JSON.stringify({ at: Date.now(), pairing: p }));
  } catch { /* a browser that refuses to remember is not an error */ }
}
function recallPairing() {
  try {
    const raw = window.sessionStorage.getItem(PAIRING_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && v.pairing ? v.pairing : null;
  } catch { return null; }
}

/** How a name was joined, in words rather than a code. */
const MATCH_NOTE = {
  link: 'you linked this',
  custom: 'an investor you added',
  exact: 'a recorded spelling',
  normal: 'a recorded spelling',
  prefix: 'a guess — please confirm',
  none: 'not recognised',
};

const pill = (bg, fg) => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11,
  fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap',
});

const ghostBtn = {
  border: `1px solid ${LINE}`, background: '#fff', color: INK, borderRadius: 8,
  padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
};

function NameCell({ entries }) {
  if (!entries || !entries.length) {
    return <span style={{ fontSize: 13, color: MUTED }}>— not quoted</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map((n) => (
        <div key={n.name}>
          <div style={{ fontSize: 13, color: INK, fontWeight: 600 }}>{n.name}</div>
          <div style={{ fontSize: 11, color: n.guessed ? CAUTION : MUTED }}>
            {MATCH_NOTE[n.match] || n.match}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * THE PICK-LIST — A TO Z, WITH A SEARCH BOX (owner-directed 2026-09-02: *"the
 * list should be alphabetical and I should be able to type to find a name"*).
 *
 * ⛔ IT IS DEFINED AT THE TOP OF THE FILE, NOT INSIDE THE SCREEN. A component
 * declared inside another component is a BRAND-NEW component type on every
 * render, so React throws the old one away and builds a fresh one — which on a
 * screen that re-renders as you type means the box loses focus and whatever was
 * typed into it, every keystroke. Defining it here (and memoising it) is what
 * makes the search box usable at all; moving it back inside would silently undo
 * the whole feature. `onPick` takes the NAME as well as the key so ONE stable
 * function serves every row rather than a fresh closure per render.
 *
 * The filter reads the label, the client-safe name and the key, because people
 * search by whichever of the three they happen to know.
 */
const Picker = React.memo(function Picker({ id, name, value, investors, onPick }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const shown = useMemo(() => {
    const all = (investors || []).slice().sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));
    if (!q) return all;
    return all.filter((i) => (
      String(i.label || '').toLowerCase().includes(q)
      || String(i.whiteLabel || '').toLowerCase().includes(q)
      || String(i.key || '').toLowerCase().includes(q)
    ));
  }, [investors, q]);

  // The one already chosen is ALWAYS an option, even while a search hides it —
  // a select whose current value is not among its options silently shows the
  // first one instead, which reads as the link having changed by itself.
  const chosen = value ? (investors || []).find((i) => i.key === value) : null;
  const options = chosen && !shown.some((i) => i.key === value) ? [chosen, ...shown] : shown;

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type to find an investor"
        aria-label="Search the investor list"
        style={{ ...input, maxWidth: 320, marginBottom: 6 }}
      />
      <select
        id={id}
        style={{ ...input, maxWidth: 320 }}
        value={value || ''}
        onChange={(e) => onPick(name, e.target.value)}
      >
        <option value="">— not linked —</option>
        {options.map((i) => (
          <option key={i.key} value={i.key}>
            {i.label}{i.whiteLabel ? ` (${i.whiteLabel})` : ''}{i.custom ? ' — added by hand' : ''}
          </option>
        ))}
      </select>
      {q && (
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
          {shown.length === 0
            ? 'No investor matches that. Clear the box to see them all.'
            : `${shown.length} of ${(investors || []).length} shown.`}
        </div>
      )}
    </div>
  );
});

/**
 * A link the store holds in an older shape — a bare investor key rather than an
 * object. The server's reader accepts both; the screen would read `.key` off a
 * string and show nothing, so it is normalised on the way in.
 */
function normaliseLinks(raw) {
  const out = {};
  for (const [name, v] of Object.entries(raw || {})) {
    if (typeof v === 'string') out[name] = { key: v };
    else if (v && typeof v === 'object') out[name] = { ...v };
  }
  return out;
}

export default function LtInvestorLinks({ pairing = null, onChanged = null, onAddInvestor = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  // The draft is the WHOLE map the Save will send: the stored links plus whatever
  // has been added or taken away on this visit. Kept separately from `data` so
  // opening the screen and pressing Save changes nothing.
  const [draft, setDraft] = useState(null);
  const [typed, setTyped] = useState('');
  const [typedSuggestions, setTypedSuggestions] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.combinedInvestorLinks()
      .then((r) => { setData(r); setDraft(normaliseLinks(r.links)); })
      .catch((e) => setErr((e && e.message) || 'The links could not be read.'));
  }, []);
  useEffect(load, [load]);

  // THE LAST BOARD, REMEMBERED. Given a live pairing this records it; given none
  // — the settings screen — it reads back what the last price put there, so the
  // names that did not match can be fixed from the screen a person is already on
  // instead of pricing a scenario again to see them.
  const [remembered, setRemembered] = useState(null);
  useEffect(() => {
    if (pairing) { rememberPairing(pairing); setRemembered(null); }
    else setRemembered(recallPairing());
  }, [pairing]);
  const board = pairing || remembered;
  const boardIsRemembered = !pairing && !!remembered;

  const investors = (data && data.investors) || [];
  const stored = useMemo(() => normaliseLinks(data && data.links), [data]);
  const links = draft || {};
  const dirty = useMemo(
    () => JSON.stringify(Object.keys(links).sort().map((k) => [k, links[k].key]))
      !== JSON.stringify(Object.keys(stored).sort().map((k) => [k, stored[k].key])),
    [links, stored],
  );

  // ONE stable function for every row's picker — see the note on `Picker`.
  const setLink = useCallback((name, key) => {
    setSaved(null); setNote(null);
    setDraft((s) => {
      const next = { ...(s || {}) };
      if (!key) delete next[name];
      // `source` is recorded so the screen can say which program's spelling this
      // was, and is never used to decide identity — the link itself is.
      else next[name] = { ...(next[name] || {}), key };
      return next;
    });
  }, []);

  async function save() {
    // ⛔ THE BUTTON IS ALWAYS LIVE (owner-directed 2026-09-02: *"the save button
    // should always be there"*). A greyed-out Save cannot say why it is greyed
    // out, so a person pressing it learns nothing; this answers instead, and
    // sends nothing when there is nothing to send.
    if (busy) return;
    if (!data) { setNote('The links have not finished loading yet.'); return; }
    if (!dirty) { setNote('Nothing has changed since this was last saved, so there is nothing to send.'); return; }
    setBusy(true); setErr(null); setSaved(null); setNote(null);
    try {
      const out = await ltApi.combinedSaveInvestorLinks(links);
      setData((d) => ({ ...(d || {}), links: out.links || {} }));
      setDraft(normaliseLinks(out.links));
      setSaved(`Saved. ${out.saved} spelling${out.saved === 1 ? '' : 's'} linked.`);
      if (onChanged) onChanged();
    } catch (e) {
      // A refusal NAMES each row, so the person fixes the one that is wrong
      // rather than being told the form is bad. Nothing was stored.
      const problems = e && e.body && Array.isArray(e.body.problems) ? e.body.problems : null;
      setErr(problems
        ? `Not saved — nothing was stored. ${problems.map((p) => p.message || p.problem).join(' · ')}`
        : (e && e.message) || 'The links could not be saved.');
    } finally { setBusy(false); }
  }

  async function suggestFor(name) {
    setTypedSuggestions(null);
    const n = String(name || '').trim();
    if (!n) return;
    try {
      const r = await ltApi.combinedLinkSuggest(n);
      setTypedSuggestions(r.suggestions || []);
    } catch { setTypedSuggestions([]); }
  }

  const rows = (board && board.rows) || [];
  const unlinked = (board && board.unlinked) || [];
  const linkedNames = Object.keys(links);

  return (
    <>
      <div style={{ ...card, borderColor: `${GOLD}55` }}>
        <div style={eyebrow}>Linking investors across the two programs</div>
        <div style={{ ...sub, marginBottom: 0, color: SLATE, lineHeight: 1.7 }}>
          The two programs spell the same investor differently. Where the spelling is a little
          different, you tell the system once that the two are the same investor — and from then on
          it treats them as one, so you can choose which program to take that investor’s pricing
          from.
          <br />
          <strong style={{ color: INK }}>Nothing is linked automatically.</strong> Suggestions below
          are proposals only; a link is recorded when you pick one and press Save.
          {data && data.problem && (
            <>
              <br />
              <span style={{ color: CAUTION }}>
                The stored links could not be read cleanly, so none are in force right now. Saving
                from this screen replaces them.
              </span>
            </>
          )}
        </div>
      </div>

      {err && <div style={{ ...card, borderColor: `${DANGER}55`, color: DANGER, fontSize: 13 }}>{err}</div>}
      {saved && <div style={{ ...card, borderColor: `${GOLD}55`, color: GOLD_TEXT, fontSize: 13 }}>{saved}</div>}
      {note && <div style={{ ...card, borderColor: `${CAUTION}55`, color: CAUTION, fontSize: 13 }}>{note}</div>}

      {/* SIDE BY SIDE — only from a real priced board, because these are the names
          the two programs actually returned. */}
      <div style={card}>
        <div style={eyebrow}>Side by side</div>
        {boardIsRemembered && rows.length > 0 && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            From the last board you priced in this window. Price again to refresh it.
          </div>
        )}
        {!board && (
          <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.7 }}>
            Price a scenario on the Combined Pricing Engine and the two programs’ own names for each
            investor appear here, side by side, with a one-click link for any that did not match.
            This screen never prices anything by itself.
          </div>
        )}
        {board && rows.length === 0 && (
          <div style={{ fontSize: 13, color: MUTED }}>The last board had no investor either program could name.</div>
        )}
        {board && rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
              <thead>
                <tr style={{ background: WASH }}>
                  {['Investor', 'Lender Price calls it', 'LoanNEX calls it', ''].map((h) => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 11, color: MUTED, fontWeight: 700, padding: '8px 10px', borderBottom: `1px solid ${LINE}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ padding: '10px', borderBottom: `1px solid ${LINE}`, verticalAlign: 'top' }}>
                      <div style={{ fontSize: 13, color: INK, fontWeight: 700 }}>{r.investor}</div>
                      {r.needsConfirming && (
                        <div style={{ marginTop: 4 }}><span style={pill('#F6EEDC', CAUTION)}>please confirm</span></div>
                      )}
                    </td>
                    <td style={{ padding: '10px', borderBottom: `1px solid ${LINE}`, verticalAlign: 'top' }}>
                      <NameCell entries={r.names.lenderprice} />
                    </td>
                    <td style={{ padding: '10px', borderBottom: `1px solid ${LINE}`, verticalAlign: 'top' }}>
                      <NameCell entries={r.names.loannex} />
                    </td>
                    <td style={{ padding: '10px', borderBottom: `1px solid ${LINE}`, verticalAlign: 'top' }}>
                      {/* The owner's own question, answered per row: is this a real
                          choice of program, or is only one of them quoting it? */}
                      {r.inBoth
                        ? <span style={pill('#EAF1F1', '#25666B')}>both — you can choose</span>
                        : <span style={{ fontSize: 12, color: MUTED }}>one program only</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* NOT RECOGNISED — the rows that are the whole point: today they are dropped
          off the board entirely, and this is where a person fixes that. */}
      {board && unlinked.length > 0 && (
        <div style={{ ...card, borderColor: `${CAUTION}55` }}>
          <div style={eyebrow}>Not recognised on the last board ({unlinked.length})</div>
          <div style={{ ...sub, color: SLATE }}>
            These spellings were quoted and could not be matched to an investor, so they were kept
            off the board rather than shown under a name that might be wrong. Say which investor
            each one is — or, if it is an investor we have never priced before, add it.
            {boardIsRemembered && ' These are from the last board you priced in this window.'}
          </div>
          {unlinked.map((u) => (
            <div key={`${u.source}|${u.name}`} style={{ padding: '10px 0', borderTop: `1px solid ${LINE}` }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 240px' }}>
                  <div style={{ fontSize: 13, color: INK, fontWeight: 700 }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: MUTED }}>
                    from {u.source === 'loannex' ? 'LoanNEX' : 'Lender Price'}
                  </div>
                </div>
                <div style={{ flex: '1 1 320px' }}>
                  <label style={label} htmlFor={`ul-${u.source}-${u.name}`}>This investor is</label>
                  <Picker
                    id={`ul-${u.source}-${u.name}`}
                    name={u.name}
                    value={(links[u.name] || {}).key}
                    investors={investors}
                    onPick={setLink}
                  />
                </div>
              </div>
              {u.suggestions && u.suggestions.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: MUTED }}>Might be:</span>
                  {u.suggestions.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setLink(u.name, s.key)}
                      title={s.why}
                      style={{
                        border: `1px solid ${LINE}`, background: '#fff', color: INK, borderRadius: 999,
                        padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}
                    >{s.label}</button>
                  ))}
                </div>
              )}
              {/* THE WAY OUT WHEN IT IS NOBODY ON THE LIST. The vendor's own
                  spelling is carried straight into the form as the first
                  spelling, so the name that was quoted is the name that is
                  recorded — retyping it is how a second, slightly different
                  spelling gets created. */}
              <div style={{ marginTop: 8 }}>
                {onAddInvestor
                  ? (
                    <button type="button" style={ghostBtn} onClick={() => onAddInvestor({ label: u.name, alias: u.name, source: u.source })}>
                      Add this as a new investor
                    </button>
                  )
                  : (
                    <span style={{ fontSize: 11, color: MUTED }}>
                      If this is an investor we have never priced before, add it on the settings screen.
                    </span>
                  )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* THE RECORDED LINKS — what is in force right now, and the only place one
          can be taken away. */}
      <div style={card}>
        <div style={eyebrow}>Links you have recorded ({linkedNames.length})</div>
        {linkedNames.length === 0 && (
          <div style={{ fontSize: 13, color: MUTED }}>None yet. Every investor is being matched by its recorded spellings alone.</div>
        )}
        {linkedNames.sort().map((name) => (
          <div key={name} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', padding: '10px 0', borderTop: `1px solid ${LINE}` }}>
            <div style={{ flex: '1 1 240px' }}>
              <div style={{ fontSize: 13, color: INK, fontWeight: 700 }}>{name}</div>
              {links[name].linkedAt && (
                <div style={{ fontSize: 11, color: MUTED }}>linked {String(links[name].linkedAt).slice(0, 10)}</div>
              )}
            </div>
            <div style={{ flex: '1 1 320px' }}>
              <label style={label} htmlFor={`lk-${name}`}>is the same investor as</label>
              <Picker
                id={`lk-${name}`}
                name={name}
                value={links[name].key}
                investors={investors}
                onPick={setLink}
              />
            </div>
            <button
              type="button"
              onClick={() => setLink(name, '')}
              style={{ ...ghostBtn, color: DANGER }}
            >Remove</button>
          </div>
        ))}
      </div>

      {/* BY HAND — so a link can be recorded without waiting for that investor to
          turn up on a board. */}
      <div style={card}>
        <div style={eyebrow}>Link a spelling by hand</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 280px' }}>
            <label style={label} htmlFor="lk-typed">The spelling as the program writes it</label>
            <input
              id="lk-typed"
              style={input}
              value={typed}
              placeholder="The investor’s name exactly as the program spells it"
              onChange={(e) => { setTyped(e.target.value); setTypedSuggestions(null); }}
              onBlur={(e) => suggestFor(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => suggestFor(typed)}
            disabled={!typed.trim()}
            style={{ border: `1px solid ${LINE}`, background: '#fff', color: INK, borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 700, cursor: typed.trim() ? 'pointer' : 'not-allowed' }}
          >What might this be?</button>
        </div>
        {typedSuggestions && typedSuggestions.length === 0 && (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
            Nothing resembles that name closely enough to propose. Pick the investor yourself below.
          </div>
        )}
        {typedSuggestions && typedSuggestions.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: MUTED }}>Might be:</span>
            {typedSuggestions.map((s) => (
              <button
                key={s.key}
                type="button"
                title={s.why}
                onClick={() => { setLink(typed.trim(), s.key); setTyped(''); setTypedSuggestions(null); }}
                style={{ border: `1px solid ${LINE}`, background: '#fff', color: INK, borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >{s.label}</button>
            ))}
          </div>
        )}
        {typed.trim() && (
          <div style={{ marginTop: 12, maxWidth: 360 }}>
            <label style={label} htmlFor="lk-typed-pick">…or say which investor it is</label>
            <Picker
              id="lk-typed-pick"
              name={typed.trim()}
              value={(links[typed.trim()] || {}).key}
              investors={investors}
              onPick={(nm, k) => { if (k) { setLink(nm, k); setTyped(''); setTypedSuggestions(null); } }}
            />
            {onAddInvestor && (
              <div style={{ marginTop: 8 }}>
                <button type="button" style={ghostBtn} onClick={() => onAddInvestor({ label: typed.trim(), alias: typed.trim() })}>
                  Add this as a new investor
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '4px 0 24px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={save}
          aria-disabled={busy ? 'true' : 'false'}
          style={{
            border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700,
            background: dirty && !busy ? GOLD : '#D8D2C4', color: dirty && !busy ? '#fff' : INK,
            cursor: busy ? 'progress' : 'pointer',
          }}
        >{busy ? 'Saving…' : 'Save the links'}</button>
        <span style={{ fontSize: 12, color: dirty ? CAUTION : MUTED }}>
          {dirty ? 'Not saved yet.' : 'Nothing has changed since this was last saved.'}
        </span>
      </div>
    </>
  );
}
