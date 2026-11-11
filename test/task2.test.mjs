import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { onRequest, createRequestHook } from '../src/request.hooks.mjs';
import { StatsStore, configureStatsStore, getStatsStore, resetStatsStoreForTests } from '../src/stats-store.mjs';
import { createService } from '../src/service-api.mjs';
import { initializePluginServer, getPluginServerStatus } from '../src/plugin-server-status.mjs';
import { validateStats } from '../src/stats-ui.mjs';
import { FilterConfigStore } from '../src/filter-config.mjs';
import { configureFilterConfig, resetFilterConfigForTests } from '../src/filter-config.mjs';
import { AVAILABLE_AGENTS_GUIDANCE } from '../src/stable-context.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const testDataRoot = join(root, 'test-data', `task2-${process.pid}`);
const dateLine = 'Session date: Tuesday, November 3, 2026';
const target = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>You have access to the Memory Tool.\n<session_context>\n${dateLine}\nConversation language: en\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
const timeGuidance = `<current_time_guidance>\nWhen the task requires the current date or time, use an available time tool or run \`date\` if shell access is available. Use the user's specified timezone; otherwise use the runtime's configured timezone. Do not infer the current date or time from older conversation messages. If the current time cannot be verified, say so.\n</current_time_guidance>`;
const clean = target.replace(`${dateLine}\n`, `${timeGuidance}\n`);

function legacyStats(stats) { const { dateMatchedRequests, dateRemovedLines, topicTitleMatchedRequests, topicTitleRemovedLines, availableAgentsMatchedRequests, availableAgentsReplacedBlocks, timeGuidanceInsertedBlocks, ...legacy } = stats; return legacy; }

async function freshDir(name) {
  const dir = join(testDataRoot, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

test('onRequest filters a supported body without mutating it and records one matched request', async () => {
  const dir = await freshDir('hook');
  const store = new StatsStore({ dataDir: dir, now: () => new Date('2026-11-04T00:00:00.000Z'), autoFlush: false });
  const hook = createRequestHook({ store, now: () => new Date('2026-11-04T00:00:00.000Z') });
  const original = { model: 'fixture-model', messages: [{ role: 'system', content: target }] };
  const result = await hook(original, { protocol: 'chat' });
  assert.equal(result.messages[0].content, clean);
  assert.equal(original.messages[0].content, target);
  assert.deepEqual(legacyStats((await store.snapshot()).stats), {
    processedRequests: 1, matchedRequests: 1, removedLines: 1, unmatchedRequests: 0,
    startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', lastMatchedAt: '2026-11-04T00:00:00.000Z',
  });
  await store.close();
});

test('onRequest counts each supported protocol request once', async () => {
  const dir = await freshDir('protocol-counts');
  const store = new StatsStore({ dataDir: dir, now: () => new Date('2026-11-04T03:20:00.000Z'), autoFlush: false });
  const hook = createRequestHook({ store, now: () => new Date('2026-11-04T03:20:00.000Z') });
  const bodies = [
    ['chat', { messages: [{ role: 'user', content: 'plain' }] }],
    ['responses', { input: [{ type: 'message', role: 'user', content: 'plain' }] }],
    ['anthropic', { messages: [{ role: 'user', content: 'plain' }] }],
    ['gemini', { contents: [{ role: 'user', parts: [{ text: 'plain' }] }] }],
  ];
  for (const [protocol, body] of bodies) assert.equal(await hook(body, { protocol }), undefined);
  const { stats } = store.snapshot();
  assert.deepEqual([stats.processedRequests, stats.matchedRequests, stats.removedLines, stats.unmatchedRequests], [4, 0, 0, 4]);
  const invalidBodies = [
    ['chat', { messages: [{}] }],
    ['chat', { messages: [{ role: 'system', content: 9 }] }],
    ['responses', { input: [{}] }],
    ['responses', { instructions: [], input: [] }],
    ['anthropic', { messages: [{ role: 'tool', content: 'result' }] }],
    ['anthropic', { messages: [{ role: 'user', content: [{}] }] }],
    ['gemini', { contents: [{}] }],
    ['gemini', { contents: [{ role: 'user', parts: [{}] }] }],
  ];
  for (const [protocol, body] of invalidBodies) {
    const snapshotBefore = await store.snapshot();
    assert.equal(await hook(body, { protocol }), undefined);
    await Promise.resolve();
    assert.equal(store.snapshot().stats.processedRequests, snapshotBefore.stats.processedRequests);
  }
  assert.equal(await hook({ messages: [] }, { protocol: 'unknown' }), undefined);
  assert.equal(await hook(null, { protocol: 'chat' }), undefined);
  assert.deepEqual(legacyStats((await store.snapshot()).stats), {
    processedRequests: 4, matchedRequests: 0, removedLines: 0, unmatchedRequests: 4,
    startedAt: '2026-11-04T03:20:00.000Z', updatedAt: '2026-11-04T03:20:00.000Z', lastMatchedAt: null,
  });
  await store.close();
});

test('pure available-agent replacement is returned by the hook and counted by blocks', async () => {
  const dir = await freshDir('pure-agent-replacement');
  const settingsDir = await freshDir('pure-agent-settings');
  const settings = configureFilterConfig({ dataDir: settingsDir });
  try {
    await settings.replace({ sessionDate: false, topicTitle: false, availableAgents: true });
    const store = new StatsStore({ dataDir: dir, autoFlush: false });
    const hook = createRequestHook({ store, now: () => new Date('2026-11-04T03:20:00.000Z') });
    const source = `<agent_management_context><instruction>Instructions</instruction><current_agent id="a">Agent</current_agent><available_models>Models</available_models><available_agents><agent id="a">First</agent><agent id="b">Second</agent></available_agents><available_plugins>Plugins</available_plugins></agent_management_context>`;
    const body = { messages: [{ role: 'system', content: source }] };
    const transformed = await hook(body, { protocol: 'chat' });
    assert.ok(transformed.messages[0].content.includes(AVAILABLE_AGENTS_GUIDANCE));
    assert.equal((await store.snapshot()).stats.matchedRequests, 1);
    assert.equal((await store.snapshot()).stats.removedLines, 0);
    assert.equal((await store.snapshot()).stats.availableAgentsMatchedRequests, 1);
    assert.equal((await store.snapshot()).stats.availableAgentsReplacedBlocks, 1);
    await store.close();
  } finally {
    resetFilterConfigForTests();
    await rm(dir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

async function assertUnmeasurable(protocol, body, label) {
  const dir = await freshDir(`unmeasurable-${label}`);
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const hook = createRequestHook({ store, now: () => new Date('2026-11-04T05:00:00.000Z') });
  const before = structuredClone(body);
  assert.equal(await hook(body, { protocol }), undefined);
  await Promise.resolve();
  assert.deepEqual(body, before);
  assert.deepEqual(legacyStats(store.snapshot().stats), {
    processedRequests: 0, matchedRequests: 0, removedLines: 0, unmatchedRequests: 0,
    startedAt: null, updatedAt: null, lastMatchedAt: null,
  });
  await store.close();
}

for (const [label, protocol, body] of [
  ['chat-empty-member', 'chat', { messages: [{}] }],
  ['chat-null-member', 'chat', { messages: [null] }],
  ['chat-missing-role', 'chat', { messages: [{ content: 'hello' }] }],
  ['chat-missing-content', 'chat', { messages: [{ role: 'user' }] }],
  ['chat-bad-content-type', 'chat', { messages: [{ role: 'user', content: 42 }] }],
  ['chat-empty-text-part', 'chat', { messages: [{ role: 'system', content: [{}] }] }],
  ['responses-empty-member', 'responses', { input: [{}] }],
  ['responses-message-missing-role', 'responses', { input: [{ type: 'message', content: 'hello' }] }],
  ['responses-empty-text-part', 'responses', { input: [{ type: 'message', role: 'user', content: [{}] }] }],
  ['responses-bad-instructions', 'responses', { input: 'hello', instructions: [] }],
  ['anthropic-invalid-role', 'anthropic', { messages: [{ role: 'tool', content: 'result' }] }],
  ['anthropic-empty-member', 'anthropic', { messages: [{}] }],
  ['anthropic-empty-text-part', 'anthropic', { messages: [{ role: 'user', content: [{}] }] }],
  ['gemini-empty-content', 'gemini', { contents: [{}] }],
  ['gemini-empty-part', 'gemini', { contents: [{ role: 'user', parts: [{}] }] }],
  ['gemini-bad-role', 'gemini', { contents: [{ role: 12, parts: [{ text: 'hello' }] }] }],
]) {
  test(`request measurement leaves malformed ${label} uncounted and unchanged`, async () => {
    await assertUnmeasurable(protocol, body, label);
  });
}

test('request measurement accepts valid chat/Responses/Anthropic/Gemini tool histories and continuations', async () => {
  const cases = [
    ['chat', { messages: [
      { role: 'user', content: [{ type: 'text', text: 'find a value' }, { type: 'image_url', image_url: { url: 'https://example.invalid/picture.png' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ id: 1 }) } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'value' },
      { role: 'assistant', content: 'done' },
    ] }],
    ['responses', { previous_response_id: 'resp_previous', input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling tool' }] },
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: JSON.stringify({ id: 1 }) },
      { type: 'function_call_output', call_id: 'call_2', output: 'value' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'done' }] },
    ] }],
    ['responses', { previous_response_id: 'resp_previous' }],
    ['anthropic', { system: [{ type: 'text', text: 'be concise', cache_control: { type: 'ephemeral' } }], messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup', input: { id: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'value' }] },
    ] }],
    ['gemini', { systemInstruction: { parts: [{ text: target }] }, contents: [
      { role: 'user', parts: [{ text: 'find a value' }] },
      { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { id: 1 } } }] },
      { role: 'model', parts: [{ functionResponse: { name: 'lookup', response: { value: 1 } } }] },
    ] }],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [protocol, body] = cases[index];
    const dir = await freshDir(`measurable-valid-${index}`);
    const store = new StatsStore({ dataDir: dir, autoFlush: false });
    const hook = createRequestHook({ store });
    const original = structuredClone(body);
    const result = await hook(body, { protocol });
    if (protocol === 'gemini') {
      assert.equal(result.systemInstruction.parts[0].text, clean);
      assert.equal(body.systemInstruction.parts[0].text, target);
    } else {
      assert.equal(result, undefined);
      assert.deepEqual(body, original);
    }
    await Promise.resolve();
    const stats = store.snapshot().stats;
    assert.equal(stats.processedRequests, 1, `case ${index}`);
    assert.equal(stats.matchedRequests, protocol === 'gemini' ? 1 : 0, `case ${index}`);
    assert.equal(stats.unmatchedRequests, protocol === 'gemini' ? 0 : 1, `case ${index}`);
    await store.close();
  }
});

