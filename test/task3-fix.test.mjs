import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createPageBridge } from '../src/page-bridge.mjs';
import { createStatsPoller, setServiceToken as setPollerToken } from '../src/stats-ui.mjs';
import { createService } from '../src/service-api.mjs';
import { HOST_BRIDGE_ROUTE, HOST_MESSAGE_MARKER, HOST_THEME_PREFIX } from './fixtures/host-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_TOKEN = 'a'.repeat(64);
const BAD_TOKEN = 'e'.repeat(64);
const good = { schemaVersion: 1, status: 'ok', stats: { processedRequests: 3, matchedRequests: 2, removedLines: 4, unmatchedRequests: 1, startedAt: '2026-11-05T02:03:04.000Z', updatedAt: '2026-11-05T02:04:04.000Z', lastMatchedAt: '2026-11-05T02:04:00.000Z' }, persistence: 'synthetic local fixture' };

function makeDocument() {
  const elements = new Map();
  for (const id of ['status','stale','total','processed','matched','unmatched','started','lastMatched','updated','refresh']) {
    const listeners = new Map();
    elements.set(id, { id, textContent: ['total','processed','matched','unmatched'].includes(id) ? '—' : (['started','lastMatched','updated'].includes(id) ? '暂无' : ''), dataset: {}, style: { colorScheme: '', setProperty() {} }, attributes: {}, disabled: false, title: '',
      addEventListener(type, fn) { listeners.set(type, fn); }, setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
      getAttribute(key) { return this.attributes[key] ?? null; }, fire(type) { listeners.get(type)?.(); } });
  }
  const listeners = new Map();
  const html = { dataset: {}, lang: '', style: { colorScheme: '', setProperty() {} } };
  return { elements, html, document: { documentElement: html, visibilityState: 'visible', getElementById: (id) => elements.get(id), addEventListener(type, fn) { listeners.set(type, fn); }, fire(type) { listeners.get(type)?.(); } }, listeners };
}

async function loadActualPageApp(service, { bootstrapOverride, onFetch, appSourceOverride, mockStats = false, captureRenderErrors = false, mockBridge = false, legacyQueryToken = false } = {}) {
  const response = await fetch(new URL('/?theme=dark&lang=zh-CN', service.server.url));
  const html = await response.text();
  const bootstrapCode = html.match(/<script nonce="[^"]+">(window\.__SESSION_DATE_FILTER__=[^<]+)<\/script>/)?.[1];
  assert.ok(bootstrapCode, 'root HTML must contain the nonce-bound runtime bootstrap');
  const bootstrapToken = JSON.parse(bootstrapCode.slice('window.__SESSION_DATE_FILTER__='.length)).token;
  const token = bootstrapToken;
  const ui = makeDocument();
  const listeners = new Map();
  const messageListeners = new Set();
  const host = { postMessage(message) { if (message?.[HOST_MESSAGE_MARKER] === 1 && message.method === 'hello') queueMicrotask(() => { for (const fn of messageListeners) fn({ source: host, data: { [HOST_MESSAGE_MARKER]: 1, id: message.id, result: { dark: true, lang: 'zh-CN', tokens: { bg: '#101010' }, service: service.server.url, visible: true } } }); }); } };
  const win = { __SESSION_DATE_FILTER__: bootstrapOverride ?? undefined, parent: host, addEventListener(type, fn) { listeners.set(type, fn); } };
  const requestFetch = (url, init) => {
    onFetch?.(url, init);
    if (!mockStats && String(url).includes('/api/stats') && init?.headers?.Authorization === `Bearer ${BAD_TOKEN}`) return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) });
    if (mockStats && String(url).includes('/api/stats')) return Promise.resolve({ ok: true, json: async () => good });
    return fetch(new URL(url, service.server.url), { ...init, headers: { ...(init?.headers || {}), Origin: 'null' } });
  };
  const context = vm.createContext({
    document: ui.document, window: win, parent: host, location: { href: legacyQueryToken ? `${service.server.url}?token=${token}&theme=dark&lang=zh-CN` : service.server.url }, fetch: requestFetch,
    addEventListener(type, fn) { if (type === 'message') messageListeners.add(fn); else listeners.set(type, fn); },
    removeEventListener(type, fn) { if (type === 'message') messageListeners.delete(fn); else listeners.delete(type); },
    setTimeout, clearTimeout, URL, Intl, Date, String, Object, Number, Error, Promise, AbortController, console,
    __deps: null,
  });
  context.__deps = { createPageBridge: (options) => mockBridge ? { ready: Promise.resolve({ visible: true, theme: null }), visible: true, stop() {} } : createPageBridge({ ...options, selfWindow: context, parentWindow: host }), createStatsPoller: (options) => { const poller = createStatsPoller({ ...options, fetcher: requestFetch }); if (captureRenderErrors) { const start = poller.start.bind(poller); poller.start = (interval, callback) => start(interval, (result) => { try { callback(result); } catch (error) { win.__renderError = error; } }); } return poller; }, setServiceToken: (value) => { if (typeof value === 'string') { context.__appToken = value; setPollerToken(value); } } };
  // Run the fetched production entry body with its production dependencies injected;
  // only the two ES import declarations are adapted for this no-browser harness.
  let appSource = appSourceOverride ?? await (await fetch(new URL('/app.mjs', service.server.url), { headers: { Origin: 'null' } })).text();
  appSource = appSource.replace(/^import \{ createPageBridge \} from '\.\/page-bridge\.mjs';\s*$/m, 'const createPageBridge = (options) => __deps.createPageBridge(options);');
  appSource = appSource.replace(/^import \{ createStatsPoller, setServiceToken \} from '\.\/stats-ui\.mjs';\s*$/m, 'const createStatsPoller = (options) => __deps.createStatsPoller(options); const setServiceToken = __deps.setServiceToken;');
  assert.doesNotMatch(appSource, /^import /m, 'only the production entry imports should require adaptation in this harness');
  vm.runInContext(bootstrapCode, context);
  if (bootstrapOverride !== undefined) win.__SESSION_DATE_FILTER__ = bootstrapOverride;
  vm.runInContext(appSource, context, { filename: 'page/app.mjs' });
  return { ...ui, win, context, listeners, token, get appToken() { return context.__appToken; }, cleanup() { listeners.get('pagehide')?.(); } };
}

