import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRequest } from '../src/protocols.mjs';

const dateLine = 'Session date: Tuesday, November 3, 2026';
const target = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>You have access to the Memory Tool.\n<session_context>\n${dateLine}\nConversation language: en\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
const clean = target.replace(`${dateLine}\n`, '');
const textBlock = (text) => ({ type: 'text', text });
const inputTextBlock = (text) => ({ type: 'input_text', text });
const geminiTextPart = (text, extras = {}) => ({ text, ...extras });

 test('filters chat system and developer string contents only', () => {
  const body = {
    model: 'model-a',
    messages: [
      { role: 'system', content: target },
      { role: 'developer', content: target },
      { role: 'user', content: target },
      { role: 'assistant', content: target },
      { role: 'tool', content: target, tool_call_id: 'call-1' },
    ],
  };
  const result = filterRequest(body, 'chat');
  assert.equal(result.supported, true);
  assert.equal(result.removedLines, 2);
  assert.equal(result.body.messages[0].content, clean);
  assert.equal(result.body.messages[1].content, clean);
  for (const index of [2, 3, 4]) assert.equal(result.body.messages[index], body.messages[index]);
  assert.equal(result.body.model, body.model);
  assert.notEqual(result.body, body);
  assert.notEqual(result.body.messages, body.messages);
  assert.notEqual(result.body.messages[0], body.messages[0]);
  assert.equal(result.body.messages[2], body.messages[2]);
});

