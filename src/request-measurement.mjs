const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const invalid = () => ({ valid: false, measurable: false });
const measurable = () => ({ valid: true, measurable: true });
const unmeasurable = () => ({ valid: true, measurable: false });
const merge = (states) => states.every((state) => state.valid)
  ? { valid: true, measurable: states.every((state) => state.measurable) }
  : invalid();

function validateChatToolCalls(value) {
  if (!Array.isArray(value) || value.length === 0) return invalid();
  const states = value.map((call) => {
    if (!isRecord(call) || !isNonEmptyString(call.id) || call.type !== 'function' || !isRecord(call.function)) return invalid();
    if (!isNonEmptyString(call.function.name) || typeof call.function.arguments !== 'string') return invalid();
    return measurable();
  });
  return merge(states);
}

function validateChatContent(value, { allowMissing = false } = {}) {
  if (typeof value === 'string') return measurable();
  if ((value === null || value === undefined) && allowMissing) return unmeasurable();
  if (Array.isArray(value)) return merge(value.map(validateChatPart));
  return invalid();
}

function validateChatPart(part) {
  if (!isRecord(part) || !isNonEmptyString(part.type)) return invalid();
  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' ? measurable() : invalid();
    case 'image_url':
      return isRecord(part.image_url) && isNonEmptyString(part.image_url.url) && (part.image_url.detail === undefined || ['auto', 'low', 'high'].includes(part.image_url.detail))
        ? measurable() : invalid();
    case 'input_audio':
      return isRecord(part.input_audio) && isNonEmptyString(part.input_audio.data) && isNonEmptyString(part.input_audio.format)
        ? measurable() : invalid();
    case 'audio':
      return isRecord(part.audio) && isNonEmptyString(part.audio.data) && isNonEmptyString(part.audio.format)
        ? measurable() : invalid();
    case 'file':
      return isRecord(part.file) && (typeof part.file.file_id === 'string' || typeof part.file.file_data === 'string')
        ? measurable() : invalid();
    case 'refusal':
      return typeof part.refusal === 'string' ? measurable() : invalid();
    default:
      // Unknown extension shapes are passed through by the gateway hook but are
      // outside the counter's schema knowledge, so do not claim a measurement.
      return unmeasurable();
  }
}

function validateChatMessage(message) {
  if (!isRecord(message) || !isNonEmptyString(message.role)) return invalid();
  const role = message.role;
  if (['system', 'developer', 'user', 'tool'].includes(role)) {
    if (role === 'tool' && !isNonEmptyString(message.tool_call_id)) return invalid();
    if (message.name !== undefined && typeof message.name !== 'string') return invalid();
    return validateChatContent(message.content);
  }
  if (role === 'function') {
    return isNonEmptyString(message.name) && typeof message.content === 'string' ? measurable() : invalid();
  }
  if (role !== 'assistant') return invalid();
  if (message.name !== undefined && typeof message.name !== 'string') return invalid();
  let state = message.content === undefined
    ? unmeasurable()
    : validateChatContent(message.content, { allowMissing: true });
  if (!state.valid) return invalid();
  if (message.tool_calls !== undefined) {
    const calls = validateChatToolCalls(message.tool_calls);
    if (!calls.valid) return invalid();
    state = merge([state, calls]);
  }
  if (message.function_call !== undefined) {
    const call = message.function_call;
    if (!isRecord(call) || !isNonEmptyString(call.name) || typeof call.arguments !== 'string') return invalid();
    state = merge([state, measurable()]);
  }
  if ((message.content === null || message.content === undefined) && message.tool_calls === undefined && message.function_call === undefined) return invalid();
  if (message.tool_calls !== undefined || message.function_call !== undefined) return measurable();
  return state;
}

function validateChat(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return invalid();
  return merge(body.messages.map(validateChatMessage));
}

