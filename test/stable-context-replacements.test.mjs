import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRequest } from '../src/protocols.mjs';

const AGENTS_A = `<agent_management_context>
  <instruction>Agent tools are available.</instruction>
  <current_agent id="agt_self">Self</current_agent>
  <available_models><provider id="p"><model id="m">Model</model></provider></available_models>
  <available_agents>
    <agent id="agt_a">Alpha - First description</agent>
  </available_agents>
  <available_plugins><plugin id="x">Plugin</plugin></available_plugins>
</agent_management_context>`;
const AGENTS_B = AGENTS_A.replace('agt_a', 'agt_b').replace('Alpha - First description', 'Beta - Different description');
const AVAILABLE_AGENTS_GUIDANCE = `<available_agents>
When Agent Management tools are available, use \`searchAgent\` with source="user" and an optional keyword to find workspace agents. Use \`getAgentDetail\` with agentId to inspect an agent when needed, and \`callAgent\` with agentId and instruction to delegate a task.
</available_agents>`;
const TIME_GUIDANCE = `<current_time_guidance>
When the task requires the current date or time, use an available time tool or run \`date\` if shell access is available. Use the user's specified timezone; otherwise use the runtime's configured timezone. Do not infer the current date or time from older conversation messages. If the current time cannot be verified, say so.
</current_time_guidance>`;

const options = { sessionDate: true, topicTitle: true, availableAgents: true };

test('dynamic agent lists become one fixed block and remain idempotent', () => {
  const run = (agents) => filterRequest({ messages: [{ role: 'system', content: agents }] }, 'chat', options);
  const first = run(AGENTS_A);
  const second = run(AGENTS_B);
  assert.equal(first.body.messages[0].content, second.body.messages[0].content);
  assert.equal(first.body.messages[0].content.match(/<available_agents>/g)?.length, 1);
  assert.equal(first.body.messages[0].content, AGENTS_A.replace(/<available_agents>[\s\S]*?<\/available_agents>/, AVAILABLE_AGENTS_GUIDANCE));
  assert.equal(first.availableAgentsMatchedRequests, 1);
  assert.equal(first.availableAgentsReplacedBlocks, 1);
  assert.equal(filterRequest(first.body, 'chat', options).changed, false);
});

test('date removal inserts one fixed time hint without dynamic date text', () => {
  const input = 'Current date: 2026-11-11 (Asia/Shanghai)\nCurrent date: 2026-11-11';
  const result = filterRequest({ messages: [{ role: 'system', content: input }] }, 'chat', { ...options, availableAgents: false });
  assert.equal(result.body.messages[0].content, `${TIME_GUIDANCE}\n`);
  assert.equal(result.removedLines, 2);
  assert.equal(result.dateRemovedLines, 2);
  assert.equal(result.timeGuidanceInsertedBlocks, 1);
  assert.equal(filterRequest(result.body, 'chat', { ...options, availableAgents: false }).changed, false);
});

test('environment user agent context is transformed only in the first eligible user message', () => {
  const body = { messages: [{ role: 'system', content: 'Keep system text.' }, { role: 'user', content: AGENTS_A }, { role: 'user', content: AGENTS_A }] };
  const result = filterRequest(body, 'chat', options);
  assert.equal(result.body.messages[1].content, AGENTS_A.replace(/<available_agents>[\s\S]*?<\/available_agents>/, AVAILABLE_AGENTS_GUIDANCE));
  assert.equal(result.body.messages[2].content, AGENTS_A);
});

test('ordinary user examples and quoted or fenced blocks are preserved', () => {
  const ordinary = `Please explain this XML:\n\`\`\`xml\n${AGENTS_A}\n\`\`\``;
  const body = { messages: [{ role: 'user', content: ordinary }, { role: 'assistant', content: AGENTS_A }] };
  const result = filterRequest(body, 'chat', options);
  assert.strictEqual(result.body, body);
  assert.equal(result.availableAgentsMatchedRequests, 0);
});

