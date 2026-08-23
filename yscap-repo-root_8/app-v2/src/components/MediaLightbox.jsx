import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { rememberScroll, restoreRemembered } from '../lib/keep-scroll.js';

/* =====================================================================
   MediaLightbox — the ONE full-screen viewer for every photo and video in
   the system (draw inspections, appraisal photographs, dispute evidence).

   THE DEFECT THIS CLOSES (owner-reported 2026-08-23):
     · *"When you open the photos of a draw on the big large screen, you
       can't then exit it, and you can't click to see the next photo. It
       opens up in full screen, and you can't do anything."*
     · *"the video format is not readable in our system … those videos are
       blacked out. Please enable the videos … You switch from a picture to
       the next, and you see a video. You should be able to see that video
       regularly like a video player."*

   WHY IT LOOKED BROKEN. The draw galleries never had a viewer. Clicking a
   photo ran `window.open('', '_blank')` and then navigated that tab to a
   blob: URL — so the browser rendered ONE raw file, on its own, with no
   application around it. There was nothing to exit back to and nothing to
   advance to, because there was no gallery there: the user had left PILOT.
   That is not a missing button, it is a missing screen.

   WHAT THIS IS. A real viewer, in the app, over the gallery it came from:
     · ← → (and the on-screen arrows) move through the set; Home/End jump.
     · Esc, the ✕, or a click on the backdrop closes it and returns focus to
       the thumbnail that opened it — you land back where you were.
     · A photo renders as a photo. A VIDEO renders in a real <video> player
       with controls, and it is just the next item in the same set, so you
       arrow into it exactly as the owner described.
     · A filmstrip along the bottom shows where you are in the set.
     · Bytes are fetched WITH the bearer token (an <img src> cannot carry
       one) and only for what you are actually looking at, plus the two
       neighbours — so opening a gallery of forty photos does not download
       forty photos.

   ACCESSIBILITY IS NOT DECORATION HERE: this is a modal that covers the
   whole screen, so it takes focus, traps it, restores it on close, locks
   the page behind it from scrolling, and is labelled as a dialog. Without
   that, "you can't exit it" is true for a keyboard or screen-reader user
   even once the ✕ exists.

   ITEM SHAPE — `{ id, kind, path?, src?, title?, caption?, meta?, filename? }`
     kind    'image' | 'video'   (anything else renders as a download card)
     path    an AUTHENTICATED API path; fetched with the token and shown from
             an object URL. Preferred for everything behind the login.
     src     a direct URL (a pre-signed CDN link). Used as-is.
   ===================================================================== */

const Z = 4000;   // above the app's own overlays (sidebar 100s, modals 1000s)

// Object URLs for authenticated media, cached per path for the life of the
// viewer so arrowing back and forth does not refetch what we already hold.
function useAuthedMedia(items, index) {
  const [urls, setUrls] = useState({});          // path -> objectURL
  const [errs, setErrs] = useState({});          // path -> message
  const madeRef = useRef([]);
  const wantedRef = useRef(new Set());

  // Only ever fetch what is on screen and its immediate neighbours. A draw with
  // 40 photos and 3 videos would otherwise pull every byte the moment the
  // viewer opens — slow, expensive, and pointless.
  const neighbourhood = useMemo(() => {
    const out = [];
    for (let d = -1; d <= 1; d++) {
      const it = items[(index + d + items.length) % items.length];
      if (it && it.path && !it.src) out.push(it.path);
    }
    return out;
  }, [items, index]);

  useEffect(() => {
    let alive = true;
    (async () => {
      for (const path of neighbourhood) {
        if (!alive) break;
        if (wantedRef.current.has(path)) continue;
        wantedRef.current.add(path);
        try {
          const blob = await api.authedBlob(path);
          if (!alive) return;
          const u = URL.createObjectURL(blob);
          madeRef.current.push(u);
          setUrls((p) => ({ ...p, [path]: u }));
        } catch (e) {
          if (alive) setErrs((p) => ({ ...p, [path]: (e && e.message) || 'Could not load this file.' }));
          wantedRef.current.delete(path);       // let a retry happen on re-open
        }
      }
    })();
    return () => { alive = false; };
  }, [neighbourhood]);

  // Revoke every object URL exactly once, when the viewer unmounts.
  useEffect(() => () => {
    madeRef.current.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) { /* noop */ } });
    madeRef.current = [];
  }, []);

  return { urls, errs };
}

