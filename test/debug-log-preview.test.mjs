import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readDebugLogs } from '../src/debug-log-reader.mjs';
import { initializeDebugLogPreview } from '../page/debug-log-preview.mjs';

const valid = (overrides = {}) => ({
  schemaVersion: 1,
  kind: 'request',
  protocol: 'chat',
  timestamp: '2026-11-12T01:02:03.000Z',
  outcome: 'changed',
  edits: [{
    kind: 'available_agents',
    action: 'replace',
    stage: 'agent_context',
    range: { start: 12, end: 50, unit: 'utf16' },
    before: 'Authorization: Bearer synthetic-value-12345',
    after: '<available_agents>Search with Agent Management.</available_agents>',
    beforeTruncated: false,
    afterTruncated: false,
    beforeOmitted: false,
  }],
  ignoredSecret: 'should never reach the browser',
  ...overrides,
});

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'session-date-preview-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('projects only validated log fields and redacts existing snippets again', async () => {
  await withDirectory(async (directory) => {
    const titleEdit = {
      schemaVersion: 1, kind: 'request', protocol: 'responses', timestamp: '2026-11-12T01:02:04.000Z', outcome: 'changed',
      edits: [
        { kind: 'topic_title', action: 'delete', stage: 'prompt_metadata', range: { start: 40, end: 75, unit: 'utf16' }, before: 'Topic Title: synthetic', after: '' },
        { kind: 'current_date', action: 'delete', stage: 'prompt_metadata', range: { start: 80, end: 104, unit: 'utf16' }, before: 'Current date: synthetic', after: '' },
        { kind: 'tool_session_date', action: 'delete', stage: 'session_dates', range: { start: 1, end: 20, unit: 'utf16' }, before: 'Session date: synthetic', after: '' },
      ],
    };
    await writeFile(join(directory, 'session-date-filter-test-run.jsonl'), `${JSON.stringify(valid())}\n${JSON.stringify(titleEdit)}\n`);
    const result = await readDebugLogs(directory);
    assert.equal(result.records.length, 2);
    assert.deepEqual(Object.keys(result.records[0]).sort(), ['code', 'edits', 'kind', 'omittedEdits', 'outcome', 'protocol', 'timestamp']);
    assert.equal(result.records[1].edits[0].before.includes('synthetic-value-12345'), false);
    assert.equal(result.records[1].edits[0].stage, 'agent_context');
    assert.deepEqual(result.records[1].edits[0].range, { start: 12, end: 50, unit: 'utf16' });
    assert.equal(result.records[0].edits[0].kind, 'topic_title');
    assert.equal(result.records[0].edits[0].action, 'delete');
    assert.equal(result.records[0].edits[0].stage, 'prompt_metadata');
    assert.deepEqual(result.records[0].edits.map((edit) => edit.kind), ['topic_title', 'current_date', 'tool_session_date']);
    assert.equal(JSON.stringify(result).includes('ignoredSecret'), false);
  });
});

test('ignores partial, corrupt, unsupported and malformed records while keeping valid entries', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'session-date-filter-test-run.jsonl');
    const unsupported = valid({ kind: 'surprise', protocol: 'chat' });
    const invalidEdit = valid({ edits: [{ kind: 'unknown', action: 'run', before: 'secret', after: 'secret' }] });
    await writeFile(path, `${JSON.stringify(valid())}\nnot-json\n${JSON.stringify(unsupported)}\n${JSON.stringify(invalidEdit)}\n${JSON.stringify(valid())}`);
    const result = await readDebugLogs(directory);
    assert.equal(result.records.length, 2);
    assert.equal(result.records.some((record) => record.edits.length === 1 && record.edits[0].kind === 'available_agents'), true);
    assert.equal(result.records.some((record) => record.edits.length === 0), true);
  });
});

test('rejects symlinked managed files and a symlinked log directory', async () => {
  await withDirectory(async (directory) => {
    const outside = join(directory, 'outside.jsonl');
    await writeFile(outside, `${JSON.stringify(valid())}\n`);
    await symlink(outside, join(directory, 'session-date-filter-linked.jsonl'));
    assert.deepEqual(await readDebugLogs(directory), { records: [], limited: false, limitReasons: [] });
    const linkDir = join(directory, 'link');
    await symlink(directory, linkDir, 'dir');
    assert.deepEqual(await readDebugLogs(linkDir), { records: [], limited: false, limitReasons: [] });
  });
});

