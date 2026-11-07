import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 1;
const DB_FILE = 'stats.sqlite';
export const DEFAULT_FLUSH_MS = 30_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const SQLITE_BUSY_WAIT_MS = 2;
export const SQLITE_INIT_BUSY_WAIT_MS = 10;
export const RETRY_DELAYS_MS = [25, 75, 200, 500, 1000];
export const RETRY_BUDGET_MS = 2000;
const EMPTY = Object.freeze({
  processedRequests: 0,
  matchedRequests: 0,
  removedLines: 0,
  unmatchedRequests: 0,
  startedAt: null,
  updatedAt: null,
  lastMatchedAt: null,
});

const addCount = (a, b) => {
  if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0 || a + b > MAX_SAFE) {
    throw Object.assign(new Error('aggregate range exceeded'), { code: 'SQLITE_FULL' });
  }
  return a + b;
};

const validISO = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)) return false;
  const millis = Date.parse(s);
  return Number.isFinite(millis) && new Date(millis).toISOString() === s;
};
const earliest = (a, b) => a == null ? b : b == null ? a : a <= b ? a : b;
const latest = (a, b) => a == null ? b : b == null ? a : a >= b ? a : b;

function storedCount(value) {
  if (typeof value === 'bigint') {
    if (value >= 0n && value <= BigInt(MAX_SAFE)) return Number(value);
  } else if (Number.isSafeInteger(value) && value >= 0) return value;
  throw Object.assign(new Error('invalid aggregate value'), { code: 'SQLITE_CORRUPT' });
}

function validateStoredRow(row) {
  const processed = storedCount(row.processed_requests);
  const matched = storedCount(row.matched_requests);
  const removed = storedCount(row.removed_lines);
  const timestamps = [row.started_at, row.updated_at, row.last_matched_at];
  for (const value of timestamps) {
    if (value !== null && !validISO(value)) throw Object.assign(new Error('invalid aggregate timestamp'), { code: 'SQLITE_CORRUPT' });
  }
  const [startedAt, updatedAt, lastMatchedAt] = timestamps;
  const invalidRelationship = matched > processed || removed < matched ||
    (matched === 0 && (removed !== 0 || lastMatchedAt !== null)) ||
    (processed === 0 ? startedAt !== null || updatedAt !== null || matched !== 0 || removed !== 0 : startedAt === null || updatedAt === null) ||
    (matched > 0 && lastMatchedAt === null) ||
    (startedAt !== null && updatedAt !== null && startedAt > updatedAt) ||
    (lastMatchedAt !== null && (lastMatchedAt < startedAt || lastMatchedAt > updatedAt));
  if (invalidRelationship) throw Object.assign(new Error('invalid aggregate relationship'), { code: 'SQLITE_CORRUPT' });
  return { processed, matched, removed };
}

function emptyPending() {
  return { processedRequests: 0, matchedRequests: 0, removedLines: 0, startedAt: null, updatedAt: null, lastMatchedAt: null };
}

function errorCode(error) {
  const code = error?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || error?.errno === 5 || error?.errno === 6) return 'busy';
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || error?.errno === 11 || error?.errno === 26) return 'corrupt';
  return 'unavailable';
}

/** Aggregated-only SQLite store. Runtime database binding is Bun's built-in bun:sqlite. */
export class StatsStore {
  constructor({
    dataDir,
    now = () => new Date(),
    flushIntervalMs = DEFAULT_FLUSH_MS,
    autoFlush = true,
    schedule = setInterval,
    cancelSchedule = clearInterval,
    sqlite,
  } = {}) {
    if (typeof dataDir !== 'string') throw new TypeError('A host data directory is required.');
    this.dataDir = dataDir;
    this.now = now;
    this.flushIntervalMs = flushIntervalMs;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.sqlite = sqlite;
    this.pending = emptyPending();
    this.failed = false;
    this.failureCode = null;
    this.closed = false;
    this.initialized = false;
    this.unavailable = false;
    this.retryCount = 0;
    this.retryWindowStartedAt = null;
    this.db = null;
    this.flushPromise = null;
    if (autoFlush) {
      this.timer = this.schedule(() => {
        if (this.retryWindowStartedAt != null && Date.now() - this.retryWindowStartedAt >= RETRY_BUDGET_MS) {
          this.retryWindowStartedAt = null;
          this.retryCount = 0;
        }
        void this.flush().catch(() => {});
      }, flushIntervalMs);
      this.timer?.unref?.();
    }
  }

