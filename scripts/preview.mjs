import path from 'node:path';
import { startDaemon } from '../lib/server.js';
const daemon=await startDaemon({dataDir:path.resolve('qa','preview'),port:48430});
console.log(`http://127.0.0.1:${daemon.port}/ui/?token=${daemon.token}`);
