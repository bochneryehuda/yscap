import React, { useEffect, useState } from 'react';

/* Street-level photo of the subject property, served by our backend proxy
   (/api/address/photo). Renders nothing until imagery is available — so with
   no Google key configured (or no coverage) the layout is unchanged. */
export default function PropertyPhoto({ address, height = 170, radius = 12 }) {
  const [ok, setOk] = useState(true);
  // Retry when the address changes — a prior no-imagery address used to hide
  // the photo permanently for every later (valid) address on this instance.
  useEffect(() => { setOk(true); }, [address]);
  if (!address || !ok) return null;
  return (
    <img
      src={'/api/address/photo?q=' + encodeURIComponent(address)}
      alt={'Property: ' + address}
      onError={() => setOk(false)}
      style={{ width: '100%', height, objectFit: 'cover', borderRadius: radius,
               border: '1px solid var(--line, #2A3742)', display: 'block', marginBottom: 14 }}
    />
  );
}
