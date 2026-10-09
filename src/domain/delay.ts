import type { TrackingEvent } from './types.js';

export function findTransitStart(events: TrackingEvent[]): string | null {
  const candidates = events
    .filter(
      (event) =>
        event.normalizedStatus === 'POSTED' || event.normalizedStatus === 'IN_TRANSIT',
    )
    .map((event) => event.occurredAt)
    .sort();

  return candidates[0] ?? null;
}

export function isShipmentDelayed(input: {
  transitStartedAt: string | null;
  delivered: boolean;
  thresholdHours: number;
  now: Date;
}): boolean {
  if (input.delivered || input.transitStartedAt === null) return false;

  const elapsedMs = input.now.getTime() - Date.parse(input.transitStartedAt);
  return elapsedMs > input.thresholdHours * 60 * 60 * 1000;
}
