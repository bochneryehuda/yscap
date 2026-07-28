'use strict';
/**
 * The TrustPoint draw-comment sanitizer, PURE (no DB, no network).
 *
 * A draw comment is written by somebody outside PILOT and is then STORED and DISPLAYED on the
 * draw desk, so this function is a security boundary as much as a formatter. Two classes it has
 * to hold: markup must never survive as markup, and a hostile body must never stall the process
 * (this runs inside the webhook drain, on the same process that serves the API — a CPU stall is
 * not catchable by the try/catch around the caller).
 */

const assert = require('assert');
const { toPlainText, _authorOf: authorOf } = require('../src/trustpoint/comments');

function readsLikeAPerson() {
  assert.strictEqual(toPlainText('<p>Thank you.</p>'), 'Thank you.');
  assert.strictEqual(
    toPlainText('<p>Please update the ZIP code.</p><p>It is missing a 0.</p>'),
    'Please update the ZIP code.\nIt is missing a 0.');
  assert.strictEqual(toPlainText('line one<br/>line two'), 'line one\nline two');
  assert.strictEqual(toPlainText('<ul><li>one</li><li>two</li></ul>'), 'one\ntwo');
  assert.strictEqual(toPlainText('Smith &amp; Sons &mdash; paid'), 'Smith & Sons &mdash; paid');
  assert.strictEqual(toPlainText('a&nbsp;&nbsp;b'), 'a b');
  assert.strictEqual(toPlainText('&#8212; dash'), '— dash');
  // absent / junk input must never throw — this is on a live render path
  for (const junk of [null, undefined, '', 0, {}, []]) assert.doesNotThrow(() => toPlainText(junk));
  assert.strictEqual(toPlainText(null), '');
  console.log('  ✓ ordinary HTML renders as the plain text a desk wants to read');
}

function markupNeverSurvivesAsMarkup() {
  // plain tags
  assert.ok(!/</.test(toPlainText('<b>bold</b> text')));
  // script/style CONTENT is dropped, not merely unwrapped
  assert.ok(!/alert/.test(toPlainText('<script>alert(1)</script>hello')));
  assert.ok(!/color/.test(toPlainText('<style>a{color:red}</style>hello')));

  // THE REGRESSION THIS FILE EXISTS FOR: the entity decode runs AFTER the tag strip, so an
  // ESCAPED tag sails through the strip untouched (it holds no `<` yet) and is then decoded
  // INTO live markup. That is a stored payload waiting for a renderer that trusts this text.
  for (const hostile of [
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '&lt;img src=x onerror=alert(1)&gt;',
    '&LT;ScRiPt&GT;alert(1)&LT;/ScRiPt&GT;',
    '&#60;script&#62;alert(1)&#60;/script&#62;',
    '<p>&lt;iframe src="javascript:alert(1)"&gt;&lt;/iframe&gt;</p>',
  ]) {
    const out = toPlainText(hostile);
    assert.ok(!/<\s*\/?\s*[a-zA-Z]/.test(out), `decoded into live markup: ${JSON.stringify(out)}`);
  }

  // …while ordinary prose that merely CONTAINS < or > is left alone. A blunt second strip
  // (`/<[^>]*>/g`) would have eaten "< 20 and 30 >" and silently destroyed the message.
  assert.strictEqual(toPlainText('<p>budget is 10 &lt; 20 and 30 &gt; 25</p>'), 'budget is 10 < 20 and 30 > 25');
  assert.strictEqual(toPlainText('a &lt;-- b'), 'a <-- b');
  console.log('  ✓ no input — escaped or raw — can leave markup in the stored text');
}

function aHostileBodyCannotStallTheProcess() {
  // An unclosed `<` makes the lazy tag scans degrade badly; the cap is what bounds it.
  const hostile = '<'.repeat(200000);
  const t0 = Date.now();
  const out = toPlainText(hostile);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `sanitizing a hostile 200k body took ${ms}ms — the length cap is not holding`);
  assert.ok(out.length < 25000, `output should be capped, got ${out.length}`);

  // A long body is TRUNCATED VISIBLY — never silently shortened, so nobody reads a half
  // message believing it is the whole one.
  const long = 'x'.repeat(50000);
  const cut = toPlainText(long);
  assert.ok(/\[message truncated\]$/.test(cut), 'a truncated message must say so');
  // …and a message that FITS is never marked truncated.
  assert.ok(!/truncated/.test(toPlainText('<p>short and complete</p>')));
  console.log(`  ✓ a hostile 200k body is bounded (${ms}ms) and truncation is visible`);
}

function theAuthorIsNeverGuessed() {
  // TrustPoint's PublicCommentResponse publishes NO author field, so this is null in practice —
  // the mirror says "what was said and when", never invents a "who".
  assert.strictEqual(authorOf({ message: 'hi' }), null);
  assert.strictEqual(authorOf({}), null);
  assert.strictEqual(authorOf(null), null);
  assert.strictEqual(authorOf({ author: '   ' }), null, 'a blank name is not a name');
  // …but it reads one the day TrustPoint sends it, in any of the shapes their APIs use.
  assert.strictEqual(authorOf({ author: 'Dana Ruiz' }), 'Dana Ruiz');
  assert.strictEqual(authorOf({ created_by: { name: 'Dana Ruiz' } }), 'Dana Ruiz');
  assert.strictEqual(authorOf({ user: { full_name: 'Dana Ruiz' } }), 'Dana Ruiz');
  console.log('  ✓ the author is read when sent and never guessed when absent');
}

(function () {
  console.log('TrustPoint draw comments (pure)');
  readsLikeAPerson();
  markupNeverSurvivesAsMarkup();
  aHostileBodyCannotStallTheProcess();
  theAuthorIsNeverGuessed();
  console.log('All TrustPoint comment tests passed.');
})();
