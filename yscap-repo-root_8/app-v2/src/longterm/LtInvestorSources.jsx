import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ltApi } from './api.js';
import LtInvestorLinks from './LtInvestorLinks.jsx';
import LtSourceMisses from './LtSourceMisses.jsx';
import { keyFromLabel, parseAliases } from './customInvestors.js';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, CAUTION, DANGER, card, eyebrow, sub, input, label, LINE, WASH } from './ppeStyles.js';
import { sourceLabel } from './sourceLabel.js';

/**
 * THE SIDE-BY-SIDE INVESTOR LIST — the ONE new section in the General Pricing Engine's settings.
 *
 * ── THE OWNER'S ASK, IN WRITING (2026-09-03) ───────────────────────────────
 * *"I want the side-by-side list… in the settings of the regular pricing engine… three options
 * should be like a nice modern design: price it from Lender Price, price it from LoanNEX, or turn
 * off this investor."* And, on the rest of the row: *"which investor is linked to which, the white
 * labelled name, which systems that investor is available on… and a manual margin holdback on top
 * of whatever the system returns."* And, answering directly what happens when an investor exists on
 * only one system: *"the other option is locked out, but the investor can always be turned off."*
 * And: *"If you see a new investor populating in any of the systems, just add that to the list."*
 *
 * ── WHAT THIS SECTION IS NOT ───────────────────────────────────────────────
 * ⛔ IT IS NOT ON THE PRICING PAGE. *"Don't add any new sections"* there, and *"basically don't
 * touch anything from the general pricing engine."* The board, the brackets and the search screen
 * are untouched; this is a settings screen and nothing else.
 *
 * ⛔ AND IT ADDS NO RULE OF ITS OWN. Every decision it draws — what the row would answer with no
 * setting, which button is locked out, whether a name may be shown to a client — is resolved on the
 * SERVER and carried on the row. A browser working any of that out again would be a second copy of
 * a rule the board prices on, and the copy that drifts is the one somebody reads.
 *
 * ⛔ SUPER ADMIN ONLY, AND SILENT FOR EVERYBODY ELSE. The door answers 404 to anyone else, so this
 * renders NOTHING rather than an error — an ordinary admin's settings screen is exactly what it was.
 */

/** The three choices, in the owner's own order. `off` is never locked out. */
const CHOICES = [
  { id: 'lenderprice', short: 'Lender Price', help: 'Price this investor from Lender Price.' },
  { id: 'loannex', short: sourceLabel('loannex'), help: 'Price this investor from LoanNEX.' },
  { id: 'off', short: 'Off', help: 'Do not show this investor at all.' },
];

/** What a row is currently set to, as ONE of the three — the shape the buttons speak. */
function choiceOf(row, edit) {
  const e = edit || {};
  if (e.choice) return e.choice;
  if (row.enabled === false) return 'off';
  // `both` is the combined engine's comparison mode and is not offered here: the general
  // engine ROUTES, it does not compare (see `pricing/general-board.js`). A row already
  // stored as `both` reads as the sheet it would take first, and pressing any button
  // stores a real one-sheet answer.
  return row.source === 'loannex' ? 'loannex' : 'lenderprice';
}

/**
 * "THIS SHEET HAS NEVER CARRIED THIS INVESTOR" — written once.
 *
 * It is the SAME fact stated in two places: the Available-on cell reports it, and
 * the greyed-out source button is greyed out BECAUSE of it. Two copies is how
 * the two ends up describing one register differently.
 */
const NEVER_CARRIED = 'has never carried this investor';

/** What one system's register says, in words a person can act on. */
function availabilityNote(a) {
  if (!a) return null;
  if (a.state === 'seen') return 'has answered for this investor';
  if (a.state === 'never') return NEVER_CARRIED;
  return 'not searched yet';
}

const dot = (color) => ({
  display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: color, marginRight: 6,
});

function AvailabilityCell({ availability }) {
  const a = availability || {};
  const one = (id, name) => {
    const st = (a[id] && a[id].state) || 'unknown';
    const colour = st === 'seen' ? '#2F7F86' : (st === 'never' ? '#B0B6BB' : GOLD);
    return (
      <div key={id} style={{ fontSize: 12, color: st === 'seen' ? SLATE : MUTED, whiteSpace: 'nowrap' }}>
        <span style={dot(colour)} />{name} — {availabilityNote(a[id])}
      </div>
    );
  };
  return <div style={{ display: 'grid', gap: 3 }}>{one('lenderprice', sourceLabel('lenderprice'))}{one('loannex', sourceLabel('loannex'))}</div>;
}

