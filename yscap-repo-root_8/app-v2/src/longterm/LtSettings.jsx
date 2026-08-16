import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

/**
 * The long-term SETTINGS screen — the sellable-LOS rule made usable.
 *
 * THE WHOLE SCREEN IS DRAWN FROM THE SERVER'S OWN DESCRIPTION. There is no list of
 * settings in this file, and there must never be one: a front end carrying its own
 * copy is a second source of truth for "what can be configured", and the moment the
 * two drift, the half that drifted is the half somebody trusts. Adding a setting in
 * `src/longterm/settings/encompass-settings.js` makes it appear here on its own.
 *
 * The consequence is that the EDITOR is chosen from the declaration's `type`, not
 * from the key — so a new list, number or toggle is editable the day it is declared.
 * A shape this screen cannot edit safely (a map of milestone → stage, a list of
 * objects) is shown READ-ONLY as its own JSON rather than hidden: a person must be
 * able to see how the system is configured even where they cannot change it here,
 * and a half-working editor on a stage map is worse than an honest "not from this
 * screen" — it would let somebody destroy the map with one mistyped brace.
 *
 * Two scopes, one screen: the COMPANY's configuration (admin) and the person's OWN
 * preferences (anybody, their own only). The personal block is always shown, because
 * it is the one thing on this screen every single person may change.
 */

const INK = '#141B22';
const MUTED = '#4B585C';

