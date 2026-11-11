import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FilterConfigStore } from '../src/filter-config.mjs';
import { filterRequest } from '../src/protocols.mjs';
import { createRequestHook } from '../src/request.hooks.mjs';
import { readFilterSettings, saveFilterSettings, setServiceToken } from '../src/stats-ui.mjs';

const date = 'Current date: 2026-11-11';
const titleEmpty = '| Topic Title |  |';
const titleReal = '| Topic Title | A real topic |';
const protocols = [
  ['chat', (text) => ({ messages: [{ role: 'system', content: text }] }), (body) => body.messages[0].content],
  ['responses', (text) => ({ instructions: text }), (body) => body.instructions],
  ['anthropic', (text) => ({ system: text }), (body) => body.system],
  ['gemini', (text) => ({ systemInstruction: { parts: [{ text }] } }), (body) => body.systemInstruction.parts[0].text],
];

test('all four setting combinations preserve stable prompts across title and date changes on every supported protocol', () => {
  for (const [protocol, makeBody, getText] of protocols) {
    for (const sessionDate of [false, true]) for (const topicTitle of [false, true]) {
      const options = { sessionDate, topicTitle };
      const first = getText(filterRequest(makeBody(`${date}\n${titleEmpty}\nstatic`), protocol, options).body);
      const second = getText(filterRequest(makeBody(`Current date: 2026-11-12\n${titleReal}\nstatic`), protocol, options).body);
      assert.equal(first, `${sessionDate ? '' : `${date}\n`}${topicTitle ? '' : `${titleEmpty}\n`}static`);
      assert.equal(second, `${sessionDate ? '' : 'Current date: 2026-11-12\n'}${topicTitle ? '' : `${titleReal}\n`}static`);
      if (sessionDate && topicTitle) assert.equal(first, second);
    }
  }
});

