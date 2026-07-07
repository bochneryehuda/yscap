import React, { useState } from 'react';

/* Password field with a Show / Hide reveal toggle.
   Used on every auth screen so a user can confirm what they typed before
   submitting — especially when creating an account (owner request). */
export default function PasswordInput({
  value,
  onChange,
  onKeyDown,
  autoComplete = 'current-password',
  autoFocus = false,
  id,
  placeholder,
}) {
  const [show, setShow] = useState(false);
  return (
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
        onClick={() => setShow((s) => !s)}
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