/**
 * THE THREE BUTTONS. A locked one is a real `disabled` button carrying the REASON — a control that
 * looks pressable and does nothing is worse than one that says why it cannot be.
 */
/**
 * WHY A SOURCE BUTTON CANNOT BE PRESSED — ONE definition, read by the hover
 * tooltip AND by the words a phone gets instead of one.
 */
const lockReason = (short) => `${short} ${NEVER_CARRIED}, so there is nothing to price from there.`;

function SourceChoice({ value, lockedOut, onPick }) {
  const locked = new Set(lockedOut || []);
  return (
    <div role="group" aria-label="Where this investor is priced from" className="lt-inv-sources" style={{
      display: 'inline-flex', border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: '#fff',
    }}>
      {CHOICES.map((c, i) => {
        const on = value === c.id;
        // ⛔ `off` IS NEVER LOCKED — the owner's rule, verbatim: an investor can always be turned off.
        const isLocked = c.id !== 'off' && locked.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            disabled={isLocked}
            aria-pressed={on}
            title={isLocked ? lockReason(c.short) : c.help}
            onClick={() => !isLocked && onPick(c.id)}
            style={{
              appearance: 'none', border: 0, cursor: isLocked ? 'not-allowed' : 'pointer',
              borderLeft: i ? `1px solid ${LINE}` : 0,
              padding: '8px 12px', fontSize: 13, fontWeight: on ? 700 : 550,
              minHeight: 40, whiteSpace: 'nowrap',
              background: on ? (c.id === 'off' ? '#F1EFEA' : GOLD) : (isLocked ? '#FAFAF8' : '#fff'),
              color: on ? (c.id === 'off' ? INK : '#fff') : (isLocked ? '#A6ADB2' : SLATE),
            }}
          >{c.short}</button>
        );
      })}
    </div>
  );
}

