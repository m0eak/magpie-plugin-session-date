import { join } from 'node:path';
import { StatsStore } from '../../src/stats-store.mjs';

const dir = process.argv[2];
const count = Number(process.argv[3]);
const timestamp = process.argv[4];
const store = new StatsStore({ dataDir: dir, autoFlush: false });
for (let i = 0; i < count; i += 1) store.record({ matched: i % 2 === 0, removedLines: i % 2 === 0 ? 1 : 0, at: timestamp });
const result = await store.flush();
if (result.status !== 'ok') {
  console.error(`flush status ${result.status} ${store.failureCode || ''}`);
  process.exitCode = 2;
}
await store.close();
