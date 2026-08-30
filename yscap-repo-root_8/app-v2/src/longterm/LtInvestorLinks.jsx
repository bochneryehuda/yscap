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
 * server, which derives them from the one investor registry — a browser copy would be a second
 * roster, and the one that drifted is the one somebody would price a loan on.
 *
 * `pairing` is OPTIONAL and is what the two boards ACTUALLY returned on the last price (the price
 * answer carries it). With it, this draws the real side-by-side. Without it — on the settings
 * screen, where nothing has been priced — it draws the recorded links and the by-hand door, and
 * says plainly that the live comparison appears once a board has been priced. It deliberately does
 * NOT price anything to fill itself in: drawing a settings screen must never cost two vendor calls.
 */

/** How a name was joined, in words rather than a code. */
const MATCH_NOTE = {
  link: 'you linked this',
  exact: 'a recorded spelling',
  normal: 'a recorded spelling',
  prefix: 'a guess — please confirm',
  none: 'not recognised',
};

const pill = (bg, fg) => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11,
  fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap',
});

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

export default function LtInvestorLinks({ pairing = null, onChanged = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(null);
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
      .then((r) => { setData(r); setDraft({ ...(r.links || {}) }); })
      .catch((e) => setErr((e && e.message) || 'The links could not be read.'));
  }, []);
  useEffect(load, [load]);

  const investors = (data && data.investors) || [];
  const stored = (data && data.links) || {};
  const links = draft || {};
  const dirty = useMemo(
    () => JSON.stringify(Object.keys(links).sort().map((k) => [k, links[k].key]))
      !== JSON.stringify(Object.keys(stored).sort().map((k) => [k, stored[k].key])),
    [links, stored],
  );

  const setLink = (name, key) => {
    setSaved(null);
    setDraft((s) => {
      const next = { ...(s || {}) };
      if (!key) delete next[name];
      // `source` is recorded so the screen can say which program's spelling this
      // was, and is never used to decide identity — the link itself is.
      else next[name] = { ...(next[name] || {}), key };
      return next;
    });
  };

  async function save() {
    setBusy(true); setErr(null); setSaved(null);
    try {
      const out = await ltApi.combinedSaveInvestorLinks(links);
      setData((d) => ({ ...(d || {}), links: out.links || {} }));
      setDraft({ ...(out.links || {}) });
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

  const rows = (pairing && pairing.rows) || [];
  const unlinked = (pairing && pairing.unlinked) || [];
  const linkedNames = Object.keys(links);

  const Picker = ({ value, onPick, id }) => (
    <select id={id} style={{ ...input, maxWidth: 320 }} value={value || ''} onChange={(e) => onPick(e.target.value)}>
      <option value="">— not linked —</option>
      {investors.map((i) => (
        <option key={i.key} value={i.key}>{i.label}{i.whiteLabel ? ` (${i.whiteLabel})` : ''}</option>
      ))}
    </select>
  );

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

      {/* SIDE BY SIDE — only from a real priced board, because these are the names
          the two programs actually returned. */}
      <div style={card}>
        <div style={eyebrow}>Side by side</div>
        {!pairing && (
          <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.7 }}>
            Price a scenario on the Combined Pricing Engine and the two programs’ own names for each
            investor appear here, side by side, with a one-click link for any that did not match.
            This screen never prices anything by itself.
          </div>
        )}
        {pairing && rows.length === 0 && (
          <div style={{ fontSize: 13, color: MUTED }}>The last board had no investor either program could name.</div>
        )}
        {pairing && rows.length > 0 && (
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
      {pairing && unlinked.length > 0 && (
        <div style={{ ...card, borderColor: `${CAUTION}55` }}>
          <div style={eyebrow}>Not recognised on the last board ({unlinked.length})</div>
          <div style={{ ...sub, color: SLATE }}>
            These spellings were quoted and could not be matched to an investor, so they were kept
            off the board rather than shown under a name that might be wrong. Say which investor
            each one is.
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
                  <Picker id={`ul-${u.source}-${u.name}`} value={(links[u.name] || {}).key} onPick={(k) => setLink(u.name, k)} />
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
              <Picker id={`lk-${name}`} value={links[name].key} onPick={(k) => setLink(name, k)} />
            </div>
            <button
              type="button"
              onClick={() => setLink(name, '')}
              style={{ border: `1px solid ${LINE}`, background: '#fff', color: DANGER, borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
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
              placeholder="A &amp; D Mortgage - Delegated"
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
              value={(links[typed.trim()] || {}).key}
              onPick={(k) => { if (k) { setLink(typed.trim(), k); setTyped(''); setTypedSuggestions(null); } }}
            />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '4px 0 24px' }}>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          style={{
            border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700,
            background: dirty && !busy ? GOLD : '#D8D2C4', color: dirty && !busy ? '#fff' : MUTED,
            cursor: dirty && !busy ? 'pointer' : 'not-allowed',
          }}
        >{busy ? 'Saving…' : 'Save the links'}</button>
        {dirty && <span style={{ fontSize: 12, color: CAUTION }}>Not saved yet.</span>}
      </div>
    </>
  );
}
