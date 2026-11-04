import { configureStatsStore } from './src/stats-store.mjs';
import { createService } from './src/service-api.mjs';

let active;

function serverPort(options) {
  const value = options?.sessionDateFilterPort;
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 3479;
}

export default {
  id: 'session-date-filter',
  async server(input, options) {
    const store = configureStatsStore({ directory: input?.directory });
    if (!active) {
      const service = createService({ store, port: serverPort(options) });
      active = { service, store };
    }
    return {};
  },
};