  #nowISO() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  record({ matched = false, removedLines = 0, at } = {}) {
    if (this.closed || typeof matched !== 'boolean' || !Number.isSafeInteger(removedLines) || removedLines < 0 || (matched && removedLines === 0) || (!matched && removedLines !== 0)) return false;
    if (at !== undefined && !validISO(at)) return false;
    const timestamp = at ?? this.#nowISO();
    try {
      const next = this.pending.processedRequests === 0 ? emptyPending() : { ...this.pending };
      next.processedRequests = addCount(next.processedRequests, 1);
      next.startedAt = earliest(next.startedAt, timestamp);
      next.updatedAt = latest(next.updatedAt, timestamp);
      if (matched) {
        next.matchedRequests = addCount(next.matchedRequests, 1);
        next.removedLines = addCount(next.removedLines, removedLines);
        next.lastMatchedAt = latest(next.lastMatchedAt, timestamp);
      }
      Object.assign(this.pending, next);
      return true;
    } catch (error) {
      if (error?.code === 'SQLITE_FULL') throw error;
      return false;
    }
  }

  #setFailure(error, permanent = false) {
    this.failed = true;
    this.failureCode = errorCode(error);
    if (permanent || this.failureCode === 'corrupt') this.unavailable = true;
    try { this.db?.close(); } catch {}
    this.db = null;
    this.initialized = false;
  }

  #secureFiles(file, fs) {
    fs.chmodSync(this.dataDir, 0o700);
    fs.chmodSync(file, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.chmodSync(`${file}${suffix}`, 0o600); } catch {}
    }
  }

  #init() {
    if (this.initialized || this.unavailable || this.initializing) return;
    if (!this.dataDir || !isAbsolute(this.dataDir)) {
      this.failed = true;
      this.failureCode = 'unavailable';
      return;
    }
    this.initializing = true;
    try {
      const { Database: DB } = this.sqlite ?? (typeof Bun !== 'undefined' ? require('bun:sqlite') : {});
      if (!DB) throw Object.assign(new Error('SQLite runtime unavailable'), { code: 'SQLITE_CANTOPEN' });
      const fs = require('node:fs');
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const dirStat = fs.lstatSync(this.dataDir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw Object.assign(new Error('invalid data directory'), { code: 'SQLITE_CANTOPEN' });
      fs.chmodSync(this.dataDir, 0o700);
      const file = join(this.dataDir, DB_FILE);
      const priorStat = fs.existsSync(file) ? fs.lstatSync(file) : null;
      if (priorStat && (!priorStat.isFile() || priorStat.isSymbolicLink())) throw Object.assign(new Error('invalid storage object'), { code: 'SQLITE_NOTADB' });
      if (!priorStat) {
        try {
          const fd = fs.openSync(file, 'wx', 0o600);
          fs.closeSync(fd);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
      }
      const current = fs.lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink()) throw Object.assign(new Error('invalid storage object'), { code: 'SQLITE_NOTADB' });
      fs.chmodSync(file, 0o600);
      this.db = new DB(file, { create: true, strict: true, safeIntegers: true });
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_INIT_BUSY_WAIT_MS};`);
      this.db.exec('PRAGMA synchronous = FULL;');
      this.db.exec('PRAGMA journal_mode = WAL;');
      const initialize = this.db.transaction(() => {
        const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => name);
        if (tables.length > 0) {
          if (tables.length !== 1 || tables[0] !== 'stats') throw Object.assign(new Error('unknown database schema'), { code: 'SQLITE_SCHEMA' });
          const columns = this.db.query('PRAGMA table_info(stats)').all().map(({ name }) => name);
          const expected = ['id', 'schema_version', 'processed_requests', 'matched_requests', 'removed_lines', 'started_at', 'updated_at', 'last_matched_at'];
          if (expected.some((name) => !columns.includes(name))) throw Object.assign(new Error('unknown database schema'), { code: 'SQLITE_SCHEMA' });
          const existing = this.db.query('SELECT schema_version FROM stats WHERE id=1').get();
          if (existing && Number(existing.schema_version) !== SCHEMA_VERSION) throw Object.assign(new Error('unknown database schema version'), { code: 'SQLITE_SCHEMA' });
        }
        this.db.exec('CREATE TABLE IF NOT EXISTS stats (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, processed_requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, removed_lines INTEGER NOT NULL, started_at TEXT, updated_at TEXT, last_matched_at TEXT)');
        this.db.query('INSERT OR IGNORE INTO stats (id,schema_version,processed_requests,matched_requests,removed_lines,started_at,updated_at,last_matched_at) VALUES (1,?,0,0,0,NULL,NULL,NULL)').run(SCHEMA_VERSION);
      });
      initialize.immediate();
      const mode = this.db.query('PRAGMA journal_mode').get()?.journal_mode;
      if (String(mode).toLowerCase() !== 'wal') throw Object.assign(new Error('WAL mode required'), { code: 'SQLITE_SCHEMA' });
      const row = this.db.query('SELECT schema_version FROM stats WHERE id=1').get();
      if (!row || Number(row.schema_version) !== SCHEMA_VERSION) throw Object.assign(new Error('unknown database schema version'), { code: 'SQLITE_SCHEMA' });
      this.#secureFiles(file, fs);
      this.initialized = true;
      this.failed = false;
      this.failureCode = null;
    } catch (error) {
      const permanent = error?.code === 'SQLITE_SCHEMA' || error?.code === 'SQLITE_NOTADB';
      this.#setFailure(error, permanent);
    } finally {
      this.initializing = false;
    }
  }

  #readCommitted() {
    this.#init();
    if (!this.db || !this.initialized) return { ...EMPTY };
    try {
      const row = this.db.query('SELECT schema_version,processed_requests,matched_requests,removed_lines,started_at,updated_at,last_matched_at FROM stats WHERE id=1').get();
      if (!row || Number(row.schema_version) !== SCHEMA_VERSION) throw Object.assign(new Error('unknown schema'), { code: 'SQLITE_SCHEMA' });
      const { processed, matched, removed } = validateStoredRow(row);
      this.#secureFiles(join(this.dataDir, DB_FILE), require('node:fs'));
      return {
        processedRequests: processed,
        matchedRequests: matched,
        removedLines: removed,
        unmatchedRequests: processed - matched,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        lastMatchedAt: row.last_matched_at,
      };
    } catch (error) {
      this.#setFailure(error, error?.code === 'SQLITE_SCHEMA' || error?.code === 'SQLITE_NOTADB');
      return { ...EMPTY };
    }
  }

  snapshot() {
    const committed = this.#readCommitted();
    const pending = this.pending;
    const processedRequests = committed.processedRequests + pending.processedRequests;
    const matchedRequests = committed.matchedRequests + pending.matchedRequests;
    const removedLines = committed.removedLines + pending.removedLines;
    const hasSafeAggregate = [processedRequests, matchedRequests, removedLines].every(Number.isSafeInteger) &&
      matchedRequests <= processedRequests && removedLines >= matchedRequests;
    const stats = hasSafeAggregate ? {
      processedRequests,
      matchedRequests,
      removedLines,
      unmatchedRequests: processedRequests - matchedRequests,
      startedAt: earliest(committed.startedAt, pending.startedAt),
      updatedAt: latest(committed.updatedAt, pending.updatedAt),
      lastMatchedAt: latest(committed.lastMatchedAt, pending.lastMatchedAt),
    } : {
      processedRequests: committed.processedRequests,
      matchedRequests: committed.matchedRequests,
      removedLines: committed.removedLines,
      unmatchedRequests: committed.unmatchedRequests,
      startedAt: committed.startedAt,
      updatedAt: committed.updatedAt,
      lastMatchedAt: committed.lastMatchedAt,
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      status: this.failed || !hasSafeAggregate ? 'degraded' : 'ok',
      stats,
      persistence: hasSafeAggregate
        ? 'SQLite WAL; this host includes local pending counters; other hosts appear after commit. Normal flush interval is about 30 seconds; persistent lock failures may delay visibility, and unflushed local counters may be lost on process crash.'
        : 'SQLite WAL; pending counters are not included in this snapshot because the aggregate exceeds the safe integer range.',
    };
  }

  async flush() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = Promise.resolve().then(() => {
      const result = this.#flushAttempt();
      if (result.status === 'degraded' && this.failureCode === 'busy') this.#scheduleRetry();
      if (result.status === 'ok') {
        this.retryWindowStartedAt = null;
        this.retryCount = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      return result;
    }).finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  #scheduleRetry() {
    if (this.closed || this.retryTimer || this.retryCount >= RETRY_DELAYS_MS.length || this.pending.processedRequests === 0) return;
    if (this.retryWindowStartedAt == null) this.retryWindowStartedAt = Date.now();
    const delay = RETRY_DELAYS_MS[this.retryCount];
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush().catch(() => {});
    }, delay);
    this.retryTimer.unref?.();
  }

  #flushAttempt() {
    if (this.closed || this.pending.processedRequests === 0) return { status: this.failed ? 'degraded' : 'ok' };
    if (!this.initialized) this.#init();
    if (this.unavailable || !this.db || !this.initialized) return { status: 'degraded' };
    const delta = { ...this.pending };
    try {
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_WAIT_MS};`);
      const apply = this.db.transaction(() => {
        const current = this.db.query('SELECT schema_version,processed_requests,matched_requests,removed_lines,started_at,updated_at,last_matched_at FROM stats WHERE id=1').get();
        if (!current || Number(current.schema_version) !== SCHEMA_VERSION) throw Object.assign(new Error('unknown database schema'), { code: 'SQLITE_SCHEMA' });
        const stored = validateStoredRow(current);
        const nextProcessed = stored.processed + delta.processedRequests;
        const nextMatched = stored.matched + delta.matchedRequests;
        const nextRemoved = stored.removed + delta.removedLines;
        if (![nextProcessed, nextMatched, nextRemoved].every(Number.isSafeInteger)) {
          throw Object.assign(new Error('aggregate range exceeded'), { code: 'SQLITE_FULL' });
        }
        const nextStartedAt = earliest(current.started_at, delta.startedAt);
        const nextUpdatedAt = latest(current.updated_at, delta.updatedAt);
        const nextLastMatchedAt = latest(current.last_matched_at, delta.lastMatchedAt);
        validateStoredRow({
          processed_requests: nextProcessed,
          matched_requests: nextMatched,
          removed_lines: nextRemoved,
          started_at: nextStartedAt,
          updated_at: nextUpdatedAt,
          last_matched_at: nextLastMatchedAt,
        });
        const result = this.db.query(`UPDATE stats SET
          processed_requests = ?, matched_requests = ?, removed_lines = ?,
          started_at = ?, updated_at = ?, last_matched_at = ?
          WHERE id=1 AND schema_version=?`).run(
          nextProcessed, nextMatched, nextRemoved,
          nextStartedAt, nextUpdatedAt, nextLastMatchedAt,
          SCHEMA_VERSION,
        );
        if (result.changes !== 1) throw Object.assign(new Error('unknown database schema'), { code: 'SQLITE_SCHEMA' });
      });
      apply.immediate();
      for (const key of ['processedRequests', 'matchedRequests', 'removedLines']) this.pending[key] = Math.max(0, this.pending[key] - delta[key]);
      if (this.pending.processedRequests === 0) {
        this.pending.startedAt = null;
        this.pending.updatedAt = null;
        this.pending.lastMatchedAt = null;
      } else {
        this.pending.startedAt = this.pending.startedAt === delta.startedAt ? null : this.pending.startedAt;
        this.pending.updatedAt = this.pending.updatedAt === delta.updatedAt ? null : this.pending.updatedAt;
        this.pending.lastMatchedAt = this.pending.lastMatchedAt === delta.lastMatchedAt ? null : this.pending.lastMatchedAt;
      }
      this.failed = false;
      this.failureCode = null;
      this.retryWindowStartedAt = null;
      this.retryCount = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      return { status: 'ok' };
    } catch (error) {
      this.failed = true;
      if (error?.code === 'SQLITE_FULL') {
        this.failureCode = 'unavailable';
        this.unavailable = true;
        try { this.db?.close(); } catch {}
        this.db = null;
        this.initialized = false;
      } else {
        this.failureCode = errorCode(error);
      }
      if (this.failureCode !== 'busy') {
        this.retryWindowStartedAt = null;
        this.retryCount = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      return { status: 'degraded' };
    }
  }

  async close() {
    if (this.closed) return;
    if (this.timer) this.cancelSchedule(this.timer);
    await this.flush();
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try { this.db?.close(); } catch {}
    this.db = null;
  }
}

let singleton;
export function configureStatsStore({ directory, ...options } = {}) {
  if (singleton) return singleton;
  const root = typeof directory === 'string' && directory.length > 0 ? directory : '';
  singleton = new StatsStore({ dataDir: root ? join(root, 'session-date-filter') : '', ...options });
  return singleton;
}

export function getStatsStore() {
  if (!singleton) singleton = configureStatsStore({ directory: '' });
  return singleton;
}

export function resetStatsStoreForTests() {
  const old = singleton;
  singleton = undefined;
  return old;
}
