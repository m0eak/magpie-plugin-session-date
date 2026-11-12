import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT = Object.freeze({ enabled: false });
const valid = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 1 && typeof value.enabled === 'boolean';

async function readConfig(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!valid(raw)) throw new Error('invalid-config');
    return { config: Object.freeze({ enabled: raw.enabled }), mtime: (await stat(path)).mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: DEFAULT, mtime: 0 };
    throw error;
  }
}

export class DebugConfigStore {
  constructor({ dataDir, schedule = setInterval, pollMs = 500 } = {}) {
    this.path = dataDir ? join(dataDir, 'debug-config.json') : null;
    this.config = DEFAULT;
    this.failed = !this.path;
    this.mtime = 0;
    this.timer = null;
    if (this.path) {
      try {
        const raw = JSON.parse(requireRead(this.path));
        if (!valid(raw)) throw new Error('invalid-config');
        this.config = Object.freeze({ enabled: raw.enabled });
        this.mtime = requireStat(this.path);
      } catch (error) {
        if (error?.code !== 'ENOENT') this.failed = true;
      }
      this.timer = schedule(() => { void this.refresh(); }, pollMs);
      this.timer?.unref?.();
    }
  }

  snapshot() { return this.failed ? null : this.config; }
  status() { return Object.freeze({ enabled: this.snapshot()?.enabled ?? false, available: !this.failed, reason: this.failed ? 'debug-config-unavailable' : null }); }

  async refresh() {
    if (!this.path) return false;
    try {
      const loaded = await readConfig(this.path);
      if (!this.failed && loaded.mtime === this.mtime && loaded.config.enabled === this.config.enabled) return false;
      this.config = loaded.config;
      this.mtime = loaded.mtime;
      this.failed = false;
      this.onChange?.(loaded.config.enabled);
      return true;
    } catch {
      this.failed = true;
      this.config = null;
      this.onChange?.(false);
      return false;
    }
  }

  async replace(value) {
    if (!valid(value) || !this.path) throw new TypeError('Invalid debug settings.');
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.path);
      chmodSync(this.path, 0o600);
      this.config = Object.freeze({ enabled: value.enabled });
      this.mtime = (await stat(this.path)).mtimeMs;
      this.failed = false;
      this.onChange?.(value.enabled);
      return this.config;
    } catch (error) {
      this.failed = true;
      this.config = null;
      throw error;
    }
  }

  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  setOnChange(callback) { this.onChange = typeof callback === 'function' ? callback : null; }
}

function requireRead(path) { return readFileSync(path, 'utf8'); }
function requireStat(path) { return statSync(path).mtimeMs; }

export function configureDebugConfig(options) {
  if (!globalThis.__sessionDateDebugConfig) globalThis.__sessionDateDebugConfig = new DebugConfigStore(options);
  else if (options?.dataDir && !globalThis.__sessionDateDebugConfig.path) {
    globalThis.__sessionDateDebugConfig.close();
    globalThis.__sessionDateDebugConfig = new DebugConfigStore(options);
  }
  return globalThis.__sessionDateDebugConfig;
}
export const getDebugConfig = () => globalThis.__sessionDateDebugConfig ?? null;
