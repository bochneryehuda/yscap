import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { engineReport } from './lib/engines.js';
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
import StaffLogin from './screens/StaffLogin.jsx';
import StaffQueue from './screens/StaffQueue.jsx';
import StaffApplication from './screens/StaffApplication.jsx';
import StaffTeam from './screens/StaffTeam.jsx';
import StaffLeads from './screens/StaffLeads.jsx';
import StaffChat from './screens/StaffChat.jsx';

/* Borrower-only area. Staff who land here are bounced to their console. */
function Private({ children }) {
  const { isAuthed, isStaff } = useAuth();
  if (!isAuthed) return <Navigate to="/login" replace />;
  if (isStaff) return <Navigate to="/staff" replace />;
  return <Layout>{children}</Layout>;
}

/* Staff-only area. Borrowers who land here are bounced to their dashboard. */
function StaffPrivate({ children }) {
  const { isAuthed, isStaff } = useAuth();
  if (!isAuthed) return <Navigate to="/staff/login" replace />;
  if (!isStaff) return <Navigate to="/dashboard" replace />;
  return <StaffLayout>{children}</StaffLayout>;
}

/* Anyone hitting an unknown path: route by who they are. */
function Fallback() {
  const { isAuthed, isStaff } = useAuth();
  if (!isAuthed) return <Navigate to="/login" replace />;
  return <Navigate to={isStaff ? '/staff' : '/dashboard'} replace />;
}

export default function App() {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.info('[YS] frozen engines:', engineReport());
  }, []);
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          {/* public */}
          <Route path="/login" element={<Login />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/reset" element={<Reset />} />
          <Route path="/accept" element={<Accept />} />
          <Route path="/staff/login" element={<StaffLogin />} />

          {/* borrower */}
          <Route path="/dashboard" element={<Private><Dashboard /></Private>} />
          <Route path="/apply" element={<Private><Apply /></Private>} />
          <Route path="/apply/:draftId" element={<Private><Apply /></Private>} />
          <Route path="/app/:id" element={<Private><Application /></Private>} />
          <Route path="/profile" element={<Private><Profile /></Private>} />

          {/* staff */}
          <Route path="/staff" element={<StaffPrivate><StaffQueue /></StaffPrivate>} />
          <Route path="/staff/app/:id" element={<StaffPrivate><StaffApplication /></StaffPrivate>} />
          <Route path="/staff/team" element={<StaffPrivate><StaffTeam /></StaffPrivate>} />
          <Route path="/staff/leads" element={<StaffPrivate><StaffLeads /></StaffPrivate>} />
          <Route path="/staff/chat" element={<StaffPrivate><StaffChat /></StaffPrivate>} />

          <Route path="*" element={<Fallback />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}
