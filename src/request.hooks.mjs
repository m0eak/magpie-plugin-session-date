import { filterRequest } from './protocols.mjs';
import { getStatsStore } from './stats-store.mjs';
import { inspectRequestBody } from './request-measurement.mjs';
import { getFilterConfig } from './filter-config.mjs';
import { getDebugConfig } from './debug-config.mjs';
import { getDebugWriter } from './debug-writer.mjs';

const SUPPORTED = new Set(['chat', 'responses', 'anthropic', 'gemini']);
/** Build the public async onRequest hook with narrow dependency injection. */
export function createRequestHook({ store = getStatsStore, config = getFilterConfig, debugConfig = getDebugConfig, debugWriter = getDebugWriter, protocols = { filterRequest }, now = () => new Date() } = {}) {
  return async function onRequest(body, ctx) {
    const protocol = ctx?.protocol;
    if (!SUPPORTED.has(protocol)) return undefined;
    const measurement = inspectRequestBody(body, protocol);
    if (!measurement.valid) return undefined;

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
    let debugSettings = null;
    let writer = null;
    try {
      debugSettings = debugConfig()?.snapshot?.() ?? null;
    } catch { /* Debug config failures must never short-circuit filtering. */ }
    try {
      writer = typeof debugWriter === 'function' ? debugWriter() : debugWriter;
      writer?.setEnabled?.(debugSettings?.enabled === true);
    } catch { /* A broken debug writer is isolated from filtering. */ }
    let result;
    try {
      const storedSettings = config().snapshot();
      const settings = storedSettings && { ...storedSettings, availableAgents: storedSettings.availableAgents ?? false };
      if (!settings || typeof settings.sessionDate !== 'boolean' || typeof settings.topicTitle !== 'boolean' || typeof settings.availableAgents !== 'boolean') {
        if (debugSettings?.enabled === true) {
          try { writer?.emit?.({ kind: 'error', protocol, code: 'filter-settings-unavailable' }); } catch {}
        }
        if (measurement.measurable) recordStats({ matched: false, removedLines: 0, at });
        return undefined;
      }
      const diagnostics = debugSettings?.enabled === true && writer
        ? {
          onEdit: (event) => {
            try { writer.emit({ kind: 'request', protocol, settings: { ...settings }, outcome: event.changed ? 'changed' : 'unchanged', ...event }); }
            catch { /* Diagnostics cannot change the request result. */ }
          },
          onError: (event) => {
            try { writer.emit({ kind: 'error', protocol, code: event?.code === 'filter-transform-error' ? event.code : 'filter-error' }); }
            catch { /* Diagnostics cannot change the request result. */ }
          },
        }
        : undefined;
      result = protocols.filterRequest(body, protocol, settings, diagnostics);
    } catch {
      if (measurement.measurable) recordStats({ matched: false, removedLines: 0, at });
      return undefined;
    }
    if (!result?.supported || !Number.isSafeInteger(result.removedLines) || result.removedLines < 0) return undefined;

    const matched = result.changed === true;
    // A safe transform is countable even when unrelated request payloads are
    // unknown; unknown, unmatched requests remain outside aggregate totals.
    if (matched || measurement.measurable) recordStats({
      matched,
      removedLines: result.removedLines,
      dateRemovedLines: result.dateRemovedLines ?? 0,
      topicTitleRemovedLines: result.topicTitleRemovedLines ?? 0,
      availableAgentsMatched: result.availableAgentsMatchedRequests > 0,
      availableAgentsReplacedBlocks: result.availableAgentsReplacedBlocks ?? 0,
      timeGuidanceInsertedBlocks: result.timeGuidanceInsertedBlocks ?? 0,
      at,
    });
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
