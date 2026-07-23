'use strict';
/**
 * #215 — pure tests for the Anthropic client's provider-agnostic pieces (no key, no
 * network). Proves: available() is false when unconfigured (so the committee stays
 * all-Azure until a key is set); buildBody forces a tool for JSON-schema output;
 * extractText reads a tool_use input as JSON (and text blocks otherwise); usage
 * normalizes to the shared shape; and complete() fails safe (never throws) with no key.
 */
const assert = require('assert');
const anthropic = require('../src/lib/ai/anthropic');
const { buildBody, extractText, normUsage } = anthropic._internals;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. Unconfigured (no ANTHROPIC_API_KEY in this env) → available() false.
{
  assert.strictEqual(anthropic.available(), false, 'no key → not available (committee stays all-Azure)');
  ok('available() is false when unconfigured');
}

// 2. buildBody with a JSON-schema responseFormat forces a single tool.
{
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  const body = buildBody({
    system: 'you are a reviewer', userText: 'review this', maxTokens: 600,
    responseFormat: { type: 'json_schema', json_schema: { name: 'CommitteeVerdict', schema } },
  });
  assert.strictEqual(body.system, 'you are a reviewer');
  assert.strictEqual(body.messages[0].role, 'user');
  assert.strictEqual(body.max_tokens, 600);
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1, 'exactly one tool');
  assert.strictEqual(body.tools[0].name, 'CommitteeVerdict');
  assert.deepStrictEqual(body.tools[0].input_schema, schema, 'the tool input_schema IS the JSON schema');
  assert.deepStrictEqual(body.tool_choice, { type: 'tool', name: 'CommitteeVerdict' }, 'tool is forced');
  assert.strictEqual(body._forcedTool, 'CommitteeVerdict');
  ok('buildBody forces a tool whose input_schema is the requested JSON schema');
}

// 3. buildBody WITHOUT a schema → a plain message, no tool.
{
  const body = buildBody({ userText: 'hello', maxTokens: 100 });
  assert.ok(!body.tools && !body.tool_choice && !body._forcedTool, 'no tool when no schema');
  ok('buildBody with no schema is a plain messages request');
}

// 4. extractText reads a forced tool_use input as a JSON string.
{
  const resp = { content: [
    { type: 'text', text: 'let me think' },
    { type: 'tool_use', name: 'CommitteeVerdict', input: { verdict: 'refute', confidence: 0.9 } },
  ] };
  const text = extractText(resp, 'CommitteeVerdict');
  assert.deepStrictEqual(JSON.parse(text), { verdict: 'refute', confidence: 0.9 }, 'tool input round-trips as JSON');
  // no tool present → empty (caller treats as non-JSON / no response)
  assert.strictEqual(extractText({ content: [{ type: 'text', text: 'x' }] }, 'CommitteeVerdict'), '');
  ok('extractText reads a forced tool_use input as JSON');
}

// 5. extractText concatenates text blocks when no tool is forced.
{
  const resp = { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] };
  assert.strictEqual(extractText(resp, null), 'AB');
  assert.strictEqual(extractText({}, null), '', 'no content → empty');
  ok('extractText concatenates text blocks in the non-tool path');
}

// 6. normUsage maps Anthropic usage to the shared prompt/completion shape.
{
  assert.deepStrictEqual(normUsage({ input_tokens: 100, output_tokens: 20 }), { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.strictEqual(normUsage(null), null);
  ok('normUsage maps input/output tokens to prompt/completion/total');
}

// 7. complete() with no key fails safe (never throws, returns ok:false).
{
  (async () => {
    const r = await anthropic.complete({ userContent: 'x', responseFormat: null });
    assert.strictEqual(r.ok, false);
    assert.ok(/not configured/i.test(r.reason), 'reason names the missing key');
  })();
  // hostile inputs to the pure helpers never throw
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.doesNotThrow(() => extractText(bad, null));
    assert.doesNotThrow(() => extractText(bad, 'T'));
    assert.doesNotThrow(() => normUsage(bad));
    assert.doesNotThrow(() => buildBody(bad || {}));
  }
  ok('complete() with no key fails safe; pure helpers never throw');
}

console.log(`\nanthropic pure — ${passed} checks passed`);
