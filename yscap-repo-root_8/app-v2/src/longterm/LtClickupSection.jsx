import React, { useCallback, useEffect, useState } from 'react';
import { day } from './format.js';
import { ltApi } from './api.js';

/**
 * The ClickUp SYNCING section of one long-term file (#36, owner-directed
 * 2026-08-23): *"Every feature that we build up that should happen
 * automatically, we should have the option over there."*
 *
 * Everything here is DRAWN FROM THE SERVER's /api/lt/clickup answer and every
 * button presses a server door that runs the guarded writer — this screen
 * decides nothing about what may be written. Confirmations are INLINE two-step
 * buttons (the ReassignControl pattern): Long-Term may not import RTL's dialog
 * library, and a browser confirm is banned portal-wide.
 *
 * Colours are explicit darks — every `--ink*` token in this palette is LIGHT.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';
const RED = '#8A2D2D';

const REASON_WORDS = {
  pii_overwrite_blocked: 'The card already holds a DIFFERENT value for this identity field — overwriting it needs a person.',
  dob_change_blocked_pending_review: 'Changing a date of birth always needs a person to approve it.',
};

function SwitchLine({ switches }) {
  if (!switches) return null;
  const bits = [];
  if (!switches.configured) bits.push(['ClickUp is not connected', RED]);
  else if (switches.dryRun) bits.push(['REHEARSING (dry run) — plans are logged, nothing is sent', '#8A6A22']);
  else if (switches.writeEnabled) bits.push(['The writer is ON — changes are pushed automatically', '#1F5F3F']);
  else bits.push(['The writer is OFF — nothing is sent until it is switched on', '#8A6A22']);
  return (
    <div style={{ fontSize: 12, marginTop: 6 }}>
      {bits.map(([t, c]) => <span key={t} style={{ color: c, fontWeight: 600 }}>{t}</span>)}
      <span style={{ color: MUTED }}> · New cards are created for files discovered on/after {switches.createSince}. This button can also create one by hand for an older file.</span>
    </div>
  );
}

/** A button that asks once, inline, before firing — never a browser confirm. */
function ArmedButton({ label, confirmLabel, className = 'btn', style, disabled, onFire }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={className} disabled={disabled || busy}
      style={{ ...(style || {}), ...(armed ? { borderColor: GOLD, fontWeight: 700 } : {}) }}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false); setBusy(true);
        Promise.resolve(onFire()).finally(() => setBusy(false));
      }}>
      {busy ? 'Working…' : armed ? (confirmLabel || `Yes — ${label}`) : label}
    </button>
  );
}

function LinkCard({ data, loanId, notice, act, reload }) {
  const link = (data && data.link) || {};
  const canAdmin = !!(data && data.canAdmin);
  const [taskId, setTaskId] = useState('');
  const [needsConfirm, setNeedsConfirm] = useState(null);

  const doLink = (confirm) => act(async () => {
    await ltApi.clickupLink(loanId, taskId.trim(), confirm);
    setTaskId(''); setNeedsConfirm(null);
    await reload();
    return 'Linked. The next sync pass fills the card in.';
  }, (e) => {
    if (e && e.data && e.data.needsConfirm) { setNeedsConfirm(e.message); return true; }
    return false;
  });

  if (link.taskId) {
    return (
      <div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ fontWeight: 700, color: INK }}>
            {link.customId || link.taskId}
          </span>
          {link.url ? (
            <a href={link.url} target="_blank" rel="noreferrer" style={{ color: TEAL, fontSize: 13 }}>
              Open the card in ClickUp →
            </a>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
          Linked {day(link.linkedAt)}{link.source ? ` · found by ${link.source === 'manual' ? 'hand' : link.source}` : ''}
          {link.confidence && link.confidence !== 'confirmed' ? ` · ${link.confidence} — not written to until confirmed` : ''}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
          {link.stampedAt ? `File ID stamped on the card ${day(link.stampedAt)}` : 'The card has not been stamped with this file’s ID yet — the stamp pass does that on its own.'}
          {link.pushedAt ? ` · Last full push ${day(link.pushedAt)}` : ' · Never fully pushed yet'}
        </div>
        {link.pushError ? (
          <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>Last problem: {link.pushError}</div>
        ) : null}
        {link.stampError ? (
          <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>Stamp problem: {link.stampError}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div style={{ color: INK, fontWeight: 600 }}>No ClickUp card is linked to this file yet.</div>
      <p style={{ margin: '4px 0 8px', fontSize: 13, color: MUTED }}>
        The sync links cards on its own when the loan numbers match. You can also create a brand-new
        card, or paste a card&rsquo;s id to tie it to this file by hand.
      </p>
      {canAdmin ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <ArmedButton label="Create New Task" confirmLabel="Yes — create the card"
            onFire={() => act(async () => {
              const out = await ltApi.clickupCreate(loanId);
              await reload();
              return out && out.dryRun ? 'Rehearsed — dry run is on, nothing was created.' : 'The card was created in the officer’s folder.';
            })} />
          <span style={{ color: MUTED, fontSize: 12 }}>or</span>
          <input className="input" value={taskId} placeholder="ClickUp task id (from the card’s URL)"
            onChange={(e) => { setTaskId(e.target.value); setNeedsConfirm(null); }}
            style={{ width: 240 }} />
          <button type="button" className="btn ghost" disabled={!taskId.trim()}
            onClick={() => doLink(false)}>Link this card</button>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: MUTED }}>Creating or linking a card is an administrator action.</div>
      )}
      {needsConfirm ? (
        <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: '#FBF4E8', color: INK, fontSize: 13 }}>
          {needsConfirm}
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn" onClick={() => doLink(true)}>I am sure — link it anyway</button>
          </div>
        </div>
      ) : null}
      {notice}
    </div>
  );
}