test('configuration is strictly boolean, atomically persisted, and survives a new store instance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lh-filter-settings-'));
  const timers = [];
  try {
    const first = new FilterConfigStore({ dataDir: dir, schedule: (fn) => (timers.push(fn), null), cancel() {} });
    const secondHost = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {} });
    assert.deepEqual(first.snapshot(), { sessionDate: true, topicTitle: true });
    await assert.rejects(first.update({ sessionDate: 0 }), /known boolean fields/);
    assert.deepEqual(await first.update({ sessionDate: false }), { sessionDate: false, topicTitle: true });
    assert.deepEqual(await secondHost.update({ topicTitle: false }), { sessionDate: false, topicTitle: false }, 'a stale page changes only its explicit field');
    const child = spawnSync(process.execPath, [join(process.cwd(), 'test/fixtures/filter-config-writer.mjs'), dir, JSON.stringify({ sessionDate: true })], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(secondHost.snapshot(), { sessionDate: false, topicTitle: false }, 'other process changes are observed on refresh, not mid-request');
    assert.equal(secondHost.refresh(), true);
    assert.deepEqual(secondHost.snapshot(), { sessionDate: true, topicTitle: false });
    const restarted = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {} });
    assert.deepEqual(restarted.snapshot(), { sessionDate: true, topicTitle: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first save creates a missing data directory before locking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lh-filter-parent-'));
  const dir = join(root, 'not-created-yet');
  try {
    const store = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {} });
    assert.deepEqual(await store.update({ sessionDate: false }), { sessionDate: false, topicTitle: true });
    store.close();
    assert.ok(existsSync(join(dir, 'filter-config.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live lock is retained, timed out asynchronously, and does not block host heartbeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lh-filter-live-lock-'));
  const store = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {}, lockTimeoutMs: 120, lockPollMs: 10 });
  const lockPath = `${store.path}.lock`;
  try {
    await store.update({ sessionDate: false });
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'active-lock-owner-test-token' }));
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats += 1; }, 2);
    await assert.rejects(store.update({ topicTitle: false }), /Timed out waiting/);
    clearInterval(heartbeat);
    assert.ok(heartbeats > 2, 'the event loop continued to run while waiting');
    assert.ok(existsSync(join(lockPath, 'owner.json')), 'a live owner lock must not be removed');
    assert.deepEqual(store.snapshot(), { sessionDate: false, topicTitle: true }, 'failed save leaves in-memory settings untouched');
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock owned by an exited process is reclaimed and the save completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lh-filter-dead-lock-'));
  const store = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {}, lockTimeoutMs: 1000, lockPollMs: 10 });
  try {
    await store.update({ sessionDate: false });
    const lockPath = `${store.path}.lock`;
    const child = spawnSync(process.execPath, [join(process.cwd(), 'test/fixtures/filter-config-abandoned-lock.mjs'), lockPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(await store.update({ topicTitle: false }), { sessionDate: false, topicTitle: false });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery guard serializes stale reclaimers and preserves a replacement live owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lh-filter-reaper-race-'));
  const first = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {}, lockTimeoutMs: 100, lockPollMs: 5 });
  const second = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {}, lockTimeoutMs: 100, lockPollMs: 5 });
  const lockPath = `${first.path}.lock`;
  const guardPath = `${lockPath}.reap`;
  const originalRmSync = fs.rmSync;
  const originalMkdir = fsPromises.mkdir;
  let guardAcquiredResolve;
  let resumeReaperResolve;
  const guardAcquired = new Promise((resolve) => { guardAcquiredResolve = resolve; });
  const resumeReaper = new Promise((resolve) => { resumeReaperResolve = resolve; });
  let interceptedGuard = false;
  let replacementInstalled = false;
  try {
    await first.update({ sessionDate: false });
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999999, token: 'abandoned-original-owner-token' }));

    const waitingA = first.update({ sessionDate: true });
    fsPromises.mkdir = async (path, options) => {
      const result = await originalMkdir(path, options);
      if (path === guardPath && !interceptedGuard) {
        interceptedGuard = true;
        guardAcquiredResolve();
        await resumeReaper;
      }
      return result;
    };
    fs.rmSync = (target, options) => {
      const result = originalRmSync(target, options);
      if (target === lockPath && !replacementInstalled) {
        replacementInstalled = true;
        mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'external-live-owner-for-review' }));
      }
      return result;
    };
    syncBuiltinESMExports();

    await guardAcquired;
    const waitingB = second.update({ topicTitle: false });
    await new Promise((resolve) => setTimeout(resolve, 25));
    resumeReaperResolve();
    const results = await Promise.allSettled([waitingA, waitingB]);
    assert.ok(results.every((result) => result.status === 'rejected' && /Timed out waiting/.test(result.reason.message)));
    assert.equal(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).token, 'external-live-owner-for-review');
    assert.deepEqual(first.snapshot(), { sessionDate: false, topicTitle: true }, 'neither reaper entered its update while writer C owned the lock');
  } finally {
    resumeReaperResolve();
    fs.rmSync = originalRmSync;
    fsPromises.mkdir = originalMkdir;
    syncBuiltinESMExports();
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged recovery guard is not reclaimed and ends in an explicit timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lh-filter-bad-guard-'));
  const store = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {}, lockTimeoutMs: 70, lockPollMs: 5 });
  const lockPath = `${store.path}.lock`;
  const guardPath = `${lockPath}.reap`;
  try {
    await store.update({ sessionDate: false });
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999999, token: 'abandoned-original-owner-token' }));
    mkdirSync(guardPath, { mode: 0o700 });
    writeFileSync(join(guardPath, 'owner.json'), 'not valid owner metadata');
    await assert.rejects(store.update({ topicTitle: false }), /Timed out waiting/);
    assert.ok(existsSync(join(lockPath, 'owner.json')));
    assert.ok(existsSync(join(guardPath, 'owner.json')));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simultaneous hosts changing separate settings merge both updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lh-filter-race-'));
  const seed = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {} });
  seed.close();
  const gatePath = join(dir, 'start-writes');
  const childScript = join(process.cwd(), 'test/fixtures/filter-config-race-writer.mjs');
  const children = ['sessionDate', 'topicTitle'].map((setting, index) => {
    const readyPath = join(dir, `ready-${index}`);
    const errorPath = join(dir, `${setting}.error`);
    const child = spawn(process.execPath, [childScript, dir, setting, 'false', readyPath, gatePath, errorPath], { stdio: 'ignore' });
    return { child, setting, readyPath, exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
  });
  try {
    const deadline = Date.now() + 5000;
    while (!children.every(({ readyPath }) => existsSync(readyPath)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(children.every(({ readyPath }) => existsSync(readyPath)), 'both hosts loaded the same starting snapshot');
    writeFileSync(gatePath, 'go');
    const statuses = await Promise.all(children.map(({ exited }) => exited));
    assert.deepEqual(statuses, [0, 0], children.map(({ setting }) => {
      const errorPath = join(dir, `${setting}.error`);
      return existsSync(errorPath) ? fs.readFileSync(errorPath, 'utf8') : '';
    }).join('\n'));
    const persisted = new FilterConfigStore({ dataDir: dir, schedule: () => null, cancel() {} });
    assert.deepEqual(persisted.snapshot(), { sessionDate: false, topicTitle: false });
    persisted.close();
  } finally {
    writeFileSync(gatePath, 'go');
    await Promise.all(children.map(({ exited }) => exited));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('request hook reads one configuration snapshot and records actual category counts', async () => {
  let reads = 0;
  const events = [];
  const hook = createRequestHook({
    store: { record: (event) => events.push(event) },
    config: () => ({ snapshot: () => { reads += 1; return { sessionDate: true, topicTitle: false }; } }),
    now: () => new Date('2026-11-11T00:00:00.000Z'),
  });
  const body = { messages: [{ role: 'system', content: `${date}\n${titleReal}` }] };
  const result = await hook(body, { protocol: 'chat' });
  assert.equal(reads, 1);
  assert.equal(result.messages[0].content, titleReal);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].dateRemovedLines, 1);
  assert.equal(events[0].topicTitleRemovedLines, 0);
});

test('date switch controls both Current date metadata and the supported Memory Session date wrapper', () => {
  const wrapped = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>\n<session_context>\nSession date: Tuesday, November 3, 2026\nConversation language: en\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
  const body = { messages: [{ role: 'system', content: `${date}\n${wrapped}` }] };
  const enabled = filterRequest(body, 'chat', { sessionDate: true, topicTitle: false });
  assert.equal(enabled.removedLines, 2);
  assert.equal(enabled.dateRemovedLines, 2);
  assert.doesNotMatch(enabled.body.messages[0].content, /Current date:|Session date:/);
  const disabled = filterRequest(body, 'chat', { sessionDate: false, topicTitle: false });
  assert.equal(disabled.removedLines, 0);
  assert.equal(disabled.body, body);
});

test('settings page client refuses to treat failed saves as applied settings', async () => {
  setServiceToken('a'.repeat(64));
  let captured;
  const fetcher = async (_url, init) => {
    captured = init;
    return { ok: false, status: 503, json: async () => ({ error: 'failed' }) };
  };
  await assert.rejects(saveFilterSettings({ sessionDate: false, topicTitle: true }, { fetcher }), /could not be saved/);
  assert.equal(captured.method, 'PATCH');
  assert.equal(captured.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
  await assert.rejects(readFilterSettings({ fetcher }), /could not be loaded/);
  setServiceToken('');
});

test('settings PATCH accepts authoritative merged state and validates only patched fields', async () => {
  setServiceToken('a'.repeat(64));
  let request;
  const response = { ok: true, json: async () => ({ settings: { sessionDate: false, topicTitle: false } }) };
  const fetcher = async (_url, init) => { request = init; return response; };
  assert.deepEqual(await saveFilterSettings({ sessionDate: false }, { fetcher }), { sessionDate: false, topicTitle: false });
  assert.equal(request.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.body), { sessionDate: false });
  const mismatch = async () => ({ ok: true, json: async () => ({ settings: { sessionDate: true, topicTitle: false } }) });
  await assert.rejects(saveFilterSettings({ sessionDate: false }, { fetcher: mismatch }), /Invalid settings response/);
});
