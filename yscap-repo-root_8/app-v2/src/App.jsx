import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { engineReport } from './lib/engines.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import RouteChrome from './components/RouteChrome.jsx';
import AppDialogHost from './components/AppDialog.jsx';
import Layout from './components/Layout.jsx';
import StaffLayout from './components/StaffLayout.jsx';
import Login from './screens/Login.jsx';
import Verify from './screens/Verify.jsx';
import Forgot from './screens/Forgot.jsx';
import Reset from './screens/Reset.jsx';
import Accept from './screens/Accept.jsx';
import AssistantAccept from './screens/AssistantAccept.jsx';
import Helpers from './screens/Helpers.jsx';
import GuestChat from './screens/GuestChat.jsx';
import GuestConditions from './screens/GuestConditions.jsx';
import DrawAccept from './screens/DrawAccept.jsx';
import AcceptTerms from './screens/AcceptTerms.jsx';
import EsignDone from './screens/EsignDone.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Tasks from './screens/Tasks.jsx';
import Apply from './screens/Apply.jsx';
import Application from './screens/Application.jsx';
import Profile from './screens/Profile.jsx';
import EntitiesScreen from './screens/EntitiesScreen.jsx';
import TrackRecordScreen from './screens/TrackRecordScreen.jsx';
import PricingStudio from './screens/PricingStudio.jsx';
import NotificationSettings from './screens/NotificationSettings.jsx';
// LONG-TERM (the second product). Its screens live in their own folder and import
// nothing from RTL; this is the mount seam the owner authorized on 2026-08-14
// ("rtl-import app-v2/src/App.jsx" in docs/LONG-TERM-AUTHORIZED-COPIES.md).
import LtPipeline from './longterm/LtPipeline.jsx';
import LtPeople from './longterm/LtPeople.jsx';
import LtArchive from './longterm/LtArchive.jsx';
import LtBook from './longterm/LtBook.jsx';
import LtBorrowers from './longterm/LtBorrowers.jsx';
import LtStatuses from './longterm/LtStatuses.jsx';
import LtStatusReviews from './longterm/LtStatusReviews.jsx';
import BorrowerLongTermScreen from './longterm/BorrowerLongTerm.jsx';
import LtConditions from './longterm/LtConditions.jsx';
import LtSync from './longterm/LtSync.jsx';
import LtSettings from './longterm/LtSettings.jsx';
import LtPpe from './longterm/LtPpe.jsx';
import LtPricer from './longterm/LtPricer.jsx';
// The COMBINED PRICING ENGINE — a second engine beside the one above, super-admin only while the
// owner audits it (2026-08-30). LtCombinedPricer.jsx is a deliberate fork of LtPricer.jsx; see its
// own header and scripts/test-lt-combined-pricer-fork.mjs.
import LtCombinedPricer from './longterm/LtCombinedPricer.jsx';
import LtCombinedSettings from './longterm/LtCombinedSettings.jsx';
import LtScenarios from './longterm/LtScenarios.jsx';
import LtSheetLookup from './longterm/LtSheetLookup.jsx';
import LtReports from './longterm/LtReports.jsx';
import LtConditionLibrary from './longterm/LtConditionLibrary.jsx';
import LtLoan from './longterm/LtLoan.jsx';
import StaffLogin from './screens/StaffLogin.jsx';
import StaffQueue from './screens/StaffQueue.jsx';
import StaffTrackRecordWorkspace from './screens/StaffTrackRecordWorkspace.jsx';
import StaffNewFile from './screens/StaffNewFile.jsx';
import StaffTasks from './screens/StaffTasks.jsx';
import StaffWorkflow from './screens/StaffWorkflow.jsx';
import StaffApplication from './screens/StaffApplication.jsx';
import StaffTeam from './screens/StaffTeam.jsx';
import StaffTpoFirms from './screens/StaffTpoFirms.jsx';
import StaffElementix from './screens/StaffElementix.jsx';
import StaffConditionStudio from './screens/StaffConditionStudio.jsx';
import StaffCompanyPricing from './screens/StaffCompanyPricing.jsx';
import StaffApprovals from './screens/StaffApprovals.jsx';
import StaffSettings from './screens/StaffSettings.jsx';
import StaffTrainingProposals from './screens/StaffTrainingProposals.jsx';
import StaffLabelingConsole from './screens/StaffLabelingConsole.jsx';
import StaffAiAdminInbox from './screens/StaffAiAdminInbox.jsx';
import StaffAiSilencedCodes from './screens/StaffAiSilencedCodes.jsx';
import StaffInsightsDashboard from './screens/StaffInsightsDashboard.jsx';
import StaffAiCenter from './screens/StaffAiCenter.jsx';
import StaffArchived from './screens/StaffArchived.jsx';
import StaffLeads from './screens/StaffLeads.jsx';
import StaffCrmDesk from './screens/StaffCrmDesk.jsx';
import StaffLeadDetail from './screens/StaffLeadDetail.jsx';
import StaffBorrowers from './screens/StaffBorrowers.jsx';
import StaffEmails from './screens/StaffEmails.jsx';
import StaffOrders from './screens/StaffOrders.jsx';
import StaffInvestorSuite from './screens/StaffInvestorSuite.jsx';
import StaffBorrowerDetail from './screens/StaffBorrowerDetail.jsx';
import StaffBorrowerView from './screens/StaffBorrowerView.jsx';
import StaffTpoView from './screens/StaffTpoView.jsx';
import StaffCobrowse from './screens/StaffCobrowse.jsx';
import CobrowseHost from './components/CobrowseHost.jsx';
import StaffVendors from './screens/StaffVendors.jsx';
// The research desk: the property / comparable / appraiser database (db/409) and
// the build-your-own valuation grid (db/410).
import StaffDashboards from './screens/StaffDashboards.jsx';
import StaffDashboard from './screens/StaffDashboard.jsx';
import StaffPropertyResearch from './screens/StaffPropertyResearch.jsx';
import StaffCompSearch from './screens/StaffCompSearch.jsx';
import StaffMarket from './screens/StaffMarket.jsx';
import StaffAdjustments from './screens/StaffAdjustments.jsx';
import StaffPropertyDetail from './screens/StaffPropertyDetail.jsx';
import StaffAppraisers from './screens/StaffAppraisers.jsx';
import StaffAppraiserDetail from './screens/StaffAppraiserDetail.jsx';
import StaffValuation from './screens/StaffValuation.jsx';
import StaffCompReportScreen from './screens/StaffCompReportScreen.jsx';
import StaffQuickAnswer from './screens/StaffQuickAnswer.jsx';
import StaffMarketAreas from './screens/StaffMarketAreas.jsx';
import StaffChat from './screens/StaffChat.jsx';
import StaffClickup from './screens/StaffClickup.jsx';
import StaffApiHealth from './screens/StaffApiHealth.jsx';
import StaffReports from './screens/StaffReports.jsx';
import StaffPipelineShadow from './screens/StaffPipelineShadow.jsx';
import StaffDraws from './screens/StaffDraws.jsx';
import StaffClosing from './screens/StaffClosing.jsx';
import StaffPurchasing from './screens/StaffPurchasing.jsx';
import StaffFileDraws from './screens/StaffFileDraws.jsx';
import StaffDrawRules from './screens/StaffDrawRules.jsx';
import StaffTapes from './screens/StaffTapes.jsx';
import StaffAuditLog from './screens/StaffAuditLog.jsx';
import EsignDashboard from './screens/EsignDashboard.jsx';
import StaffNotificationCenter from './screens/StaffNotificationCenter.jsx';
// THE ARENA — the live staff game board. The ROUTE always exists; what decides
// whether anybody can use it is the server's master switch, which answers 404
// to every /api/arena call while it is off, so the screen simply says there is
// nothing here. Gating the route itself in the browser would put a second copy
// of that rule somewhere it could drift.
import StaffArena from './screens/StaffArena.jsx';
// TPO (broker) portal — the third front door (kind='tpo', firm-scoped).
import TpoLayout from './components/TpoLayout.jsx';
import TpoLogin from './screens/TpoLogin.jsx';
import TpoAccept from './screens/TpoAccept.jsx';
import TpoPipeline from './screens/TpoPipeline.jsx';
import TpoTeam from './screens/TpoTeam.jsx';
import TpoNewLoan from './screens/TpoNewLoan.jsx';
import TpoBorrowers from './screens/TpoBorrowers.jsx';
import TpoBorrowerDetail from './screens/TpoBorrowerDetail.jsx';
import TpoFile from './screens/TpoFile.jsx';

