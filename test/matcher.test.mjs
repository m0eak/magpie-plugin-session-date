import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSessionDates } from '../src/matcher.mjs';

const dateLine = 'Session date: Tuesday, November 3, 2026';
const toolBlock = (name, body = `<session_context>\nCurrent user: demo\n${dateLine}\nConversation language: en\n</session_context>`) =>
  `<tool name="${name}">\n<tool.instructions>You have access to the ${name} Tool.\n\n${body}\n</tool.instructions>\n</tool>`;
const prompt = (tools, description = 'The tools you can use below') =>
  `<tools description="${description}">\n${tools}\n</tools>`;
const cleanSession = '<session_context>\nCurrent user: demo\nConversation language: en\n</session_context>';

 test('removes the date only inside the Memory session context', () => {
  const input = prompt(toolBlock('Memory'));
  const expected = prompt(toolBlock('Memory', '<session_context>\nCurrent user: demo\nConversation language: en\n</session_context>'));
  assert.deepEqual(stripSessionDates(input), { text: expected, removedLines: 1 });
});

test('removes the date only inside the Credentials session context', () => {
  const input = prompt(toolBlock('Credentials'));
  const expected = prompt(toolBlock('Credentials', cleanSession));
  assert.deepEqual(stripSessionDates(input), { text: expected, removedLines: 1 });
});

test('preserves line indentation, trailing horizontal space, and CRLF bytes', () => {
  const input = `<tools description="The tools you can use below">\r\n<tool name="Memory">\r\n<tool.instructions>x\r\n<session_context>\r\nCurrent user: demo\r\n \t${dateLine}\t \r\nConversation language: en\r\n</session_context>\r\n</tool.instructions>\r\n</tool>\r\n</tools>`;
  const expected = `<tools description="The tools you can use below">\r\n<tool name="Memory">\r\n<tool.instructions>x\r\n<session_context>\r\nCurrent user: demo\r\nConversation language: en\r\n</session_context>\r\n</tool.instructions>\r\n</tool>\r\n</tools>`;
  assert.deepEqual(stripSessionDates(input), { text: expected, removedLines: 1 });
});

test('removes multiple matching lines in multiple supported tools', () => {
  const first = toolBlock('Memory', `<session_context>\n${dateLine}\nCurrent date: 2026-11-04\n${dateLine}\n</session_context>`);
  const second = toolBlock('Credentials');
  const result = stripSessionDates(prompt(`${first}\n${second}`));
  assert.equal(result.removedLines, 3);
  assert.equal(result.text.includes(dateLine), false);
  assert.equal(result.text.includes('Current date: 2026-11-04'), true);
});

test('keeps identical date text outside the exact tools wrapper', () => {
  assert.deepEqual(stripSessionDates(`System note\n${dateLine}\n${prompt(toolBlock('Memory', '<session_context>\nNo session metadata\n</session_context>'))}`), {
    text: `System note\n${dateLine}\n${prompt(toolBlock('Memory', '<session_context>\nNo session metadata\n</session_context>'))}`,
    removedLines: 0,
  });
});

