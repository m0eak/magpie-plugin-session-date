#!/usr/bin/env bun
import { StatsStore } from '../../src/stats-store.mjs';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';

const startedAt = Date.now();
const dataDir = process.argv[2];
const count = Number(process.argv[3]);
const timestamp = process.argv[4];
const readyFile = process.argv[5];
const goFile = process.argv[6];
const name = process.argv[7] ?? 'writer';

if (readyFile && goFile) {
  writeFileSync(readyFile, `${process.pid}`, { mode: 0o600 });
  const start = Date.now();
  while (!existsSync(goFile)) {
    if (Date.now() - start > 30_000) throw new Error('writer barrier timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const store = new StatsStore({ dataDir, autoFlush: true, flushIntervalMs: 30_000 });
for (let i = 0; i < count; i += 1) store.record({ matched: i % 2 === 0, removedLines: i % 2 === 0 ? 1 : 0, at: timestamp });
let result = await store.flush();
const retryDeadline = Date.now() + 2500;
while (store.pending.processedRequests > 0 && Date.now() < retryDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (store.pending.processedRequests > 0) {
  result = await store.flush();
}
if (store.pending.processedRequests === 0 && result.status === 'degraded' && store.snapshot().status === 'ok') {
  result = { status: 'ok' };
}
if (result.status !== 'ok' || store.pending.processedRequests !== 0) {
  const retryFile = process.argv[8];
  if (retryFile) {
    writeFileSync(retryFile, JSON.stringify({ failed: true, pending: store.pending.processedRequests, status: result.status, code: store.failureCode }), { mode: 0o600 });
    const start = Date.now();
    while (!existsSync(retryFile + '.stop') && Date.now() - start < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = await store.flush();
    }
  }
  console.error(`flush status ${result.status} pending ${store.pending.processedRequests} ${store.failureCode || ''}`);
  process.exitCode = 2;
}
await store.close();
console.log(JSON.stringify({ name, pid: process.pid, status: result.status, elapsedMs: Date.now() - startedAt }));
