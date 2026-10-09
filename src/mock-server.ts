import { serve } from '@hono/node-server';
import { createMockAggregatorApp } from './mock/app.js';

const port = Number(process.env.AGGREGATOR_PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('AGGREGATOR_PORT must be an integer between 1 and 65535.');
}

const server = serve({ fetch: createMockAggregatorApp().fetch, port });
console.log(`Mock aggregator listening on http://localhost:${port}`);
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
