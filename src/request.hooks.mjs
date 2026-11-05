import { filterRequest } from './protocols.mjs';
import { getStatsStore } from './stats-store.mjs';
import { inspectRequestBody } from './request-measurement.mjs';

const SUPPORTED = new Set(['chat', 'responses', 'anthropic', 'gemini']);
/** Build the public async onRequest hook with narrow dependency injection. */
export function createRequestHook({ store = getStatsStore, protocols = { filterRequest }, now = () => new Date() } = {}) {
  return async function onRequest(body, ctx) {
    const protocol = ctx?.protocol;
    if (!SUPPORTED.has(protocol)) return undefined;
    const measurement = inspectRequestBody(body, protocol);
    if (!measurement.valid || !measurement.measurable) return undefined;

    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    const at = Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
    const recordStats = (event) => {
      try {
        queueMicrotask(() => recordBestEffort(store, event));
      } catch {
        // Preserve the transform if the runtime cannot queue statistics work.
      }
    };
    let result;
    try {
      result = protocols.filterRequest(body, protocol);
    } catch {
      recordStats({ matched: false, removedLines: 0, at });
      return undefined;
    }
    if (!result?.supported || !Number.isSafeInteger(result.removedLines) || result.removedLines < 0) return undefined;

    const matched = result.removedLines > 0;
    recordStats({ matched, removedLines: result.removedLines, at });
    return matched ? result.body : undefined;
  };
}

function recordBestEffort(storeOrGetter, event) {
  try {
    const store = typeof storeOrGetter === 'function' ? storeOrGetter() : storeOrGetter;
    store?.record?.(event);
  } catch {
    // Statistics failures never affect request content or gateway routing.
  }
}

export const onRequest = createRequestHook();
