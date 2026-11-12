import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugConfigStore } from '../src/debug-config.mjs';
import { DebugWriter } from '../src/debug-writer.mjs';
import { createService } from '../src/service-api.mjs';

const dir = await mkdtemp(join(tmpdir(), 'session-date-debug-api-'));
const token = 'c'.repeat(64);
const configStore = new DebugConfigStore({ dataDir: dir, pollMs: 60_000 });
const writer = new DebugWriter({ directory: join(dir, 'debug'), runId: 'bun-api' });
const service = createService({
  store: { snapshot: () => ({ stats: {} }) },
  configStore: { snapshot: () => ({ sessionDate: true, topicTitle: true, availableAgents: false }) },
  debugConfigStore: configStore,
  debugWriter: writer,
  port: 0,
  token,
});
const call = (method, body, authorization = `Bearer ${token}`) => fetch(new URL('/api/debug', service.server.url), {
  method,
  headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
try {
  const unauthenticated = await call('GET', undefined, 'Bearer invalid');
  assert.equal(unauthenticated.status, 401);
  const initial = await call('GET');
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.settings.enabled, false);
  assert.deepEqual(Object.keys(initialBody.status).sort(), ['directory', 'droppedRequests', 'lastErrorCode', 'lastWriteAt', 'queuedRequests', 'state', 'writtenRequests'].sort());
  assert.equal(initialBody.status.state, 'disabled');

  const preflight = await fetch(new URL('/api/debug', service.server.url), {
    method: 'OPTIONS',
    headers: {
      Origin: 'null',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /(?:^|,\s*)PUT(?:,|$)/);

  const enabled = await call('PUT', { enabled: true });
  assert.equal(enabled.status, 200);
  const enabledBody = await enabled.json();
  assert.equal(enabledBody.settings.enabled, true);
  assert.equal(enabledBody.status.state, 'ready');
  assert.equal(writer.status().enabled, true);

  const invalid = await call('PUT', { enabled: false, extra: true });
  assert.equal(invalid.status, 400);
  await service.stop();

  const restarted = new DebugConfigStore({ dataDir: dir, pollMs: 60_000 });
  assert.deepEqual(restarted.snapshot(), { enabled: true });
  restarted.close();

  await writeFile(join(dir, 'debug-config.json'), '{broken');
  const brokenConfig = new DebugConfigStore({ dataDir: dir, pollMs: 60_000 });
  const brokenWriter = new DebugWriter({ directory: join(dir, 'debug'), runId: 'broken-api' });
  const brokenService = createService({
    store: { snapshot: () => ({ stats: {} }) },
    configStore: { snapshot: () => ({ sessionDate: true, topicTitle: true, availableAgents: false }) },
    debugConfigStore: brokenConfig,
    debugWriter: brokenWriter,
    port: 0,
    token,
  });
  try {
    const broken = await fetch(new URL('/api/debug', brokenService.server.url), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(broken.status, 503);
    const brokenBody = await broken.json();
    assert.equal(brokenBody.settings, null);
    assert.equal(brokenBody.status.state, 'config_unavailable');
    const repaired = await fetch(new URL('/api/debug', brokenService.server.url), {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(repaired.status, 200);
    assert.deepEqual(brokenConfig.snapshot(), { enabled: false });
  } finally { await brokenService.stop(); }
  console.log('debug-api.bun: passed');
} finally {
  try { await service.stop(); } catch {}
  await rm(dir, { recursive: true, force: true });
}
