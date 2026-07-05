import React from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

const ROLE_LABEL = {
  super_admin: 'Super Admin', admin: 'Admin',
  loan_officer: 'Loan Officer', processor: 'Processor', underwriter: 'Underwriter',
};

export default function StaffLayout({ children }) {
  const { signOut, role } = useAuth();
  const nav = useNavigate();
  return (
    <div className="shell">
      <header className="header">
        <div className="wrap">
          <Link to="/staff" className="brand" aria-label="YS Capital Group — Staff" style={{ textDecoration: 'none' }}>
            <img className="brand-mark" src={import.meta.env.BASE_URL + 'brand/mark-dark.png'} alt="" />
            <span className="brand-word">YS&nbsp;CAPITAL</span>
            <span className="sub">Staff</span>
          </Link>
          <nav className="nav">
            <NavLink to="/staff">Pipeline</NavLink>
            <NavLink to="/staff/leads">Leads</NavLink>
            {(role === 'admin' || role === 'super_admin') && <NavLink to="/staff/team">Team</NavLink>}
            <span className="pill" title="Your role">{ROLE_LABEL[role] || role || 'Staff'}</span>
            <button className="btn link" onClick={() => { signOut(); nav('/staff/login'); }}>Sign out</button>
          </nav>
        </div>
      </header>
      <main className="content"><div className="wrap">{children}</div></main>
      <footer className="wrap small muted" style={{ padding: '20px', borderTop: '1px solid var(--line)' }}>
        YS Capital Group · NMLS #2609746 · Staff console · Business-purpose lending only.
      </footer>
    </div>
  );
}
