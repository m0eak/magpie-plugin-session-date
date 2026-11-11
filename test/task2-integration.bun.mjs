import { Database } from 'bun:sqlite';
import { mkdtempSync, chmodSync, statSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { StatsStore } from '../src/stats-store.mjs';
import { createRequestHook } from '../src/request.hooks.mjs';
import { createService } from '../src/service-api.mjs';
import { CURRENT_TIME_GUIDANCE } from '../src/stable-context.mjs';

const dateLine = 'Session date: Tuesday, November 3, 2026';
const target = `<tools description="The tools you can use below">\n<tool name="Memory">\n<tool.instructions>You have access to the Memory Tool.\n<session_context>\n${dateLine}\nConversation language: en\n</session_context>\n</tool.instructions>\n</tool>\n</tools>`;
const clean = target.replace(`${dateLine}\n`, `${CURRENT_TIME_GUIDANCE}\n`);
const root = mkdtempSync(join(process.cwd(), 'test-data', `integration-${process.pid}-`));
chmodSync(root, 0o700);
try {
const hookDataDir = join(root, 'hook');
mkdirSync(hookDataDir, { recursive: true, mode: 0o700 });
const hookStore = new StatsStore({ dataDir: hookDataDir, autoFlush: false });
const hook = createRequestHook({ store: hookStore, now: () => new Date('2026-11-04T00:00:00.000Z') });
const transformed = await hook({ messages: [{ role: 'system', content: target }] }, { protocol: 'chat' });
if (transformed.messages[0].content !== clean) throw new Error('request hook did not filter target date');
await hookStore.flush();
const service = createService({ store: hookStore, port: 0 });
const response = await fetch(new URL('/api/stats', service.server.url), { headers: { Origin: 'null' } });
if (response.status !== 200 || (await response.json()).stats.matchedRequests !== 1) throw new Error('service API returned incorrect stats');
await service.stop();
await hookStore.close();
const mode = statSync(join(hookDataDir, 'stats.sqlite')).mode & 0o777;
if (mode !== 0o600) throw new Error('database permissions are not owner-only');

const dataDir = join(root, 'concurrent');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = join(dataDir, 'stats.sqlite');
const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL; CREATE TABLE stats (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, processed_requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, removed_lines INTEGER NOT NULL, started_at TEXT, updated_at TEXT, last_matched_at TEXT)');
db.run('INSERT INTO stats VALUES (1,1,0,0,0,NULL,NULL,NULL)');
db.close();
const base = new StatsStore({ dataDir, autoFlush: false });
if ((await base.snapshot()).stats.processedRequests !== 0) throw new Error('could not open seeded stats');
await base.close();
const script = join(process.cwd(), 'test/fixtures/stats-writer.bun.mjs');
const runWriter = (ts) => new Promise((resolveWriter, reject) => {
  const child = Bun.spawn(['bun', script, dataDir, '25', ts], { stdout: 'pipe', stderr: 'pipe' });
  void child.exited.then(async (code) => {
    const err = await new Response(child.stderr).text();
    if (code === 0) resolveWriter(); else reject(new Error(`Writer exited ${code}: ${err}`));
  });
});
await Promise.all(Array.from({ length: 4 }, (_, i) => runWriter(`2026-11-04T01:00:00.${String(i).padStart(3, '0')}Z`)));
  const final = new Database(dbPath, { readonly: true });
  const row = final.query('SELECT processed_requests,matched_requests,removed_lines FROM stats WHERE id=1').get();
  final.close();
  if (Number(row.processed_requests) !== 100 || Number(row.matched_requests) !== 52 || Number(row.removed_lines) !== 52) throw new Error('concurrent increments were lost');
  console.log('Hook, read-only HTTP service, owner-only permissions and four-process SQLite aggregate passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
