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

test('preserves skipped wrappers before a later matching wrapper exactly', () => {
  const skipped = prompt(toolBlock('Other'));
  const matched = prompt(toolBlock('Memory'));
  const expectedMatch = prompt(toolBlock('Memory', cleanSession));
  const input = `${skipped}\nordinary note\n${matched}`;
  assert.deepEqual(stripSessionDates(input), {
    text: `${skipped}\nordinary note\n${expectedMatch}`,
    removedLines: 1,
  });
});

test('fails open when a blockquote closing tag is the only outer tools close', () => {
  const target = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions><session_context>\n${dateLine}\n</session_context></tool.instructions>\n</tool>`;
  const input = `${target}\n> </tools>`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('fails open when a fenced closing tag is the only outer tools close', () => {
  const target = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions><session_context>\n${dateLine}\n</session_context></tool.instructions>\n</tool>`;
  const input = `${target}\n\`\`\`xml\n</tools>\n\`\`\``;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('fails open for a target wrapper nested inside an unterminated outer tools tag', () => {
  const nestedTarget = prompt(toolBlock('Memory'));
  const input = `<tools description="The tools you can use below">broken\n${nestedTarget}`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('fails open for multiple target wrappers nested inside a complete non-target tools tag', () => {
  const firstTarget = prompt(toolBlock('Memory'));
  const secondTarget = prompt(toolBlock('Credentials'));
  const input = `<tools description="wrong">\n${firstTarget}\n${secondTarget}\n</tools>`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('fails open on malformed tools regions before or after otherwise legal wrappers', () => {
  const valid = prompt(toolBlock('Memory'));
  const malformedOpen = '<tools description="The tools you can use below">broken';
  const malformedOuter = `<tools description="The tools you can use below">\n${valid}`;
  const malformedClose = '</tools> stray close';
  const cases = [
    `${malformedOpen}\n${valid}`,
    `${valid}\n${malformedOpen}`,
    `${valid}\n${malformedOuter}`,
    `${malformedOuter}\n${valid}`,
    `${valid}\n${malformedClose}\n${valid}`,
  ];
  for (const input of cases) {
    assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
  }
});

test('fails open for nested closes and unmatched tools closing tags', () => {
  const nestedTarget = prompt(toolBlock('Memory'));
  const nested = `<tools description="wrong">\n${nestedTarget}\n</tools>`;
  const extraNestedClose = `${nested}\n</tools>`;
  const unmatchedClose = `</tools> stray close\n${nestedTarget}`;
  for (const input of [nested, extraNestedClose, unmatchedClose]) {
    assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
  }
});

test('filters multiple flat valid tools wrappers while preserving every wrapper boundary', () => {
  const first = prompt(toolBlock('Memory'));
  const second = prompt(toolBlock('Credentials'));
  const expected = `${prompt(toolBlock('Memory', cleanSession))}\n${prompt(toolBlock('Credentials', cleanSession))}`;
  assert.deepEqual(stripSessionDates(`${first}\n${second}`), { text: expected, removedLines: 2 });
});

test('preserves an unterminated wrapper after a matching wrapper exactly', () => {
  const matched = prompt(toolBlock('Memory'));
  const malformedTail = '\n<tools description="The tools you can use below">broken';
  const input = `${matched}${malformedTail}`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});

test('preserves skipped wrappers between two matching wrappers exactly', () => {
  const first = prompt(toolBlock('Memory'));
  const firstExpected = prompt(toolBlock('Memory', cleanSession));
  const skipped = prompt(toolBlock('Other'));
  const second = prompt(toolBlock('Credentials'));
  const secondExpected = prompt(toolBlock('Credentials', cleanSession));
  const input = `${first}\n${skipped}\n${second}`;
  assert.deepEqual(stripSessionDates(input), {
    text: `${firstExpected}\n${skipped}\n${secondExpected}`,
    removedLines: 2,
  });
});

test('preserves multiple skipped wrappers and ordinary text before a match', () => {
  const skippedA = prompt(toolBlock('Other'));
  const skippedB = prompt(toolBlock('MemoryManager'));
  const skippedText = 'ordinary system instruction';
  const matched = prompt(toolBlock('Credentials'));
  const expectedMatch = prompt(toolBlock('Credentials', cleanSession));
  const input = `${skippedA}\n${skippedText}\n${skippedB}\n${matched}`;
  assert.deepEqual(stripSessionDates(input), {
    text: `${skippedA}\n${skippedText}\n${skippedB}\n${expectedMatch}`,
    removedLines: 1,
  });
});

test('returns a zero-match input byte-for-byte unchanged after multiple skipped candidates', () => {
  const skippedA = prompt(toolBlock('Other'));
  const malformed = '<tools description="The tools you can use below">open without close';
  const skippedB = prompt(toolBlock('MemoryManager'));
  const input = `${skippedA}\n${malformed}\n${skippedB}`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
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

test('supports valid early years without Date.UTC year remapping', () => {
  const cases = [
    ['Session date: Monday, January 1, 0001', 1],
    ['Session date: Saturday, March 15, 0042', 1],
    ['Session date: Thursday, December 31, 0099', 1],
    ['Session date: Sunday, February 29, 0004', 1],
    ['Session date: Wednesday, November 4, 2026', 1],
    ['Session date: Tuesday, February 29, 0004', 0],
    ['Session date: Monday, February 29, 0001', 0],
    ['Session date: Monday, February 30, 0042', 0],
  ];
  for (const [line, removedLines] of cases) {
    const input = prompt(toolBlock('Memory', `<session_context>\n${line}\n</session_context>`));
    const result = stripSessionDates(input);
    assert.equal(result.removedLines, removedLines, line);
    assert.equal(result.text.includes(line), removedLines === 0, line);
  }
});

test('removes a dynamically different valid date without hard-coding one day', () => {
  const dynamic = 'Session date: Wednesday, November 4, 2026';
  const input = prompt(toolBlock('Credentials', `<session_context>\n${dynamic}\n</session_context>`));
  const result = stripSessionDates(input);
  assert.equal(result.removedLines, 1);
  assert.equal(result.text.includes(dynamic), false);
});

const protectedToolsSample = `\`\`\`xml\n<tools description="The tools you can use below">\n</tools>\n\`\`\``;
const cleanMemoryWrapper = prompt(toolBlock('Memory', cleanSession));

test('filters a complete wrapper before a protected blockquote close suffix', () => {
  const input = `${prompt(toolBlock('Memory'))}\n> </tools>`;
  assert.deepEqual(stripSessionDates(input), {
    text: `${cleanMemoryWrapper}\n> </tools>`,
    removedLines: 1,
  });
});

test('filters a complete wrapper before a protected fenced close suffix', () => {
  const input = `${prompt(toolBlock('Memory'))}\n\`\`\`xml\n</tools>\n\`\`\``;
  assert.deepEqual(stripSessionDates(input), {
    text: `${cleanMemoryWrapper}\n\`\`\`xml\n</tools>\n\`\`\``,
    removedLines: 1,
  });
});

test('ignores a protected close before a later complete wrapper', () => {
  const prefix = '> </tools>\n\n';
  const input = `${prefix}${prompt(toolBlock('Memory'))}`;
  assert.deepEqual(stripSessionDates(input), {
    text: `${prefix}${cleanMemoryWrapper}`,
    removedLines: 1,
  });
});

test('ignores protected opening and closing examples between flat wrappers', () => {
  const first = prompt(toolBlock('Memory'));
  const second = prompt(toolBlock('Credentials'));
  const cleanSecond = prompt(toolBlock('Credentials', cleanSession));
  const input = `${first}\n${protectedToolsSample}\n${second}`;
  assert.deepEqual(stripSessionDates(input), {
    text: `${cleanMemoryWrapper}\n${protectedToolsSample}\n${cleanSecond}`,
    removedLines: 2,
  });
});

test('ignores protected opening and closing examples while a real wrapper is active', () => {
  const sessionWithExample = `<session_context>\n${dateLine}\n${protectedToolsSample}\n</session_context>`;
  const input = prompt(toolBlock('Memory', sessionWithExample));
  const expected = prompt(toolBlock('Memory', `<session_context>\n${protectedToolsSample}\n</session_context>`));
  assert.deepEqual(stripSessionDates(input), { text: expected, removedLines: 1 });
});

test('manual fix F1: supports legal fence info strings and removes only a real date line', () => {
  const body = [
    '<session_context>',
    '~~~js~literal', dateLine, '~~~',
    '~~~js`literal', dateLine, '~~~',
    '```js~literal', dateLine, '```',
    '~~~~language with ~ info', dateLine, '~~~~',
    dateLine,
    '</session_context>',
  ].join('\n');
  const expectedBody = body.replace(`\n${dateLine}\n</session_context>`, '\n</session_context>');
  const input = prompt(toolBlock('Memory', body));
  assert.deepEqual(stripSessionDates(input), {
    text: prompt(toolBlock('Memory', expectedBody)),
    removedLines: 1,
  });
});

test('manual fix F1: fence closes require matching character and sufficient run length', () => {
  const body = `<session_context>\n~~~~json\n${dateLine}\n~~~\n${dateLine}\n${String.fromCharCode(96).repeat(3)}\n${dateLine}\n~~~~\n${dateLine}\n</session_context>`;
  const expectedBody = body.replace(`\n${dateLine}\n</session_context>`, '\n</session_context>');
  assert.deepEqual(stripSessionDates(prompt(toolBlock('Memory', body))), {
    text: prompt(toolBlock('Memory', expectedBody)),
    removedLines: 1,
  });
});

test('manual fix F1: preserves CRLF fenced examples and filters the following real line', () => {
  const body = `<session_context>\r\n~~~js~literal\r\n${dateLine}\r\n~~~\r\n${dateLine}\r\n</session_context>`;
  const expectedBody = `<session_context>\r\n~~~js~literal\r\n${dateLine}\r\n~~~\r\n</session_context>`;
  assert.deepEqual(stripSessionDates(prompt(toolBlock('Memory', body))), {
    text: prompt(toolBlock('Memory', expectedBody)),
    removedLines: 1,
  });
});

test('manual fix F2: rejects date fragments sharing a physical line with either session tag', () => {
  const bodies = [
    `<session_context>${dateLine}</session_context>`,
    `<session_context>${dateLine}\n</session_context>`,
    `<session_context>\n${dateLine}</session_context>`,
  ];
  for (const body of bodies) {
    const input = prompt(toolBlock('Memory', body));
    assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 }, body);
  }
});

test('manual fix F2: removes only a complete physical date line and preserves all other bytes', () => {
  const body = `<session_context>\r\nleft\r\n \t${dateLine}\t \r\nright\r\n</session_context>`;
  const expectedBody = `<session_context>\r\nleft\r\nright\r\n</session_context>`;
  assert.deepEqual(stripSessionDates(prompt(toolBlock('Credentials', body))), {
    text: prompt(toolBlock('Credentials', expectedBody)),
    removedLines: 1,
  });
});

test('manual fix F3: ignores fenced structural close examples at every tool/session layer', () => {
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const body = `<tool.instructions>\n${fence}xml\n</tool>\n</session_context>\n${fence}\n<session_context>\n${dateLine}\nKeep exact\n</session_context>\n</tool.instructions>`;
  const input = prompt(`<tool name="Memory">\n${body}\n</tool>`);
  const expectedBody = body.replace(`\n${dateLine}\nKeep exact`, '\nKeep exact');
  assert.deepEqual(stripSessionDates(input), {
    text: prompt(`<tool name="Memory">\n${expectedBody}\n</tool>`),
    removedLines: 1,
  });
});

test('manual fix F3: ignores every protected tool-structure opening and closing tag', () => {
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const sample = [
    '<tool name="Other">', '<tool.instructions>', '<session_context>',
    dateLine, '</session_context>', '</tool.instructions>', '</tool>',
  ].join('\n');
  const body = `<tool.instructions>\n${fence}xml\n${sample}\n${fence}\n<session_context>\n${dateLine}\nKeep exact\n</session_context>\n</tool.instructions>`;
  const input = prompt(`<tool name="Memory">\n${body}\n</tool>`);
  const expectedBody = body.replace(`\n${dateLine}\nKeep exact`, '\nKeep exact');
  assert.deepEqual(stripSessionDates(input), {
    text: prompt(`<tool name="Memory">\n${expectedBody}\n</tool>`),
    removedLines: 1,
  });
});

test('manual fix F3: ignores quoted tool and session tags while processing the actual wrapper', () => {
  const sample = [
    '> <tool name="Other">', '> <tool.instructions>', '> <session_context>',
    `> ${dateLine}`, '> </session_context>', '> </tool.instructions>', '> </tool>',
  ].join('\n');
  const body = `<tool.instructions>\n${sample}\n\n<session_context>\n${dateLine}\nKeep exact\n</session_context>\n</tool.instructions>`;
  const input = prompt(`<tool name="Memory">\n${body}\n</tool>`);
  const expectedBody = body.replace(`\n${dateLine}\nKeep exact`, '\nKeep exact');
  assert.deepEqual(stripSessionDates(input), {
    text: prompt(`<tool name="Memory">\n${expectedBody}\n</tool>`),
    removedLines: 1,
  });
});

test('manual fix F3: protected close in another tool does not skip a sibling Memory tool', () => {
  const tick = String.fromCharCode(96);
  const other = `<tool name="Other">\n<tool.instructions>\n${tick.repeat(3)}xml\n</tool>\n${tick.repeat(3)}\n</tool.instructions>\n</tool>`;
  const memory = toolBlock('Memory');
  const input = prompt(`${other}\n${memory}`);
  const expected = prompt(`${other}\n${toolBlock('Memory', cleanSession)}`);
  assert.deepEqual(stripSessionDates(input), { text: expected, removedLines: 1 });
});

test('manual fix F3: a protected fake close cannot complete a genuinely unclosed tool', () => {
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const input = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>\n<session_context>\n${dateLine}\n</session_context>\n${fence}xml\n</tool>\n${fence}\n</tool.instructions>\n</tools>`;
  assert.deepEqual(stripSessionDates(input), { text: input, removedLines: 0 });
});
