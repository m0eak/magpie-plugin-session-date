import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open as fsOpen, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequestHook } from '../src/request.hooks.mjs';
import { DebugConfigStore } from '../src/debug-config.mjs';
import { configureDebugWriter, getDebugWriter, DebugWriter, redactText } from '../src/debug-writer.mjs';
import { filterRequest } from '../src/protocols.mjs';
import { transformPromptText } from '../src/stable-context.mjs';
import { createService } from '../src/service-api.mjs';

const fixture = new URL('./fixtures/debug-writer-child.mjs', import.meta.url);
const bodies = {
  chat: { messages: [{ role: 'system', content: 'Current date: 2026-11-12\n| Topic Title | Demo |' }] },
  responses: { instructions: 'Current date: 2026-11-12\n| Topic Title | Demo |' },
  anthropic: { system: 'Current date: 2026-11-12\n| Topic Title | Demo |' },
  gemini: { systemInstruction: { parts: [{ text: 'Current date: 2026-11-12\n| Topic Title | Demo |' }] } },
};
const configs = Array.from({ length: 8 }, (_, bits) => ({
  sessionDate: Boolean(bits & 1),
  topicTitle: Boolean(bits & 2),
  availableAgents: Boolean(bits & 4),
}));

test('debug-config defaults closed, persists only its own boolean and rejects unknown keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-debug-config-'));
  try {
    const store = new DebugConfigStore({ dataDir: dir, schedule: () => ({ unref() {} }) });
    assert.deepEqual(store.snapshot(), { enabled: false });
    assert.deepEqual(await store.replace({ enabled: true }), { enabled: true });
    assert.equal((await readFile(join(dir, 'debug-config.json'), 'utf8')).trim(), '{"enabled":true}');
    await assert.rejects(store.replace({ enabled: true, sessionDate: false }));
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('four protocols × eight settings remain byte-equivalent with diagnostics enabled', () => {
  for (const [protocol, body] of Object.entries(bodies)) {
    for (const settings of configs) {
      const baseline = filterRequest(body, protocol, settings);
      const emitted = [];
      const observed = filterRequest(body, protocol, settings, {
        onEdit: (event) => emitted.push(event),
        onError: () => assert.fail('valid transform should not report an error'),
      });
      assert.equal(JSON.stringify(observed), JSON.stringify(baseline), `${protocol} ${JSON.stringify(settings)}`);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].changed, baseline.changed);
    }
  }
});

test('matcher debug edits contain only the matched line with its stage input offset', () => {
  const input = [
    'Credentials unrelated note must not be logged',
    '<tools description="The tools you can use below">',
    '<tool name="Memory">',
    '<tool.instructions>',
    '<session_context>',
    'Session date: Wednesday, November 12, 2025',
    '</session_context>',
    '</tool.instructions>',
    '</tool>',
    '</tools>',
    '| Topic Title | synthetic title |',
  ].join('\n');
  const result = transformPromptText(input, { sessionDate: true, topicTitle: true, __debugEnabled: true });
  assert.equal(result.changed, true);
  assert.equal(result.edits.length, 2);
  assert.deepEqual(result.edits.map(({ kind, stage }) => [kind, stage]), [
    ['tool_session_date', 'session_dates'],
    ['topic_title', 'prompt_metadata'],
  ]);
  assert.equal(result.edits[0].before, 'Session date: Wednesday, November 12, 2025\n');
  assert.equal(result.edits[0].offset, input.indexOf('Session date:'));
  assert.equal(result.edits[1].before, '| Topic Title | synthetic title |');
  assert.equal(
    result.edits[1].offset,
    input.indexOf('| Topic Title') - result.edits[0].before.length + result.edits[0].after.length,
  );
  assert.ok(result.edits.every((edit) => !edit.before.includes('Credentials unrelated')));
});

