// Isolated visual QA server: never reads or modifies the user's project store.
import { startDaemon } from '../lib/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { port, token } = await startDaemon({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-preview-')), port: 47580 });
console.log(`http://127.0.0.1:${port}/ui/?token=${token}`);
