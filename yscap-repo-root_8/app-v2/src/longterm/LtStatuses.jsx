import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

/**
 * STATUSES — the three layers of wording, side by side, and ours are editable.
 *
 * The owner asked for the report of every file's milestone and status *"so I can
 * give you the exact mapping of what everything means. We need to rephrase this in
 * our system with our own statuses, more user-friendly."* The book screen is the
 * report; this is where the rephrasing happens.
 *
 * THREE LAYERS, AND ONLY THE MIDDLE ONE IS OURS.
 *   1. **Encompass's milestone** — the tenant's own 19. Not ours; shown as it is.
 *   2. **Our stage** — the 9 we group and sort the pipeline by. **Rename it, and
 *      re-point any milestone at a different one.** This is the whole screen.
 *   3. **What the borrower sees** — the tenant's own consumer wording, mirrored
 *      from Encompass. Read-only, because Encompass is read-only to PILOT.
 *
 * WHY THIS IS A PURPOSE-BUILT SCREEN AND NOT A BOX ON THE SETTINGS PAGE. Both
 * layers are already settings, and the settings page deliberately shows a `map`
 * READ-ONLY: a free-text editor over the milestone ladder would let one mistyped
 * brace destroy it. Here every choice is a dropdown of stages that exist, so a typo
 * is not possible — which is the answer that rule was pointing at.
 *
 * IT WRITES THROUGH THE SETTINGS DOOR. There is no second write door for this. That
 * keeps one writer, one validation and one audit trail, and it is why "Put back to
 * ours" works here for free.
 *
 * THE KEY IS NEVER EDITABLE, only the LABEL. `stage_key` is what every stored loan,
 * every saved view and every query holds; renaming a key would orphan them all,
 * while renaming a label changes only the words on our screens. That distinction is
 * the entire safety property of this screen.
 *
 * THE COUNTS ARE THE POINT. "Move Waiting for Docs from Conditions Out to In
 * Underwriting" is a different question when it is one file than when it is ninety,
 * so every row says how many files are sitting on it right now.
 *
 * Colours are explicit darks per the HARD RULE — every `--ink*` token in this
 * palette is a LIGHT paper colour and would render white-on-white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';

export default function LtStatuses() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Pending edits, held apart from the server's answer so nothing is saved by
  // typing and "Unsaved" can be shown honestly.
  const [labels, setLabels] = useState({});     // stageKey -> new label
  const [map, setMap] = useState({});           // milestone -> stageKey ('' = unmapped)

  const load = useCallback(() => {
    setErr(null);
    ltApi.statusMap()
      .then((d) => { setData(d); setLabels({}); setMap({}); })
      .catch((e) => setErr(e.message || 'Could not load the status map.'));
  }, []);
  useEffect(load, [load]);

  const canManage = !!(data && data.canManage);
  const dirty = Object.keys(labels).length > 0 || Object.keys(map).length > 0;

  const labelOf = (s) => (labels[s.key] !== undefined ? labels[s.key] : s.label);
  const stageOf = (m) => (map[m.milestone] !== undefined ? map[m.milestone] : (m.stageKey || ''));

  const save = async () => {
    if (!data || !dirty) return;
    setBusy(true);
    setNote('');
    try {
      const patch = {};

      // OUR STAGES — the same list, in the same order, with the labels replaced.
      // Sent whole rather than as a delta because the setting IS the whole list:
      // sending a partial one would silently drop every stage left out of it.
      if (Object.keys(labels).length) {
        patch[data.settingKeys.stages] = data.stages.map((s) => ({
          key: s.key, label: labelOf(s), order: s.order,
        }));
      }

      // THE MAP. Rebuilt whole from what is on screen, for the same reason — and a
      // milestone set back to "not mapped" is OMITTED rather than stored as an
      // empty string, because the reader treats a missing key and an unusable one
      // identically and an empty value would just be a slower way of saying the
      // same thing.
      if (Object.keys(map).length) {
        const next = {};
        for (const m of data.milestones) {
          const k = stageOf(m);
          if (k) next[m.milestone] = k;
        }
        patch[data.settingKeys.map] = next;
      }

      await ltApi.saveSettings(patch);
      setNote('Saved. The pipeline and the book now use these names.');
      load();
    } catch (e) {
      setNote(e.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  const putBack = async () => {
    setBusy(true);
    setNote('');
    try {
      await ltApi.resetSettings([data.settingKeys.stages, data.settingKeys.map]);
      setNote('Put back to the names we shipped with.');
      load();
    } catch (e) {
      setNote(e.message || 'Could not put that back.');
    } finally {
      setBusy(false);
    }
  };

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: MUTED, fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap' };
  const td = { padding: '9px 10px', fontSize: 14, color: INK, borderTop: '1px solid #EAE4D7', verticalAlign: 'top' };

  return (
    <LtLayout title="Statuses">
      <p style={{ margin: '0 0 14px', color: MUTED, maxWidth: 780, lineHeight: 1.55 }}>
        Encompass has its own milestones. We group them into our own stages — that middle
        column is yours to rename and re-point. What the borrower is told comes from
        Encompass and is shown here so you can see it, not to be edited.
      </p>

      {note && <div className="card" style={{ color: INK, marginBottom: 12 }}>{note}</div>}
      {err && <div className="card" style={{ color: INK }}>{err}</div>}
      {!data && !err && <div className="card" style={{ color: MUTED }}>Reading the status map…</div>}

      {data && (
        <>
          {!canManage && (
            <div className="card" style={{ color: MUTED, marginBottom: 14 }}>
              You can see the map. Only an administrator can change it.
            </div>
          )}

          {/* OUR STAGES — the rename half. */}
          <h2 style={{ fontSize: 16, color: INK, margin: '0 0 8px' }}>Our stages</h2>
          <p style={{ color: MUTED, fontSize: 13, margin: '0 0 8px', maxWidth: 720 }}>
            These are the words on our own screens — the pipeline groups and sorts by them.
            Renaming one changes nothing about the loans themselves.
          </p>
          <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: 20 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead><tr>
                <th style={th}>What we call it</th><th style={th}>Files here now</th>
              </tr></thead>
              <tbody>
                {data.stages.map((s) => (
                  <tr key={s.key}>
                    <td style={td}>
                      <input className="input" style={{ maxWidth: 320 }}
                        value={labelOf(s)} disabled={!canManage}
                        onChange={(e) => setLabels((p) => ({ ...p, [s.key]: e.target.value }))} />
                      {labels[s.key] !== undefined && labels[s.key] !== s.label && (
                        <div style={{ color: '#2F7F86', fontSize: 12, fontWeight: 600, marginTop: 4 }}>Unsaved</div>
                      )}
                    </td>
                    <td style={td}>{s.files}</td>
                  </tr>
                ))}
                {/* "Other" is not one of ours and cannot be renamed — it is where a
                    milestone nobody has mapped lands, and it is SHOWN rather than
                    hidden so an unmapped file is never invisible. */}
                <tr>
                  <td style={{ ...td, color: MUTED }}>
                    {data.unmappedStage.label} — anything not mapped below
                  </td>
                  <td style={{ ...td, color: data.unmappedStage.files ? '#8A6A17' : MUTED }}>
                    {data.unmappedStage.files}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* THE LADDER — the re-point half. */}
          <h2 style={{ fontSize: 16, color: INK, margin: '0 0 8px' }}>Encompass&rsquo;s milestones</h2>
          <p style={{ color: MUTED, fontSize: 13, margin: '0 0 8px', maxWidth: 720 }}>
            In the order Encompass runs them. Pick which of our stages each one belongs to.
          </p>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead><tr>
                <th style={th}>#</th><th style={th}>Encompass milestone</th>
                <th style={th}>Who does it</th><th style={th}>Our stage</th>
                <th style={th}>What the borrower sees</th><th style={th}>Files</th>
              </tr></thead>
              <tbody>
                {data.milestones.map((m) => {
                  const changed = map[m.milestone] !== undefined && map[m.milestone] !== (m.stageKey || '');
                  return (
                    <tr key={m.milestone}>
                      <td style={{ ...td, color: MUTED }}>{m.sequence == null ? '—' : m.sequence}</td>
                      <td style={{ ...td, fontWeight: 600 }}>
                        {m.milestone}
                        {/* A milestone on real loans that the published ladder does not
                            carry. It is real and it needs an answer, so it is listed
                            rather than quietly left out of the one screen for this. */}
                        {!m.inCatalog && (
                          <div style={{ color: '#8A6A17', fontSize: 12, marginTop: 2 }}>
                            On live files, not in the Encompass ladder
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, color: MUTED, fontSize: 13 }}>{m.role || '—'}</td>
                      <td style={td}>
                        <select className="input" style={{ maxWidth: 220 }}
                          value={stageOf(m)} disabled={!canManage}
                          onChange={(e) => setMap((p) => ({ ...p, [m.milestone]: e.target.value }))}>
                          <option value="">Not mapped ({data.unmappedStage.label})</option>
                          {data.stages.map((s) => (
                            <option key={s.key} value={s.key}>{labelOf(s)}</option>
                          ))}
                        </select>
                        {changed && (
                          <div style={{ color: '#2F7F86', fontSize: 12, fontWeight: 600, marginTop: 4 }}>Unsaved</div>
                        )}
                      </td>
                      <td style={{ ...td, color: MUTED, fontSize: 13 }}>
                        {m.borrowerWording || <span title="Encompass has no client wording for this milestone.">—</span>}
                      </td>
                      <td style={td}>{m.files}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {canManage && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 14 }}>
              <button className="btn" onClick={save} disabled={busy || !dirty}>
                {busy ? 'Saving…' : dirty ? 'Save these names' : 'Nothing to save'}
              </button>
              <button className="btn ghost" onClick={putBack} disabled={busy}
                title="Back to the stages and mapping we shipped with.">
                Put back to ours
              </button>
              <span style={{ color: MUTED, fontSize: 13 }}>{data.note}</span>
            </div>
          )}
        </>
      )}
    </LtLayout>
  );
}