test('old two-key config defaults the new independent option off', async () => {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FilterConfigStore } = await import('../src/filter-config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'stable-context-config-'));
  const path = join(dir, 'filter-config.json');
  writeFileSync(path, JSON.stringify({ sessionDate: false, topicTitle: true }));
  const store = new FilterConfigStore({ dataDir: dir, schedule: () => null });
  try {
    assert.deepEqual(store.snapshot(), { sessionDate: false, topicTitle: true, availableAgents: false });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { sessionDate: false, topicTitle: true });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const mergedEnvironment = `<user_memory>\nExample memory.\n</user_memory>\n\n${AGENTS_A}`;

test('all protocol adapters replace a merged first environment message in place', () => {
  const cases = [
    ['chat', { messages: [{ role: 'user', content: mergedEnvironment }, { role: 'assistant', content: 'ok' }] }, (body) => body.messages[0].content],
    ['responses', { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: mergedEnvironment }] }] }, (body) => body.input[0].content[0].text],
    ['anthropic', { messages: [{ role: 'user', content: mergedEnvironment }, { role: 'assistant', content: 'ok' }] }, (body) => body.messages[0].content],
    ['gemini', { contents: [{ role: 'user', parts: [{ text: mergedEnvironment }] }] }, (body) => body.contents[0].parts[0].text],
  ];
  for (const [protocol, body, getText] of cases) {
    const result = filterRequest(body, protocol, options);
    assert.equal(result.availableAgentsReplacedBlocks, 1, `${protocol} counts one replacement`);
    assert.equal(result.body.messages?.length ?? result.body.input?.length ?? result.body.contents?.length,
      body.messages?.length ?? body.input?.length ?? body.contents?.length, `${protocol} keeps message count`);
    assert.ok(getText(result.body).startsWith('<user_memory>\nExample memory.\n</user_memory>\n\n'));
    assert.ok(getText(result.body).includes('When Agent Management tools are available'));
  }
});

test('later user messages after conversation history are outside the environment candidate', () => {
  const cases = [
    ['chat', { messages: [{ role: 'assistant', content: 'prior' }, { role: 'user', content: AGENTS_A }] }],
    ['responses', { input: [{ type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: AGENTS_A }] }] }],
    ['anthropic', { messages: [{ role: 'assistant', content: 'prior' }, { role: 'user', content: AGENTS_A }] }],
    ['gemini', { contents: [{ role: 'model', parts: [{ text: 'prior' }] }, { role: 'user', parts: [{ text: AGENTS_A }] }] }],
  ];
  for (const [protocol, body] of cases) {
    const result = filterRequest(body, protocol, options);
    assert.equal(result.availableAgentsReplacedBlocks, 0, protocol);
    assert.equal(result.body, body, `${protocol} retains original body identity`);
  }
});

test('system and developer date rows remain eligible after conversation messages', () => {
  const body = { messages: [
    { role: 'system', content: 'System.' },
    { role: 'user', content: 'Question.' },
    { role: 'assistant', content: 'Answer.' },
    { role: 'developer', content: 'Current date: 2026-11-11' },
  ] };
  const result = filterRequest(body, 'chat', options);
  assert.equal(result.timeGuidanceInsertedBlocks, 1);
  assert.match(result.body.messages[3].content, /<current_time_guidance>/);
});

test('agent structure accepts multiline escaped text and refuses mismatched tags', () => {
  const multiline = AGENTS_A.replace('Example agent', 'Example\nagent &amp; helper');
  const valid = filterRequest({ messages: [{ role: 'system', content: multiline }] }, 'chat', options);
  assert.equal(valid.availableAgentsReplacedBlocks, 1);
  const malformed = AGENTS_A.replace('</agent>', '</note>');
  const invalid = filterRequest({ messages: [{ role: 'system', content: malformed }] }, 'chat', options);
  assert.equal(invalid.changed, false);
  assert.equal(invalid.availableAgentsReplacedBlocks, 0);
});

test('quoted and fenced agent examples remain untouched while active blocks transform', () => {
  const quoted = AGENTS_A.split('\n').map((line) => `> ${line}`).join('\n');
  const fenced = `\`\`\`\`xml\n\`\`\`\n${AGENTS_A}\n\`\`\`\``;
  const active = `${fenced}\n${AGENTS_A}`;
  const result = filterRequest({ messages: [{ role: 'system', content: `${quoted}\n${active}` }] }, 'chat', options);
  assert.equal(result.availableAgentsReplacedBlocks, 1);
  assert.ok(result.body.messages[0].content.includes(quoted));
  assert.ok(result.body.messages[0].content.includes(fenced));
  assert.equal((result.body.messages[0].content.match(/When Agent Management tools are available/g) ?? []).length, 1);
});

