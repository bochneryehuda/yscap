import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm, showMessage } from '../lib/dialog.js';

/* SEND IT LATER — the clock beside the send button (owner-directed 2026-08-20).

   "If somebody wants to work in the middle of the night but he wants it to go
   out in the morning, we need to add a scheduling option by the order … just add
   an additional option with the small icon, like a time to schedule the email
   instead of ordering it immediately."

   ONE CONTROL, FOUR SURFACES. The title order, the insurance order, the
   closing-prep request and the investor delivery all mount THIS — a second copy
   would drift, and the half that drifts is the half that tells somebody their
   order is queued for a time it is not.

   THE TIME IS ALWAYS NEW YORK, AND IT ALWAYS SAYS SO. The server reads what is
   typed here as New York time (its own note explains why: read in the server's
   own zone, a staffer's 8am goes out at 4am). A control that showed a bare "8:00"
   would leave a person in another state guessing which 8 o'clock they picked, so
   every time on this control is labelled ET.

   Colours are explicit darks: every `--ink*` token in this palette is a LIGHT
   paper colour and would render this white-on-white. */

const INK = '#141B22';
const MUTED = '#4B585C';

/* The NY calendar day and wall-clock time of an instant — the same two strings
   the server parses back, so what is offered and what is stored cannot disagree. */
const nyDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const nyTime = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const nyLabel = (d) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)} ET`;

/* Tomorrow at a given NY hour. Built by walking forward from now in NY rather
   than by adding 24 hours to a UTC instant, so "tomorrow 8am" is 8am on the day
   after today IN NEW YORK — which is a different day from the server's own for
   several hours every night, exactly the hours this feature is for. */
function nyTomorrowAt(hour) {
  const now = new Date();
  const [y, m, d] = nyDay(new Date(now.getTime() + 24 * 3600 * 1000)).split('-').map(Number);
  return { day: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, time: `${String(hour).padStart(2, '0')}:00` };
}
function inHours(n) {
  const at = new Date(Date.now() + n * 3600 * 1000);
  return { day: nyDay(at), time: nyTime(at) };
}

/* The presets are the owner's own case first: worked at night, wants it out in
   the morning. */
function presets() {
  return [
    { key: 'am8', label: 'Tomorrow 8:00 AM', ...nyTomorrowAt(8) },
    { key: 'am9', label: 'Tomorrow 9:00 AM', ...nyTomorrowAt(9) },
    { key: 'h2', label: 'In 2 hours', ...inHours(2) },
  ];
}

/**
 * @param onSchedule  ({day, time}) => Promise — the caller's own door, so this
 *                    component never needs to know which of the four it is
 * @param disabled    whatever disables the send button beside it
 * @param busy
 * @param what        "the title order" — used in the confirmation sentence
 */
export function ScheduleButton({ onSchedule, disabled = false, busy = false, what = 'this' }) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(() => presets()[0].day);
  const [time, setTime] = useState(() => presets()[0].time);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // What the two boxes currently mean, spelled out — the whole point of the
  // control is that nobody has to work out which 8 o'clock they picked.
  const preview = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
    const at = new Date(`${day}T${time}:00`);
    return isNaN(at.getTime()) ? null : `${new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(at)}, ${time} ET`;
  }, [day, time]);

  const pick = (p) => { setDay(p.day); setTime(p.time); setErr(null); };

  const go = useCallback(async () => {
    setErr(null); setSaving(true);
    try {
      await onSchedule({ day, time });
      setOpen(false);
    } catch (e) {
      setErr((e && e.message) || 'Could not schedule that.');
    } finally { setSaving(false); }
  }, [day, time, onSchedule]);

  return (
    <>
      <button type="button" className="btn soft small" disabled={disabled || busy}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={`Send ${what} later instead of now`}>
        <span aria-hidden="true" style={{ marginRight: 6 }}>🕐</span>Schedule…
      </button>
      {open && (
        <div className="card" style={{ marginTop: 8, padding: 12, width: '100%', maxWidth: 460, color: INK }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Send it later</div>
          <div className="small" style={{ color: MUTED, marginBottom: 10 }}>
            PILOT will send {what} at the time you pick. Nothing is written now — everything
            is checked again when it goes out, so it uses the file as it stands then.
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {presets().map((p) => (
              <button key={p.key} type="button" className="btn ghost small" onClick={() => pick(p)}>{p.label}</button>
            ))}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="small" style={{ color: MUTED }}>Date</span>
              <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="small" style={{ color: MUTED }}>Time (New York)</span>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
          {preview && (
            <div className="small" style={{ color: INK, marginTop: 8 }}>
              Goes out <strong>{preview}</strong>.
            </div>
          )}
          {err && <div className="small" style={{ color: '#B3261E', marginTop: 8 }}>{err}</div>}
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button type="button" className="btn primary small" disabled={saving || !preview} onClick={go}>
              {saving ? 'Scheduling…' : 'Schedule it'}
            </button>
            <button type="button" className="btn ghost small" disabled={saving} onClick={() => setOpen(false)}>Not now</button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * What is queued on this file, and what recently happened to it.
 *
 * A FAILURE IS SHOWN AS LOUDLY AS A PENDING SEND, and that is deliberate: the
 * whole risk of scheduling is somebody believing an order went out when it did
 * not. The server notifies the person who scheduled it too — this is the second
 * place, on the screen they are already looking at.
 */
export function ScheduledSends({ rows, onCancel, kinds = null }) {
  const list = (rows || []).filter((r) => !kinds || kinds.includes(r.kind));
  if (!list.length) return null;
  const pending = list.filter((r) => r.status === 'scheduled' || r.status === 'sending');
  const failed = list.filter((r) => r.status === 'failed');
  return (
    <div style={{ marginTop: 8 }}>
      {pending.map((r) => (
        <div key={r.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap',
          padding: '6px 10px', borderRadius: 8, background: 'var(--surface-soft)', marginBottom: 6, color: INK }}>
          <span aria-hidden="true">🕐</span>
          <span><strong>{r.label}</strong> is scheduled for <strong>{r.sendAtText}</strong>
            {r.createdByName ? <span className="small" style={{ color: MUTED }}> · set by {r.createdByName}</span> : null}
          </span>
          {onCancel && (
            <button type="button" className="btn ghost small" style={{ marginLeft: 'auto' }}
              onClick={() => onCancel(r)}>Cancel</button>
          )}
        </div>
      ))}
      {failed.map((r) => (
        <div key={r.id} style={{ padding: '8px 10px', borderRadius: 8, marginBottom: 6,
          border: '1px solid #B3261E', background: '#FFF6F5', color: INK }}>
          <div style={{ fontWeight: 700 }}>⚠️ {r.label} did NOT go out</div>
          <div className="small" style={{ color: INK }}>
            It was due {r.sendAtText}. {r.lastError || 'PILOT could not send it.'}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The file's queue, loaded and kept in step. Every surface that shows or changes
 * a scheduled send goes through this so they cannot disagree about what is armed.
 */
export function useScheduledSends(appId, deps = []) {
  const [rows, setRows] = useState([]);
  const load = useCallback(async () => {
    if (!appId) return;
    try { setRows(await api.staffScheduledSends(appId)); }
    catch (_) { /* the queue is an assist; a failed read must not break the panel */ }
  }, [appId]);
  /* THE CALLER'S DEPS ARE FOLDED INTO ONE KEY, NEVER SPREAD. React throws a hard
     error the moment a dependency list changes LENGTH between renders, and
     spreading a caller-supplied array hands that decision to the caller — every
     caller, forever. Both of today's callers happen to pass a fixed one-element
     array, so nothing misbehaves; one built from data that starts empty and fills
     would take the file screen down. Folding them makes the list exactly two
     entries by construction, and the effect still re-runs when a value changes. */
  const depKey = deps.map((d) => (d == null ? '' : String(d))).join('');
  useEffect(() => { load(); }, [load, depKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = useCallback(async (row) => {
    if (!(await askConfirm(`Cancel the scheduled ${String(row.what || row.label).toLowerCase()}? Nothing will be sent, and you can schedule it again.`))) return;
    try { await api.staffCancelScheduledSend(appId, row.id); await load(); }
    catch (e) { await showMessage((e && e.message) || 'Could not cancel that.'); }
  }, [appId, load]);
  return { rows, reload: load, cancel };
}

export default ScheduleButton;
