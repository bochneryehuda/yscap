import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { engineReport } from './lib/engines.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import RouteChrome from './components/RouteChrome.jsx';
import Layout from './components/Layout.jsx';
import StaffLayout from './components/StaffLayout.jsx';
import Login from './screens/Login.jsx';
import Verify from './screens/Verify.jsx';
import Forgot from './screens/Forgot.jsx';
import Reset from './screens/Reset.jsx';
import Accept from './screens/Accept.jsx';
import GuestChat from './screens/GuestChat.jsx';
import DrawAccept from './screens/DrawAccept.jsx';
import EsignDone from './screens/EsignDone.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Apply from './screens/Apply.jsx';
import Application from './screens/Application.jsx';
import Profile from './screens/Profile.jsx';
import EntitiesScreen from './screens/EntitiesScreen.jsx';
import TrackRecordScreen from './screens/TrackRecordScreen.jsx';
import PricingStudio from './screens/PricingStudio.jsx';
import NotificationSettings from './screens/NotificationSettings.jsx';
import StaffLogin from './screens/StaffLogin.jsx';
import StaffQueue from './screens/StaffQueue.jsx';
import StaffNewFile from './screens/StaffNewFile.jsx';
import StaffTasks from './screens/StaffTasks.jsx';
import StaffApplication from './screens/StaffApplication.jsx';
import StaffTeam from './screens/StaffTeam.jsx';
import StaffConditionStudio from './screens/StaffConditionStudio.jsx';
import StaffCompanyPricing from './screens/StaffCompanyPricing.jsx';
import StaffArchived from './screens/StaffArchived.jsx';
import StaffLeads from './screens/StaffLeads.jsx';
import StaffLeadDetail from './screens/StaffLeadDetail.jsx';
import StaffBorrowers from './screens/StaffBorrowers.jsx';
import StaffEmails from './screens/StaffEmails.jsx';
import StaffBorrowerDetail from './screens/StaffBorrowerDetail.jsx';
import StaffVendors from './screens/StaffVendors.jsx';
import StaffChat from './screens/StaffChat.jsx';
import StaffClickup from './screens/StaffClickup.jsx';
import StaffDraws from './screens/StaffDraws.jsx';
import StaffFileDraws from './screens/StaffFileDraws.jsx';
import StaffDrawRules from './screens/StaffDrawRules.jsx';
import StaffAuditLog from './screens/StaffAuditLog.jsx';
import SyncReviews from './screens/SyncReviews.jsx';
import EsignDashboard from './screens/EsignDashboard.jsx';

/* Borrower-only area. Internal users who land here are bounced to their console.
   An unauthenticated hit carries the intended route through sign-in (`from`) so
   an email deep-link (e.g. a chat conversation) lands ON its target after login
   instead of dumping the user on the portal home (owner-reported 2026-07-14). */
function Private({ children }) {
  const { isAuthed, isStaff } = useAuth();
  const loc = useLocation();
  if (!isAuthed) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  if (isStaff) return <Navigate to="/internal" replace />;
  return <Layout>{children}</Layout>;
}

/* Internal-only area. Borrowers who land here are bounced to their dashboard. */
function StaffPrivate({ children }) {
  const { isAuthed, isStaff } = useAuth();
  const loc = useLocation();
  if (!isAuthed) return <Navigate to="/internal/login" state={{ from: loc.pathname + loc.search }} replace />;
  if (!isStaff) return <Navigate to="/dashboard" replace />;
  return <StaffLayout>{children}</StaffLayout>;
}

/* Anyone hitting an unknown path: route by who they are. */
function Fallback() {
  const { isAuthed, isStaff } = useAuth();
  if (!isAuthed) return <Navigate to="/login" replace />;
  return <Navigate to={isStaff ? '/internal' : '/dashboard'} replace />;
}

/* The internal console used to live under /staff — keep old links (emails,
   bookmarks, stored notifications) working by rewriting them to /internal. */
function LegacyStaffRedirect() {
  const loc = useLocation();
  return <Navigate to={loc.pathname.replace(/^\/staff/, '/internal') + loc.search} replace />;
}

