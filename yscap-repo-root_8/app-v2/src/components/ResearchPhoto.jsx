import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { MUTED } from '../lib/research.js';

/* A property photo out of the research warehouse.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT AN <img src="/api/...">:
 * every binary on this platform is served behind a Bearer token, and a browser
 * image request carries NO Authorization header — `authenticate()` reads the
 * token only from `req.get('authorization')`. So pointing an <img> at an API
 * path is a guaranteed 401 and a broken-image icon for every user, including
 * one who is perfectly entitled to the picture. That shipped once and made the
 * whole photo half of the property page dead.
 *
 * Same rule, and the same fix, as components/DocPreview.jsx: fetch the bytes
 * with the authenticated loader and render them from an object URL. The URL is
 * revoked on unmount and whenever the document changes, or a page of thumbnails
 * leaks a blob each time it re-renders.
 */
export default function ResearchPhoto({ documentId, alt, style, onClick, className }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    // Drop the previous picture's blob before asking for the next one.
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setUrl(null);
    if (!documentId) return undefined;

    api.researchPhotoBlob(documentId)
      .then(({ blob }) => {
        if (!alive) return;
        const u = URL.createObjectURL(blob);
        urlRef.current = u;
        setUrl(u);
      })
      .catch(() => { if (alive) setFailed(true); });

    return () => {
      alive = false;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
  }, [documentId]);

  // A photo we could not load says so quietly in the same box — never a broken
  // image icon, and never a silently empty gap where a picture should be.
  if (failed) {
    return (
      <div className={className} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#F4F1EA', color: MUTED, fontSize: 11, textAlign: 'center', padding: 6, cursor: 'default' }}>
        Photo unavailable
      </div>
    );
  }

  if (!url) {
    return <div className={className} style={{ ...style, background: '#F4F1EA', cursor: 'default' }} aria-busy="true" />;
  }

  return <img src={url} alt={alt || 'Property photo'} className={className} style={style} onClick={onClick} />;
}
