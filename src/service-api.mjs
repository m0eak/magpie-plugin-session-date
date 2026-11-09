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
const EMPTY_STATS = Object.freeze({ processedRequests: 0, matchedRequests: 0, removedLines: 0, unmatchedRequests: 0, startedAt: null, updatedAt: null, lastMatchedAt: null });
const NONCE = /^[a-f0-9]{64}$/i;

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

export function createService({ store, port = 3479, token = '' } = {}) {
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
    const isApi = url.pathname === '/api/stats' || url.pathname === '/health';
    const isRoot = url.pathname === '/';
    const isAsset = ASSETS.has(url.pathname);
    if (!isApi && !isRoot && !isAsset) return jsonResponse({ error: 'Not found' }, 404);
    if ((isRoot || isAsset) && request.method !== 'GET' && request.method !== 'HEAD') return jsonResponse({ error: 'Method not allowed' }, 405);
    if (isAsset && url.search) return jsonResponse({ error: 'Not found' }, 404);
    const cors = {
      'access-control-allow-origin': origin ?? `http://${host}`,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      if (!isApi) return jsonResponse({ error: 'Method not allowed' }, 405, cors);
      if (url.search) return jsonResponse({ error: 'Not found' }, 404);
      const requested = request.headers.get('access-control-request-method');
      const requestedHeaders = (request.headers.get('access-control-request-headers') || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      if ((requested && requested !== 'GET') || requestedHeaders.some((header) => !['authorization', 'content-type'].includes(header))) return jsonResponse({ error: 'Method not allowed' }, 405, cors);
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
  return { server, async stop() { if (stopped) return; stopped = true; try { server.stop(true); } catch {} } };
}