function PlanTable({ data, loanId, act, compare, onCompare }) {
  const fields = (data && data.plan && data.plan.fields) || [];
  const cmp = (data && data.compare && data.compare.fields) || null;
  const cmpByKey = cmp ? new Map(cmp.map((f) => [f.key, f])) : null;
  const linked = !!(data && data.link && data.link.taskId);
  const filled = fields.filter((f) => f.value != null && f.value !== '');
  const [showEmpty, setShowEmpty] = useState(false);
  const rows = showEmpty ? fields : filled;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <ArmedButton label="Push everything now" confirmLabel="Yes — push the whole card"
          disabled={!linked}
          onFire={() => act(async () => {
            const out = await ltApi.clickupPush(loanId);
            return out && out.plan && out.plan.length
              ? `Rehearsed (dry run): ${out.plan.length} change(s) would be sent.`
              : `Pushed — ${out.wrote || 0} written, ${out.suppressed || 0} already matched, ${out.blocked || 0} held for review.`;
          })} />
        {linked ? (
          <button type="button" className="btn ghost" onClick={onCompare}>
            {compare ? 'Refresh the comparison' : 'Check against the card'}
          </button>
        ) : null}
        <button type="button" className="btn ghost" style={{ fontSize: 12 }}
          onClick={() => setShowEmpty((v) => !v)}>
          {showEmpty ? 'Hide empty fields' : `Show all ${fields.length} fields`}
        </button>
        <span style={{ fontSize: 12, color: MUTED }}>
          {filled.length} of {fields.length} fields hold a value
          {data && data.plan && data.plan.liveFieldsRead ? ` · ${data.plan.liveFieldsRead} read live from Encompass` : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em' }}>
              <th style={{ padding: '4px 8px 4px 0' }}>ClickUp field</th>
              <th style={{ padding: '4px 8px' }}>PILOT holds</th>
              {cmpByKey ? <th style={{ padding: '4px 8px' }}>On the card</th> : null}
              <th style={{ padding: '4px 0 4px 8px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const c = cmpByKey ? cmpByKey.get(f.key) : null;
              const differs = c && c.same === false;
              return (
                <tr key={f.key} style={{ borderTop: '1px solid rgba(20,27,34,.07)' }}>
                  <td style={{ padding: '5px 8px 5px 0', color: MUTED, whiteSpace: 'nowrap' }}>{f.name}</td>
                  <td style={{ padding: '5px 8px', color: INK, fontWeight: 600 }}>{f.value == null || f.value === '' ? '—' : String(f.value)}</td>
                  {cmpByKey ? (
                    <td style={{ padding: '5px 8px', color: differs ? '#8A6A22' : INK }}>
                      {c ? (c.card == null || c.card === '' ? '—' : String(c.card)) : '—'}
                      {c && c.same === true ? <span style={{ color: '#1F5F3F', fontSize: 11 }}> · matches</span> : null}
                      {differs ? <span style={{ fontSize: 11 }}> · differs</span> : null}
                    </td>
                  ) : null}
                  <td style={{ padding: '5px 0 5px 8px', textAlign: 'right' }}>
                    {f.value != null && f.value !== '' && linked ? (
                      <button type="button" className="btn ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => act(async () => {
                          const out = await ltApi.clickupPushField(loanId, f.key);
                          return out && out.plan && out.plan.length
                            ? 'Rehearsed (dry run) — nothing sent.'
                            : out.blocked ? 'Held for review — see “Held for a person” below.'
                              : out.wrote ? `Pushed “${f.name}”.` : 'The card already holds this value.';
                        })}>Push</button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data && data.compare && data.compare.status ? (
        <div style={{ marginTop: 8, fontSize: 13, color: INK }}>
          <span style={{ color: MUTED }}>Card status </span>
          <strong>{data.compare.status.current || '—'}</strong>
          {data.compare.status.desired && String(data.compare.status.desired).toLowerCase() !== String(data.compare.status.current || '').toLowerCase() ? (
            <span style={{ color: '#8A6A22' }}> · Encompass says it should be <strong>{data.compare.status.desired}</strong> — the next full push moves it ({data.compare.status.reason})</span>
          ) : data.compare.status.desired ? (
            <span style={{ color: '#1F5F3F' }}> · matches what Encompass says</span>
          ) : null}
        </div>
      ) : null}
      {data && data.compare && data.compare.error ? (
        <div style={{ marginTop: 8, fontSize: 12, color: RED }}>{data.compare.error}</div>
      ) : null}
      {data && data.plan && data.plan.coBorrower && data.plan.coBorrower.present ? (
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
          Co-borrower {data.plan.coBorrower.name}: a full push keeps their own subtask under the card.
          {data.compare && data.compare.subtask ? (data.compare.subtask.found ? ' The subtask is on the card.' : ' The subtask has not been created yet — the next full push creates it.') : ''}
        </div>
      ) : null}
    </div>
  );
}

function Reviews({ data, loanId, act, reload }) {
  const open = (data && data.reviews && data.reviews.open) || [];
  const decided = (data && data.reviews && data.reviews.decided) || [];
  if (!open.length && !decided.length) {
    return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>Nothing is waiting on a person. When the sync is about to overwrite an identity field (a name, a Social, a date of birth) it stops and asks here instead.</p>;
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {open.map((r) => (
        <div key={r.id} style={{ padding: 10, borderRadius: 8, background: '#FBF4E8' }}>
          <div style={{ fontWeight: 700, color: INK, fontSize: 13 }}>{String(r.field_key).replace(/_/g, ' ')}</div>
          <div style={{ fontSize: 13, color: INK, marginTop: 2 }}>
            The card holds <strong>{r.current_value || '—'}</strong>; PILOT wants to write <strong>{r.proposed_value || '—'}</strong>.
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {REASON_WORDS[r.reason] || r.reason} · raised {day(r.created_at)}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <ArmedButton label="Approve — write PILOT’s value" confirmLabel="Yes — overwrite the card"
              onFire={() => act(async () => {
                const out = await ltApi.clickupReview(loanId, r.id, 'approve');
                await reload();
                return out && out.dryRun ? 'Rehearsed — dry run is on; the review stays open.' : 'Approved and written to the card.';
              })} />
            <ArmedButton label="Keep the card as it is" confirmLabel="Yes — keep the card’s value"
              className="btn ghost"
              onFire={() => act(async () => {
                await ltApi.clickupReview(loanId, r.id, 'reject');
                await reload();
                return 'Kept — nothing was written.';
              })} />
          </div>
        </div>
      ))}
      {decided.length ? (
        <div style={{ fontSize: 12, color: MUTED }}>
          Recently decided: {decided.map((r) => `${String(r.field_key).replace(/_/g, ' ')} — ${r.status}`).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

function Journal({ data }) {
  const rows = (data && data.journal) || [];
  const statusMoves = rows.filter((r) => r.field_key === '__status');
  const fieldRows = rows.filter((r) => r.field_key !== '__status' && r.field_key !== '__card');
  if (!rows.length) {
    return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>Nothing has been written to ClickUp for this file yet.</p>;
  }
  const show = (v) => {
    if (v == null || v === '') return '—';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {statusMoves.length ? (
        <div>
          <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            Status changes pushed to ClickUp
          </div>
          {statusMoves.map((r) => (
            <div key={r.id} style={{ fontSize: 13, color: INK, padding: '4px 0', borderTop: '1px solid rgba(20,27,34,.07)' }}>
              {day(r.created_at)} — {r.blocked ? 'could not move' : 'moved'} the card
              {r.old_value ? <> from <strong>{show(r.old_value)}</strong></> : null}
              {' '}to <strong style={{ color: r.blocked ? '#8A6A22' : TEAL }}>{show(r.new_value)}</strong>
              {r.blocked ? ' (that status is not on the card’s list)' : ''}
            </div>
          ))}
        </div>
      ) : null}
      <div>
        <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
          Field writes (newest first)
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {fieldRows.slice(0, 25).map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid rgba(20,27,34,.07)' }}>
                  <td style={{ padding: '4px 8px 4px 0', color: MUTED, whiteSpace: 'nowrap' }}>{day(r.created_at)}</td>
                  <td style={{ padding: '4px 8px', color: INK, whiteSpace: 'nowrap' }}>{String(r.field_key).replace(/_/g, ' ')}</td>
                  <td style={{ padding: '4px 8px', color: MUTED }}>{show(r.old_value)} → <span style={{ color: INK }}>{show(r.new_value)}</span></td>
                  <td style={{ padding: '4px 0 4px 8px', color: r.blocked ? RED : '#1F5F3F', whiteSpace: 'nowrap' }}>
                    {r.blocked ? 'held / failed' : 'written'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function LtClickupSection({ loanId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [compare, setCompare] = useState(false);

  const load = useCallback((withCompare) => {
    setErr(null);
    return ltApi.clickupSection(loanId, { compare: !!withCompare })
      .then(setData)
      .catch((e) => setErr((e && e.message) || 'Could not read the ClickUp section.'));
  }, [loanId]);

  useEffect(() => { load(false); }, [load]);

  // Every action runs through here: it shows the outcome sentence (success or the
  // server's refusal) in ONE place, right under the buttons — never a silent
  // nothing, never a browser popup. `special` lets a caller claim an error it
  // handles itself (the link door's confirm flow).
  const act = useCallback((fn, special) => (
    Promise.resolve()
      .then(fn)
      .then((msg) => { if (msg) setNotice({ tone: 'ok', text: msg }); })
      .catch((e) => {
        if (special && special(e)) return;
        setNotice({ tone: 'bad', text: (e && e.message) || 'That did not work.' });
      })
  ), []);

  if (err) return <div style={{ color: RED }}>{err}</div>;
  if (!data) return <div style={{ color: MUTED }}>Loading the ClickUp section…</div>;

  const noticeEl = notice ? (
    <div style={{
      marginTop: 10, padding: '8px 10px', borderRadius: 8, fontSize: 13,
      background: notice.tone === 'ok' ? '#EAF3EC' : '#FBEFEF',
      color: notice.tone === 'ok' ? '#1F5F3F' : RED,
    }}>{notice.text}</div>
  ) : null;

  return (
    <div style={{ display: 'grid', gap: 14, color: INK }}>
      <div>
        <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700, marginBottom: 6 }}>
          The card
        </div>
        <LinkCard data={data} loanId={loanId} notice={null} act={act} reload={() => load(compare)} />
        <SwitchLine switches={data.switches} />
      </div>

      <div>
        <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700, marginBottom: 6 }}>
          What PILOT syncs onto the card
        </div>
        <PlanTable data={data} loanId={loanId} act={act} compare={compare}
          onCompare={() => { setCompare(true); load(true); }} />
      </div>

      <div>
        <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700, marginBottom: 6 }}>
          Held for a person
        </div>
        <Reviews data={data} loanId={loanId} act={act} reload={() => load(compare)} />
      </div>

      <div>
        <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700, marginBottom: 6 }}>
          What the sync has done
        </div>
        <Journal data={data} />
      </div>

      {noticeEl}
    </div>
  );
}
