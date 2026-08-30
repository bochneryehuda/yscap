import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import LtInvestorLinks from './LtInvestorLinks.jsx';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, CAUTION, DANGER, card, eyebrow, sub, input, label, LINE } from './ppeStyles.js';

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

const SOURCE_LABEL = {
  lenderprice: 'Lender Price',
  loannex: 'LoanNEX',
  both: 'Both (compare)',
};

/** Where an answer came from, in words a person can act on. */
const ORIGIN_NOTE = {
  setting: 'you set this',
  owner_directed: 'pre-filled by instruction',
  default: 'pre-filled',
  sheet: 'from the white-label sheet',
  unset: 'not named yet',
};

/** Is this row pinned — does it carry a setting of its own rather than the pre-fill? */
function isPinned(row) {
  return row.sourceOrigin === 'setting' || row.enabledOrigin === 'setting' || row.whiteLabelOrigin === 'setting';
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
  if (edit.whiteLabel !== undefined && String(edit.whiteLabel).trim() !== String(row.whiteLabel || '')) {
    const wl = String(edit.whiteLabel).trim();
    if (wl) out.whiteLabel = wl;
  } else if (row.whiteLabelOrigin === 'setting') {
    out.whiteLabel = row.whiteLabel;
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

  const load = useCallback(() => {
    setErr(null);
    ltApi.combinedInvestors()
      .then((r) => { setData(r); setEdits({}); })
      .catch((e) => setErr((e && e.message) || 'The settings could not be read.'));
  }, []);
  useEffect(load, [load]);

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
      const problems = e && e.body && Array.isArray(e.body.problems) ? e.body.problems : null;
      setErr(problems
        ? `Not saved. ${problems.map((p) => `${p.investor || 'a row'}: ${p.message || p.error}`).join(' · ')}`
        : (e && e.message) || 'The settings could not be saved.');
    } finally { setBusy(false); }
  }

  const missing = (data && data.needsWhiteLabel) || [];

  return (
    <LtLayout title="Combined Pricing Engine settings">
      <div style={{ ...card, borderColor: `${GOLD}55` }}>
        <div style={eyebrow}>What this screen decides</div>
        <div style={{ ...sub, marginBottom: 0, color: SLATE, lineHeight: 1.7 }}>
          Every investor is on this list. For each one you choose the name a client may see, which of
          the two pricing programs their products are fetched from, and whether they show at all.
          <br />
          <strong style={{ color: INK }}>This is the Combined Pricing Engine only.</strong> The General
          Pricing Engine is not affected by anything here.
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
            <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>
              {busy ? 'Saving…' : dirty ? 'Save changes' : 'Nothing to save'}
            </button>
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
              </div>
              <div style={{ flex: '0 1 190px' }}>
                <label style={label} htmlFor={`src-${r.key}`}>Fetch their pricing from</label>
                <select id={`src-${r.key}`} style={input} value={src} disabled={pending} onChange={(ev) => edit(r.key, { source: ev.target.value })}>
                  {(data.sources || []).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
                </select>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{ORIGIN_NOTE[r.sourceOrigin] || ''}</div>
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

      {/* THE LINKS. Mounted here rather than re-implemented, so the settings screen
          and the priced board show ONE arrangement of the same thing — the board
          additionally passes the live side-by-side, which only exists there. */}
      <LtInvestorLinks />

      <div style={{ height: 24, borderTop: `1px solid ${LINE}`, marginTop: 8 }} />
    </LtLayout>
  );
}