export default function LtInvestorSources() {
  const [data, setData] = useState(null);
  const [gone, setGone] = useState(false); // the door answered 404 — not our screen to draw
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState({});
  const [q, setQ] = useState('');
  const [onlyOn, setOnlyOn] = useState(true);

  const [hb, setHb] = useState(null);
  const [hbDraft, setHbDraft] = useState('');
  const [hbBusy, setHbBusy] = useState(false);
  const [hbMsg, setHbMsg] = useState(null);
  const [hbErr, setHbErr] = useState(null);

  const [ci, setCi] = useState(null);
  const [ciForm, setCiForm] = useState({ label: '', whiteLabel: '', aliases: '' });
  const [ciBusy, setCiBusy] = useState(false);
  const [ciMsg, setCiMsg] = useState(null);
  const [ciErr, setCiErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.sourceInvestors()
      .then((r) => { setData(r); setEdits({}); })
      .catch((e) => {
        // 404 is the gate, not a fault: this section simply is not for this person.
        if (e && (e.status === 404 || (e.data && e.data.error === 'not_found'))) { setGone(true); return; }
        setErr((e && e.message) || 'The investor list could not be read.');
      });
  }, []);
  useEffect(load, [load]);

  const loadHb = useCallback(() => {
    ltApi.sourceMarginHoldback()
      .then((r) => { setHb(r); setHbDraft(r.points == null ? '' : String(r.points)); })
      .catch(() => { /* the gate above already decided whether this section renders */ });
  }, []);
  useEffect(loadHb, [loadHb]);

  const loadCi = useCallback(() => {
    ltApi.sourceCustomInvestors().then(setCi).catch(() => { /* same */ });
  }, []);
  useEffect(loadCi, [loadCi]);

  const rows = useMemo(() => (data && data.investors) || [], [data]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows;
    if (onlyOn) {
      // The default view is what the board is actually pricing plus anything somebody
      // has deliberately touched — forty-odd rows of "off, nobody has ever set this"
      // is a wall, and the owner asked for the five investors to be readable at a glance.
      list = list.filter((r) => choiceOf(r, edits[r.key]) !== 'off' || edits[r.key] || r.sourceOrigin === 'setting' || r.enabledOrigin === 'setting');
    }
    if (!needle) return list;
    return list.filter((r) => `${r.label} ${r.whiteLabel || ''} ${r.key}`.toLowerCase().includes(needle));
  }, [rows, q, onlyOn, edits]);

  const edit = (key, patch) => {
    setSaved(null);
    setEdits((s) => ({ ...s, [key]: { ...(s[key] || {}), ...patch } }));
  };
  const dirty = Object.keys(edits).length > 0;

  /**
   * THE ROW AS THE SERVER STORES IT. The WHOLE map is sent on every save (the door's own rule), so
   * a row that already carries a setting must re-state it or the save would drop it.
   *
   * ⛔ AND A ROW NOBODY HAS TOUCHED SENDS NOTHING — that is what leaves it answering to the
   * standing instruction rather than pinning today's pre-fill onto it for ever.
   */
  const patchOf = (r) => {
    const e = edits[r.key];
    const touched = !!e;
    const pinned = r.sourceOrigin === 'setting' || r.enabledOrigin === 'setting'
      || r.whiteLabelOrigin === 'setting' || r.holdbackOrigin === 'setting';
    if (!touched && !pinned) return null;
    const choice = choiceOf(r, e);
    const out = {
      source: choice === 'off' ? (r.source === 'loannex' ? 'loannex' : 'lenderprice') : choice,
      enabled: choice !== 'off',
    };
    const wl = e && e.whiteLabel !== undefined ? e.whiteLabel : r.whiteLabel;
    if (wl != null && String(wl).trim() !== '') out.whiteLabel = String(wl).trim();
    const hbv = e && e.holdback !== undefined ? e.holdback : r.holdback;
    if (hbv !== undefined && hbv !== null && String(hbv) !== '') {
      const n = Number(hbv);
      if (Number.isFinite(n)) out.holdback = n;
    }
    return out;
  };

  async function save() {
    if (busy || !data) return;
    if (!dirty) { setSaved('Nothing has changed since this was last saved.'); return; }
    setBusy(true); setErr(null); setSaved(null);
    try {
      const map = {};
      for (const r of rows) {
        const p = patchOf(r);
        if (p) map[r.key] = p;
      }
      const out = await ltApi.sourceSaveInvestors(map);
      setData(out); setEdits({});
      setSaved(`Saved. ${out.saved} investor${out.saved === 1 ? '' : 's'} now carry a setting of their own; the rest use the pre-fill.`);
    } catch (e) {
      const problems = e && e.data && Array.isArray(e.data.problems) ? e.data.problems : null;
      setErr(problems
        ? `Not saved — nothing was stored. ${problems.map((p) => `${p.investor || 'a row'}: ${p.message || p.error}`).join(' · ')}`
        : (e && e.message) || 'The settings could not be saved.');
    } finally { setBusy(false); }
  }

  async function saveHb(points) {
    setHbBusy(true); setHbErr(null); setHbMsg(null);
    try {
      const r = await ltApi.sourceSaveMarginHoldback(points);
      setHb(r);
      setHbDraft(r.points == null ? '' : String(r.points));
      setHbMsg(r.origin === 'default'
        ? `Back to the standing ${r.points} — nothing of our own is saved for it any more.`
        : (r.points === 0
          ? 'Saved. No margin holdback is being taken on LoanNEX quotes.'
          : `Saved. ${r.points} in points is held back on every LoanNEX quote.`));
    } catch (e) {
      setHbErr((e && e.message) || 'The margin holdback could not be saved.');
    } finally { setHbBusy(false); }
  }

  /** Add an investor nobody has linked yet — the owner's *"add an unlinked one"*. */
  async function addInvestor() {
    if (ciBusy) return;
    const lbl = String(ciForm.label || '').trim();
    if (!lbl) { setCiErr('Type the investor’s real name first — the key and the list are built from it.'); return; }
    const key = keyFromLabel(lbl);
    if (!key) { setCiErr('That name has no letters or digits in it, so there is no key to give it.'); return; }
    setCiBusy(true); setCiErr(null); setCiMsg(null);
    try {
      const map = {};
      for (const e of (ci && ci.list) || []) {
        map[e.key] = { label: e.label, whiteLabel: e.whiteLabel || '', aliases: e.aliases || [] };
      }
      map[key] = { label: lbl, whiteLabel: String(ciForm.whiteLabel || '').trim(), aliases: parseAliases(ciForm.aliases) };
      const out = await ltApi.sourceSaveCustomInvestors(map);
      setCi(out);
      setCiForm({ label: '', whiteLabel: '', aliases: '' });
      setCiMsg(`Saved. “${lbl}” is on the list and can be named, linked and switched on.`);
      load(); // it has to reach the rows above without a reload
    } catch (e) {
      const problems = e && e.data && Array.isArray(e.data.problems) ? e.data.problems : null;
      setCiErr(problems
        ? `Not saved — nothing was stored. ${problems.map((x) => x.message || x.problem).join(' · ')}`
        : (e && e.message) || 'That could not be saved.');
    } finally { setCiBusy(false); }
  }

  if (gone) return null;

  const sight = (data && data.sightings) || null;
  const coldRegister = sight && !sight.boards.lenderprice && !sight.boards.loannex;

  /**
   * A RATE SHEET NOBODY CAN SIGN IN TO — the reason an investor set to it never
   * reaches the board (owner-reported 2026-09-03: *"It still does not come up in
   * any of the new five. It's not pulling on the ink from loannex yet."*).
   *
   * ⛔ THE SERVER DECIDES WHETHER TO SPEAK, NOT THIS SCREEN. `speak` already
   * accounts for whether anybody is actually routed there, and the wording is
   * the server's one definition — re-deriving either here would be a second copy
   * of the rule, free to disagree with the board about the same fact.
   */
  const sheetTrouble = useMemo(() => {
    const c = (data && data.connections) || null;
    if (!c) return [];
    return ['loannex', 'lenderprice']
      .map((k) => c[k])
      .filter((x) => x && x.speak && x.message);
  }, [data]);

  return (
    <div style={{ ...card, borderColor: `${GOLD}55` }}>
      <div style={eyebrow}>Investors — where each one is priced from</div>
      <h2 style={{ margin: '4px 0 4px', fontSize: 16, color: INK }}>The side-by-side list</h2>
      <p style={{ ...sub, marginBottom: 12, lineHeight: 1.7 }}>
        Every investor the system knows about, side by side. For each one: the name a client may see,
        which pricing systems have actually produced them, and whether the board takes their products
        from <strong style={{ color: INK }}>Lender Price</strong>, from{' '}
        <strong style={{ color: INK }}>LoanNEX</strong>, or not at all.
        <br />
        A system that has never carried an investor is greyed out for that row —{' '}
        <strong style={{ color: INK }}>Off is always available</strong>.
      </p>

      {err && <div style={{ fontSize: 13, color: DANGER, marginBottom: 10 }}>{err}</div>}
      {saved && <div style={{ fontSize: 13, color: GOLD_TEXT, marginBottom: 10 }}>{saved}</div>}
      {coldRegister && (
        <div style={{ fontSize: 12, color: CAUTION, marginBottom: 10 }}>
          Nothing has been priced yet, so no system has reported which investors it carries. Every
          button stays available until a search tells us otherwise.
        </div>
      )}

      {/* Above the list and above the search box on purpose: this is the answer to
          "I set five investors to LoanNEX and nothing came up", and it is worth
          nothing if somebody has to scroll to it. */}
      {sheetTrouble.map((c) => (
        <div
          key={c.source}
          style={{
            border: `1px solid ${DANGER}55`, background: '#FDF4F3', borderRadius: 10,
            padding: '10px 12px', marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, color: DANGER, letterSpacing: '.04em', textTransform: 'uppercase' }}>
            {c.label} is not connected
          </div>
          <div style={{ fontSize: 13, color: INK, marginTop: 4, lineHeight: 1.6 }}>{c.message}</div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          style={{ ...input, maxWidth: 280 }}
          placeholder="Find an investor"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label style={{ fontSize: 13, color: SLATE, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyOn} onChange={(e) => setOnlyOn(e.target.checked)} />
          Only the ones that are on
        </label>
        <span style={{ fontSize: 12, color: MUTED }}>
          {shown.length} of {rows.length} shown
        </span>
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          style={{
            marginLeft: 'auto', appearance: 'none', border: 0, borderRadius: 9,
            padding: '9px 16px', fontSize: 13, fontWeight: 700, minHeight: 40,
            cursor: busy || !dirty ? 'not-allowed' : 'pointer',
            background: dirty ? GOLD : '#EDEAE3', color: dirty ? '#fff' : '#9AA1A6',
          }}
        >{busy ? 'Saving…' : 'Save the list'}</button>
      </div>

      <div className="lt-inv" style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
        <div className="lt-inv-head" style={{
          padding: '9px 12px', background: WASH, borderBottom: `1px solid ${LINE}`,
          fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: MUTED, fontWeight: 700,
        }}>
          <div>Investor</div>
          <div>Name a client may see</div>
          <div>Available on</div>
          <div>Priced from</div>
          <div>Holdback</div>
        </div>
        {shown.length === 0 && (
          <div style={{ padding: 14, fontSize: 13, color: MUTED }}>
            Nothing matches. {onlyOn ? 'Un-tick “Only the ones that are on” to see every investor.' : ''}
          </div>
        )}
        {shown.map((r) => {
          const e = edits[r.key] || {};
          const choice = choiceOf(r, e);
          const wl = e.whiteLabel !== undefined ? e.whiteLabel : (r.whiteLabel || '');
          const hbv = e.holdback !== undefined ? e.holdback : (r.holdback == null ? '' : r.holdback);
          return (
            <div
              key={r.key}
              className="lt-inv-row"
              style={{
                padding: '10px 12px',
                borderBottom: `1px solid ${LINE}`,
                background: choice === 'off' ? '#FBFAF8' : '#fff',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 650, color: INK, overflowWrap: 'anywhere' }}>{r.label}</div>
                <div style={{ fontSize: 11, color: MUTED }}>
                  {r.key}{r.custom ? ' · added by hand' : ''}
                </div>
              </div>
              <div>
                <div className="lt-inv-cell-label">Name a client may see</div>
                <input
                  style={{ ...input, fontSize: 14, padding: '7px 9px' }}
                  placeholder={r.prefill && r.prefill.whiteLabel ? r.prefill.whiteLabel : 'not named yet'}
                  value={wl}
                  onChange={(ev) => edit(r.key, { whiteLabel: ev.target.value })}
                />
                {r.whiteLabelMissing && !String(wl).trim() && (
                  <div style={{ fontSize: 11, color: CAUTION, marginTop: 3 }}>
                    No client-safe name yet — this investor may not be shown to a borrower or a broker.
                  </div>
                )}
              </div>
              <div>
                <div className="lt-inv-cell-label">Available on</div>
                <AvailabilityCell availability={r.availability} />
              </div>
              <div>
                <div className="lt-inv-cell-label">Priced from</div>
                <SourceChoice
                  value={choice}
                  lockedOut={r.lockedOut}
                  onPick={(id) => edit(r.key, { choice: id })}
                />
                {/* ⛔ A TOOLTIP DOES NOT EXIST ON A PHONE. The greyed-out button explains
                    itself on hover, and a touch screen has no hover — so on the stacked
                    form the owner met a button they could not press with no reason given
                    anywhere, which is the "you can't really change from LenderPric, the
                    loannex, maybe only not on mobile" half of the report. The CSS shows
                    this only in the stacked form, so the desktop table gains no wall of
                    repeated lines while the phone stops being a dead end. */}
                {(r.lockedOut || []).filter((id) => id !== 'off').map((id) => (
                  <div key={id} className="lt-inv-lock">{lockReason(sourceLabel(id))}</div>
                ))}
              </div>
              <div>
                <div className="lt-inv-cell-label">Holdback (extra points)</div>
                <input
                  style={{ ...input, fontSize: 14, padding: '7px 9px', textAlign: 'right' }}
                  placeholder="0"
                  inputMode="decimal"
                  value={hbv}
                  onChange={(ev) => edit(r.key, { holdback: ev.target.value })}
                  title="Extra points held back on this investor, on top of the standing holdback."
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* THE STANDING HOLDBACK, under the list it applies to — the owner's *"a manual margin
          holdback on top of whatever the system returns"*, with the per-investor extra in the
          column above it. */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
        <div style={eyebrow}>The standing margin holdback</div>
        <p style={{ ...sub, marginBottom: 8 }}>
          {hb ? hb.note : 'Held back on every LoanNEX quote before anything compares the two systems.'}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ ...label, marginBottom: 0 }} htmlFor="src-hb">Points</label>
          <input
            id="src-hb"
            style={{ ...input, maxWidth: 110, textAlign: 'right' }}
            inputMode="decimal"
            value={hbDraft}
            onChange={(ev) => setHbDraft(ev.target.value)}
            placeholder={hb && hb.prefill != null ? String(hb.prefill) : '0.25'}
          />
          <button type="button" disabled={hbBusy} onClick={() => saveHb(hbDraft === '' ? null : Number(hbDraft))} style={{
            appearance: 'none', border: `1px solid ${LINE}`, background: '#fff', color: INK,
            borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 600, minHeight: 40, cursor: 'pointer',
          }}>{hbBusy ? 'Saving…' : 'Save'}</button>
          <button type="button" disabled={hbBusy} onClick={() => saveHb(null)} style={{
            appearance: 'none', border: 0, background: 'transparent', color: GOLD_TEXT,
            fontSize: 13, fontWeight: 600, minHeight: 40, cursor: 'pointer', textDecoration: 'underline',
          }}>Put back to ours</button>
          {hb && hb.origin && (
            <span style={{ fontSize: 12, color: MUTED }}>
              {hb.origin === 'setting' ? 'you set this' : 'pre-filled'}
            </span>
          )}
        </div>
        {hbMsg && <div style={{ fontSize: 13, color: GOLD_TEXT, marginTop: 6 }}>{hbMsg}</div>}
        {hbErr && <div style={{ fontSize: 13, color: DANGER, marginTop: 6 }}>{hbErr}</div>}
      </div>

      {/* ADD AN INVESTOR NOBODY HAS LINKED YET — the owner's *"add an investor that is not linked
          yet with its white label and holdback"*. It joins the list above the moment it is saved,
          switched off, so nothing starts pricing because a name was typed. */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
        <div style={eyebrow}>Add an investor</div>
        <p style={{ ...sub, marginBottom: 8 }}>
          For an investor neither system has produced yet. It joins the list switched off; name it,
          link its spellings below, and switch it on when you are ready.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(16rem,100%),1fr))', gap: 10 }}>
          <div>
            <label style={label} htmlFor="src-ci-label">Their real name</label>
            <input id="src-ci-label" style={input} value={ciForm.label}
              onChange={(ev) => setCiForm((s) => ({ ...s, label: ev.target.value }))} />
          </div>
          <div>
            <label style={label} htmlFor="src-ci-wl">The name a client may see</label>
            <input id="src-ci-wl" style={input} value={ciForm.whiteLabel}
              onChange={(ev) => setCiForm((s) => ({ ...s, whiteLabel: ev.target.value }))} />
          </div>
          <div>
            <label style={label} htmlFor="src-ci-al">Other spellings (one per line)</label>
            <input id="src-ci-al" style={input} value={ciForm.aliases}
              onChange={(ev) => setCiForm((s) => ({ ...s, aliases: ev.target.value }))} />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="button" disabled={ciBusy} onClick={addInvestor} style={{
            appearance: 'none', border: `1px solid ${LINE}`, background: '#fff', color: INK,
            borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 600, minHeight: 40, cursor: 'pointer',
          }}>{ciBusy ? 'Saving…' : 'Add this investor'}</button>
        </div>
        {ciMsg && <div style={{ fontSize: 13, color: GOLD_TEXT, marginTop: 6 }}>{ciMsg}</div>}
        {ciErr && <div style={{ fontSize: 13, color: DANGER, marginTop: 6 }}>{ciErr}</div>}
      </div>

      {/* THE RECORD BEHIND THE SILENCE — an investor the second system answered about and did not
          carry is left off the board with nothing said, and lands here instead. It sits under the
          list it is about, so the person changing a source and the person digging into a miss are
          looking at the same screen. */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
        <LtSourceMisses />
      </div>

      {/* LINK ANY NAME TO ANY INVESTOR — the owner's *"full linking"*. The whole block is the SAME
          component the combined engine's settings mount, pointed at this engine's own doors, so a
          link recorded on either screen is the one link both boards read. */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
        <LtInvestorLinks
          api={{
            get: ltApi.sourceInvestorLinks,
            save: ltApi.sourceSaveInvestorLinks,
            suggest: ltApi.sourceLinkSuggest,
          }}
          onAddInvestor={(seed) => setCiForm({
            label: String((seed && seed.label) || '').trim(),
            whiteLabel: '',
            aliases: String((seed && seed.alias) || '').trim(),
          })}
        />
      </div>
    </div>
  );
}
