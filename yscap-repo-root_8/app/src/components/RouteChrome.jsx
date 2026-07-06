import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/* Per-navigation housekeeping the router doesn't do on its own:
   - HashRouter keeps the scroll position across navigations, so leaving a
     long page landed the user mid-screen on the next one. Reset to top.
   - Give each screen its own document/history title. */
const TITLES = [
  [/^\/login/, 'Sign in'],
  [/^\/verify/, 'Verify your email'],
  [/^\/forgot/, 'Reset password'],
  [/^\/reset/, 'Choose a new password'],
  [/^\/accept/, 'Accept invitation'],
  [/^\/dashboard/, 'Dashboard'],
  [/^\/apply/, 'New application'],
  [/^\/app\//, 'Loan file'],
  [/^\/profile/, 'Profile'],
  [/^\/track-record/, 'Track record'],
  [/^\/settings\/notifications/, 'Notification settings'],
  [/^\/internal\/login/, 'Team sign in'],
  [/^\/internal\/new/, 'New file'],
  [/^\/internal\/tasks/, 'My tasks'],
  [/^\/internal\/app\//, 'Loan file'],
  [/^\/internal\/team/, 'Team'],
  [/^\/internal\/leads/, 'Leads'],
  [/^\/internal\/vendors/, 'Vendors'],
  [/^\/internal\/chat/, 'Chat'],
  [/^\/internal/, 'Pipeline'],
];

export default function RouteChrome() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    const hit = TITLES.find(([re]) => re.test(pathname));
    document.title = hit ? `${hit[1]} — YS Capital Group` : 'YS Capital Group — Portal';
  }, [pathname]);
  return null;
}
