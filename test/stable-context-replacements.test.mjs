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
