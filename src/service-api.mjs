function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

/**
 * Start a GET-only stats service on the loopback interface.
 * In the host use this from the plugin's server(input, options) function.
 */
export function createService({ store, port = 3479 } = {}) {
  if (!store || typeof store.snapshot !== 'function') throw new TypeError('A stats store is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid service port.');
  if (typeof Bun === 'undefined' || typeof Bun.serve !== 'function') throw new Error('Service requires Bun.');

  let server;
  const fetchHandler = async (request) => {
    const url = new URL(request.url);
    const host = `127.0.0.1:${server.port}`;
    const requestHost = request.headers.get('host');
    const origin = request.headers.get('origin');
    if (requestHost !== host) return jsonResponse({ error: 'Forbidden' }, 403);
    if (origin != null && origin !== 'null' && origin !== `http://${host}`) return jsonResponse({ error: 'Forbidden' }, 403);
    const cors = {
      'access-control-allow-origin': origin ?? `http://${host}`,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      const requested = request.headers.get('access-control-request-method');
      if (requested && requested !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    if (url.pathname !== '/api/stats' && url.pathname !== '/health') return jsonResponse({ error: 'Not found' }, 404, cors);
    if (url.search) return jsonResponse({ error: 'Not found' }, 404, cors);
    if (url.pathname === '/health') return jsonResponse({ status: store.snapshot().status }, 200, cors);
    try {
      return jsonResponse(store.snapshot(), 200, cors);
    } catch {
      return jsonResponse({ schemaVersion: 1, status: 'degraded', stats: {
        processedRequests: 0, matchedRequests: 0, removedLines: 0, unmatchedRequests: 0,
        startedAt: null, updatedAt: null, lastMatchedAt: null,
      } }, 200, cors);
    }
  };
  server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: fetchHandler });
  let stopped = false;
  return {
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      try { server.stop(true); } catch {}
    },
  };
}
