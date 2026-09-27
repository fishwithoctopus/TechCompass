import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './tools.js';
await createMcpServer().connect(new StdioServerTransport());
