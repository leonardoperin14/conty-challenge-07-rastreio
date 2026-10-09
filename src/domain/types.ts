export const shipmentStatuses = [
  'POSTED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
] as const;

export type ShipmentStatus = (typeof shipmentStatuses)[number];

export interface TrackingReference {
  trackingCode: string;
  carrier: string;
}

export interface TrackingEvent {
  eventKey: string;
  externalEventId: string | null;
  rawStatus: string;
  normalizedStatus: ShipmentStatus | null;
  occurredAt: string;
  receivedAt: string;
  description: string | null;
  rawPayload: unknown;
}

export interface ShipmentProjection {
  status: ShipmentStatus | null;
  stage: number;
  deliveredAt: string | null;
}

export interface Shipment {
  id: string;
  trackingCode: string;
  carrier: string;
  delayThresholdHours: number;
  status: ShipmentStatus | null;
  transitStartedAt: string | null;
  deliveredAt: string | null;
  isDelayed: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface DelayAlert {
  shipmentId: string;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
