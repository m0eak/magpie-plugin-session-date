const COUNT_FIELDS = ['processedRequests', 'matchedRequests', 'removedLines', 'unmatchedRequests'];
const TIME_FIELDS = ['startedAt', 'updatedAt', 'lastMatchedAt'];
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function validTimestamp(value) {
  return value === null || (typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}

export function validateStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !['ok', 'degraded'].includes(value.status)) throw new TypeError('Invalid statistics response.');
  const source = value.stats;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Invalid statistics response.');
  for (const key of COUNT_FIELDS) if (!Number.isSafeInteger(source[key]) || source[key] < 0) throw new TypeError('Invalid statistics response.');
  if (source.matchedRequests > source.processedRequests || source.unmatchedRequests !== source.processedRequests - source.matchedRequests || source.removedLines < source.matchedRequests) throw new TypeError('Invalid statistics response.');
  for (const key of TIME_FIELDS) if (!validTimestamp(source[key])) throw new TypeError('Invalid statistics response.');
  if (source.processedRequests === 0 && (source.startedAt !== null || source.updatedAt !== null || source.lastMatchedAt !== null)) throw new TypeError('Invalid statistics response.');
  if (source.processedRequests > 0 && (source.startedAt === null || source.updatedAt === null)) throw new TypeError('Invalid statistics response.');
  if ((source.matchedRequests === 0) !== (source.lastMatchedAt === null)) throw new TypeError('Invalid statistics response.');
  if (value.persistence != null && typeof value.persistence !== 'string') throw new TypeError('Invalid statistics response.');
  return value;
}

export function createStatsPoller({ fetcher = fetch, url = '/api/stats', getVisible = () => true, timeoutMs = 4000 } = {}) {
  let inFlight = null;
  let timer = null;
  let stopped = false;
  let started = false;
  let visible = getVisible();
  const state = { snapshot: null, kind: 'loading', error: '' };
  const poller = {
    state,
    refresh() {
      if (!visible || !getVisible()) return Promise.resolve({ kind: 'paused' });
      if (inFlight) return inFlight;
      state.kind = state.snapshot ? 'refreshing' : 'loading';
      const request = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${serviceToken}` }, signal: controller.signal, cache: 'no-store' });
          if (!response?.ok) throw new Error('service unavailable');
          const next = validateStats(await response.json());
          state.snapshot = next;
          state.kind = next.status === 'ok' ? 'ok' : 'degraded';
          state.error = '';
          return { kind: state.kind, snapshot: next };
        } catch {
          state.kind = state.snapshot ? 'stale' : 'unavailable';
          state.error = '统计服务暂不可用';
          return { kind: state.kind, snapshot: state.snapshot };
        } finally {
          clearTimeout(timeout);
          inFlight = null;
        }
      })();
      inFlight = request;
      return request;
    },
    setVisible(next) {
      visible = next === true;
      if (visible && started && !timer && !inFlight && !stopped) timer = setTimeout(() => { timer = null; void poller.refresh(); }, 0);
      if (!visible && timer) { clearTimeout(timer); timer = null; }
    },
    start(intervalMs = 5000, onUpdate = () => {}) {
      if (started) return;
      started = true;
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        if (visible && getVisible()) onUpdate(await poller.refresh());
        if (!visible || stopped) return;
        timer = setTimeout(tick, intervalMs);
      };
      void tick();
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
  return poller;
}

let serviceToken = '';
export function setServiceToken(token) { serviceToken = typeof token === 'string' ? token : ''; }
