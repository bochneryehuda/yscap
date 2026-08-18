import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { askPrompt } from '../lib/dialog.js';

/* PILOT AI — the writing assistant beside a composer (owner-directed
   2026-08-18). One small "✦ Pilot AI" button that attaches to any text box:
     · Fix spelling & grammar (wording stays theirs)
     · Rewrite — professional / friendly / firmer / shorter / plain
     · Help me write… (say what the message should do; it drafts)
   The suggestion renders in a PREVIEW; nothing touches the composer until the
   human clicks "Use this" (onReplace). Purely advisory — the server returns
   text and does nothing else. `surface` picks the door ('staff' | 'borrower' |
   'tpo'), so an external user's requests ride the borrower-safe scrub.

   Mount it in the composer's action row:
     <PilotWriter value={text} onReplace={setText} surface="staff" />       */

const TONES = [
  ['professional', 'Professional'],
  ['friendly', 'Friendly'],
  ['firm', 'Firmer'],
  ['shorter', 'Shorter'],
  ['plain', 'Plainer'],
];

export default function PilotWriter({ value, onReplace, surface = 'staff', label = '✦ Pilot AI' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { text } | null
  const [err, setErr] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const run = async (body) => {
    setBusy(true); setErr(''); setResult(null);
    try {
      const out = await api.pilotWriter(surface, body);
      if (out && out.ok && out.text) setResult({ text: out.text });
      else setErr((out && out.reason) || 'Pilot AI could not answer just now — try again.');
    } catch (e) {
      setErr((e.data && (e.data.reason || e.data.error)) || e.message || 'Pilot AI could not answer just now — try again.');
    } finally { setBusy(false); }
  };

  const helpMeWrite = async () => {
    const instruction = await askPrompt('What should this message do? (e.g. "ask the title company for the updated commitment, polite but urgent")',
      { placeholder: 'Say what to write', confirmLabel: 'Draft it', multiline: true });
    if (instruction == null || !instruction.trim()) return;
    await run({ mode: 'draft', instruction: instruction.trim(), text: String(value || '') });
  };

  return (
    <span ref={boxRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className="btn ghost small" disabled={busy}
        title="Pilot AI — fix, rewrite, or draft this message. Nothing changes until you choose to use the suggestion."
        onClick={() => { setOpen((v) => !v); setErr(''); }}>
        {busy ? 'Pilot AI…' : label}
      </button>
      {open && (
        <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60, width: 'min(340px, 86vw)',
          background: '#FFFFFF', border: '1px solid #D9D4C8', borderRadius: 10, boxShadow: '0 8px 28px rgba(20,27,34,.16)', padding: 10 }}>
          <div style={{ font: '600 11px/1 "Hanken Grotesk", system-ui, sans-serif', letterSpacing: '.08em', textTransform: 'uppercase', color: '#AE8746', marginBottom: 6 }}>
            Pilot AI
          </div>
          {!result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button type="button" className="btn ghost small" disabled={busy || !String(value || '').trim()}
                style={{ justifyContent: 'flex-start' }}
                onClick={() => run({ mode: 'fix', text: String(value || '') })}>
                Fix spelling &amp; grammar
              </button>
              <div className="small" style={{ color: '#4B585C', margin: '4px 0 0' }}>Rewrite as…</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {TONES.map(([tone, tlabel]) => (
                  <button key={tone} type="button" className="btn ghost small" disabled={busy || !String(value || '').trim()}
                    onClick={() => run({ mode: 'rewrite', tone, text: String(value || '') })}>
                    {tlabel}
                  </button>
                ))}
              </div>
              <button type="button" className="btn ghost small" disabled={busy} style={{ justifyContent: 'flex-start', marginTop: 4 }}
                onClick={helpMeWrite}>
                Help me write…
              </button>
              {err && <div className="small" role="alert" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
            </div>
          )}
          {result && (
            <div>
              <div className="small" style={{ whiteSpace: 'pre-wrap', color: '#141B22', maxHeight: 220, overflowY: 'auto',
                border: '1px solid #EAE4D7', borderRadius: 8, padding: 8, background: '#FBFAF6' }}>{result.text}</div>
              <div className="row" style={{ gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
                <button type="button" className="btn ghost small" onClick={() => setResult(null)}>Back</button>
                <button type="button" className="btn primary small"
                  onClick={() => { if (onReplace) onReplace(result.text); setResult(null); setOpen(false); }}>
                  Use this
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
