import { stripSessionDates } from './matcher.mjs';

const SUPPORTED_PROTOCOLS = new Set(['chat', 'responses', 'anthropic', 'gemini']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function filterTextValue(value) {
  if (typeof value !== 'string') return { value, removedLines: 0, changed: false };
  const result = stripSessionDates(value);
  return { value: result.text, removedLines: result.removedLines, changed: result.removedLines > 0 };
}

function filterBlockArray(blocks, types) {
  if (!Array.isArray(blocks)) return { value: blocks, removedLines: 0, changed: false };
  let next = blocks;
  let removedLines = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!isRecord(block) || !types.has(block.type) || typeof block.text !== 'string') continue;
    const filtered = filterTextValue(block.text);
    if (!filtered.changed) continue;
    if (next === blocks) next = blocks.slice();
    next[index] = { ...block, text: filtered.value };
    removedLines += filtered.removedLines;
  }
  return { value: next, removedLines, changed: next !== blocks };
}

function filterChat(body) {
  if (!isRecord(body) || !Array.isArray(body.messages)) return { body, removedLines: 0 };
  let messages = body.messages;
  let removedLines = 0;

  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index];
    if (!isRecord(message) || !['system', 'developer'].includes(message.role)) continue;

    let nextMessage = message;
    let changed = false;
    if (typeof message.content === 'string') {
      const filtered = filterTextValue(message.content);
      if (filtered.changed) {
        nextMessage = { ...message, content: filtered.value };
        removedLines += filtered.removedLines;
        changed = true;
      }
    } else if (Array.isArray(message.content)) {
      const filtered = filterBlockArray(message.content, new Set(['text']));
      if (filtered.changed) {
        nextMessage = { ...message, content: filtered.value };
        removedLines += filtered.removedLines;
        changed = true;
      }
    }

    if (changed) {
      if (messages === body.messages) messages = body.messages.slice();
      messages[index] = nextMessage;
    }
  }

  return removedLines > 0 ? { body: { ...body, messages }, removedLines } : { body, removedLines: 0 };
}

function filterResponses(body) {
  if (!isRecord(body)) return { body, removedLines: 0 };
  let nextBody = body;
  let removedLines = 0;

  if (typeof body.instructions === 'string') {
    const filtered = filterTextValue(body.instructions);
    if (filtered.changed) {
      nextBody = { ...nextBody, instructions: filtered.value };
      removedLines += filtered.removedLines;
    }
  }
  if (!Array.isArray(body.input)) return { body: nextBody, removedLines };

  let input = body.input;
  for (let index = 0; index < body.input.length; index += 1) {
    const item = body.input[index];
    if (!isRecord(item) || (item.type !== undefined && item.type !== 'message') || !['system', 'developer'].includes(item.role)) continue;

    let nextItem = item;
    if (typeof item.content === 'string') {
      const filtered = filterTextValue(item.content);
      if (filtered.changed) {
        nextItem = { ...item, content: filtered.value };
        removedLines += filtered.removedLines;
      }
    } else if (Array.isArray(item.content)) {
      const filtered = filterBlockArray(item.content, new Set(['input_text']));
      if (filtered.changed) {
        nextItem = { ...item, content: filtered.value };
        removedLines += filtered.removedLines;
      }
    }
    if (nextItem !== item) {
      if (input === body.input) input = body.input.slice();
      input[index] = nextItem;
    }
  }

  if (input !== body.input) nextBody = { ...nextBody, input };
  return { body: removedLines > 0 ? nextBody : body, removedLines: removedLines > 0 ? removedLines : 0 };
}

function filterAnthropic(body) {
  if (!isRecord(body)) return { body, removedLines: 0 };
  if (typeof body.system === 'string') {
    const filtered = filterTextValue(body.system);
    return filtered.changed
      ? { body: { ...body, system: filtered.value }, removedLines: filtered.removedLines }
      : { body, removedLines: 0 };
  }
  if (Array.isArray(body.system)) {
    const filtered = filterBlockArray(body.system, new Set(['text']));
    return filtered.changed
      ? { body: { ...body, system: filtered.value }, removedLines: filtered.removedLines }
      : { body, removedLines: 0 };
  }
  return { body, removedLines: 0 };
}

function filterGeminiParts(parts) {
  if (!Array.isArray(parts)) return { value: parts, removedLines: 0, changed: false };
  let next = parts;
  let removedLines = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // Gemini Part is a one-of shape: a text part has only text payload plus
    // recognized generation metadata, while multimodal/tool parts carry other
    // payload keys. Fail open on ambiguous combinations.
    if (!isRecord(part) || typeof part.text !== 'string') continue;
    if (part.thought !== undefined && typeof part.thought !== 'boolean') continue;
    if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string') continue;
    const payloadKeys = Object.keys(part).filter((key) => key !== 'text' && key !== 'thought' && key !== 'thoughtSignature');
    if (payloadKeys.length > 0) continue;
    const filtered = filterTextValue(part.text);
    if (!filtered.changed) continue;
    if (next === parts) next = parts.slice();
    next[index] = { ...part, text: filtered.value };
    removedLines += filtered.removedLines;
  }
  return { value: next, removedLines, changed: next !== parts };
}

function filterGemini(body) {
  if (!isRecord(body)) return { body, removedLines: 0 };
  const system = body.systemInstruction;
  if (!isRecord(system)) return { body, removedLines: 0 };

  const parts = filterGeminiParts(system.parts);
  if (!parts.changed) return { body, removedLines: 0 };
  return {
    body: { ...body, systemInstruction: { ...system, parts: parts.value } },
    removedLines: parts.removedLines,
  };
}

const FILTERS = new Map([
  ['chat', filterChat],
  ['responses', filterResponses],
  ['anthropic', filterAnthropic],
  ['gemini', filterGemini],
]);

/**
 * Filter only known system/developer prompt fields for an explicitly selected protocol.
 * Unsupported and unchanged bodies retain the original reference.
 * @param {unknown} body
 * @param {string} protocol
 * @returns {{body: unknown, removedLines: number, supported: boolean}}
 */
export function filterRequest(body, protocol) {
  const filter = FILTERS.get(protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol) || !filter) {
    return { body, removedLines: 0, supported: false };
  }
  try {
    const result = filter(body);
    return { ...result, supported: true };
  } catch {
    return { body, removedLines: 0, supported: true };
  }
}
