import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILE = 'filter-config.json';
const DEFAULT_FILTER_CONFIG = Object.freeze({ sessionDate: true, topicTitle: true, availableAgents: false });
const CONFIG_KEYS = Object.keys(DEFAULT_FILTER_CONFIG);
const POLL_MS = 500;
const LOCK_POLL_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;

function validConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const legacy = CONFIG_KEYS.filter((key) => key !== 'availableAgents');
  const validKeys = keys.length === legacy.length
    ? legacy.every((key) => Object.hasOwn(value, key))
    : keys.length === CONFIG_KEYS.length && CONFIG_KEYS.every((key) => Object.hasOwn(value, key));
  return validKeys && typeof value.sessionDate === 'boolean' && typeof value.topicTitle === 'boolean' &&
    (value.availableAgents === undefined || typeof value.availableAgents === 'boolean');
}

function validPatch(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length > 0 && Object.keys(value).every((key) => CONFIG_KEYS.includes(key) && typeof value[key] === 'boolean');
}

function loadFile(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!validConfig(raw)) throw new Error('Invalid persisted filter configuration.');
    return { config: Object.freeze({ sessionDate: raw.sessionDate, topicTitle: raw.topicTitle, availableAgents: raw.availableAgents ?? false }), mtime: statSync(path).mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: DEFAULT_FILTER_CONFIG, mtime: 0 };
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(lockPath) {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && owner.token.length >= 16) return owner;
  } catch {}
  return null;
}

function readOwnerSync(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && owner.token.length >= 16) return owner;
  } catch {}
  return null;
}

async function tryAcquireRecoveryGuard(guardPath) {
  const owner = { pid: process.pid, token: randomUUID() };
  try {
    await mkdir(guardPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  try {
    await writeFile(`${guardPath}/owner.json`, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    throw new Error('Could not establish recovery guard ownership.', { cause: error });
  }
  return async () => {
    const current = await readOwner(guardPath);
    if (current?.pid === owner.pid && current.token === owner.token) await rm(guardPath, { recursive: true, force: true });
  };
}

async function removeDeadOwner(lockPath, expectedToken) {
  const releaseGuard = await tryAcquireRecoveryGuard(`${lockPath}.reap`);
  if (!releaseGuard) return false;
  try {
    const owner = readOwnerSync(lockPath);
    if (owner) {
      if (owner.token !== expectedToken || processIsAlive(owner.pid)) return false;
      const current = readOwnerSync(lockPath);
      if (!current || current.token !== owner.token || processIsAlive(current.pid)) return false;
      rmSync(lockPath, { recursive: true, force: true });
      return true;
    }
    return false;
  } finally {
    await releaseGuard();
  }
}

async function acquireLock(lockPath, { timeoutMs = LOCK_TIMEOUT_MS, pollMs = LOCK_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const owner = { pid: process.pid, token: randomUUID() };
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingOwner = await readOwner(lockPath);
      if (existingOwner && !processIsAlive(existingOwner.pid)) {
        if (await removeDeadOwner(lockPath, existingOwner.token)) continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the filter settings lock.');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    try {
      await writeFile(`${lockPath}/owner.json`, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      throw new Error('Could not establish filter settings lock ownership.', { cause: error });
    }
    return async () => {
      const current = await readOwner(lockPath);
      if (current?.token === owner.token && current.pid === owner.pid) await rm(lockPath, { recursive: true, force: true });
    };
  }
}

async function persistConfig(path, config) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(config)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

export class FilterConfigStore {
  constructor({ dataDir, schedule = setInterval, cancel = clearInterval, pollMs = POLL_MS, lockTimeoutMs = LOCK_TIMEOUT_MS, lockPollMs = LOCK_POLL_MS } = {}) {
    this.path = dataDir ? join(dataDir, FILE) : '';
    this.config = DEFAULT_FILTER_CONFIG;
    this.mtime = 0;
    this.failed = false;
    this.timer = null;
    this.schedule = schedule;
    this.cancel = cancel;
    this.pollMs = pollMs;
    this.lockOptions = { timeoutMs: lockTimeoutMs, pollMs: lockPollMs };
    if (this.path) {
      try { Object.assign(this, loadFile(this.path)); }
      catch { this.failed = true; this.config = null; }
      this.timer = schedule(() => this.refresh(), pollMs);
      this.timer?.unref?.();
    }
  }

  snapshot() { return this.failed ? null : this.config; }

  refresh() {
    if (!this.path) return false;
    try {
      const loaded = loadFile(this.path);
      if (!this.failed && loaded.mtime === this.mtime && loaded.config.sessionDate === this.config.sessionDate && loaded.config.topicTitle === this.config.topicTitle && loaded.config.availableAgents === this.config.availableAgents) return false;
      this.config = loaded.config;
      this.mtime = loaded.mtime;
      this.failed = false;
      return true;
    } catch {
      this.failed = true;
      this.config = null;
      return false;
    }
  }

  async update(patch) {
    if (!validPatch(patch)) throw new TypeError('Settings patch must contain one or more known boolean fields.');
    return this.#write(patch, false);
  }

  async replace(value) {
    if (!validConfig(value)) throw new TypeError('Both filter settings must be booleans.');
    return this.#write(value, true);
  }

  async #write(value, replace) {
    if (!this.path || this.failed) throw new Error('Filter settings storage is unavailable.');
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch {}
    const lockPath = `${this.path}.lock`;
    const release = await acquireLock(lockPath, this.lockOptions);
    try {
      const current = loadFile(this.path).config;
      const next = Object.freeze(replace ? { ...DEFAULT_FILTER_CONFIG, ...value } : { ...current, ...value });
      await persistConfig(this.path, next);
      this.config = next;
      this.mtime = statSync(this.path).mtimeMs;
      this.failed = false;
      return this.config;
    } finally {
      await release();
    }
  }

  close() {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }
}

let active;
export function getFilterConfig(options) {
  if (!active || (!active.path && typeof options?.dataDir === 'string' && options.dataDir.length > 0)) {
    active?.close();
    active = new FilterConfigStore(options);
  }
  return active ?? (active = new FilterConfigStore());
}

export function configureFilterConfig(options = {}) {
  if (!active || (!active.path && typeof options.dataDir === 'string' && options.dataDir.length > 0)) {
    active?.close();
    active = new FilterConfigStore(options);
  }
  return active;
}

export function resetFilterConfigForTests() {
  active?.close();
  active = undefined;
}
