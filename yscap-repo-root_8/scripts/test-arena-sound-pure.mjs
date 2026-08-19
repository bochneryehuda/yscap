/* THE ARENA'S SOUND AND ITS FULL-SCREEN LANDING — the properties a render check
   cannot see (owner-directed: "sound and a full-screen takeover on every screen
   when a spin lands, not just a card").

   Three things must hold, and each of them is a way this could go wrong on a
   sales floor rather than a theory:

     1. IT NEVER MAKES A NOISE IT WAS NOT ALLOWED TO. Browsers refuse audio
        before the person has touched the page, and trying to get around that
        is not something a staff game has any business doing. Silence before a
        gesture is the correct behaviour, not a bug to work around.
     2. IT NEVER BREAKS THE ARENA. No Web Audio, no output device, a locked-down
        policy, private browsing with no storage — every one of those means "no
        sound", never a screen that stopped working in front of the whole room.
     3. THE TAKEOVER ALWAYS LETS GO. A full-screen panel that can trap somebody
        on the day the room is watching is worse than no takeover at all, so it
        must dismiss itself, answer Escape, and answer a click.

   Pure — a fake window, a fake audio engine, no browser and no database. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) failures++; };

// ---------------------------------------------------------------------------
// A FAKE BROWSER. `store` stands in for localStorage; `ac` records every note
// the module schedules, so "did it actually try to play?" is answerable.
// ---------------------------------------------------------------------------
let store = {};
let storageThrows = false;
const scheduled = [];
let audioAvailable = true;
let contextState = 'suspended';     // what a browser gives you before a gesture
const listeners = {};

function FakeParam() {
  return {
    setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0,
  };
}
// A REAL browser does NOT flip an audio context to 'running' the moment you
// ask: `resume()` hands back a promise, and before the first gesture it never
// keeps it. Modelling that faithfully is the whole point — a fake that resumes
// synchronously would have this suite reporting a chime nobody could hear.
let gestured = false;
class FakeAudioContext {
  constructor() { this.state = contextState; this.currentTime = 1; this.destination = { kind: 'out' }; }
  resume() {
    if (!gestured) return Promise.reject(new Error('not allowed without a gesture'));
    return Promise.resolve().then(() => { this.state = 'running'; contextState = 'running'; });
  }
  createGain() { return { gain: FakeParam(), connect() {} }; }
  createOscillator() {
    return {
      type: '', frequency: FakeParam(), connect() {},
      start: (at) => scheduled.push(at), stop() {},
    };
  }
}

globalThis.window = {
  get AudioContext() { return audioAvailable ? FakeAudioContext : undefined; },
  localStorage: {
    getItem(k) { if (storageThrows) throw new Error('private mode'); return k in store ? store[k] : null; },
    setItem(k, v) { if (storageThrows) throw new Error('private mode'); store[k] = String(v); },
  },
  addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
};
const gesture = async () => {
  gestured = true;
  for (const fn of (listeners.pointerdown || [])) fn();
  await Promise.resolve();   // let the resume() the gesture kicked off settle
};

const snd = await import('../app-v2/src/lib/arenaSound.js');

// ---------------------------------------------------------------------------
// A. SILENT UNTIL SOMEBODY HAS TOUCHED THE PAGE.
// ---------------------------------------------------------------------------
ok(snd.soundOn() === true, 'the chime is on unless somebody turned it off');
ok(snd.playLanding() === false,
  'nothing is played before the first click — the browser forbids it, and pretending otherwise '
  + 'would be an exception in the console instead of a chime');
ok(scheduled.length === 0, 'and nothing was scheduled either');

snd.arm();
await gesture();
ok(snd.playLanding() === true, 'once the person has clicked anywhere, a landing is heard');
ok(scheduled.length === 4, 'the chime is four notes, synthesised — no audio file to download or 404');

// ---------------------------------------------------------------------------
// B. THE OFF SWITCH IS READ AT THE MOMENT OF PLAYING.
//    Somebody on a call turns it off; the very next spin must be silent, not
//    the one after they reload the page.
// ---------------------------------------------------------------------------
scheduled.length = 0;
snd.setSoundOn(false);
ok(snd.soundOn() === false, 'turning it off sticks');
ok(snd.playLanding() === false && scheduled.length === 0, 'and the next landing is silent immediately');
ok(snd.playTick() === false, 'the count-in tick obeys the same switch');
snd.setSoundOn(true);
ok(snd.playLanding() === true, 'turning it back on is felt on the very next spin');

// ---------------------------------------------------------------------------
// C. IT NEVER BREAKS THE ARENA.
// ---------------------------------------------------------------------------
audioAvailable = false;
let threw = null;
try { snd.playLanding(); snd.playTick(); snd.arm(); } catch (e) { threw = e; }
ok(threw === null, 'a browser with no Web Audio gets no sound, never an error');
audioAvailable = true;

storageThrows = true;
threw = null;
let def = null;
try { def = snd.soundOn(); snd.setSoundOn(false); } catch (e) { threw = e; }
ok(threw === null && def === true,
  'private browsing, where storage refuses to answer, reads as ON rather than taking the page down');
storageThrows = false;

// ---------------------------------------------------------------------------
// D. THE TAKEOVER ALWAYS LETS GO, AND RESPECTS SOMEBODY WHO ASKED FOR LESS
//    MOTION. Source properties, because a full-screen panel that traps the room
//    is the one failure worth guarding structurally.
// ---------------------------------------------------------------------------
const takeover = read('app-v2/src/components/arena/ArenaTakeover.jsx');
ok(/setTimeout\(/.test(takeover), 'the takeover dismisses itself — nobody has to find the way out');
ok(/Escape/.test(takeover), 'Escape closes it');
ok(/onClick=\{/.test(takeover), 'and so does a click anywhere on it');
ok(/prefers-reduced-motion/.test(takeover),
  'somebody who asked their computer for less motion is not thrown a spinning full-screen panel');
ok(!/color:\s*['"]?var\(--ink/.test(takeover),
  'no --ink* token is used as a text colour (they are LIGHT paper colours here)');

const stage = read('app-v2/src/screens/StaffArena.jsx');
ok(/ArenaTakeover/.test(stage), 'the takeover is actually mounted on the Arena screen');
ok(/seenDecided/.test(stage),
  'and a landing is celebrated ONCE per spin — a reconnecting stream replays frames, and a room '
  + 'that gets the same fanfare three times stops believing the fourth');

// ---------------------------------------------------------------------------
// E. THE BUSIEST MINUTE OF THE DAY IS CHEAP.
//    Every arena frame asks the open screens to refresh, and the board is nine
//    queries. At half past ten forty people check in inside two minutes — each
//    one a frame to every open screen — so refreshing on each frame turns one
//    person's click into forty board loads. The refresh is coalesced to one a
//    second per screen, with a TRAILING call, because the frame worth reacting
//    to is usually the last in a burst.
// ---------------------------------------------------------------------------
ok(/reload\.current = askReload/.test(stage),
  'the stream asks for a COALESCED refresh, never the raw loader on every frame');
ok(/setTimeout\(/.test(stage.slice(stage.indexOf('const askReload'), stage.indexOf('reload.current = askReload'))),
  'and it keeps a trailing refresh, so the last frame in a burst is not the one that is dropped');
ok(/arena:chat['"] \|\| event === ['"]arena:chat-react['"]\) return/.test(stage),
  'a chat message never refetches the board at all — the chat panel owns those frames');

console.log(failures ? `\n${failures} failed` : '\nALL arena-sound assertions passed');
process.exit(failures ? 1 : 0);
