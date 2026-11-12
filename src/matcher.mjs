const TOOLS_OPEN = '<tools description="The tools you can use below">';
const TOOL_TAG = /<tool(?:\s+[^>]*)?>|<\/tool>/g;
const DATE_LINE = /^[\t ]*Session date:[\t ]*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),[\t ]*(January|February|March|April|May|June|July|August|September|October|November|December)[\t ]+(\d{1,2}),[\t ]+(\d{4})[\t ]*$/;
const CURRENT_DATE_LINE = /^[\t ]*Current date:[\t ]*(\d{4})-(\d{2})-(\d{2})(?:[\t ]+\(([^()\r\n]+)\))?[\t ]*$/;
const TOPIC_TITLE_LINE = /^[\t ]*\|[\t ]*Topic Title[\t ]*\|(?:[^\r\n]*\|)[\t ]*$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = new Map([
  ['January', 0], ['February', 1], ['March', 2], ['April', 3], ['May', 4], ['June', 5],
  ['July', 6], ['August', 7], ['September', 8], ['October', 9], ['November', 10], ['December', 11],
]);

function lineStartAt(text, offset) {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

export function protectedMarkdownLines(text) {
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
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
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

function isPromptMetadataLine(line) {
  if (TOPIC_TITLE_LINE.test(line)) return true;
  const match = CURRENT_DATE_LINE.exec(line);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (year < 1 || month < 0 || month > 11 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day;
}

function stripPromptMetadata(text, options = {}) {
  const protectedLines = protectedMarkdownLines(text);
  let output = '', removedLines = 0, dateRemovedLines = 0, topicTitleRemovedLines = 0, cursor = 0;
  while (cursor < text.length) {
    const lineStart = cursor;
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1) lineEnd = text.length;
    const valueEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = text.slice(lineStart, valueEnd);
    const next = lineEnd < text.length ? lineEnd + 1 : lineEnd;
    const isTitle = TOPIC_TITLE_LINE.test(line);
    const isCurrentDate = !isTitle && isPromptMetadataLine(line);
    if (!protectedLines.has(lineStart) && ((isTitle && options.topicTitle !== false) || (isCurrentDate && options.sessionDate !== false))) {
      removedLines += 1;
      const guidanceInserted = Boolean(!isTitle && options.dateReplacement && !options.replacementState?.inserted);
      options.recordEdit?.({
        kind: isTitle ? 'topic_title' : 'current_date',
        action: guidanceInserted ? 'replace' : 'delete',
        stage: 'prompt_metadata',
        offset: lineStart,
        source: text, start: lineStart, end: next,
        after: guidanceInserted ? `${options.dateReplacement}${next > lineEnd ? text.slice(lineEnd, next) : ''}` : '',
        insertedTimeGuidance: guidanceInserted,
      });
      if (isTitle) topicTitleRemovedLines += 1;
      else {
        dateRemovedLines += 1;
        if (options.dateReplacement && !options.replacementState?.inserted) {
          output += options.dateReplacement;
          if (next > lineEnd) output += text.slice(lineEnd, next);
          if (options.replacementState) options.replacementState.inserted = true;
        }
      }
    } else {
      output += text.slice(lineStart, next);
    }
    cursor = next;
  }
  return { text: output, removedLines, dateRemovedLines, topicTitleRemovedLines };
}

function stripSessionBlock(text, start, end, protectedLines, options = {}) {
  let output = '', removedLines = 0, cursor = start;
  while (cursor < end) {
    let lineStart = cursor;
    while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart -= 1;
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1) lineEnd = text.length;
    const valueEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = text.slice(lineStart, valueEnd);
    const next = lineEnd < text.length ? lineEnd + 1 : lineEnd;
    const insideTarget = lineStart >= start && lineEnd <= end;
    if (options.sessionDate !== false && insideTarget && !protectedLines.has(lineStart) && isValidCalendarLine(line)) {
      removedLines += 1;
      const guidanceInserted = Boolean(options.dateReplacement && !options.replacementState?.inserted);
      options.recordEdit?.({
        kind: 'tool_session_date',
        action: guidanceInserted ? 'replace' : 'delete',
        stage: 'session_dates',
        offset: lineStart,
        source: text, start: lineStart, end: next,
        after: guidanceInserted ? `${options.dateReplacement}${next > lineEnd ? text.slice(lineEnd, next) : ''}` : '',
        insertedTimeGuidance: guidanceInserted,
      });
      output += text.slice(cursor, lineStart);
      if (options.dateReplacement && !options.replacementState?.inserted) {
        output += options.dateReplacement;
        if (next > lineEnd) output += text.slice(lineEnd, next);
        if (options.replacementState) options.replacementState.inserted = true;
      }
      cursor = next;
    } else {
      const chunkEnd = Math.min(next, end);
      output += text.slice(cursor, chunkEnd);
      cursor = chunkEnd;
    }
  }
  return { text: output, removedLines };
}

function matchingToolName(openTag) {
  if (openTag === '<tool name="Memory">') return 'Memory';
  if (openTag === '<tool name="Credentials">') return 'Credentials';
  return null;
}

function nextUnprotectedTag(text, tag, cursor, end, protectedLines) {
  let index = text.indexOf(tag, cursor);
  while (index !== -1 && index < end) {
    if (!protectedLines.has(lineStartAt(text, index))) return index;
    index = text.indexOf(tag, index + tag.length);
  }
  return -1;
}

function findTagsInRange(text, open, close, start, end, protectedLines) {
  const result = [];
  let cursor = start;
  while (cursor < end) {
    const openAt = nextUnprotectedTag(text, open, cursor, end, protectedLines);
    const closeAt = nextUnprotectedTag(text, close, cursor, end, protectedLines);
    if (closeAt !== -1 && (openAt === -1 || closeAt < openAt)) return null;
    if (openAt === -1) break;
    const nextOpen = nextUnprotectedTag(text, open, openAt + open.length, end, protectedLines);
    const nextClose = nextUnprotectedTag(text, close, openAt + open.length, end, protectedLines);
    if (nextClose === -1 || (nextOpen !== -1 && nextOpen < nextClose)) return null;
    result.push({ start: openAt, contentStart: openAt + open.length, contentEnd: nextClose, end: nextClose + close.length });
    cursor = nextClose + close.length;
  }
  return result;
}

function stripInTool(text, tool, protectedLines, options) {
  const instructionOpen = '<tool.instructions>', instructionClose = '</tool.instructions>';
  const instructions = findTagsInRange(text, instructionOpen, instructionClose, tool.contentStart, tool.contentEnd, protectedLines);
  if (!instructions || instructions.length !== 1) return [];
  const instruction = instructions[0];
  const sessions = findTagsInRange(text, '<session_context>', '</session_context>', instruction.contentStart, instruction.contentEnd, protectedLines);
  if (!sessions || sessions.length !== 1) return [];
  const session = sessions[0];
  for (const offset of [tool.start, instruction.start, instruction.contentEnd, session.start, session.contentEnd]) {
    if (protectedLines.has(lineStartAt(text, offset))) return [];
  }
  const result = stripSessionBlock(text, session.contentStart, session.contentEnd, protectedLines, options);
  return result.removedLines ? [{ ...result, start: session.contentStart, end: session.contentEnd }] : [];
}

function findTopLevelTools(text, start, end, protectedLines) {
  const tags = new RegExp(TOOL_TAG.source, 'g');
  const tools = [];
  const stack = [];
  let match;
  while ((match = tags.exec(text)) !== null) {
    const tagStart = match.index;
    if (tagStart < start) continue;
    if (tagStart >= end) break;
    if (protectedLines.has(lineStartAt(text, tagStart))) continue;
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
export function stripSessionDates(text, options = {}) {
  if (typeof text !== 'string') return { text, removedLines: 0 };
  const settings = {
    sessionDate: options.sessionDate !== false,
    topicTitle: options.topicTitle !== false,
    dateReplacement: options.dateReplacement,
    replacementState: { inserted: false },
    recordEdit: options.recordEdit,
  };
  const protectedLines = protectedMarkdownLines(text);
  const scan = scanTopLevelTools(text);
  if (!scan.valid) {
    const metadata = stripPromptMetadata(text, settings);
    return options.withCategories
      ? { ...metadata, timeGuidanceInsertedBlocks: settings.replacementState.inserted ? 1 : 0 }
      : { text: metadata.text, removedLines: metadata.removedLines };
  }

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

    const tools = findTopLevelTools(text, region.contentStart, region.closeStart, protectedLines);
    const replacements = [];
    if (tools) {
      for (const tool of tools) {
        if (protectedLines.has(lineStartAt(text, tool.start))) continue;
        replacements.push(...stripInTool(text, tool, protectedLines, settings));
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

  if (removedLines === 0) output = text;
  else output += text.slice(cursor);
  const metadata = stripPromptMetadata(output, settings);
  const totalRemovedLines = removedLines + metadata.removedLines;
  const result = {
    text: totalRemovedLines === 0 ? text : metadata.text,
    removedLines: totalRemovedLines,
    dateRemovedLines: removedLines + metadata.dateRemovedLines,
    topicTitleRemovedLines: metadata.topicTitleRemovedLines,
    timeGuidanceInsertedBlocks: settings.replacementState.inserted ? 1 : 0,
  };
  return options.withCategories ? result : { text: result.text, removedLines: result.removedLines };
}
