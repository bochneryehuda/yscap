import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import CompPlanCard from './CompPlanCard.jsx';
import { INK, MUTED, SLATE, PAPER, DANGER, CAUTION, card, h2, sub, eyebrow, input, label } from './ppeStyles.js';

// ---------------------------------------------------------------------------
// The pricing engine's settings, made changeable.
//
// Until this screen existed, NOTHING in the product could change one of these numbers:
// `store.setSetting` / `store.clearSetting` had no caller anywhere in `src/`, and the
// router published the settings read with no write route at all. So every parity
// tolerance, the rounding, the price floor and the per-investor margin were read-only in
// practice and could only be changed by editing the database by hand.
//
// Five rules this screen keeps:
//   · It CARRIES NO LIST OF SETTINGS. Every row — its label, its help, its type, its
//     range, its option list, its default — comes from `settings[]` on the server's own
//     answer. Adding a setting server-side makes it appear here with no change to this
//     file, which is what stops the two drifting into two definitions of "what is
//     configurable".
//   · It says which values are DEFAULTS and which a human set — two different facts. A
//     row shows where the value in force came from AND, separately, whether somebody set
//     it at this slot, with who and when.
//   · It NEVER builds a scope string. The slot is stated in words ("company-wide" or an
//     investor), which is what makes it impossible to put a per-investor number into the
//     global slot by a typo.
//   · It never hides a control a person may not use. A non-admin sees the settings and
//     is told, in place, that changing them is an administrator's job — a hidden control
//     is indistinguishable from a broken one.
//   · It confirms a change INLINE rather than in a modal: the shared dialog helper lives
//     in RTL's folders and Long-Term may not import RTL code (the separation gate refuses
//     it, correctly), and a second Long-Term copy of a dialog would be a duplicate of a
//     solved problem. It is also simply better here — the "are you sure" belongs next to
//     the number it is about, and so does the refusal.
//
// Dark text on the white PILOT canvas throughout — never a `--ink*` token, which is a
// LIGHT paper colour in this palette and renders white-on-white.
// ---------------------------------------------------------------------------

function Pill({ tone, children, title }) {
  const tones = {
    good: { bg: 'rgba(47,127,134,.10)', fg: '#256168', bd: 'rgba(47,127,134,.35)' },
    warn: { bg: 'rgba(174,135,70,.12)', fg: CAUTION, bd: 'rgba(174,135,70,.40)' },
    bad: { bg: 'rgba(158,58,58,.10)', fg: DANGER, bd: 'rgba(158,58,58,.32)' },
    flat: { bg: PAPER, fg: SLATE, bd: 'rgba(20,27,34,.14)' },
  };
  const t = tones[tone] || tones.flat;
  return (
    <span title={title} style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12,
      fontWeight: 600, background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
    }}>{children}</span>
  );
}

// How a value is TYPED, entirely from the server's description of the setting. A `json`
// setting is edited as text and parsed on save — refused here with a plain message rather
// than sent as a string the server would (correctly) turn back.
function textOf(row) {
  if (row.value === null || row.value === undefined) return '';
  if (row.type === 'json') return JSON.stringify(row.value, null, 2);
  return String(row.value);
}

function parseTyped(row, text) {
  const raw = String(text == null ? '' : text);
  if (row.type === 'number') {
    if (!raw.trim()) {
      if (row.nullable) return { ok: true, value: null };
      return { ok: false, message: `${row.label} cannot be left blank.` };
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, message: `${row.label} must be a number.` };
    return { ok: true, value: n };
  }
  if (row.type === 'boolean') return { ok: true, value: raw === 'true' };
  if (row.type === 'json') {
    if (!raw.trim()) return { ok: false, message: `${row.label} needs a list or an object — leave the default in place instead.` };
    try { return { ok: true, value: JSON.parse(raw) }; } catch (e) {
      return { ok: false, message: `${row.label} is not valid JSON (${e.message}).` };
    }
  }
  return { ok: true, value: raw };
}

