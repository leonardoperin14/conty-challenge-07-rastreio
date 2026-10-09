import { Hono } from 'hono';
import { z } from 'zod';
import { createDefaultMockTrackings, key, type MockTracking } from './fixtures.js';

const referenceSchema = z.object({
  tracking_number: z.string().trim().min(1).max(100),
  carrier: z.string().trim().min(1).max(60),
});

const eventSchema = z.object({
  id: z.string().min(1).optional(),
  code: z.string().min(1),
  description: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }),
});

const appendEventsSchema = z.object({ events: z.array(eventSchema) });

export function createMockAggregatorApp(
  trackings: Map<string, MockTracking> = createDefaultMockTrackings(),
): Hono {
  const app = new Hono();

  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.post('/trackings', async (context) => {
    const parsed = referenceSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'Invalid tracking reference.' }, 400);
    }

    const identity = key(parsed.data.carrier, parsed.data.tracking_number);
    const created = !trackings.has(identity);
    if (created) {
      trackings.set(identity, {
        ...parsed.data,
        events: [],
      });
    }
    return context.json(trackings.get(identity), created ? 201 : 200);
  });

  app.get('/trackings', (context) => {
    const carrier = context.req.query('carrier');
    const trackingNumber = context.req.query('tracking_number');
    if (!carrier || !trackingNumber) {
      return context.json({ error: 'carrier and tracking_number are required.' }, 400);
    }

    const tracking = trackings.get(key(carrier, trackingNumber));
    if (!tracking) return context.json({ error: 'Tracking not found.' }, 404);
    return context.json(tracking);
  });

  app.post('/__mock/trackings/:carrier/:trackingNumber/events', async (context) => {
    const parsed = appendEventsSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'Invalid events payload.' }, 400);
    }
    const tracking = trackings.get(
      key(context.req.param('carrier'), context.req.param('trackingNumber')),
    );
    if (!tracking) return context.json({ error: 'Tracking not found.' }, 404);
    tracking.events.push(
      ...parsed.data.events.map((event) => ({
        ...(event.id === undefined ? {} : { id: event.id }),
        code: event.code,
        ...(event.description === undefined ? {} : { description: event.description }),
        timestamp: event.timestamp,
      })),
    );
    return context.json({ tracking, appendedEvents: parsed.data.events.length });
  });

  app.notFound((context) => context.json({ error: 'Route not found.' }, 404));
  return app;
}
