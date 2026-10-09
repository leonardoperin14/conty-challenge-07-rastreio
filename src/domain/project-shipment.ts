import type { ShipmentProjection, ShipmentStatus, TrackingEvent } from './types.js';

const stageByStatus: Record<Exclude<ShipmentStatus, 'EXCEPTION'>, number> = {
  POSTED: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
};

const tieBreakOrder: Record<ShipmentStatus, number> = {
  POSTED: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  EXCEPTION: 4,
  DELIVERED: 5,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function projectShipment(events: TrackingEvent[]): ShipmentProjection {
  const ordered = events
    .filter((event): event is TrackingEvent & { normalizedStatus: ShipmentStatus } =>
      event.normalizedStatus !== null,
    )
    .slice()
    .sort((a, b) =>
      compareText(a.occurredAt, b.occurredAt) ||
      tieBreakOrder[a.normalizedStatus] - tieBreakOrder[b.normalizedStatus] ||
      compareText(a.eventKey, b.eventKey),
    );

  let stage = 0;
  let status: ShipmentStatus | null = null;
  let deliveredAt: string | null = null;
  let delivered = false;

  for (const event of ordered) {
    if (delivered) continue;

    if (event.normalizedStatus === 'EXCEPTION') {
      status = 'EXCEPTION';
      continue;
    }

    const nextStage = stageByStatus[event.normalizedStatus];
    if (nextStage < stage) continue;

    stage = nextStage;
    status = event.normalizedStatus;

    if (event.normalizedStatus === 'DELIVERED') {
      delivered = true;
      deliveredAt = event.occurredAt;
    }
  }

  return { status, stage, deliveredAt };
}