test('fixed time guidance inside a code fence does not suppress an active insertion', () => {
  const text = `\`\`\`xml\n${TIME_GUIDANCE}\n\`\`\`\nCurrent date: 2026-11-11`;
  const result = filterRequest({ messages: [{ role: 'system', content: text }] }, 'chat', options);
  assert.equal(result.timeGuidanceInsertedBlocks, 1);
  assert.equal((result.body.messages[0].content.match(/<current_time_guidance>/g) ?? []).length, 2);
});

test('active time guidance suppresses insertion and does not increment the insertion counter', () => {
  const result = filterRequest({ messages: [{ role: 'system', content: `${TIME_GUIDANCE}\nCurrent date: 2026-11-11` }] }, 'chat', options);
  assert.equal(result.timeGuidanceInsertedBlocks, 0);
  assert.equal((result.body.messages[0].content.match(/<current_time_guidance>/g) ?? []).length, 1);
});

test('one request may insert time guidance in multiple text regions', () => {
  const result = filterRequest({ messages: [
    { role: 'system', content: 'Current date: 2026-11-11' },
    { role: 'developer', content: 'Current date: 2026-11-11' },
  ] }, 'chat', options);
  assert.equal(result.removedLines, 2);
  assert.equal(result.timeGuidanceInsertedBlocks, 2);
});

test('agent instructions change only inside a recognized context with a replaced live list', () => {
  const oldInstruction = "The `available_agents` section lists the user's other existing agents (you are not in this list). When the user's request clearly matches one of them, you may delegate to it via the Agent Management `callAgent` tool (activating the tool first if it is not already enabled). If no listed agent matches, use `searchAgent` to look further (including the marketplace).";
  const standalone = filterRequest({ messages: [{ role: 'system', content: oldInstruction }] }, 'chat', options);
  assert.equal(standalone.changed, false);
  assert.equal(standalone.removedLines, 0);
  assert.equal(standalone.availableAgentsReplacedBlocks, 0);
});

test('repeated agent entries collapse with the list and count as one replaced block', () => {
  const repeated = AGENTS_A.replace('</available_agents>', '<agent id="agt_a">Alpha - First description</agent></available_agents>');
  const result = filterRequest({ messages: [{ role: 'system', content: repeated }] }, 'chat', options);
  assert.equal(result.availableAgentsReplacedBlocks, 1);
  assert.equal((result.body.messages[0].content.match(/When Agent Management tools are available/g) ?? []).length, 1);
});

const HOST_ENVIRONMENT_WRAPPERS = [
  '<agent_knowledge><instruction>Knowledge</instruction></agent_knowledge>',
  '<available_tools description="Installed tools"><tool identifier="x" name="Example">Use it</tool></available_tools>',
  '<expertise><domain id="ops" name="Operations">Scope</domain></expertise>',
  '<group_context>Group context</group_context>',
  '<discord_context><channel id="channel-1" /></discord_context>',
  '<plan><goal>Keep the context stable</goal></plan>',
  '<agent_documents_index>Documents</agent_documents_index>',
  '<agent_document id="doc-1">Document</agent_document>',
  '<current_agent_context><instruction>Agent builder</instruction></current_agent_context>',
  '<current_group_context><instruction>Group builder</instruction></current_group_context>',
  '<onboarding_context><phase>discover</phase></onboarding_context>',
  '<user_memory><instruction>Memory</instruction></user_memory>',
];

function environmentWithWrappers(wrapperOrder) {
  return [
    ...wrapperOrder,
    '<agent_management_context>',
    '  <instruction>Delegate matching requests.</instruction>',
    '  <current_agent id="self" />',
    '  <available_models>Models</available_models>',
    '  <available_agents>',
    '    <note>Only the 10 most recently updated agents are listed here.</note>',
    '    <agent id="agt_a">Alpha</agent>',
    '  </available_agents>',
    '  <available_plugins>Plugins</available_plugins>',
    '</agent_management_context>',
  ].join('\n');
}

test('recognizes the shared host environment with known wrappers around agent management', () => {
  const source = environmentWithWrappers(HOST_ENVIRONMENT_WRAPPERS);
  const result = filterRequest(
    { messages: [{ role: 'user', content: source }] },
    'chat',
    { sessionDate: false, topicTitle: false, availableAgents: true },
  );

  assert.equal(result.availableAgentsReplacedBlocks, 1);
  assert.equal(result.body.messages[0].content.includes('<agent_knowledge>'), true);
  assert.equal(result.body.messages[0].content.includes('<available_tools description="Installed tools">'), true);
  assert.equal(result.body.messages[0].content.includes('<onboarding_context>'), true);
  assert.equal(result.body.messages[0].content.includes('<available_agents>\nWhen Agent Management tools are available'), true);
  assert.equal(result.body.messages[0].content.includes('<agent id="agt_a">Alpha</agent>'), false);
});