test('filters only explicit chat text content blocks and preserves metadata', () => {
  const cache = { type: 'text', text: target, cache_control: { type: 'ephemeral' }, vendor: 9 };
  const ambiguous = { text: target, cache_control: { type: 'ephemeral' } };
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,x' }, text: target };
  const responsesOnly = inputTextBlock(target);
  const body = { messages: [{ role: 'system', content: [cache, ambiguous, image, responsesOnly] }] };
  const result = filterRequest(body, 'chat');
  assert.equal(result.removedLines, 1);
  assert.equal(result.body.messages[0].content[0].text, clean);
  assert.deepEqual(result.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(result.body.messages[0].content[0].vendor, 9);
  assert.equal(result.body.messages[0].content[1], ambiguous);
  assert.equal(result.body.messages[0].content[2], image);
  assert.equal(result.body.messages[0].content[3], responsesOnly);
});

test('treats Chat input_text as an unsupported block while retaining source identity', () => {
  const block = inputTextBlock(target);
  const message = { role: 'system', content: [block] };
  const body = { messages: [message] };
  const result = filterRequest(body, 'chat');
  assert.equal(result.supported, true);
  assert.equal(result.removedLines, 0);
  assert.equal(result.body, body);
  assert.equal(result.body.messages[0], message);
  assert.equal(result.body.messages[0].content[0], block);
});

test('leaves malformed chat blocks fail-open while processing a valid sibling', () => {
  const malformed = { type: 'text', text: 12, cache_control: { type: 'ephemeral' } };
  const body = { messages: [{ role: 'developer', content: [malformed, textBlock(target)] }] };
  const result = filterRequest(body, 'chat');
  assert.equal(result.removedLines, 1);
  assert.equal(result.body.messages[0].content[0], malformed);
  assert.equal(result.body.messages[0].content[1].text, clean);
});

test('filters Responses instructions and system/developer message input', () => {
  const body = {
    model: 'model-r',
    instructions: target,
    input: [
      { type: 'message', role: 'system', content: target, id: 'sys' },
      { type: 'message', role: 'developer', content: [inputTextBlock(target)], id: 'dev' },
      { type: 'message', role: 'user', content: target },
      { type: 'function_call', name: 'tool', arguments: target },
      { type: 'function_call_output', output: target },
      { type: 'message', role: 'system', content: [{ text: target }] },
      { type: 'message', role: 'system', content: [inputTextBlock(target)] },
      { role: 'system', content: target },
    ],
  };
  const result = filterRequest(body, 'responses');
  assert.equal(result.supported, true);
  assert.equal(result.removedLines, 5);
  assert.equal(result.body.instructions, clean);
  assert.equal(result.body.input[0].content, clean);
  assert.equal(result.body.input[1].content[0].text, clean);
  for (const index of [2, 3, 4, 5]) assert.equal(result.body.input[index], body.input[index]);
  assert.equal(result.body.input[7].content, clean);
  assert.notEqual(result.body.input[7], body.input[7]);
  assert.equal(result.body.input[6].content[0].text, clean);
  assert.equal(result.body.input[6].content[0].type, 'input_text');
  assert.equal(result.body.model, body.model);
  assert.deepEqual(body.input[0], { type: 'message', role: 'system', content: target, id: 'sys' });
});

test('filters Anthropic top-level system text and explicit text blocks only', () => {
  const image = { type: 'image', source: { type: 'base64', data: 'x' }, text: target };
  const other = { text: target };
  const body = {
    system: [textBlock(target), image, other],
    messages: [{ role: 'user', content: target }, { role: 'assistant', content: target }],
    metadata: { user_id: 'kept' },
  };
  const result = filterRequest(body, 'anthropic');
  assert.equal(result.supported, true);
  assert.equal(result.removedLines, 1);
  assert.equal(result.body.system[0].text, clean);
  assert.equal(result.body.system[1], image);
  assert.equal(result.body.system[2], other);
  assert.equal(result.body.messages, body.messages);
  assert.deepEqual(result.body.metadata, body.metadata);
});

test('filters Gemini systemInstruction string and legal text parts only', () => {
  const imagePart = { inlineData: { mimeType: 'image/png', data: 'x' }, text: target };
  const unknownPart = { text: target, cache_control: { type: 'ephemeral' } };
  const validTextPart = geminiTextPart(target, { thought: false, thoughtSignature: 'sig' });
  const body = {
    systemInstruction: {
      role: 'system',
      parts: [validTextPart, imagePart, unknownPart],
      vendorMeta: { keep: true },
    },
    contents: [{ role: 'user', parts: [textBlock(target)] }],
    generationConfig: { thinkingConfig: { includeThoughts: true } },
  };
  const result = filterRequest(body, 'gemini');
  assert.equal(result.supported, true);
  assert.equal(result.removedLines, 1);
  assert.equal(result.body.systemInstruction.parts[0].text, clean);
  assert.equal(result.body.systemInstruction.parts[0].thought, false);
  assert.equal(result.body.systemInstruction.parts[0].thoughtSignature, 'sig');
  assert.equal(result.body.systemInstruction.parts[1], imagePart);
  assert.equal(result.body.systemInstruction.parts[2], unknownPart);
  assert.equal(result.body.systemInstruction.role, 'system');
  assert.deepEqual(result.body.systemInstruction.vendorMeta, { keep: true });
  assert.equal(result.body.contents, body.contents);
  assert.equal(result.body.generationConfig, body.generationConfig);
});

test('leaves Gemini systemInstruction string and unknown shapes unchanged', () => {
  const shapes = [target, null, 7, [], { parts: {} }, { role: 'system', text: target }];
  for (const systemInstruction of shapes) {
    const body = { systemInstruction };
    const result = filterRequest(body, 'gemini');
    assert.equal(result.supported, true);
    assert.equal(result.removedLines, 0);
    assert.equal(result.body, body);
    assert.equal(result.body.systemInstruction, systemInstruction);
  }
});

test('leaves Gemini text parts with malformed known metadata untouched', () => {
  const malformedParts = [
    { text: target, thought: 'not-a-boolean' },
    { text: target, thoughtSignature: [] },
    { text: target, thought: null },
    { text: target, thoughtSignature: 12 },
    { text: target, thought: false, extraPayload: { bytes: [1] } },
  ];
  for (const part of malformedParts) {
    const body = { systemInstruction: { parts: [part] } };
    const result = filterRequest(body, 'gemini');
    assert.equal(result.supported, true);
    assert.equal(result.removedLines, 0);
    assert.equal(result.body, body);
    assert.equal(result.body.systemInstruction.parts[0], part);
  }
});

test('returns the original body reference for known protocol requests without a match', () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    const body = { model: 'x', user: 'hello', messages: [{ role: 'user', content: target }] };
    const result = filterRequest(body, protocol);
    assert.equal(result.body, body, protocol);
    assert.equal(result.removedLines, 0, protocol);
    assert.equal(result.supported, true, protocol);
  }
});