test('keeps a fake target tree nested beneath a non-target tool untouched', () => {
  const fake = `<tool name="Other">\n<tool name="Memory">\n<tool.instructions><session_context>\n${dateLine}\n</session_context></tool.instructions>\n</tool>\n</tool>`;
  const input = prompt(fake);
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('does not remove a date when a target tools wrapper is nested in a non-target tools block', () => {
  const input = `<tools description="other">\n${prompt(toolBlock('Memory'))}\n</tools>`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('does not treat a similarly named non-target tool as a supported wrapper', () => {
  const input = prompt(toolBlock('MemoryManager'));
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('does not broaden to a tools wrapper with a different description', () => {
  const input = prompt(toolBlock('Memory'), 'some other tools');
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('does not remove dates from ordinary system prompt text without wrappers', () => {
  const input = `<session_context>\n${dateLine}\n</session_context>`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('does not remove quoted or fenced date examples inside the target area', () => {
  const body = `<session_context>\n> ${dateLine}\n\`\`\`text\n${dateLine}\n\`\`\`\n${dateLine}\n</session_context>`;
  const input = prompt(toolBlock('Memory', body));
  const expectedBody = `<session_context>\n> ${dateLine}\n\`\`\`text\n${dateLine}\n\`\`\`\n</session_context>`;
  assert.deepEqual(stripSessionDates(input), { text: prompt(toolBlock('Memory', expectedBody)), removedLines: 1 });
});

test('does not remove dates from an indented Markdown blockquote continuation', () => {
  const input = prompt(toolBlock('Memory', `<session_context>\n> quoted example\n  ${dateLine}\n</session_context>`));
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('does not remove lines wrapped in same-line backtick or tilde fences', () => {
  for (const fence of ['```', '~~~']) {
    const body = `<session_context>\n${fence}\n${dateLine}\n${fence}\n</session_context>`;
    const input = prompt(toolBlock('Memory', body));
    assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
  }
});

test('does not recognize a target wrapper when the outer template is inside a fenced code block', () => {
  const input = `\`\`\`xml\n${prompt(toolBlock('Memory'))}\n\`\`\``;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('does not remove current-date, ISO-date, non-English, or malformed calendar lines', () => {
  const body = `<session_context>\nCurrent date: Wednesday, November 4, 2026\nDate: 2026-11-04\nSession date: Wednesday, November 3, 2026\nSession date: Tuesday, February 31, 2026\n${dateLine}\n</session_context>`;
  const expectedBody = `<session_context>\nCurrent date: Wednesday, November 4, 2026\nDate: 2026-11-04\nSession date: Wednesday, November 3, 2026\nSession date: Tuesday, February 31, 2026\n</session_context>`;
  assert.deepEqual(stripSessionDates(prompt(toolBlock('Memory', body))), {
    text: prompt(toolBlock('Memory', expectedBody)),
    removedLines: 1,
  });
});

test('keeps tags split by line indentation in the same XML tree valid', () => {
  const input = `<tools description="The tools you can use below">\n  <tool name="Memory">\n  <tool.instructions>\n    <session_context>\n      ${dateLine}\n    </session_context>\n  </tool.instructions>\n  </tool>\n</tools>`;
  const expected = `<tools description="The tools you can use below">\n  <tool name="Memory">\n  <tool.instructions>\n    <session_context>\n    </session_context>\n  </tool.instructions>\n  </tool>\n</tools>`;
  assert.deepEqual(stripSessionDates(input), { text: expected, removedLines: 1 });
});

test('removes a matching line while preserving unrelated line separators exactly', () => {
  const input = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>intro\n<session_context>\nA\r\n${dateLine}\nB\r\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
  const expected = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>intro\n<session_context>\nA\r\nB\r\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
  assert.deepEqual(stripSessionDates(input), { text: expected, removedLines: 1 });
});

test('does not throw on malformed or unclosed prompt wrappers', () => {
  const input = `<tools description="The tools you can use below"><tool name="Memory"><tool.instructions><session_context>\n${dateLine}`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('leaves a date untouched when only part of its wrapper is present', () => {
  const input = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions><session_context>\n${dateLine}\n</tool.instructions>\n</tool>\n</tools>`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('is idempotent after removing a session date line', () => {
  const once = stripSessionDates(prompt(toolBlock('Memory')));
  assert.equal(once.removedLines, 1);
  assert.deepEqual(stripSessionDates(once.text), { text: once.text, removedLines: 0 });
});

test('passes through non-string inputs without scanning them', () => {
  for (const value of [null, undefined, 7, {}, ['text']]) {
    const result = stripSessionDates(value);
    assert.equal(result.text, value);
    assert.equal(result.removedLines, 0);
  }
});

test('removes a dynamically different valid date without hard-coding one day', () => {
  const dynamic = 'Session date: Wednesday, November 4, 2026';
  const input = prompt(toolBlock('Credentials', `<session_context>\n${dynamic}\n</session_context>`));
  const result = stripSessionDates(input);
  assert.equal(result.removedLines, 1);
  assert.equal(result.text.includes(dynamic), false);
});
