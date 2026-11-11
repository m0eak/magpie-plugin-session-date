import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateStats, createStatsPoller } from '../src/stats-ui.mjs';
import { createService } from '../src/service-api.mjs';

const good = { schemaVersion: 1, status: 'ok', stats: { processedRequests: 3, matchedRequests: 2, removedLines: 4, unmatchedRequests: 1, startedAt: '2026-11-05T02:03:04.000Z', updatedAt: '2026-11-05T02:04:04.000Z', lastMatchedAt: '2026-11-05T02:04:00.000Z' }, persistence: 'SQLite WAL; this host includes local pending counters.' };

test('stats schema accepts consistent counts and nullable UTC timestamps', () => {
  assert.deepEqual(validateStats(good), good);
  assert.equal(validateStats({ ...good, stats: { ...good.stats, startedAt: null, updatedAt: null, lastMatchedAt: null, processedRequests: 0, matchedRequests: 0, removedLines: 0, unmatchedRequests: 0 } }).stats.startedAt, null);
});

test('stats schema rejects alien, malformed, unsafe and inconsistent data', () => {
  for (const bad of [null, [], {}, { ...good, schemaVersion: 2 }, { ...good, status: 'unknown' }, { ...good, stats: { ...good.stats, processedRequests: -1 } }, { ...good, stats: { ...good.stats, processedRequests: Number.MAX_SAFE_INTEGER + 1 } }, { ...good, stats: { ...good.stats, matchedRequests: 4 } }, { ...good, stats: { ...good.stats, updatedAt: 'not-a-date' } }, { ...good, stats: { ...good.stats, lastMatchedAt: null } }, { ...good, stats: { ...good.stats, availableAgentsMatchedRequests: 2, availableAgentsReplacedBlocks: 1 } }, { ...good, stats: { ...good.stats, dateMatchedRequests: 1 } }, { ...good, stats: { ...good.stats, topicTitleRemovedLines: 1 } }, { ...good, stats: { ...good.stats, availableAgentsReplacedBlocks: 1 } }]) assert.throws(() => validateStats(bad));
  assert.equal(validateStats({ ...good, status: 'degraded' }).status, 'degraded');
});

test('stats schema accepts multiple guidance blocks per matched request and pure agent replacement', () => {
  const base = {
    ...good,
    stats: {
      ...good.stats,
      processedRequests: 1,
      matchedRequests: 1,
      unmatchedRequests: 0,
      removedLines: 2,
      dateMatchedRequests: 1,
      dateRemovedLines: 2,
      timeGuidanceInsertedBlocks: 2,
    },
  };
  assert.equal(validateStats(base).stats.timeGuidanceInsertedBlocks, 2);
  const pureAgents = {
    ...base,
    stats: {
      ...base.stats,
      removedLines: 0,
      dateMatchedRequests: 0,
      dateRemovedLines: 0,
      timeGuidanceInsertedBlocks: 0,
      availableAgentsMatchedRequests: 1,
      availableAgentsReplacedBlocks: 1,
    },
  };
  assert.equal(validateStats(pureAgents).stats.availableAgentsReplacedBlocks, 1);
  assert.throws(() => validateStats({
    ...pureAgents,
    stats: { ...pureAgents.stats, availableAgentsReplacedBlocks: 0 },
  }), /Invalid statistics/);
});

