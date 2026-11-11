import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { configureStatsStore } from './src/stats-store.mjs';
import { configureFilterConfig } from './src/filter-config.mjs';
import { createService, ServiceListenError } from './src/service-api.mjs';
import { getPluginServerStatus, initializePluginServer } from './src/plugin-server-status.mjs';

let active;
function serverPort(options) {
  const value = options?.sessionDateFilterPort;
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 3479;
}

export default {
  id: 'session-date-filter',
  async server(input, options) {
    if (active) return {};
    const root = typeof input?.directory === 'string' ? input.directory : '';
    const store = configureStatsStore({ directory: root });
    const configStore = configureFilterConfig({ dataDir: root ? join(root, 'session-date-filter') : '' });
    let service;
    try {
      service = createService({ store, configStore, port: serverPort(options), token: randomBytes(32).toString('hex') });
    } catch (error) {
      if (!(error instanceof ServiceListenError)) throw error;
      initializePluginServer({ state: 'unavailable', listenerAvailable: false, storageStatus: store.snapshot().status, reason: 'listener-unavailable' });
      try {
        const log = input?.client?.app?.log;
        if (typeof log === 'function') await log({ body: { level: 'warn', service: 'session-date-filter', message: 'Statistics listener unavailable; request filtering remains active.' } });
      } catch { /* Logging failures cannot disable the gateway request hook. */ }
    }
    if (service) {
      try { initializePluginServer({ state: 'available', listenerAvailable: true, storageStatus: store.snapshot().status, reason: null }); }
      catch (error) { try { await service.stop(); } catch { /* Best-effort cleanup for this owned listener only. */ } throw error; }
    }
    active = { service, store };
    return {};
  },
};

export { getPluginServerStatus };
