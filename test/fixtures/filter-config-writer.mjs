import { FilterConfigStore } from '../../src/filter-config.mjs';

const [, , directory, serialized] = process.argv;
const store = new FilterConfigStore({ dataDir: directory, schedule: () => null, cancel() {} });
try { await store.update(JSON.parse(serialized)); }
finally { store.close(); }
