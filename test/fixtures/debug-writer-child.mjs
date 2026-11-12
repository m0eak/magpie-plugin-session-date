import { DebugWriter } from '../../src/debug-writer.mjs';

const [directory, runId] = process.argv.slice(2);
const writer = new DebugWriter({ directory, runId });
writer.setEnabled(true);
writer.emit({ kind: 'request', protocol: 'chat', outcome: 'unchanged', edits: [] });
await writer.flush();
await writer.close();