/** Is this a value the generic editors below can safely round-trip? */
function editorFor(decl) {
  const t = String(decl.type || '');
  if (t === 'boolean') return 'boolean';
  if (t === 'number') return 'number';
  if (t === 'enum' && Array.isArray(decl.options) && decl.options.length) return 'enum';
  // A `fieldId` is an Encompass field NUMBER and it is a string ('1401', 'CUST01FV').
  // It is also the single most likely thing a buyer has to change — their Encompass
  // is configured differently — so it must be editable, not shown as read-only JSON.
  if (t === 'fieldId' || t === 'string') return 'string';
  // A list of plain strings edits as one-per-line. A list of OBJECTS (the stage
  // ladder, the role→scope map) does not — see the header.
  if (t === 'list') return 'list';
  // A MAP is read-only here, and it is named rather than left to fall through, so
  // that the fall-through means only one thing: a type nobody has decided about.
  // A guard in scripts/test-lt-settings-screen-pure.js fails the build on one.
  if (t === 'map') return null;
  return null;
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A list is editable here only while every entry is a plain scalar. */
const plainList = (v) => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');

/**
 * The words for one option of an enum.
 *
 * The DECLARATION supplies them (`optionLabels`) when the stored value is not
 * something to show a person — `rtl` and `long_term` are keys, not English. The
 * wording lives on the server with the setting for the same reason the rest of this
 * screen does: a label kept here would be a second place to change when a buyer
 * renames something, and the two would drift.
 */
const optionLabel = (decl, o) => (decl.optionLabels && decl.optionLabels[o]) || String(o);

function SettingRow({ setting, canManage, pending, onChange, onReset }) {
  const kind = editorFor(setting);
  const value = pending !== undefined ? pending : setting.value;
  const dirty = pending !== undefined && !sameValue(pending, setting.value);
  const editable = canManage && kind && (kind !== 'list' || plainList(value));

  const label = (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: INK, fontWeight: 600, fontSize: 14 }}>{setting.label || setting.key}</div>
      <div style={{ color: MUTED, fontSize: 12, marginTop: 2, wordBreak: 'break-word' }}>
        <code style={{ fontSize: 11 }}>{setting.key}</code>
        {setting.description ? <> — {setting.description}</> : null}
      </div>
    </div>
  );

  let control = null;
  if (!editable) {
    control = (
      <pre style={{
        margin: 0, padding: '8px 10px', borderRadius: 8, background: '#F4F1EA',
        color: INK, fontSize: 12, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap',
      }}>{JSON.stringify(setting.value, null, 2)}</pre>
    );
  } else if (kind === 'boolean') {
    control = (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: INK, fontSize: 14 }}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {value === true ? 'On' : 'Off'}
      </label>
    );
  } else if (kind === 'number') {
    control = (
      <input
        className="input" type="number" step="any" value={value === null || value === undefined ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  } else if (kind === 'enum') {
    control = (
      <select className="input" value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}>
        {setting.options.map((o) => <option key={String(o)} value={String(o)}>{optionLabel(setting, o)}</option>)}
      </select>
    );
  } else if (kind === 'list') {
    control = (
      <textarea
        className="input" rows={Math.min(8, Math.max(2, (value || []).length + 1))}
        value={(value || []).join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
        placeholder="One per line"
      />
    );
  } else {
    control = (
      <input className="input" type="text" value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)} />
    );
  }

  return (
    <div className="ltset-row">
      {label}
      <div style={{ minWidth: 0, display: 'grid', gap: 6 }}>
        {control}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
          {setting.isOverridden
            ? <span style={{ color: '#8A6A22', fontWeight: 600 }}>Changed from ours</span>
            : <span style={{ color: MUTED }}>Our pre-filled value</span>}
          {dirty && <span style={{ color: '#2F7F86', fontWeight: 600 }}>Unsaved</span>}
          {canManage && setting.isOverridden && (
            <button type="button" className="btn ghost" style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={() => onReset(setting.key)}>Put back to ours</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LtSettings() {
  const [data, setData] = useState(null);
  const [mine, setMine] = useState(null);
  const [pending, setPending] = useState({});
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState({});

  const load = useCallback(async () => {
    const [company, personal] = await Promise.all([
      ltApi.settings().catch((e) => ({ error: (e && e.message) || 'Could not load the settings.' })),
      ltApi.mySettings().catch(() => ({ settings: [] })),
    ]);
    setData(company);
    setMine(personal);
    setPending({});
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirtyKeys = useMemo(() => {
    if (!data || !data.groups) return [];
    const byKey = new Map();
    for (const g of data.groups) for (const s of g.settings) byKey.set(s.key, s.value);
    return Object.keys(pending).filter((k) => !sameValue(pending[k], byKey.get(k)));
  }, [pending, data]);

  const save = async () => {
    if (!dirtyKeys.length) return;
    setBusy(true); setNote(null);
    try {
      const patch = {};
      for (const k of dirtyKeys) patch[k] = pending[k];
      await ltApi.saveSettings(patch);
      setNote({ ok: true, text: `Saved ${dirtyKeys.length} setting${dirtyKeys.length === 1 ? '' : 's'}.` });
      await load();
    } catch (e) {
      // The server NAMES the key it refused; showing its own words beats a flat
      // "could not save" on a screen of fifty fields.
      setNote({ ok: false, text: (e && e.message) || 'Could not save the settings.' });
    } finally { setBusy(false); }
  };

  const reset = async (key) => {
    setBusy(true); setNote(null);
    try {
      await ltApi.resetSettings([key]);
      setNote({ ok: true, text: 'Put back to our pre-filled value.' });
      await load();
    } catch (e) {
      setNote({ ok: false, text: (e && e.message) || 'Could not reset that setting.' });
    } finally { setBusy(false); }
  };

  const saveMine = async (key, value) => {
    setBusy(true); setNote(null);
    try {
      await ltApi.saveMySettings({ [key]: value });
      setNote({ ok: true, text: 'Your preference is saved.' });
      const personal = await ltApi.mySettings().catch(() => mine);
      setMine(personal);
    } catch (e) {
      setNote({ ok: false, text: (e && e.message) || 'Could not save your preference.' });
    } finally { setBusy(false); }
  };

  if (!data) return <LtLayout title="Long-term settings"><div className="card" style={{ color: INK }}>Loading…</div></LtLayout>;
  if (data.error) return <LtLayout title="Long-term settings"><div className="card" style={{ color: '#8A2D2D' }}>{data.error}</div></LtLayout>;

  const canManage = data.canManage === true;

  return (
    <LtLayout title="Long-term settings">
      {/* The screen SAYS what it is for. A buyer opening a list of 56 fields with no
          explanation cannot tell ours from theirs. */}
      <div className="card" style={{ color: INK, marginBottom: 14 }}>
        <p style={{ margin: '0 0 6px', lineHeight: 1.55 }}>
          Everything the long-term side assumes about your company lives here, pre-filled with our
          values. Change one and it takes effect everywhere; press <strong>Put back to ours</strong> and
          it returns to the value we shipped.
        </p>
        <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
          {canManage
            ? 'You may change these.'
            : 'You can see how the system is set up; an administrator changes it.'}
          {data.degraded ? ' — the saved values could not be read just now, so these are ours.' : ''}
        </p>
      </div>

      {mine && Array.isArray(mine.settings) && mine.settings.length > 0 && (
        <div className="card" style={{ color: INK, marginBottom: 14 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>Yours</h2>
          <p style={{ margin: '0 0 8px', color: MUTED, fontSize: 13 }}>
            Just for you. Nobody else is affected, and nobody else can change these for you.
          </p>
          {mine.settings.map((s) => (
            <div key={s.key} className="ltset-row ltset-mid">
              <div>
                <div style={{ color: INK, fontWeight: 600, fontSize: 14 }}>{s.label || s.key}</div>
                <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
                  {s.followsCompany
                    ? 'Following the company setting'
                    : `You chose this — the company setting is ${JSON.stringify(s.default)}`}
                </div>
              </div>
              <div>
                {editorFor(s) === 'enum' ? (
                  <select className="input" value={String(s.value)} disabled={busy}
                    onChange={(e) => saveMine(s.key, e.target.value)}>
                    {s.options.map((o) => <option key={String(o)} value={String(o)}>{optionLabel(s, o)}</option>)}
                  </select>
                ) : editorFor(s) === 'boolean' ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: INK }}>
                    <input type="checkbox" checked={s.value === true} disabled={busy}
                      onChange={(e) => saveMine(s.key, e.target.checked)} />
                    {s.value === true ? 'On' : 'Off'}
                  </label>
                ) : (
                  <code style={{ color: INK, fontSize: 12 }}>{JSON.stringify(s.value)}</code>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {note && (
        <div className="card" style={{
          marginBottom: 14, color: note.ok ? '#1F5F3F' : '#8A2D2D',
          borderColor: note.ok ? 'rgba(47,127,134,.35)' : 'rgba(138,45,45,.35)',
        }}>{note.text}</div>
      )}

      {canManage && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 12px', marginBottom: 12, borderRadius: 10,
          background: '#FFFFFF', border: '1px solid rgba(174,135,70,.28)',
        }}>
          <button type="button" className="btn primary" disabled={busy || !dirtyKeys.length} onClick={save}>
            {busy ? 'Saving…' : `Save${dirtyKeys.length ? ` (${dirtyKeys.length})` : ''}`}
          </button>
          {dirtyKeys.length > 0 && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setPending({})}>Discard</button>
          )}
          <span style={{ color: MUTED, fontSize: 13 }}>
            {dirtyKeys.length ? 'Unsaved changes on this screen.' : 'Everything on this screen is saved.'}
          </span>
        </div>
      )}

      {data.groups.map((g) => {
        const changed = g.settings.filter((s) => s.isOverridden).length;
        const isOpen = open[g.group] !== false;
        return (
          <div key={g.group} className="card" style={{ color: INK, marginBottom: 12 }}>
            <button type="button"
              onClick={() => setOpen((o) => ({ ...o, [g.group]: !isOpen }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none',
                border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: INK,
              }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{g.group}</span>
              <span style={{ color: MUTED, fontSize: 13 }}>{g.settings.length} setting{g.settings.length === 1 ? '' : 's'}</span>
              {changed > 0 && (
                <span style={{ color: '#8A6A22', fontSize: 12, fontWeight: 600 }}>{changed} changed from ours</span>
              )}
              <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 13 }}>{isOpen ? 'Hide' : 'Show'}</span>
            </button>
            {isOpen && g.settings.map((s) => (
              <SettingRow
                key={s.key} setting={s} canManage={canManage} pending={pending[s.key]}
                onChange={(v) => setPending((p) => ({ ...p, [s.key]: v }))}
                onReset={reset}
              />
            ))}
          </div>
        );
      })}
    </LtLayout>
  );
}
