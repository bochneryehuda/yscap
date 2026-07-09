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
import Dashboard from './screens/Dashboard.jsx';
import Apply from './screens/Apply.jsx';
import Application from './screens/Application.jsx';
import Profile from './screens/Profile.jsx';
import EntitiesScreen from './screens/EntitiesScreen.jsx';
import TrackRecordScreen from './screens/TrackRecordScreen.jsx';
import NotificationSettings from './screens/NotificationSettings.jsx';
import StaffLogin from './screens/StaffLogin.jsx';
import StaffQueue from './screens/StaffQueue.jsx';
import StaffNewFile from './screens/StaffNewFile.jsx';
import StaffTasks from './screens/StaffTasks.jsx';
import StaffApplication from './screens/StaffApplication.jsx';
import StaffTeam from './screens/StaffTeam.jsx';
import StaffConditionStudio from './screens/StaffConditionStudio.jsx';
import StaffArchived from './screens/StaffArchived.jsx';
import StaffLeads from './screens/StaffLeads.jsx';
import StaffBorrowers from './screens/StaffBorrowers.jsx';
import StaffBorrowerDetail from './screens/StaffBorrowerDetail.jsx';
import StaffVendors from './screens/StaffVendors.jsx';
import StaffChat from './screens/StaffChat.jsx';
import StaffClickup from './screens/StaffClickup.jsx';

/* Borrower-only area. Internal users who land here are bounced to their console. */
function Private({ children }) {
  const { isAuthed, isStaff } = useAuth();
  if (!isAuthed) return <Navigate to="/login" replace />;
  if (isStaff) return <Navigate to="/internal" replace />;
  return <Layout>{children}</Layout>;
}

/* Internal-only area. Borrowers who land here are bounced to their dashboard. */
function StaffPrivate({ children }) {
  const { isAuthed, isStaff } = useAuth();
  if (!isAuthed) return <Navigate to="/internal/login" replace />;
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
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/reset" element={<Reset />} />
          <Route path="/accept" element={<Accept />} />
          <Route path="/internal/login" element={<StaffLogin />} />

          {/* borrower */}
          <Route path="/dashboard" element={<Private><Dashboard /></Private>} />
          <Route path="/apply" element={<Private><Apply /></Private>} />
          <Route path="/apply/:draftId" element={<Private><Apply /></Private>} />
          <Route path="/app/:id" element={<Private><Application /></Private>} />
          <Route path="/profile" element={<Private><Profile /></Private>} />
          <Route path="/entities" element={<Private><EntitiesScreen /></Private>} />
          <Route path="/track-record" element={<Private><TrackRecordScreen /></Private>} />
          <Route path="/settings/notifications" element={<Private><NotificationSettings /></Private>} />

          {/* internal console */}
          <Route path="/internal" element={<StaffPrivate><StaffQueue /></StaffPrivate>} />
          <Route path="/internal/new" element={<StaffPrivate><StaffNewFile /></StaffPrivate>} />
          <Route path="/internal/tasks" element={<StaffPrivate><StaffTasks /></StaffPrivate>} />
          <Route path="/internal/app/:id" element={<StaffPrivate><StaffApplication /></StaffPrivate>} />
          <Route path="/internal/team" element={<StaffPrivate><StaffTeam /></StaffPrivate>} />
          <Route path="/internal/conditions" element={<StaffPrivate><StaffConditionStudio /></StaffPrivate>} />
          <Route path="/internal/archived" element={<StaffPrivate><StaffArchived /></StaffPrivate>} />
          <Route path="/internal/leads" element={<StaffPrivate><StaffLeads /></StaffPrivate>} />
          <Route path="/internal/borrowers" element={<StaffPrivate><StaffBorrowers /></StaffPrivate>} />
          <Route path="/internal/borrowers/:id" element={<StaffPrivate><StaffBorrowerDetail /></StaffPrivate>} />
          <Route path="/internal/vendors" element={<StaffPrivate><StaffVendors /></StaffPrivate>} />
          <Route path="/internal/chat" element={<StaffPrivate><StaffChat /></StaffPrivate>} />
          <Route path="/internal/clickup" element={<StaffPrivate><StaffClickup /></StaffPrivate>} />

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
