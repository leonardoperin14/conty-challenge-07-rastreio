import { describe, expect, it } from 'vitest';
import { findTransitStart, isShipmentDelayed } from '../src/domain/delay.js';
import { projectShipment } from '../src/domain/project-shipment.js';
import type { ShipmentStatus, TrackingEvent } from '../src/domain/types.js';

const baseTime = Date.parse('2025-01-01T00:00:00.000Z');

function event(
  key: string,
  status: ShipmentStatus | null,
  offsetHours: number,
): TrackingEvent {
  return {
    eventKey: key,
    externalEventId: key,
    rawStatus: status ?? 'CARRIER_INVENTION',
    normalizedStatus: status,
    occurredAt: new Date(baseTime + offsetHours * 60 * 60 * 1000).toISOString(),
    receivedAt: '2025-01-10T00:00:00.000Z',
    description: null,
    rawPayload: { code: status ?? 'CARRIER_INVENTION' },
  };
}

describe('shipment projection', () => {
  it('produces the same result when normal events arrive out of order', () => {
    const posted = event('a', 'POSTED', 0);
    const moving = event('b', 'IN_TRANSIT', 24);
    const outForDelivery = event('c', 'OUT_FOR_DELIVERY', 48);

    expect(projectShipment([outForDelivery, posted, moving])).toEqual(
      projectShipment([posted, moving, outForDelivery]),
    );
    expect(projectShipment([outForDelivery, posted, moving]).status).toBe(
      'OUT_FOR_DELIVERY',
    );
  });

  it('preserves a discovered carrier status without treating it as delivered', () => {
    const projection = projectShipment([
      event('posted', 'POSTED', 0),
      event('invented', null, 20),
    ]);
    expect(projection.status).toBe('POSTED');
    expect(projection.status).not.toBe('DELIVERED');
  });

  it('allows a later event to recover from an exception without lowering the stage', () => {
    const projection = projectShipment([
      event('posted', 'POSTED', 0),
      event('moving', 'IN_TRANSIT', 1),
      event('out', 'OUT_FOR_DELIVERY', 2),
      event('exception', 'EXCEPTION', 3),
      event('recovered', 'OUT_FOR_DELIVERY', 4),
    ]);
    expect(projection.status).toBe('OUT_FOR_DELIVERY');
    expect(projection.stage).toBe(3);
  });

  it('keeps delivery terminal when later events arrive', () => {
    const projection = projectShipment([
      event('posted', 'POSTED', 0),
      event('delivered', 'DELIVERED', 2),
      event('old-moving', 'IN_TRANSIT', 3),
    ]);
    expect(projection.status).toBe('DELIVERED');
  });

  it('uses a stable precedence when event timestamps match', () => {
    const projection = projectShipment([
      event('exception', 'EXCEPTION', 1),
      event('delivered', 'DELIVERED', 1),
    ]);
    expect(projection.status).toBe('DELIVERED');
  });
});

describe('delay rule', () => {
  it('starts from the earliest posted or in-transit event', () => {
    const start = event('moving', 'IN_TRANSIT', 2);
    const earlierPost = event('posted', 'POSTED', 0);
    expect(findTransitStart([start, earlierPost])).toBe(earlierPost.occurredAt);
    expect(findTransitStart([event('unknown', null, 0)])).toBeNull();
  });

  it('uses a strict threshold and does not flag a known delivery', () => {
    const started = '2025-01-01T00:00:00.000Z';
    const thresholdDate = new Date(baseTime + 72 * 60 * 60 * 1000);

    expect(
      isShipmentDelayed({
        transitStartedAt: started,
        delivered: false,
        thresholdHours: 72,
        now: thresholdDate,
      }),
    ).toBe(false);
    expect(
      isShipmentDelayed({
        transitStartedAt: started,
        delivered: false,
        thresholdHours: 72,
        now: new Date(thresholdDate.getTime() + 1),
      }),
    ).toBe(true);
    expect(
      isShipmentDelayed({
        transitStartedAt: started,
        delivered: true,
        thresholdHours: 72,
        now: new Date('2025-02-01T00:00:00.000Z'),
      }),
    ).toBe(false);
  });
});