test('unknown nested content parts pass through but are not counted as measurable', async () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'future_payload', payload: { value: 1 } }] }] };
  await assertUnmeasurable('chat', body, 'unknown-extension-part');
});

test('onRequest returns undefined for an unchanged supported body and increments unmatched once', async () => {
  const dir = await freshDir('unmatched');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const hook = createRequestHook({ store });
  const body = { messages: [{ role: 'user', content: target }] };
  assert.equal(await hook(body, { protocol: 'chat' }), undefined);
  assert.equal((await store.snapshot()).stats.unmatchedRequests, 1);
  await store.close();
});

test('onRequest ignores unsupported and malformed request inputs without counting them', async () => {
  const dir = await freshDir('invalid-hook');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const hook = createRequestHook({ store });
  assert.equal(await hook({ messages: [] }, { protocol: 'unknown' }), undefined);
  assert.equal(await hook(null, { protocol: 'chat' }), undefined);
  assert.deepEqual(legacyStats((await store.snapshot()).stats), {
    processedRequests: 0, matchedRequests: 0, removedLines: 0, unmatchedRequests: 0,
    startedAt: null, updatedAt: null, lastMatchedAt: null,
  });
  await store.close();
});

test('onRequest fail-opens an unexpected matcher error without logging or leaking it', async () => {
  const dir = await freshDir('matcher-error');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const body = { messages: [{ role: 'system', content: target }] };
  const broken = { filterRequest() { throw new Error('fixture secret body and key'); } };
  const hook = createRequestHook({ store, protocols: broken });
  assert.equal(await hook(body, { protocol: 'chat' }), undefined);
  assert.equal((await store.snapshot()).stats.processedRequests, 1);
  assert.equal((await store.snapshot()).stats.matchedRequests, 0);
  await store.close();
});

test('parallel requests aggregate exact processed, matched and removed-line counts', async () => {
  const dir = await freshDir('concurrent-hook');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const hook = createRequestHook({ store });
  const matched = { messages: [{ role: 'system', content: `${target}\n${target}` }] };
  const misses = { messages: [{ role: 'user', content: target }] };
  await Promise.all(Array.from({ length: 80 }, (_, i) => hook(i % 2 ? matched : misses, { protocol: 'chat' })));
  const stats = (await store.snapshot()).stats;
  assert.equal(stats.processedRequests, 80);
  assert.equal(stats.matchedRequests, 40);
  assert.equal(stats.removedLines, 80);
  assert.equal(stats.unmatchedRequests, 40);
  await store.close();
});

