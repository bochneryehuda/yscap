import React, { useEffect, useState } from 'react';
import { arena } from '../../lib/arena.js';

/* THE LITTLE HELPER — "make what I wrote sound better".
 *
 * FOUR RULES, and they are all about not losing somebody's words:
 *
 * 1. IT NEVER TOUCHES WHAT THEY TYPED. The suggestion appears BESIDE their text
 *    with a Use it and a No thanks. Silently replacing what somebody wrote is
 *    the one unforgivable thing a writing helper can do, and it is why people
 *    stop trusting these.
 * 2. IT IS UNDOABLE. After accepting, "Put mine back" is still there, holding
 *    the original, until they navigate away.
 * 3. IT IS INVISIBLE WHEN IT CANNOT HELP. No key configured, or the call fails,
 *    and this component renders nothing at all. The box it sits under is an
 *    ordinary text box that works perfectly on its own.
 * 4. IT SAYS WHAT IT IS. Everything it produces is labelled as the AI's
 *    suggestion, never presented as if a person wrote it.
 *
 * It also does NOT run on every keystroke — only when somebody asks. A helper
 * that fires on a timer while you are still thinking is a helper that
 * interrupts, and it costs money on every keystroke for the privilege.
 */
export default function ArenaAiHelp({ text, purpose = 'entry', onAccept, compact = false }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [problem, setProblem] = useState('');
  const [original, setOriginal] = useState(null);

  useEffect(() => {
    let alive = true;
    arena.aiStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // The helper is off for this company, or we could not ask. Show nothing —
  // the text box beneath works exactly as well without it.
  if (!status || !status.available) return null;

  const ask = async () => {
    const t = String(text || '').trim();
    if (!t) { setProblem('Write something first, then I can tidy it up.'); return; }
    setBusy(true); setProblem(''); setSuggestion(null);
    try {
      const r = await arena.aiRewrite(t, purpose);
      if (!r.ok) setProblem(r.reason || 'The helper could not answer just now.');
      else setSuggestion(r);
    } catch (e) {
      setProblem((e && e.message) || 'The helper could not be reached. Carry on without it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`arena-ai${compact ? ' compact' : ''}`}>
      <div className="arena-ai-row">
        <button className="btn ghost small" type="button" onClick={ask} disabled={busy}>
          {busy ? 'Thinking…' : '✨ Tidy this up'}
        </button>
        {original && (
          <button
            className="btn ghost small" type="button"
            onClick={() => { if (onAccept) onAccept(original); setOriginal(null); setSuggestion(null); }}
          >Put mine back</button>
        )}
      </div>

      {problem && <p className="arena-ai-problem">{problem}</p>}

      {suggestion && (
        <div className="arena-ai-suggestion">
          <span className="arena-ai-label">{suggestion.label}</span>
          <p>{suggestion.rewritten}</p>
          {suggestion.whatChanged && <p className="muted small">{suggestion.whatChanged}</p>}
          <div className="arena-ai-row">
            <button
              className="btn small" type="button"
              onClick={() => {
                setOriginal(suggestion.original);      // kept, so it can always come back
                if (onAccept) onAccept(suggestion.rewritten);
                setSuggestion(null);
              }}
            >Use it</button>
            <button className="btn ghost small" type="button" onClick={() => setSuggestion(null)}>No thanks</button>
          </div>
        </div>
      )}
    </div>
  );
}

/*
 * IDEAS ON DEMAND — the chips.
 *
 * The owner's picture of this: "we write this and he starts saying — business
 * laptop, business tablet, business marketing budget for $1,000 that you can
 * spend for marketing, a blog video with bloggers up to $1,000, a full page in
 * a magazine, a voice ad, a video ad."
 *
 * Each idea is its own chip you take or leave. "More ideas" is told what has
 * already been offered, so it gives new ones rather than the same list in
 * different words. Nothing is ever applied automatically.
 */
export function ArenaAiIdeas({ kind = 'personal', capUsd, hint, onPick, what = 'prizes' }) {
  const [status, setStatus] = useState(null);
  const [ideas, setIdeas] = useState([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  const [label, setLabel] = useState('');

  useEffect(() => {
    let alive = true;
    arena.aiStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!status || !status.available) return null;

  const ask = async () => {
    setBusy(true); setProblem('');
    try {
      const avoid = ideas.map((i) => i.label || i.title).filter(Boolean);
      const r = what === 'challenges'
        ? await arena.aiChallenges({ text: text || hint, avoid })
        : await arena.aiPrizes({ text: text || hint, kind, capUsd, avoid });
      if (!r.ok) { setProblem(r.reason || 'The helper could not answer just now.'); return; }
      setIdeas((cur) => [...cur, ...(r.ideas || [])]);
      setLabel(r.label || '');
    } catch (e) {
      setProblem((e && e.message) || 'The helper could not be reached.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="arena-ai">
      <div className="arena-ai-row">
        <input
          className="input" value={text} placeholder={hint || 'What sort of thing are you after?'}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn ghost small" type="button" onClick={ask} disabled={busy}>
          {busy ? 'Thinking…' : ideas.length ? '✨ More ideas' : '✨ Give me ideas'}
        </button>
      </div>
      {problem && <p className="arena-ai-problem">{problem}</p>}
      {!!ideas.length && (
        <>
          {label && <span className="arena-ai-label">{label}</span>}
          <ul className="arena-ai-chips">
            {ideas.map((i, n) => (
              <li key={n}>
                <button type="button" className="arena-ai-chip" onClick={() => onPick && onPick(i)}>
                  <strong>{i.label || i.title}</strong>
                  <span>{i.detail || i.prompt}</span>
                  {i.valueUsd != null && <em>${Number(i.valueUsd).toLocaleString('en-US')}</em>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
