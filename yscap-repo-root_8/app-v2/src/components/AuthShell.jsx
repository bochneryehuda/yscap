import React from 'react';
import { BrandLockup } from './Layout.jsx';

/* Centered branded card used by the public auth screens
   (verify, forgot, reset, accept). Mirrors the Login layout. */
export default function AuthShell({ title, subtitle, children }) {
  return (
    <div className="authbg">
      <div className="authcard panel">
        <BrandLockup />
        <div className="gold-rule" />
        {title && <h1>{title}</h1>}
        {subtitle && <p className="muted small" style={{ marginTop: 6 }}>{subtitle}</p>}
        <div style={{ marginTop: 18 }}>{children}</div>
      </div>
    </div>
  );
}
