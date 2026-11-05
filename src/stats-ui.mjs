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

export function createStatsPoller({ fetcher = fetch, url = '/api/stats', getVisible = () => true, timeoutMs = 4000, onState = () => {} } = {}) {
  let inFlight = null;
  let timer = null;
  let stopped = false;
  let started = false;
  let visible = getVisible();
  let intervalMs = 5000;
  let onUpdate = () => {};
  let refreshOnResume = false;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const schedule = (delay = intervalMs) => {
    if (!started || stopped || !visible || !getVisible() || timer || inFlight) return;
    timer = setTimeout(() => { timer = null; void tick(); }, delay);
  };
  const state = { snapshot: null, kind: 'loading', error: '' };
  async function tick() {
    if (stopped || !started || !visible || !getVisible()) return;
    const result = await poller.refresh();
    if (stopped) return;
    if (visible && getVisible()) { try { onUpdate(result); } catch { /* UI rendering cannot break the timer. */ } }
    schedule();
  }
  const poller = {
    state,
    refresh() {
      if (stopped || !visible || !getVisible()) return Promise.resolve({ kind: 'paused' });
      if (inFlight) return inFlight;
      state.kind = state.snapshot ? 'refreshing' : 'loading';
      try { onState(state.kind); } catch { /* UI state cannot break polling. */ }
      const request = Promise.resolve().then(async () => {
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
          try { onState(state.kind); } catch { /* UI state cannot break polling. */ }
          if (inFlight === request) inFlight = null;
          const delay = refreshOnResume ? 0 : intervalMs;
          refreshOnResume = false;
          schedule(delay);
        }
      });
      inFlight = request;
      return request;
    },
    setVisible(next) {
      visible = next === true;
      if (visible) {
        if (inFlight) refreshOnResume = true;
        else schedule(0);
      } else {
        refreshOnResume = false;
        clearTimer();
      }
    },
    start(nextIntervalMs = 5000, update = () => {}) {
      if (started) return;
      started = true;
      stopped = false;
      intervalMs = Number.isFinite(nextIntervalMs) && nextIntervalMs >= 0 ? nextIntervalMs : 5000;
      onUpdate = typeof update === 'function' ? update : () => {};
      void tick();
    },
    stop() { stopped = true; clearTimer(); },
  };
  return poller;
}

let serviceToken = '';
export function setServiceToken(token) { serviceToken = typeof token === 'string' ? token : ''; }
