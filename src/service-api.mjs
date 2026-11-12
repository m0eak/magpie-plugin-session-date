import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ASSETS = new Map([
  ['/app.mjs', ['../page/app.mjs', 'text/javascript; charset=utf-8']],
  ['/boot.js', ['../page/boot.js', 'text/javascript; charset=utf-8']],
  ['/page-bridge.mjs', ['../src/page-bridge.mjs', 'text/javascript; charset=utf-8']],
  ['/stats-ui.mjs', ['../src/stats-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['../page/style.css', 'text/css; charset=utf-8']],
]);
const EMPTY_STATS = Object.freeze({ processedRequests: 0, matchedRequests: 0, removedLines: 0, unmatchedRequests: 0, dateMatchedRequests: 0, dateRemovedLines: 0, topicTitleMatchedRequests: 0, topicTitleRemovedLines: 0, availableAgentsMatchedRequests: 0, availableAgentsReplacedBlocks: 0, timeGuidanceInsertedBlocks: 0, startedAt: null, updatedAt: null, lastMatchedAt: null });
const NONCE = /^[a-f0-9]{64}$/i;
const DEBUG_EMPTY_STATUS = Object.freeze({
  state: 'config_unavailable', directory: null, queuedRequests: 0,
  writtenRequests: 0, droppedRequests: 0, lastWriteAt: null,
  lastErrorCode: 'debug-config-unavailable',
});
const DEBUG_CODES = new Set(['queue-full', 'write-failed', 'capacity-unavailable', 'lock-timeout', 'event-error', 'directory-unavailable']);
const fixedDebugCode = (reason) => DEBUG_CODES.has(reason) ? reason : 'debug-write-failed';

function getDebugStatus(debugConfigStore, debugWriter, enabled) {
  const config = debugConfigStore?.status?.() ?? { available: false };
  const writer = debugWriter?.status?.() ?? {};
  const configUnavailable = config.available !== true;
  const writerFailed = writer.state === 'degraded' || Boolean(writer.reason);
  return {
    state: configUnavailable ? 'config_unavailable' : writerFailed ? 'degraded' : enabled ? 'ready' : 'disabled',
    directory: typeof writer.directory === 'string' ? writer.directory : null,
    queuedRequests: Number.isSafeInteger(writer.queuedRequests) ? writer.queuedRequests : 0,
    writtenRequests: Number.isSafeInteger(writer.writtenRequests) ? writer.writtenRequests : 0,
    droppedRequests: Number.isSafeInteger(writer.droppedRequests) ? writer.droppedRequests : 0,
    lastWriteAt: typeof writer.lastWriteAt === 'string' ? writer.lastWriteAt : null,
    lastErrorCode: configUnavailable ? 'debug-config-unavailable' : writerFailed ? fixedDebugCode(writer.reason) : null,
  };
}

export class ServiceListenError extends Error {
  constructor() { super('Statistics listener could not be started.'); this.name = 'ServiceListenError'; this.reasonCode = 'address-in-use'; }
}
function response(body, status, headers = {}) {
  return new Response(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
function jsonResponse(body, status, headers = {}) {
  return response(JSON.stringify(body), status, { 'content-type': 'application/json; charset=utf-8', ...headers });
}
function validateUiOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.hostname.includes('*')) return null;
    return value;
  } catch { return null; }
}

export function createService({ store, configStore, debugConfigStore, debugWriter, port = 3479, token = '' } = {}) {
  if (!store || typeof store.snapshot !== 'function') throw new TypeError('A stats store is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid service port.');
  if (token && !NONCE.test(token)) throw new TypeError('Invalid service token.');
  if (typeof Bun === 'undefined' || typeof Bun.serve !== 'function') throw new Error('Service requires Bun.');
  let server;
  const fetchHandler = async (request) => {
    const url = new URL(request.url);
    const host = `127.0.0.1:${server.port}`;
    const requestHost = request.headers.get('host');
    const origin = request.headers.get('origin');
    if (requestHost !== host) return jsonResponse({ error: 'Forbidden' }, 403);
    if (origin != null && origin !== 'null' && origin !== `http://${host}`) return jsonResponse({ error: 'Forbidden' }, 403);
    const isApi = url.pathname === '/api/stats' || url.pathname === '/api/settings' || url.pathname === '/api/debug' || url.pathname === '/health';
    const isRoot = url.pathname === '/';
    const isAsset = ASSETS.has(url.pathname);
    if (!isApi && !isRoot && !isAsset) return jsonResponse({ error: 'Not found' }, 404);
    if ((isRoot || isAsset) && request.method !== 'GET' && request.method !== 'HEAD') return jsonResponse({ error: 'Method not allowed' }, 405);
    if (isAsset && url.search) return jsonResponse({ error: 'Not found' }, 404);
    const cors = {
      'access-control-allow-origin': origin ?? `http://${host}`,
      'access-control-allow-methods': url.pathname === '/api/settings' ? 'GET, PUT, PATCH, OPTIONS' : 'GET, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      if (!isApi) return jsonResponse({ error: 'Method not allowed' }, 405, cors);
      if (url.search) return jsonResponse({ error: 'Not found' }, 404);
      const requested = request.headers.get('access-control-request-method');
      const requestedHeaders = (request.headers.get('access-control-request-headers') || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      if ((requested && !['GET', 'PUT', 'PATCH'].includes(requested)) || requestedHeaders.some((header) => !['authorization', 'content-type'].includes(header))) return jsonResponse({ error: 'Method not allowed' }, 405, cors);
      return new Response(null, { status: 204, headers: cors });
    }
    if (isApi && url.search) return jsonResponse({ error: 'Not found' }, 404, cors);
    if (isRoot) {
      const allowed = new Set(['uiOrigin', 'theme', 'lang']);
      if ([...url.searchParams.keys()].some((key) => !allowed.has(key)) || [...allowed].some((key) => url.searchParams.getAll(key).length > 1)) return jsonResponse({ error: 'Not found' }, 404);
      const uiOrigin = validateUiOrigin(url.searchParams.get('uiOrigin') || '');
      if (uiOrigin === null) return jsonResponse({ error: 'Invalid UI origin' }, 400);
      const theme = ['dark', 'light'].includes(url.searchParams.get('theme')) ? url.searchParams.get('theme') : 'light';
      const lang = (url.searchParams.get('lang') || 'en').slice(0, 24);
      try {
        let html = await readFile(fileURLToPath(new URL('../page/service.html', import.meta.url)), 'utf8');
        const nonce = randomBytes(18).toString('base64');
        const bootstrap = JSON.stringify({ token, theme, lang }).replaceAll('<', '\\u003c');
        html = html.replace('<head>', `<head>\n  <script nonce="${nonce}">window.__SESSION_DATE_FILTER__=${bootstrap}</script>`);
        const connect = ["'self'", ...(uiOrigin ? [uiOrigin] : [])].join(' ');
        return response(request.method === 'HEAD' ? null : html, 200, {
          'content-type': 'text/html; charset=utf-8',
          'referrer-policy': 'no-referrer',
          'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; connect-src ${connect}; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`,
        });
      } catch { return jsonResponse({ error: 'Asset unavailable' }, 503); }
    }
    if (url.pathname === '/api/settings') {
      if (!token || request.headers.get('authorization') !== `Bearer ${token}`) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
      if (request.method === 'GET') {
        const settings = configStore?.snapshot?.();
        return settings ? jsonResponse({ settings }, 200, cors) : jsonResponse({ error: 'Settings storage unavailable.' }, 503, cors);
      }
      if (request.method !== 'PUT' && request.method !== 'PATCH') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
      let value;
      try { value = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400, cors); }
      const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
      const validPatch = keys.length > 0 && keys.every((key) => ['sessionDate', 'topicTitle', 'availableAgents'].includes(key) && typeof value[key] === 'boolean');
      const validFull = keys.length === 3 && validPatch;
      if (request.method === 'PATCH' && !validPatch) return jsonResponse({ error: 'Settings patch must contain known boolean fields.' }, 400, cors);
      if (request.method === 'PUT' && !validFull) return jsonResponse({ error: 'All settings must be booleans.' }, 400, cors);
      try {
        const settings = request.method === 'PATCH' ? await configStore.update(value) : await configStore.replace(value);
        return jsonResponse({ settings }, 200, cors);
      }
      catch { return jsonResponse({ error: 'Settings could not be saved.' }, 503, cors); }
    }
    if (url.pathname === '/api/debug') {
      if (!token || request.headers.get('authorization') !== `Bearer ${token}`) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
      if (request.method === 'GET') {
        try {
          const settings = debugConfigStore?.snapshot?.();
          if (!settings || typeof settings.enabled !== 'boolean') {
            return jsonResponse({ settings: null, status: { ...DEBUG_EMPTY_STATUS, ...getDebugStatus(debugConfigStore, debugWriter, false) }, error: 'debug-config-unavailable' }, 503, cors);
          }
          return jsonResponse({ settings, status: getDebugStatus(debugConfigStore, debugWriter, settings.enabled) }, 200, cors);
        } catch {
          return jsonResponse({ settings: null, status: DEBUG_EMPTY_STATUS, error: 'debug-config-unavailable' }, 503, cors);
        }
      }
      if (request.method !== 'PUT') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
      let value;
      try { value = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400, cors); }
      if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') return jsonResponse({ error: 'Debug settings must contain only an enabled boolean.' }, 400, cors);
      try {
        const settings = await debugConfigStore.replace(value);
        try { debugWriter?.setEnabled?.(value.enabled); } catch { /* Writer failure is reported in status and does not undo config persistence. */ }
        return jsonResponse({ settings, status: getDebugStatus(debugConfigStore, debugWriter, value.enabled) }, 200, cors);
      } catch {
        return jsonResponse({ error: 'debug-config-save-failed', settings: null, status: DEBUG_EMPTY_STATUS }, 503, cors);
      }
    }
    if (isApi && request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    if (url.pathname === '/api/stats') {
      if (token && request.headers.get('authorization') !== `Bearer ${token}`) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
      try { return jsonResponse(store.snapshot(), 200, cors); }
      catch { return jsonResponse({ schemaVersion: 1, status: 'degraded', stats: EMPTY_STATS, persistence: 'Statistics storage is unavailable.' }, 200, cors); }
    }
    if (url.pathname === '/health') {
      try { return jsonResponse({ status: store.snapshot().status }, 200, cors); }
      catch { return jsonResponse({ status: 'degraded' }, 200, cors); }
    }
    const [relative, contentType] = ASSETS.get(url.pathname);
    try {
      const body = await readFile(fileURLToPath(new URL(relative, import.meta.url)));
      const headers = { 'content-type': contentType, vary: 'Origin' };
      if (origin === 'null') headers['access-control-allow-origin'] = 'null';
      return response(request.method === 'HEAD' ? null : body, 200, headers);
    } catch { return jsonResponse({ error: 'Asset unavailable' }, 503); }
  };
  try { server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: fetchHandler }); }
  catch (error) {
    let code;
    try { code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined; }
    catch { throw error; }
    if (code === 'EADDRINUSE') throw new ServiceListenError();
    throw error;
  }
  let stopped = false;
  return {
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      try { server.stop(true); } catch {}
      try { await debugWriter?.close?.(); } catch {}
      try { debugConfigStore?.close?.(); } catch {}
    },
  };
}
