import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDay } from '../lib/dates.js';
import { DateCommitInput } from './FormattedInputs.jsx';
import { useFlash } from './FlashToast.jsx';
import { leadName, initials, money, STAGE_LABEL, STAGE_PILL } from '../lib/leadCrm.js';

/* THE FOLLOW-UP REVIEW (owner-directed 2026-08-28: "on the lead side need a
   system to review leads per follow up date").

   The board answers "where is everything in the funnel". This answers the other
   question, the one an officer starts the day with: WHAT DID I SAY I WOULD DO,
   AND WHAT HAVE I LET SLIP. The whole book, split into the piles you actually
   work — overdue, today, tomorrow, the next seven days, later, and the pile
   nobody builds and everybody needs: the open leads with NO next step at all.

   THREE DELIBERATE CHOICES, all of them about not lying to the officer:

   · THE SERVER COUNTS, NOT THIS SCREEN. The board's list is capped at 500 rows,
     so a browser-side count would tell an officer with a real book "3 overdue"
     while forty sat past the cap. Every number here is taken over the officer's
     WHOLE visible scope, and the rows come back one pile at a time.
   · WHICH PILE A LEAD IS IN IS THE SERVER'S ANSWER TOO — every row carries its
     own `bucket`, computed by the one definition (src/lib/lead-followup.js). A
     browser copy of "what counts as overdue" would drift, and the copy that
     drifted would be the one somebody is reading their day off.
   · YOU CAN ACT WITHOUT LEAVING. A review you have to leave to act on is a list
     you stop opening. Every row can be pushed to a new date and can take a
     logged call/note right here — both through the SAME doors the lead
     workspace uses (PATCH /leads/:id and the activity timeline), never a second
     write path.

   The date box is the shared DateCommitInput for the reason db/595 exists: a
   save-per-keystroke date box fires on each intermediate year (0002 → 0202 →
   2026) and the racing saves wipe what was typed. */

const DARK = '#141B22';
const MUTED = '#4B585C';
const DANGER = '#B3261E';

/* The quick pushes. Days, not dates, so "3 days" from a Friday is a Monday's
   problem rather than this component's — the SERVER stores whatever calendar day
   we send, and the day arithmetic is done here in calendar strings for the same
   reason it is done that way on the server: `new Date('2026-03-08')` shifts
   across a DST boundary and lands on the wrong day twice a year. */
const PUSHES = [
  { days: 1, label: 'Tomorrow' },
  { days: 3, label: '+3 days' },
  { days: 7, label: '+1 week' },
  { days: 30, label: '+1 month' },
];

function addDays(day, n) {
  const s = String(day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

/** Whole calendar days between two 'YYYY-MM-DD' days (a − b). */
function dayGap(a, b) {
  const pa = String(a || '').slice(0, 10).split('-').map(Number);
  const pb = String(b || '').slice(0, 10).split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || !pa[0] || !pb[0]) return null;
  return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400000);
}

/** "3 days late" / "today" / "in 4 days" — the sentence, not the raw date, because
    the raw date is what an officer has to do arithmetic on to understand. */
function dueText(row, today) {
  if (!row.next_follow_up) return 'No date set';
  const gap = dayGap(String(row.next_follow_up).slice(0, 10), today);
  if (gap == null) return fmtDay(row.next_follow_up);
  if (gap === 0) return 'Due today';
  if (gap < 0) return `${-gap} day${gap === -1 ? '' : 's'} late`;
  if (gap === 1) return 'Due tomorrow';
  return `In ${gap} days`;
}

/** How long since a human last logged a call/email/note on this lead. */
function touchText(row) {
  if (!row.last_touch_at) return 'never contacted';
  const days = Math.floor((Date.now() - new Date(row.last_touch_at).getTime()) / 86400000);
  if (!Number.isFinite(days)) return 'never contacted';
  if (days <= 0) return 'touched today';
  if (days === 1) return 'touched yesterday';
  return `touched ${days} days ago`;
}