test('recognizes shared host wrappers in every supported protocol', () => {
  const source = environmentWithWrappers([
    HOST_ENVIRONMENT_WRAPPERS[0],
    HOST_ENVIRONMENT_WRAPPERS[1],
  ]);
  const opts = { sessionDate: false, topicTitle: false, availableAgents: true };
  const bodies = {
    chat: { messages: [{ role: 'user', content: source }] },
    responses: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: source }] }] },
    anthropic: { messages: [{ role: 'user', content: [{ type: 'text', text: source }] }] },
    gemini: { contents: [{ role: 'user', parts: [{ text: source }] }] },
  };

  for (const [protocol, body] of Object.entries(bodies)) {
    const result = filterRequest(body, protocol, opts);
    assert.equal(result.availableAgentsReplacedBlocks, 1, protocol);
    const text = protocol === 'chat'
      ? result.body.messages[0].content
      : protocol === 'responses'
        ? result.body.input[0].content[0].text
        : protocol === 'anthropic'
          ? result.body.messages[0].content[0].text
          : result.body.contents[0].parts[0].text;
    assert.equal(text.includes('<agent_knowledge>'), true, protocol);
    assert.equal(text.includes('<available_tools description="Installed tools">'), true, protocol);
    assert.equal(text.includes('<available_agents>\nWhen Agent Management tools are available'), true, protocol);
  }
});

function environmentWithManagementAround(before, after, agents = AGENTS_A) {
  return [
    ...before,
    agents,
    ...after,
  ].join('\n');
}

function protocolEnvironmentCases(source) {
  return [
    ['chat', {
      messages: [{ role: 'user', content: source }],
      tools: [{ type: 'function', function: { name: 'keep_chat_tool' } }],
      cache_control: { type: 'ephemeral' },
    }, (body) => body.messages[0].content],
    ['responses', {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: source }] }],
      tools: [{ type: 'function', name: 'keep_responses_tool' }],
      prompt_cache_key: 'keep-responses-cache-key',
    }, (body) => body.input[0].content[0].text],
    ['anthropic', {
      messages: [{ role: 'user', content: source }],
      tools: [{ name: 'keep_anthropic_tool' }],
      cache_control: { type: 'ephemeral' },
    }, (body) => body.messages[0].content],
    ['gemini', {
      contents: [{ role: 'user', parts: [{ text: source }] }],
      systemInstruction: { parts: [{ text: 'keep system instruction' }], vendorMeta: { keep: true } },
      tools: [{ functionDeclarations: [{ name: 'keep_gemini_tool' }] }],
      generationConfig: { temperature: 0.2 },
    }, (body) => body.contents[0].parts[0].text],
  ];
}

test('replaces agent lists when knowledge and tool wrappers appear before or after them in every protocol', () => {
  const knowledge = '<agent_knowledge><instruction>Knowledge stays.</instruction></agent_knowledge>';
  const tools = '<available_tools description="Installed tools"><tool identifier="x">Tool stays.</tool></available_tools>';
  const variants = [
    { before: [knowledge], after: [] },
    { before: [], after: [knowledge] },
    { before: [tools], after: [] },
    { before: [], after: [tools] },
    { before: [knowledge], after: [tools] },
    { before: [tools], after: [knowledge, '<plan><goal>Plan stays.</goal></plan>'] },
  ];

  for (const { before, after } of variants) {
    const source = environmentWithManagementAround(before, after);
    for (const [protocol, body, getText] of protocolEnvironmentCases(source)) {
      const original = structuredClone(body);
      const result = filterRequest(body, protocol, options);
      assert.equal(result.availableAgentsReplacedBlocks, 1, `${protocol} replaces one list`);
      assert.equal(result.changed, true, `${protocol} reports a change`);
      const text = getText(result.body);
      assert.equal(text.includes(AVAILABLE_AGENTS_GUIDANCE), true, `${protocol} has fixed guidance`);
      for (const wrapper of [...before, ...after]) {
        assert.equal(text.includes(wrapper), true, `${protocol} keeps ${wrapper}`);
      }
      assert.deepEqual(body, original, `${protocol} does not mutate its input`);
      assert.deepEqual(
        Object.fromEntries(Object.entries(result.body).filter(([key]) => key !== 'messages' && key !== 'input' && key !== 'contents')),
        Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'messages' && key !== 'input' && key !== 'contents')),
        `${protocol} keeps tools and cache metadata`,
      );
    }
  }
});

