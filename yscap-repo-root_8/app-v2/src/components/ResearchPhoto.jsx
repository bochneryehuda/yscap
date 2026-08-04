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
export default function ResearchPhoto({ documentId, alt, style, onClick, className, streetAddress }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [streetOk, setStreetOk] = useState(true);
  const urlRef = useRef(null);
  // A street-level picture is only worth trying when there is no appraisal photo
  // and we have an address to ask about.
  useEffect(() => { setStreetOk(true); }, [streetAddress]);
  const street = streetAddress && streetOk ? String(streetAddress) : null;

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

  /* NO APPRAISAL PHOTO? SHOW THE STREET, AND SAY THAT IS WHAT IT IS.
   *
   * Most warehouse properties carry a photograph an appraiser took; some carry
   * none, and a grey box tells an officer nothing about a house. Street View
   * fills that in — served through our own proxy so the key stays on the server,
   * and rendering NOTHING when no key is configured, so the layout is unchanged
   * until one is.
   *
   * IT IS ALWAYS LABELLED, and that is not decoration. An appraiser's photo is
   * evidence of the property ON THE DAY OF THE REPORT and is what the condition
   * grade was written from. A street-level image is a car that drove past at some
   * point, possibly years before or after, from the road only. Presenting the two
   * the same way invites somebody to read a tidy front garden as evidence of
   * condition. So the appraisal photo is never replaced by one — this is only
   * ever the fallback when there is no photo at all — and it carries a corner
   * label saying where it came from.
   */
  if ((!documentId || failed) && street) {
    return (
      <div className={className} style={{ ...style, position: 'relative', overflow: 'hidden' }}>
        {/* LAZY, AND THAT IS A COST DECISION AS MUCH AS A SPEED ONE. Street View
            Static is billed per request, so a 25-row comparable list where most
            properties carry no appraisal photo would fire 25 billable calls on
            every page view — including the rows nobody scrolls to. `loading=lazy`
            makes the browser ask only for what is actually looked at. (With no key
            configured the proxy 404s and none of this costs anything.) */}
        <img src={'/api/address/photo?q=' + encodeURIComponent(street)}
          alt={`Street view of ${street}`}
          loading="lazy"
          onError={() => setStreetOk(false)}
          onClick={onClick}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <span style={{ position: 'absolute', left: 0, bottom: 0, right: 0, background: 'rgba(20,27,34,.72)',
          color: '#fff', font: '600 9.5px/1.35 system-ui', padding: '2px 4px', letterSpacing: '.02em' }}>
          STREET VIEW · not an appraisal photo
        </span>
      </div>
    );
  }

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
    return <div className={className} style={{ ...style, background: '#F4F1EA', cursor: 'default' }}
      aria-busy={documentId ? 'true' : undefined} />;
  }

  return <img src={url} alt={alt || 'Property photo'} className={className} style={style} onClick={onClick} />;
}
