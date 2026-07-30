import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { readToolState, writeToolState } from '../lib/tool-scenario-state.js';

/* SAVED SCENARIOS for an Investor Suite tool (owner-directed 2026-07-30).
 *
 * "they can save themselves scenarios … Give a name for the scenario and then we
 *  should have a scenario with all the scenarios that they price and they can pick
 *  up from every any scenario … And you can anytime reopen the tool from where he
 *  left off."
 *
 * Sits in the full-screen tool header. The tool itself is untouched — this reads and
 * restores its working state through the same-origin frame window that
 * StaticToolFrame hands us (see lib/tool-scenario-state.js for why two of the tools
 * need their own accessor).
 *
 * A scenario is the staffer's PRIVATE scratchpad: it is not attached to a loan file
 * and can never register or price one.
 */
export default function ToolScenarioBar({ slug, toolName, getWin, onCountChange }) {
  const [list, setList] = useState([]);
  const [showList, setShowList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);       // {kind:'ok'|'err', text}
  const noteTimer = useRef(null);

  const flash = useCallback((kind, text) => {
    setNote({ kind, text });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    // An error stays put — it usually needs an action. Success clears itself.
    if (kind === 'ok') noteTimer.current = setTimeout(() => setNote(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.toolScenarios(slug);
      const rows = (r && r.scenarios) || [];
      setList(rows);
      if (onCountChange) onCountChange(slug, rows.length);
    } catch (_) { /* the list is a convenience; never block the tool on it */ }
  }, [slug, onCountChange]);

  useEffect(() => { refresh(); return () => { if (noteTimer.current) clearTimeout(noteTimer.current); }; }, [refresh]);

  const save = async () => {
    const win = getWin && getWin();
    if (!win) return flash('err', 'The tool is still loading — give it a second and try again.');
    const read = readToolState(win);
    if (!read) return flash('err', "Couldn't read this tool's numbers. Reload the tool and try again.");

    const raw = window.prompt(`Name this ${toolName} scenario — you'll find it under "My scenarios".`, '');
    if (raw == null) return;                                  // cancelled
    const name = String(raw).trim();
    if (!name) return flash('err', 'A scenario needs a name so you can find it again.');

    const existing = list.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
    if (existing && !window.confirm(`You already have a scenario called "${existing.name}". Replace it with what's on screen now?`)) return;

    setBusy(true);
    try {
      await api.saveToolScenario({ toolSlug: slug, name, state: read.state, stateKind: read.kind });
      await refresh();
      flash('ok', existing ? `Replaced "${name}".` : `Saved "${name}".`);
    } catch (e) {
      flash('err', (e && e.detail) || (e && e.message) || "Couldn't save that scenario.");
    } finally { setBusy(false); }
  };

  const openScenario = async (row) => {
    const win = getWin && getWin();
    if (!win) return flash('err', 'The tool is still loading — give it a second and try again.');
    setBusy(true);
    try {
      const r = await api.toolScenario(row.id);
      const sc = r && r.scenario;
      if (!sc || !sc.state) throw new Error('That scenario has no saved numbers.');
      const ok = writeToolState(win, sc.state, sc.stateKind);
      if (!ok) throw new Error("This tool couldn't take that scenario back. It may have been saved by an older version.");
      setShowList(false);
      flash('ok', `Opened "${sc.name}".`);
    } catch (e) {
      flash('err', (e && e.detail) || (e && e.message) || "Couldn't open that scenario.");
    } finally { setBusy(false); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete the scenario "${row.name}"? This can't be undone.`)) return;
    setBusy(true);
    try { await api.deleteToolScenario(row.id); await refresh(); flash('ok', `Deleted "${row.name}".`); }
    catch (e) { flash('err', (e && e.detail) || "Couldn't delete that scenario."); }
    finally { setBusy(false); }
  };

  const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch (_) { return ''; } };

  return (
    <div className="tsb-wrap" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
      {note && (
        <span style={{
          fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 100, maxWidth: 340,
          color: note.kind === 'ok' ? '#256168' : '#8A3A2E',
          background: note.kind === 'ok' ? 'rgba(47,127,134,.10)' : 'rgba(201,138,106,.14)',
          border: `1px solid ${note.kind === 'ok' ? 'rgba(47,127,134,.35)' : 'rgba(201,138,106,.45)'}`,
        }}>{note.text}</span>
      )}
      <button type="button" className="btn ghost small" onClick={save} disabled={busy}
        title="Save what's on screen now as a named scenario you can come back to">Save scenario</button>
      <button type="button" className="btn ghost small" onClick={() => setShowList((v) => !v)} disabled={busy}
        aria-expanded={showList}
        title={`Your saved ${toolName} scenarios`}>My scenarios{list.length ? ` (${list.length})` : ''}</button>

      {showList && (
        <div role="dialog" aria-label={`Saved ${toolName} scenarios`} style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 40, width: 380, maxHeight: 420,
          overflowY: 'auto', background: '#FFFFFF', border: '1px solid #E6E0D2', borderRadius: 12,
          boxShadow: '0 12px 32px rgba(20,27,34,.16)', padding: 10,
        }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.1em', color: '#4B585C', padding: '2px 4px 8px' }}>
            {toolName} — saved scenarios
          </div>
          {!list.length && (
            <div style={{ fontSize: 13, color: '#4B585C', padding: '6px 4px 8px' }}>
              Nothing saved yet. Fill this tool in, then press <strong>Save scenario</strong>.
            </div>
          )}
          {list.map((row) => (
            <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 4px', borderTop: '1px solid #F0EBDF' }}>
              <button type="button" onClick={() => openScenario(row)} disabled={busy}
                style={{
                  flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none',
                  cursor: 'pointer', padding: 0, font: 'inherit',
                }}
                title="Open this scenario in the tool">
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#141B22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</div>
                <div style={{ fontSize: 11.5, color: '#4B585C' }}>{toolName} · {when(row.updatedAt)}</div>
              </button>
              <button type="button" className="btn ghost small" onClick={() => remove(row)} disabled={busy}
                aria-label={`Delete ${row.name}`} title="Delete this scenario">Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
