/* Wrapper over the FROZEN pricing engines loaded via <script> in index.html
   (window.YSP / window.GSP / window.TitleCost). Never reimplements their logic. */
export const YSP = () => window.YSP || null;
export const GSP = () => window.GSP || null;
export const TitleCost = () => window.TitleCost || null;
export function enginesReady() { return !!(window.YSP && window.GSP && window.TitleCost); }
export function engineReport() {
  return {
    ysp: !!window.YSP, gsp: !!window.GSP, title: !!window.TitleCost,
    markup: window.YSP && window.YSP.constants ? window.YSP.constants.MARKUP : null,
  };
}
