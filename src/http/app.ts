import { Hono } from 'hono';
import { z } from 'zod';
import { TrackingService } from '../application/tracking-service.js';
import { AppError } from '../domain/errors.js';

const registerSchema = z.object({
  trackingCode: z.string().trim().min(1).max(100),
  carrier: z.string().trim().min(1).max(60),
  delayThresholdHours: z.number().finite().positive().optional(),
});

export function createApp(service: TrackingService): Hono {
  const app = new Hono();

  app.onError((error, context) => {
    if (error instanceof AppError) {
      return context.json(
        { error: { code: error.code, message: error.message } },
        error.statusCode as 400 | 404 | 409 | 502 | 504,
      );
    }
    console.error(error);
    return context.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } },
      500,
    );
  });

  app.notFound((context) =>
    context.json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada.' } }, 404),
  );

  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.post('/shipments', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { error: { code: 'INVALID_REQUEST', message: 'Corpo JSON inválido.' } },
        400,
      );
    }
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: { code: 'INVALID_REQUEST', message: 'Dados do rastreamento inválidos.' } },
        400,
      );
    }

    const { trackingCode, carrier, delayThresholdHours } = parsed.data;
    const result = await service.register(
      { trackingCode, carrier },
      delayThresholdHours,
    );
    return context.json({ shipment: result.shipment }, result.created ? 201 : 200);
  });

  app.post('/shipments/:id/sync', async (context) => {
    const result = await service.sync(context.req.param('id'));
    return context.json(result);
  });

  app.get('/shipments/:id', (context) =>
    context.json({ shipment: service.getShipment(context.req.param('id')) }),
  );

  app.get('/shipments/:id/events', (context) =>
    context.json({ events: service.listEvents(context.req.param('id')) }),
  );

  app.post('/shipments/:id/check-delay', (context) => {
    const result = service.checkDelay(context.req.param('id'));
    return context.json(result);
  });

  app.get('/shipments/:id/alerts', (context) =>
    context.json({ alerts: service.listAlerts(context.req.param('id')) }),
  );

  return app;
}
