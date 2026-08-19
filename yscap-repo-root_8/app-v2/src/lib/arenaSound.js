/**
 * THE ARENA'S SOUND — a short chime when a spin lands, and a way to turn it off.
 *
 * The owner asked for "sound and a full-screen takeover on every screen when a
 * spin lands". Four decisions worth stating, because each of them is the reason
 * something here looks more careful than it needs to:
 *
 * 1. NO AUDIO FILE. Shipping an mp3 means a binary in the repository, a bundle
 *    that grows, and a request that can fail. The chime is SYNTHESISED with the
 *    Web Audio API the browser already has — a few oscillators and an envelope,
 *    about a kilobyte of code, nothing to download and nothing to 404.
 *
 * 2. A BROWSER WILL NOT MAKE A NOISE UNTIL THE PERSON HAS TOUCHED THE PAGE.
 *    Every modern browser blocks audio started without a gesture — a rule that
 *    exists because of autoplaying adverts, and one this has no business trying
 *    to get around. So the audio context is created on the FIRST real click or
 *    key press anywhere on the page and kept warm after that. Somebody who
 *    opened the Arena and has not touched it hears nothing on the first spin;
 *    they hear every one after. That is the honest behaviour, and it is far
 *    better than an exception in the console nobody sees.
 *
 * 3. IT MUST BE POSSIBLE TO SILENCE, INSTANTLY. Somebody is on a call. The
 *    preference is per-person, held in this browser, and it is read at the
 *    moment of playing — not captured at start-up — so switching it off is felt
 *    on the very next spin.
 *
 * 4. IT NEVER THROWS. Every entry point is wrapped. A browser with no Web Audio,
 *    a device with no output, a locked-down policy — all of them mean "no
 *    sound", never "the Arena stopped working".
 */

const KEY = 'arena.sound';

let ctx = null;
let armed = false;

/** Is the chime switched on for this person, in this browser? Default: yes. */
export function soundOn() {
  try { return window.localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

/** Turn it on or off. Returns the new state. */
export function setSoundOn(on) {
  try { window.localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  if (on) arm();
  return !!on;
}

/**
 * Create (or resume) the audio context. Safe to call as often as you like.
 * Returns null when the browser will not give us one.
 */
function context() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    // A context created before the first gesture starts 'suspended'. Resuming
    // is itself only allowed from a gesture, which is exactly when arm() runs.
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}

/**
 * Wait for the first gesture on the page, then open the audio context so a
 * later spin can actually be heard. Idempotent; call it from anywhere.
 */
export function arm() {
  if (armed) return;
  armed = true;
  const go = () => { context(); };
  try {
    window.addEventListener('pointerdown', go, { once: true, passive: true });
    window.addEventListener('keydown', go, { once: true });
  } catch { /* no window (server render) — nothing to arm */ }
}

/** One note. `t` is the context time it starts at. */
function note(c, out, freq, at, len, gain = 0.16, type = 'sine') {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  // A hard start or stop is a click. Ramp both ends.
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g); g.connect(out);
  o.start(at); o.stop(at + len + 0.05);
}

/**
 * THE LANDING CHIME — a rising major triad with the octave on top. Bright,
 * short, and unmistakably a "you won" rather than an alert.
 */
export function playLanding() {
  if (!soundOn()) return false;
  const c = context();
  if (!c || c.state === 'suspended') return false;
  try {
    const out = c.createGain();
    out.gain.value = 0.9;
    out.connect(c.destination);
    const t = c.currentTime + 0.01;
    //   C5     E5     G5     C6
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      note(c, out, f, t + i * 0.085, i === 3 ? 0.55 : 0.28, i === 3 ? 0.2 : 0.14);
    });
    return true;
  } catch { return false; }
}

/**
 * THE COUNT-IN TICK — one short, dry click. Deliberately quiet and unmusical:
 * it is a metronome under a countdown, not a second fanfare.
 */
export function playTick() {
  if (!soundOn()) return false;
  const c = context();
  if (!c || c.state === 'suspended') return false;
  try {
    const out = c.createGain();
    out.gain.value = 0.5;
    out.connect(c.destination);
    note(c, out, 880, c.currentTime + 0.005, 0.06, 0.08, 'triangle');
    return true;
  } catch { return false; }
}

export default { soundOn, setSoundOn, arm, playLanding, playTick };
