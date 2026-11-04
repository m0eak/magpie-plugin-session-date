const TOOLS_OPEN = '<tools description="The tools you can use below">';
const TOOL_TAG = /<tool(?:\s+[^>]*)?>|<\/tool>/g;
const DATE_LINE = /^[\t ]*Session date:[\t ]*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),[\t ]*(January|February|March|April|May|June|July|August|September|October|November|December)[\t ]+(\d{1,2}),[\t ]+(\d{4})[\t ]*$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = new Map([
  ['January', 0], ['February', 1], ['March', 2], ['April', 3], ['May', 4], ['June', 5],
  ['July', 6], ['August', 7], ['September', 8], ['October', 9], ['November', 10], ['December', 11],
]);

function lineStartAt(text, offset) {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function protectedMarkdownLines(text) {
  const protectedLines = new Set();
  let fence = null;
  let quoteContinuation = false;
  let cursor = 0;
  while (cursor < text.length) {
    let end = text.indexOf('\n', cursor);
    if (end === -1) end = text.length;
    const lineEnd = end > cursor && text[end - 1] === '\r' ? end - 1 : end;
    const line = text.slice(cursor, lineEnd);
    if (fence) {
      protectedLines.add(cursor);
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[\\t ]*$`).test(line)) fence = null;
    } else {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/);
      if (open) {
        fence = { char: open[1][0], length: open[1].length };
        protectedLines.add(cursor);
        quoteContinuation = false;
      } else if (/^\s*>/.test(line)) {
        protectedLines.add(cursor);
        quoteContinuation = true;
      } else if (quoteContinuation && line.trim() !== '') {
        protectedLines.add(cursor);
      } else quoteContinuation = false;
    }
    if (end === text.length) break;
    cursor = end + 1;
  }
  return protectedLines;
}

function isValidCalendarLine(line) {
  const match = DATE_LINE.exec(line);
  if (!match) return false;
  const [, weekday, monthName, dayText, yearText] = match;
  const year = Number(yearText), month = MONTHS.get(monthName), day = Number(dayText);
  if (year < 1 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day && WEEKDAYS[date.getUTCDay()] === weekday;
}

function stripSessionBlock(text, start, end, protectedLines) {
  let output = '', removedLines = 0, cursor = start;
  while (cursor < end) {
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1 || lineEnd >= end) lineEnd = end;
    const hasLf = lineEnd < end && text[lineEnd] === '\n';
    const valueEnd = hasLf && lineEnd > cursor && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = text.slice(cursor, valueEnd);
    const next = hasLf ? lineEnd + 1 : lineEnd;
    if (!protectedLines.has(cursor) && isValidCalendarLine(line)) removedLines += 1;
    else output += text.slice(cursor, next);
    cursor = next;
  }
  return { text: output, removedLines };
}

function matchingToolName(openTag) {
  if (openTag === '<tool name="Memory">') return 'Memory';
  if (openTag === '<tool name="Credentials">') return 'Credentials';
  return null;
}

function findTagsInRange(text, open, close, start, end) {
  const result = [];
  let cursor = start;
  while (cursor < end) {
    const openAt = text.indexOf(open, cursor);
    const closeAt = text.indexOf(close, cursor);
    if (closeAt !== -1 && closeAt < end && (openAt === -1 || openAt >= end || closeAt < openAt)) return null;
    if (openAt === -1 || openAt >= end) break;
    const nextOpen = text.indexOf(open, openAt + open.length);
    const nextClose = text.indexOf(close, openAt + open.length);
    if (nextClose === -1 || nextClose >= end || (nextOpen !== -1 && nextOpen < nextClose)) return null;
    result.push({ start: openAt, contentStart: openAt + open.length, contentEnd: nextClose, end: nextClose + close.length });
    cursor = nextClose + close.length;
  }
  return result;
}

function stripInTool(text, tool, protectedLines) {
  const instructionOpen = '<tool.instructions>', instructionClose = '</tool.instructions>';
  const instructions = findTagsInRange(text, instructionOpen, instructionClose, tool.contentStart, tool.contentEnd);
  if (!instructions || instructions.length !== 1) return [];
  const instruction = instructions[0];
  const sessions = findTagsInRange(text, '<session_context>', '</session_context>', instruction.contentStart, instruction.contentEnd);
  if (!sessions || sessions.length !== 1) return [];
  const session = sessions[0];
  for (const offset of [tool.start, instruction.start, instruction.contentEnd, session.start, session.contentEnd]) {
    if (protectedLines.has(lineStartAt(text, offset))) return [];
  }
  const result = stripSessionBlock(text, session.contentStart, session.contentEnd, protectedLines);
  return result.removedLines ? [{ ...result, start: session.contentStart, end: session.contentEnd }] : [];
}

function findTopLevelTools(text, start, end) {
  const tags = new RegExp(TOOL_TAG.source, 'g');
  const tools = [];
  const stack = [];
  let match;
  while ((match = tags.exec(text.slice(start, end))) !== null) {
    const tagStart = start + match.index;
    if (match[0] === '</tool>') {
      if (!stack.length) return null;
      const opened = stack.pop();
      if (opened.name) {
        if (stack.length) return null;
        tools.push({ ...opened, contentEnd: tagStart });
      }
    } else {
      const name = stack.length === 0 ? matchingToolName(match[0]) : null;
      stack.push(name ? { name, start: tagStart, contentStart: tagStart + match[0].length } : {});
    }
  }
  return stack.length === 0 ? tools : null;
}

function nextUnprotectedToolsTag(text, marker, cursor, protectedLines) {
  let index = nextToolsTag(text, marker, cursor);
  while (index !== -1 && protectedLines.has(lineStartAt(text, index))) {
    index = nextToolsTag(text, marker, index + marker.length);
  }
  return index;
}

function nextToolsTag(text, marker, cursor) {
  let index = text.indexOf(marker, cursor);
  while (index !== -1) {
    const boundary = text[index + marker.length];
    if (boundary === '>' || boundary === ' ' || boundary === '\t' || boundary === '\r' || boundary === '\n') return index;
    index = text.indexOf(marker, index + marker.length);
  }
  return -1;
}

function scanTopLevelTools(text) {
  const regions = [];
  const protectedLines = protectedMarkdownLines(text);
  let cursor = 0;
  let open = null;

  while (cursor < text.length) {
    const openAt = nextUnprotectedToolsTag(text, '<tools', cursor, protectedLines);
    const closeAt = nextUnprotectedToolsTag(text, '</tools', cursor, protectedLines);
    if (openAt === -1 && closeAt === -1) break;

    if (openAt !== -1 && (closeAt === -1 || openAt < closeAt)) {
      const tagEnd = text.indexOf('>', openAt + '<tools'.length);
      if (tagEnd === -1 || open) return { valid: false, regions: [] };
      open = { start: openAt, contentStart: tagEnd + 1, opening: text.slice(openAt, tagEnd + 1) };
      cursor = tagEnd + 1;
      continue;
    }

    if (closeAt === -1 || text.slice(closeAt, closeAt + '</tools>'.length) !== '</tools>' || !open) {
      return { valid: false, regions: [] };
    }
    regions.push({ ...open, closeStart: closeAt, end: closeAt + '</tools>'.length });
    open = null;
    cursor = closeAt + '</tools>'.length;
  }

  return open ? { valid: false, regions: [] } : { valid: true, regions };
}

/** Remove matched date lines only inside known LobeHub Memory/Credentials tool prompt wrappers. */
export function stripSessionDates(text) {
  if (typeof text !== 'string') return { text, removedLines: 0 };
  const protectedLines = protectedMarkdownLines(text);
  const scan = scanTopLevelTools(text);
  if (!scan.valid) return { text, removedLines: 0 };

  let output = '', removedLines = 0, cursor = 0;
  for (const region of scan.regions) {
    output += text.slice(cursor, region.start);
    const isTargetWrapper = region.opening === TOOLS_OPEN;
    const isProtected = protectedLines.has(lineStartAt(text, region.start));
    if (!isTargetWrapper || isProtected) {
      output += text.slice(region.start, region.end);
      cursor = region.end;
      continue;
    }

    const tools = findTopLevelTools(text, region.contentStart, region.closeStart);
    const replacements = [];
    if (tools) {
      for (const tool of tools) {
        if (protectedLines.has(lineStartAt(text, tool.start))) continue;
        replacements.push(...stripInTool(text, tool, protectedLines));
      }
    }

    if (replacements.length === 0) {
      output += text.slice(region.start, region.end);
      cursor = region.end;
      continue;
    }

    let inner = region.start;
    for (const replacement of replacements) {
      output += text.slice(inner, replacement.start) + replacement.text;
      inner = replacement.end;
      removedLines += replacement.removedLines;
    }
    output += text.slice(inner, region.end);
    cursor = region.end;
  }

  if (removedLines === 0) return { text, removedLines: 0 };
  output += text.slice(cursor);
  return { text: output, removedLines };
}
