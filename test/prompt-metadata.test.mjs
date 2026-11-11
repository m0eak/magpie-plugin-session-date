import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSessionDates } from '../src/matcher.mjs';
import { filterRequest } from '../src/protocols.mjs';
import { createRequestHook } from '../src/request.hooks.mjs';

const currentDate = 'Current date: 2026-11-11 (Asia/Shanghai)';
const emptyTitle = '| Topic Title |  |';
const firstTitle = '| Topic Title | 你好 |';
const nextTitle = '| Topic Title | 本周计划 |';

test('removes blank, real, and pipe-containing topic title rows and current date lines', () => {
  for (const title of [emptyTitle, firstTitle, '| Topic Title | Alpha | Beta |']) {
    const input = `Before\n${title}\n${currentDate}\nAfter`;
    assert.deepEqual(stripSessionDates(input), {
      text: 'Before\nAfter',
      removedLines: 2,
    });
  }
});

test('removes metadata rows with CRLF while preserving the surrounding bytes', () => {
  const input = `prefix\r\n${firstTitle}\r\n${currentDate}\r\nsuffix`;
  assert.deepEqual(stripSessionDates(input), {
    text: 'prefix\r\nsuffix',
    removedLines: 2,
  });
});

test('matches complete current date lines with optional timezone only', () => {
  const input = [
    'Current date: 2026-11-11',
    'Current date: 2026-02-30 (UTC)',
    'Current date: 2026-11-11 extra',
    'The Current date: 2026-11-11',
    'Current date: 2026-11-11 (Asia/Shanghai)',
  ].join('\n');
  assert.deepEqual(stripSessionDates(input), {
    text: 'Current date: 2026-02-30 (UTC)\nCurrent date: 2026-11-11 extra\nThe Current date: 2026-11-11\n',
    removedLines: 2,
  });
});

test('topic-title and current-date changes produce identical transformed static prompts', () => {
  const first = `Stable system instructions\n${emptyTitle}\n${currentDate}\nStable tail`;
  const second = `Stable system instructions\n${nextTitle}\nCurrent date: 2026-11-12 (Asia/Shanghai)\nStable tail`;
  assert.equal(stripSessionDates(first).text, stripSessionDates(second).text);
});

test('does not remove metadata-looking lines from fenced code or unrelated body fields', () => {
  const fenced = `Example:\n\`\`\`md\n${firstTitle}\n${currentDate}\n\`\`\`\nDone`;
  assert.equal(stripSessionDates(fenced).text, fenced);

  const userText = `${firstTitle}\n${currentDate}`;
  const body = {
    messages: [
      { role: 'system', content: 'System stays' },
      { role: 'user', content: userText },
      { role: 'assistant', content: userText },
      { role: 'tool', content: userText },
    ],
  };
  const result = filterRequest(body, 'chat');
  assert.equal(result.body, body);
  assert.equal(result.removedLines, 0);
});

test('filters metadata consistently in the known prompt fields of all four protocols', () => {
  const clean = `Stable instructions\n${timeGuidance}\nStable tail`;
  const cases = [
    ['chat', { messages: [{ role: 'system', content: `Stable instructions\n${emptyTitle}\n${currentDate}\nStable tail` }] }, (body) => body.messages[0].content],
    ['responses', { instructions: `Stable instructions\n${emptyTitle}\n${currentDate}\nStable tail` }, (body) => body.instructions],
    ['anthropic', { system: `Stable instructions\n${emptyTitle}\n${currentDate}\nStable tail` }, (body) => body.system],
    ['gemini', { systemInstruction: { parts: [{ text: `Stable instructions\n${emptyTitle}\n${currentDate}\nStable tail` }] } }, (body) => body.systemInstruction.parts[0].text],
  ];

  for (const [protocol, body, readPrompt] of cases) {
    const result = filterRequest(body, protocol);
    assert.equal(readPrompt(result.body), clean, protocol);
    assert.equal(result.removedLines, 2, protocol);
    assert.equal(filterRequest(result.body, protocol).removedLines, 0, `${protocol} is idempotent`);
  }
});

const stablePrompt = (title, date) => [
  'Agent system role: follow the configured instructions.',
  '| Topic Description | Stable topic metadata |',
  `| Topic Title | ${title} |`,
  `Current date: ${date} (Asia/Shanghai)`,
  '<tools description="The tools you can use below">',
  '<tool name="Memory">',
  '<tool.instructions>',
  '<session_context>',
  'Memory instructions remain stable.',
  '</session_context>',
  '</tool.instructions>',
  '</tool>',
  '</tools>',
].join('\n');
const timeGuidance = `<current_time_guidance>
When the task requires the current date or time, use an available time tool or run \`date\` if shell access is available. Use the user's specified timezone; otherwise use the runtime's configured timezone. Do not infer the current date or time from older conversation messages. If the current time cannot be verified, say so.
</current_time_guidance>`;
const normalizedStablePrompt = stripSessionDates(
  stablePrompt('placeholder', '2026-11-11').replace(/^Current date:.*$/m, timeGuidance),
).text;