function validateResponsesTextBlock(block) {
  if (!isRecord(block) || !isNonEmptyString(block.type)) return invalid();
  switch (block.type) {
    case 'input_text':
    case 'output_text':
    case 'summary_text':
      return typeof block.text === 'string' ? measurable() : invalid();
    case 'input_image':
      return typeof block.image_url === 'string' || typeof block.file_id === 'string' ? measurable() : invalid();
    case 'input_audio':
      return isNonEmptyString(block.data) && isNonEmptyString(block.format) ? measurable() : invalid();
    case 'refusal':
      return typeof block.refusal === 'string' ? measurable() : invalid();
    case 'computer_screenshot':
      return typeof block.image_url === 'string' || typeof block.file_id === 'string' ? measurable() : invalid();
    default:
      return unmeasurable();
  }
}

function validateResponsesContent(value) {
  if (typeof value === 'string') return measurable();
  if (!Array.isArray(value)) return invalid();
  return merge(value.map(validateResponsesTextBlock));
}

function validateResponsesItem(item) {
  if (!isRecord(item)) return invalid();
  if (item.type === undefined) {
    if (!isNonEmptyString(item.role) || !Object.hasOwn(item, 'content')) return invalid();
    if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) return invalid();
    return validateResponsesContent(item.content);
  }
  if (!isNonEmptyString(item.type)) return invalid();
  switch (item.type) {
    case 'message':
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) return invalid();
      if (!Object.hasOwn(item, 'content')) return invalid();
      if (item.status !== undefined && typeof item.status !== 'string') return invalid();
      if (item.id !== undefined && typeof item.id !== 'string') return invalid();
      return validateResponsesContent(item.content);
    case 'function_call':
      return isNonEmptyString(item.call_id) && isNonEmptyString(item.name) && typeof item.arguments === 'string'
        ? measurable() : invalid();
    case 'function_call_output':
      if (!isNonEmptyString(item.call_id) || !Object.hasOwn(item, 'output')) return invalid();
      return isRecord(item.output) || Array.isArray(item.output) || typeof item.output === 'string'
        ? (typeof item.output === 'string' ? measurable() : unmeasurable()) : invalid();
    case 'reasoning': {
      if (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string') return invalid();
      if (item.id !== undefined && typeof item.id !== 'string') return invalid();
      if (item.status !== undefined && typeof item.status !== 'string') return invalid();
      if (item.summary === undefined) return measurable();
      if (!Array.isArray(item.summary)) return invalid();
      return merge(item.summary.map(validateResponsesTextBlock));
    }
    default:
      return unmeasurable();
  }
}

function validateResponses(body) {
  if (body.instructions !== undefined && typeof body.instructions !== 'string') return invalid();
  if (body.previous_response_id !== undefined && typeof body.previous_response_id !== 'string') return invalid();
  if (body.store !== undefined && typeof body.store !== 'boolean') return invalid();
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return invalid();
  if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) return invalid();
  if (body.input === undefined && body.instructions === undefined) {
    if (!isNonEmptyString(body.previous_response_id)) return invalid();
    return measurable();
  }
  if (typeof body.input === 'string') return measurable();
  if (Array.isArray(body.input)) return merge(body.input.map(validateResponsesItem));
  return measurable();
}

function validateAnthropicBlock(block) {
  if (!isRecord(block) || !isNonEmptyString(block.type)) return invalid();
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? measurable() : invalid();
    case 'tool_use':
      return isNonEmptyString(block.id) && isNonEmptyString(block.name) && isRecord(block.input) ? measurable() : invalid();
    case 'tool_result':
      return isNonEmptyString(block.tool_use_id) && Object.hasOwn(block, 'content')
        ? (typeof block.content === 'string' || isRecord(block.content) || Array.isArray(block.content) ? measurable() : invalid())
        : invalid();
    case 'image':
      return isRecord(block.source) && isNonEmptyString(block.source.type) ? measurable() : invalid();
    case 'thinking':
      return typeof block.thinking === 'string' ? measurable() : invalid();
    case 'redacted_thinking':
      return isNonEmptyString(block.data) ? measurable() : invalid();
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'search_result':
      return unmeasurable();
    default:
      return unmeasurable();
  }
}

function validateAnthropicContent(value) {
  if (typeof value === 'string') return measurable();
  if (!Array.isArray(value) || value.length === 0) return invalid();
  return merge(value.map(validateAnthropicBlock));
}

