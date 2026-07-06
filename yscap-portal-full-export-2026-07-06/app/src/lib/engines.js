/* Wrapper over the FROZEN pricing engines loaded via <script> in index.html
   (window.YSP / window.GSP / window.YSTitle). Never reimplements their logic.
   Note: the title engine registers itself as window.YSTitle. */
export const YSP = () => window.YSP || null;
export const GSP = () => window.GSP || null;
export const TitleCost = () => window.YSTitle || null;
export function enginesReady() { return !!(window.YSP && window.GSP && window.YSTitle); }
export function engineReport() {
  return {
    ysp: !!window.YSP, gsp: !!window.GSP, title: !!window.YSTitle,
    markup: window.YSP && window.YSP.constants ? window.YSP.constants.MARKUP : null,
  };
}
