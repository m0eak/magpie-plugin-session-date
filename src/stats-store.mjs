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

const validISO = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s));
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
  storedCount(row.removed_lines);
  if (matched > processed) throw Object.assign(new Error('invalid aggregate relationship'), { code: 'SQLITE_CORRUPT' });
  for (const value of [row.started_at, row.updated_at, row.last_matched_at]) {
    if (value !== null && !validISO(value)) throw Object.assign(new Error('invalid aggregate timestamp'), { code: 'SQLITE_CORRUPT' });
  }
  return { processed, matched };
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
    if (this.closed || this.pending.processedRequests >= MAX_SAFE) return false;
    if (!Number.isSafeInteger(removedLines) || removedLines < 0) return false;
    const timestamp = validISO(at) ? at : this.#nowISO();
    this.pending.processedRequests = addCount(this.pending.processedRequests, 1);
    this.pending.startedAt = earliest(this.pending.startedAt, timestamp);
    this.pending.updatedAt = latest(this.pending.updatedAt, timestamp);
    if (matched && removedLines > 0) {
      this.pending.matchedRequests = addCount(this.pending.matchedRequests, 1);
      this.pending.removedLines = addCount(this.pending.removedLines, removedLines);
      this.pending.lastMatchedAt = latest(this.pending.lastMatchedAt, timestamp);
    }
    return true;
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
      const { processed, matched } = validateStoredRow(row);
      this.#secureFiles(join(this.dataDir, DB_FILE), require('node:fs'));
      return {
        processedRequests: processed,
        matchedRequests: matched,
        removedLines: storedCount(row.removed_lines),
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
    const processedRequests = addCount(committed.processedRequests, pending.processedRequests);
    const matchedRequests = Math.min(processedRequests, addCount(committed.matchedRequests, pending.matchedRequests));
    return {
      schemaVersion: SCHEMA_VERSION,
      status: this.failed ? 'degraded' : 'ok',
      stats: {
        processedRequests,
        matchedRequests,
        removedLines: addCount(committed.removedLines, pending.removedLines),
        unmatchedRequests: processedRequests - matchedRequests,
        startedAt: earliest(committed.startedAt, pending.startedAt),
        updatedAt: latest(committed.updatedAt, pending.updatedAt),
        lastMatchedAt: latest(committed.lastMatchedAt, pending.lastMatchedAt),
      },
      persistence: 'SQLite WAL; this host includes local pending counters; other hosts appear after commit. Normal flush interval is about 30 seconds; persistent lock failures may delay visibility, and unflushed local counters may be lost on process crash.',
    };
  }

  async flush() {
    if (this.flushPromise) return this.flushPromise;
    if (this.retryStartedAt != null && Date.now() - this.retryStartedAt >= RETRY_BUDGET_MS) {
      this.retryStartedAt = null;
      this.retryCount = 0;
    }
    this.flushPromise = Promise.resolve().then(() => {
      if (this.retryWindowStartedAt != null && Date.now() - this.retryWindowStartedAt >= RETRY_BUDGET_MS) {
        this.retryWindowStartedAt = null;
        this.retryCount = 0;
      }
      const result = this.#flushAttempt();
      if (result.status === 'ok') {
        this.retryStartedAt = null;
        this.retryCount = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
      } else if (this.failureCode === 'busy') {
        this.#scheduleRetry();
      }
      return result;
    }).finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  #scheduleRetry() {
    if (this.closed || this.retryTimer || this.pending.processedRequests === 0) return;
    if (this.retryWindowStartedAt == null) this.retryWindowStartedAt = Date.now();
    const elapsed = Date.now() - this.retryWindowStartedAt;
    if (elapsed >= RETRY_BUDGET_MS || this.retryCount >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[this.retryCount];
    if (elapsed + delay > RETRY_BUDGET_MS) return;
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
        const result = this.db.query(`UPDATE stats SET
          processed_requests = MIN(?, processed_requests + ?),
          matched_requests = MIN(?, matched_requests + ?),
          removed_lines = MIN(?, removed_lines + ?),
          started_at = CASE WHEN started_at IS NULL THEN ? WHEN ? IS NULL THEN started_at ELSE MIN(started_at, ?) END,
          updated_at = CASE WHEN updated_at IS NULL THEN ? WHEN ? IS NULL THEN updated_at ELSE MAX(updated_at, ?) END,
          last_matched_at = CASE WHEN last_matched_at IS NULL THEN ? WHEN ? IS NULL THEN last_matched_at ELSE MAX(last_matched_at, ?) END
          WHERE id=1 AND schema_version=?`).run(
          MAX_SAFE, delta.processedRequests, MAX_SAFE, delta.matchedRequests,
          MAX_SAFE, delta.removedLines,
          delta.startedAt, delta.startedAt, delta.startedAt,
          delta.updatedAt, delta.updatedAt, delta.updatedAt,
          delta.lastMatchedAt, delta.lastMatchedAt, delta.lastMatchedAt,
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
      this.failureCode = errorCode(error);
      if (this.failureCode === 'corrupt' || error?.code === 'SQLITE_SCHEMA') this.unavailable = true;
      if (this.failureCode === 'busy' && this.retryWindowStartedAt == null) this.retryWindowStartedAt = Date.now();
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