function validateAnthropicMessage(message) {
  if (!isRecord(message) || !['user', 'assistant'].includes(message.role) || !Object.hasOwn(message, 'content')) return invalid();
  return validateAnthropicContent(message.content);
}

function validateAnthropic(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return invalid();
  if (body.system !== undefined) {
    if (typeof body.system === 'string') return merge([...body.messages.map(validateAnthropicMessage), measurable()]);
    if (!Array.isArray(body.system) || body.system.length === 0) return invalid();
    const system = merge(body.system.map((block) => {
      if (!isRecord(block) || typeof block.type !== 'string') return invalid();
      if (block.type !== 'text') return unmeasurable();
      return typeof block.text === 'string' ? measurable() : invalid();
    }));
    if (!system.valid) return invalid();
    return merge([...body.messages.map(validateAnthropicMessage), system]);
  }
  return merge(body.messages.map(validateAnthropicMessage));
}

function validateGeminiPart(part) {
  if (!isRecord(part)) return invalid();
  if (part.thought !== undefined && typeof part.thought !== 'boolean') return invalid();
  if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string') return invalid();
  const payloads = ['text', 'functionCall', 'functionResponse', 'inlineData', 'fileData', 'executableCode', 'codeExecutionResult', 'videoMetadata'].filter((key) => Object.hasOwn(part, key));
  const extensionPayloads = Object.keys(part).filter((key) => !['thought', 'thoughtSignature', 'text', 'functionCall', 'functionResponse', 'inlineData', 'fileData', 'executableCode', 'codeExecutionResult', 'videoMetadata'].includes(key));
  if (extensionPayloads.length > 0) return unmeasurable();
  if (payloads.length !== 1) return invalid();
  const value = part[payloads[0]];
  switch (payloads[0]) {
    case 'text': return typeof value === 'string' ? measurable() : invalid();
    case 'functionCall': return isRecord(value) && isNonEmptyString(value.name) && (value.args === undefined || isRecord(value.args)) ? measurable() : invalid();
    case 'functionResponse': return isRecord(value) && isNonEmptyString(value.name) && isRecord(value.response) ? measurable() : invalid();
    case 'inlineData': return isRecord(value) && isNonEmptyString(value.mimeType) && isNonEmptyString(value.data) ? measurable() : invalid();
    case 'fileData': return isRecord(value) && isNonEmptyString(value.mimeType) && isNonEmptyString(value.fileUri) ? measurable() : invalid();
    case 'executableCode': return isRecord(value) && isNonEmptyString(value.code) && isNonEmptyString(value.language) ? measurable() : invalid();
    case 'codeExecutionResult': return isRecord(value) && isNonEmptyString(value.outcome) && typeof value.output === 'string' ? measurable() : invalid();
    case 'videoMetadata': return isRecord(value) ? unmeasurable() : invalid();
    default: return invalid();
  }
}

function validateGeminiContent(content, { system = false } = {}) {
  if (!isRecord(content)) return invalid();
  if (!system && content.role !== undefined && !['user', 'model'].includes(content.role)) return invalid();
  if (system && content.role !== undefined && typeof content.role !== 'string') return invalid();
  if (!Array.isArray(content.parts) || content.parts.length === 0) return invalid();
  return merge(content.parts.map(validateGeminiPart));
}

function validateGemini(body) {
  if (!Array.isArray(body.contents) || body.contents.length === 0) return invalid();
  const states = body.contents.map((content) => validateGeminiContent(content));
  if (body.systemInstruction !== undefined) states.push(validateGeminiContent(body.systemInstruction, { system: true }));
  return merge(states);
}

export function inspectRequestBody(body, protocol) {
  if (!isRecord(body)) return invalid();
  if (body.metadata !== undefined && !isRecord(body.metadata)) return invalid();
  switch (protocol) {
    case 'chat': return validateChat(body);
    case 'responses': return validateResponses(body);
    case 'anthropic': return validateAnthropic(body);
    case 'gemini': return validateGemini(body);
    default: return invalid();
  }
}

export const __measurementInternals = Object.freeze({
  validateChat,
  validateResponses,
  validateAnthropic,
  validateGemini,
});
