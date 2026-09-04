import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsScreen } from './LtSettings.jsx';
import { COMBINED_ENGINE } from './pricerEngine.js';
import { ltApi } from './api.js';
import LtInvestorLinks from './LtInvestorLinks.jsx';
import { keyFromLabel, parseAliases } from './customInvestors.js';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, CAUTION, DANGER, card, eyebrow, sub, input, label, LINE } from './ppeStyles.js';
import { SOURCE_LABELS } from './sourceLabel.js';

/**
 * COMBINED PRICING ENGINE — SETTINGS. One row per investor.
 *
 * Owner-directed 2026-08-30:
 *
 *   "You should open a settings menu where you have every single investor listed. Pre-fill a white
 *    label name for everybody, and if their products are coming up, pre-fill where it's fetching
 *    their product: if it's coming from Lender Price or from LoanNEX. For Button Finance, just
 *    pre-fill that as off, and whenever we're ready for it, we're gonna turn it on over there…
 *    For every investor, we can always switch it from where we want to take the information."
 *
 * ⛔ THIS SCREEN CONFIGURES THE COMBINED ENGINE AND NOTHING ELSE. The General Pricing Engine has
 * its own settings and is untouched by anything here — the owner is auditing a second engine
 * beside the first, and the first must not move while they do.
 *
 * ⛔ SUPER ADMIN ONLY. The server answers 404 to anybody else, and the nav entry is hidden, so a
 * visible control that always fails never appears in front of the rest of the team.
 *
 * ⛔ THE ROSTER IS DRAWN FROM THE SERVER, and there is no list of investors in this file. The
 * server derives it from the one investor registry, so an investor added there appears here on its
 * own; a browser copy would be a second roster and the one that drifted is the one somebody would
 * price a loan on.
 *
 * ⛔ A WHITE LABEL IS NEVER INVENTED. An investor with none is shown with an EMPTY box and said out
 * loud at the top of the screen, because the white label is the one name a client may see: filling
 * it with a guess — and above all with the investor's real name — is how a real investor name
 * reaches a borrower or a broker, which is a hard rule.
 */

/* ONE definition of what we call a rate sheet (`sourceLabel.js`), plus the one word
   only this screen has: `both` is a SETTING a person picks, never a sheet that answered. */
const SOURCE_LABEL = { ...SOURCE_LABELS, both: 'Both (compare)' };

/** Where an answer came from, in words a person can act on. */
const ORIGIN_NOTE = {
  setting: 'you set this',
  owner_directed: 'pre-filled by instruction',
  default: 'pre-filled',
  sheet: 'from the white-label sheet',
  custom: 'the name you gave it when you added it',
  unset: 'not named yet',
  // THE TWO REASONS A ROW IS OFF THAT NOBODY CHOSE. They are different work —
  // one needs a name, the other needs this switch — so they never share a
  // sentence (owner-directed 2026-09-04: naming an investor must not switch it on).
  unnamed: 'off until you name it',
  awaiting_switch: 'named — switch it on when you are ready',
};

/** Is this row pinned — does it carry a setting of its own rather than the pre-fill? */
function isPinned(row) {
  return row.sourceOrigin === 'setting' || row.enabledOrigin === 'setting'
    || row.whiteLabelOrigin === 'setting' || row.holdbackOrigin === 'setting';
}