test('multiple date edits describe one actual guidance insertion and protocol paths are JSON Pointers', () => {
  const chatEvents = [];
  const body = { messages: [{ role: 'system', content: 'Current date: 2026-11-12\nCurrent date: 2026-11-12' }] };
  const result = filterRequest(body, 'chat', { sessionDate: true, topicTitle: true, availableAgents: false }, {
    onEdit: (event) => chatEvents.push(event),
    onError: () => assert.fail('valid duplicate date lines must remain filterable'),
  });
  assert.equal(result.timeGuidanceInsertedBlocks, 1);
  assert.equal(chatEvents[0].edits.filter((edit) => edit.after.includes('<current_time_guidance>')).length, 1);
  assert.equal(chatEvents[0].edits.filter((edit) => edit.action === 'delete').length, 1);
  assert.ok(chatEvents[0].edits.every((edit) => edit.range?.basis === 'stage-input' && edit.role === 'system'));
  const cases = [
    ['anthropic', { system: [{ type: 'text', text: 'Current date: 2026-11-12' }] }, '/system/0/text', 'system'],
    ['responses', { input: [{ role: 'developer', content: [{ type: 'input_text', text: 'Current date: 2026-11-12' }] }] }, '/input/0/content/0/text', 'developer'],
    ['gemini', { systemInstruction: { parts: [{ text: 'Current date: 2026-11-12' }] } }, '/systemInstruction/parts/0/text', 'system'],
  ];
  for (const [protocol, payload, pointer, role] of cases) {
    let event;
    filterRequest(payload, protocol, { sessionDate: true, topicTitle: true, availableAgents: false }, {
      onEdit: (value) => { event = value; },
    });
    assert.equal(event.edits[0].path, pointer);
    assert.equal(event.edits[0].role, role);
    assert.equal(event.edits[0].range.unit, 'utf16');
  }
  const disabled = filterRequest(body, 'chat', { sessionDate: true, topicTitle: true, availableAgents: false });
  assert.equal(Object.hasOwn(disabled, 'edits'), false);
  assert.equal(Object.hasOwn(disabled, 'omittedEdits'), false);
});

test('diagnostics callback failures cannot undo an applied transform or expose thrown values', () => {
  const body = { messages: [{ role: 'system', content: 'Current date: 2026-11-12' }] };
  const result = filterRequest(body, 'chat', { sessionDate: true, topicTitle: true }, {
    onEdit() { throw new Error('synthetic-secret-should-not-escape'); },
    onError() { throw new Error('also-secret'); },
  });
  assert.equal(result.changed, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|also-secret/);
});

test('default debug writer is used by the request hook and debug access failures do not skip filtering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-hook-'));
  const globalWriter = getDebugWriter();
  let settingsEvents = 0;
  try {
    const writer = configureDebugWriter({ directory: dir, runId: 'hook-integration' });
    writer.setEnabled(true);
    const hook = createRequestHook({
      config: () => ({ snapshot: () => ({ sessionDate: true, topicTitle: true, availableAgents: false }) }),
      debugConfig: () => ({ snapshot: () => ({ enabled: true }) }),
      store: () => ({ record: () => { settingsEvents += 1; } }),
      now: () => new Date('2026-11-12T00:00:00.000Z'),
    });
    const result = await hook({ messages: [{ role: 'system', content: 'Current date: 2026-11-12' }] }, { protocol: 'chat' });
    assert.equal(result.messages[0].content.includes('Current date: 2026-11-12'), false);
    await writer.flush();
    await writer.close();
    const files = await readdir(dir);
    const log = await readFile(join(dir, files.find((name) => name.endsWith('.jsonl'))), 'utf8');
    assert.match(log, /"kind":"request"/);
    assert.equal(settingsEvents, 1);

    const debugFailures = [
      { debugConfig: () => { throw new Error('synthetic-debug-config-getter'); } },
      { debugConfig: () => ({ snapshot: () => { throw new Error('synthetic-debug-config-snapshot'); } }) },
      { debugWriter: () => { throw new Error('synthetic-debug-writer-getter'); } },
      { debugWriter: () => ({ setEnabled() { throw new Error('synthetic-debug-set-enabled'); }, emit() {} }) },
      { debugWriter: () => ({ setEnabled() {}, emit() { throw new Error('synthetic-debug-emit'); } }) },
    ];
    for (const failure of debugFailures) {
      const throwingHook = createRequestHook({
        config: () => ({ snapshot: () => ({ sessionDate: true, topicTitle: true, availableAgents: false }) }),
        debugConfig: () => ({ snapshot: () => ({ enabled: true }) }),
        debugWriter: () => ({ setEnabled() {}, emit() {} }),
        ...failure,
        store: () => ({ record: () => { settingsEvents += 1; } }),
        now: () => new Date('2026-11-12T00:00:00.000Z'),
      });
      const fallback = await throwingHook({ messages: [{ role: 'system', content: 'Current date: 2026-11-12' }] }, { protocol: 'chat' });
      assert.equal(fallback.messages[0].content.includes('Current date: 2026-11-12'), false);
    }
    assert.equal(settingsEvents, 6);
  } finally {
    if (globalWriter) globalThis.__sessionDateDebugWriter = globalWriter;
    else delete globalThis.__sessionDateDebugWriter;
    await rm(dir, { recursive: true, force: true });
  }
});

