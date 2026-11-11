import { mkdirSync, writeFileSync } from 'node:fs';

const lockPath = process.argv[2];
mkdirSync(lockPath, { mode: 0o700 });
writeFileSync(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, token: 'abandoned-lock-owner-test-token' }), { mode: 0o600 });
