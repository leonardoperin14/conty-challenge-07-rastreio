import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { TrackingService } from './application/tracking-service.js';
import { systemClock } from './domain/types.js';
import { createApp } from './http/app.js';
import { MockAggregatorHttpClient } from './integrations/mock-aggregator-client.js';
import { TrackingRepository } from './persistence/tracking-repository.js';

const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.DATABASE_PATH ?? './data/tracking.sqlite';
const delayThresholdHours = Number(process.env.DELAY_THRESHOLD_HOURS ?? 72);
const aggregatorUrl = process.env.AGGREGATOR_URL ?? 'http://localhost:4001';

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
if (!Number.isFinite(delayThresholdHours) || delayThresholdHours <= 0) {
  throw new Error('DELAY_THRESHOLD_HOURS must be a positive number.');
}
if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });

const repository = new TrackingRepository(databasePath, systemClock);
const provider = new MockAggregatorHttpClient(aggregatorUrl, fetch, 5_000, systemClock);
const service = new TrackingService(repository, provider, systemClock, delayThresholdHours);
const server = serve({ fetch: createApp(service).fetch, port });

console.log(`Tracking API listening on http://localhost:${port}`);

function shutdown(): void {
  server.close(() => {
    repository.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
