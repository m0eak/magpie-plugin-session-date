import { transformPromptText } from './stable-context.mjs';

const SUPPORTED_PROTOCOLS = new Set(['chat', 'responses', 'anthropic', 'gemini']);
const ZERO = () => ({ changed: false, removedLines: 0, dateRemovedLines: 0, topicTitleRemovedLines: 0, availableAgentsMatchedRequests: 0, availableAgentsReplacedBlocks: 0, timeGuidanceInsertedBlocks: 0 });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function add(into, value) {
  into.removedLines += value.removedLines ?? 0;
  into.dateRemovedLines += value.dateRemovedLines ?? 0;
  into.topicTitleRemovedLines += value.topicTitleRemovedLines ?? 0;
  into.availableAgentsReplacedBlocks += value.availableAgentsReplacedBlocks ?? 0;
  into.timeGuidanceInsertedBlocks += value.timeGuidanceInsertedBlocks ?? 0;
  into.changed ||= value.changed === true;
}

function transformText(text, options, environmentUser = false) {
  return transformPromptText(text, environmentUser
    ? { ...options, sessionDate: false, topicTitle: false }
    : options, { environmentUser });
}

function transformTextArray(blocks, acceptedTypes, options, environmentUser = false) {
  const result = ZERO();
  if (!Array.isArray(blocks)) return { value: blocks, ...result };
  let next = blocks;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!isRecord(block) || !acceptedTypes.has(block.type) || typeof block.text !== 'string') continue;
    const transformed = transformText(block.text, options, environmentUser);
    if (!transformed.changed) continue;
    if (next === blocks) next = blocks.slice();
    next[i] = { ...block, text: transformed.text };
    add(result, transformed);
  }
  return { value: next, ...result };
}

function transformMessageContent(message, options, environmentUser = false, acceptedTypes = new Set(['text'])) {
  if (typeof message.content === 'string') {
    const transformed = transformText(message.content, options, environmentUser);
    return transformed.changed ? { message: { ...message, content: transformed.text }, ...transformed } : { message, ...ZERO() };
  }
  if (Array.isArray(message.content)) {
    const transformed = transformTextArray(message.content, acceptedTypes, options, environmentUser);
    return transformed.changed ? { message: { ...message, content: transformed.value }, ...transformed } : { message, ...ZERO() };
  }
  return { message, ...ZERO() };
}

function transformChat(body, options) {
  const result = ZERO();
  if (!isRecord(body) || !Array.isArray(body.messages)) return { body, ...result };
  let messages = body.messages;
  let firstUserIndex = -1;
  let historyStarted = false;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isRecord(message)) continue;
    if (message.role === 'user' && firstUserIndex < 0 && !historyStarted) firstUserIndex = i;
    if (['assistant', 'tool'].includes(message.role)) {
      historyStarted = true;
      continue;
    }
    if (['system', 'developer'].includes(message.role)) {
      const filtered = transformMessageContent(message, options);
      if (filtered.message !== message) {
        if (messages === body.messages) messages = messages.slice();
        messages[i] = filtered.message;
        add(result, filtered);
      }
    }
  }
  if (firstUserIndex >= 0) {
    const message = messages[firstUserIndex];
    const transformed = transformMessageContent(message, options, true);
    if (transformed.message !== message) {
      if (messages === body.messages) messages = messages.slice();
      messages[firstUserIndex] = transformed.message;
      add(result, transformed);
    }
  }
  return { body: result.changed ? { ...body, messages } : body, ...result };
}

function transformResponses(body, options) {
  const result = ZERO();
  if (!isRecord(body)) return { body, ...result };
  let nextBody = body;
  if (typeof body.instructions === 'string') {
    const value = transformText(body.instructions, options);
    if (value.changed) {
      nextBody = { ...nextBody, instructions: value.text };
      add(result, value);
    }
  }
  if (!Array.isArray(body.input)) return { body: result.changed ? nextBody : body, ...result };
  let input = body.input;
  let firstUserIndex = -1;
  let historyStarted = false;
  for (let i = 0; i < body.input.length; i += 1) {
    const item = body.input[i];
    if (!isRecord(item)) continue;
    if (['function_call', 'function_call_output', 'tool_call', 'tool_result'].includes(item.type)) {
      historyStarted = true;
      continue;
    }
    if (item.type !== undefined && item.type !== 'message') continue;
    if (item.role === 'user' && firstUserIndex < 0 && !historyStarted) firstUserIndex = i;
    if (['assistant', 'tool'].includes(item.role)) {
      historyStarted = true;
      continue;
    }
    if (['system', 'developer'].includes(item.role)) {
      const value = transformMessageContent(item, options, false, new Set(['input_text']));
      if (value.message !== item) {
        if (input === body.input) input = input.slice();
        input[i] = value.message;
        add(result, value);
      }
    }
  }
  if (firstUserIndex >= 0) {
    const item = input[firstUserIndex];
    const value = transformMessageContent(item, options, true, new Set(['input_text']));
    if (value.message !== item) {
      if (input === body.input) input = input.slice();
      input[firstUserIndex] = value.message;
      add(result, value);
    }
  }
  if (input !== body.input) nextBody = { ...nextBody, input };
  return { body: result.changed ? nextBody : body, ...result };
}