test('bridge uses the pinned host namespace and theme token contract', async () => {
  const listeners = new Set(); const rootElement = { dataset: {}, style: { colorScheme: '', vars: {}, setProperty(key, value) { this.vars[key] = value; } }, lang: '' };
  const self = { parent: null, document: { documentElement: rootElement }, addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); } };
  const sent = []; const parent = { postMessage(message) { sent.push(message); } }; self.parent = parent;
  const bridge = createPageBridge({ selfWindow: self, parentWindow: parent, timeoutMs: 30 });
  assert.equal(sent[0]?.[HOST_MESSAGE_MARKER], 1, 'hello marker must match the pinned host contract');
  const hello = sent[0];
  for (const fn of listeners) fn({ source: parent, data: { [HOST_MESSAGE_MARKER]: 1, id: hello.id, result: { dark: true, lang: 'zh-CN', tokens: { bg: '#101010' }, visible: true } } });
  await bridge.ready;
  assert.equal(rootElement.style.vars[`${HOST_THEME_PREFIX}bg`], '#101010');
  const initialPage = await readFile(resolve(root, 'page/index.html'), 'utf8');
  assert.match(initialPage, /--[^\s]+-font/, 'initial page must use the host font variable');
  for (const path of ['page/style.css', 'page/index.html']) {
    const source = await readFile(resolve(root, path), 'utf8');
    assert.ok(source.includes(HOST_THEME_PREFIX), `${path} theme tokens must match the pinned host contract`);
  }
  bridge.stop();
});

