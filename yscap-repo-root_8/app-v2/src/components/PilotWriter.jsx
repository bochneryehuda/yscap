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
  const [pos, setPos] = useState(null);         // { left, bottom, width } — viewport-clamped
  const boxRef = useRef(null);

  // The popover is position:FIXED and viewport-CLAMPED (audit 2026-08-18
  // finding 2: absolute-anchored left:0 was clipped by the chat thread's
  // overflow:hidden on phones — a whole rewrite tone sat off-canvas). Fixed
  // positioning escapes every overflow container (none of the mounts sits
  // under a transformed ancestor); the clamp keeps all 340px (or 86vw) on
  // screen with an 8px gutter whichever side the ✦ button is on.
  const place = () => {
    const btn = boxRef.current && boxRef.current.querySelector('button');
    const r = btn && btn.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const w = Math.min(340, Math.floor(vw * 0.86));
    // Vertical: open ABOVE the button (the composer sits at the bottom of its
    // panel), but a button near the TOP of the viewport flips it BELOW instead
    // of pushing the popover off-screen (audit 2026-08-18 note — unreachable on
    // today's mounts, real on a future one). ~320px covers the tallest state.
    const openBelow = r.top < 340;
    setPos({
      left: Math.max(8, Math.min(r.left, vw - w - 8)),
      bottom: openBelow ? null : Math.max(8, window.innerHeight - r.top + 6),
      top: openBelow ? Math.min(window.innerHeight - 60, r.bottom + 6) : null,
      width: w,
    });
  };
  const toggle = () => { setErr(''); setOpen((v) => { if (!v) place(); return !v; }); };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    // A fixed popover stays put while the page scrolls/resizes under it — track.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
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
        onClick={toggle}>
        {busy ? 'Pilot AI…' : label}
      </button>
      {open && pos && (
        <div style={{ position: 'fixed', ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }), left: pos.left, zIndex: 260, width: pos.width,
          maxHeight: 'calc(100vh - 16px)', overflowY: 'auto',
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
