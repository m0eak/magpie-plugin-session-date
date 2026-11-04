import { filterRequest } from './protocols.mjs';
import { getStatsStore } from './stats-store.mjs';

const SUPPORTED = new Set(['chat', 'responses', 'anthropic', 'gemini']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isLegalBody(body, protocol) {
  if (!isRecord(body)) return false;
  switch (protocol) {
    case 'chat': return Array.isArray(body.messages);
    case 'responses': return Array.isArray(body.input) || typeof body.instructions === 'string';
    case 'anthropic': return Array.isArray(body.messages) && (body.system === undefined || typeof body.system === 'string' || Array.isArray(body.system));
    case 'gemini': return Array.isArray(body.contents) || isRecord(body.systemInstruction);
    default: return false;
  }
}

/** Build the public async onRequest hook with narrow dependency injection. */
export function createRequestHook({ store = getStatsStore, protocols = { filterRequest }, now = () => new Date() } = {}) {
  return async function onRequest(body, ctx) {
    const protocol = ctx?.protocol;
    if (!SUPPORTED.has(protocol) || !isLegalBody(body, protocol)) return undefined;

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
