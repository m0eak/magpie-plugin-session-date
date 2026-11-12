import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactText } from './debug-writer.mjs';

const FILE_NAME = /^session-date-filter-[A-Za-z0-9-]+\.jsonl$/;
const PROTOCOLS = new Set(['chat', 'responses', 'anthropic', 'gemini']);
const EDIT_KINDS = new Set(['available_agents', 'agent_instruction', 'current_date', 'topic_title', 'tool_session_date']);
const EDIT_ACTIONS = new Set(['replace', 'delete', 'remove']);
const EDIT_STAGES = new Set(['agent_context', 'prompt_metadata', 'session_dates']);
const ERROR_CODES = new Set(['filter-settings-unavailable', 'filter-transform-error', 'filter-error']);

const MAX_SCAN = 512;
const MAX_FILES = 8;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 48 * 1024;
const MAX_LINES = 512;
const MAX_RECORDS = 40;
const MAX_RESPONSE_BYTES = 240 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_EDITS = 16;

const boundedText = (value, maxBytes) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes
  ? redactText(value)
  : null;
const boundedOmitted = (value) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100000) : 0;

function projectRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return null;
  if (!['request', 'error'].includes(value.kind) || !PROTOCOLS.has(value.protocol)) return null;
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return null;

  const sourceEdits = Array.isArray(value.edits) ? value.edits : [];
  let omittedEdits = Math.min(100000, boundedOmitted(value.omittedEdits) + Math.max(0, sourceEdits.length - MAX_EDITS));
  const record = {
    timestamp: new Date(value.timestamp).toISOString(),
    protocol: value.protocol,
    kind: value.kind,
    outcome: value.kind === 'request' && ['changed', 'unchanged'].includes(value.outcome) ? value.outcome : null,
    code: value.kind === 'error' && ERROR_CODES.has(value.code) ? value.code : null,
    edits: [],
    omittedEdits,
  };

  for (const edit of sourceEdits.slice(0, MAX_EDITS)) {
    if (!edit || typeof edit !== 'object' || !EDIT_KINDS.has(edit.kind) || !EDIT_ACTIONS.has(edit.action)) {
      omittedEdits += 1;
      continue;
    }

    const stage = EDIT_STAGES.has(edit.stage) ? edit.stage : null;
    const range = edit.range && Number.isSafeInteger(edit.range.start) && Number.isSafeInteger(edit.range.end)
      && edit.range.start >= 0 && edit.range.end >= edit.range.start
      ? { start: edit.range.start, end: edit.range.end, unit: edit.range.unit === 'utf16' ? 'utf16' : 'unknown' }
      : null;
    const path = boundedText(edit.path, MAX_PATH_BYTES)
      ?? (stage ? `${stage}${range ? ` · ${range.start}–${range.end}` : ''}` : range ? `${range.start}–${range.end}` : null);
    const rawBefore = typeof edit.before === 'string' ? edit.before : null;
    const before = rawBefore === null ? null : boundedText(rawBefore, MAX_TEXT_BYTES);
    const rawAfter = typeof edit.after === 'string' ? edit.after : null;
    const after = rawAfter === null ? null : boundedText(rawAfter, MAX_TEXT_BYTES);

    // Never return a malformed edit: after is always a string on every projected edit.
    if (after === null) {
      omittedEdits += 1;
      continue;
    }
    record.edits.push({
      kind: edit.kind,
      action: edit.action,
      path,
      stage,
      range,
      before,
      after,
      redacted: edit.redacted === true,
      beforeTruncated: edit.beforeTruncated === true,
      afterTruncated: edit.afterTruncated === true,
      beforeOmitted: edit.beforeOmitted === true || before === null,
    });
  }
  record.omittedEdits = Math.min(100000, omittedEdits);
  return record;
}