test('bounds oversized lines, file scanning, file reads, record count and response size', async () => {
  await withDirectory(async (directory) => {
    const huge = valid({ edits: [{ kind: 'available_agents', action: 'replace', before: 'x'.repeat(60_000), after: 'safe' }] });
    await writeFile(join(directory, 'session-date-filter-huge.jsonl'), `${JSON.stringify(huge)}\n`);
    for (let index = 0; index < 48; index += 1) {
      await writeFile(join(directory, `session-date-filter-${String(index).padStart(3, '0')}.jsonl`), `${JSON.stringify(valid())}\n`);
    }
    const result = await readDebugLogs(directory);
    assert.ok(result.records.length <= 40);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 240 * 1024);
    assert.equal(result.records.some((record) => record.edits.some((edit) => edit.before?.length > 8192)), false);
  });
});

test('returns empty preview for unavailable directories', async () => {
  assert.deepEqual(await readDebugLogs(join(tmpdir(), 'missing-session-date-preview')), { records: [], limited: false, limitReasons: [] });
  await withDirectory(async (directory) => {
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'synthetic');
    assert.deepEqual(await readDebugLogs(file), { records: [], limited: false, limitReasons: [] });
  });
});

test('sorts records newest first across rotated files and tolerates optional legacy fields', async () => {
  await withDirectory(async (directory) => {
    const old = { schemaVersion: 1, kind: 'request', protocol: 'chat', timestamp: '2026-11-10T00:00:00.000Z' };
    const recent = valid({ timestamp: '2026-11-12T00:00:00.000Z', edits: undefined, outcome: undefined });
    await writeFile(join(directory, 'session-date-filter-older.jsonl'), `${JSON.stringify(old)}\n`);
    await writeFile(join(directory, 'session-date-filter-recent.jsonl'), `${JSON.stringify(recent)}\n`);
    const result = await readDebugLogs(directory);
    assert.deepEqual(result.records.map((record) => record.timestamp), ['2026-11-12T00:00:00.000Z', '2026-11-10T00:00:00.000Z']);
    assert.deepEqual(result.records[0].edits, []);
    assert.equal(result.records[0].outcome, null);
  });
});

test('keeps the newest records when a single file exceeds the line cap', async () => {
  await withDirectory(async (directory) => {
    const start = Date.parse('2026-11-12T00:00:00.000Z');
    const lines = Array.from({ length: 650 }, (_, index) => JSON.stringify({
      schemaVersion: 1,
      kind: 'request',
      protocol: 'chat',
      timestamp: new Date(start + index * 1000).toISOString(),
      outcome: 'unchanged',
      edits: [],
    }));
    const contents = `${lines.join('\n')}\n`;
    assert.ok(Buffer.byteLength(contents) < 96 * 1024);
    await writeFile(join(directory, 'session-date-filter-many-lines.jsonl'), contents);
    const result = await readDebugLogs(directory);
    assert.equal(result.records[0].timestamp, '2026-11-12T00:10:49.000Z');
    assert.equal(result.limited, true);
    assert.ok(result.limitReasons.includes('lines'));
  });
});

test('selects newest files when more than 32 managed logs exist', async () => {
  await withDirectory(async (directory) => {
    const base = Date.parse('2026-11-12T00:00:00.000Z');
    for (let index = 0; index < 40; index += 1) {
      const timestamp = new Date(base + index * 1000).toISOString();
      const path = join(directory, `session-date-filter-run-${String(index).padStart(3, '0')}.jsonl`);
      await writeFile(path, `${JSON.stringify({ schemaVersion: 1, kind: 'request', protocol: 'chat', timestamp, outcome: 'unchanged' })}\n`);
      const fileTime = new Date(base + index * 1000);
      await utimes(path, fileTime, fileTime);
    }
    const result = await readDebugLogs(directory);
    assert.equal(result.records[0].timestamp, new Date(base + 39_000).toISOString());
    assert.ok(result.limitReasons.includes('files'));
    assert.equal(result.limited, true);
  });
});

test('marks a capped directory scan as range limited', async () => {
  await withDirectory(async (directory) => {
    const timestamp = '2026-11-12T00:00:00.000Z';
    const line = `${JSON.stringify({ schemaVersion: 1, kind: 'request', protocol: 'chat', timestamp, outcome: 'unchanged' })}\n`;
    for (let index = 0; index < 520; index += 1) {
      await writeFile(join(directory, `session-date-filter-scan-${String(index).padStart(4, '0')}.jsonl`), line);
    }
    const result = await readDebugLogs(directory);
    assert.equal(result.limited, true);
    assert.ok(result.limitReasons.includes('scan'));
  });
});