function pairedProtocolBodies(protocol, title, date) {
  const prompt = stablePrompt(title, date);
  if (protocol === 'chat') {
    return { messages: [{ role: 'system', content: prompt }] };
  }
  if (protocol === 'responses') {
    return { instructions: prompt };
  }
  if (protocol === 'anthropic') {
    return { system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] };
  }
  return { systemInstruction: { parts: [{ text: prompt }] } };
}

test('all four protocols normalize empty, real, Discord, and pipe titles across date changes', () => {
  const variants = ['', '你好', 'discord-thread-name', 'Alpha | Beta'];
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    for (const title of variants) {
      const first = pairedProtocolBodies(protocol, title, '2026-11-11');
      const second = pairedProtocolBodies(protocol, title, '2026-11-13');
      const firstOriginal = structuredClone(first);
      const secondOriginal = structuredClone(second);
      const firstResult = filterRequest(first, protocol);
      const secondResult = filterRequest(second, protocol);
      assert.deepEqual(first, firstOriginal, `${protocol} first request was mutated`);
      assert.deepEqual(second, secondOriginal, `${protocol} second request was mutated`);
      assert.deepEqual(firstResult.body, secondResult.body, `${protocol} static prompt differs for title ${title}`);
      assert.equal(firstResult.removedLines, 2, `${protocol} first removal count`);
      assert.equal(secondResult.removedLines, 2, `${protocol} second removal count`);

      const firstAgain = filterRequest(firstResult.body, protocol);
      const secondAgain = filterRequest(secondResult.body, protocol);
      assert.deepEqual(firstAgain.body, firstResult.body, `${protocol} first transform is not idempotent`);
      assert.deepEqual(secondAgain.body, secondResult.body, `${protocol} second transform is not idempotent`);
      assert.equal(firstAgain.removedLines, 0, `${protocol} first second-pass count`);
      assert.equal(secondAgain.removedLines, 0, `${protocol} second second-pass count`);
    }
  }
});

function historyCase(protocol, title, date) {
  const prompt = stablePrompt(title, date);
  const parameters = {
    type: 'object',
    properties: { query: { type: 'string' } },
  };
  const chatToolSchema = {
    type: 'function',
    function: {
      name: 'lookup_memory',
      description: 'Read a memory entry.',
      parameters,
    },
  };
  const responsesToolSchema = {
    type: 'function',
    name: 'lookup_memory',
    description: 'Read a memory entry.',
    parameters,
  };
  const anthropicToolSchema = {
    name: 'lookup_memory',
    description: 'Read a memory entry.',
    input_schema: parameters,
  };
  if (protocol === 'chat') {
    return {
      messages: [
        { role: 'system', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'Find the deployment note.' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'lookup_memory', arguments: '{"query":"deployment"}' } },
          { id: 'call-2', type: 'function', function: { name: 'lookup_memory', arguments: '{"query":"release"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call-1', content: 'Deployment note result.' },
        { role: 'tool', tool_call_id: 'call-2', content: 'Release note result.' },
        { role: 'assistant', content: 'The note says the change is local.' },
      ],
      tools: [chatToolSchema],
      cache_control: { type: 'ephemeral' },
    };
  }
  if (protocol === 'responses') {
    return {
      instructions: 'Stable developer instructions.',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: prompt, cache_control: { type: 'ephemeral' } }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Find the deployment note.' }] },
        { type: 'function_call', call_id: 'call-1', name: 'lookup_memory', arguments: '{"query":"deployment"}' },
        { type: 'function_call', call_id: 'call-2', name: 'lookup_memory', arguments: '{"query":"release"}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'Deployment note result.' },
        { type: 'function_call_output', call_id: 'call-2', output: 'Release note result.' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The note says the change is local.' }] },
      ],
      tools: [responsesToolSchema],
      metadata: { cache_control: { type: 'ephemeral' } },
    };
  }
  if (protocol === 'anthropic') {
    return {
      system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'Find the deployment note.' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'call-1', name: 'lookup_memory', input: { query: 'deployment' } },
          { type: 'tool_use', id: 'call-2', name: 'lookup_memory', input: { query: 'release' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'Deployment note result.' },
          { type: 'tool_result', tool_use_id: 'call-2', content: 'Release note result.' },
        ] },
        { role: 'assistant', content: [{ type: 'text', text: 'The note says the change is local.' }] },
      ],
      tools: [anthropicToolSchema],
      cache_control: { type: 'ephemeral' },
    };
  }
  return {
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [
      { role: 'user', parts: [{ text: 'Find the deployment note.' }] },
      { role: 'model', parts: [
        { functionCall: { name: 'lookup_memory', args: { query: 'deployment' } } },
        { functionCall: { name: 'lookup_memory', args: { query: 'release' } } },
      ] },
      { role: 'user', parts: [
        { functionResponse: { name: 'lookup_memory', response: { result: 'Deployment note result.' } } },
        { functionResponse: { name: 'lookup_memory', response: { result: 'Release note result.' } } },
      ] },
      { role: 'model', parts: [{ text: 'The note says the change is local.' }] },
    ],
    tools: [{ functionDeclarations: [{ name: 'lookup_memory', description: 'Read a memory entry.', parameters }] }],
    generationConfig: { temperature: 0.2 },
  };
}