/** The row as the server would store it — only what a person has actually CHANGED. */
function patchOf(row, edit) {
  // ⛔ "USE THE PRE-FILL" IS THE WAY BACK, AND WITHOUT IT THERE IS NONE. The whole
  // map is sent on every save, so a row that already HAS a setting must re-send it
  // or the save would drop it — which is what every branch below does. The cost is
  // that once a row is touched it is pinned FOREVER: setting it back to exactly
  // the pre-fill still stores a restatement, `sourceOrigin` stays 'setting', and a
  // later change to the owner's standing instruction silently never reaches it.
  // The server has always supported the way back (leave the key out); this screen
  // could not express it, and the route's own note calls returning a row to its
  // pre-fill "the one thing somebody auditing this will want to do most often".
  //
  // An empty patch IS that expression: the key is left out of the whole map, the
  // stored setting disappears, and the row goes back to answering to the pre-fill.
  if (edit.reset) return {};
  const out = {};
  //
  // CLEARING THE BOX TAKES THIS ROW'S OWN NAME AWAY — it does not blank the
  // investor. The key is left out, so the row goes back to whatever the pre-fill
  // answers: the white-label sheet where there is one, the name given when the
  // investor was added by hand, and genuinely nothing where there is neither.
  // The row SAYS which of those will apply before it is saved (see the note under
  // the box) — the old behaviour did the same thing and said nothing, so a person
  // clearing the box watched the sheet's name come back and could not tell why.
  //
  // ⛔ A DELIBERATE BLANK — "this investor has a sheet name and may still never be
  // shown to a client" — is NOT expressible here, and that is an owner decision
  // rather than an oversight: the way to keep an investor off client surfaces
  // today is to switch it off. Flagged rather than guessed at.
  if (edit.whiteLabel !== undefined && String(edit.whiteLabel).trim() !== String(row.whiteLabel || '')) {
    const wl = String(edit.whiteLabel).trim();
    if (wl) out.whiteLabel = wl;
  } else if (row.whiteLabelOrigin === 'setting') {
    out.whiteLabel = row.whiteLabel;
  }
  /**
   * THIS INVESTOR'S OWN EXTRA MARGIN HOLDBACK.
   *
   * ⛔ A BLANK BOX MEANS "NOTHING OF MY OWN", NOT ZERO, and the two are stored
   * differently on purpose: leaving the key out returns the row to the standing
   * holdback, while a typed 0 is a person saying "hold nothing back on this
   * investor" and is stored as a decision. That is the same distinction the
   * source and the on/off switch already make, and it is what lets the screen
   * show which rows somebody has actually answered.
   */
  const hbTyped = edit.holdback !== undefined ? String(edit.holdback).trim() : null;
  if (hbTyped !== null) {
    if (hbTyped !== '' && Number.isFinite(Number(hbTyped))) out.holdback = Number(hbTyped);
  } else if (row.holdbackOrigin === 'setting') {
    out.holdback = row.holdback;
  }
  const source = edit.source !== undefined ? edit.source : row.source;
  // Store the source only when it DIFFERS from what the pre-fill would answer.
  // Storing a restatement would freeze today's pre-fill onto the row, so a later
  // change to the standing instruction would silently not reach it — the same
  // trap the RTL side hit with company-default markups.
  if (row.sourceOrigin === 'setting' || source !== row.source) out.source = source;
  const enabled = edit.enabled !== undefined ? edit.enabled : row.enabled;
  if (row.enabledOrigin === 'setting' || enabled !== row.enabled) out.enabled = enabled;
  return out;
}

