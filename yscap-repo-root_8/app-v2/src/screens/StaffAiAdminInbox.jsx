import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from 'react-router-dom';

/**
 * AI → super-admin inbox (owner-directed 2026-07-22, R3.7).
 *
 * When an AI agent hits an uncertainty it can't resolve (a genuinely ambiguous
 * document, a policy call, a naming edge case), it asks the super-admin here
 * instead of guessing. The super-admin's plain-English answer:
 *   1. Closes the linked ai_suggestion (marks it "answered").
 *   2. Feeds the learning module (learning.captureAdminAnswer) so the specific
 *      agent that asked has one more training signal next time it sees the
 *      same class of question.
 *
 * Super-admin only. Anything less shows an access-denied notice.
 */

const AGENT_LABEL = {
  cure: 'Condition-cure',
  committee: 'Model committee',
  twin: 'Loan digital twin',
  entity_chain: 'Entity chain',
  assignment_fraud: 'Assignment fraud',
  wrong_condition: 'Wrong condition',
  authenticity: 'Doc authenticity',
  splitter: 'Package splitter',
  section_1071: 'Section 1071',
};

export default function StaffAiAdminInbox() {
  const { role } = useAuth();
  const isSuper = role === 'super_admin';
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState({});

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.aiAdminQuestions();
      setRows((r && r.questions) || []);
    } catch (e) { setErr((e && e.message) || 'could not load'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (isSuper) load(); }, [isSuper, load]);

  if (!isSuper) return <div className="notice">Super-admin only. This is where the AI asks questions and you decide.</div>;

  const submit = async (id) => {
    const answer = answers[id];
    if (!answer || !answer.trim()) { alert('Type an answer first.'); return; }
    setBusy(true);
    try {
      await api.aiAdminAnswer(id, answer);
      setAnswers({ ...answers, [id]: '' });
      await load();
    } catch (e) { alert('Could not submit answer: ' + (e && e.message || 'error')); }
    finally { setBusy(false); }
  };

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>AI Questions Inbox</h2>
      <p style={{ color: 'var(--muted,#4B585C)', fontSize: 13, marginTop: 0, marginBottom: 12 }}>
        The AI asks here when it isn't sure — an unusual document, a naming edge case, or a policy
        call. Your answer closes the on-file suggestion AND becomes a training signal so the agent
        gets smarter without a developer changing code.
      </p>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div style={{ marginBottom: 10 }}>
        <button className="btn ghost" onClick={load} disabled={busy}>{busy ? '…' : '↻ Refresh'}</button>
      </div>
      {rows == null && <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>Loading…</div>}
      {rows && rows.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--muted,#4B585C)' }}>
          Nothing in the inbox. When an AI agent runs into something it can't decide, it will show up here.
        </div>
      )}
      {(rows || []).map((q) => {
        const agent = AGENT_LABEL[q.agent] || q.agent;
        return (
          <div key={q.id} style={{ border: '1px solid var(--paper,#E9E4D3)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
              <span style={{ background: 'rgba(47,127,134,.12)', color: 'var(--teal-deep,#256168)', fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>{agent}</span>
              <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>{new Date(q.asked_at).toLocaleString()}</span>
              {q.application_id && (
                <Link to={`/internal/app/${q.application_id}`} style={{ fontSize: 11, color: 'var(--teal-deep,#256168)', marginLeft: 'auto' }}>Open file →</Link>
              )}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, whiteSpace: 'pre-wrap' }}>{q.question}</div>
            {q.context && Object.keys(q.context).length > 0 && (
              <details style={{ marginBottom: 8, fontSize: 12 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted,#4B585C)' }}>Context the AI saw</summary>
                <pre style={{ background: 'var(--paper,#F6F3EC)', padding: 8, borderRadius: 6, fontSize: 11, overflow: 'auto' }}>{JSON.stringify(q.context, null, 2)}</pre>
              </details>
            )}
            <textarea value={answers[q.id] || ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              placeholder="Your answer — plain English. This feeds the AI's learning."
              style={{ width: '100%', minHeight: 70, fontSize: 13, padding: 8, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 6 }} />
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
              <button className="btn primary" onClick={() => submit(q.id)} disabled={busy || !(answers[q.id] || '').trim()}>Send answer</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
