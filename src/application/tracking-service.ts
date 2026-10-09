import { AppError } from '../domain/errors.js';
import type { Clock, DelayAlert, Shipment, TrackingEvent, TrackingReference } from '../domain/types.js';
import type { TrackingProvider } from '../integrations/tracking-provider.js';
import { TrackingRepository } from '../persistence/tracking-repository.js';

export class TrackingService {
  constructor(
    private readonly repository: TrackingRepository,
    private readonly provider: TrackingProvider,
    private readonly clock: Clock,
    private readonly defaultDelayThresholdHours: number,
  ) {}

  async register(
    reference: TrackingReference,
    requestedThresholdHours?: number,
  ): Promise<{ shipment: Shipment; created: boolean }> {
    const existing = this.repository.findShipment(this.provider.name, reference);
    if (existing) {
      if (
        requestedThresholdHours !== undefined &&
        existing.delayThresholdHours !== requestedThresholdHours
      ) {
        throw new AppError(
          'SHIPMENT_CONFIGURATION_CONFLICT',
          'O código já está cadastrado com outro limite de atraso.',
          409,
        );
      }
      return { shipment: existing, created: false };
    }

    await this.provider.register(reference);
    const shipment = this.repository.createShipment(
      this.provider.name,
      reference,
      requestedThresholdHours ?? this.defaultDelayThresholdHours,
      this.clock.now().toISOString(),
    );
    return { shipment, created: true };
  }

  getShipment(id: string): Shipment {
    const shipment = this.repository.findShipmentById(id);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Rastreamento não encontrado.', 404);
    return shipment;
  }

  listEvents(id: string): TrackingEvent[] {
    this.getShipment(id);
    return this.repository.listEvents(id);
  }

  listAlerts(id: string): DelayAlert[] {
    this.getShipment(id);
    return this.repository.listAlerts(id);
  }

  async sync(id: string): Promise<{ shipment: Shipment; receivedEvents: number; insertedEvents: number }> {
    const shipment = this.getShipment(id);
    const reference = {
      trackingCode: shipment.trackingCode,
      carrier: shipment.carrier,
    };
    const incoming = await this.provider.getEvents(reference);
    const result = this.repository.syncEvents(shipment, incoming, this.clock.now());
    return {
      ...result,
      receivedEvents: incoming.length,
    };
  }

  checkDelay(id: string): { shipment: Shipment; alert: DelayAlert | null } {
    const shipment = this.getShipment(id);
    return this.repository.checkDelay(shipment, this.clock.now());
  }
}
