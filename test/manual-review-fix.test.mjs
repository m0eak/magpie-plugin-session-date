import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHook } from '../src/request.hooks.mjs';

const dateLine = 'Session date: Tuesday, November 3, 2026';
const prompt = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>You have access to the Memory Tool.\n<session_context>\n${dateLine}\nConversation language: en\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
const cleaned = prompt.replace(`${dateLine}\n`, '');

function setup() {
  const events = [];
  const hook = createRequestHook({ store: { record: (event) => events.push(event) }, now: () => new Date('2026-11-05T12:00:00.000Z') });
  return { hook, events };
}

async function expectMatched(hook, events, body, protocol, expected, removedLines = 1) {
  const before = structuredClone(body);
  const result = await hook(body, { protocol });
  await Promise.resolve();
  assert.deepEqual(result, expected);
  assert.deepEqual(body, before, 'request body must not be mutated in place');
  assert.deepEqual(events, [{ matched: true, removedLines, at: '2026-11-05T12:00:00.000Z' }]);
}

test('public hook filters Chat system date with assistant tool_calls missing content', async () => {
  const { hook, events } = setup();
  const body = { messages: [
    { role: 'system', content: prompt },
    { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ] };
  await expectMatched(hook, events, body, 'chat', { messages: [{ role: 'system', content: cleaned }, ...body.messages.slice(1)] });
});

test('public hook filters Responses easy input messages without type', async () => {
  const { hook, events } = setup();
  const body = { input: [
    { role: 'system', content: prompt },
    { role: 'developer', content: prompt },
    { role: 'user', content: 'hello' },
  ] };
  await expectMatched(hook, events, body, 'responses', { input: [
    { role: 'system', content: cleaned },
    { role: 'developer', content: cleaned },
    body.input[2],
  ] }, 2);
});

test('public hook filters Gemini system date beside recognized image and file parts', async () => {
  const { hook, events } = setup();
  const image = { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } };
  const file = { fileData: { mimeType: 'text/plain', fileUri: 'gs://bucket/file.txt' } };
  const body = { systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: 'user', parts: [{ text: 'describe' }, image, file] }] };
  await expectMatched(hook, events, body, 'gemini', {
    systemInstruction: { parts: [{ text: cleaned }] },
    contents: [{ role: 'user', parts: [{ text: 'describe' }, image, file] }],
  });
});

test('public hook filters known system text despite unrelated unknown user payload and counts the transform', async () => {
  const { hook, events } = setup();
  const extension = { type: 'vendor_future', payload: { untouched: [1, 2, 3] } };
  const body = { messages: [
    { role: 'system', content: prompt },
    { role: 'user', content: [extension] },
  ] };
  const expected = { messages: [{ role: 'system', content: cleaned }, body.messages[1]] };
  await expectMatched(hook, events, body, 'chat', expected);
});

test('public hook does not count valid unknown unmatched payloads', async () => {
  const { hook, events } = setup();
  const body = { messages: [{ role: 'user', content: [{ type: 'vendor_future', payload: { untouched: true } }] }] };
  assert.equal(await hook(body, { protocol: 'chat' }), undefined);
  await Promise.resolve();
  assert.deepEqual(events, []);
});

test('public hook filters Responses system text but leaves an unknown typed item untouched', async () => {
  const { hook, events } = setup();
  const future = { type: 'future-item', role: 'system', content: prompt, vendor: { keep: true } };
  const body = { input: [{ role: 'system', content: prompt }, future] };
  await expectMatched(hook, events, body, 'responses', { input: [
    { role: 'system', content: cleaned },
    future,
  ] });
});

test('public hook leaves malformed request wholly unchanged and uncounted', async () => {
  const { hook, events } = setup();
  const malformedCases = [
    ['chat', { messages: [{ role: 'system', content: prompt }, {}] }],
    ['chat', { messages: [{ role: 'system', content: prompt }, { role: 'user' }] }],
    ['responses', { input: [{ role: 'system', content: prompt }, { role: 'user' }] }],
  ];
  for (const [protocol, body] of malformedCases) {
    const before = structuredClone(body);
    assert.equal(await hook(body, { protocol }), undefined);
    assert.deepEqual(body, before);
    await Promise.resolve();
    assert.deepEqual(events, []);
  }
});