test('lock failures keep pending, yield the event loop and retry without manual flush', async () => {
  const dir = await freshDir('lock-retry-auto');
  const { Database } = await import('bun:sqlite');
  const dbFile = join(dir, 'stats.sqlite');
  const seed = new Database(dbFile);
  seed.exec('PRAGMA journal_mode=WAL; CREATE TABLE stats (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, processed_requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, removed_lines INTEGER NOT NULL, started_at TEXT, updated_at TEXT, last_matched_at TEXT)');
  seed.run('INSERT INTO stats VALUES (1,1,0,0,0,NULL,NULL,NULL)');
  seed.close();
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal(store.snapshot().status, 'ok');
  await store.close();

  const ready = join(dir, 'locked');
  const release = join(dir, 'release');
  const locker = spawn('bun', ['-e', `import {Database} from 'bun:sqlite'; import {writeFileSync,existsSync} from 'node:fs'; const db=new Database(${JSON.stringify(dbFile)}); db.exec('BEGIN IMMEDIATE'); writeFileSync(${JSON.stringify(ready)},'1',{mode:0o600}); const start=Date.now(); while(!existsSync(${JSON.stringify(release)})){if(Date.now()-start>10000)process.exit(3); await new Promise(r=>setTimeout(r,5))} db.exec('COMMIT'); db.close()`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolveExit, rejectExit) => {
    locker.once('error', rejectExit);
    locker.once('exit', (code) => code === 0 ? resolveExit() : rejectExit(new Error(`locker exit ${code}`)));
  });
  const startWait = Date.now();
  while (Date.now() - startWait < 5000) {
    try { await stat(ready); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
  }
  await stat(ready);

  const runtime = new StatsStore({ dataDir: dir, autoFlush: false });
  const hook = createRequestHook({ store: runtime, now: () => new Date('2026-11-04T04:30:00.000Z') });
  const hookBody = { messages: [{ role: 'system', content: target }] };
  const hookStartedAt = performance.now();
  const transformed = await hook(hookBody, { protocol: 'chat' });
  const hookMs = performance.now() - hookStartedAt;
  await Promise.resolve();
  assert.equal(transformed.messages[0].content, clean);
  assert.ok(hookMs < 20, `cold-store request hook took ${hookMs}ms under SQLite lock`);
  assert.equal(runtime.db, null, 'request hook must not open or initialize SQLite');
  assert.equal(runtime.pending.processedRequests, 1);

  let heartbeatAt = null;
  const heartbeatScheduledAt = performance.now();
  setTimeout(() => { heartbeatAt = performance.now(); }, 20);
  const flushStartedAt = performance.now();
  const firstFlush = await runtime.flush();
  const firstFlushMs = performance.now() - flushStartedAt;
  assert.equal(firstFlush.status, 'degraded');
  assert.ok(firstFlushMs < 250, `single bounded flush attempt took ${firstFlushMs}ms`);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(heartbeatAt !== null, 'event-loop heartbeat did not run while lock was held');
  const heartbeatDelayMs = heartbeatAt - heartbeatScheduledAt;
  assert.equal(runtime.pending.processedRequests, 1);
  assert.equal(runtime.snapshot().status, 'degraded');

  const releasedAt = performance.now();
  writeFileSync(release, '1', { mode: 0o600 });
  await exit;
  const deadline = Date.now() + 5000;
  while (runtime.pending.processedRequests !== 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const autoRecoveryMs = performance.now() - releasedAt;
  const recovered = runtime.snapshot();
  assert.equal(runtime.pending.processedRequests, 0);
  assert.equal(recovered.status, 'ok');
  assert.deepEqual(legacyStats(recovered.stats), {
    processedRequests: 1, matchedRequests: 1, removedLines: 1, unmatchedRequests: 0,
    startedAt: '2026-11-04T04:30:00.000Z', updatedAt: '2026-11-04T04:30:00.000Z', lastMatchedAt: '2026-11-04T04:30:00.000Z',
  });
  console.log(`LOCK_METRICS=${JSON.stringify({ hookMs: +hookMs.toFixed(3), firstFlushMs: +firstFlushMs.toFixed(3), heartbeatDelayMs: +heartbeatDelayMs.toFixed(3), autoRecoveryMs: +autoRecoveryMs.toFixed(3) })}`);
  await runtime.close();
});

test('snapshot includes same-host pending data once and concurrent record during flush survives', async () => {
  const dir = await freshDir('flush-concurrent-record');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal(store.snapshot().status, 'ok');
  store.record({ matched: true, removedLines: 2, at: '2026-11-04T04:00:00.000Z' });
  const db = store.db;
  const originalImmediate = db.transaction;
  db.transaction = (fn) => {
    const transaction = originalImmediate.call(db, fn);
    const callable = (...args) => transaction(...args);
    callable.immediate = (...args) => {
      const result = transaction.immediate(...args);
      store.record({ matched: false, removedLines: 0, at: '2026-11-04T04:00:01.000Z' });
      return result;
    };
    return callable;
  };
  assert.equal((await store.flush()).status, 'ok');
  store.db = db;
  store.db.transaction = originalImmediate;
  const snapshot = store.snapshot();
  assert.deepEqual(legacyStats(snapshot.stats), {
    processedRequests: 2, matchedRequests: 1, removedLines: 2, unmatchedRequests: 1,
    startedAt: '2026-11-04T04:00:00.000Z', updatedAt: '2026-11-04T04:00:01.000Z', lastMatchedAt: '2026-11-04T04:00:00.000Z',
  });
  assert.equal(store.pending.processedRequests, 1);
  assert.equal((await store.flush()).status, 'ok');
  assert.equal(store.snapshot().stats.processedRequests, 2);
  await store.close();
});

test('multiple guidance blocks on one request persist and reopen without degrading statistics', async () => {
  const dir = await freshDir('multiple-guidance-blocks');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal(store.record({
    matched: true,
    removedLines: 2,
    dateRemovedLines: 2,
    timeGuidanceInsertedBlocks: 2,
    at: '2026-11-04T04:00:00.000Z',
  }), true);
  assert.equal(store.snapshot().status, 'ok');
  assert.equal(store.snapshot().stats.timeGuidanceInsertedBlocks, 2);
  assert.equal((await store.flush()).status, 'ok');
  await store.close();
  const reopened = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal(reopened.snapshot().status, 'ok');
  assert.equal(reopened.snapshot().stats.timeGuidanceInsertedBlocks, 2);
  await reopened.close();
});

test('flush followed by snapshot does not double count pending data', async () => {
  const dir = await freshDir('flush-snapshot');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  store.record({ removedLines: 2, matched: true, at: '2026-11-04T01:00:00.000Z' });
  assert.equal((await store.flush()).status, 'ok');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.stats.processedRequests, 1);
  assert.equal(snapshot.stats.matchedRequests, 1);
  assert.equal(snapshot.stats.removedLines, 2);
  assert.equal(snapshot.stats.unmatchedRequests, 0);
  await store.close();
});

test('scheduled flush uses an injectable scheduler with the intended 30 second period', async () => {
  const dir = await freshDir('schedule');
  let callback;
  const store = new StatsStore({ dataDir: dir, autoFlush: true, flushIntervalMs: 30_000,
    schedule(fn, ms) { assert.equal(ms, 30_000); callback = fn; return { unref() {} }; }, cancelSchedule() {},
  });
  await store.record({ removedLines: 0, matched: false, at: '2026-11-04T02:00:00.000Z' });
  await callback();
  assert.equal((await store.snapshot()).stats.processedRequests, 1);
  await store.close();
});

test('four fresh database first-open races and three seeded writer races merge exact increments', async () => {
  const childScript = join(root, 'test', 'fixtures', 'stats-writer.bun.mjs');
  const runChild = (args) => new Promise((resolveRun, reject) => {
    const proc = spawn('bun', [childScript, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.setEncoding('utf8').on('data', (value) => { out += value; });
    proc.stderr.setEncoding('utf8').on('data', (value) => { err += value; });
    proc.once('error', reject);
    proc.once('exit', (code) => code === 0 ? resolveRun({ out, err }) : reject(new Error(`Bun child exit ${code}: ${err}`)));
  });
  const iterations = [];
  for (let round = 0; round < 8; round += 1) {
    const dir = await freshDir(`writers-${round}`);
    if (round >= 5) {
      const { Database } = await import('bun:sqlite');
      const db = new Database(join(dir, 'stats.sqlite'));
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE stats (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, processed_requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, removed_lines INTEGER NOT NULL, started_at TEXT, updated_at TEXT, last_matched_at TEXT)');
      db.run('INSERT INTO stats VALUES (1,1,0,0,0,NULL,NULL,NULL)');
      db.close();
    }
    const ready = Array.from({ length: 4 }, (_, i) => join(dir, `ready-${i}`));
    const go = join(dir, 'go');
    const workers = ready.map((file, i) => runChild([dir, '25', `2026-11-04T00:00:0${round}.${String(i).padStart(3, '0')}Z`, file, go, `round-${round}-worker-${i}`]));
    const readyStart = Date.now();
    while (Date.now() - readyStart < 10_000) {
      try { await Promise.all(ready.map((file) => stat(file))); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
    }
    await Promise.all(ready.map((file) => stat(file)));
    writeFileSync(go, 'go', { mode: 0o600 });
    const results = await Promise.all(workers);
    const finalStore = new StatsStore({ dataDir: dir, autoFlush: false });
    const { stats, status } = finalStore.snapshot();
    assert.equal(status, 'ok', `round ${round}`);
    assert.deepEqual({ processed: stats.processedRequests, matched: stats.matchedRequests, removed: stats.removedLines, unmatched: stats.unmatchedRequests }, { processed: 100, matched: 52, removed: 52, unmatched: 48 }, `round ${round}`);
    assert.deepEqual([stats.startedAt, stats.updatedAt, stats.lastMatchedAt], [`2026-11-04T00:00:0${round}.000Z`, `2026-11-04T00:00:0${round}.003Z`, `2026-11-04T00:00:0${round}.003Z`], `round ${round} UTC merge`);
    iterations.push({ round, fresh: round < 5, childStatuses: results.map(({ out }) => JSON.parse(out.trim()).status), stats: { processedRequests: stats.processedRequests, matchedRequests: stats.matchedRequests, removedLines: stats.removedLines } });
    await finalStore.close();
  }
  console.log(`MULTIPROCESS_ROUNDS=${JSON.stringify(iterations)}`);
});

test('store reopens committed stats and preserves owner-only database permissions', async () => {
  const dir = await freshDir('reopen');
  const childScript = join(root, 'test', 'fixtures', 'stats-writer.bun.mjs');
  const runChild = (args) => new Promise((resolveRun, reject) => {
    const proc = spawn('bun', [childScript, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.setEncoding('utf8').on('data', (v) => { out += v; });
    proc.stderr.setEncoding('utf8').on('data', (v) => { err += v; });
    proc.once('error', reject);
    proc.once('exit', (code) => code === 0 ? resolveRun({ out, err }) : reject(new Error(`Bun child exited ${code}: ${err}`)));
  });
  const ready = Array.from({ length: 4 }, (_, i) => join(dir, `ready-${i}`));
  const go = join(dir, 'go');
  const workers = ready.map((readyFile, i) => runChild([dir, '25', `2024-11-04T00:00:00.${String(i * 10).padStart(3, '0')}Z`, readyFile, go, `worker-${i}`]));
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try { await Promise.all(ready.map((file) => stat(file))); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
  }
  await Promise.all(ready.map((file) => stat(file)));
  writeFileSync(go, 'go', { mode: 0o600 });
  await Promise.all(workers);
  const finalStore = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.deepEqual(legacyStats(finalStore.snapshot().stats), {
    processedRequests: 100, matchedRequests: 52, removedLines: 52, unmatchedRequests: 48,
    startedAt: '2024-11-04T00:00:00.000Z', updatedAt: '2024-11-04T00:00:00.030Z', lastMatchedAt: '2024-11-04T00:00:00.030Z',
  });
  await finalStore.close();
});

test('seeded database four-writer competition preserves each committed batch', async () => {
  const dir = await freshDir('seeded-multiprocess');
  const { Database } = await import('bun:sqlite');
  const db = new Database(join(dir, 'stats.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE stats (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, processed_requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, removed_lines INTEGER NOT NULL, started_at TEXT, updated_at TEXT, last_matched_at TEXT)');
  db.run('INSERT INTO stats VALUES (1,1,0,0,0,NULL,NULL,NULL)');
  db.close();
  const childScript = join(root, 'test', 'fixtures', 'stats-writer.bun.mjs');
  const runChild = (args) => new Promise((resolveRun, reject) => {
    const proc = spawn('bun', [childScript, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.setEncoding('utf8').on('data', (v) => { out += v; });
    proc.stderr.setEncoding('utf8').on('data', (v) => { err += v; });
    proc.once('error', reject);
    proc.once('exit', (code) => code === 0 ? resolveRun({ out, err }) : reject(new Error(`Bun child exited ${code}: ${err}`)));
  });
  const ready = Array.from({ length: 4 }, (_, i) => join(dir, `ready-${i}`));
  const go = join(dir, 'go');
  const workers = ready.map((file, i) => runChild([dir, '25', `2026-11-04T00:00:00.${String(i).padStart(3, '0')}Z`, file, go, `seeded-${i}`]));
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try { await Promise.all(ready.map((file) => stat(file))); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
  }
  await Promise.all(ready.map((file) => stat(file)));
  writeFileSync(go, 'go', { mode: 0o600 });
  const results = await Promise.all(workers);
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const { status, stats } = store.snapshot();
  assert.equal(status, 'ok');
  assert.deepEqual([stats.processedRequests, stats.matchedRequests, stats.removedLines], [100, 52, 52]);
  console.log(`SEEDED_WRITER_STATUSES=${JSON.stringify(results.map(({ out }) => JSON.parse(out.trim()).status))}`);
  await store.close();
});

test('store reopens committed stats and preserves owner-only database permissions', async () => {
  const dir = await freshDir('reopen');
  const first = new StatsStore({ dataDir: dir, autoFlush: false });
  first.record({ matched: true, removedLines: 3, at: '2026-11-04T03:00:00.000Z' });
  await first.flush();
  await first.close();
  const dbStat = await stat(join(dir, 'stats.sqlite'));
  assert.equal(dbStat.mode & 0o777, 0o600);
  const second = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal((await second.snapshot()).stats.removedLines, 3);
  await second.close();
});

test('stats singleton uses host directory and ignores reconfiguration attempts', async () => {
  const prior = resetStatsStoreForTests();
  await prior?.close();
  const directory = join(testDataRoot, 'host-config-root');
  const first = configureStatsStore({ directory, autoFlush: false });
  const second = configureStatsStore({ directory: join(testDataRoot, 'different-root'), autoFlush: false });
  assert.equal(first, second);
  assert.equal(getStatsStore(), first);
  first.record({ matched: false, removedLines: 0, at: '2026-11-04T03:30:00.000Z' });
  assert.equal((await first.flush()).status, 'ok');
  const dbFile = join(directory, 'session-date-filter', 'stats.sqlite');
  assert.equal((await stat(dbFile)).mode & 0o777, 0o600);
  assert.equal((await first.snapshot()).stats.processedRequests, 1);
  await first.close();
  await resetStatsStoreForTests();
});

test('corrupt databases and unknown schema degrade without overwrite', async () => {
  const corruptDir = await freshDir('corrupt');
  const corruptPath = join(corruptDir, 'stats.sqlite');
  await writeFile(corruptPath, 'not a sqlite database', { mode: 0o600 });
  const before = await readFile(corruptPath);
  const corrupt = new StatsStore({ dataDir: corruptDir, autoFlush: false });
  assert.equal((await corrupt.snapshot()).status, 'degraded');
  assert.deepEqual(await readFile(corruptPath), before);
  await corrupt.close();

  const schemaDir = await freshDir('unknown-schema');
  const seed = new StatsStore({ dataDir: schemaDir, autoFlush: false });
  seed.record({ matched: false, removedLines: 0, at: '2026-11-04T00:00:00.000Z' });
  await seed.flush();
  await seed.close();
  const { Database } = await import('bun:sqlite');
  const db = new Database(join(schemaDir, 'stats.sqlite'));
  db.run('UPDATE stats SET schema_version = 99 WHERE id = 1');
  db.close();
  const prior = await readFile(join(schemaDir, 'stats.sqlite'));
  const unknown = new StatsStore({ dataDir: schemaDir, autoFlush: false });
  assert.equal((await unknown.snapshot()).status, 'degraded');
  assert.deepEqual(await readFile(join(schemaDir, 'stats.sqlite')), prior);
  await unknown.close();
});

test('invalid store directory degrades safely and does not block request processing', async () => {
  const parent = join(testDataRoot, 'invalid-dir');
  await rm(parent, { recursive: true, force: true });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const notDirectory = join(parent, 'file');
  await writeFile(notDirectory, 'x', { mode: 0o600 });
  const store = new StatsStore({ dataDir: notDirectory, autoFlush: false });
  const hook = createRequestHook({ store });
  const body = { messages: [{ role: 'system', content: target }] };
  const result = await hook(body, { protocol: 'chat' });
  assert.equal(result.messages[0].content, clean);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.stats.processedRequests, 1);
  assert.equal(snapshot.stats.matchedRequests, 1);
  assert.equal(JSON.stringify(snapshot).includes(notDirectory), false);
  await store.close();
});

test('HTTP service is read-only, allows only null/same origin and hides storage errors', async () => {
  const dir = await freshDir('service');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  store.record({ matched: true, removedLines: 1, at: '2026-11-04T04:00:00.000Z' });
  const service = createService({ store, port: 0 });
  try {
    const address = service.server.url;
    assert.equal(address.hostname, '127.0.0.1');
    const stats = await fetch(new URL('/api/stats', address), { headers: { Origin: 'null' } });
    assert.equal(stats.status, 200);
    assert.equal(stats.headers.get('access-control-allow-origin'), 'null');
    const sameOrigin = await fetch(new URL('/api/stats', address), { headers: { Origin: `http://127.0.0.1:${address.port}` } });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), `http://127.0.0.1:${address.port}`);
    const json = await stats.json();
    assert.deepEqual(Object.keys(json.stats).sort(), ['lastMatchedAt', 'matchedRequests', 'processedRequests', 'removedLines', 'startedAt', 'unmatchedRequests', 'updatedAt', 'dateMatchedRequests', 'dateRemovedLines', 'topicTitleMatchedRequests', 'topicTitleRemovedLines', 'availableAgentsMatchedRequests', 'availableAgentsReplacedBlocks', 'timeGuidanceInsertedBlocks'].sort());
    const options = await fetch(new URL('/api/stats', address), { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    const badPathPreflight = await fetch(new URL('/not-an-api?path=/secret', address), { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(badPathPreflight.status, 404);
    assert.equal(badPathPreflight.headers.get('access-control-allow-origin'), null);
    assert.equal(badPathPreflight.headers.get('access-control-allow-methods'), null);
    const badQueryPreflight = await fetch(new URL('/api/stats?file=/secret', address), { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(badQueryPreflight.status, 404);
    assert.equal(badQueryPreflight.headers.get('access-control-allow-origin'), null);
    assert.equal(badQueryPreflight.headers.get('access-control-allow-methods'), null);
    const badMethodPreflight = await fetch(new URL('/api/stats', address), { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(badMethodPreflight.status, 405);
    const post = await fetch(new URL('/api/stats', address), { method: 'POST' });
    assert.ok([404, 405].includes(post.status));
    const badHost = await fetch(new URL('/api/stats', address), { headers: { Host: `localhost:${address.port}` } });
    assert.equal(badHost.status, 403);
    const badOrigin = await fetch(new URL('/api/stats', address), { headers: { Origin: 'https://attacker.invalid' } });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.text()).includes(dir), false);
    const hidden = await fetch(new URL('/private/path?file=/secret', address));
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.text()).includes('/secret'), false);
  } finally {
    await service.stop();
    await store.close();
  }
});

test('service fails safely when database is unavailable and emits only generic degraded status', async () => {
  const parent = join(testDataRoot, 'service-bad-dir');
  await rm(parent, { recursive: true, force: true });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const file = join(parent, 'file');
  await writeFile(file, 'x', { mode: 0o600 });
    const store = new StatsStore({ dataDir: file, autoFlush: false });
  const service = createService({ store, port: 0 });
  try {
    const response = await fetch(new URL('/api/stats', service.server.url));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).status, 'degraded');
    assert.equal(text.includes(file), false);
    assert.equal(text.includes('SQLITE'), false);
  } finally {
    await service.stop();
    await store.close();
  }
});

test('service listener failures are typed only for known bind errors and unknown startup errors propagate', async () => {
  const dir = await freshDir('service-listen-errors');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const owner = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('owned') });
  try {
    assert.throws(() => createService({ store, port: -1 }), TypeError, 'parameter validation stays outside the listener error classification');
    assert.throws(() => createService({ store, port: owner.port }), (error) => {
      assert.equal(error?.name, 'ServiceListenError');
      assert.equal(error?.reasonCode, 'address-in-use');
      assert.equal(error?.message, 'Statistics listener could not be started.');
      assert.equal(error.message.includes(String(owner.port)), false);
      return true;
    });
  } finally {
    owner.stop(true);
    await store.close();
  }
});

test('plugin server propagates unknown listener and snapshot failures without misclassification or leaks', async () => {
  const fixture = join(root, 'test', 'fixtures', 'server-error-boundaries.bun.mjs');
  for (const scenario of ['unknown-error', 'type-error', 'snapshot-error', 'status-error']) {
    const result = await new Promise((resolveRun, reject) => {
      const proc = spawn('bun', [fixture, scenario], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      proc.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      proc.once('error', reject);
      proc.once('exit', (code) => resolveRun({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, `${scenario} fixture failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${scenario}: passed`));
  }
});

test('plugin server bind failure degrades statistics but keeps the request hook loaded', async () => {
  const entry = await import('../index.mjs');
  const priorStore = resetStatsStoreForTests();
  await priorStore?.close();
  const configurationRoot = await freshDir('server-bind-degraded');
  const owner = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('owned') });
  const warnings = [];
  const input = {
    directory: configurationRoot,
    client: { app: { log: async (options) => { warnings.push(options?.body ?? options); } } },
  };
  const options = { sessionDateFilterPort: owner.port };
  try {
    await assert.doesNotReject(() => entry.default.server(input, options));
    assert.equal(typeof entry.getPluginServerStatus, 'function');
    assert.deepEqual(entry.getPluginServerStatus(), {
      state: 'unavailable', listenerAvailable: false, storageStatus: 'ok', reason: 'listener-unavailable',
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warn');
    assert.equal(warnings[0].message, 'Statistics listener unavailable; request filtering remains active.');
    assert.equal(JSON.stringify(warnings).includes(String(owner.port)), false);

    const hook = await import('../src/request.hooks.mjs');
    const request = { messages: [{ role: 'system', content: target }] };
    const transformed = await hook.onRequest(request, { protocol: 'chat' });
    assert.equal(transformed.messages[0].content, clean);
    await Promise.resolve();
    const stats = getStatsStore().snapshot().stats;
    assert.deepEqual([stats.processedRequests, stats.matchedRequests, stats.removedLines], [1, 1, 1]);
    assert.equal(entry.getPluginServerStatus().listenerAvailable, false);
    assert.equal((await fetch(`http://127.0.0.1:${owner.port}/`)).status, 200);
    await entry.default.server(input, options);
    assert.equal(entry.getPluginServerStatus().listenerAvailable, false);
    assert.equal(warnings.length, 1, 'startup warning is emitted once');
  } finally {
    owner.stop(true);
    const store = resetStatsStoreForTests();
    await store?.close();
  }
});

test('controller retry window is bounded under a real writer lock and resumes on the next period', async () => {
  const dir = await freshDir('controller-retry-bounded');
  const dbFile = join(dir, 'stats.sqlite');
  const seed = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal(seed.snapshot().status, 'ok');
  await seed.close();

  const ready = join(dir, 'controller-lock-ready');
  const release = join(dir, 'controller-lock-release');
  const locker = spawn('bun', ['-e', `import {Database} from 'bun:sqlite'; import {writeFileSync,existsSync} from 'node:fs'; const db=new Database(${JSON.stringify(dbFile)}); db.exec('BEGIN IMMEDIATE'); writeFileSync(${JSON.stringify(ready)},'1'); const start=Date.now(); while(!existsSync(${JSON.stringify(release)})){if(Date.now()-start>10000)process.exit(3); await new Promise(r=>setTimeout(r,5))} db.exec('COMMIT'); db.close()`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const lockerExit = new Promise((resolveExit, reject) => {
    locker.once('error', reject);
    locker.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`controller locker exit ${code}`)));
  });
  let periodic;
  let attempts = 0;
  const store = new StatsStore({ dataDir: dir, autoFlush: true,
    schedule(fn) { periodic = fn; return { unref() {} }; }, cancelSchedule() {},
  });
  const realSetTimeout = globalThis.setTimeout;
  const actualRetryDelays = [];
  const configuredDelays = new Set([25, 75, 200, 500, 1000]);
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (configuredDelays.has(ms)) {
      actualRetryDelays.push(ms);
      return realSetTimeout(fn, 5, ...args);
    }
    return realSetTimeout(fn, ms, ...args);
  };
  try {
    const readyStart = Date.now();
    while (Date.now() - readyStart < 5000) {
      try { await stat(ready); break; } catch { await new Promise((r) => realSetTimeout(r, 5)); }
    }
    await stat(ready);
    const originalFlush = store.flush.bind(store);
    store.flush = (...args) => { attempts += 1; return originalFlush(...args); };
    store.record({ matched: true, removedLines: 1, at: '2026-11-07T12:34:56.000Z' });
    assert.equal(store.db, null, 'first locked flush starts before this store has opened SQLite');
    assert.equal((await store.flush()).status, 'degraded');
    const exhaustedBy = Date.now() + 2500;
    while (attempts < 6 && Date.now() < exhaustedBy) await new Promise((r) => realSetTimeout(r, 10));
    assert.deepEqual(actualRetryDelays, [25, 75, 200, 500, 1000], 'finite retries honor the configured backoff ladder');
    const attemptsAtExhaustion = attempts;
    assert.ok(attemptsAtExhaustion >= 5 && attemptsAtExhaustion <= 6, `finite retry attempt count: ${attemptsAtExhaustion}`);
    assert.equal(Number.isSafeInteger(store.retryCount), true);
    assert.equal(store.retryCount, 5);
    assert.equal(store.pending.processedRequests, 1, 'failed attempts retain pending data');
    assert.equal(store.failed, true);
    await new Promise((r) => realSetTimeout(r, 50));
    assert.equal(attempts, attemptsAtExhaustion, 'exhausted retry window must not self-schedule another attempt');

    const attemptsBeforeRecovery = attempts;
    writeFileSync(release, '1', { mode: 0o600 });
    await lockerExit;
    periodic();
    const recoveredBy = Date.now() + 3000;
    while (store.pending.processedRequests !== 0 && Date.now() < recoveredBy) await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(attempts, attemptsBeforeRecovery + 1, 'regular period retries once after the lock is released');
    assert.equal(store.pending.processedRequests, 0, 'regular period retries and commits after the real lock is released');
    assert.deepEqual([store.snapshot().stats.processedRequests, store.snapshot().stats.matchedRequests, store.snapshot().stats.removedLines], [1, 1, 1]);
    assert.equal(store.snapshot().status, 'ok');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    try { writeFileSync(release, '1', { mode: 0o600 }); } catch {}
    if (locker.exitCode === null) locker.kill();
    await lockerExit.catch(() => {});
    await store.close();
  }
});

test('corrupt stored aggregate invariants degrade and flush never overwrites the bad row', async () => {
  const corruptions = [
    ['removed below matched', 'UPDATE stats SET removed_lines=0 WHERE id=1'],
    ['date hits above date lines', 'UPDATE stats SET date_matched_requests=1,date_removed_lines=0 WHERE id=1'],
    ['title hits above title lines', 'UPDATE stats SET topic_title_matched_requests=1,topic_title_removed_lines=0 WHERE id=1'],
    ['removed without any match', 'UPDATE stats SET matched_requests=0, removed_lines=3, last_matched_at=NULL WHERE id=1'],
    ['processed has no start time', 'UPDATE stats SET started_at=NULL WHERE id=1'],
    ['processed has no update time', 'UPDATE stats SET updated_at=NULL WHERE id=1'],
    ['matched has no last-match time', 'UPDATE stats SET last_matched_at=NULL WHERE id=1'],
    ['unmatched row retains last-match time', 'UPDATE stats SET matched_requests=0, removed_lines=0 WHERE id=1'],
    ['zero processed row retains timestamps', 'UPDATE stats SET processed_requests=0, matched_requests=0, removed_lines=0 WHERE id=1'],
    ['noncanonical UTC date', "UPDATE stats SET started_at='2026-02-30T00:00:00.000Z' WHERE id=1"],
    ['last match is later than aggregate update', "UPDATE stats SET updated_at='2026-11-07T12:34:55.000Z' WHERE id=1"],
  ];
  for (const [label, mutation] of corruptions) {
    const dir = await freshDir(`controller-corrupt-${label.replaceAll(' ', '-')}`);
    const seed = new StatsStore({ dataDir: dir, autoFlush: false });
    seed.record({ matched: true, removedLines: 3, at: '2026-11-07T12:34:56.000Z' });
    assert.equal((await seed.flush()).status, 'ok');
    await seed.close();
    const dbFile = join(dir, 'stats.sqlite');
    const { Database } = await import('bun:sqlite');
    const corrupting = new Database(dbFile);
    corrupting.run(mutation);
    const before = corrupting.query('SELECT * FROM stats WHERE id=1').get();
    corrupting.close();

    const store = new StatsStore({ dataDir: dir, autoFlush: false });
    store.record({ matched: false, removedLines: 0, at: '2026-11-07T12:34:57.000Z' });
    assert.equal((await store.flush()).status, 'degraded', `${label}: flush must reject the corrupt aggregate`);
    assert.equal(store.pending.processedRequests, 1, `${label}: pending increment must remain uncommitted`);
    assert.equal(store.snapshot().status, 'degraded', `${label}: corruption is not healthy`);
    const verify = new Database(dbFile, { readonly: true });
    assert.deepEqual(verify.query('SELECT * FROM stats WHERE id=1').get(), before, `${label}: stored row must remain unchanged`);
    verify.close();
    await store.close();
  }
});

test('record and commit range failures are atomic and retain exact pending data', async () => {
  const dir = await freshDir('controller-range-atomic');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  store.record({ matched: true, removedLines: Number.MAX_SAFE_INTEGER, at: '2026-11-07T12:34:56.000Z' });
  const before = structuredClone(store.pending);
  assert.throws(() => store.record({ matched: true, removedLines: 1, at: '2026-11-07T12:34:57.000Z' }), /aggregate range exceeded/);
  assert.deepEqual(store.pending, before, 'record overflow leaves every pending field unchanged');
  assert.equal(store.record({ matched: 'yes', removedLines: 0, at: '2026-11-07T12:34:57.000Z' }), false);
  assert.deepEqual(store.pending, before, 'invalid event leaves every pending field unchanged');
  assert.equal(store.record({ matched: true, removedLines: 1, at: 'not-a-UTC-timestamp' }), false);
  assert.deepEqual(store.pending, before, 'invalid timestamp leaves every pending field unchanged');
  await store.close();

  const seed = new StatsStore({ dataDir: join(dir, 'committed-overflow'), autoFlush: false });
  seed.record({ matched: true, removedLines: Number.MAX_SAFE_INTEGER, at: '2026-11-07T12:34:56.000Z' });
  assert.equal((await seed.flush()).status, 'ok');
  seed.db.run('UPDATE stats SET processed_requests=? WHERE id=1', Number.MAX_SAFE_INTEGER);
  const committedBefore = seed.db.query('SELECT * FROM stats WHERE id=1').get();
  assert.equal(seed.record({ matched: false, removedLines: 0, at: '2026-11-07T12:34:57.000Z' }), true);
  const commitDelta = structuredClone(seed.pending);
  assert.equal((await seed.flush()).status, 'degraded', 'SQL aggregate overflow must not be silently saturated');
  assert.deepEqual(seed.pending, commitDelta, 'failed transaction retains the full pending delta');
  assert.equal(seed.failed, true);
  const { Database } = await import('bun:sqlite');
  const verifyCommitted = new Database(join(seed.dataDir, 'stats.sqlite'), { readonly: true, safeIntegers: true });
  assert.deepEqual(verifyCommitted.query('SELECT * FROM stats WHERE id=1').get(), committedBefore);
  verifyCommitted.close();
  const afterSnapshot = seed.snapshot();
  assert.equal(afterSnapshot.status, 'degraded');
  assert.deepEqual([afterSnapshot.stats.processedRequests, afterSnapshot.stats.matchedRequests, afterSnapshot.stats.removedLines], [1, 0, 0]);
  await seed.close();
});

test('snapshot marks pending merge overflow degraded and returns safe committed aggregate', async () => {
  const dir = await freshDir('controller-snapshot-range');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const at = '2026-11-07T12:34:56.000Z';
  try {
    store.record({ matched: false, removedLines: 0, at });
    assert.equal((await store.flush()).status, 'ok');
    store.db.run('UPDATE stats SET processed_requests=? WHERE id=1', Number.MAX_SAFE_INTEGER);
    const beforeRow = store.db.query('SELECT * FROM stats WHERE id=1').get();
    assert.equal(store.record({ matched: false, removedLines: 0, at: '2026-11-07T12:34:57.000Z' }), true);
    const pendingBefore = structuredClone(store.pending);

    const snapshot = store.snapshot();
    assert.equal(snapshot.status, 'degraded', 'unsafe committed+pending merge cannot be reported healthy');
    assert.deepEqual(snapshot.stats, {
      processedRequests: Number.MAX_SAFE_INTEGER, matchedRequests: 0, removedLines: 0, unmatchedRequests: Number.MAX_SAFE_INTEGER,
      startedAt: at, updatedAt: at, lastMatchedAt: null,
    });
    assert.match(snapshot.persistence, /pending.*safe integer range/);
    assert.doesNotThrow(() => validateStats(snapshot), 'degraded fallback must remain page-consumable');
    assert.deepEqual(store.pending, pendingBefore, 'snapshot must not consume or mutate pending data');
    assert.deepEqual(store.db.query('SELECT * FROM stats WHERE id=1').get(), beforeRow, 'snapshot must not change persisted row');

    assert.equal((await store.flush()).status, 'degraded', 'flush still refuses the unsafe aggregate');
    assert.deepEqual(store.pending, pendingBefore, 'failed flush retains the complete pending record');
    assert.equal(store.db, null, 'overflow degrades storage without keeping a misleading writable connection');
    const { Database } = await import('bun:sqlite');
    const verify = new Database(join(dir, 'stats.sqlite'), { readonly: true, safeIntegers: true });
    try {
      assert.deepEqual(verify.query('SELECT * FROM stats WHERE id=1').get(), beforeRow, 'flush overflow leaves the physical row unchanged');
    } finally {
      verify.close();
    }
    assert.doesNotThrow(() => validateStats(store.snapshot()), 'repeated degraded snapshot remains valid for the page');
  } finally {
    await store.close();
  }
});

test('category counters overlap by request, sum line counts, and survive flush/reopen', { skip: typeof Bun === 'undefined' }, async () => {
  const dir = await freshDir('category-counters');
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal(store.record({ matched: true, removedLines: 3, dateRemovedLines: 2, topicTitleRemovedLines: 1, at: '2026-11-11T00:00:00.000Z' }), true);
  assert.equal(store.record({ matched: true, removedLines: 1, dateRemovedLines: 0, topicTitleRemovedLines: 1, at: '2026-11-11T00:00:01.000Z' }), true);
  const before = store.snapshot().stats;
  assert.equal(before.matchedRequests, 2);
  assert.equal(before.removedLines, 4);
  assert.equal(before.dateMatchedRequests, 1);
  assert.equal(before.dateRemovedLines, 2);
  assert.equal(before.topicTitleMatchedRequests, 2);
  assert.equal(before.topicTitleRemovedLines, 2);
  assert.equal((await store.flush()).status, 'ok');
  await store.close();
  const reopened = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.deepEqual(reopened.snapshot().stats, before);
  await reopened.close();
});

test('legacy aggregate migration preserves totals and initializes category counters as unclassified', { skip: typeof Bun === 'undefined' }, async () => {
  const dir = await freshDir('legacy-category-upgrade');
  const { Database } = await import('bun:sqlite');
  const db = new Database(join(dir, 'stats.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE stats (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, processed_requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, removed_lines INTEGER NOT NULL, started_at TEXT, updated_at TEXT, last_matched_at TEXT);');
  db.query('INSERT INTO stats VALUES (1,1,12,4,9,?,?,?)').run('2026-11-01T00:00:00.000Z', '2026-11-11T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
  db.close();
  const store = new StatsStore({ dataDir: dir, autoFlush: false });
  const stats = store.snapshot().stats;
  assert.deepEqual([stats.processedRequests, stats.matchedRequests, stats.removedLines], [12, 4, 9]);
  assert.deepEqual([stats.dateMatchedRequests, stats.dateRemovedLines, stats.topicTitleMatchedRequests, stats.topicTitleRemovedLines], [0, 0, 0, 0]);
  assert.deepEqual([stats.availableAgentsMatchedRequests, stats.availableAgentsReplacedBlocks, stats.timeGuidanceInsertedBlocks], [0, 0, 0]);
  assert.deepEqual([stats.startedAt, stats.updatedAt, stats.lastMatchedAt], ['2026-11-01T00:00:00.000Z', '2026-11-11T00:00:00.000Z', '2026-11-10T00:00:00.000Z']);
  assert.equal(store.snapshot().status, 'ok');
  assert.equal((await store.flush()).status, 'ok');
  await store.close();
  const reopened = new StatsStore({ dataDir: dir, autoFlush: false });
  assert.equal(reopened.snapshot().status, 'ok');
  assert.deepEqual([reopened.snapshot().stats.processedRequests, reopened.snapshot().stats.matchedRequests, reopened.snapshot().stats.removedLines], [12, 4, 9]);
  assert.deepEqual([reopened.snapshot().stats.availableAgentsReplacedBlocks, reopened.snapshot().stats.timeGuidanceInsertedBlocks], [0, 0]);
  await reopened.close();
});

test('settings API authenticates reads and writes, validates booleans, and persists settings', { skip: typeof Bun === 'undefined' }, async () => {
  const dir = await freshDir('settings-api');
  const config = new FilterConfigStore({ dataDir: dir });
  const token = 'b'.repeat(64);
  const service = createService({ store: { snapshot: () => ({ schemaVersion: 1, status: 'ok', stats: {}, persistence: 'fixture' }) }, configStore: config, port: 0, token });
  try {
    const url = new URL('/api/settings', service.server.url);
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionDate: false, topicTitle: false, availableAgents: false }) })).status, 401);
    const invalid = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionDate: 0, topicTitle: false }) });
    assert.equal(invalid.status, 400);
    const saved = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionDate: false, topicTitle: true, availableAgents: false }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).settings, { sessionDate: false, topicTitle: true, availableAgents: false });
    const read = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual((await read.json()).settings, { sessionDate: false, topicTitle: true, availableAgents: false });
    const reloaded = new FilterConfigStore({ dataDir: dir });
    assert.deepEqual(reloaded.snapshot(), { sessionDate: false, topicTitle: true, availableAgents: false });
    reloaded.close();
  } finally { await service.stop(); config.close(); }
});

test.after(async () => {
  await rm(testDataRoot, { recursive: true, force: true });
});
