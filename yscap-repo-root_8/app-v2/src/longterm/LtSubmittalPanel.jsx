import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { GOLD_TEXT } from './ppeStyles.js';
import { stamp } from './format.js';

/**
 * PRIOR TO SUBMITTAL — COMPLETED (owner-directed 2026-09-02).
 *
 * *"After the bunch of prior to submittal conditions there should be an
 * option of a button that a loan officer can click — Prior to submittal
 * completed — nicely designed. And it should come up over there outstanding
 * what else he needs to do to complete … Everything that he clicks Done goes
 * down this list, and then he can click Complete Prior to Submittal."*
 *
 * ── WHAT IS ACTUALLY HERE ───────────────────────────────────────────────────
 * A card under the bucket's heading: a progress bar, the outstanding list —
 * each item with what still blocks it, in the SERVER'S words (the same
 * sign-off rules the back office uses), and a button that opens the condition
 * — and the one button. The button is disabled until nothing is outstanding,
 * and it says why. Once complete: who, when, and the ClickUp state — filled,
 * owed (no card linked yet, or the writer is off), or failed with a by-hand
 * retry. The orders (title, insurance, the VOR) are shown as the loan-setup
 * desk's, by the owner's own list, so nobody looks for them on this list.
 *
 * NOTHING IS DECIDED HERE. The list, the readiness and the stamp all come from
 * `/api/lt/condition-center/loans/:id/submittal`; this screen only draws them
 * and re-reads after every action. A blocker sentence is the server's — never
 * rewritten — because it names what to do next.
 *
 * DARK TEXT ON WHITE, ALWAYS: explicit hexes, never an `--ink*` token.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GREEN = '#1F6F43';
const AMBER = '#8A5B00';
const RED = '#8A2D2D';
const PAPER = '#FBF9F4';

const eyebrow = {
  fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
  color: GOLD_TEXT, fontWeight: 700,
};

function Bar({ done, total }) {
  const filled = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div aria-label={`${done} of ${total} done`} style={{ height: 8, borderRadius: 999, background: '#ECE7DB', overflow: 'hidden' }}>
      <div style={{ width: `${filled}%`, height: '100%', background: filled === 100 ? GREEN : GOLD_TEXT, transition: 'width .3s ease' }} />
    </div>
  );
}

function ClickupLine({ clickup, onRetry, busy }) {
  if (!clickup) return null;
  const card = clickup.customId || (clickup.taskId ? `card ${clickup.taskId}` : null);
  if (clickup.pushedAt) {
    return (
      <div style={{ fontSize: 13, color: GREEN, lineHeight: 1.55 }}>
        ✓ ClickUp: <strong>Prior to submittal conditions → Completed</strong>
        {card && <> on {clickup.url ? <a href={clickup.url} target="_blank" rel="noreferrer" style={{ color: GREEN }}>{card}</a> : card}</>}
        {' '}· {stamp(clickup.pushedAt)}
      </div>
    );
  }
  if (!clickup.taskId) {
    return (
      <div style={{ fontSize: 13, color: AMBER, lineHeight: 1.55 }}>
        ClickUp: no card is linked to this file yet. The completion is recorded here and the card’s
        “Prior to submittal conditions” is set to Completed by itself once one is linked.
      </div>
    );
  }
  return (
    <div style={{ fontSize: 13, color: AMBER, lineHeight: 1.55 }}>
      ClickUp: not on the card yet{clickup.error ? ` — ${clickup.error}` : ''}. The sync retries on its own;{' '}
      <button type="button" className="btn ghost small" disabled={busy} onClick={onRetry} style={{ marginLeft: 4 }}>
        {busy ? 'Trying…' : 'Try the card now'}
      </button>
    </div>
  );
}

export default function LtSubmittalPanel({ loanId, onOpenCondition, onChanged, refreshKey }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    return ltApi.submittalReadiness(loanId)
      .then(setData)
      .catch((e) => setErr((e && e.message) || 'Could not read the prior-to-submittal list just now.'));
  }, [loanId]);
  // Re-read whenever the conditions list above changes — a Done click, an
  // upload, a contact linked — so this list moves the moment the work does.
  useEffect(() => { load(); }, [load, refreshKey]);

  const complete = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const out = await ltApi.submittalComplete(loanId);
      setNote(out.already
        ? 'This file was already declared complete.'
        : (out.clickup && out.clickup.pushedAt
          ? 'Prior to submittal completed — and the ClickUp card says so.'
          : 'Prior to submittal completed. The ClickUp card is told next.'));
      await load();
      if (onChanged) await onChanged();
    } catch (e) {
      // THE SERVER'S OWN WORDS: its refusal names what is still outstanding.
      setErr((e && (e.error || e.message)) || 'That could not be completed.');
      await load();
    } finally { setBusy(false); }
  };

  const retry = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const out = await ltApi.submittalPushClickup(loanId);
      setNote(out.ok
        ? (out.push && out.push.skipped === 'already_completed' ? 'The card already said Completed.' : 'The ClickUp card now says Completed.')
        : `Not on the card yet — ${(out.push && out.push.reason) || 'it did not go through'}.`);
      await load();
    } catch (e) {
      setErr((e && (e.error || e.message)) || 'That did not work.');
    } finally { setBusy(false); }
  };

  if (err && !data) return <p style={{ margin: '8px 0 0', fontSize: 13, color: RED }}>{err}</p>;
  if (!data) return <p style={{ margin: '8px 0 0', fontSize: 13, color: MUTED }}>Reading what is left before submittal…</p>;

  const items = data.items || [];
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const completed = data.completed;

  return (
    <div style={{ margin: '10px 0 14px', border: `1px solid ${completed ? '#CFE3D5' : LINE}`, borderRadius: 12,
      background: completed ? '#F3FAF5' : PAPER, padding: '14px 16px' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={eyebrow}>Prior to submittal — the loan officer’s part</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginTop: 2 }}>
            {completed
              ? 'Completed'
              : (open.length === 0
                ? 'Everything on this list is done — ready to complete'
                : `${open.length} of ${items.length} still to do`)}
          </div>
          <div style={{ marginTop: 8 }}><Bar done={done.length} total={items.length} /></div>
        </div>

        {completed ? (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, color: GREEN, lineHeight: 1 }}>✓</div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
              by <strong style={{ color: INK }}>{completed.byName || 'a member of staff'}</strong> · {stamp(completed.at)}
            </div>
          </div>
        ) : (
          <button type="button" className="btn primary" disabled={busy || !data.ready}
            title={data.ready
              ? 'Records that the prior-to-submittal conditions are complete, and sets the ClickUp card’s “Prior to submittal conditions” to Completed so the file moves up for a faster submission.'
              : 'Enabled once nothing on the list below is outstanding.'}
            onClick={complete}
            style={{ fontSize: 14, padding: '10px 16px', opacity: data.ready ? 1 : 0.55 }}>
            {busy ? 'Completing…' : 'Complete prior to submittal ✓'}
          </button>
        )}
      </div>

      {data.degraded && (
        <p style={{ margin: '10px 0 0', fontSize: 13, color: RED, lineHeight: 1.55 }}>
          Some of this file could not be read just now ({data.degraded}), so this list is not the whole picture.
        </p>
      )}

      {/* THE OUTSTANDING LIST — each with what still blocks it, the server's
          words, and a way to the condition itself. */}
      {open.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...eyebrow, color: MUTED }}>Still to do</div>
          <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 6 }}>
            {open.map((i) => (
              <li key={i.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px',
                background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 8 }}>
                <span aria-hidden="true" style={{ width: 16, height: 16, marginTop: 2, borderRadius: 4, border: `2px solid ${AMBER}`, flex: '0 0 auto' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{i.label}</div>
                  <ul style={{ margin: '2px 0 0', paddingLeft: 16, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
                    {(i.blockers || []).map((b, n) => <li key={n}>{b}</li>)}
                  </ul>
                </div>
                {onOpenCondition && (
                  <button type="button" className="btn ghost small" onClick={() => onOpenCondition(i.id)}>Open</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* DONE GOES DOWN THE LIST — kept in view, ticked, so the officer sees the
          whole shape of the work rather than a shrinking list. */}
      {done.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...eyebrow, color: MUTED }}>Done</div>
          <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {done.map((i) => (
              <li key={i.id} title={i.how || ''} style={{ fontSize: 12.5, color: GREEN, padding: '3px 9px',
                background: '#FFFFFF', border: '1px solid #CFE3D5', borderRadius: 999 }}>
                ✓ {i.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* THE ORDERS ARE THE LOAN-SETUP DESK'S — said, so nobody hunts for them here. */}
      {(data.orders || []).length > 0 && (
        <p style={{ margin: '10px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
          Not on this list, by design — the orders are loan setup’s to place after the hand-over:{' '}
          {data.orders.map((o) => o.label).join(', ')}.
        </p>
      )}

      {completed && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #CFE3D5' }}>
          <ClickupLine clickup={data.clickup} onRetry={retry} busy={busy} />
          {open.length > 0 && (
            <p style={{ margin: '6px 0 0', fontSize: 12.5, color: AMBER, lineHeight: 1.5 }}>
              Since it was completed, {open.length} item{open.length === 1 ? ' has' : 's have'} come back open — see above.
            </p>
          )}
        </div>
      )}

      {note && <p style={{ margin: '10px 0 0', fontSize: 13, color: INK, lineHeight: 1.55 }}>{note}</p>}
      {err && <p role="alert" style={{ margin: '10px 0 0', fontSize: 13, color: RED, lineHeight: 1.55 }}>{err}</p>}
    </div>
  );
}
