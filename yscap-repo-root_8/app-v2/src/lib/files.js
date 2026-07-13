/* Read a File to raw base64 (no data: prefix) — the portal's upload contract is
   { filename, contentType, dataBase64 }. Shared so the ~half-dozen upload sites
   don't each re-implement the same FileReader dance. */
export const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = reject;
  r.readAsDataURL(file);
});
