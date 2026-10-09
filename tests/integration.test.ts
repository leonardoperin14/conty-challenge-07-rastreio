import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrackingService } from '../src/application/tracking-service.js';
import type { Clock, TrackingEvent, TrackingReference } from '../src/domain/types.js';
import { createApp } from '../src/http/app.js';
import { MockAggregatorHttpClient } from '../src/integrations/mock-aggregator-client.js';
import type { TrackingProvider } from '../src/integrations/tracking-provider.js';
import { createMockAggregatorApp } from '../src/mock/app.js';
import { TrackingRepository } from '../src/persistence/tracking-repository.js';

class TestClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(value: string): void {
    this.current = new Date(value);
  }
}

class FakeProvider implements TrackingProvider {
  readonly name = 'test-provider';
  readonly registrations: TrackingReference[] = [];
  events: TrackingEvent[] = [];

  async register(reference: TrackingReference): Promise<void> {
    this.registrations.push(reference);
  }
  async getEvents(): Promise<TrackingEvent[]> {
    return this.events;
  }
}

function normalizedEvent(
  eventKey: string,
  rawStatus: string,
  normalizedStatus: TrackingEvent['normalizedStatus'],
  occurredAt: string,
  receivedAt = '2025-01-01T00:00:00.000Z',
): TrackingEvent {
  return {
    eventKey,
    externalEventId: eventKey,
    rawStatus,
    normalizedStatus,
    occurredAt,
    receivedAt,
    description: null,
    rawPayload: { id: eventKey, code: rawStatus, timestamp: occurredAt },
  };
}

function makeApi(input?: { events?: TrackingEvent[]; clock?: TestClock }) {
  const clock = input?.clock ?? new TestClock(new Date('2025-01-10T00:00:00.000Z'));
  const repository = new TrackingRepository(':memory:', clock);
  const provider = new FakeProvider();
  provider.events = input?.events ?? [];
  const service = new TrackingService(repository, provider, clock, 72);
  return { app: createApp(service), repository, provider, clock };
}