export default function App() {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.info('[YS] frozen engines:', engineReport());
  }, []);
  return (
    <AuthProvider>
      <HashRouter>
        <RouteChrome />
        <ErrorBoundary>
        <Routes>
          {/* public */}
          <Route path="/login" element={<Login />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/forgot" element={<Forgot scope="borrower" />} />
          <Route path="/reset" element={<Reset />} />
          <Route path="/accept" element={<Accept />} />
          {/* #75 — magic-link guest chat for external email participants (no login). */}
          <Route path="/guest/:key" element={<GuestChat />} />
          <Route path="/draw-accept/:token" element={<DrawAccept />} />
          {/* Where a borrower lands after signing from PILOT's branded e-sign email —
              exchanges the one-time login code so they return INSIDE their file logged in. */}
          <Route path="/esign/done" element={<EsignDone />} />
          <Route path="/internal/login" element={<StaffLogin />} />
          {/* Staff console has its OWN reset screen so a dual borrower+staff
              account is never sent two different reset emails (owner 2026-07-14). */}
          <Route path="/internal/forgot" element={<Forgot scope="staff" />} />

          {/* borrower */}
          <Route path="/dashboard" element={<Private><Dashboard /></Private>} />
          <Route path="/apply" element={<Private><Apply /></Private>} />
          <Route path="/apply/:draftId" element={<Private><Apply /></Private>} />
          <Route path="/app/:id" element={<Private><Application /></Private>} />
          <Route path="/profile" element={<Private><Profile /></Private>} />
          <Route path="/entities" element={<Private><EntitiesScreen /></Private>} />
          <Route path="/track-record" element={<Private><TrackRecordScreen /></Private>} />
          <Route path="/pricing" element={<Private><PricingStudio /></Private>} />
          <Route path="/settings/notifications" element={<Private><NotificationSettings /></Private>} />

          {/* internal console */}
          <Route path="/internal" element={<StaffPrivate><StaffQueue /></StaffPrivate>} />
          <Route path="/internal/new" element={<StaffPrivate><StaffNewFile /></StaffPrivate>} />
          <Route path="/internal/tasks" element={<StaffPrivate><StaffTasks /></StaffPrivate>} />
          <Route path="/internal/app/:id" element={<StaffPrivate><StaffApplication /></StaffPrivate>} />
          <Route path="/internal/app/:id/draws" element={<StaffPrivate><StaffFileDraws /></StaffPrivate>} />
          <Route path="/internal/team" element={<StaffPrivate><StaffTeam /></StaffPrivate>} />
          <Route path="/internal/conditions" element={<StaffPrivate><StaffConditionStudio /></StaffPrivate>} />
          <Route path="/internal/pricing" element={<StaffPrivate><StaffCompanyPricing /></StaffPrivate>} />
          <Route path="/internal/archived" element={<StaffPrivate><StaffArchived /></StaffPrivate>} />
          <Route path="/internal/leads" element={<StaffPrivate><StaffLeads /></StaffPrivate>} />
          <Route path="/internal/leads/:id" element={<StaffPrivate><StaffLeadDetail /></StaffPrivate>} />
          <Route path="/internal/emails" element={<StaffPrivate><StaffEmails /></StaffPrivate>} />
          <Route path="/internal/borrowers" element={<StaffPrivate><StaffBorrowers /></StaffPrivate>} />
          <Route path="/internal/borrowers/:id" element={<StaffPrivate><StaffBorrowerDetail /></StaffPrivate>} />
          <Route path="/internal/vendors" element={<StaffPrivate><StaffVendors /></StaffPrivate>} />
          <Route path="/internal/chat" element={<StaffPrivate><StaffChat /></StaffPrivate>} />
          <Route path="/internal/clickup" element={<StaffPrivate><StaffClickup /></StaffPrivate>} />
          <Route path="/internal/draws" element={<StaffPrivate><StaffDraws /></StaffPrivate>} />
          <Route path="/internal/draw-rules" element={<StaffPrivate><StaffDrawRules /></StaffPrivate>} />
          <Route path="/internal/audit" element={<StaffPrivate><StaffAuditLog /></StaffPrivate>} />
          <Route path="/internal/sync-reviews" element={<StaffPrivate><SyncReviews /></StaffPrivate>} />
          <Route path="/internal/esign" element={<StaffPrivate><EsignDashboard /></StaffPrivate>} />

          {/* legacy /staff/* deep links (old emails, bookmarks) → /internal/* */}
          <Route path="/staff" element={<LegacyStaffRedirect />} />
          <Route path="/staff/*" element={<LegacyStaffRedirect />} />

          <Route path="*" element={<Fallback />} />
        </Routes>
        </ErrorBoundary>
      </HashRouter>
    </AuthProvider>
  );
}