/* Borrower-only area. Internal users who land here are bounced to their console.
   An unauthenticated hit carries the intended route through sign-in (`from`) so
   an email deep-link (e.g. a chat conversation) lands ON its target after login
   instead of dumping the user on the portal home (owner-reported 2026-07-14). */
function Private({ children }) {
  const { isAuthed, isStaff, isTpo } = useAuth();
  const loc = useLocation();
  if (!isAuthed) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  if (isStaff) return <Navigate to="/internal" replace />;
  if (isTpo) return <Navigate to="/tpo" replace />;
  return <Layout>{children}</Layout>;
}

/* Internal-only area. Borrowers who land here are bounced to their dashboard. */
function StaffPrivate({ children }) {
  const { isAuthed, isStaff, isTpo } = useAuth();
  const loc = useLocation();
  if (!isAuthed) return <Navigate to="/internal/login" state={{ from: loc.pathname + loc.search }} replace />;
  if (isTpo) return <Navigate to="/tpo" replace />;
  if (!isStaff) return <Navigate to="/dashboard" replace />;
  return <StaffLayout>{children}</StaffLayout>;
}

/* Broker (TPO) area. Anyone who is not a signed-in external broker is bounced to
   their own door — a borrower to their dashboard, a staffer to the console. */
function TpoPrivate({ children }) {
  const { isAuthed, isTpo, isStaff } = useAuth();
  const loc = useLocation();
  if (!isAuthed) return <Navigate to="/tpo/login" state={{ from: loc.pathname + loc.search }} replace />;
  if (isStaff) return <Navigate to="/internal" replace />;
  if (!isTpo) return <Navigate to="/dashboard" replace />;
  return <TpoLayout>{children}</TpoLayout>;
}

