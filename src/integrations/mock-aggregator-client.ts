import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { Clock, ShipmentStatus, TrackingEvent, TrackingReference } from '../domain/types.js';
import { systemClock } from '../domain/types.js';
import type { TrackingProvider } from './tracking-provider.js';

const rawEventSchema = z.object({
  id: z.string().min(1).optional(),
  code: z.string().min(1),
  description: z.string().nullable().optional(),
  timestamp: z.string().datetime({ offset: true }),
});

const trackingResponseSchema = z.object({
  tracking_number: z.string().min(1),
  carrier: z.string().min(1),
  events: z.array(rawEventSchema),
});

const statusByCarrier: Record<string, Record<string, ShipmentStatus>> = {
  mock_express: {
    OBJ_POSTED: 'POSTED',
    ACCEPTED: 'POSTED',
    MOVING: 'IN_TRANSIT',
    TRANSFERRED: 'IN_TRANSIT',
    ON_ROUTE: 'OUT_FOR_DELIVERY',
    COURIER_OUT: 'OUT_FOR_DELIVERY',
    POD_OK: 'DELIVERED',
    DELIVERY_DONE: 'DELIVERED',
    ADDRESS_PROBLEM: 'EXCEPTION',
    DELIVERY_FAILED: 'EXCEPTION',
  },
  mock_postal: {
    POSTAGEM_CONFIRMADA: 'POSTED',
    OBJETO_POSTADO: 'POSTED',
    EM_TRANSFERENCIA: 'IN_TRANSIT',
    OBJETO_EM_TRANSITO: 'IN_TRANSIT',
    SAIU_PARA_ENTREGA: 'OUT_FOR_DELIVERY',
    ROTA_DE_ENTREGA: 'OUT_FOR_DELIVERY',
    ENTREGA_REALIZADA: 'DELIVERED',
    RECEBIDO_PELO_DESTINATARIO: 'DELIVERED',
    ENDERECO_INCORRETO: 'EXCEPTION',
    ENTREGA_NAO_REALIZADA: 'EXCEPTION',
  },
};

function normalizeStatus(carrier: string, code: string): ShipmentStatus | null {
  return statusByCarrier[carrier]?.[code] ?? null;
}

function eventKey(input: {
  carrier: string;
  trackingCode: string;
  rawStatus: string;
  occurredAt: string;
  externalEventId: string | null;
}): string {
  if (input.externalEventId !== null) return `external:${input.externalEventId}`;

  const canonical = JSON.stringify([
    input.carrier,
    input.trackingCode,
    input.rawStatus,
    input.occurredAt,
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class MockAggregatorHttpClient implements TrackingProvider {
  readonly name = 'mock-aggregator';

  constructor(
    private readonly baseUrl = 'http://localhost:4001',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
    private readonly clock: Clock = systemClock,
  ) {}

  async register(reference: TrackingReference): Promise<void> {
    const response = await this.request('/trackings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tracking_number: reference.trackingCode,
        carrier: reference.carrier,
      }),
    });

    if (!response.ok) {
      throw new AppError('AGGREGATOR_ERROR', 'O agregador recusou o cadastro.', 502);
    }
  }

  async getEvents(reference: TrackingReference): Promise<TrackingEvent[]> {
    const query = new URLSearchParams({
      carrier: reference.carrier,
      tracking_number: reference.trackingCode,
    });
    const path = `/trackings?${query.toString()}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.request(path, { method: 'GET' }, signal);

    if (response.status === 404) {
      throw new AppError('UPSTREAM_TRACKING_NOT_FOUND', 'Código não encontrado no agregador.', 404);
    }
    if (!response.ok) {
      throw new AppError('AGGREGATOR_ERROR', 'O agregador não conseguiu consultar o rastreamento.', 502);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      if (signal.aborted) {
        throw new AppError('AGGREGATOR_TIMEOUT', 'Tempo limite do agregador excedido.', 504, {
          cause,
        });
      }
      throw new AppError('INVALID_AGGREGATOR_PAYLOAD', 'O agregador retornou JSON inválido.', 502, { cause });
    }

    const parsed = trackingResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('INVALID_AGGREGATOR_PAYLOAD', 'O agregador retornou um payload inválido.', 502, {
        cause: parsed.error,
      });
    }
    if (
      parsed.data.tracking_number !== reference.trackingCode ||
      parsed.data.carrier !== reference.carrier
    ) {
      throw new AppError('INVALID_AGGREGATOR_PAYLOAD', 'O agregador retornou outro código de rastreamento.', 502);
    }

    const receivedAt = this.clock.now().toISOString();
    return parsed.data.events.map((rawEvent) => {
      const occurredAt = new Date(rawEvent.timestamp).toISOString();
      const externalEventId = rawEvent.id ?? null;
      return {
        eventKey: eventKey({
          carrier: reference.carrier,
          trackingCode: reference.trackingCode,
          rawStatus: rawEvent.code,
          occurredAt,
          externalEventId,
        }),
        externalEventId,
        rawStatus: rawEvent.code,
        normalizedStatus: normalizeStatus(reference.carrier, rawEvent.code),
        occurredAt,
        receivedAt,
        description: rawEvent.description ?? null,
        rawPayload: rawEvent,
      };
    });
  }

  private async request(
    path: string,
    init: RequestInit,
    signal: AbortSignal = AbortSignal.timeout(this.timeoutMs),
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        signal,
      });
    } catch (cause) {
      const timedOut =
        signal.aborted ||
        (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError'));
      throw new AppError(
        timedOut ? 'AGGREGATOR_TIMEOUT' : 'AGGREGATOR_UNAVAILABLE',
        timedOut ? 'Tempo limite do agregador excedido.' : 'Agregador indisponível.',
        timedOut ? 504 : 502,
        { cause },
      );
    }
    return response;
  }
}