export default function LeadFollowUps({ officerId = null, onChanged }) {
  const nav = useNavigate();
  const { flash, toast } = useFlash();
  const [bucket, setBucket] = useState('');      // '' = what is on me now (overdue + today)
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = () => api.staffLeadFollowUps({
    ...(bucket ? { bucket } : {}),
    ...(officerId ? { officerId } : {}),
  }).then((d) => { setData(d); setErr(''); })
    .catch((e) => setErr((e && e.message) || 'Could not load the follow-up review.'));

  useEffect(() => { load(); }, [bucket, officerId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const today = (data && data.today) || '';
  const counts = (data && data.counts) || {};
  const buckets = useMemo(() => (data && data.buckets) || [], [data]);

  /* PUSH THE DATE. The same PATCH the lead workspace uses, so a date set here and a
     date set there are one write with one guard (a typed 2-digit year is resolved
     server-side; an unresolvable one is refused rather than stored). */
  const setDate = async (row, day) => {
    setBusy(row.id);
    try {
      await api.staffUpdateLead(row.id, { nextFollowUp: day });
      await load();
      onChanged && onChanged();
      flash(day ? `${leadName(row)} → ${fmtDay(day)}` : `${leadName(row)}: follow-up date cleared`);
    } catch (e) { setErr((e && e.message) || 'Could not move that date.'); }
    finally { setBusy(''); }
  };

  /* LOG A TOUCH — a real timeline entry, exactly as the lead workspace writes one,
     so the review does not become a second, thinner history nobody else can see. */
  const logTouch = async (row, kind, body, nextDay) => {
    setBusy(row.id);
    try {
      await api.staffAddLeadActivity(row.id, { type: kind, direction: 'outbound', body });
      if (nextDay !== undefined) await api.staffUpdateLead(row.id, { nextFollowUp: nextDay });
      await load();
      onChanged && onChanged();
      flash('Logged.');
    } catch (e) { setErr((e && e.message) || 'Could not log that.'); }
    finally { setBusy(''); }
  };

  if (err && !data) return <div role="alert" className="notice err">{err}</div>;
  if (!data) return <div className="panel pad muted">Loading the follow-up review…</div>;

  const rows = data.rows || [];
  const current = buckets.find((b) => b.key === bucket) || null;

  return (
    <div className="stack">
      {toast}
      {err && <div role="alert" className="notice err">{err}</div>}

      {/* THE PILES. Every one is shown, at zero as much as at forty — "nothing is
          overdue" is an answer an officer is entitled to read off the screen,
          rather than having to infer it from a tab that is not there. */}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className={`btn ${bucket === '' ? 'primary' : 'ghost'} small`}
          aria-pressed={bucket === ''}
          onClick={() => setBucket('')}
          title="Everything that is actually on you right now — overdue and due today, together">
          On me now ({data.dueNow || 0})
        </button>
        {buckets.map((b) => (
          <button key={b.key} type="button"
            className={`btn ${bucket === b.key ? 'primary' : 'ghost'} small`}
            aria-pressed={bucket === b.key}
            onClick={() => setBucket(b.key)} title={b.blurb}
            style={b.key === 'overdue' && (counts.overdue || 0) > 0 && bucket !== 'overdue'
              ? { borderColor: DANGER, color: DANGER } : undefined}>
            {b.label} ({counts[b.key] || 0})
          </button>
        ))}
      </div>
      <div className="muted small" style={{ marginTop: -4 }}>
        {current ? current.blurb : 'Overdue and due-today together — the calls that are actually on you.'}
        {' '}Measured against <b>{fmtDay(today)}</b>, the team’s own day.
      </div>

      {rows.length === 0 ? (
        <div className="panel"><div className="panel-b"><div className="empty-state">
          <h3>{bucket === 'none' ? 'Every open lead has a next step' : bucket === 'overdue' ? 'Nothing has slipped' : 'Nothing here'}</h3>
          <p>{bucket === 'none'
            ? 'No open lead is sitting without a follow-up date.'
            : bucket === 'overdue'
              ? 'No open lead is past its follow-up date.'
              : 'No leads in this pile right now.'}</p>
        </div></div></div>
      ) : (
        <div className="panel">
          <div className="tbl-scroll">
            <table className="tbl lead-tbl">
              <thead>
                <tr>
                  <th>Lead</th><th>Stage</th><th>Owner</th><th>Follow-up</th>
                  <th>Last contact</th><th className="num">Est. amount</th><th>Move it</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const late = row.bucket === 'overdue';
                  return (
                    <tr key={row.id} className="lead-row">
                      <td className="cell-deal">
                        <button type="button" className="btn link" style={{ padding: 0, textAlign: 'left' }}
                          onClick={() => nav(`/internal/leads/${row.id}`)}>
                          <span className="who">
                            <span className="mono">{initials(leadName(row))}</span>
                            <span className="lead">{leadName(row)}</span>
                          </span>
                        </button>
                        <div className="mut">
                          {[row.company, row.phone, row.email].filter(Boolean).join(' · ') || '—'}
                        </div>
                      </td>
                      <td><span className={`pill ${STAGE_PILL[row.status] || 'mut'}`}>{STAGE_LABEL[row.status] || row.status}</span></td>
                      <td>{row.officer_name || <span className="muted">Loan desk</span>}</td>
                      <td style={late ? { color: DANGER, fontWeight: 600 } : { color: DARK }}>
                        {dueText(row, today)}
                        {row.next_follow_up && <div className="mut" style={{ fontWeight: 400 }}>{fmtDay(row.next_follow_up)}</div>}
                      </td>
                      <td className="mut">
                        {touchText(row)}
                        {row.open_tasks > 0 && <div className="mut">{row.open_tasks} open task{row.open_tasks === 1 ? '' : 's'}</div>}
                      </td>
                      <td className="num">{money(row.loan_amount) || '—'}</td>
                      <td>
                        {/* Push the date without leaving the review. The pushes are
                            measured from TODAY, never from the old (possibly long
                            past) date — "call me in 3 days" means three days from
                            now, which is what somebody clicking this means. */}
                        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                          {PUSHES.map((p) => (
                            <button key={p.days} type="button" className="btn ghost small" disabled={busy === row.id}
                              title={`Follow up on ${fmtDay(addDays(today, p.days))}`}
                              onClick={() => setDate(row, addDays(today, p.days))}>{p.label}</button>
                          ))}
                          <DateCommitInput className="input flt-sm" style={{ width: 140 }}
                            value={row.next_follow_up}
                            aria-label={`Next follow-up for ${leadName(row)}`}
                            onCommit={(d) => setDate(row, d)} />
                        </div>
                        <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                          <button type="button" className="btn ghost small" disabled={busy === row.id}
                            title="Log that you called, and push the follow-up a week out"
                            onClick={() => logTouch(row, 'call', 'Called — logged from the follow-up review.', addDays(today, 7))}>
                            Logged a call
                          </button>
                          <button type="button" className="btn ghost small" disabled={busy === row.id}
                            title="Log that you emailed, and push the follow-up three days out"
                            onClick={() => logTouch(row, 'email', 'Emailed — logged from the follow-up review.', addDays(today, 3))}>
                            Logged an email
                          </button>
                          <button type="button" className="btn ghost small" disabled={busy === row.id}
                            onClick={() => nav(`/internal/leads/${row.id}`)}>Open</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length >= 300 && (
            <div className="muted small" style={{ padding: '6px 10px' }}>
              Showing the first 300 in this pile — the counts above are the full figures.
            </div>
          )}
        </div>
      )}
      <div className="muted small" style={{ color: MUTED }}>
        A lead that is won, lost or archived is never in this review — there is no follow-up owed on a closed lead.
      </div>
    </div>
  );
}
