import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App />);

// Register the PWA service worker so the portal is installable and opens fast.
// It caches only the static shell — never API/auth/PII (see public/sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}
