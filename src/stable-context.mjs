import { stripSessionDates, protectedMarkdownLines } from './matcher.mjs';

export const AVAILABLE_AGENTS_GUIDANCE = `<available_agents>
When Agent Management tools are available, use \`searchAgent\` with source="user" and an optional keyword to find workspace agents. Use \`getAgentDetail\` with agentId to inspect an agent when needed, and \`callAgent\` with agentId and instruction to delegate a task.
</available_agents>`;

export const CURRENT_TIME_GUIDANCE = `<current_time_guidance>
When the task requires the current date or time, use an available time tool or run \`date\` if shell access is available. Use the user's specified timezone; otherwise use the runtime's configured timezone. Do not infer the current date or time from older conversation messages. If the current time cannot be verified, say so.
</current_time_guidance>`;

const OLD_AGENT_INSTRUCTION =
  "If none of the agents in the `available_agents` section match the user's intent, fall back to searchAgent (which can also search the marketplace).";
const NEW_AGENT_INSTRUCTION =
  'To find workspace agents, use searchAgent with source="user" and an optional keyword.';
const OLD_CONTEXT_INSTRUCTION =
  "The `available_agents` section lists the user's other existing agents (you are not in this list). When the user's request clearly matches one of them, you may delegate to it via the Agent Management `callAgent` tool (activating the tool first if it is not already enabled). If no listed agent matches, use `searchAgent` to look further (including the marketplace).";
const NEW_CONTEXT_INSTRUCTION =
  'The available_agents section contains tool guidance, not a live agent list. Use searchAgent with source="user" to find workspace agents, then callAgent with agentId and instruction when delegating.';
const MAIN_CHILDREN = new Set(['instruction', 'current_agent', 'available_models', 'available_agents', 'available_plugins']);
// These are the top-level XML blocks emitted by LobeHub's shared
// BaseFirstUserContentProvider pipeline. The allowlist keeps environment-user
// recognition tied to known host templates instead of accepting arbitrary XML.
const ENVIRONMENT_WRAPPERS = new Set([
  'user_memory',
  'expertise',
  'group_context',
  'discord_context',
  'plan',
  'agent_knowledge',
  'agent_documents_index',
  'agent_document',
  'available_tools',
  'current_agent_context',
  'agent_management_context',
  'current_group_context',
  'onboarding_context',
]);
const TOKEN_SOURCE = String.raw`<\/?([A-Za-z_][\w.-]*)(?:\s+([^<>]*?))?\s*(\/?)>`;

function parseFragment(xml) {
  if (typeof xml !== 'string' || xml.length > 500_000) return null;
  const roots = [];
  const stack = [];
  let cursor = 0;
  const token = new RegExp(TOKEN_SOURCE, 'g');
  for (let match; (match = token.exec(xml));) {
    if (xml.slice(cursor, match.index).includes('<')) return null;
    const [, name, attrs = '', selfClosing] = match;
    const closing = match[0].startsWith('</');
    if (closing) {
      const node = stack.pop();
      if (!node || node.name !== name || selfClosing) return null;
      node.end = token.lastIndex;
      if (!stack.length) roots.push(node);
    } else {
      const node = { name, attrs: attrs.trim(), start: match.index, openEnd: token.lastIndex, end: null, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(node);
      if (selfClosing) {
        node.end = token.lastIndex;
        if (!stack.length) roots.push(node);
      } else stack.push(node);
    }
    cursor = token.lastIndex;
  }
  if (xml.slice(cursor).includes('<') || stack.length) return null;
  return roots;
}

function getAgentContext(text, strictEnvironment = false) {
  const protectedLines = protectedMarkdownLines(text);
  const contexts = [];
  const token = new RegExp(TOKEN_SOURCE, 'g');
  for (let match; (match = token.exec(text));) {
    if (match[0].startsWith('</') || match[1] !== 'agent_management_context') continue;
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    if (protectedLines.has(lineStart)) continue;
    const close = text.indexOf('</agent_management_context>', token.lastIndex);
    if (close < 0) continue;
    const end = close + '</agent_management_context>'.length;
    const parsed = parseFragment(text.slice(match.index, end));
    const root = parsed?.length === 1 ? parsed[0] : null;
    if (!root || root.name !== 'agent_management_context' ||
        root.children.length < 3 || !root.children.some((child) => child.name === 'instruction') ||
        !root.children.some((child) => child.name === 'current_agent') ||
        !root.children.some((child) => child.name === 'available_agents') ||
        root.children.some((child) => !MAIN_CHILDREN.has(child.name)) ||
        new Set(root.children.map((child) => child.name)).size !== root.children.length) continue;
    if (strictEnvironment && !isTopLevelEnvironment(text, match.index, end)) continue;
    contexts.push({ start: match.index, end, root, offset: match.index });
  }
  return contexts.length === 1 ? contexts[0] : null;
}

function isTopLevelEnvironment(text, contextStart, contextEnd) {
  const protectedLines = protectedMarkdownLines(text);
  let cursor = 0;
  let found = false;
  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (cursor >= text.length) break;
    if (text[cursor] !== '<') return false;
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    if (protectedLines.has(lineStart)) return false;
    const token = new RegExp(TOKEN_SOURCE, 'g');
    token.lastIndex = cursor;
    const open = token.exec(text);
    if (!open || open.index !== cursor || open[0].startsWith('</')) return false;
    const name = open[1];
    let end = token.lastIndex;
    if (!open[3]) {
      const closeTag = `</${name}>`;
      let depth = 1;
      token.lastIndex = end;
      for (let tag; (tag = token.exec(text));) {
        if (tag[1] !== name) continue;
        if (tag[0].startsWith('</')) depth -= 1;
        else if (!tag[3]) depth += 1;
        if (depth === 0) { end = token.lastIndex; break; }
      }
      if (depth !== 0) return false;
    }
    if (!ENVIRONMENT_WRAPPERS.has(name)) return false;
    if (cursor === contextStart && end === contextEnd && name === 'agent_management_context') found = true;
    cursor = end;
  }
  return found;
}

