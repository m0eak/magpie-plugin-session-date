import { existsSync, writeFileSync } from 'node:fs';
import { FilterConfigStore } from '../../src/filter-config.mjs';

const [, , directory, setting, serializedValue, readyPath, gatePath, errorPath] = process.argv;
const store = new FilterConfigStore({ dataDir: directory, schedule: () => null, cancel() {} });
writeFileSync(readyPath, 'ready');
const deadline = Date.now() + 5000;
while (!existsSync(gatePath)) {
  if (Date.now() >= deadline) {
    store.close();
    process.exitCode = 2;
    break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
if (process.exitCode !== 2) {
  try { await store.update({ [setting]: JSON.parse(serializedValue) }); }
  catch (error) {
    writeFileSync(errorPath, error?.stack ?? String(error));
    process.exitCode = 1;
  }
  finally { store.close(); }
}