test('keeps every projected edit schema valid and counts rejected edit snippets', async () => {
  await withDirectory(async (directory) => {
    const record = valid({
      edits: [
        { kind: 'available_agents', action: 'replace', before: 'safe', after: 'x'.repeat(9000) },
        { kind: 'topic_title', action: 'delete', stage: 'prompt_metadata', range: { start: 1, end: 2, unit: 'utf16' }, path: 'p'.repeat(600), before: 'b'.repeat(9000), after: '' },
        { kind: 'current_date', action: 'delete', before: 'bad', after: { unexpected: true } },
      ],
    });
    await writeFile(join(directory, 'session-date-filter-edit-bounds.jsonl'), `${JSON.stringify(record)}\n`);
    const result = await readDebugLogs(directory);
    const [projected] = result.records[0].edits;
    assert.equal(result.records[0].edits.length, 1);
    assert.equal(result.records[0].omittedEdits, 2);
    assert.equal(typeof projected.after, 'string');
    assert.equal(projected.after, '');
    assert.equal(projected.before, null);
    assert.equal(projected.beforeOmitted, true);
    assert.ok(projected.path.startsWith('prompt_metadata'));
  });
});

test('only known error codes are exposed', async () => {
  await withDirectory(async (directory) => {
    const records = [
      valid({ kind: 'error', code: 'filter-error', edits: undefined }),
      valid({ kind: 'error', code: 'synthetic-sensitive-code-value', timestamp: '2026-11-12T01:02:04.000Z', edits: undefined }),
    ];
    await writeFile(join(directory, 'session-date-filter-error-codes.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const result = await readDebugLogs(directory);
    assert.deepEqual(result.records.map((record) => record.code), [null, 'filter-error']);
  });
});

class FakeElement {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.textContent = ''; this.checked = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
}

function fakeDocument() {
  const elements = new Map(['debugLogRefresh', 'debugLogAll', 'debugLogStatus', 'debugLogList'].map((id) => [id, new FakeElement(id)]));
  return {
    elements,
    getElementById: (id) => elements.get(id),
    createElement: (tagName) => new FakeElement(tagName),
  };
}

test('renders only changed records by default and treats log text as text nodes', async () => {
  const documentRef = fakeDocument();
  const records = [
    { timestamp: '2026-11-12T01:02:03.000Z', protocol: 'chat', kind: 'request', outcome: 'changed', code: null, edits: [{ kind: 'available_agents', action: 'replace', stage: 'agent_context', range: null, path: '<b>safe path text</b>', before: 'old', after: '<img src=x onerror=alert(1)>', redacted: false, beforeTruncated: false, afterTruncated: false, beforeOmitted: false }], omittedEdits: 0 },
    { timestamp: '2026-11-12T01:02:04.000Z', protocol: 'chat', kind: 'request', outcome: 'unchanged', code: null, edits: [], omittedEdits: 0 },
    { timestamp: '2026-11-12T01:02:05.000Z', protocol: 'chat', kind: 'error', outcome: null, code: 'filter-error', edits: [], omittedEdits: 0 },
    { timestamp: '2026-11-12T01:02:06.000Z', protocol: 'chat', kind: 'request', outcome: 'changed', code: null, edits: [{ kind: 'topic_title', action: 'delete', stage: 'prompt_metadata', range: null, path: null, before: null, after: '', redacted: false, beforeTruncated: false, afterTruncated: false, beforeOmitted: true }], omittedEdits: 0 },
  ];
  initializeDebugLogPreview({
    token: 'a'.repeat(64),
    documentRef,
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ records, limited: true, limitReasons: ['files'] }) }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const list = documentRef.elements.get('debugLogList');
  assert.equal(list.children.length, 2);
  const pre = list.children[0].children[1].children[0].children[1].children[1].children[1];
  assert.equal(pre.tagName, 'pre');
  assert.equal(pre.textContent, '<img src=x onerror=alert(1)>');
  const deleted = list.children[1].children[1].children[0].children[1];
  assert.equal(deleted.children[0].children[1].textContent, 'Original snippet not stored');
  assert.equal(deleted.children[1].children[1].textContent, 'Removed');
  assert.equal(documentRef.elements.get('debugLogStatus').dataset.state, 'ok');
  assert.match(documentRef.elements.get('debugLogStatus').textContent, /Read scope limited/);
  const showAll = documentRef.elements.get('debugLogAll');
  showAll.checked = true;
  showAll.listeners.change();
  assert.equal(list.children.length, 4);
});