const liveHostRoot = process.env.SESSION_DATE_FILTER_HOST_ROOT;
if (liveHostRoot !== undefined) {
  test('optional live host source matches the pinned 0.1.3319 contract', async () => {
    const hostRoot = resolve(liveHostRoot);
    const [hostBridge, hostPages, hostPluginPage] = await Promise.all([
      readFile(resolve(hostRoot, 'internal/gui/pagebridge.js'), 'utf8'),
      readFile(resolve(hostRoot, 'internal/gui/assets/pluginpages.js'), 'utf8'),
      readFile(resolve(hostRoot, 'internal/gui/pluginpage.go'), 'utf8'),
    ]);
    const sourceMarkerMatch = hostBridge.match(/postMessage\(\{\s*(?:([\w$]+)|["']([^"']+)["']|\[\s*["']([^"']+)["']\s*\])\s*:\s*1,\s*id,\s*method,\s*params\s*\}/);
    const sourceMarker = sourceMarkerMatch?.[1] ?? sourceMarkerMatch?.[2] ?? sourceMarkerMatch?.[3];
    assert.equal(sourceMarker, HOST_MESSAGE_MARKER, 'host bridge message marker must match the pinned contract');
    assert.match(hostPages, /case "hello"[\s\S]*?service: \(!p\.context && e\.service\)/, 'host hello returns the page service through the host bridge');
    assert.ok(hostPluginPage.includes(`const pluginBridgePath = "${HOST_BRIDGE_ROUTE}"`), 'initial page loads the pinned host bridge route');
  });
} else {
  test.skip('optional live host source compatibility (set SESSION_DATE_FILTER_HOST_ROOT to enable)', () => {});
}

test('actual page app reads root HTML bootstrap token and renders localized real timestamps', { skip: typeof Bun === 'undefined' }, async () => {
  let authCorrect = false;
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  try {
    const ui = await loadActualPageApp(service, { onFetch: (_url, init) => { authCorrect ||= init?.headers?.Authorization === `Bearer ${HOST_TOKEN}`; } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ui.appToken, ui.win.__SESSION_DATE_FILTER__.token, 'the entry must initialize from the bootstrap, not query parameters');
    assert.equal(authCorrect, true, 'the real app fetch must use the bootstrap Bearer token');
    assert.equal(ui.elements.get('status').dataset.state, 'ok', 'the real app must read the authenticated statistics API');
    assert.equal(ui.elements.get('refresh').disabled, false);
    assert.equal(ui.elements.get('refresh').getAttribute('aria-busy'), 'false');
    assert.equal(ui.elements.get('total').textContent, '4');
    assert.ok(ui.elements.get('started').textContent.length > 0, 'non-null dates must pass Intl formatting');
    assert.equal(ui.elements.get('started').title, good.stats.startedAt, 'retain the original UTC timestamp for precise inspection');
    assert.equal(ui.html.dataset.theme, 'dark');
    assert.equal(ui.html.lang, 'zh-CN');
    ui.cleanup();
  } finally { await service.stop(); }
});

test('actual page entry preserves degraded counters through stale failure and recovers on refresh', { skip: typeof Bun === 'undefined' }, async () => {
  const degraded = { ...good, status: 'degraded', stats: { ...good.stats, removedLines: 5 } };
  const recovered = { ...good, stats: { ...good.stats, removedLines: 7, updatedAt: '2026-11-05T02:05:04.000Z' } };
  let current = degraded;
  let failRequests = false;
  const service = createService({ store: { snapshot: () => current }, port: 0, token: HOST_TOKEN });
  const ui = await loadActualPageApp(service, {
    onFetch: (url) => {
      if (failRequests && String(url).includes('/api/stats')) throw new Error('synthetic network failure');
    },
  });
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 1500;
    while (!predicate()) {
      if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    const values = () => Object.fromEntries(['total', 'processed', 'matched', 'unmatched'].map((id) => [id, ui.elements.get(id).textContent]));
    await waitFor(() => ui.elements.get('status').dataset.state === 'degraded', 'degraded API snapshot');
    assert.deepEqual(values(), { total: '5', processed: '3', matched: '2', unmatched: '1' });
    assert.match(ui.elements.get('status').textContent, /存储降级/);

    failRequests = true;
    ui.elements.get('refresh').fire('click');
    await waitFor(() => ui.elements.get('status').dataset.state === 'stale', 'stale state after API failure');
    assert.deepEqual(values(), { total: '5', processed: '3', matched: '2', unmatched: '1' }, 'stale must retain all last-read counters');
    assert.match(ui.elements.get('status').textContent, /显示旧数据/);
    assert.match(ui.elements.get('stale').textContent, /上次成功读取/);

    current = recovered;
    failRequests = false;
    ui.elements.get('refresh').fire('click');
    await waitFor(() => ui.elements.get('status').dataset.state === 'ok' && ui.elements.get('total').textContent === '7', 'successful refresh recovery');
    assert.equal(ui.elements.get('stale').textContent, '', 'recovery clears the stale warning');
    assert.deepEqual(values(), { total: '7', processed: '3', matched: '2', unmatched: '1' });
  } finally { ui.cleanup(); await service.stop(); }
});

test('actual page entry renders a non-null timestamp without Intl option errors', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const ui = await loadActualPageApp(service, { mockStats: true, captureRenderErrors: true, mockBridge: true, legacyQueryToken: true, appSourceOverride: await (await fetch(new URL('/app.mjs', service.server.url), { headers: { Origin: 'null' } })).text() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ui.win.__renderError, undefined, 'the real entry rendering callback must not throw for a valid timestamp');
    assert.deepEqual(unhandled, [], 'the real entry must not reject while rendering a valid timestamp');
    assert.ok(ui.elements.get('started').textContent.length > 0);
    assert.equal(ui.elements.get('started').title, good.stats.startedAt);
    ui.cleanup();
  } finally { process.off('unhandledRejection', onUnhandled); await service.stop(); }
});

test('malformed runtime bootstrap fails closed without requesting stats', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  let calls = 0;
  try {
    const ui = await loadActualPageApp(service, { bootstrapOverride: { token: 'not-a-token', theme: 'dark', lang: 'zh-CN' }, onFetch: () => { calls++; } });
    assert.equal(ui.elements.get('status').dataset.state, 'unavailable');
    assert.equal(ui.elements.get('refresh').disabled, true);
    assert.equal(ui.elements.get('refresh').getAttribute('aria-busy'), 'false');
    assert.equal(ui.elements.get('total').textContent, '—');
    assert.equal(calls, 0, 'malformed bootstrap must stop before making an API request');
    ui.cleanup();
  } finally { await service.stop(); }
});