test('keeps the supported non-management wrappers byte-for-byte while replacing the list', () => {
  for (const wrapper of HOST_ENVIRONMENT_WRAPPERS) {
    const source = environmentWithManagementAround([wrapper], []);
    const result = filterRequest(
      { messages: [{ role: 'user', content: source }] },
      'chat',
      options,
    );
    assert.equal(result.availableAgentsReplacedBlocks, 1, wrapper);
    assert.equal(result.body.messages[0].content.includes(wrapper), true, wrapper);
  }
});

test('produces the same final payload when only the dynamic agent list changes', () => {
  for (const [protocol, bodyA, getText] of protocolEnvironmentCases(
    environmentWithManagementAround(['<agent_knowledge>Knowledge</agent_knowledge>'], []),
  )) {
    const sourceA = getText(bodyA);
    const bodyB = structuredClone(bodyA);
    const replaceText = (body) => {
      if (protocol === 'chat' || protocol === 'anthropic') return body.messages[0].content;
      if (protocol === 'responses') return body.input[0].content[0].text;
      return body.contents[0].parts[0].text;
    };
    const setText = (body, text) => {
      if (protocol === 'chat' || protocol === 'anthropic') body.messages[0].content = text;
      else if (protocol === 'responses') body.input[0].content[0].text = text;
      else body.contents[0].parts[0].text = text;
    };
    setText(bodyB, sourceA.replace(AGENTS_A, AGENTS_B));
    const resultA = filterRequest(bodyA, protocol, options);
    const resultB = filterRequest(bodyB, protocol, options);
    assert.deepEqual(resultA.body, resultB.body, `${protocol} final payload is stable`);
    assert.equal(replaceText(resultA.body).includes(AVAILABLE_AGENTS_GUIDANCE), true, protocol);
  }
});

test('does not replace the environment list when the assistant-list switch is disabled', () => {
  const source = environmentWithManagementAround(['<agent_knowledge>Knowledge</agent_knowledge>'], []);
  for (const [protocol, body, getText] of protocolEnvironmentCases(source)) {
    const result = filterRequest(body, protocol, { ...options, availableAgents: false });
    assert.strictEqual(result.body, body, protocol);
    assert.equal(result.availableAgentsReplacedBlocks, 0, protocol);
    assert.equal(getText(body).includes('<agent id="agt_a">'), true, protocol);
  }
});

test('rejects unknown, ordinary, fenced, quoted, nested, malformed, and historical user content', () => {
  const cases = [
    `<unknown_wrapper>${AGENTS_A}</unknown_wrapper>`,
    `Please explain this XML:\n${AGENTS_A}`,
    `\`\`\`xml\n${AGENTS_A}\n\`\`\``,
    `> ${AGENTS_A.replaceAll('\n', '\n> ')}`,
    `<outer><agent_management_context>${AGENTS_A}</agent_management_context></outer>`,
    AGENTS_A.replace('</available_agents>', ''),
  ];
  for (const source of cases) {
    const body = { messages: [{ role: 'user', content: source }] };
    const result = filterRequest(body, 'chat', options);
    assert.strictEqual(result.body, body, source.slice(0, 40));
    assert.equal(result.availableAgentsReplacedBlocks, 0, source.slice(0, 40));
  }

  const historical = {
    messages: [
      { role: 'assistant', content: 'history' },
      { role: 'user', content: AGENTS_A },
    ],
  };
  const historicalResult = filterRequest(historical, 'chat', options);
  assert.strictEqual(historicalResult.body, historical);
  assert.equal(historicalResult.availableAgentsReplacedBlocks, 0);
});

test('is idempotent after replacing a shared environment list', () => {
  const body = { messages: [{ role: 'user', content: environmentWithManagementAround(
    ['<available_tools>Tools</available_tools>'],
    ['<current_group_context>Group</current_group_context>'],
  ) }] };
  const first = filterRequest(body, 'chat', options);
  const second = filterRequest(first.body, 'chat', options);
  assert.equal(first.availableAgentsReplacedBlocks, 1);
  assert.equal(second.changed, false);
  assert.equal(second.availableAgentsReplacedBlocks, 0);
  assert.deepEqual(second.body, first.body);
});