export default function LtCombinedSettings() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  // Only what the person has touched on this visit. Everything else keeps whatever
  // the server already resolved, so opening the screen and pressing Save changes
  // nothing — a settings screen that rewrites the world on a stray click is worse
  // than one nobody opens.
  const [edits, setEdits] = useState({});
  const [q, setQ] = useState('');
  // The margin holdback is ONE number for the whole LoanNEX feed, not a per-row
  // setting, so it has its own small piece of state rather than riding the
  // investor edits map.
  const [hb, setHb] = useState(null);
  const [hbDraft, setHbDraft] = useState('');
  const [hbBusy, setHbBusy] = useState(false);
  const [hbMsg, setHbMsg] = useState(null);
  const [hbErr, setHbErr] = useState(null);
  // THE INVESTORS SOMEBODY ADDED BY HAND. Their own read and their own save —
  // they are a different setting from the per-investor rows above (which decide
  // what to do with an investor that already exists) and mixing the two saves
  // would mean one form's refusal could hold up the other's work.
  const [ci, setCi] = useState(null);
  const [ciForm, setCiForm] = useState({ label: '', whiteLabel: '', aliases: '', key: '' });
  const [ciEditKey, setCiEditKey] = useState(null);
  const [ciBusy, setCiBusy] = useState(false);
  const [ciMsg, setCiMsg] = useState(null);
  const [ciErr, setCiErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.combinedInvestors()
      .then((r) => { setData(r); setEdits({}); })
      .catch((e) => setErr((e && e.message) || 'The settings could not be read.'));
  }, []);
  useEffect(load, [load]);

  const loadCi = useCallback(() => {
    ltApi.combinedCustomInvestors()
      .then((r) => setCi(r))
      .catch((e) => setCiErr((e && e.message) || 'The investors you added could not be read.'));
  }, []);
  useEffect(loadCi, [loadCi]);

  const loadHb = useCallback(() => {
    ltApi.combinedMarginHoldback()
      .then((r) => { setHb(r); setHbDraft(r.points == null ? '' : String(r.points)); })
      .catch((e) => setHbErr((e && e.message) || 'The margin holdback could not be read.'));
  }, []);
  useEffect(loadHb, [loadHb]);

  async function saveHb(points) {
    setHbBusy(true); setHbErr(null); setHbMsg(null);
    try {
      const r = await ltApi.combinedSaveMarginHoldback(points);
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

  /** The stored map as the form is about to send it — the WHOLE map, always. */
  const ciMap = useCallback((mutate) => {
    const map = {};
    for (const e of (ci && ci.list) || []) {
      map[e.key] = {
        label: e.label,
        whiteLabel: e.whiteLabel || '',
        aliases: e.aliases || [],
        addedBy: e.addedBy || null,
        addedAt: e.addedAt || null,
      };
    }
    return mutate ? mutate(map) : map;
  }, [ci]);

  const putCustom = useCallback(async (map, done) => {
    setCiBusy(true); setCiErr(null); setCiMsg(null);
    try {
      const out = await ltApi.combinedSaveCustomInvestors(map);
      setCi(out);
      setCiForm({ label: '', whiteLabel: '', aliases: '', key: '' });
      setCiEditKey(null);
      setCiMsg(done);
      // The rows above and the link pick-list are both drawn from the effective
      // roster, so an investor added here has to reach them without a reload.
      load();
    } catch (e) {
      const problems = e && e.data && Array.isArray(e.data.problems) ? e.data.problems : null;
      setCiErr(problems
        ? `Not saved — nothing was stored. ${problems.map((x) => x.message || x.problem).join(' · ')}`
        : (e && e.message) || 'That could not be saved.');
    } finally { setCiBusy(false); }
  }, [load]);

  // WHAT THE FORM WOULD CREATE, worked out in the browser only so a person can
  // see the key before they press the button. The server derives its own and is
  // the one that decides; this is a preview, never an instruction.
  const ciKey = String(ciForm.key || '').trim() || keyFromLabel(ciForm.label);
  const ciAliases = parseAliases(ciForm.aliases);
  const ciTaken = !!(ci && (ci.keysInUse || []).includes(ciKey) && ciKey !== ciEditKey);

  async function saveCustomInvestor() {
    if (ciBusy) return;
    const lbl = String(ciForm.label || '').trim();
    if (!lbl) { setCiErr('Type the investor’s real name first — that is what the key and the list are built from.'); return; }
    if (!ciKey) { setCiErr('That name has no letters or digits in it, so there is no key to give it.'); return; }
    if (ciTaken) { setCiErr(`The key “${ciKey}” is already in use. Give this one a key of its own.`); return; }
    const wl = String(ciForm.whiteLabel || '').trim();
    await putCustom(ciMap((map) => {
      if (ciEditKey && ciEditKey !== ciKey) delete map[ciEditKey];
      map[ciKey] = { label: lbl, whiteLabel: wl, aliases: ciAliases };
      return map;
    }), ciEditKey ? `Saved. “${lbl}” has been updated.` : `Saved. “${lbl}” can now be priced, linked and named.`);
  }

  async function removeCustomInvestor(key, lbl) {
    if (ciBusy) return;
    await putCustom(ciMap((map) => { delete map[key]; return map; }), `Removed “${lbl}”.`);
  }

  /**
   * The "Add this as a new investor" button on the links block below, answered.
   * The vendor's OWN spelling is carried in as the first spelling, because that
   * is the name the board could not match — retyping it by hand is how a second,
   * slightly different spelling gets created.
   */
  const startAddInvestor = useCallback((seed) => {
    setCiErr(null); setCiMsg(null); setCiEditKey(null);
    setCiForm({
      label: String((seed && seed.label) || '').trim(),
      whiteLabel: '',
      aliases: String((seed && seed.alias) || '').trim(),
      key: '',
    });
    try {
      const el = document.getElementById('ci-label');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      if (el && el.focus) el.focus();
    } catch { /* a browser that will not scroll is not an error */ }
  }, []);

  const rows = (data && data.investors) || [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.label} ${r.whiteLabel || ''} ${r.key}`.toLowerCase().includes(needle));
  }, [rows, q]);

  const edit = (key, patch) => {
    setSaved(null);
    // A reset REPLACES this row's pending edits rather than merging into them: a
    // half-typed white label left sitting beside it would be re-applied the moment
    // anything else on the row moved, quietly re-pinning the row somebody had just
    // asked to un-pin.
    setEdits((s) => (patch.reset
      ? { ...s, [key]: { reset: true } }
      : { ...s, [key]: { ...(s[key] || {}), ...patch } }));
  };

  const dirty = Object.keys(edits).length > 0;

  async function save() {
    if (busy) return;
    if (!data) { setErr('The investor list has not finished loading yet.'); return; }
    if (!dirty) { setSaved('Nothing has changed since this was last saved, so there is nothing to send.'); return; }
    setBusy(true); setErr(null); setSaved(null);
    try {
      const map = {};
      for (const r of rows) {
        const p = patchOf(r, edits[r.key] || {});
        if (Object.keys(p).length) map[r.key] = p;
      }
      const out = await ltApi.combinedSaveInvestors(map);
      setData(out); setEdits({});
      setSaved(`Saved. ${out.saved} investor${out.saved === 1 ? '' : 's'} now have a setting of their own; the rest use the pre-fill.`);
    } catch (e) {
      // A refusal names the rows it refused, so the person can fix the one that
      // is wrong rather than being told the form is bad.
      const problems = e && e.data && Array.isArray(e.data.problems) ? e.data.problems : null;
      setErr(problems
        ? `Not saved. ${problems.map((p) => `${p.investor || 'a row'}: ${p.message || p.error}`).join(' · ')}`
        : (e && e.message) || 'The settings could not be saved.');
    } finally { setBusy(false); }
  }

  const missing = (data && data.needsWhiteLabel) || [];

  /* THE WHOLE SCREEN IS THE SHARED SETTINGS SCREEN, with these panels passed in above it.
     Owner-directed: *"It should have separate settings with all the settings we currently have,
     adding the additional settings to link the investors and choose every investor from where it
     should price."* "All the settings we currently have" is the roster the shared screen draws
     from the server, so it is MOUNTED rather than listed here — a setting declared tomorrow is on
     this screen tomorrow, with nobody porting anything. */
  return (
    <SettingsScreen engine={COMBINED_ENGINE} slots={{ before: () => (
      <>
      <div style={{ ...card, borderColor: `${GOLD}55` }}>
        <div style={eyebrow}>What this screen decides</div>
        <div style={{ ...sub, marginBottom: 0, color: SLATE, lineHeight: 1.7 }}>
          Every investor is on this list. For each one you choose the name a client may see, which of
          the two pricing programs their products are fetched from, and whether they show at all.
          <br />
          <strong style={{ color: INK }}>Everything in this block is the Combined Pricing Engine
          only</strong> — the General Pricing Engine is not affected by any of it.
          <br />
          Below it is the company&#8217;s own configuration, the same settings the General Pricing
          Engine runs on and the same ones on the Long-term settings screen. It is here because
          this engine runs on them too and you should be able to see them in one place; a change
          made there changes both engines.
        </div>
      </div>

      {err && (
        <div style={{ ...card, borderColor: `${DANGER}55` }}>
          <div style={{ color: DANGER, fontSize: 13, fontWeight: 700 }}>{err}</div>
        </div>
      )}

      {/* THE MARGIN HOLDBACK — one number for the whole LoanNEX feed.
          Owner-directed: it must always be possible to move it up, remove it, or
          move it down. It is its own card rather than a row in the list below
          because it is not a per-investor setting: it applies to every LoanNEX
          quote, which is the owner's own rule ("On LoanNEX, everybody"). */}
      {hb && (
        <div style={{ ...card, borderColor: `${GOLD}55` }}>
          <div style={eyebrow}>The margin holdback we add ourselves</div>
          <div style={{ ...sub, color: SLATE, lineHeight: 1.7, marginBottom: 12 }}>
            {hb.note}
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '0 1 190px' }}>
              <label style={label} htmlFor="cps-hb">Points held back</label>
              <input
                id="cps-hb" style={input} inputMode="decimal" value={hbDraft} disabled={hbBusy}
                placeholder={String(hb.prefill)}
                onChange={(e) => { setHbDraft(e.target.value); setHbMsg(null); setHbErr(null); }}
              />
              <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
                {hb.origin === 'setting'
                  ? (hb.points === 0 ? 'you removed it' : 'you set this')
                  : `the standing ${hb.prefill}`}
              </div>
            </div>
            <div style={{ flex: '0 0 auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button" className="btn primary" disabled={hbBusy || hbDraft.trim() === ''}
                onClick={() => saveHb(Number(hbDraft))}
              >
                {hbBusy ? 'Saving…' : 'Save this amount'}
              </button>
              {/* REMOVE and BACK-TO-THE-PRE-FILL are two different things and are
                  two different buttons. Removing it stores a deliberate zero;
                  the pre-fill button stores nothing at all, so the row follows
                  the standing number again if it ever changes. */}
              <button type="button" className="btn ghost" disabled={hbBusy || hb.points === 0} onClick={() => saveHb(0)}>
                Remove it
              </button>
              <button type="button" className="btn ghost" disabled={hbBusy || hb.origin !== 'setting'} onClick={() => saveHb(null)}>
                Use the standing {hb.prefill}
              </button>
            </div>
          </div>

          {hb.points === 0 && (
            <div style={{ fontSize: 12, color: CAUTION, marginTop: 10, lineHeight: 1.6, fontWeight: 600 }}>
              No holdback is being taken. Lender Price&rsquo;s feed still carries its own, so while this
              stands the two programs are NOT being compared on the same footing — a LoanNEX quote will
              read better than a Lender Price one for that reason alone.
            </div>
          )}
          {hb.problem && (
            <div style={{ fontSize: 12, color: DANGER, marginTop: 10, lineHeight: 1.6, fontWeight: 600 }}>
              {hb.problem.message}
            </div>
          )}
          {hbErr && <div style={{ fontSize: 13, color: DANGER, marginTop: 10, fontWeight: 700 }}>{hbErr}</div>}
          {hbMsg && <div style={{ fontSize: 13, color: GOLD_TEXT, marginTop: 10, fontWeight: 700 }}>{hbMsg}</div>}
        </div>
      )}
      {saved && (
        <div style={{ ...card, borderColor: `${GOLD}55` }}>
          <div style={{ color: GOLD_TEXT, fontSize: 13, fontWeight: 700 }}>{saved}</div>
        </div>
      )}

      {data && missing.length > 0 && (
        <div style={{ ...card, borderColor: `${CAUTION}55` }}>
          <div style={eyebrow}>Still need a client-safe name ({missing.length})</div>
          <div style={{ fontSize: 13, color: SLATE, marginTop: 6, lineHeight: 1.7 }}>
            These investors have no white-label name yet. Nothing has been made up for them, and
            nothing will be: the white-label name is the only name a client may see, so each one has
            to be chosen by a person.
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 8, lineHeight: 1.8 }}>
            {missing.map((m) => m.investor).join(' · ')}
          </div>
        </div>
      )}

      {data && data.problems && data.problems.length > 0 && (
        <div style={{ ...card, borderColor: `${CAUTION}55` }}>
          <div style={eyebrow}>Settings that could not be read</div>
          {data.problems.map((p, i) => (
            <div key={i} style={{ fontSize: 12, color: CAUTION, marginTop: 6, lineHeight: 1.6 }}>
              {p.investor ? `${p.investor}: ` : ''}{p.message || p.error}
            </div>
          ))}
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <label style={label} htmlFor="cps-q">Find an investor</label>
            <input id="cps-q" style={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name" />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            {/* ⛔ ALWAYS CLICKABLE (owner-directed 2026-09-02: *"the save button
                should always be there"*). A greyed-out button cannot say why it
                is greyed out; this one answers instead and sends nothing when
                there is nothing to send. */}
            <button
              type="button"
              className="btn primary"
              aria-disabled={busy ? 'true' : 'false'}
              onClick={save}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <div style={{ fontSize: 12, color: dirty ? CAUTION : MUTED, marginTop: 6 }}>
              {dirty ? 'Not saved yet.' : 'Nothing has changed since this was last saved.'}
            </div>
          </div>
        </div>
        {data && (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 10, lineHeight: 1.6 }}>
            {data.summary.total} investors · {data.summary.on} on · {data.summary.off} off ·{' '}
            {data.summary.fromLenderPrice} from Lender Price · {data.summary.fromLoanNex} from LoanNEX
            {data.summary.fromBoth ? ` · ${data.summary.fromBoth} from both` : ''}
            {data.origin === 'environment' ? ' · settings are coming from this deployment’s configuration until you save here' : ''}
          </div>
        )}
      </div>

      {!data && !err && <div style={card}><div style={{ fontSize: 13, color: MUTED }}>Reading the investor list…</div></div>}

      {data && shown.map((r) => {
        const e = edits[r.key] || {};
        // A pending reset shows the row as it will read once saved: whatever the
        // pre-fill answers. `resetPreview` is what the row would fall back to with
        // no setting of its own — the standing instruction where there is one, and
        // the plain default otherwise; the server sends both on every row.
        const pending = !!e.reset;
        const pre = r.prefill || {};
        const wl = pending ? (pre.whiteLabel || '') : (e.whiteLabel !== undefined ? e.whiteLabel : (r.whiteLabel || ''));
        const src = pending ? (pre.source || r.source) : (e.source !== undefined ? e.source : r.source);
        const on = pending ? (pre.enabled !== undefined ? pre.enabled : r.enabled) : (e.enabled !== undefined ? e.enabled : r.enabled);
        // A blank box is the honest reading of "nothing of my own here": only a row
        // somebody has actually answered shows a figure, so the placeholder 0 never
        // reads as a decision nobody made.
        // Named apart from the screen's own `hb` (the ONE standing holdback for
        // the whole LoanNEX feed): one row's extra and the feed-wide figure are
        // different decisions, and a name that means both is how they get mixed up.
        const hbRow = pending ? (pre.holdback != null ? String(pre.holdback) : '')
          : (e.holdback !== undefined ? e.holdback : (r.holdbackOrigin === 'setting' ? String(r.holdback) : ''));
        const pinned = isPinned(r);
        return (
          <div key={r.key} style={{ ...card, opacity: on ? 1 : 0.72 }}>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{r.label}</div>
                {r.note && <div style={{ fontSize: 12, color: CAUTION, marginTop: 4, lineHeight: 1.6 }}>{r.note}</div>}
                {(pinned || pending) && (
                  <button
                    type="button"
                    onClick={() => edit(r.key, pending ? { reset: false } : { reset: true })}
                    style={{
                      marginTop: 6, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                      font: 'inherit', fontSize: 12, fontWeight: 700, color: pending ? SLATE : GOLD_TEXT,
                      textDecoration: 'underline',
                    }}
                  >
                    {pending ? 'Keep this row’s own setting after all' : 'Use the pre-fill instead'}
                  </button>
                )}
                {pending && (
                  <div style={{ fontSize: 11, color: SLATE, marginTop: 4, lineHeight: 1.6 }}>
                    On save this row goes back to having no setting of its own, so it follows the
                    pre-fill from then on.
                  </div>
                )}
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <label style={label} htmlFor={`wl-${r.key}`}>
                  Name a client may see{r.whiteLabelMissing ? ' — not named yet' : ''}
                </label>
                <input
                  id={`wl-${r.key}`} style={{ ...input, borderColor: r.whiteLabelMissing ? `${CAUTION}88` : undefined }}
                  value={wl} placeholder="(none yet)" disabled={pending}
                  onChange={(ev) => edit(r.key, { whiteLabel: ev.target.value })}
                />
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{ORIGIN_NOTE[r.whiteLabelOrigin] || ''}</div>
                {!pending && e.whiteLabel !== undefined && !String(e.whiteLabel).trim() && r.whiteLabelOrigin === 'setting' && (
                  <div style={{ fontSize: 11, color: CAUTION, marginTop: 4, lineHeight: 1.6 }}>
                    {pre.whiteLabel
                      ? `On save this investor goes back to being called “${pre.whiteLabel}”, which is the name on file for it.`
                      : 'On save this investor has no name a client may see, so it cannot be put in front of one until you name it.'}
                  </div>
                )}
              </div>
              <div style={{ flex: '0 1 190px' }}>
                <label style={label} htmlFor={`src-${r.key}`}>Fetch their pricing from</label>
                <select id={`src-${r.key}`} style={input} value={src} disabled={pending} onChange={(ev) => edit(r.key, { source: ev.target.value })}>
                  {(data.sources || []).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
                </select>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{ORIGIN_NOTE[r.sourceOrigin] || ''}</div>
              </div>
              {/* THIS INVESTOR'S OWN EXTRA (owner-directed 2026-08-30: *"We can add extra
                  company margin holdbacks on top of each and every program. If it's a set
                  on LoanNEX, we should be able to increase or decrease the margin holdbacks
                  accordingly."*).

                  ONE SIGNED NUMBER answers both halves: positive adds on top of whatever
                  the feed already holds back, negative takes it back down. Two boxes — one
                  to add and one to reduce — would be two ways to say one thing, and the
                  screen would then have to decide what they mean together. */}
              <div style={{ flex: '0 1 150px' }}>
                <label style={label} htmlFor={`hb-${r.key}`}>Extra holdback (points)</label>
                <input
                  id={`hb-${r.key}`} style={input} inputMode="decimal" disabled={pending}
                  value={hbRow} placeholder="0"
                  onChange={(ev) => edit(r.key, { holdback: ev.target.value })}
                />
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
                  {r.holdbackOrigin === 'setting'
                    ? (Number(r.holdback) === 0 ? 'you set nothing extra here'
                      : (Number(r.holdback) > 0 ? `you add ${r.holdback} on top` : `you take ${Math.abs(Number(r.holdback))} back off`))
                    : 'the standing holdback only'}
                </div>
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!on} disabled={pending} onChange={(ev) => edit(r.key, { enabled: ev.target.checked })} />
                  <span style={{ fontSize: 13, color: SLATE, fontWeight: 600 }}>{on ? 'Showing' : 'Not showing'}</span>
                </label>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{ORIGIN_NOTE[r.enabledOrigin] || ''}</div>
              </div>
            </div>
          </div>
        );
      })}

      {data && shown.length === 0 && (
        <div style={card}>
          <div style={{ fontSize: 13, color: MUTED }}>No investor matches “{q}”.</div>
        </div>
      )}

      <div style={{ height: 8, borderTop: `1px solid ${LINE}`, marginTop: 16 }} />

      {/* ═══ AN INVESTOR WE HAVE NEVER PRICED BEFORE ═══
          Owner-directed 2026-09-02: *"I want to be able to add a new investor
          myself — one came up on a vendor board and there was nowhere to put it.
          And I need to give it our own name, the way the others have one."*

          ⛔ NO INVESTOR IS NAMED IN THIS FILE. Everything drawn here arrives from
          the server, which is the only thing that knows the roster.

          ⛔ NOTHING IS CHECKED HERE THAT MATTERS. The key shown below is a preview
          so a person is not surprised by it; every rule that makes an investor
          safe to add — that no name collides with one already recorded, and that
          the client-safe name cannot slip past the block that keeps a real
          investor name away from a client — is applied at the door and cannot be
          talked past from a screen. */}
      <div style={{ ...card, borderColor: `${GOLD}55` }}>
        <div style={eyebrow}>Add an investor</div>
        <div style={{ ...sub, color: SLATE, lineHeight: 1.7 }}>
          For an investor that turns up on one of the programs and is not on the list above. Give
          the real name, the name a client may see, and every spelling the programs use for it —
          that is what lets a board find it instead of dropping the row.
        </div>

        {ciErr && <div style={{ fontSize: 13, color: DANGER, marginBottom: 10, lineHeight: 1.6 }}>{ciErr}</div>}
        {ciMsg && <div style={{ fontSize: 13, color: GOLD_TEXT, marginBottom: 10 }}>{ciMsg}</div>}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 240px' }}>
            <label style={label} htmlFor="ci-label">Their real name</label>
            <input
              id="ci-label" style={input} value={ciForm.label}
              onChange={(ev) => { setCiErr(null); setCiForm((f) => ({ ...f, label: ev.target.value })); }}
            />
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Internal only. It is never shown to a client.
            </div>
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={label} htmlFor="ci-wl">Name a client may see</label>
            <input
              id="ci-wl" style={input} value={ciForm.whiteLabel}
              onChange={(ev) => { setCiErr(null); setCiForm((f) => ({ ...f, whiteLabel: ev.target.value })); }}
            />
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Leave it blank and this investor stays off anything a client sees until you name it.
            </div>
          </div>
          <div style={{ flex: '1 1 260px' }}>
            <label style={label} htmlFor="ci-aliases">Other spellings the programs use</label>
            <input
              id="ci-aliases" style={input} value={ciForm.aliases}
              placeholder="Separate them with commas"
              onChange={(ev) => { setCiErr(null); setCiForm((f) => ({ ...f, aliases: ev.target.value })); }}
            />
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              {ciAliases.length
                ? `${ciAliases.length} spelling${ciAliases.length === 1 ? '' : 's'} · the real name always counts as one.`
                : 'The real name always counts as one.'}
            </div>
          </div>
          <div style={{ flex: '0 1 200px' }}>
            <label style={label} htmlFor="ci-key">Its key</label>
            <input
              id="ci-key" style={{ ...input, borderColor: ciTaken ? `${DANGER}88` : undefined }}
              value={ciForm.key} placeholder={ciKey || '(from the name)'}
              onChange={(ev) => { setCiErr(null); setCiForm((f) => ({ ...f, key: ev.target.value })); }}
            />
            <div style={{ fontSize: 11, color: ciTaken ? DANGER : MUTED, marginTop: 4, lineHeight: 1.6 }}>
              {ciTaken
                ? `“${ciKey}” is already in use.`
                : (ciKey ? `Saved as “${ciKey}”. Lower-case letters, digits and underscores.` : 'Built from the name.')}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn primary"
            aria-disabled={ciBusy ? 'true' : 'false'}
            onClick={saveCustomInvestor}
          >
            {ciBusy ? 'Saving…' : (ciEditKey ? 'Save this investor' : 'Add this investor')}
          </button>
          {ciEditKey && (
            <button
              type="button"
              onClick={() => { setCiEditKey(null); setCiForm({ label: '', whiteLabel: '', aliases: '', key: '' }); setCiErr(null); }}
              style={{ border: `1px solid ${LINE}`, background: '#fff', color: INK, borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >Stop editing</button>
          )}
        </div>

        {ci && ci.problem && (
          <div style={{ fontSize: 12, color: CAUTION, marginTop: 10, lineHeight: 1.6 }}>
            The investors added by hand could not be read, so none of them are in force right now
            and boards are being priced on the standing list alone.
          </div>
        )}
        {ci && (ci.problems || []).length > 0 && (
          <div style={{ fontSize: 12, color: CAUTION, marginTop: 10, lineHeight: 1.6 }}>
            {(ci.problems || []).map((x) => x.message || x.problem).join(' · ')}
          </div>
        )}

        <div style={{ marginTop: 14, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: MUTED, fontWeight: 700, marginBottom: 6 }}>
            Investors you have added ({(ci && ci.list ? ci.list.length : 0)})
          </div>
          {ci && (ci.list || []).length === 0 && (
            <div style={{ fontSize: 13, color: MUTED }}>None yet.</div>
          )}
          {ci && (ci.list || []).map((e) => (
            <div key={e.key} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', padding: '10px 0', borderTop: `1px solid ${LINE}` }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontSize: 13, color: INK, fontWeight: 700 }}>{e.label}</div>
                <div style={{ fontSize: 11, color: e.whiteLabel ? MUTED : CAUTION, marginTop: 2 }}>
                  {e.whiteLabel
                    ? `Clients see “${e.whiteLabel}”`
                    : 'No name a client may see yet, so this investor is kept off client-facing surfaces.'}
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                  {e.aliases.length} spelling{e.aliases.length === 1 ? '' : 's'} · key {e.key}
                  {e.addedAt ? ` · added ${String(e.addedAt).slice(0, 10)}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCiErr(null); setCiMsg(null); setCiEditKey(e.key);
                  setCiForm({
                    label: e.label,
                    whiteLabel: e.whiteLabel || '',
                    // The real name is a spelling in its own right and the server
                    // adds it back, so it is not offered for editing here.
                    aliases: (e.aliases || []).filter((a) => a !== e.label).join(', '),
                    key: e.key,
                  });
                }}
                style={{ border: `1px solid ${LINE}`, background: '#fff', color: INK, borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >Edit</button>
              <button
                type="button"
                onClick={() => removeCustomInvestor(e.key, e.label)}
                style={{ border: `1px solid ${LINE}`, background: '#fff', color: DANGER, borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >Remove</button>
            </div>
          ))}
        </div>
      </div>

      {/* THE LINKS. Mounted here rather than re-implemented, so the settings screen
          and the priced board show ONE arrangement of the same thing — the board
          additionally passes the live side-by-side, which only exists there. */}
      <LtInvestorLinks onAddInvestor={startAddInvestor} onChanged={load} />

      <div style={{ height: 24, borderTop: `1px solid ${LINE}`, marginTop: 8 }} />
      </>
    ) }} />
  );
}
