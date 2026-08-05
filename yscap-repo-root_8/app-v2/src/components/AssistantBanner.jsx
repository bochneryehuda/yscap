import React from 'react';
import { useAuth } from '../lib/auth.jsx';

/* BORROWER ASSISTANT banner (owner-directed).
   A helper login can do everything in the portal EXCEPT see the borrower's
   personal details and sign documents. This bar, pinned to the top of every
   screen while a helper is signed in, makes both facts plain so a helper is
   never surprised that a field is blank or a Sign button is off. */
export default function AssistantBanner() {
  const { isAssistant, assistantOf } = useAuth();
  if (!isAssistant) return null;
  const who = assistantOf?.borrowerName || 'this borrower';
  return (
    <div className="bview-bar bview-bar--helper" role="status" aria-live="polite">
      <span className="bview-dot" aria-hidden="true" />
      <span className="bview-text">
        <strong>Helper access</strong>
        <span className="bview-sep" aria-hidden="true">·</span>
        You’re helping <strong>{who}</strong> with their loan. Personal details (like the
        Social Security number) are hidden, and only {who} can sign documents.
      </span>
    </div>
  );
}