describe('tracking API and persistence', () => {
  it('does not duplicate a registration or its history on repeated synchronization', async () => {
    const { app, repository, provider } = makeApi({
      events: [
        normalizedEvent('out', 'ON_ROUTE', 'OUT_FOR_DELIVERY', '2025-01-03T00:00:00.000Z'),
        normalizedEvent('post', 'OBJ_POSTED', 'POSTED', '2025-01-01T00:00:00.000Z'),
        normalizedEvent('move', 'MOVING', 'IN_TRANSIT', '2025-01-02T00:00:00.000Z'),
      ],
    });

    const registered = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackingCode: 'TRACK-1', carrier: 'mock_express' }),
    });
    expect(registered.status).toBe(201);
    const { shipment } = (await registered.json()) as { shipment: { id: string } };

    const repeated = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackingCode: 'TRACK-1', carrier: 'mock_express' }),
    });
    expect(repeated.status).toBe(200);
    expect(provider.registrations).toHaveLength(1);

    const firstSync = await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    expect(firstSync.status).toBe(200);
    expect(((await firstSync.json()) as { insertedEvents: number }).insertedEvents).toBe(3);
    const secondSync = await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    expect(((await secondSync.json()) as { insertedEvents: number }).insertedEvents).toBe(0);

    const current = await app.request(`/shipments/${shipment.id}`);
    expect(((await current.json()) as { shipment: { status: string } }).shipment.status).toBe(
      'OUT_FOR_DELIVERY',
    );
    const history = await app.request(`/shipments/${shipment.id}/events`);
    expect(((await history.json()) as { events: unknown[] }).events).toHaveLength(3);
    repository.close();
  });

  it('preserves an unknown carrier status in history without marking delivery', async () => {
    const { app, repository } = makeApi({
      events: [
        normalizedEvent('post', 'OBJ_POSTED', 'POSTED', '2025-01-01T00:00:00.000Z'),
        normalizedEvent(
          'invented',
          'AWAITING_DRONE_PICKUP',
          null,
          '2025-01-02T00:00:00.000Z',
        ),
      ],
    });
    const created = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackingCode: 'TRACK-UNKNOWN', carrier: 'mock_express' }),
    });
    const { shipment } = (await created.json()) as { shipment: { id: string } };
    await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    const current = (await (await app.request(`/shipments/${shipment.id}`)).json()) as {
      shipment: { status: string };
    };
    const history = (await (await app.request(`/shipments/${shipment.id}/events`)).json()) as {
      events: { rawStatus: string; normalizedStatus: string | null }[];
    };
    expect(current.shipment.status).toBe('POSTED');
    expect(history.events.find((entry) => entry.rawStatus === 'AWAITING_DRONE_PICKUP')?.normalizedStatus).toBeNull();
    repository.close();
  });

  it('uses the injected clock, emits one delay alert, and resolves it on delivery', async () => {
    const clock = new TestClock(new Date('2025-01-04T00:00:00.000Z'));
    const { app, repository, provider } = makeApi({
      clock,
      events: [
        normalizedEvent('post', 'OBJ_POSTED', 'POSTED', '2025-01-01T00:00:00.000Z'),
        normalizedEvent('move', 'MOVING', 'IN_TRANSIT', '2025-01-01T01:00:00.000Z'),
      ],
    });
    const created = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trackingCode: 'TRACK-DELAY',
        carrier: 'mock_express',
        delayThresholdHours: 72,
      }),
    });
    const { shipment } = (await created.json()) as { shipment: { id: string } };

    await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    clock.set('2025-01-04T00:00:00.000Z');
    const atLimit = await app.request(`/shipments/${shipment.id}/check-delay`, { method: 'POST' });
    expect(((await atLimit.json()) as { alert: unknown }).alert).toBeNull();

    clock.set('2025-01-04T00:00:00.001Z');
    const overdue = await app.request(`/shipments/${shipment.id}/check-delay`, { method: 'POST' });
    expect(((await overdue.json()) as { alert: { resolvedAt: string | null } }).alert.resolvedAt).toBeNull();
    await app.request(`/shipments/${shipment.id}/check-delay`, { method: 'POST' });
    expect(repository.listAlerts(shipment.id)).toHaveLength(1);

    provider.events = [
      ...provider.events,
      normalizedEvent('delivered', 'POD_OK', 'DELIVERED', '2025-01-04T01:00:00.000Z'),
    ];
    clock.set('2025-01-05T00:00:00.000Z');
    await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    const alerts = (await (await app.request(`/shipments/${shipment.id}/alerts`)).json()) as {
      alerts: { resolvedAt: string | null }[];
    };
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]?.resolvedAt).toBe('2025-01-05T00:00:00.000Z');
    const shipmentResponse = (await (await app.request(`/shipments/${shipment.id}`)).json()) as {
      shipment: { isDelayed: boolean };
    };
    expect(shipmentResponse.shipment.isDelayed).toBe(false);
    repository.close();
  });

  it('does not create a delay alert for a normally completed delivery checked days later', async () => {
    const clock = new TestClock(new Date('2025-01-20T00:00:00.000Z'));
    const { app, repository } = makeApi({
      clock,
      events: [
        normalizedEvent('post', 'OBJ_POSTED', 'POSTED', '2025-01-01T00:00:00.000Z'),
        normalizedEvent('delivered', 'POD_OK', 'DELIVERED', '2025-01-03T00:00:00.000Z'),
      ],
    });
    const created = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackingCode: 'TRACK-ON-TIME', carrier: 'mock_express' }),
    });
    const { shipment } = (await created.json()) as { shipment: { id: string } };

    await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    const checked = (await (
      await app.request(`/shipments/${shipment.id}/check-delay`, { method: 'POST' })
    ).json()) as { alert: unknown; shipment: { status: string; isDelayed: boolean } };

    expect(checked.shipment.status).toBe('DELIVERED');
    expect(checked.shipment.isDelayed).toBe(false);
    expect(checked.alert).toBeNull();
    expect(repository.listAlerts(shipment.id)).toHaveLength(0);
    repository.close();
  });

  it('runs the API through the actual HTTP client and mock aggregator', async () => {
    const mock = createMockAggregatorApp();
    const fetchMock: typeof fetch = async (input, init) =>
      mock.fetch(new Request(input, init));
    const clock = new TestClock(new Date('2025-01-10T00:00:00.000Z'));
    const provider = new MockAggregatorHttpClient(
      'http://mock.local',
      fetchMock,
      1_000,
      clock,
    );
    const repository = new TrackingRepository(':memory:', clock);
    const service = new TrackingService(repository, provider, clock, 72);
    const app = createApp(service);

    const created = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trackingCode: 'DEMO-OUT-OF-ORDER',
        carrier: 'mock_express',
      }),
    });
    expect(created.status).toBe(201);
    const { shipment } = (await created.json()) as { shipment: { id: string } };
    const sync = await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    expect(sync.status).toBe(200);
    expect(((await sync.json()) as { insertedEvents: number }).insertedEvents).toBe(3);
    const current = (await (await app.request(`/shipments/${shipment.id}`)).json()) as {
      shipment: { status: string };
    };
    expect(current.shipment.status).toBe('OUT_FOR_DELIVERY');
    repository.close();
  });

  it('rejects invalid input and reports missing shipments', async () => {
    const { app, repository } = makeApi();
    const invalid = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackingCode: '', carrier: 'mock_express' }),
    });
    expect(invalid.status).toBe(400);
    const missing = await app.request('/shipments/missing');
    expect(missing.status).toBe(404);
    repository.close();
  });

  it('persists shipments and event history after reopening SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'conty-tracking-'));
    const databasePath = join(directory, 'tracking.sqlite');
    const clock = new TestClock(new Date('2025-01-02T00:00:00.000Z'));
    const reference = { trackingCode: 'TRACK-PERSISTED', carrier: 'mock_express' };

    try {
      const firstRepository = new TrackingRepository(databasePath, clock);
      const shipment = firstRepository.createShipment(
        'test-provider',
        reference,
        72,
        clock.now().toISOString(),
      );
      firstRepository.syncEvents(
        shipment,
        [normalizedEvent('post', 'OBJ_POSTED', 'POSTED', '2025-01-01T00:00:00.000Z')],
        clock.now(),
      );
      firstRepository.close();

      const reopened = new TrackingRepository(databasePath, clock);
      const restored = reopened.findShipment('test-provider', reference);
      expect(restored?.status).toBe('POSTED');
      expect(reopened.listEvents(shipment.id)).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('HTTP aggregator adapter and mock', () => {
  it('normalizes two carrier dialects and leaves an invented code unknown', async () => {
    const mock = createMockAggregatorApp();
    const fetchMock: typeof fetch = async (input, init) =>
      mock.fetch(new Request(input, init));
    const clock = new TestClock(new Date('2025-01-01T00:00:00.000Z'));
    const provider = new MockAggregatorHttpClient(
      'http://mock.local',
      fetchMock,
      1_000,
      clock,
    );

    const expressEvents = await provider.getEvents({
      carrier: 'mock_express',
      trackingCode: 'DEMO-UNKNOWN',
    });
    expect(expressEvents.find((entry) => entry.rawStatus === 'AWAITING_DRONE_PICKUP')?.normalizedStatus).toBeNull();

    const postalEvents = await provider.getEvents({
      carrier: 'mock_postal',
      trackingCode: 'DEMO-POSTAL',
    });
    expect(postalEvents.map((entry) => entry.normalizedStatus)).toEqual([
      'POSTED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
    expect(postalEvents[0]?.receivedAt).toBe(clock.now().toISOString());
  });

  it('returns an HTTP error when the upstream response is invalid', async () => {
    const provider = new MockAggregatorHttpClient(
      'http://mock.local',
      async () => new Response('{bad json', { status: 200 }),
      1_000,
    );
    await expect(
      provider.getEvents({ carrier: 'mock_express', trackingCode: 'BROKEN' }),
    ).rejects.toMatchObject({ code: 'INVALID_AGGREGATOR_PAYLOAD', statusCode: 502 });
  });

  it('reports a timeout while reading the upstream body without changing shipment state', async () => {
    const clock = new TestClock(new Date('2025-01-10T00:00:00.000Z'));
    const encoder = new TextEncoder();
    const fetchMock: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') return new Response(null, { status: 201 });

      const signal = init?.signal;
      if (!signal) throw new Error('Expected the aggregator timeout signal.');

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              '{"tracking_number":"TIMEOUT-BODY","carrier":"mock_express","events":[',
            ),
          );
          const failRead = () => controller.error(signal.reason);
          if (signal.aborted) failRead();
          else signal.addEventListener('abort', failRead, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = new MockAggregatorHttpClient('http://mock.local', fetchMock, 100, clock);
    const repository = new TrackingRepository(':memory:', clock);
    const service = new TrackingService(repository, provider, clock, 72);
    const app = createApp(service);

    const created = await app.request('/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackingCode: 'TIMEOUT-BODY', carrier: 'mock_express' }),
    });
    expect(created.status).toBe(201);
    const { shipment } = (await created.json()) as { shipment: { id: string } };

    const sync = await app.request(`/shipments/${shipment.id}/sync`, { method: 'POST' });
    expect(sync.status).toBe(504);
    expect(await sync.json()).toMatchObject({ error: { code: 'AGGREGATOR_TIMEOUT' } });

    const current = (await (
      await app.request(`/shipments/${shipment.id}`)
    ).json()) as {
      shipment: { status: string | null; lastSyncedAt: string | null };
    };
    expect(current.shipment).toMatchObject({ status: null, lastSyncedAt: null });
    expect(repository.listEvents(shipment.id)).toHaveLength(0);
    repository.close();
  });

  it('maps an upstream timeout to a gateway timeout', async () => {
    const provider = new MockAggregatorHttpClient(
      'http://mock.local',
      async () => {
        throw new DOMException('Timed out', 'TimeoutError');
      },
      1,
    );
    await expect(
      provider.getEvents({ carrier: 'mock_express', trackingCode: 'TIMEOUT' }),
    ).rejects.toMatchObject({ code: 'AGGREGATOR_TIMEOUT', statusCode: 504 });
  });
});