/* Anyone hitting an unknown path: route by who they are. */
function Fallback() {
  const { isAuthed, isStaff, isTpo } = useAuth();
  if (!isAuthed) return <Navigate to="/login" replace />;
  return <Navigate to={isStaff ? '/internal' : isTpo ? '/tpo' : '/dashboard'} replace />;
}

/* The internal console used to live under /staff — keep old links (emails,
   bookmarks, stored notifications) working by rewriting them to /internal. */
function LegacyStaffRedirect() {
  const loc = useLocation();
  return <Navigate to={loc.pathname.replace(/^\/staff/, '/internal') + loc.search} replace />;
}

/* Old standalone approval routes → the Approvals hub (owner-directed 2026-07-31),
   PRESERVING the incoming query string — StaffExceptions deep-links carry ?app=<id>
   (notification emails link them) — then appending the hub tab. Mirrors the
   /internal/training → /internal/ai redirect pattern, plus the query carry-over. */
function RedirectWithQuery({ to, tab }) {
  const loc = useLocation();
  const merged = new URLSearchParams(loc.search);
  merged.set('tab', tab);
  return <Navigate to={`${to}?${merged.toString()}`} replace />;
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
        {/* PILOT's own message box. Mounted ONCE, here, for two reasons: it
            covers every screen including the public ones (login, e-sign, guest
            chat), and it sits OUTSIDE the ErrorBoundary so a screen that
            crashes cannot take the dialog down with it. Without a mounted host
            lib/dialog falls back to the browser's native box, so a message is
            never swallowed — see the note in that file. */}
        <AppDialogHost />
        {/* CO-BROWSE, guest side (owner-directed 2026-09-02). Mounted once, beside the
            dialog host and outside the ErrorBoundary for the same reasons: the consent
            prompt and the "X is watching" banner must reach every signed-in screen —
            a borrower's portal as much as a teammate's console — and must survive a
            screen that crashes. It draws nothing until a request arrives. */}
        <CobrowseHost />
        <ErrorBoundary>
        <Routes>
          {/* public */}
          <Route path="/login" element={<Login />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/forgot" element={<Forgot scope="borrower" />} />
          <Route path="/reset" element={<Reset />} />
          <Route path="/accept" element={<Accept />} />
          <Route path="/assistant/accept" element={<AssistantAccept />} />
          {/* A borrower's helper signs in on the ONE client login screen — the
              server recognizes their credentials there (owner-directed
              2026-08-09). The separate helper sign-in screen is gone; this
              redirect keeps an old bookmark or a saved link working. */}
          <Route path="/assistant/login" element={<Navigate to="/login" replace />} />
          {/* #75 — magic-link guest chat for external email participants (no login). */}
          {/* The login-free condition center (owner-directed 2026-08-28) MUST be
              matched BEFORE /guest/:key, or its path reads as a chat key. */}
          <Route path="/guest/conditions" element={<GuestConditions />} />
          <Route path="/guest/:key" element={<GuestChat />} />
          <Route path="/draw-accept/:token" element={<DrawAccept />} />
          {/* An officer's emailed term sheet: see the terms, create a password,
              answer two questions, and land in a file already carrying them
              (owner-directed 2026-08-07). PUBLIC — nobody has an account yet. */}
          <Route path="/accept-terms/:token" element={<AcceptTerms />} />
          {/* Where a borrower lands after signing from PILOT's branded e-sign email —
              exchanges the one-time login code so they return INSIDE their file logged in. */}
          <Route path="/esign/done" element={<EsignDone />} />
          <Route path="/internal/login" element={<StaffLogin />} />
          {/* Staff console has its OWN reset screen so a dual borrower+staff
              account is never sent two different reset emails (owner 2026-07-14). */}
          <Route path="/internal/forgot" element={<Forgot scope="staff" />} />
          {/* TPO (broker) portal — the third front door. Public entry points. */}
          <Route path="/tpo/login" element={<TpoLogin />} />
          <Route path="/tpo/accept" element={<TpoAccept />} />

          {/* borrower */}
          <Route path="/dashboard" element={<Private><Dashboard /></Private>} />
          {/* The CLIENT's long-term side. Its own page rather than a panel on the
              dashboard, because the authorization ledger lets this router MOUNT
              long-term code and says plainly that no other RTL screen may import
              an LT component. It also matches the staff switch, which has always
              moved between two sides rather than folding one into the other. */}
          <Route path="/long-term" element={<Private><BorrowerLongTermScreen /></Private>} />
          <Route path="/tasks" element={<Private><Tasks /></Private>} />
          <Route path="/apply" element={<Private><Apply /></Private>} />
          <Route path="/apply/:draftId" element={<Private><Apply /></Private>} />
          <Route path="/app/:id" element={<Private><Application /></Private>} />
          <Route path="/profile" element={<Private><Profile /></Private>} />
          <Route path="/helpers" element={<Private><Helpers /></Private>} />
          <Route path="/entities" element={<Private><EntitiesScreen /></Private>} />
          <Route path="/track-record" element={<Private><TrackRecordScreen /></Private>} />
          <Route path="/pricing" element={<Private><PricingStudio /></Private>} />
          <Route path="/settings/notifications" element={<Private><NotificationSettings /></Private>} />

          {/* broker (TPO) portal */}
          <Route path="/tpo" element={<TpoPrivate><TpoPipeline /></TpoPrivate>} />
          <Route path="/tpo/new" element={<TpoPrivate><TpoNewLoan /></TpoPrivate>} />
          <Route path="/tpo/file/:id" element={<TpoPrivate><TpoFile /></TpoPrivate>} />
          <Route path="/tpo/borrowers" element={<TpoPrivate><TpoBorrowers /></TpoPrivate>} />
          <Route path="/tpo/borrower/:id" element={<TpoPrivate><TpoBorrowerDetail /></TpoPrivate>} />
          <Route path="/tpo/team" element={<TpoPrivate><TpoTeam /></TpoPrivate>} />

          {/* internal console */}
          <Route path="/internal" element={<StaffPrivate><StaffQueue /></StaffPrivate>} />
          {/* LONG-TERM — the second product's own screens, under their own prefix.
              Nothing here is merged into an RTL screen; the top-bar switch moves
              between the two sides. */}
          <Route path="/internal/lt" element={<StaffPrivate><LtPipeline /></StaffPrivate>} />
          <Route path="/internal/lt/book" element={<StaffPrivate><LtBook /></StaffPrivate>} />
          <Route path="/internal/lt/people" element={<StaffPrivate><LtPeople /></StaffPrivate>} />
          <Route path="/internal/lt/archive" element={<StaffPrivate><LtArchive /></StaffPrivate>} />
          <Route path="/internal/lt/borrowers" element={<StaffPrivate><LtBorrowers /></StaffPrivate>} />
          <Route path="/internal/lt/statuses" element={<StaffPrivate><LtStatuses /></StaffPrivate>} />
          <Route path="/internal/lt/status-reviews" element={<StaffPrivate><LtStatusReviews /></StaffPrivate>} />
          <Route path="/internal/lt/conditions" element={<StaffPrivate><LtConditions /></StaffPrivate>} />
          <Route path="/internal/lt/reports" element={<StaffPrivate><LtReports /></StaffPrivate>} />
          <Route path="/internal/lt/condition-library" element={<StaffPrivate><LtConditionLibrary /></StaffPrivate>} />
          <Route path="/internal/lt/sync" element={<StaffPrivate><LtSync /></StaffPrivate>} />
          <Route path="/internal/lt/settings" element={<StaffPrivate><LtSettings /></StaffPrivate>} />
          <Route path="/internal/lt/ppe" element={<StaffPrivate><LtPpe /></StaffPrivate>} />
          {/* THE PRICING ENGINE. Staff-only, and the investor name is why: every line on it
              names a lender and an investor, and an investor name never reaches a borrower
              or a TPO. It is inside StaffPrivate and the API sits behind the staff guard. */}
          <Route path="/internal/lt/pricer" element={<StaffPrivate><LtPricer /></StaffPrivate>} />
          {/* THE COMBINED PRICING ENGINE and its settings — a SECOND engine beside the one above,
              never on top of it (owner-directed 2026-08-30). Both are SUPER ADMIN ONLY: the server
              answers 404 to every other role and the nav entries are hidden, so the route being
              reachable by URL still lands on a screen that can read nothing. The route is left
              inside the ordinary StaffPrivate rather than gated again here for exactly that
              reason — a second gate in the browser would be a second place the rule lives, and the
              one that drifts is never the server's. */}
          <Route path="/internal/lt/combined" element={<StaffPrivate><LtCombinedPricer /></StaffPrivate>} />
          <Route path="/internal/lt/combined-settings" element={<StaffPrivate><LtCombinedSettings /></StaffPrivate>} />
          <Route path="/internal/lt/scenarios" element={<StaffPrivate><LtScenarios /></StaffPrivate>} />
          {/* PULL UP A TERM SHEET BY ITS ID. Staff-only for the same reason the
              pricer is: it shows which investor was really behind each price, and
              an investor name never reaches a borrower or a TPO. */}
          <Route path="/internal/lt/sheets" element={<StaffPrivate><LtSheetLookup /></StaffPrivate>} />
          <Route path="/internal/lt/loan/:loanId" element={<StaffPrivate><LtLoan /></StaffPrivate>} />
          <Route path="/internal/new" element={<StaffPrivate><StaffNewFile /></StaffPrivate>} />
          <Route path="/internal/tasks" element={<StaffPrivate><StaffTasks /></StaffPrivate>} />
          <Route path="/internal/workflow" element={<StaffPrivate><StaffWorkflow /></StaffPrivate>} />
          <Route path="/internal/app/:id" element={<StaffPrivate><StaffApplication /></StaffPrivate>} />
          <Route path="/internal/app/:id/draws" element={<StaffPrivate><StaffFileDraws /></StaffPrivate>} />
          <Route path="/internal/team" element={<StaffPrivate><StaffTeam /></StaffPrivate>} />
          <Route path="/internal/tpo-firms" element={<StaffPrivate><StaffTpoFirms /></StaffPrivate>} />
          <Route path="/internal/elementix" element={<StaffPrivate><StaffElementix /></StaffPrivate>} />
          <Route path="/internal/conditions" element={<StaffPrivate><StaffConditionStudio /></StaffPrivate>} />
          <Route path="/internal/pricing" element={<StaffPrivate><StaffCompanyPricing /></StaffPrivate>} />
          {/* Approvals hub — every queue waiting on a decision, in one tabbed section
              (owner-directed 2026-07-31). Embeds the escalation/exception/finding/
              sync-review/my-request screens unchanged. */}
          <Route path="/internal/approvals" element={<StaffPrivate><StaffApprovals /></StaffPrivate>} />
          {/* The track-record workspace as its OWN full-screen route (mega-workspace
              phase F) — the same component the Approvals tab embeds, with room to
              work. ?borrower=<id> narrows it to one person (profile links here). */}
          <Route path="/internal/track-record" element={<StaffPrivate><StaffTrackRecordWorkspace /></StaffPrivate>} />
          <Route path="/internal/settings" element={<StaffPrivate><StaffSettings /></StaffPrivate>} />
          {/* Old scattered approval routes now redirect into the hub, keeping their
              query string so deep links (?app=<id>) still land on the right card. */}
          <Route path="/internal/escalations" element={<RedirectWithQuery to="/internal/approvals" tab="escalations" />} />
          <Route path="/internal/exceptions" element={<RedirectWithQuery to="/internal/approvals" tab="exceptions" />} />
          <Route path="/internal/my-exceptions" element={<RedirectWithQuery to="/internal/approvals" tab="mine" />} />
          <Route path="/internal/findings-review" element={<RedirectWithQuery to="/internal/approvals" tab="findings" />} />
          {/* AI Command Center — the one hub for everything AI (owner-directed 2026-07-24). */}
          <Route path="/internal/ai" element={<StaffPrivate><StaffAiCenter /></StaffPrivate>} />
          {/* Old scattered AI routes now redirect into the hub (keeps emails/bookmarks working). */}
          <Route path="/internal/training" element={<Navigate to="/internal/ai?tab=training" replace />} />
          <Route path="/internal/labeling" element={<Navigate to="/internal/ai?tab=labeling" replace />} />
          <Route path="/internal/ai-inbox" element={<Navigate to="/internal/ai?tab=inbox" replace />} />
          <Route path="/internal/ai-silenced-codes" element={<Navigate to="/internal/ai?tab=silenced" replace />} />
          <Route path="/internal/insights" element={<Navigate to="/internal/ai?tab=overview" replace />} />
          <Route path="/internal/archived" element={<StaffPrivate><StaffArchived /></StaffPrivate>} />
          {/* The ADMIN CRM desk (owner-directed 2026-08-19) — every officer's book
              in one table, and a switcher that opens any one officer's FULL CRM
              (the same StaffLeads screen, narrowed) without coming back here.
              `?officer=<id>` keeps whose book it is in the URL, so a refresh, the
              back button and a shared link all land in the same place. */}
          <Route path="/internal/crm" element={<StaffPrivate><StaffCrmDesk /></StaffPrivate>} />
          <Route path="/internal/leads" element={<StaffPrivate><StaffLeads /></StaffPrivate>} />
          <Route path="/internal/leads/:id" element={<StaffPrivate><StaffLeadDetail /></StaffPrivate>} />
          <Route path="/internal/emails" element={<StaffPrivate><StaffEmails /></StaffPrivate>} />
          <Route path="/internal/orders" element={<StaffPrivate><StaffOrders /></StaffPrivate>} />
          {/* Investor Suite — every marketing tool (term sheet, rehab budget, analyzers) inside PILOT. */}
          <Route path="/internal/investor-suite" element={<StaffPrivate><StaffInvestorSuite /></StaffPrivate>} />
          {/* Same screen, opened straight onto the Term Sheet Studio — the owner's
              direct left-nav entry (2026-07-30). One screen, so the scenario bar and
              the saved-count badges behave identically either way in. */}
          <Route path="/internal/term-sheet" element={<StaffPrivate><StaffInvestorSuite initialTool="term-sheet" /></StaffPrivate>} />
          <Route path="/internal/borrowers" element={<StaffPrivate><StaffBorrowers /></StaffPrivate>} />
          <Route path="/internal/borrowers/:id" element={<StaffPrivate><StaffBorrowerDetail /></StaffPrivate>} />
          {/* Borrower view — pick a borrower and see PILOT as they see it. */}
          <Route path="/internal/borrower-view" element={<StaffPrivate><StaffBorrowerView /></StaffPrivate>} />
          {/* Broker (TPO) view — pick one of your firms' brokers and see PILOT as they see it. */}
          <Route path="/internal/tpo-view" element={<StaffPrivate><StaffTpoView /></StaffPrivate>} />
          <Route path="/internal/cobrowse/:sessionId" element={<StaffPrivate><StaffCobrowse /></StaffPrivate>} />
          <Route path="/internal/vendors" element={<StaffPrivate><StaffVendors /></StaffPrivate>} />
          {/* Research desk — every staff role, no per-file scoping (owner-directed:
              "make it available for all the staff users to see all the things"). */}
          <Route path="/internal/research" element={<StaffPrivate><StaffPropertyResearch /></StaffPrivate>} />
          {/* Subject-anchored comp search: start from a property, a loan file, or a typed address. */}
          <Route path="/internal/research/comps" element={<StaffPrivate><StaffCompSearch /></StaffPrivate>} />
          {/* What the appraisers themselves said about a town's market, month by month. */}
          <Route path="/internal/research/market" element={<StaffPrivate><StaffMarket /></StaffPrivate>} />
          <Route path="/internal/research/adjustments" element={<StaffPrivate><StaffAdjustments /></StaffPrivate>} />
          <Route path="/internal/research/property/:id" element={<StaffPrivate><StaffPropertyDetail /></StaffPrivate>} />
          <Route path="/internal/research/appraisers" element={<StaffPrivate><StaffAppraisers /></StaffPrivate>} />
          <Route path="/internal/research/appraiser/:id" element={<StaffPrivate><StaffAppraiserDetail /></StaffPrivate>} />
          <Route path="/internal/research/quick" element={<StaffPrivate><StaffQuickAnswer /></StaffPrivate>} />
          <Route path="/internal/research/areas" element={<StaffPrivate><StaffMarketAreas /></StaffPrivate>} />
          <Route path="/internal/research/valuation/:id" element={<StaffPrivate><StaffValuation /></StaffPrivate>} />
          <Route path="/internal/research/valuation/:id/report" element={<StaffPrivate><StaffCompReportScreen /></StaffPrivate>} />
          <Route path="/internal/chat" element={<StaffPrivate><StaffChat /></StaffPrivate>} />
          <Route path="/internal/api-health" element={<StaffPrivate><StaffApiHealth /></StaffPrivate>} />
          <Route path="/internal/reports" element={<StaffPrivate><StaffReports /></StaffPrivate>} />
          <Route path="/internal/pipeline-shadow" element={<StaffPrivate><StaffPipelineShadow /></StaffPrivate>} />
          <Route path="/internal/clickup" element={<StaffPrivate><StaffClickup /></StaffPrivate>} />
          <Route path="/internal/draws" element={<StaffPrivate><StaffDraws /></StaffPrivate>} />
          <Route path="/internal/closing" element={<StaffPrivate><StaffClosing /></StaffPrivate>} />
          <Route path="/internal/purchasing" element={<StaffPrivate><StaffPurchasing /></StaffPrivate>} />
          <Route path="/internal/draw-rules" element={<StaffPrivate><StaffDrawRules /></StaffPrivate>} />
          <Route path="/internal/tapes" element={<StaffPrivate><StaffTapes /></StaffPrivate>} />
          <Route path="/internal/audit" element={<StaffPrivate><StaffAuditLog /></StaffPrivate>} />
          <Route path="/internal/sync-reviews" element={<RedirectWithQuery to="/internal/approvals" tab="sync" />} />
          <Route path="/internal/esign" element={<StaffPrivate><EsignDashboard /></StaffPrivate>} />
          <Route path="/internal/dashboards" element={<StaffPrivate><StaffDashboards /></StaffPrivate>} />
        <Route path="/internal/dashboards/:id" element={<StaffPrivate><StaffDashboard /></StaffPrivate>} />
        <Route path="/internal/notifications" element={<StaffPrivate><StaffNotificationCenter /></StaffPrivate>} />
        <Route path="/internal/arena" element={<StaffPrivate><StaffArena /></StaffPrivate>} />

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
