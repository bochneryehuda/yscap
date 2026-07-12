// Client-side mirror of the backend password rule (src/lib/crypto.js
// `passwordProblem`). Keep the two IN SYNC — the backend is the real gate; this
// just gives the user the same plain-language feedback before they submit.
// Returns a reason the password is too weak, or '' if it passes (S1-02).
export function passwordProblem(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < 8) return 'Password must be at least 8 characters.';
  if (s.length > 200) return 'Password must be 200 characters or fewer.';
  if (!/[a-z]/.test(s)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(s)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(s)) return 'Password must include a number.';
  return '';
}

// One shared hint shown under password fields so the requirement is visible
// up front, not only after a rejected submit.
export const PASSWORD_HINT =
  'At least 8 characters, with an uppercase letter, a lowercase letter, and a number.';