function validAgentList(node) {
  if (node.children.length === 0 || node.children.some((child) => !['note', 'agent'].includes(child.name))) return false;
  let agents = 0;
  for (const child of node.children) {
    if (child.children.length !== 0) return false;
    if (child.name === 'note') {
      if (child.attrs !== '') return false;
    } else {
      if (!/^id=["'][^"'<>]+["']$/.test(child.attrs)) return false;
      agents += 1;
    }
  }
  return agents > 0;
}

function replaceRanges(text, ranges) {
  let out = '';
  let cursor = 0;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    if (range.start < cursor) return text;
    out += text.slice(cursor, range.start) + range.value;
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

function replaceAgentContext(text, context) {
  if (!context) return { text, blocks: 0 };
  const listNodes = context.root.children.filter((child) => child.name === 'available_agents');
  if (listNodes.length !== 1) return { text, blocks: 0 };
  const list = listNodes[0];
  if (!validAgentList(list)) return { text, blocks: 0 };
  const absoluteStart = context.offset + list.start;
  const absoluteEnd = context.offset + list.end;
  const original = text.slice(absoluteStart, absoluteEnd);
  if (original === AVAILABLE_AGENTS_GUIDANCE) return { text, blocks: 0 };
  const ranges = [{ start: absoluteStart, end: absoluteEnd, value: AVAILABLE_AGENTS_GUIDANCE }];
  const instruction = context.root.children.find((child) => child.name === 'instruction');
  if (instruction) {
    const instructionStart = context.offset + instruction.openEnd;
    const instructionEnd = context.offset + instruction.end - '</instruction>'.length;
    let value = text.slice(instructionStart, instructionEnd);
    value = value.replace(OLD_AGENT_INSTRUCTION, NEW_AGENT_INSTRUCTION).replace(OLD_CONTEXT_INSTRUCTION, NEW_CONTEXT_INSTRUCTION);
    if (value !== text.slice(instructionStart, instructionEnd)) ranges.push({ start: instructionStart, end: instructionEnd, value });
  }
  return { text: replaceRanges(text, ranges), blocks: 1 };
}

function hasActiveTimeGuidance(text) {
  const protectedLines = protectedMarkdownLines(text);
  let cursor = 0;
  while ((cursor = text.indexOf(CURRENT_TIME_GUIDANCE, cursor)) !== -1) {
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    if (!protectedLines.has(lineStart)) return true;
    cursor += CURRENT_TIME_GUIDANCE.length;
  }
  return false;
}

export function transformPromptText(text, options = {}, context = {}) {
  if (typeof text !== 'string') return {
    text, changed: false, removedLines: 0, dateRemovedLines: 0,
    topicTitleRemovedLines: 0, availableAgentsReplacedBlocks: 0, timeGuidanceInsertedBlocks: 0,
  };

  const environmentUser = context.environmentUser === true;
  let output = text;
  let availableAgentsReplacedBlocks = 0;
  if (options.availableAgents) {
    const agentContext = getAgentContext(output, environmentUser);
    const replaced = replaceAgentContext(output, agentContext);
    output = replaced.text;
    availableAgentsReplacedBlocks = replaced.blocks;
  }

  const existingGuidance = hasActiveTimeGuidance(output);
  const dateReplacement = options.sessionDate !== false && !environmentUser && !existingGuidance
    ? CURRENT_TIME_GUIDANCE
    : undefined;
  const filtered = stripSessionDates(output, {
    sessionDate: options.sessionDate !== false && !environmentUser,
    topicTitle: options.topicTitle !== false && !environmentUser,
    dateReplacement,
    withCategories: true,
  });
  output = filtered.text;
  const removedLines = filtered.removedLines ?? 0;
  const dateRemovedLines = filtered.dateRemovedLines ?? 0;
  const topicTitleRemovedLines = filtered.topicTitleRemovedLines ?? 0;
  const timeGuidanceInsertedBlocks = filtered.timeGuidanceInsertedBlocks ?? 0;
  return {
    text: output,
    changed: output !== text,
    removedLines,
    dateRemovedLines,
    topicTitleRemovedLines,
    availableAgentsReplacedBlocks,
    timeGuidanceInsertedBlocks,
  };
}