test('returns an unsupported protocol unchanged without guessing', () => {
  const body = { system: target, messages: [{ role: 'system', content: target }] };
  const result = filterRequest(body, 'unknown');
  assert.equal(result.body, body);
  assert.equal(result.removedLines, 0);
  assert.equal(result.supported, false);
});

test('treats malformed bodies and fields as supported-protocol fail-open', () => {
  for (const [body, protocol] of [[null, 'chat'], [[], 'responses'], [{ messages: {} }, 'chat'], [{ instructions: 7 }, 'responses'], [{ system: false }, 'anthropic'], [{ systemInstruction: { parts: {} } }, 'gemini']]) {
    const result = filterRequest(body, protocol);
    assert.equal(result.body, body);
    assert.equal(result.removedLines, 0);
    assert.equal(result.supported, true);
  }
});

test('does not mutate the original request or nested cache metadata', () => {
  const block = { type: 'text', text: target, cache_control: { type: 'ephemeral' } };
  const message = { role: 'system', content: [block], name: 'keep' };
  const body = { messages: [message], untouched: { value: 2 } };
  const before = structuredClone(body);
  const result = filterRequest(body, 'chat');
  assert.deepEqual(body, before);
  assert.deepEqual(result.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(result.body.untouched, body.untouched);
});

test('counts multiple blocks but does not join text across blocks', () => {
  const split = [
    { type: 'text', text: '<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions><session_' },
    { type: 'text', text: `context>\n${dateLine}\n</session_context></tool.instructions>\n</tool>\n</tools>` },
  ];
  const body = { messages: [{ role: 'system', content: [textBlock(target), ...split] }] };
  const result = filterRequest(body, 'chat');
  assert.equal(result.removedLines, 1);
  assert.equal(result.body.messages[0].content[1], split[0]);
  assert.equal(result.body.messages[0].content[2], split[1]);
});

test('preserves chat and Responses cache metadata on changed text blocks', () => {
  const chatBlock = { type: 'text', text: target, cache_control: { type: 'ephemeral' } };
  const responsesBlock = { type: 'input_text', text: target, cache_control: { type: 'ephemeral' } };
  const chatResult = filterRequest({ messages: [{ role: 'system', content: [chatBlock] }] }, 'chat');
  const responseResult = filterRequest({ input: [{ type: 'message', role: 'developer', content: [responsesBlock] }] }, 'responses');
  assert.deepEqual(chatResult.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(responseResult.body.input[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(chatResult.body.messages[0].content[0].text, clean);
  assert.equal(responseResult.body.input[0].content[0].text, clean);
});

test('does not join wrappers across adjacent protocol content blocks', () => {
  const first = { type: 'text', text: '<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions><session_' };
  const second = { type: 'text', text: `context>\n${dateLine}\n</session_context></tool.instructions>\n</tool>\n</tools>` };
  const body = { system: [first, second] };
  const result = filterRequest(body, 'anthropic');
  assert.equal(result.removedLines, 0);
  assert.equal(result.body, body);
  assert.equal(result.body.system[0], first);
  assert.equal(result.body.system[1], second);
});

test('keeps empty text blocks and removes only the line inside each matched block', () => {
  const body = { system: [textBlock(`<lead>\n${target}\n<trail>`), textBlock(''), textBlock(target)] };
  const result = filterRequest(body, 'anthropic');
  assert.equal(result.removedLines, 2);
  assert.equal(result.body.system[0].text, `<lead>\n${clean}\n<trail>`);
  assert.equal(result.body.system[1].text, '');
  assert.equal(result.body.system[2].text, clean);
});
