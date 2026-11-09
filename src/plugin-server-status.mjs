import { getStatsStore } from './stats-store.mjs';

const STORE_FAILURES = new Set(['busy', 'corrupt', 'unavailable']);
const freezeState = (state) => Object.freeze({
  state: state.state,
  listenerAvailable: state.listenerAvailable,
  storageStatus: state.storageStatus,
  reason: state.reason,
});

let serverState = freezeState({ state: 'unavailable', listenerAvailable: false, storageStatus: 'degraded', reason: 'not-started' });

export function initializePluginServer(state) {
  const storageStatus = state?.storageStatus === 'ok' ? 'ok' : 'degraded';
  const listenerAvailable = state?.listenerAvailable === true;
  const degraded = !listenerAvailable || storageStatus !== 'ok';
  const reason = listenerAvailable
    ? (storageStatus === 'ok' ? null : (STORE_FAILURES.has(state?.reason) ? state.reason : 'storage-unavailable'))
    : 'listener-unavailable';
  serverState = freezeState({ state: degraded ? 'unavailable' : 'available', listenerAvailable, storageStatus, reason });
  return serverState;
}

export function getPluginServerStatus() {
  return serverState;
}
