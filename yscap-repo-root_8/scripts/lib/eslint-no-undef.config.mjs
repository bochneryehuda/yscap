/**
 * THE `no-undef` CONFIG CLAUDE.md TELLS YOU TO RUN, COMMITTED SO THE CHECK IS
 * REPRODUCIBLE.
 *
 * The standing rule (CLAUDE.md, "a green build does NOT mean the page renders"):
 * esbuild treats an UNDECLARED IDENTIFIER as a global and emits it verbatim, so
 * a React component using a variable it was never passed BUILDS CLEANLY and then
 * throws `ReferenceError` at render — which the app's ErrorBoundary turns into
 * the full-screen "Something went wrong". A passing build is necessary and not
 * sufficient; this is the check that catches the class.
 *
 * It is a FILE rather than a paragraph of instructions because a pre-merge audit
 * pointed out the obvious: a verification run from an ad-hoc config in somebody's
 * temp directory cannot be repeated by the next person, so the claim "eslint
 * no-undef is clean" was not checkable. Now it is:
 *
 *   npx eslint --no-config-lookup -c scripts/lib/eslint-no-undef.config.mjs <files>
 *
 * ⛔ `files` IS LOAD-BEARING. Without it eslint's flat config silently IGNORES
 * every `.jsx` — reporting "File ignored because no matching configuration was
 * supplied" as a WARNING and exiting 0. That is how a lint run reports success
 * over code it never looked at, which is exactly the trap this file exists to
 * avoid. PROVE IT BITES on a deliberately undeclared identifier before trusting
 * a clean run.
 *
 * NOT wired into `npm test`: eslint is not a dependency of this repo (only
 * express and pg are installed, so Render builds cleanly), and adding one is the
 * owner's call rather than a drive-by. Run it by hand on the files you changed.
 */
export default [{
  files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: {
      // Browser
      window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
      localStorage: 'readonly', sessionStorage: 'readonly', console: 'readonly',
      fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
      URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly',
      FormData: 'readonly', FileReader: 'readonly', Image: 'readonly', Audio: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
      clearInterval: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
      queueMicrotask: 'readonly', structuredClone: 'readonly', performance: 'readonly',
      atob: 'readonly', btoa: 'readonly', crypto: 'readonly', alert: 'readonly',
      confirm: 'readonly', prompt: 'readonly', getComputedStyle: 'readonly',
      DOMParser: 'readonly', XMLSerializer: 'readonly', AbortController: 'readonly',
      Event: 'readonly', CustomEvent: 'readonly', EventSource: 'readonly', WebSocket: 'readonly',
      IntersectionObserver: 'readonly', ResizeObserver: 'readonly', MutationObserver: 'readonly',
      HTMLElement: 'readonly', Node: 'readonly', Intl: 'readonly', TextEncoder: 'readonly',
      TextDecoder: 'readonly', matchMedia: 'readonly', scrollTo: 'readonly', history: 'readonly',
      // React (some files rely on the classic runtime global)
      React: 'readonly',
      // Node, for the scripts under this folder
      process: 'readonly', require: 'readonly', module: 'writable', __dirname: 'readonly',
      Buffer: 'readonly', globalThis: 'readonly',
    },
  },
  rules: { 'no-undef': 'error' },
}];