function setHistoryPrompt(body, protocol, prompt) {
  if (protocol === 'chat') body.messages[0].content[0].text = prompt;
  else if (protocol === 'responses') body.input[0].content[0].text = prompt;
  else if (protocol === 'anthropic') body.system[0].text = prompt;
  else body.systemInstruction.parts[0].text = prompt;
}

test('preserves complete tool histories, schemas, cache metadata, order, and input immutability', () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    const body = historyCase(protocol, '你好', '2026-11-11');
    const original = structuredClone(body);
    const expected = structuredClone(body);
    setHistoryPrompt(expected, protocol, normalizedStablePrompt);
    const result = filterRequest(body, protocol);
    assert.deepEqual(body, original, `${protocol} input was mutated`);
    assert.deepEqual(result.body, expected, `${protocol} changed non-target history or metadata`);
    assert.equal(result.removedLines, 2, `${protocol} removal count`);
  }
});

test('the public onRequest hook transforms a mixed date and title request and records it', async () => {
  const events = [];
  const hook = createRequestHook({
    store: { record: (event) => events.push(event) },
    now: () => new Date('2026-11-11T00:00:00.000Z'),
  });
  const body = historyCase('chat', 'Discord thread name', '2026-11-11');
  const original = structuredClone(body);
  const result = await hook(body, { protocol: 'chat' });
  assert.deepEqual(body, original, 'onRequest mutated the input');
  assert.equal(result.messages[0].content[0].text, normalizedStablePrompt);
  assert.equal(result.messages[1], body.messages[1]);
  assert.equal(result.messages[2], body.messages[2]);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(events, [{ matched: true, removedLines: 2, dateRemovedLines: 1, topicTitleRemovedLines: 1, availableAgentsMatched: false, availableAgentsReplacedBlocks: 0, timeGuidanceInsertedBlocks: 1, at: '2026-11-11T00:00:00.000Z' }]);
});

test('filters Responses system and developer text, including typed text blocks only', () => {
  const body = {
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: `${firstTitle}\n${currentDate}` }] },
      { type: 'message', role: 'developer', content: `${nextTitle}\n${currentDate}` },
      { type: 'message', role: 'user', content: `${firstTitle}\n${currentDate}` },
      { type: 'function_call_output', output: `${firstTitle}\n${currentDate}` },
      { type: 'message', role: 'developer', content: [{ type: 'input_image', image_url: 'opaque' }] },
    ],
  };
  const result = filterRequest(body, 'responses');
  assert.equal(result.removedLines, 4);
  assert.equal(result.body.input[0].content[0].text, timeGuidance);
  assert.equal(result.body.input[1].content, timeGuidance);
  assert.equal(result.body.input[2], body.input[2]);
  assert.equal(result.body.input[3], body.input[3]);
  assert.equal(result.body.input[4], body.input[4]);
});

test('preserves unsupported protocols, unknown fields, and unmatched body references', () => {
  const unsupported = { messages: [{ role: 'system', content: `${firstTitle}\n${currentDate}` }] };
  assert.deepEqual(filterRequest(unsupported, 'unknown'), {
    body: unsupported,
    removedLines: 0,
    supported: false,
  });

  const body = {
    messages: [{ role: 'user', content: `${firstTitle}\n${currentDate}` }],
    extension: { prompt: `${firstTitle}\n${currentDate}` },
  };
  const result = filterRequest(body, 'chat');
  assert.equal(result.body, body);
  assert.equal(result.removedLines, 0);
});

test('retains the Session date wrapper and tool-name restrictions', () => {
  const sessionLine = 'Session date: Wednesday, November 11, 2026';
  const inMemory = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>\n<session_context>\n${sessionLine}\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
  const unrelated = `<tools description="The tools you can use below">\n<tool name="Other">\n<tool.instructions>\n<session_context>\n${sessionLine}\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
  assert.equal(stripSessionDates(inMemory).text.includes(sessionLine), false);
  assert.equal(stripSessionDates(unrelated).text.includes(sessionLine), true);
});
