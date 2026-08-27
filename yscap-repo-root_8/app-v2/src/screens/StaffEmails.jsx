import React from 'react';
import EmailCenter from '../components/EmailCenter.jsx';
import { useAuth } from '../lib/auth.jsx';

/* Email Center (global) — the portal-wide audit mailbox the owner asked for:
   every email + notification that went out across the files the viewer can see
   (admins/underwriters: all files; loan officers/processors: their assigned
   files), with the full designed body, exactly whom it reached and when, the
   delivery status (so a failed send can be troubleshot), and the inbound
   replies. Reply to any file's thread right here. Reuses the shared EmailCenter
   component in "global" mode. */
export default function StaffEmails() {
  const { can } = useAuth();
  // The SAME signal the backend uses (see_all_files), never a hardcoded role
  // list — the old list here had drifted past the closer / coordinator /
  // processor grants (processors see the whole pipeline, owner-directed
  // 2026-08-26).
  const seesAll = can('see_all_files');
  return (
    <>
      <div className="page-head">
        <div>
          <h1 style={{ marginBottom: 4 }}>Email Center</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {seesAll
              ? 'Every email and notification going out of the portal, across all files — the full body, exactly who it reached, when, and whether it sent. Search, filter, troubleshoot, and reply.'
              : 'Every email and notification across your files — the full body, exactly who it reached, when, and whether it sent. Search, filter, and reply on any file’s thread.'}
          </p>
        </div>
      </div>
      <div className="panel" style={{ padding: 16 }}>
        <EmailCenter mode="global" />
      </div>
    </>
  );
}