function transformAnthropic(body, options) {
  const result = ZERO();
  if (!isRecord(body)) return { body, ...result };
  let nextBody = body;
  if (typeof body.system === 'string') {
    const value = transformText(body.system, options);
    if (value.changed) {
      nextBody = { ...nextBody, system: value.text };
      add(result, value);
    }
  } else if (Array.isArray(body.system)) {
    const value = transformTextArray(body.system, new Set(['text']), options);
    if (value.changed) {
      nextBody = { ...nextBody, system: value.value };
      add(result, value);
    }
  }
  if (Array.isArray(body.messages)) {
    let messages = body.messages;
    let firstUserIndex = -1;
    let historyStarted = false;
    for (let i = 0; i < body.messages.length; i += 1) {
      const message = body.messages[i];
      if (!isRecord(message)) continue;
      if (message.role === 'user' && firstUserIndex < 0 && !historyStarted) firstUserIndex = i;
      if (message.role === 'assistant') historyStarted = true;
    }
    if (firstUserIndex >= 0) {
      const message = messages[firstUserIndex];
      const value = transformMessageContent(message, options, true);
      if (value.message !== message) {
        messages = messages.slice();
        messages[firstUserIndex] = value.message;
        nextBody = { ...nextBody, messages };
        add(result, value);
      }
    }
  }
  return { body: result.changed ? nextBody : body, ...result };
}

function transformGeminiParts(parts, options, environmentUser = false) {
  const result = ZERO();
  if (!Array.isArray(parts)) return { value: parts, ...result };
  let next = parts;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!isRecord(part) || typeof part.text !== 'string') continue;
    if (part.thought !== undefined && typeof part.thought !== 'boolean') continue;
    if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string') continue;
    if (Object.keys(part).some((key) => !['text', 'thought', 'thoughtSignature'].includes(key))) continue;
    const value = transformText(part.text, options, environmentUser);
    if (!value.changed) continue;
    if (next === parts) next = parts.slice();
    next[i] = { ...part, text: value.text };
    add(result, value);
  }
  return { value: next, ...result };
}

function transformGemini(body, options) {
  const result = ZERO();
  if (!isRecord(body)) return { body, ...result };
  let nextBody = body;
  const system = body.systemInstruction;
  if (isRecord(system)) {
    const value = transformGeminiParts(system.parts, options);
    if (value.changed) {
      nextBody = { ...nextBody, systemInstruction: { ...system, parts: value.value } };
      add(result, value);
    }
  }
  if (Array.isArray(body.contents)) {
    let firstUser = -1;
    let historyStarted = false;
    for (let i = 0; i < body.contents.length; i += 1) {
      if (!isRecord(body.contents[i])) continue;
      if (body.contents[i].role === 'user' && firstUser < 0 && !historyStarted) firstUser = i;
      if (body.contents[i].role === 'model') historyStarted = true;
    }
    if (firstUser >= 0) {
      const content = body.contents[firstUser];
      const value = transformGeminiParts(content.parts, options, true);
      if (value.changed) {
        const contents = body.contents.slice();
        contents[firstUser] = { ...content, parts: value.value };
        nextBody = { ...nextBody, contents };
        add(result, value);
      }
    }
  }
  return { body: result.changed ? nextBody : body, ...result };
}

const FILTERS = new Map([
  ['chat', transformChat],
  ['responses', transformResponses],
  ['anthropic', transformAnthropic],
  ['gemini', transformGemini],
]);

/**
 * Apply only to explicitly recognized prompt locations for a known protocol.
 * User role text is considered solely at the initial environment position and
 * only when it matches the complete LobeHub agent-management wrapper.
 */
export function filterRequest(body, protocol, options = {}) {
  const filter = FILTERS.get(protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol) || !filter) return { body, removedLines: 0, supported: false };
  try {
    const result = filter(body, options);
    return {
      ...result,
      availableAgentsMatchedRequests: result.availableAgentsReplacedBlocks > 0 ? 1 : 0,
      supported: true,
    };
  } catch {
    return { body, ...ZERO(), supported: true };
  }
}
