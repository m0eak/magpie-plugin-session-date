import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import plugin, { getPluginServerStatus } from '../../index.mjs';
import { StatsStore, resetStatsStoreForTests } from '../../src/stats-store.mjs';

const scenario = process.argv[2];
const root = join(process.cwd(), 'test-data', `server-error-boundary-${process.pid}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const warnings = [];
const input = { directory: root, client: { app: { log: async (item) => warnings.push(item) } } };
const originalServe = Bun.serve;
const originalSnapshot = StatsStore.prototype.snapshot;
const originalFreeze = Object.freeze;
let createdServer;
let stopCount = 0;

try {
  if (scenario === 'unknown-error' || scenario === 'type-error') {
    const failure = scenario === 'unknown-error' ? new Error('unexpected listener failure') : new TypeError('unexpected type failure');
    Bun.serve = () => { throw failure; };
    await assert.rejects(plugin.server(input, {}), (error) => error === failure);
    assert.equal(warnings.length, 0);
    assert.notEqual(getPluginServerStatus().reason, 'listener-unavailable');
  } else if (scenario === 'snapshot-error' || scenario === 'status-error') {
    Bun.serve = (options) => {
      createdServer = { port: options.port, url: new URL('http://127.0.0.1:3479'), stop: () => { stopCount += 1; } };
      return createdServer;
    };
    const failure = new Error(`unexpected ${scenario}`);
    if (scenario === 'snapshot-error') {
      StatsStore.prototype.snapshot = function snapshot() { throw failure; };
    } else {
      Object.freeze = (value) => {
        if (value && Object.hasOwn(value, 'listenerAvailable') && Object.hasOwn(value, 'storageStatus')) throw failure;
        return originalFreeze(value);
      };
    }
    await assert.rejects(plugin.server(input, {}), (error) => error === failure);
    assert.equal(stopCount, 1, 'only the listener created by this startup attempt is stopped');
    assert.equal(warnings.length, 0);
    assert.notEqual(getPluginServerStatus().reason, 'listener-unavailable');
  } else {
    throw new Error(`unknown fixture scenario: ${scenario}`);
  }
  console.log(`${scenario}: passed`);
} finally {
  Bun.serve = originalServe;
  StatsStore.prototype.snapshot = originalSnapshot;
  Object.freeze = originalFreeze;
  const store = resetStatsStoreForTests();
  await store?.close();
  rmSync(root, { recursive: true, force: true });
}