// A value as a person reads it, for the "in force" line and the history.
function show(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

const SOURCE_WORDS = {
  product_default: 'the shipped default',
  company: 'the company-wide value',
  investor: "this investor's own value",
  officer: "this loan officer's own value",
};

export default function LtPpeSettings() {
  const [data, setData] = useState(null);
  const [investors, setInvestors] = useState([]);
  const [investor, setInvestor] = useState('');
  // The loan officers PILOT can key a settings slot on. They come from the people map, and only a
  // row that is LINKED to one of our staff records carries an id to key on — an unlinked Encompass
  // login is a person we cannot store a number against, and offering one would be a control the
  // server refuses.
  const [officers, setOfficers] = useState([]);
  const [officer, setOfficer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Per-row state, keyed by setting key so two rows can never share a half-typed value
  // or somebody else's refusal.
  const [draft, setDraft] = useState({});
  const [rowError, setRowError] = useState({});
  const [rowOk, setRowOk] = useState({});
  const [confirmClear, setConfirmClear] = useState(null);

  const [history, setHistory] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);

  const target = useMemo(() => {
    if (investor) return { target: 'investor', investor };
    if (officer) return { target: 'officer', officer };
    return { target: 'company' };
  }, [investor, officer]);

  const load = useCallback(() => {
    setNote('');
    ltApi.ppeSettings(investor || undefined, officer || undefined)
      .then((d) => { setData(d); setDraft({}); setRowError({}); setRowOk({}); })
      .catch((e) => setNote(e.message || 'Could not read the pricing engine settings.'));
  }, [investor, officer]);
  useEffect(load, [load]);

  useEffect(() => {
    ltApi.ppeInvestors().then((d) => setInvestors((d && d.investors) || [])).catch(() => setInvestors([]));
    ltApi.people().then((d) => {
      const seen = new Map();
      for (const p of ((d && d.people) || [])) {
        if (p && p.staff && p.staff.id && !seen.has(p.staff.id)) seen.set(p.staff.id, p.staff);
      }
      setOfficers([...seen.values()]);
    }).catch(() => setOfficers([]));
  }, []);

  // The server's own answer is what redraws the screen after a save — never the values
  // that were just sent. A screen that redraws what it typed shows a save that did not
  // happen as a save that did.
  const adopt = (d, keys) => {
    setData(d);
    setDraft((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
    if (historyFor) openHistory(historyFor, d);
  };

  const openHistory = (key, latest) => {
    setHistoryFor(key);
    setHistory(null);
    ltApi.ppeSettingsAudit({ key, investor: investor || undefined })
      .then(setHistory)
      .catch((e) => setHistory({ available: false, error: e.message, entries: [] }));
    void latest;
  };

  const save = async (row) => {
    const parsed = parseTyped(row, draft[row.key]);
    if (!parsed.ok) {
      setRowError((e) => ({ ...e, [row.key]: parsed.message }));
      return;
    }
    setBusy(true);
    setRowError((e) => ({ ...e, [row.key]: null }));
    setRowOk((o) => ({ ...o, [row.key]: null }));
    try {
      const d = await ltApi.ppeSaveSettings(target, { [row.key]: parsed.value });
      const applied = (d.applied || []).find((a) => a.key === row.key);
      adopt(d, [row.key]);
      setRowOk((o) => ({
        ...o,
        [row.key]: applied && applied.changed === false
          ? 'Nothing changed — it already had that value.'
          : 'Saved.',
      }));
    } catch (e) {
      // The server refuses an unknown key, a bad type, a value outside the range, a
      // per-investor key at the wrong slot, and a non-admin — and its wording names WHICH
      // rule was broken. A generic "that didn't work" would not.
      setRowError((er) => ({ ...er, [row.key]: e.message || 'That change was refused.' }));
    } finally { setBusy(false); }
  };

  const clear = async (row) => {
    setBusy(true);
    setConfirmClear(null);
    setRowError((e) => ({ ...e, [row.key]: null }));
    setRowOk((o) => ({ ...o, [row.key]: null }));
    try {
      const d = await ltApi.ppeClearSettings(target, [row.key]);
      const applied = (d.applied || []).find((a) => a.key === row.key);
      adopt(d, [row.key]);
      setRowOk((o) => ({
        ...o,
        [row.key]: applied && applied.changed === false
          ? 'Nothing changed — it was already following the default.'
          : 'Back to the default.',
      }));
    } catch (e) {
      setRowError((er) => ({ ...er, [row.key]: e.message || 'That change was refused.' }));
    } finally { setBusy(false); }
  };

  const rows = (data && data.settings) || null;
  const canWrite = !!(data && data.canWrite);
  const groups = useMemo(() => {
    const out = [];
    for (const r of rows || []) {
      let g = out.find((x) => x.name === r.group);
      if (!g) { g = { name: r.group, rows: [] }; out.push(g); }
      g.rows.push(r);
    }
    return out;
  }, [rows]);

  return (
    <LtLayout title="Pricing engine settings">
      {note && <div style={{ ...card, borderColor: 'rgba(158,58,58,.32)', color: DANGER }}>{note}</div>}

      <div style={card}>
        <h2 style={h2}>What these numbers do</h2>
        <p style={sub}>
          These are the knobs the pricing engine runs on — how close our price has to be to Lender Price
          before we call it a disagreement, how the final price is rounded, the lowest price we will
          quote, and the margin and holdback we hold back. Every one ships with a default we chose;
          changing one here overrides that default from now on, and every change is recorded.
        </p>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 300, flex: '0 1 380px' }}>
            <span style={label}>Whose settings</span>
            {/* Wide enough for the longest option to read in full — a truncated
                "Everyone — the company-wide val" is the one control on this screen
                where a misread means changing the wrong investor's numbers. */}
            {/* ONE control for the three slots, because they are one choice. Two pickers would let
                somebody name an investor AND an officer, which the server refuses — and a control that
                can produce a refused request is a control that reads as broken. */}
            <select
              style={{ ...input, maxWidth: 380 }}
              value={investor ? `investor:${investor}` : (officer ? `officer:${officer}` : '')}
              onChange={(e) => {
                const v = e.target.value;
                setInvestor(v.startsWith('investor:') ? v.slice('investor:'.length) : '');
                setOfficer(v.startsWith('officer:') ? v.slice('officer:'.length) : '');
              }}
            >
              <option value="">Everyone — the company-wide values</option>
              {investors.map((i) => (
                <option key={i.id || i.code} value={`investor:${i.code}`}>{i.name || i.code} only</option>
              ))}
              {officers.map((o) => (
                <option key={o.id} value={`officer:${o.id}`}>{o.name || o.email} (loan officer) only</option>
              ))}
            </select>
          </div>
          {!canWrite && (
            <p style={{ ...sub, marginBottom: 0, color: CAUTION, flex: 1, minWidth: 240 }}>
              You can see how the engine is set up. Changing one of these numbers is an administrator's
              job — the buttons are here, and the server will say so if you try.
            </p>
          )}
        </div>

        {officer && (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0 }}>
            Only this loan officer&rsquo;s own compensation numbers can differ here — what they earn, how
            it splits between origination and rebate, their per-loan least and most, and their share.
            The company holdback is deliberately not on that list: it is the company&rsquo;s and an
            officer can never set it. Everything else is company-wide and read-only here.
          </p>
        )}
        {investor && (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0 }}>
            Only a few settings can differ per investor — the margin, the holdback, and the per-scenario
            rules. Everything else is company-wide and is shown here read-only, with the company value it
            is using. Where this investor has nothing of their own, they follow the company value.
          </p>
        )}
        {data && data.describeError && (
          <p style={{ ...sub, marginTop: 12, marginBottom: 0, color: DANGER }}>
            The engine could not read which of these have been changed, so every row below shows the
            value in force without saying who set it. ({data.describeError})
          </p>
        )}
      </div>

      {!rows && !note && <div style={card}><p style={{ ...sub, marginBottom: 0 }}>Reading the settings…</p></div>}

      {groups.map((g) => (
        <div key={g.name} style={card}>
          <h2 style={h2}>{g.name}</h2>
          {g.rows.map((row) => {
            const dirty = Object.prototype.hasOwnProperty.call(draft, row.key);
            const value = dirty ? draft[row.key] : textOf(row);
            const readOnly = !row.settable;
            return (
              <div key={row.key} style={{ borderTop: '1px solid rgba(20,27,34,.10)', padding: '14px 0' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontSize: 14, color: INK, fontWeight: 600 }}>{row.label}</span>
                  {row.isDefault
                    ? <Pill tone="flat" title="Nobody has changed this — it is the value the engine ships with.">the shipped default</Pill>
                    : <Pill tone="good" title={`In force from ${SOURCE_WORDS[row.source] || row.source}.`}>set to {show(row.value)}</Pill>}
                  {row.perInvestor && <Pill tone="warn">can differ per investor</Pill>}
                  {row.perOfficer && <Pill tone="warn">can differ per loan officer</Pill>}
                  {readOnly && <Pill tone="flat">company-wide only</Pill>}
                </div>

                <p style={{ ...sub, marginBottom: 8 }}>{row.help}</p>

                <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
                  In force: <strong style={{ color: INK }}>{show(row.value)}</strong> — {SOURCE_WORDS[row.source] || row.source}.
                  {' '}The default is {show(row.default)}.
                  {row.setHere && (
                    <> Set here{row.setAt ? ` on ${String(row.setAt).slice(0, 10)}` : ''}
                      {row.setBy ? ' by a person on the team' : ''}.</>
                  )}
                  {!row.setHere && !row.isDefault && (investor || officer) && (
                    <> Nothing of their own is set here, so it follows the company value ({show(row.companyValue)}).</>
                  )}
                  {row.ignoredHere && (
                    <span style={{ color: CAUTION }}>
                      {' '}There is a leftover value stored for this investor and nothing reads it — the engine uses
                      the company value above.
                    </span>
                  )}
                </div>

                {readOnly ? (
                  <p style={{ ...sub, marginBottom: 0 }}>
                    Change this on the company-wide settings — it is the same for every investor.
                  </p>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      {row.type === 'enum' ? (
                        <select
                          style={{ ...input, maxWidth: 320 }}
                          value={value}
                          disabled={busy}
                          onChange={(e) => setDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                        >
                          {(row.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : row.type === 'boolean' ? (
                        <select
                          style={{ ...input, maxWidth: 200 }}
                          value={value === 'true' ? 'true' : 'false'}
                          disabled={busy}
                          onChange={(e) => setDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                        >
                          <option value="true">yes</option>
                          <option value="false">no</option>
                        </select>
                      ) : row.type === 'json' ? (
                        <textarea
                          rows={4}
                          style={{ ...input, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, maxWidth: 560 }}
                          value={value}
                          disabled={busy}
                          onChange={(e) => setDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                        />
                      ) : (
                        <input
                          type={row.type === 'number' ? 'number' : 'text'}
                          style={{ ...input, maxWidth: 240 }}
                          value={value}
                          disabled={busy}
                          min={row.min == null ? undefined : row.min}
                          max={row.max == null ? undefined : row.max}
                          step={row.integer ? 1 : 'any'}
                          onChange={(e) => setDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                        />
                      )}

                      <button className="btn" disabled={busy || !dirty} onClick={() => save(row)}>Save</button>
                      {row.setHere && (
                        confirmClear === row.key ? (
                          <>
                            <button className="btn" disabled={busy} onClick={() => clear(row)}>
                              Yes — back to {show(row.default)}
                            </button>
                            <button className="btn ghost" disabled={busy} onClick={() => setConfirmClear(null)}>Cancel</button>
                          </>
                        ) : (
                          <button className="btn ghost" disabled={busy} onClick={() => setConfirmClear(row.key)}>
                            Put back to the default
                          </button>
                        )
                      )}
                      <button
                        className="btn ghost"
                        disabled={busy}
                        onClick={() => (historyFor === row.key ? setHistoryFor(null) : openHistory(row.key))}
                      >
                        {historyFor === row.key ? 'Hide history' : 'History'}
                      </button>
                    </div>
                    {row.type === 'number' && (row.min != null || row.max != null) && (
                      <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                        Allowed: {row.min == null ? 'any' : row.min} to {row.max == null ? 'any' : row.max}
                        {row.integer ? ', whole numbers only' : ''}.
                      </div>
                    )}
                    {confirmClear === row.key && (
                      <div style={{ fontSize: 13, color: CAUTION, marginTop: 8 }}>
                        This takes the setting back to {show(row.default)} and it will follow the default again from
                        now on. The change is recorded.
                      </div>
                    )}
                    {rowError[row.key] && (
                      <div style={{ marginTop: 8, fontSize: 13, color: DANGER }}>{rowError[row.key]}</div>
                    )}
                    {rowOk[row.key] && (
                      <div style={{ marginTop: 8, fontSize: 13, color: '#256168' }}>{rowOk[row.key]}</div>
                    )}
                  </>
                )}

                {historyFor === row.key && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: PAPER }}>
                    <div style={{ ...eyebrow, marginBottom: 6 }}>Every change to this setting</div>
                    {!history && <div style={{ fontSize: 13, color: MUTED }}>Reading…</div>}
                    {history && history.available === false && (
                      <div style={{ fontSize: 13, color: DANGER }}>
                        The history could not be read, so this is not a list of no changes — it is no answer.
                        {history.error ? ` (${history.error})` : ''}
                      </div>
                    )}
                    {history && history.available !== false && (history.entries || []).length === 0 && (
                      <div style={{ fontSize: 13, color: SLATE }}>Nobody has changed this yet.</div>
                    )}
                    {history && (history.entries || []).map((h) => (
                      <div key={h.id} style={{ fontSize: 13, color: SLATE, padding: '4px 0' }}>
                        <strong style={{ color: INK }}>{show(h.from)}</strong>
                        {h.fromSource === 'product_default' ? ' (the default)' : ''}
                        {' → '}
                        <strong style={{ color: INK }}>{show(h.to)}</strong>
                        {h.toSource === 'product_default' ? ' (back to the default)' : ''}
                        {' — '}{h.by || 'not recorded'}{h.at ? `, ${String(h.at).slice(0, 10)}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        Every change here is written down — what it was, what it became, who changed it and when — and
        that record is never edited or removed.
      </p>
      <CompPlanCard officers={officers} />
    </LtLayout>
  );
}
