/* The frozen pricing engines are NOT loaded into the portal (2026-08-03).
   They used to be pulled in by four <script> tags in index.html — so every
   visitor downloaded the full leverage matrix, rate build-up and eligibility
   rules BEFORE logging in — while the only thing the portal ever read them for
   was the console.info diagnostic below. The actual pricing happens inside the
   Term Sheet Studio iframe, which loads its own copies from /tools/, and the
   authoritative numbers come from the server (src/lib/pricing.js).

   These readers are kept so the diagnostic keeps working if the engines are
   ever deliberately re-introduced; today they simply report absent. Do NOT
   "fix" that by re-adding the script tags. */
export const YSP = () => (typeof window !== 'undefined' && window.YSP) || null;
export const GSP = () => (typeof window !== 'undefined' && window.GSP) || null;
export const TitleCost = () => (typeof window !== 'undefined' && window.YSTitle) || null;
export function enginesReady() { return !!(YSP() && GSP() && TitleCost()); }
export function engineReport() {
  // Never reads engine internals — the old version printed YSP.constants.MARKUP,
  // putting the company markup in the browser console of every portal visitor.
  return { ysp: !!YSP(), gsp: !!GSP(), title: !!TitleCost(), loadedInPortal: enginesReady() };
}