test('redaction removes full synthetic secrets across token, cookie and credential patterns', () => {
  const secrets = [
    ['sk-' + 'a'.repeat(48), new RegExp('sk-' + 'a'.repeat(48))],
    ['api_key=' + 'b'.repeat(32), /api_key=b{32}/],
    ['token=' + 'c'.repeat(40), /token=c{40}/],
    ['client_secret=' + 'd'.repeat(40), /client_secret=d{40}/],
    ['Cookie: sid=' + 'e'.repeat(24) + '; auth=' + 'f'.repeat(24), /(?:e{24}|f{24})/],
    ['https://user:' + 'g'.repeat(20) + '@example.invalid/path?access_token=' + 'h'.repeat(30), /(?:g{20}|h{30})/],
    ['-----BEGIN PRIVATE KEY-----\n' + 'i'.repeat(48) + '\n-----END PRIVATE KEY-----', /i{48}/],
    ['agt_' + 'j'.repeat(20), /agt_j{20}/],
  ];
  for (const [input, leakPattern] of secrets) {
    const redacted = redactText(input);
    assert.equal(leakPattern.test(redacted), false);
    assert.match(redacted, /REDACTED|OMITTED/);
  }
});

test('pending debug records stay under the configured queue limit during chained flushes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-queue-'));
  const writer = new DebugWriter({
    directory: dir,
    runId: 'bounded-queue',
    limits: { batchCount: 1, flushMs: 60_000, queueCount: 4 },
  });
  try {
    writer.setEnabled(true);
    for (let i = 0; i < 70; i += 1) writer.emit({ kind: 'unchanged', protocol: 'chat', code: 'no-match' });
    assert.ok(writer.status().queuedRequests <= 4);
    assert.ok(writer.status().droppedRequests >= 66);
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown JSONL files are preserved during debug initialization and pruning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-unknown-'));
  const customerFile = join(dir, 'customer-records.jsonl');
  await writeFile(customerFile, '{"keep":"synthetic"}\n', { mode: 0o600 });
  const writer = new DebugWriter({ directory: dir, runId: 'managed-only' });
  try {
    writer.setEnabled(true);
    await writer.prepare();
    assert.equal(await readFile(customerFile, 'utf8'), '{"keep":"synthetic"}\n');
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('writer retires a dead lock owner and gives up promptly on a live owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-lock-'));
  const lock = join(dir, '.writer-lock');
  const exitedPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', () => resolve(child.pid));
  });
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: exitedPid, token: 'stale-owner' }), { mode: 0o600 });
  const recovering = new DebugWriter({ directory: dir, runId: 'recover-lock', limits: { lockWaitMs: 250 } });
  recovering.setEnabled(true);
  try {
    await recovering.preparing;
    assert.equal(recovering.status().reason, null, `stale-owner recovery status: ${recovering.status().reason}`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live-owner' }), { mode: 0o600 });
    const blocked = new DebugWriter({ directory: dir, runId: 'bounded-lock', limits: { lockWaitMs: 40 } });
    blocked.setEnabled(true);
    const started = Date.now();
    await blocked.preparing;
    assert.ok(Date.now() - started < 250);
    assert.equal(blocked.status().reason, 'lock-timeout');
    await blocked.close();
  } finally {
    await recovering.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('writer drops batches when managed-file accounting or deletion fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-io-'));
  try {
    const owned = join(dir, 'session-date-filter-old.jsonl');
    await writeFile(owned, '{"old":true}\n', { mode: 0o600 });
    const lstatWriter = new DebugWriter({
      directory: dir,
      runId: 'lstat-error',
      io: { lstat: async () => { const error = new Error('synthetic filesystem fault'); error.code = 'EIO'; throw error; } },
    });
    lstatWriter.setEnabled(true);
    await lstatWriter.preparing;
    assert.equal(lstatWriter.status().reason, 'write-failed');
    assert.equal(await readFile(owned, 'utf8'), '{"old":true}\n');
    await lstatWriter.close();
    const retained = 'synthetic-old-record'.repeat(12);
    await writeFile(owned, retained, { mode: 0o600 });

    const rmWriter = new DebugWriter({
      directory: dir,
      runId: 'remove-error',
      limits: { totalBytes: 240, fileBytes: 1024 },
      io: { rm: async () => { const error = new Error('synthetic filesystem fault'); error.code = 'EACCES'; throw error; } },
    });
    rmWriter.setEnabled(true);
    await rmWriter.preparing;
    rmWriter.emit({ kind: 'unchanged', protocol: 'chat', code: 'no-match' });
    await rmWriter.flush();
    assert.equal(rmWriter.status().reason, 'write-failed');
    assert.equal(await readFile(owned, 'utf8'), retained);
    assert.equal(rmWriter.status().writtenRequests, 0);
    await rmWriter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a partial JSONL append is truncated before a later valid record is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-short-write-'));
  let failOnce = true;
  const io = {
    open: async (...args) => {
      const handle = await fsOpen(...args);
      if (!failOnce) return handle;
      return {
        stat: (...values) => handle.stat(...values),
        writeFile: async (value, encoding) => {
          if (failOnce) {
            failOnce = false;
            await handle.writeFile(String(value).slice(0, 8), encoding);
            throw new Error('synthetic short write');
          }
          return handle.writeFile(value, encoding);
        },
        truncate: (...values) => handle.truncate(...values),
        chmod: (...values) => handle.chmod(...values),
        close: (...values) => handle.close(...values),
      };
    },
  };
  const writer = new DebugWriter({ directory: dir, runId: 'short-write', io });
  try {
    writer.setEnabled(true);
    await writer.preparing;
    writer.emit({ kind: 'unchanged', protocol: 'chat', code: 'first-record' });
    await writer.flush();
    assert.equal(writer.status().writtenRequests, 0);
    writer.emit({ kind: 'unchanged', protocol: 'chat', code: 'second-record' });
    await writer.flush();
    const name = (await readdir(dir)).find((entry) => entry.endsWith('.jsonl'));
    const contents = await readFile(join(dir, name), 'utf8');
    assert.equal(contents.endsWith('\n'), true);
    assert.deepEqual(contents.trimEnd().split('\n').map((line) => JSON.parse(line).code), ['second-record']);
    assert.equal(writer.status().writtenRequests, 1);
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('writer redacts before truncating, bounds records and drops queued events when disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-debug-writer-'));
  try {
    const writer = new DebugWriter({ directory: dir, runId: 'run-test' });
    writer.setEnabled(true);
    writer.emit({ kind: 'request', protocol: 'chat', outcome: 'changed', edits: [
      { category: 'sessionDate', location: 'messages[0].content', before: 'Authorization: Bearer abcdefghijklmnop', after: 'safe' },
    ] });
    writer.setEnabled(false);
    await writer.flush();
    assert.deepEqual(await readdir(dir), []);
    writer.setEnabled(true);
    writer.emit({ kind: 'request', protocol: 'chat', outcome: 'changed', edits: [
      { category: 'sessionDate', location: 'messages[0].content', before: 'Authorization: Bearer abcdefghijklmnop', after: 'safe' },
    ] });
    await writer.flush();
    writer.emit({ kind: 'request', protocol: 'chat', outcome: 'changed', edits: [
      { category: 'sessionDate', location: 'messages[0].content', before: 'Authorization: Bearer abcdefghijklmnop', after: 'safe' },
    ] });
    writer.emit({ kind: 'request', protocol: 'chat', outcome: 'changed', edits: [
      { category: 'sessionDate', location: 'messages[0].content', before: `x${'a'.repeat(70 * 1024)}`, after: 'safe' },
    ] });
    await writer.flush();
    const text = await readFile(join(dir, 'session-date-filter-run-test.jsonl'), 'utf8');
    for (const secret of ['abcdefghijklmnop', 'sk-shortSecretValue', 'short-token-value', 'api-secret-value', 'cookie-one; session=two', 'url-user:pw-synthetic-value', 'query-secret-value', 'agt_123456789abcdef']) {
      assert.equal(text.includes(secret), false, 'serialized debug data must not retain synthetic secrets');
    }
    assert.match(text, /beforeOmitted":true/);
    assert.ok(Buffer.byteLength(text) <= 64 * 1024);
    assert.equal((await stat(join(dir, 'session-date-filter-run-test.jsonl'))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await writer.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('redactor removes known and generic secret formats without retaining capture groups', () => {
  const secrets = [
    'sk-shortSecretValue', 'ghp_syntheticGitToken',
    'token: short-token-value', 'api_key = api-secret-value', 'secret="value-secret"',
    'Cookie: cookie-one=alpha; session=two-secret', 'https://synthetic-user:' + 'synthetic-password' + '@host.invalid/',
    '?api_key=query-secret-value', 'agt_123456789abcdef',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----',
  ];
  const redacted = redactText(secrets.join('\n'));
  assert.ok(secrets.every((secret) => !redacted.includes(secret)));
});

test('writer truncates by UTF-8 bytes and omits oversized source before redaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-debug-utf8-'));
  try {
    const writer = new DebugWriter({ directory: dir, runId: 'utf8-run' });
    writer.setEnabled(true);
    const before = `sensitive-token: synthetic-secret-value ${'界🙂'.repeat(2000)}`;
    writer.emit({ kind: 'request', protocol: 'chat', outcome: 'changed', edits: [
      { kind: 'topic_title', before, after: '界🙂'.repeat(1000) },
      { kind: 'topic_title', before: 'x'.repeat(70 * 1024), after: 'safe' },
    ] });
    await writer.flush();
    const row = JSON.parse(await readFile(join(dir, 'session-date-filter-utf8-run.jsonl'), 'utf8'));
    assert.equal(JSON.stringify(row).includes('synthetic-secret-value'), false);
    assert.ok(Buffer.byteLength(row.edits[0].before) <= 8 * 1024);
    assert.ok(Buffer.byteLength(row.edits[0].after) <= 1024);
    assert.equal(row.edits[1].before, null);
    assert.equal(row.edits[1].beforeOmitted, true);
    await writer.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two real child processes serialize JSONL writes through the shared directory lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-debug-multiprocess-'));
  try {
    const deadPid = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', () => resolve(child.pid));
    });
    const staleLock = join(dir, '.writer-lock');
    await mkdir(staleLock, { mode: 0o700 });
    await writeFile(join(staleLock, 'owner.json'), JSON.stringify({ pid: deadPid, token: 'stale-before-race' }), { mode: 0o600 });
    const run = (id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fixture.pathname, dir, id], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child-exit-${code}`)));
    });
    await Promise.all([run('run-one'), run('run-two')]);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 2);
    const rows = await Promise.all(files.map(async (name) => JSON.parse((await readFile(join(dir, name), 'utf8')).trim())));
    assert.deepEqual(new Set(rows.map((row) => row.runId)), new Set(['run-one', 'run-two']));
    assert.ok(rows.every((row) => row.sequence === 1 && row.outcome === 'unchanged'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writer rotates per-run files and enforces total directory capacity with test-sized limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-debug-rotation-'));
  try {
    await writeFile(join(dir, 'customer-records.jsonl'), 'keep this file');
    await writeFile(join(dir, 'unrelated-plugin-debug.jsonl'), 'also keep');
    const writer = new DebugWriter({
      directory: dir,
      runId: 'rotate-run',
      limits: { fileBytes: 360, totalBytes: 900, retentionMs: 24 * 60 * 60 * 1000 },
    });
    writer.setEnabled(true);
    for (let i = 0; i < 8; i += 1) {
      writer.emit({ kind: 'request', protocol: 'chat', outcome: 'unchanged', index: i, edits: [] });
      await writer.flush();
    }
    const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    const sizes = await Promise.all(files.map(async (name) => (await stat(join(dir, name))).size));
    assert.ok(files.length > 1);
    assert.ok(sizes.every((size) => size <= 360));
    assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 900);
    assert.equal((await readFile(join(dir, 'customer-records.jsonl'), 'utf8')), 'keep this file');
    assert.equal((await readFile(join(dir, 'unrelated-plugin-debug.jsonl'), 'utf8')), 'also keep');
    await writer.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writer enforces queue limits while one batch is in flight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-debug-queue-'));
  try {
    const writer = new DebugWriter({
      directory: dir,
      runId: 'queue-run',
      limits: { batchCount: 1, queueCount: 64, queueBytes: 1024 * 1024, flushMs: 60_000 },
    });
    writer.setEnabled(true);
    await mkdir(join(dir, '.writer-lock'));
    await writeFile(join(dir, '.writer-lock', 'owner.json'), JSON.stringify({ pid: process.pid, token: 'synthetic-owner' }));
    for (let i = 0; i < 70; i += 1) writer.emit({ kind: 'request', protocol: 'chat', outcome: 'unchanged', index: i, edits: [] });
    const pending = writer.status();
    assert.ok(pending.queuedRequests <= 65);
    assert.ok(pending.droppedRequests >= 5);
    await rm(join(dir, '.writer-lock'), { recursive: true, force: true });
    await writer.flush();
    assert.equal(writer.status().writtenRequests + writer.status().droppedRequests, 70);
    assert.ok(writer.status().droppedRequests >= 5);
    await writer.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('page exposes independent debug controls and status without adding a debug asset route', async () => {
  const html = await readFile(new URL('../page/service.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../page/app.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="debugEnabled"/);
  assert.match(html, /id="debugStatus"/);
  assert.match(html, /id="debugDirectory"/);
  assert.match(app, /fetch\('\.\/api\/debug'/);
  assert.match(app, /调试状态不可用/);
  assert.match(app, /toggle\.checked = previous/);
  assert.match(app, /config_unavailable/);
  assert.match(app, /\['disabled', 'ready', 'degraded', 'config_unavailable'\]/);
  assert.match(app, /validStatus/);
  assert.match(app, /void refreshDebug\?\.\(\)/);
  assert.match(app, /debugStatus/);
});

if (typeof Bun === 'undefined') test('debug API is independent, authenticated and rejects extra fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-debug-api-'));
  const originalBun = globalThis.Bun;
  try {
    let handler;
    globalThis.Bun = { serve: (options) => { handler = options.fetch; return { port: 3479, stop() {} }; } };
    const config = new DebugConfigStore({ dataDir: dir, schedule: () => ({ unref() {} }) });
    const writer = new DebugWriter({ directory: join(dir, 'debug') });
    const service = createService({
      store: { snapshot: () => ({ schemaVersion: 1, status: 'ok' }) },
      configStore: { snapshot: () => ({ sessionDate: true, topicTitle: true, availableAgents: false }) },
      debugConfigStore: config,
      debugWriter: writer,
      token: 'a'.repeat(64),
    });
    const request = (method, body, headers = {}) => handler(new Request('http://127.0.0.1:3479/api/debug', {
      method,
      headers: { host: '127.0.0.1:3479', authorization: `Bearer ${'a'.repeat(64)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    assert.equal((await request('GET', undefined, { authorization: 'Bearer wrong' })).status, 401);
    const initial = await request('GET');
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json()).settings, { enabled: false });
    assert.equal((await request('PUT', { enabled: true, topicTitle: false })).status, 400);
    assert.equal((await request('POST')).status, 405);
    assert.equal((await request('GET', undefined, { origin: 'http://evil.invalid' })).status, 403);
    const saved = await request('PUT', { enabled: true });
    assert.equal(saved.status, 200);
    assert.deepEqual(config.snapshot(), { enabled: true });
    const settings = await handler(new Request('http://127.0.0.1:3479/api/settings', {
      method: 'GET', headers: { host: '127.0.0.1:3479', authorization: `Bearer ${'a'.repeat(64)}` },
    }));
    assert.deepEqual((await settings.json()).settings, { sessionDate: true, topicTitle: true, availableAgents: false });
    await service.stop();
    config.close();
    await writer.close();
  } finally {
    globalThis.Bun = originalBun;
    await rm(dir, { recursive: true, force: true });
  }
});

test('collector failures do not bypass filtering and inserted time guidance is retained in edits', () => {
  const body = { messages: [{ role: 'system', content: 'Current date: 2026-11-12\nCurrent date: 2026-11-12\nstatic' }] };
  const settings = { sessionDate: true, topicTitle: true, availableAgents: false };
  const baseline = filterRequest(body, 'chat', settings);
  const originalByteLength = Buffer.byteLength;
  let failOnce = true;
  Buffer.byteLength = function (...args) {
    if (failOnce) { failOnce = false; throw new Error('synthetic collector fault'); }
    return originalByteLength.apply(this, args);
  };
  let observed;
  const errors = [];
  try {
    observed = filterRequest(body, 'chat', settings, { onEdit() {}, onError: (event) => errors.push(event) });
  } finally {
    Buffer.byteLength = originalByteLength;
  }
  assert.equal(JSON.stringify(observed), JSON.stringify(baseline), 'debug collection failure must not change the filtered payload');
  assert.equal(observed.changed, true);
  assert.equal(errors[0]?.code, 'edit-collection-failed');

  const events = [];
  filterRequest(body, 'chat', settings, { onEdit: (event) => events.push(event) });
  const edits = events.flatMap((event) => event.edits || []);
  assert.equal(edits.filter((edit) => edit.insertedTimeGuidance === true).length, 1,
    'duplicate date lines produce one actual guidance insertion marker');
});

test('redaction removes complete short bearer, generic key, and quoted whitespace password values', () => {
  const cases = [
    ['Authorization: Bearer abc', ['abc']],
    ['key=syntheticKey9', ['syntheticKey9']],
    ['password="syntheticAlpha syntheticBeta"', ['syntheticAlpha', 'syntheticBeta']],
    ['https://example.invalid/path?api_key=syntheticUrlKey', ['syntheticUrlKey']],
  ];
  for (const [input, secrets] of cases) {
    const redacted = redactText(input);
    for (const secret of secrets) assert.equal(redacted.includes(secret), false);
  }
});

test('disabling during an active write counts each accepted record exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-r2-count-'));
  let enterOpen;
  let releaseOpen;
  const opening = new Promise((resolve) => { enterOpen = resolve; });
  const blocked = new Promise((resolve) => { releaseOpen = resolve; });
  const writer = new DebugWriter({ directory: dir, runId: 'r2-count' });
  try {
    writer.setEnabled(true);
    await writer.preparing;
    const { open } = await import('node:fs/promises');
    writer.io.open = async (...args) => {
      enterOpen();
      await blocked;
      return open(...args);
    };
    writer.emit({ kind: 'unchanged', protocol: 'chat', code: 'synthetic-active-write' });
    const draining = writer.flush();
    await opening;
    writer.setEnabled(false);
    releaseOpen();
    await draining;
    const status = writer.status();
    assert.equal(status.writtenRequests + status.droppedRequests, 1);
    assert.equal(status.writtenRequests, 1);
  } finally {
    releaseOpen();
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('lock-wait cancellation drops once and re-enable writes the next generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-r2-generation-'));
  const lockDir = join(dir, '.writer-lock');
  const writer = new DebugWriter({ directory: dir, runId: 'r2-generation', limits: { lockWaitMs: 40 } });
  try {
    writer.setEnabled(true);
    await writer.preparing;
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'synthetic-owner' }), { mode: 0o600 });
    writer.emit({ kind: 'unchanged', protocol: 'chat', code: 'synthetic-locked-record' });
    const waiting = writer.flush();
    const deadline = Date.now() + 100;
    while (writer.status().queuedRequests !== 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(writer.status().queuedRequests, 1);
    writer.setEnabled(false);
    await waiting;
    assert.equal(writer.status().writtenRequests + writer.status().droppedRequests, 1);
    assert.equal(writer.status().droppedRequests, 1);
    await rm(lockDir, { recursive: true, force: true });
    writer.setEnabled(true);
    await writer.preparing;
    writer.emit({ kind: 'unchanged', protocol: 'chat', code: 'synthetic-after-reenable' });
    await writer.flush();
    assert.equal(writer.status().writtenRequests, 1);
    assert.equal(writer.status().droppedRequests, 1);
    assert.equal(writer.status().writtenRequests + writer.status().droppedRequests, 2);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