export default function MediaLightbox({ items, index = 0, onIndex, onClose, title }) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const count = list.length;
  const safeIndex = count ? ((index % count) + count) % count : 0;
  const cur = list[safeIndex];
  const { urls, errs } = useAuthedMedia(list, safeIndex);
  const shellRef = useRef(null);
  const openerRef = useRef(null);

  const go = useCallback((delta) => {
    if (!count) return;
    onIndex(((safeIndex + delta) % count + count) % count);
  }, [count, safeIndex, onIndex]);

  /* KEYBOARD. Registered on the document (capture) rather than on the shell, so
     it works no matter what inside the viewer has focus — including the <video>
     element, which swallows key events it thinks are its own. Space is left to
     the video (play/pause) when the video has focus; everywhere else it advances. */
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
      if (e.key === 'Home') { e.preventDefault(); onIndex(0); return; }
      if (e.key === 'End') { e.preventDefault(); onIndex(Math.max(0, count - 1)); return; }
      // Focus trap: Tab must not walk out of the dialog into the page behind it.
      if (e.key === 'Tab' && shellRef.current) {
        const focusables = shellRef.current.querySelectorAll(
          'button, [href], video, input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [go, onClose, onIndex, count]);

  /* Lock the page behind the viewer, and give focus to the viewer — then hand
     BOTH back to whatever opened it. "You can't exit it" is true of three things,
     not one: the overlay, the focus, and the reader's PLACE ON THE PAGE.

     That third one is the easy one to miss and it is a real defect: `overflow:
     hidden` on the body can clamp the page scroll to 0, so closing a lightbox
     opened from the eleventh draw on a long file dropped the reader back at the
     top — which is the same complaint that produced `keep-scroll` in the first
     place ("it flies down to the bottom … we need to stay where we are, always").
     `restoreRemembered` keeps asking while the page grows its images back rather
     than setting an offset once against a page that is still short. */
  useEffect(() => {
    openerRef.current = document.activeElement;
    const y = rememberScroll();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => { if (shellRef.current) shellRef.current.focus(); }, 0);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prev;
      restoreRemembered(y);
      try { if (openerRef.current && openerRef.current.focus) openerRef.current.focus(); } catch (_) { /* noop */ }
    };
  }, []);

  if (!count || !cur) return null;

  const src = cur.src || (cur.path ? urls[cur.path] : null);
  const err = cur.path ? errs[cur.path] : null;
  const isVideo = cur.kind === 'video';

  return (
    <div
      className="mlb-backdrop"
      role="dialog" aria-modal="true"
      aria-label={title || 'Media viewer'}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ zIndex: Z }}
    >
      <div className="mlb-shell" ref={shellRef} tabIndex={-1}>
        {/* ---- header: what you're looking at, where you are, and the way out ---- */}
        <div className="mlb-bar mlb-bar-top">
          <div className="mlb-title">
            <div className="mlb-title-main">{cur.title || (isVideo ? 'Inspection video' : 'Photo')}</div>
            {cur.meta ? <div className="mlb-title-sub">{cur.meta}</div> : null}
          </div>
          <div className="mlb-count" aria-live="polite">{safeIndex + 1} of {count}</div>
          {src && !isVideo ? (
            <a className="mlb-icon" href={src} download={cur.filename || 'photo'} title="Download this photo"
               onClick={(e) => e.stopPropagation()} aria-label="Download">↓</a>
          ) : null}
          <button type="button" className="mlb-icon mlb-close" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </div>

        {/* ---- the stage ---- */}
        <div className="mlb-stage">
          {count > 1 && (
            <button type="button" className="mlb-nav mlb-prev" onClick={() => go(-1)} title="Previous (←)" aria-label="Previous">‹</button>
          )}

          <div className="mlb-frame">
            {err ? (
              <div className="mlb-msg">
                <div className="mlb-msg-h">This file couldn’t be loaded.</div>
                <div className="mlb-msg-p">{err}</div>
              </div>
            ) : !src ? (
              <div className="mlb-msg"><div className="mlb-spin" aria-hidden="true" /><div className="mlb-msg-p">Loading…</div></div>
            ) : isVideo ? (
              /* A REAL PLAYER — controls, scrubbing, volume, full screen. `key` on the
                 source forces React to rebuild the element when you arrow to another
                 video, instead of leaving the previous one playing underneath. The
                 fallback text is what shows if the browser genuinely cannot decode the
                 container, so a codec problem reads as a codec problem rather than as a
                 black rectangle. */
              <video
                key={src}
                className="mlb-media"
                src={src}
                controls
                autoPlay
                playsInline
                preload="metadata"
                controlsList="nodownload"
                onClick={(e) => e.stopPropagation()}
              >
                Your browser can’t play this video format.
              </video>
            ) : (
              <img className="mlb-media" src={src} alt={cur.caption || cur.title || 'Media'} onClick={(e) => e.stopPropagation()} />
            )}
          </div>

          {count > 1 && (
            <button type="button" className="mlb-nav mlb-next" onClick={() => go(1)} title="Next (→)" aria-label="Next">›</button>
          )}
        </div>

        {cur.caption ? <div className="mlb-caption">{cur.caption}</div> : null}

        {/* ---- filmstrip: where you are in the set, and a way to jump ---- */}
        {count > 1 && (
          <div className="mlb-strip" role="tablist" aria-label="All media on this draw">
            {list.map((it, i) => {
              const thumb = it.src || (it.path ? urls[it.path] : null);
              return (
                <button
                  key={it.id != null ? it.id : i}
                  type="button" role="tab" aria-selected={i === safeIndex}
                  className={`mlb-thumb${i === safeIndex ? ' is-current' : ''}`}
                  onClick={() => onIndex(i)}
                  title={it.title || (it.kind === 'video' ? 'Video' : 'Photo')}
                >
                  {it.kind === 'video'
                    ? <span className="mlb-thumb-vid" aria-hidden="true">▶</span>
                    : thumb
                      ? <img src={thumb} alt="" loading="lazy" />
                      : <span className="mlb-thumb-blank" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The state a gallery needs to drive the viewer, so a call site is two lines
 * rather than five pieces of bookkeeping repeated on every surface.
 *
 *   const lb = useLightbox();
 *   …<button onClick={() => lb.open(items, i)}>
 *   {lb.node}
 */
export function useLightbox(title) {
  const [state, setState] = useState(null);   // { items, index }
  const open = useCallback((items, index = 0) => setState({ items, index }), []);
  const close = useCallback(() => setState(null), []);
  const node = state ? (
    <MediaLightbox
      items={state.items}
      index={state.index}
      title={title}
      onIndex={(i) => setState((s) => (s ? { ...s, index: i } : s))}
      onClose={close}
    />
  ) : null;
  return { open, close, node, isOpen: !!state };
}
