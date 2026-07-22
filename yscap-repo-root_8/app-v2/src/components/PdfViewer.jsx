import React, { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Feature-rich PDF preview powered by PDF.js (Mozilla's engine — the same one
 * Firefox ships). We render each page to a <canvas> ourselves instead of an
 * <iframe>, which is why this works where the old sandboxed-iframe preview did
 * not: a fully-sandboxed iframe cannot load a blob: URL (opaque origin), so
 * PDFs came up blank. Rendering to canvas also means uploaded PDF JavaScript
 * never executes — safe by construction.
 *
 * pdfjs (and its ~1 MB worker) load on demand via dynamic import, so they stay
 * out of the main app bundle and only download the first time someone previews
 * a PDF. The worker is emitted as a local asset (?url), so nothing is fetched
 * from a CDN — the strict CSP is honored.
 *
 * Props:
 *   data        ArrayBuffer of the PDF bytes (preferred — origin-independent)
 *   onError     () => void   called if the document can't be parsed
 *   initialPage optional 1-based page to scroll to once rendered (findings
 *               "open the source document to page N" — the page the finding
 *               was raised from). Auto-jumps ONCE; the reader can then scroll.
 */
export default function PdfViewer({ data, onError, initialPage }) {
  const [status, setStatus] = useState('loading');   // loading | ready | error
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.15);
  const pdfRef = useRef(null);
  const scrollRef = useRef(null);
  const pageRefs = useRef([]);          // one wrapper div per page
  const renderTokens = useRef(0);       // cancels stale re-renders on zoom
  const jumpedRef = useRef(false);      // auto-jump to initialPage only once

  // Load the document once. Clone the ArrayBuffer because pdfjs transfers
  // (neuters) the buffer it's given, which would break a later re-open.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const buf = data.slice(0);
        const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
        if (!alive) { doc.destroy(); return; }
        pdfRef.current = doc;
        pageRefs.current = new Array(doc.numPages).fill(null);
        setNumPages(doc.numPages);
        setStatus('ready');
      } catch (e) {
        if (alive) { setStatus('error'); onError && onError(e); }
      }
    })();
    return () => { alive = false; if (pdfRef.current) { try { pdfRef.current.destroy(); } catch (_) {} pdfRef.current = null; } };
  }, [data, onError]);

  // (Re)render every page whenever the document or zoom changes.
  useEffect(() => {
    if (status !== 'ready' || !pdfRef.current) return;
    const token = ++renderTokens.current;
    const doc = pdfRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    (async () => {
      for (let n = 1; n <= doc.numPages; n++) {
        if (token !== renderTokens.current) return;   // a newer zoom superseded us
        const wrap = pageRefs.current[n - 1];
        if (!wrap) continue;
        try {
          const pg = await doc.getPage(n);
          const viewport = pg.getViewport({ scale });
          let canvas = wrap.querySelector('canvas');
          if (!canvas) { canvas = document.createElement('canvas'); wrap.appendChild(canvas); }
          const ctx = canvas.getContext('2d');
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = Math.floor(viewport.width) + 'px';
          canvas.style.height = Math.floor(viewport.height) + 'px';
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          await pg.render({ canvasContext: ctx, viewport }).promise;
        } catch (_) { /* one bad page never kills the rest */ }
      }
    })();
  }, [status, scale, numPages]);

  // Auto-jump to a requested page once it has actually rendered (its wrapper has
  // real height). Pages render sequentially + async, so poll a few frames until
  // the target page is measurable, then scroll to it — once. A manual scroll or
  // zoom afterward won't re-trigger it (jumpedRef).
  useEffect(() => {
    if (status !== 'ready' || !initialPage || initialPage < 1 || jumpedRef.current) return;
    let raf = 0, tries = 0;
    const tryScroll = () => {
      const target = Math.min(numPages || 1, initialPage);
      const w = pageRefs.current[target - 1];
      if (w && w.offsetHeight > 60 && scrollRef.current) {
        scrollRef.current.scrollTo({ top: Math.max(0, w.offsetTop - 8), behavior: 'auto' });
        setPage(target);
        jumpedRef.current = true;
        return;
      }
      if (tries++ < 180) raf = requestAnimationFrame(tryScroll);   // ~3s at 60fps, then give up
    };
    raf = requestAnimationFrame(tryScroll);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [status, numPages, initialPage]);

  // Track which page is centered so the toolbar counter is live.
  const onScroll = useCallback(() => {
    const c = scrollRef.current; if (!c) return;
    const mid = c.scrollTop + c.clientHeight / 2;
    let best = 1;
    for (let i = 0; i < pageRefs.current.length; i++) {
      const w = pageRefs.current[i]; if (!w) continue;
      if (w.offsetTop <= mid) best = i + 1; else break;
    }
    setPage(best);
  }, []);

  const goto = (n) => {
    const i = Math.max(1, Math.min(numPages, n));
    const w = pageRefs.current[i - 1];
    if (w && scrollRef.current) scrollRef.current.scrollTo({ top: w.offsetTop - 8, behavior: 'smooth' });
  };
  const zoom = (d) => setScale(s => Math.max(0.5, Math.min(3, Math.round((s + d) * 100) / 100)));

  if (status === 'error') return null;   // DocPreview falls back to its download card

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <div className="row" style={{ gap: 6, alignItems: 'center', padding: '6px 8px', flexWrap: 'wrap', borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
        <button className="btn ghost small" disabled={page <= 1} onClick={() => goto(page - 1)} title="Previous page">‹</button>
        <span className="muted small" style={{ minWidth: 92, textAlign: 'center' }}>
          {status === 'ready' ? `Page ${page} / ${numPages}` : 'Loading…'}
        </span>
        <button className="btn ghost small" disabled={page >= numPages} onClick={() => goto(page + 1)} title="Next page">›</button>
        <span style={{ width: 12 }} />
        <button className="btn ghost small" onClick={() => zoom(-0.15)} title="Zoom out">−</button>
        <span className="muted small" style={{ minWidth: 46, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button className="btn ghost small" onClick={() => zoom(0.15)} title="Zoom in">+</button>
        <button className="btn ghost small" onClick={() => setScale(1.15)} title="Reset zoom">Fit</button>
      </div>
      <div ref={scrollRef} onScroll={onScroll}
        style={{ flex: 1, overflow: 'auto', background: '#525659', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 10 }}>
        {status === 'loading' && <span style={{ color: '#eee', margin: 'auto' }}>Loading PDF…</span>}
        {status === 'ready' && Array.from({ length: numPages }, (_, i) => (
          <div key={i} ref={el => { pageRefs.current[i] = el; }}
            // flexShrink:0 is essential: this scroll container is a column flex,
            // and the explicit minHeight overrides the default min-height:auto,
            // so without it multi-page PDFs get each wrapper squashed and the
            // fixed-height canvases overlap — the "top of the doc repeated" bug.
            style={{ background: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,0.4)', minHeight: 40, flexShrink: 0 }} />
        ))}
      </div>
    </div>
  );
}
