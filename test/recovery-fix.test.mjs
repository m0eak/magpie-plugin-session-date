import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilterConfigStore } from '../src/filter-config.mjs';
import { createRequestHook } from '../src/request.hooks.mjs';
import { createService } from '../src/service-api.mjs';

const valid = { sessionDate: false, topicTitle: true };
const invalid = '{"sessionDate":';
const makeStore = (dataDir) => new FilterConfigStore({ dataDir, schedule: () => null, cancel() {} });
const writeConfig = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`);

test('filter settings recover after repeated runtime parse failures, including unchanged mtime, without overwriting bad disk state', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'synthetic-filter-recovery-'));
  const store = makeStore(dataDir);
  try {
    await store.replace(valid);
    const originalMtime = new Date(store.mtime);
    writeFileSync(store.path, invalid);
    utimesSync(store.path, originalMtime, originalMtime);
    assert.equal(store.refresh(), false);
    assert.equal(store.snapshot(), null);
    await assert.rejects(store.update({ topicTitle: false }), /unavailable/i);
    assert.equal(readFileSync(store.path, 'utf8'), invalid, 'a failed store must not overwrite the damaged file');

    writeFileSync(store.path, invalid);
    utimesSync(store.path, originalMtime, originalMtime);
    assert.equal(store.refresh(), false, 'polling continues while invalid data remains');
    writeConfig(store.path, valid);
    utimesSync(store.path, originalMtime, originalMtime);
    assert.equal(store.refresh(), true, 'recovery must reread even if restored content reuses its old mtime');
    assert.deepEqual(store.snapshot(), valid);
    const hook = createRequestHook({ config: () => store, store: () => ({ record() {} }) });
    const prompt = { messages: [{ role: 'system', content: 'Current date: 2026-11-11\n| Topic Title | synthetic title |' }] };
    const transformed = await hook(prompt, { protocol: 'chat' });
    assert.match(transformed.messages[0].content, /Current date: 2026-11-11/);
    assert.doesNotMatch(transformed.messages[0].content, /Topic Title/);
    assert.deepEqual(await store.update({ topicTitle: false }), { sessionDate: false, topicTitle: false });
    assert.deepEqual(JSON.parse(readFileSync(store.path, 'utf8')), { sessionDate: false, topicTitle: false });
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('settings API returns unavailable while config is invalid and recovers after a valid reread', { skip: typeof Bun === 'undefined' }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'synthetic-filter-api-recovery-'));
  const seed = makeStore(dataDir);
  let service;
  try {
    writeFileSync(seed.path, invalid);
    seed.close();
    const store = makeStore(dataDir);
    service = createService({ store: { snapshot: () => ({ stats: {} }) }, configStore: store, port: 0, token: 'a'.repeat(64) });
    const settingsUrl = new URL('/api/settings', service.server.url);
    const headers = { Authorization: `Bearer ${'a'.repeat(64)}` };
    const unavailable = await fetch(settingsUrl, { headers });
    assert.equal(unavailable.status, 503);
    writeConfig(store.path, valid);
    assert.equal(store.refresh(), true);
    const recovered = await fetch(settingsUrl, { headers });
    assert.equal(recovered.status, 200);
    assert.deepEqual((await recovered.json()).settings, valid);
    store.close();
  } finally {
    await service?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('filter settings recover when the initial persisted configuration is invalid', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'synthetic-filter-startup-recovery-'));
  const seed = makeStore(dataDir);
  try {
    writeFileSync(seed.path, invalid);
    seed.close();
    const store = makeStore(dataDir);
    try {
      assert.equal(store.snapshot(), null);
      writeConfig(store.path, valid);
      assert.equal(store.refresh(), true);
      assert.deepEqual(store.snapshot(), valid);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('measurable request with unavailable settings is counted once without changing its body', async () => {
  const events = [];
  let settingsReads = 0;
  const hook = createRequestHook({
    config: () => ({ snapshot: () => { settingsReads++; return null; } }),
    store: () => ({ record: (event) => events.push(event) }),
  });
  const body = { messages: [{ role: 'system', content: 'Current date: 2026-11-11\n| Topic Title | synthetic title |' }] };
  const original = structuredClone(body);
  assert.equal(await hook(body, { protocol: 'chat' }), undefined);
  await Promise.resolve();
  assert.deepEqual(body, original, 'unavailable settings must fail open without transforming prompt text');
  assert.equal(settingsReads, 1, 'one configuration snapshot is taken per supported request');
  assert.equal(events.length, 1);
  assert.equal(events[0].matched, false);
  assert.equal(events[0].removedLines, 0);

  assert.equal(await hook({ unknown: true }, { protocol: 'chat' }), undefined);
  assert.equal(await hook(body, { protocol: 'unsupported' }), undefined);
  await Promise.resolve();
  assert.equal(events.length, 1, 'unknown payloads and unsupported protocols remain uncounted');
});
