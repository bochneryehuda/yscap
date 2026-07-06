import React, { useEffect, useRef, useState } from 'react';

/* Seamless host for the static tools (Track Record, Scope of Work, Term Sheet
   Studio…) inside the portal. The tools stay exactly what they are — static
   HTML pages with their frozen engines — but the frame around them disappears:

     · same-origin iframe with no border, no box, transparent background
     · auto-height: the frame grows/shrinks to the tool's content, so the
       PORTAL page scrolls as one — no scrollbar-inside-a-scrollbar
     · `fill` mode instead fills the parent (for the full-screen ToolSheet)
     · a quiet loading state until the tool has painted

   Auto-height needs `html,body{height:auto}` inside the frame — otherwise
   scrollHeight reports the frame's own viewport back and the loop feeds
   itself (the Term Sheet Studio learned this the hard way). */
export default function StaticToolFrame({ src, title, fill = false, minHeight = 480, onReady }) {
  const frameRef = useRef(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let disposed = false;
    let poller = null;

    const boot = () => {
      let win;
      try { win = frame.contentWindow; if (!win || !win.document) throw new Error('no frame'); }
      catch (_) { setLoaded(true); return; }   // cross-origin/failed: show as-is
      try {
        const style = win.document.createElement('style');
        style.textContent = 'html,body{height:auto!important;min-height:0!important;background:transparent}';
        win.document.head.appendChild(style);
      } catch (_) { /* cosmetic only */ }
      if (!disposed) setLoaded(true);
      if (onReady) { try { onReady(win); } catch (_) { /* optional hook */ } }
      if (fill) return;
      poller = setInterval(() => {
        if (disposed) return;
        try {
          const want = Math.max(minHeight, win.document.body.scrollHeight + 16);
          const have = parseInt(frame.style.height, 10) || 0;
          // only move on a real change — see the feedback-loop note above
          if (Math.abs(want - have) > 24) frame.style.height = want + 'px';
        } catch (_) { /* frame navigated / torn down */ }
      }, 400);
    };

    frame.addEventListener('load', boot);
    return () => {
      disposed = true;
      frame.removeEventListener('load', boot);
      if (poller) clearInterval(poller);
    };
    // mount-once: src changes remount via key upstream
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`toolframe ${fill ? 'fill' : ''}`} style={fill ? undefined : { minHeight }}>
      {!loaded && (
        <div className="toolframe-loading" aria-live="polite">
          <span className="toolframe-spinner" aria-hidden="true" />
          Loading…
        </div>
      )}
      <iframe
        ref={frameRef}
        src={src}
        title={title}
        style={{
          width: '100%', border: 0, display: 'block', background: 'transparent',
          ...(fill ? { height: '100%', flex: 1 } : { height: minHeight }),
          opacity: loaded ? 1 : 0, transition: 'opacity .25s ease',
        }}
      />
    </div>
  );
}
