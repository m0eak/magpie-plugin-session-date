import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createPageBridge } from '../src/page-bridge.mjs';
import { createStatsPoller, setServiceToken as setPollerToken } from '../src/stats-ui.mjs';
import { createService } from '../src/service-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = resolve(root, '../magpie');
const hostBridge = await readFile(resolve(hostRoot, 'internal/gui/pagebridge.js'), 'utf8');
const hostPages = await readFile(resolve(hostRoot, 'internal/gui/assets/pluginpages.js'), 'utf8');
const hostPluginPage = await readFile(resolve(hostRoot, 'internal/gui/pluginpage.go'), 'utf8');
const hostMarker = hostBridge.match(/postMessage\(\{\s*([\w$]+):\s*1,\s*id,\s*method,\s*params\s*\}/)?.[1];
assert.ok(hostMarker, 'read the bridge marker from the checked-out host source');
assert.match(hostPages, /case "hello"[\s\S]*?service: \(!p\.context && e\.service\)/, 'host hello returns the page service through the host bridge');
assert.match(hostPluginPage, /const pluginBridgePath = "_magpie\/bridge\.js"/, 'initial page loads the actual host bridge route');
const hostTokenPrefix = `--${hostMarker}-`;
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

async function loadActualPageApp(service, { bootstrapOverride, onFetch, appSourceOverride, mockStats = false, captureRenderErrors = false } = {}) {
  const response = await fetch(new URL('/?theme=dark&lang=zh-CN', service.server.url));
  const html = await response.text();
  const bootstrapCode = html.match(/<script nonce="[^"]+">(window\.__SESSION_DATE_FILTER__=[^<]+)<\/script>/)?.[1];
  assert.ok(bootstrapCode, 'root HTML must contain the nonce-bound runtime bootstrap');
  const bootstrapToken = JSON.parse(bootstrapCode.slice('window.__SESSION_DATE_FILTER__='.length)).token;
  const token = bootstrapToken;
  const ui = makeDocument();
  const listeners = new Map();
  const messageListeners = new Set();
  const host = { postMessage(message) { if (message?.[hostMarker] === 1 && message.method === 'hello') queueMicrotask(() => { for (const fn of messageListeners) fn({ source: host, data: { [hostMarker]: 1, id: message.id, result: { dark: true, lang: 'zh-CN', tokens: { bg: '#101010' }, service: service.server.url, visible: true } } }); }); } };
  const win = { __SESSION_DATE_FILTER__: bootstrapOverride ?? undefined, parent: host, addEventListener(type, fn) { listeners.set(type, fn); } };
  const requestFetch = (url, init) => {
    onFetch?.(url, init);
    if (!mockStats && String(url).includes('/api/stats') && init?.headers?.Authorization === `Bearer ${BAD_TOKEN}`) return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) });
    if (mockStats && String(url).includes('/api/stats')) return Promise.resolve({ ok: true, json: async () => good });
    return fetch(new URL(url, service.server.url), { ...init, headers: { ...(init?.headers || {}), Origin: 'null' } });
  };
  const context = vm.createContext({
    document: ui.document, window: win, parent: host, location: { href: service.server.url }, fetch: requestFetch,
    addEventListener(type, fn) { if (type === 'message') messageListeners.add(fn); else listeners.set(type, fn); },
    removeEventListener(type, fn) { if (type === 'message') messageListeners.delete(fn); else listeners.delete(type); },
    setTimeout, clearTimeout, URL, Intl, Date, String, Object, Number, Error, Promise, AbortController, console,
    __deps: null,
  });
  context.__deps = { createPageBridge: (options) => createPageBridge({ ...options, selfWindow: context, parentWindow: host }), createStatsPoller: (options) => { const poller = createStatsPoller({ ...options, fetcher: requestFetch }); if (captureRenderErrors) { const start = poller.start.bind(poller); poller.start = (interval, callback) => start(interval, (result) => { try { callback(result); } catch (error) { win.__renderError = error; } }); } return poller; }, setServiceToken: (value) => { if (typeof value === 'string') { context.__appToken = value; setPollerToken(value); } } };
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

test('bridge uses the exact namespace and theme tokens from the checked-out host', async () => {
  const listeners = new Set(); const rootElement = { dataset: {}, style: { colorScheme: '', vars: {}, setProperty(key, value) { this.vars[key] = value; } }, lang: '' };
  const self = { parent: null, document: { documentElement: rootElement }, addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); } };
  const sent = []; const parent = { postMessage(message) { sent.push(message); } }; self.parent = parent;
  const bridge = createPageBridge({ selfWindow: self, parentWindow: parent, timeoutMs: 30 });
  assert.equal(sent[0]?.[hostMarker], 1, 'hello marker must match host pagebridge.js');
  const hello = sent[0];
  for (const fn of listeners) fn({ source: parent, data: { [hostMarker]: 1, id: hello.id, result: { dark: true, lang: 'zh-CN', tokens: { bg: '#101010' }, visible: true } } });
  await bridge.ready;
  assert.equal(rootElement.style.vars[`${hostTokenPrefix}bg`], '#101010');
  const initialPage = await readFile(resolve(root, 'page/index.html'), 'utf8');
  assert.match(initialPage, /--[^\s]+-font/, 'initial page must use the host font variable');
  for (const path of ['page/style.css', 'page/index.html']) {
    const source = await readFile(resolve(root, path), 'utf8');
    assert.ok(source.includes(`--${hostMarker}-`), `${path} theme tokens must match host pagebridge.js`);
  }
  bridge.stop();
});

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

test('actual page entry renders a non-null timestamp without Intl option errors', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  try {
    const ui = await loadActualPageApp(service, { mockStats: true, captureRenderErrors: true, appSourceOverride: await (await fetch(new URL('/app.mjs', service.server.url), { headers: { Origin: 'null' } })).text() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ui.win.__renderError, undefined, 'the real entry rendering callback must not throw for a valid timestamp');
    assert.ok(ui.elements.get('started').textContent.length > 0);
    assert.equal(ui.elements.get('started').title, good.stats.startedAt);
    ui.cleanup();
  } finally { await service.stop(); }
});

test('malformed runtime bootstrap shows unavailable and never reports empty statistics', { skip: typeof Bun === 'undefined' }, async () => {
  const service = createService({ store: { snapshot: () => good }, port: 0, token: HOST_TOKEN });
  let calls = 0;
  try {
    const ui = await loadActualPageApp(service, { bootstrapOverride: { token: BAD_TOKEN, theme: 'dark', lang: 'zh-CN' }, onFetch: () => { calls++; } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(ui.elements.get('status').dataset.state, 'unavailable');
    assert.equal(ui.elements.get('refresh').getAttribute('aria-busy'), 'false');
    assert.equal(ui.elements.get('total').textContent, '—');
    assert.equal(calls, 1, 'an invalid token is sent only to the fixed authenticated API');
    assert.equal(ui.elements.get('total').textContent, '—', 'failed bootstrap authentication must not render zero statistics');
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
