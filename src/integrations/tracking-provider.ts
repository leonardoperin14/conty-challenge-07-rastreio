import type { TrackingEvent, TrackingReference } from '../domain/types.js';

export interface TrackingProvider {
  readonly name: string;
  register(reference: TrackingReference): Promise<void>;
  getEvents(reference: TrackingReference): Promise<TrackingEvent[]>;
}