test('poller marks initial network failure unavailable, keeps stale success, times out without overlap and pauses when hidden', async () => {
  let visible = true;
  let calls = 0;
  const poller = createStatsPoller({
    fetcher: async (_url, { signal }) => {
      calls++;
      if (calls === 1) throw new Error('offline');
      if (calls === 2) return { ok: true, json: async () => good };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    getVisible: () => visible,
    timeoutMs: 15,
  });
  assert.equal((await poller.refresh()).kind, 'unavailable');
  assert.equal(poller.state.snapshot, null);
  assert.equal((await poller.refresh()).kind, 'ok');
  const first = poller.refresh();
  const second = poller.refresh();
  assert.equal((await first).kind, 'stale');
  assert.equal((await second).kind, 'stale');
  assert.equal(calls, 3);
  visible = false;
  assert.equal((await poller.refresh()).kind, 'paused');
  assert.equal(calls, 3);
  poller.stop();
});

test('manifest and initial page use the real page bridge service handoff', async () => {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg['magpie'].page, { title: 'Session Date Filter', titles: { zh: '会话日期清理' }, file: 'page/index.html', service: { port: 3479, option: 'sessionDateFilterPort' } });
  assert.equal(pkg['magpie'].options, undefined);
  const html = await readFile(join(root, 'page/index.html'), 'utf8');
  const boot = await readFile(join(root, 'page/boot.js'), 'utf8');
  assert.match(html, /_magpie\/bridge\.js/);
  assert.match(boot, /window\.magpie\?\.ready/);
  assert.match(boot, /window\.magpie\?\.service/);
  assert.match(boot, /uiOrigin/);
  assert.match(boot, /location\.replace/);
  assert.doesNotMatch(boot, /fetch\s*\(/);
});

test('service serves fixed assets and read-only authenticated API with proxy CSP', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: 'a'.repeat(64) });
  try {
    const root = service.server.url;
    for (const [path, type] of [['/', 'text/html'], ['/app.mjs', 'text/javascript'], ['/boot.js', 'text/javascript'], ['/page-bridge.mjs', 'text/javascript'], ['/stats-ui.mjs', 'text/javascript'], ['/style.css', 'text/css']]) {
      const response = await fetch(new URL(path, root));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), new RegExp(type));
    }
    for (const path of ['/etc/passwd', '/not-a-file.js', '/api/stats?path=/secret']) assert.equal((await fetch(new URL(path, root))).status, 404);
    const page = await fetch(new URL('/?uiOrigin=https%3A%2F%2Fhost.example&theme=dark&lang=zh-CN', root));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/host\.example/);
    assert.match(await page.text(), /window\.__SESSION_DATE_FILTER__=/);
    assert.equal((await fetch(new URL('/api/stats', root))).status, 401);
    const options = await fetch(new URL('/api/stats', root), { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(options.status, 204);
    assert.match(options.headers.get('access-control-allow-headers'), /Authorization/);
    const stats = await fetch(new URL('/api/stats', root), { headers: { Authorization: `Bearer ${'a'.repeat(64)}`, Origin: 'null' } });
    assert.equal(stats.status, 200);
    assert.deepEqual(await stats.json(), good);
    assert.equal((await fetch(new URL('/api/stats', root), { method: 'POST' })).status, 405);
    assert.equal((await fetch(new URL('/health', root))).status, 200);
  } finally { await service.stop(); }
});

test('settings PATCH merges explicit fields, PUT replaces all fields, and writes require authentication', { skip: typeof Bun === 'undefined' }, async () => {
  let settings = { sessionDate: true, topicTitle: true, availableAgents: false };
  const configStore = {
    snapshot: () => settings,
    async update(patch) { settings = Object.freeze({ ...settings, ...patch }); return settings; },
    async replace(value) { settings = Object.freeze({ ...value }); return settings; },
  };
  const service = createService({ store: { snapshot: () => good }, configStore, port: 0, token: 'a'.repeat(64) });
  try {
    const root = service.server.url;
    const headers = { Authorization: `Bearer ${'a'.repeat(64)}`, Origin: 'null', 'Content-Type': 'application/json' };
    const dateChange = await fetch(new URL('/api/settings', root), { method: 'PATCH', headers, body: JSON.stringify({ sessionDate: false }) });
    assert.equal(dateChange.status, 200);
    assert.deepEqual((await dateChange.json()).settings, { sessionDate: false, topicTitle: true, availableAgents: false });
    const titleChange = await fetch(new URL('/api/settings', root), { method: 'PATCH', headers, body: JSON.stringify({ topicTitle: false }) });
    assert.deepEqual((await titleChange.json()).settings, { sessionDate: false, topicTitle: false, availableAgents: false });
    assert.equal((await fetch(new URL('/api/settings', root), { method: 'PATCH', headers, body: JSON.stringify({ unknown: false }) })).status, 400);
    const replace = await fetch(new URL('/api/settings', root), { method: 'PUT', headers, body: JSON.stringify({ sessionDate: true, topicTitle: true, availableAgents: false }) });
    assert.deepEqual((await replace.json()).settings, { sessionDate: true, topicTitle: true, availableAgents: false });
    const unauthorized = await fetch(new URL('/api/settings', root), { method: 'PATCH', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: JSON.stringify({ topicTitle: false }) });
    assert.equal(unauthorized.status, 401);
    const preflight = await fetch(new URL('/api/settings', root), { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'PATCH' } });
    assert.equal(preflight.status, 204);
  } finally { await service.stop(); }
});
