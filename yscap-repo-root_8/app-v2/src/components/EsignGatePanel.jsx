import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/* The CLEAR VIEW on a send-before-clear-to-close exception (owner-directed
 * 2026-07-24): every send requirement with a live ✓ (done) or ✗ (outstanding),
 * so the reviewing super-admin — and the requester — see the WHOLE picture, not
 * just the misses. In selectable mode (an open request being decided by a
 * super-admin) each outstanding requirement gets a "Waive this" checkbox:
 * readiness-tier items start checked, term-sheet-CORRECTNESS (floor) items start
 * UNCHECKED and show a loud consequence warning when ticked. Everything left
 * unchecked stays required — "I'm waiving this, but you still need to complete
 * these." On a decided exception the panel shows which items the approval waived.
 *
 * Selection state lives in the PARENT (StaffExceptions) so the decide buttons —
 * rendered outside this panel — can submit it. The server re-validates against
 * the live gate either way; this panel is presentation + selection only. */

export default function EsignGatePanel({ exceptionId, status, select }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const initedFor = useRef(null);   // exceptionId we already initialized defaults for

  useEffect(() => {
    let dead = false;
    setData(null); setErr('');
    api.exceptionGate(exceptionId)
      .then((d) => { if (!dead) setData(d); })
      .catch((e) => { if (!dead) setErr((e && e.message) || 'Could not load the requirements picture.'); });
    return () => { dead = true; };
  }, [exceptionId, status]);

  // Selectable mode: initialize the parent's selection ONCE per exception with
  // the safe default — readiness (ctc) blockers pre-checked, floor blockers NOT.
  useEffect(() => {
    if (!data || !select || !select.onChange) return;
    if (initedFor.current === exceptionId || select.selected != null) { initedFor.current = exceptionId; return; }
    const outstanding = (data.live && data.live.outstanding) || [];
    select.onChange(outstanding.filter((o) => o.tier === 'ctc').map((o) => o.code));
    initedFor.current = exceptionId;
  }, [data, select, exceptionId]);

  if (err) return <div className="notice err" style={{ marginTop: 10 }}>{err}</div>;
  if (!data) return <p className="muted small" style={{ marginTop: 10 }}>Loading the requirements picture…</p>;

  const live = data.live || {};
  const checks = live.checks || [];
  const waivedCodes = data.waivedCodes || [];
  const selectable = !!(select && select.onChange && data.canDecide);
  const selected = new Set(select && Array.isArray(select.selected) ? select.selected : []);
  const toggle = (code) => {
    const next = new Set(selected);
    if (next.has(code)) next.delete(code); else next.add(code);
    select.onChange([...next]);
  };
  const requestedAt = data.requestSnapshot && data.requestSnapshot.at;

  return (
    <div style={{ marginTop: 10, padding: 10, background: 'var(--ink-2, #f4f2ec)', border: '1px solid var(--line, #e4e0d6)', borderRadius: 8 }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong className="small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Send requirements — done vs. outstanding</strong>
        <div className="spacer" />
        {live.ready
          ? <span className="ts-badge ok">Everything is done</span>
          : <span className="ts-badge warn">{(live.outstanding || []).length} outstanding</span>}
      </div>
      {requestedAt ? (
        <div className="muted small" style={{ marginTop: 2 }}>
          Live picture (re-checked just now). The request was made {new Date(requestedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.
        </div>
      ) : null}

      <ul className="esign-gate" style={{ marginTop: 8 }}>
        {checks.map((c) => {
          const isWaived = c.ok ? false : (data.status !== 'requested' && waivedCodes.includes(c.code));
          const checkedHere = selectable && !c.ok && selected.has(c.code);
          return (
            <li key={c.code} className={c.ok || isWaived ? 'ok' : 'bad'}>
              <span className="esign-gate-ic">{c.ok ? '✓' : isWaived ? '✓' : '✗'}</span>{' '}
              <strong>{c.label}</strong>
              {c.ok ? (
                <span className="muted small"> — done</span>
              ) : (
                <>
                  {' '}— <span className="muted small">{c.reason}</span>
                  {c.tier === 'floor' ? <span className="ts-badge warn" style={{ marginLeft: 6 }} title="This requirement makes the signed term sheet itself correct.">term-sheet correctness</span> : null}
                  {isWaived ? <span className="ts-badge ok" style={{ marginLeft: 6 }}>waived by this exception</span> : null}
                  {data.status !== 'requested' && waivedCodes.length > 0 && !isWaived ? <span className="ts-badge warn" style={{ marginLeft: 6 }}>still required</span> : null}
                  {selectable ? (
                    <div style={{ marginTop: 4 }}>
                      <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={checkedHere} onChange={() => toggle(c.code)} />
                        Waive this requirement for the send
                      </label>
                      {checkedHere && c.waiveWarning ? (
                        <div className="notice err" style={{ marginTop: 4, padding: '6px 8px' }}>
                          <strong>Careful:</strong> {c.waiveWarning}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>

      {selectable ? (
        <div className="muted small" style={{ marginTop: 6 }}>
          {selected.size
            ? <>Approving will waive <strong>{selected.size}</strong> requirement{selected.size === 1 ? '' : 's'} for the send. Everything left unchecked <strong>still applies</strong> — the team must complete it before the package can go out.</>
            : <>Tick the requirement(s) you are waiving. Everything unchecked still applies. (Approve needs at least one.)</>}
        </div>
      ) : null}
    </div>
  );
}
