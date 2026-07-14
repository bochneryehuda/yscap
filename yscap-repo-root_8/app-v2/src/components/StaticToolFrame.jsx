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
    let booted = false;

    const boot = () => {
      if (booted || disposed) return;
      booted = true;
      let win;
      try { win = frame.contentWindow; if (!win || !win.document) throw new Error('no frame'); }
      catch (_) { setLoaded(true); return; }   // cross-origin/failed: show as-is
      try {
        // The tools carry the marketing site's light/dark switch (theme.js) and
        // may boot from a stale saved 'dark' preference. The portal is white-first
        // now, so force the LIGHT tokens and hide the toggle: the embed always
        // matches the white portal around it (owner-directed 2026-07-10 — every
        // embedded tool follows the portal's white coloring).
        win.document.documentElement.setAttribute('data-theme', 'light');
        const style = win.document.createElement('style');
        // Keep the tool's OWN brand-paper background (matches the perfect standalone
        // version) instead of forcing transparent — forcing transparent showed the
        // portal's gray sheet through and read as "ugly gray". And stop looping
        // decorative motion (the "Live" dot pulse etc.) that reads as blinking here.
        style.textContent = 'html,body{height:auto!important;min-height:0!important;background:#F4F0E7!important}'
          + '.ys-theme-toggle{display:none!important}'
          + '*,*::before,*::after{animation-iteration-count:1!important}';
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

    // Boot on DOM-ready, not the full `load` event: one stalled third-party
    // resource (a slow fonts CDN) used to leave the tool invisible and
    // unthemed indefinitely because `load` never fired.
    const tryBoot = () => {
      if (booted || disposed) return true;
      let doc;
      try { doc = frame.contentWindow && frame.contentWindow.document; }
      catch (_) { setLoaded(true); booted = true; return true; }   // cross-origin: show as-is
      if (!doc || (doc.location && doc.location.href === 'about:blank')) return false;
      // Theme the tool the moment its real document exists — even mid-parse
      // (a hung stylesheet keeps readyState at 'loading' for a long time, and
      // the embed must never sit there in the wrong theme). White-first.
      try { if (doc.documentElement) doc.documentElement.setAttribute('data-theme', 'light'); } catch (_) { /* cosmetic */ }
      // full boot needs the parsed body
      if (doc.readyState === 'loading' || !doc.body) return false;
      boot();
      return true;
    };
    frame.addEventListener('load', tryBoot);
    const readyPoll = setInterval(() => { if (tryBoot()) clearInterval(readyPoll); }, 150);
    return () => {
      disposed = true;
      frame.removeEventListener('load', tryBoot);
      clearInterval(readyPoll);
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