test('a rejected bootstrap bearer token shows unavailable without rendering zeroes', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  let calls = 0;
  try {
    const ui = await loadActualPageApp(service, { bootstrapOverride: { token: BAD_TOKEN, theme: 'dark', lang: 'zh-CN' }, onFetch: () => { calls++; } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(ui.elements.get('status').dataset.state, 'unavailable');
    assert.equal(ui.elements.get('total').textContent, '—');
    assert.equal(calls, 1, 'the bearer token is only attempted against the fixed authenticated API');
    ui.cleanup();
  } finally { await service.stop(); }
});

test('module assets allow only the sandbox null origin and vary by origin', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  try {
    for (const path of ['/app.mjs', '/page-bridge.mjs', '/stats-ui.mjs']) {
      const response = await fetch(new URL(path, service.server.url), { headers: { Origin: 'null' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), 'null');
      assert.match(response.headers.get('vary') || '', /Origin/i);
    }
    const denied = await fetch(new URL('/app.mjs', service.server.url), { headers: { Origin: 'https://not-the-host.example' } });
    assert.equal(denied.status, 403);
  } finally { await service.stop(); }
});

test('poller resumes with repeated reads and onUpdate callbacks, then stops completely', async () => {
  let visible = true, reads = 0, updates = 0;
  const poller = createStatsPoller({ fetcher: async () => { reads++; return { ok: true, json: async () => good }; }, getVisible: () => visible, timeoutMs: 100 });
  poller.start(12, () => { updates++; });
  await new Promise((resolve) => setTimeout(resolve, 35));
  poller.setVisible(false); visible = false;
  const hiddenReads = reads, hiddenUpdates = updates;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(reads, hiddenReads); assert.equal(updates, hiddenUpdates);
  visible = true; poller.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 58));
  assert.ok(reads >= hiddenReads + 3, `resumed recurring reads: before=${hiddenReads}, after=${reads}`);
  assert.ok(updates >= hiddenUpdates + 3, `resumed render callbacks: before=${hiddenUpdates}, after=${updates}`);
  poller.stop(); const stoppedReads = reads, stoppedUpdates = updates;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(reads, stoppedReads); assert.equal(updates, stoppedUpdates);
});

test('visibility returning during a request triggers one immediate follow-up without overlap', async () => {
  let visible = true, calls = 0, active = 0, maxActive = 0, resolveFirst;
  const poller = createStatsPoller({ fetcher: () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    if (calls === 1) return new Promise((resolve) => { resolveFirst = () => { active--; resolve({ ok: true, json: async () => good }); }; });
    active--;
    return Promise.resolve({ ok: true, json: async () => good });
  }, getVisible: () => visible, timeoutMs: 500 });
  poller.start(1000, () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  poller.setVisible(false); visible = false;
  visible = true; poller.setVisible(true);
  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(calls, 2, 'the hidden-to-visible recovery should immediately schedule one follow-up');
  assert.equal(maxActive, 1, 'the in-flight request must finish before the recovery request starts');
  poller.stop();
});

test('synchronous fetcher throw releases the single-flight slot for retry', async () => {
  let calls = 0;
  const poller = createStatsPoller({ fetcher: () => { if (++calls === 1) throw new Error('offline'); return Promise.resolve({ ok: true, json: async () => good }); } });
  assert.equal((await poller.refresh()).kind, 'unavailable');
  assert.equal((await poller.refresh()).kind, 'ok');
  assert.equal(calls, 2);
  poller.stop();
});

test('root rejects non-read methods before rendering bootstrap; assets and root remain read-only', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  try {
    const rootUrl = new URL('/', service.server.url);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(rootUrl, { method, body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? 'synthetic' : undefined });
      assert.equal(response.status, 405, `${method} / must be denied`);
      assert.doesNotMatch(await response.text(), /__SESSION_DATE_FILTER__/);
    }
    assert.equal((await fetch(rootUrl, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(new URL('/style.css?x=1', service.server.url))).status, 404);
  } finally { await service.stop(); }
});
