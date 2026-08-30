import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
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

/** The row as the server would store it — only what a person has actually CHANGED. */
function patchOf(row, edit) {
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

  const load = useCallback(() => {
    setErr(null);
    ltApi.combinedInvestors()
      .then((r) => { setData(r); setEdits({}); })
      .catch((e) => setErr((e && e.message) || 'The settings could not be read.'));
  }, []);
  useEffect(load, [load]);

  const rows = (data && data.investors) || [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.label} ${r.whiteLabel || ''} ${r.key}`.toLowerCase().includes(needle));
  }, [rows, q]);

  const edit = (key, patch) => {
    setSaved(null);
    setEdits((s) => ({ ...s, [key]: { ...(s[key] || {}), ...patch } }));
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
        const wl = e.whiteLabel !== undefined ? e.whiteLabel : (r.whiteLabel || '');
        const src = e.source !== undefined ? e.source : r.source;
        const on = e.enabled !== undefined ? e.enabled : r.enabled;
        return (
          <div key={r.key} style={{ ...card, opacity: on ? 1 : 0.72 }}>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{r.label}</div>
                {r.note && <div style={{ fontSize: 12, color: CAUTION, marginTop: 4, lineHeight: 1.6 }}>{r.note}</div>}
              </div>
              <div style={{ flex: '1 1 220px' }}>
                <label style={label} htmlFor={`wl-${r.key}`}>
                  Name a client may see{r.whiteLabelMissing ? ' — not named yet' : ''}
                </label>
                <input
                  id={`wl-${r.key}`} style={{ ...input, borderColor: r.whiteLabelMissing ? `${CAUTION}88` : undefined }}
                  value={wl} placeholder="(none yet)"
                  onChange={(ev) => edit(r.key, { whiteLabel: ev.target.value })}
                />
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{ORIGIN_NOTE[r.whiteLabelOrigin] || ''}</div>
              </div>
              <div style={{ flex: '0 1 190px' }}>
                <label style={label} htmlFor={`src-${r.key}`}>Fetch their pricing from</label>
                <select id={`src-${r.key}`} style={input} value={src} onChange={(ev) => edit(r.key, { source: ev.target.value })}>
                  {(data.sources || []).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
                </select>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{ORIGIN_NOTE[r.sourceOrigin] || ''}</div>
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!on} onChange={(ev) => edit(r.key, { enabled: ev.target.checked })} />
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
      <div style={{ height: 24, borderTop: `1px solid ${LINE}`, marginTop: 8 }} />
    </LtLayout>
  );
}
