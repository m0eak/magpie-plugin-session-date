import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  queueCount: 64,
  queueBytes: 1024 * 1024,
  batchCount: 64,
  batchBytes: 64 * 1024,
  flushMs: 250,
  lockWaitMs: 250,
});
const REDACT = [
  { pattern: /\bBearer\s+\S+/gi },
  { pattern: /\bBasic\s+\S+/gi },
  { pattern: /\b(?:sk-ant-)?sk-[A-Za-z0-9_-]{4,}\b/gi },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{4,}\b/g },
  { pattern: /((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]*/gi, prefix: true },
  { pattern: /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token|key)\s*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"'`\s,;&]+)/gi, prefix: true },
  { pattern: /\b(?:agt|tpc|op)_[A-Za-z0-9_-]{6,}\b/g },
  { pattern: /(https?:\/\/)[^/@\s:]+(?::[^/@\s]*)?@/gi, prefix: true },
  { pattern: /([?&](?:api[_-]?key|token|secret|password)=)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&#\s]+)/gi, prefix: true },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const managedFile = /^session-date-filter-[A-Za-z0-9-]+\.jsonl$/;

export function redactText(text) {
  let value = String(text);
  for (const { pattern, prefix = false } of REDACT) {
    value = value.replace(pattern, (...args) => `${prefix ? args[1] : ''}[REDACTED]`);
  }
  return value;
}

function truncateUtf8(value, limit) {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}

async function acquireControlGuard(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const owner = { pid: process.pid, token: randomUUID() };
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
      return async () => {
        try {
          const actual = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
          if (actual.pid === owner.pid && actual.token === owner.token) await rm(path, { recursive: true });
        } catch { /* An unverifiable guard remains for conservative timeout handling. */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('lock-timeout');
      await wait(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

async function acquireDirectoryLock(lockPath, timeoutMs) {
  const guardPath = `${lockPath}-control`;
  const deadline = Date.now() + timeoutMs;
  const owner = { pid: process.pid, token: randomUUID() };
  while (Date.now() < deadline) {
    const releaseGuard = await acquireControlGuard(guardPath, Math.max(1, deadline - Date.now()));
    let acquired = false;
    try {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
          acquired = true;
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let existing;
        try { existing = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')); }
        catch { existing = null; }
        if (existing && processAlive(existing.pid) === false) {
          const retired = `${lockPath}-retired-${randomUUID()}`;
          await rename(lockPath, retired);
          try {
            const moved = JSON.parse(await readFile(join(retired, 'owner.json'), 'utf8'));
            if (moved.pid === existing.pid && moved.token === existing.token) await rm(retired, { recursive: true });
          } catch { /* Preserve unverified retired material for operator inspection. */ }
        }
      }
    } finally {
      await releaseGuard();
    }
    if (acquired) {
      return async () => {
        const releaseGuard = await acquireControlGuard(guardPath, timeoutMs);
        try {
          let current;
          try { current = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')); }
          catch { current = null; }
          if (current?.pid === owner.pid && current.token === owner.token) await rm(lockPath, { recursive: true });
        } finally { await releaseGuard(); }
      };
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  throw new Error('lock-timeout');
}

export class DebugWriter {
  constructor({ directory, runId = randomUUID(), limits = {}, io = {} } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Debug directory is unavailable.');
    if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new TypeError('Invalid debug run id.');
    this.directory = directory;
    this.runId = runId;
    this.io = { lstat, readdir, rm, open, ...io };
    this.filePath = join(directory, `session-date-filter-${runId}.jsonl`);
    this.lockPath = join(directory, '.writer-lock');
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.queue = [];
    this.queueBytes = 0;
    this.sequence = 0;
    this.dropped = 0;
    this.written = 0;
    this.lastWriteAt = null;
    this.reason = null;
    this.timer = null;
    this.worker = null;
    this.preparing = null;
    this.inFlightCount = 0;
    this.inFlightBytes = 0;
    this.closed = false;
    this.enabled = false;
    this.generation = 0;
  }

  status() {
    return Object.freeze({
      enabled: this.enabled,
      state: this.closed ? 'closed' : this.reason ? 'degraded' : this.enabled ? 'ready' : 'disabled',
      reason: this.reason,
      runId: this.runId,
      droppedRequests: this.dropped,
      queuedRequests: this.queue.length + this.inFlightCount,
      writtenRequests: this.written,
      lastWriteAt: this.lastWriteAt,
      directory: this.directory,
    });
  }

  setEnabled(enabled) {
    const next = enabled === true;
    if (this.enabled === next) return;
    this.enabled = next;
    this.generation += 1;
    if (!next) {
      // The active batch owns its written/dropped accounting when it settles.
      this.dropped += this.queue.length;
      this.queue.length = 0;
      this.queueBytes = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    this.preparing = this.prepare();
  }

  async prepare() {
    if (!this.enabled || this.closed) return;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const release = await acquireDirectoryLock(this.lockPath, this.limits.lockWaitMs);
      try { await this.#pruneAndRotate(0); }
      finally { await release(); }
      if (this.reason === 'write-failed') this.reason = null;
    } catch (error) { this.reason = error?.message === 'lock-timeout' ? 'lock-timeout' : 'write-failed'; }
  }

  emit(event) {
    if (this.closed || !this.enabled) return;
    let line;
    let originalCount = 0;
    try {
      const clean = {
        schemaVersion: 1,
        ...event,
        runId: this.runId,
        sequence: ++this.sequence,
        timestamp: new Date().toISOString(),
      };
      if (Array.isArray(clean.edits)) {
        originalCount = clean.edits.length;
        clean.edits = clean.edits.slice(0, 16).map((edit) => {
          const rawBefore = edit.before == null ? null : String(edit.before);
          const rawAfter = String(edit.after ?? '');
          const originalBeforeBytes = rawBefore === null ? edit.beforeBytes ?? 0 : byteLength(rawBefore);
          const originalAfterBytes = byteLength(rawAfter);
          const before = rawBefore === null || originalBeforeBytes > 64 * 1024 ? null : redactText(rawBefore);
          const after = redactText(rawAfter);
          const beforeValue = before === null ? null : truncateUtf8(before, 8 * 1024);
          const afterValue = truncateUtf8(after, 1024);
          return {
            ...edit,
            before: beforeValue,
            after: afterValue,
            beforeBytes: originalBeforeBytes,
            afterBytes: originalAfterBytes,
            redacted: (before !== null && before !== rawBefore) || after !== rawAfter,
            beforeTruncated: before !== null && beforeValue.length !== before.length,
            beforeOmitted: before === null || edit.beforeOmitted === true,
            afterTruncated: afterValue.length !== after.length,
          };
        });
        clean.omittedEdits = (clean.omittedEdits ?? 0) + Math.max(0, originalCount - 16);
      }
      line = `${JSON.stringify(clean)}\n`;
      if (byteLength(line) > this.limits.batchBytes) {
        clean.edits = [];
        clean.omittedEdits = (clean.omittedEdits ?? 0) + originalCount;
        line = `${JSON.stringify(clean)}\n`;
      }
      if (byteLength(line) > this.limits.batchBytes) throw new Error('record-too-large');
    } catch {
      this.dropped += 1;
      this.reason = 'event-error';
      return;
    }
    const size = byteLength(line);
    const pending = this.queue.length + this.inFlightCount;
    const pendingBytes = this.queueBytes + this.inFlightBytes;
    if (pending >= this.limits.queueCount || pendingBytes + size > this.limits.queueBytes) {
      this.dropped += 1;
      this.reason = 'queue-full';
      return;
    }
    this.queue.push({ line, size, generation: this.generation });
    this.queueBytes += size;
    if (this.queue.length >= this.limits.batchCount || this.queueBytes >= this.limits.batchBytes) void this.flush();
    else this.#schedule();
  }

  #schedule() {
    if (this.timer || this.closed || !this.enabled) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.limits.flushMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.closed || !this.enabled || this.worker || this.queue.length === 0) return this.worker ?? Promise.resolve();
    this.worker = this.#drain();
    return this.worker;
  }

  async #drain() {
    try {
      while (!this.closed && this.enabled && this.queue.length) {
        const generation = this.generation;
        const batch = [];
        let bytes = 0;
        while (this.queue.length && batch.length < this.limits.batchCount) {
          const item = this.queue[0];
          if (item.generation !== generation) {
            this.queue.shift();
            this.queueBytes -= item.size;
            this.dropped += 1;
            continue;
          }
          if (batch.length && bytes + item.size > this.limits.batchBytes) break;
          batch.push(this.queue.shift());
          this.queueBytes -= item.size;
          bytes += item.size;
        }
        if (!batch.length) continue;
        this.inFlightCount = batch.length;
        this.inFlightBytes = bytes;
        try {
          await this.#writeBatch(batch, generation);
        } catch {
          this.dropped += batch.length;
          this.reason = 'write-failed';
        } finally {
          this.inFlightCount = 0;
          this.inFlightBytes = 0;
        }
      }
    } finally {
      this.worker = null;
      if (this.queue.length && this.enabled && !this.closed) this.#schedule();
    }
  }

  async #writeBatch(batch, generation) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const release = await acquireDirectoryLock(this.lockPath, this.limits.lockWaitMs);
    try {
      if (generation !== this.generation || !this.enabled || this.closed) {
        this.dropped += batch.length;
        return;
      }
      const text = batch.map((item) => item.line).join('');
      await this.#pruneAndRotate(byteLength(text));
      let handle;
      let initialSize = 0;
      try {
        handle = await this.io.open(this.filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        initialSize = (await handle.stat()).size;
        await handle.writeFile(text, 'utf8');
        await handle.chmod(0o600);
      } catch (error) {
        if (handle) {
          try { await handle.truncate(initialSize); } catch {
            this.filePath = join(this.directory, `session-date-filter-${this.runId}-${randomUUID()}.jsonl`);
          }
        }
        throw error;
      } finally {
        await handle?.close();
      }
      this.written += batch.length;
      this.lastWriteAt = new Date().toISOString();
      this.reason = null;
    } finally { await release(); }
  }

  async #pruneAndRotate(incomingBytes) {
    if (incomingBytes > this.limits.fileBytes || incomingBytes > this.limits.totalBytes) throw new Error('batch-too-large');
    const now = Date.now();
    const files = [];
    for (const name of await this.io.readdir(this.directory)) {
      if (!managedFile.test(name)) continue;
      const path = join(this.directory, name);
      let info;
      try { info = await this.io.lstat(path); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      if (!info.isFile()) {
        files.push({ path, name, size: info.size, mtime: info.mtimeMs, removable: false });
        continue;
      }
      const file = { path, name, size: info.size, mtime: info.mtimeMs, removable: true };
      if (now - info.mtimeMs > this.limits.retentionMs) {
        await this.io.rm(path);
      } else files.push(file);
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((sum, item) => sum + item.size, 0);
    const current = files.find((item) => item.path === this.filePath);
    const rotate = (current?.size ?? 0) + incomingBytes > this.limits.fileBytes;
    for (const file of files) {
      if (total + incomingBytes <= this.limits.totalBytes) break;
      if (!file.removable || file.path === this.filePath) continue;
      await this.io.rm(file.path);
      total -= file.size;
    }
    if (total + incomingBytes > this.limits.totalBytes) throw new Error('capacity-unavailable');
    if (rotate) this.filePath = join(this.directory, `session-date-filter-${this.runId}-${randomUUID()}.jsonl`);
  }

  async close({ timeoutMs = 1000 } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.enabled = false;
    this.generation += 1;
    this.dropped += this.queue.length;
    this.queue.length = 0;
    this.queueBytes = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = Promise.allSettled([this.worker, this.preparing].filter(Boolean));
    await Promise.race([pending, wait(timeoutMs)]);
  }
}

export { DEFAULT_LIMITS as DEBUG_LIMITS };
export function configureDebugWriter(options) {
  if (!globalThis.__sessionDateDebugWriter) globalThis.__sessionDateDebugWriter = new DebugWriter(options);
  else if (options?.directory && globalThis.__sessionDateDebugWriter.directory !== options.directory) {
    throw new Error('Debug writer already belongs to another data directory.');
  }
  return globalThis.__sessionDateDebugWriter;
}
export const getDebugWriter = () => globalThis.__sessionDateDebugWriter ?? null;
