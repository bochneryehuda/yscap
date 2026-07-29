import React, { useEffect, useRef, useState, useCallback } from 'react';
import { findHighlightItems } from '../lib/pdfHighlight.js';

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
 * SEARCH (Ctrl/⌘-F) — owner-directed 2026-07-29. The viewer has its own find bar
 * (the browser's Ctrl-F can't reach into a canvas). It searches the PDF's text
 * layer, boxes every match, and steps through them. When the document has NO
 * text layer (a scanned page), the `ocr` prop — when provided — lets the reader
 * run OCR on the server and then search the recognized text (page-level: it
 * jumps to the page the words are on).
 *
 * Props:
 *   data        ArrayBuffer of the PDF bytes (preferred — origin-independent)
 *   onError     () => void   called if the document can't be parsed
 *   initialPage optional 1-based page to scroll to once rendered.
 *   highlight   optional string — a value to soft-highlight (findings).
 *   highlightBoxes optional [{ page, polygon }] — precise evidence boxes (R5.17).
 *   ocr         optional () => Promise<{ ok, pages:[{page,text}], engine, reason }>
 *               — runs server OCR for a scanned PDF so search can find text in it.
 */
export default function PdfViewer({ data, onError, initialPage, highlight, highlightBoxes, ocr }) {
  const [status, setStatus] = useState('loading');   // loading | ready | error
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.15);
  const pdfRef = useRef(null);
  const pdfjsRef = useRef(null);       // the pdfjs module (for Util.transform when highlighting)
  const scrollRef = useRef(null);
  const pageRefs = useRef([]);          // one wrapper div per page
  const renderTokens = useRef(0);       // cancels stale re-renders on zoom
  const jumpedRef = useRef(false);      // auto-jump to initialPage only once

  // --- Search state ---------------------------------------------------------
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);      // [{ page, ord }] in reading order
  const [active, setActive] = useState(-1);        // index into matches
  const [mode, setMode] = useState('native');      // 'native' text layer | 'ocr'
  const [ocrState, setOcrState] = useState('unknown'); // unknown | has_text | scanned | running | ready | failed
  const [ocrNote, setOcrNote] = useState('');
  const [indexReady, setIndexReady] = useState(0); // bumped when the native text index is built
  const itemsRef = useRef([]);          // native tc.items per page (0-based)
  const pageTextRef = useRef([]);       // lowercased joined text per page (native)
  const ocrTextRef = useRef([]);        // lowercased text per page (OCR), 1-based → index 0-based
  const findInputRef = useRef(null);

  // Load the document once. Clone the ArrayBuffer because pdfjs transfers
  // (neuters) the buffer it's given, which would break a later re-open.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjsRef.current = pdfjs;
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

  // Build the native text index once, so search is instant and we can tell a
  // scanned PDF (no text layer) from a real one.
  useEffect(() => {
    if (status !== 'ready' || !pdfRef.current) return;
    let alive = true;
    (async () => {
      const doc = pdfRef.current;
      const items = new Array(doc.numPages);
      const texts = new Array(doc.numPages);
      let total = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        try {
          const pg = await doc.getPage(n);
          const tc = await pg.getTextContent();
          if (!alive) return;
          items[n - 1] = tc.items;
          const joined = tc.items.map((it) => (it && it.str) || '').join(' ');
          texts[n - 1] = joined.toLowerCase();
          total += joined.replace(/\s+/g, '').length;
        } catch (_) { items[n - 1] = []; texts[n - 1] = ''; }
      }
      if (!alive) return;
      itemsRef.current = items;
      pageTextRef.current = texts;
      // A real (searchable) document has a text layer; a scanned one has ~none.
      // The threshold is deliberately low — a mostly-image PDF with a stray
      // stamp of text still counts as scanned so the OCR offer shows.
      setOcrState(total >= 12 ? 'has_text' : 'scanned');
      setIndexReady((v) => v + 1);
    })();
    return () => { alive = false; };
  }, [status, numPages]);

  // (Re)render every page's CANVAS whenever the document or zoom changes.
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

  // OVERLAYS — the findings highlight, the precise evidence boxes, and the
  // search-match boxes. Kept SEPARATE from the canvas render so stepping through
  // search results never re-rasterizes the pages (just repaints cheap divs).
  useEffect(() => {
    if (status !== 'ready' || !pdfRef.current || !pdfjsRef.current) return;
    const doc = pdfRef.current;
    let alive = true;
    (async () => {
      const needle = query.trim().toLowerCase();
      for (let n = 1; n <= doc.numPages; n++) {
        const wrap = pageRefs.current[n - 1];
        if (!wrap) continue;
        let pg, viewport;
        try { pg = await doc.getPage(n); viewport = pg.getViewport({ scale }); } catch (_) { continue; }
        if (!alive) return;
        wrap.querySelectorAll('.pdf-hl').forEach((el) => el.remove());

        // Findings value highlight (best-effort).
        if (highlight) {
          try {
            const items = itemsRef.current[n - 1] || (await pg.getTextContent()).items;
            const hits = findHighlightItems(items, highlight);
            for (const idx of hits) {
              const it = items[idx];
              if (!it || !it.transform) continue;
              const tx = pdfjsRef.current.Util.transform(viewport.transform, it.transform);
              const fontH = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 12;
              const w = (Number(it.width) || 0) * viewport.scale;
              const box = document.createElement('div');
              box.className = 'pdf-hl';
              box.style.cssText = `position:absolute;left:${tx[4]}px;top:${tx[5] - fontH}px;`
                + `width:${Math.max(w, 4)}px;height:${fontH * 1.15}px;`
                + 'background:rgba(255,213,0,0.40);border-radius:2px;pointer-events:none;mix-blend-mode:multiply;';
              wrap.appendChild(box);
            }
          } catch (_) { /* highlighting is best-effort */ }
        }

        // Precise evidence boxes (R5.17) from stored normalized 0..1 polygons.
        if (Array.isArray(highlightBoxes) && highlightBoxes.length) {
          try {
            for (const b of highlightBoxes) {
              if (!b || Number(b.page) !== n) continue;
              const poly = b.polygon;
              if (!Array.isArray(poly) || !poly.length) continue;
              let minX = 1, minY = 1, maxX = 0, maxY = 0, ok = false;
              for (const p of poly) {
                const px = Array.isArray(p) ? Number(p[0]) : Number(p && p.x);
                const py = Array.isArray(p) ? Number(p[1]) : Number(p && p.y);
                if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
                minX = Math.min(minX, px); minY = Math.min(minY, py);
                maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
                ok = true;
              }
              if (!ok || maxX <= minX || maxY <= minY) continue;
              const box = document.createElement('div');
              box.className = 'pdf-hl pdf-hl-box';
              box.style.cssText = `position:absolute;left:${minX * viewport.width}px;top:${minY * viewport.height}px;`
                + `width:${Math.max((maxX - minX) * viewport.width, 4)}px;height:${Math.max((maxY - minY) * viewport.height, 4)}px;`
                + 'background:rgba(255,213,0,0.30);border:1.5px solid rgba(214,158,0,0.85);'
                + 'border-radius:2px;pointer-events:none;mix-blend-mode:multiply;';
              wrap.appendChild(box);
            }
          } catch (_) { /* box overlay is best-effort */ }
        }

        // Search-match boxes (native text layer only — OCR search is page-level).
        if (needle && mode === 'native') {
          const items = itemsRef.current[n - 1] || [];
          const act = matches[active];
          let ord = 0;
          for (const it of items) {
            const s = (it && it.str ? it.str : '').toLowerCase();
            if (!s.includes(needle)) continue;
            const thisOrd = ord++;
            if (!it.transform) continue;
            try {
              const tx = pdfjsRef.current.Util.transform(viewport.transform, it.transform);
              const fontH = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 12;
              const w = (Number(it.width) || 0) * viewport.scale;
              const isActive = act && act.page === n && act.ord === thisOrd;
              const box = document.createElement('div');
              box.className = 'pdf-hl pdf-find' + (isActive ? ' pdf-find-active' : '');
              box.style.cssText = `position:absolute;left:${tx[4]}px;top:${tx[5] - fontH}px;`
                + `width:${Math.max(w, 4)}px;height:${fontH * 1.2}px;border-radius:2px;pointer-events:none;`
                + (isActive
                  ? 'background:rgba(255,150,0,0.55);outline:2px solid rgba(214,120,0,0.95);mix-blend-mode:multiply;'
                  : 'background:rgba(90,170,255,0.40);mix-blend-mode:multiply;');
              wrap.appendChild(box);
            } catch (_) { /* per-match draw is best-effort */ }
          }
        }
      }
    })();
    return () => { alive = false; };
  }, [status, scale, numPages, highlight, highlightBoxes, query, active, matches, mode, indexReady]);

  // Auto-jump to a requested page once it has actually rendered.
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
      if (tries++ < 180) raf = requestAnimationFrame(tryScroll);
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
  const zoom = (d) => setScale((s) => Math.max(0.5, Math.min(3, Math.round((s + d) * 100) / 100)));

  // --- Search behavior ------------------------------------------------------
  // Recompute matches whenever the query, the built index, or the mode changes.
  const recompute = useCallback((q, srcMode) => {
    const needle = (q || '').trim().toLowerCase();
    if (!needle) { setMatches([]); setActive(-1); return; }
    const out = [];
    if (srcMode === 'ocr') {
      const texts = ocrTextRef.current || [];
      for (let n = 1; n <= texts.length; n++) {
        const t = texts[n - 1] || '';
        let idx = t.indexOf(needle), ord = 0;
        while (idx !== -1) { out.push({ page: n, ord }); ord++; idx = t.indexOf(needle, idx + needle.length); }
      }
    } else {
      const all = itemsRef.current || [];
      for (let n = 1; n <= all.length; n++) {
        const items = all[n - 1] || [];
        let ord = 0;
        for (const it of items) {
          if ((it && it.str ? it.str : '').toLowerCase().includes(needle)) { out.push({ page: n, ord }); ord++; }
        }
      }
    }
    setMatches(out);
    setActive(out.length ? 0 : -1);
  }, []);

  useEffect(() => { recompute(query, mode); }, [query, mode, indexReady, recompute]);

  // Scroll to the active match's page whenever it changes.
  useEffect(() => {
    if (active < 0 || !matches[active]) return;
    goto(matches[active].page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const stepMatch = (delta) => {
    if (!matches.length) return;
    setActive((a) => {
      const base = a < 0 ? 0 : a;
      return (base + delta + matches.length) % matches.length;
    });
  };

  const openFind = useCallback(() => {
    setFindOpen(true);
    setTimeout(() => { if (findInputRef.current) findInputRef.current.select(); }, 0);
  }, []);
  const closeFind = () => { setFindOpen(false); setQuery(''); setMatches([]); setActive(-1); };

  // Ctrl/⌘-F opens the in-viewer find bar (and beats the browser's own find,
  // which can't see canvas text anyway). Only while this viewer is mounted.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFind]);

  // Run server OCR for a scanned PDF, then search the recognized text.
  const runOcr = async () => {
    if (!ocr) return;
    setOcrState('running'); setOcrNote('');
    try {
      const res = await ocr();
      if (!res || !res.ok || !Array.isArray(res.pages) || !res.pages.length) {
        setOcrState('failed');
        setOcrNote((res && res.reason === 'ocr_not_configured')
          ? 'Text reading isn’t turned on for this account.'
          : 'Couldn’t read text from this scan.');
        return;
      }
      const texts = new Array(numPages).fill('');
      for (const p of res.pages) {
        const n = Number(p.page);
        if (n >= 1 && n <= numPages) texts[n - 1] = String(p.text || '').toLowerCase();
      }
      ocrTextRef.current = texts;
      setOcrState('ready');
      setMode('ocr');
      setOcrNote(res.engine ? `Read with ${String(res.engine).replace(/-/g, ' ')}.` : 'Text is ready to search.');
    } catch (e) {
      setOcrState('failed');
      setOcrNote('Couldn’t read text from this scan.');
    }
  };

  if (status === 'error') return null;   // DocPreview falls back to its download card

  const matchLabel = query.trim()
    ? (matches.length ? `${active + 1} / ${matches.length}` : '0 / 0')
    : '';

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
        <span style={{ width: 12 }} />
        <button className="btn ghost small" onClick={() => (findOpen ? closeFind() : openFind())} title="Search this document (Ctrl/⌘-F)">🔍 Find</button>
      </div>

      {findOpen && (
        <div className="row" style={{ gap: 6, alignItems: 'center', padding: '6px 8px', flexWrap: 'wrap', borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))', background: 'var(--ink-2, #2a2f36)' }}>
          <input ref={findInputRef} className="input small" style={{ maxWidth: 260 }}
            placeholder={mode === 'ocr' ? 'Search the scanned text…' : 'Search this document…'}
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
            }} />
          <span className="muted small" style={{ minWidth: 56, textAlign: 'center' }}>{matchLabel}</span>
          <button className="btn ghost small" disabled={!matches.length} onClick={() => stepMatch(-1)} title="Previous match">‹</button>
          <button className="btn ghost small" disabled={!matches.length} onClick={() => stepMatch(1)} title="Next match">›</button>
          <button className="btn ghost small" onClick={closeFind} title="Close find (Esc)">✕</button>
          {/* No text layer → offer OCR so a scanned document is still searchable. */}
          {ocrState === 'scanned' && mode === 'native' && ocr && (
            <button className="btn ghost small" onClick={runOcr} title="Read the text off this scan so you can search it">
              This looks scanned — make it searchable
            </button>
          )}
          {ocrState === 'running' && <span className="muted small">Reading the text…</span>}
          {ocrState === 'scanned' && !ocr && mode === 'native' && (
            <span className="muted small">No searchable text in this document.</span>
          )}
          {ocrNote && <span className="muted small">{ocrNote}</span>}
          {mode === 'ocr' && query.trim() && !matches.length && ocrState === 'ready' && (
            <span className="muted small">Not found in the scanned text.</span>
          )}
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll}
        style={{ flex: 1, overflow: 'auto', background: '#525659', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 10 }}>
        {status === 'loading' && <span style={{ color: '#eee', margin: 'auto' }}>Loading PDF…</span>}
        {status === 'ready' && Array.from({ length: numPages }, (_, i) => (
          <div key={i} ref={(el) => { pageRefs.current[i] = el; }}
            style={{ background: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,0.4)', minHeight: 40, flexShrink: 0, position: 'relative' }} />
        ))}
      </div>
    </div>
  );
}
