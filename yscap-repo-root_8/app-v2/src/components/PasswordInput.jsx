import React, { useState } from 'react';

/* Password field with a Show / Hide reveal toggle.
   Used on every auth screen so a user can confirm what they typed before
   submitting — especially when creating an account (owner request). */
// The requirements checked live when `rules` is on — must mirror the server's
// crypto.passwordProblem() so the UI never green-lights a password the API will
// reject.
const PW_RULES = [
  { key: 'len', label: 'At least 10 characters', test: (s) => s.length >= 10 },
  { key: 'low', label: 'A lowercase letter', test: (s) => /[a-z]/.test(s) },
  { key: 'up', label: 'An uppercase letter', test: (s) => /[A-Z]/.test(s) },
  { key: 'num', label: 'A number', test: (s) => /[0-9]/.test(s) },
  { key: 'sym', label: 'A symbol (! ? @ # $ …)', test: (s) => /[^A-Za-z0-9]/.test(s) },
];

export default function PasswordInput({
  value,
  onChange,
  onKeyDown,
  autoComplete = 'current-password',
  autoFocus = false,
  id,
  placeholder,
  rules = false,
}) {
  const [show, setShow] = useState(false);
  const s = String(value || '');
  return (
    <>
      <div className="pw-wrap">
        <input
          className="input pw-input"
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          id={id}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="pw-toggle"
          tabIndex={-1}
          aria-pressed={show}
          aria-label={show ? 'Hide password' : 'Show password'}
          onClick={() => setShow((s2) => !s2)}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {rules && (
        <ul className="pw-rules" aria-label="Password requirements">
          {PW_RULES.map((r) => {
            const ok = r.test(s);
            return (
              <li key={r.key} className={ok ? 'ok' : ''}>
                <span className="pw-rule-ic" aria-hidden="true">{ok ? '✓' : '○'}</span>{r.label}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