async function readTailLines(path, byteBudget, lineBudget) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || byteBudget <= 0 || lineBudget <= 0) {
      return { lines: [], bytesRead: 0, byteLimited: false, lineLimited: false, lineSizeLimited: false };
    }
    const size = Math.min(info.size, MAX_FILE_BYTES, byteBudget);
    const start = Math.max(0, info.size - size);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    let text = buffer.toString('utf8', 0, bytesRead);
    const byteLimited = start > 0;
    if (byteLimited) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    }

    // Drop the last line because a concurrent append may have left it incomplete.
    const lastNewline = text.lastIndexOf('\n');
    text = lastNewline < 0 ? '' : text.slice(0, lastNewline + 1);
    const completeLines = text.split('\n');
    const lines = [];
    let lineSizeLimited = false;
    let lineLimited = false;
    for (let index = completeLines.length - 2; index >= 0; index -= 1) {
      const line = completeLines[index];
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        lineSizeLimited = true;
        continue;
      }
      if (lines.length >= lineBudget) {
        lineLimited = true;
        break;
      }
      lines.push(line);
    }
    if (lines.length >= lineBudget) lineLimited = true;
    return { lines, bytesRead, byteLimited, lineLimited, lineSizeLimited };
  } catch {
    return { lines: [], bytesRead: 0, byteLimited: false, lineLimited: false, lineSizeLimited: false };
  } finally {
    try { await handle?.close(); } catch {}
  }
}

export async function readDebugLogs(directory) {
  const limitReasons = new Set();
  if (typeof directory !== 'string' || !directory) return { records: [], limited: false, limitReasons: [] };
  try {
    const dirInfo = await lstat(directory);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return { records: [], limited: false, limitReasons: [] };
  } catch { return { records: [], limited: false, limitReasons: [] }; }

  const candidates = [];
  let scanned = 0;
  try {
    const dir = await opendir(directory);
    for await (const entry of dir) {
      scanned += 1;
      if (FILE_NAME.test(entry.name)) candidates.push(entry.name);
      if (scanned >= MAX_SCAN) {
        limitReasons.add('scan');
        break;
      }
    }
  } catch { return { records: [], limited: false, limitReasons: [] }; }

  const files = [];
  for (const name of candidates) {
    try {
      const info = await lstat(join(directory, name));
      if (info.isFile() && !info.isSymbolicLink()) files.push({ name, mtime: info.mtimeMs });
    } catch { /* Rotation may remove a candidate during the scan. */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  if (files.length > MAX_FILES) limitReasons.add('files');

  const lines = [];
  let remainingBytes = MAX_TOTAL_BYTES;
  for (const file of files.slice(0, MAX_FILES)) {
    if (remainingBytes <= 0) {
      limitReasons.add('bytes');
      break;
    }
    if (lines.length >= MAX_LINES) {
      limitReasons.add('lines');
      break;
    }
    const tail = await readTailLines(join(directory, file.name), remainingBytes, MAX_LINES - lines.length);
    remainingBytes -= tail.bytesRead;
    if (tail.byteLimited) limitReasons.add('bytes');
    if (tail.lineLimited) limitReasons.add('lines');
    if (tail.lineSizeLimited) limitReasons.add('line-size');
    lines.push(...tail.lines);
  }

  const records = [];
  for (const line of lines) {
    try {
      const record = projectRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch { /* Ignore corrupt records without exposing their content. */ }
  }
  records.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  if (records.length > MAX_RECORDS) limitReasons.add('records');
  let bounded = records.slice(0, MAX_RECORDS);
  while (Buffer.byteLength(JSON.stringify({
    records: bounded,
    limited: limitReasons.size > 0,
    limitReasons: [...limitReasons],
  })) > MAX_RESPONSE_BYTES) {
    if (!bounded.length) break;
    bounded = bounded.slice(0, -1);
    limitReasons.add('response');
  }
  return { records: bounded, limited: limitReasons.size > 0, limitReasons: [...limitReasons] };
}
