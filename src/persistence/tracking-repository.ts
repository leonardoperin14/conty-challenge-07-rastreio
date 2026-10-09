import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../domain/errors.js';
import { findTransitStart, isShipmentDelayed } from '../domain/delay.js';
import { projectShipment } from '../domain/project-shipment.js';
import { systemClock } from '../domain/types.js';
import type {
  DelayAlert,
  Shipment,
  ShipmentStatus,
  TrackingEvent,
  TrackingReference,
} from '../domain/types.js';

interface ShipmentRow {
  id: string;
  provider: string;
  tracking_code: string;
  carrier: string;
  delay_threshold_hours: number;
  status: ShipmentStatus | null;
  transit_started_at: string | null;
  delivered_at: string | null;
  last_synced_at: string | null;
  created_at: string;
}

interface EventRow {
  event_key: string;
  external_event_id: string | null;
  raw_status: string;
  normalized_status: ShipmentStatus | null;
  occurred_at: string;
  received_at: string;
  description: string | null;
  raw_payload: string;
}

interface AlertRow {
  shipment_id: string;
  detected_at: string;
  resolved_at: string | null;
}

export class TrackingRepository {
  private readonly db: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly clock = systemClock,
  ) {
    this.db = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shipments (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        tracking_code TEXT NOT NULL,
        carrier TEXT NOT NULL,
        delay_threshold_hours REAL NOT NULL CHECK (delay_threshold_hours > 0),
        status TEXT,
        stage INTEGER NOT NULL DEFAULT 0,
        transit_started_at TEXT,
        delivered_at TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (provider, carrier, tracking_code)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tracking_events (
        shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        external_event_id TEXT,
        raw_status TEXT NOT NULL,
        normalized_status TEXT,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        description TEXT,
        raw_payload TEXT NOT NULL,
        PRIMARY KEY (shipment_id, event_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS delay_alerts (
        shipment_id TEXT PRIMARY KEY REFERENCES shipments(id) ON DELETE CASCADE,
        detected_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
  }

  findShipment(provider: string, reference: TrackingReference): Shipment | null {
    const row = this.db
      .prepare(
        `SELECT * FROM shipments
         WHERE provider = ? AND carrier = ? AND tracking_code = ?`,
      )
      .get(provider, reference.carrier, reference.trackingCode) as ShipmentRow | undefined;
    return row ? this.toShipment(row) : null;
  }

  findShipmentById(id: string): Shipment | null {
    const row = this.db.prepare('SELECT * FROM shipments WHERE id = ?').get(id) as ShipmentRow | undefined;
    return row ? this.toShipment(row) : null;
  }

  createShipment(
    provider: string,
    reference: TrackingReference,
    delayThresholdHours: number,
    createdAt: string,
  ): Shipment {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO shipments
         (id, provider, tracking_code, carrier, delay_threshold_hours, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, carrier, tracking_code) DO NOTHING`,
      )
      .run(id, provider, reference.trackingCode, reference.carrier, delayThresholdHours, createdAt);

    const shipment = this.findShipment(provider, reference);
    if (!shipment) throw new Error('Could not read the created shipment.');
    return shipment;
  }

  listEvents(shipmentId: string): TrackingEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracking_events
         WHERE shipment_id = ?
         ORDER BY occurred_at ASC, event_key ASC`,
      )
      .all(shipmentId) as unknown as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  syncEvents(
    shipment: Shipment,
    incoming: TrackingEvent[],
    now: Date,
  ): { shipment: Shipment; insertedEvents: number } {
    let insertedEvents = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(
        `INSERT INTO tracking_events
         (shipment_id, event_key, external_event_id, raw_status, normalized_status,
          occurred_at, received_at, description, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (shipment_id, event_key) DO NOTHING`,
      );
      const findEvent = this.db.prepare(
        `SELECT raw_status, normalized_status, occurred_at
         FROM tracking_events WHERE shipment_id = ? AND event_key = ?`,
      );

      for (const event of incoming) {
        const result = insert.run(
          shipment.id,
          event.eventKey,
          event.externalEventId,
          event.rawStatus,
          event.normalizedStatus,
          event.occurredAt,
          event.receivedAt,
          event.description,
          JSON.stringify(event.rawPayload),
        );
        insertedEvents += Number(result.changes);

        const saved = findEvent.get(shipment.id, event.eventKey) as
          | { raw_status: string; normalized_status: ShipmentStatus | null; occurred_at: string }
          | undefined;
        if (
          !saved ||
          saved.raw_status !== event.rawStatus ||
          saved.normalized_status !== event.normalizedStatus ||
          saved.occurred_at !== event.occurredAt
        ) {
          throw new AppError(
            'EVENT_ID_CONFLICT',
            'O agregador reutilizou a identidade de um evento com dados diferentes.',
            502,
          );
        }
      }

      const allEvents = this.listEvents(shipment.id);
      const projection = projectShipment(allEvents);
      const transitStartedAt = findTransitStart(allEvents);
      const updatedAt = now.toISOString();

      this.db
        .prepare(
          `UPDATE shipments
           SET status = ?, stage = ?, transit_started_at = ?, delivered_at = ?, last_synced_at = ?
           WHERE id = ?`,
        )
        .run(
          projection.status,
          projection.stage,
          transitStartedAt,
          projection.deliveredAt,
          updatedAt,
          shipment.id,
        );

      this.reconcileAlert(shipment, projection.status === 'DELIVERED', transitStartedAt, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const updated = this.findShipmentById(shipment.id);
    if (!updated) throw new Error('The shipment disappeared during synchronization.');
    return { shipment: updated, insertedEvents };
  }

  checkDelay(shipment: Shipment, now: Date): { shipment: Shipment; alert: DelayAlert | null } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const events = this.listEvents(shipment.id);
      const transitStartedAt = findTransitStart(events);
      const status = projectShipment(events).status;
      this.reconcileAlert(shipment, status === 'DELIVERED', transitStartedAt, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const updatedShipment = this.findShipmentById(shipment.id);
    if (!updatedShipment) throw new Error('The shipment disappeared during delay check.');
    return { shipment: updatedShipment, alert: this.getAlert(shipment.id) };
  }

  getAlert(shipmentId: string): DelayAlert | null {
    const row = this.db
      .prepare('SELECT * FROM delay_alerts WHERE shipment_id = ?')
      .get(shipmentId) as AlertRow | undefined;
    return row
      ? {
          shipmentId: row.shipment_id,
          detectedAt: row.detected_at,
          resolvedAt: row.resolved_at,
        }
      : null;
  }

  listAlerts(shipmentId: string): DelayAlert[] {
    const alert = this.getAlert(shipmentId);
    return alert ? [alert] : [];
  }

  private reconcileAlert(
    shipment: Shipment,
    delivered: boolean,
    transitStartedAt: string | null,
    now: Date,
  ): void {
    const nowIso = now.toISOString();
    if (delivered) {
      this.db
        .prepare(
          `UPDATE delay_alerts SET resolved_at = COALESCE(resolved_at, ?)
           WHERE shipment_id = ? AND resolved_at IS NULL`,
        )
        .run(nowIso, shipment.id);
      return;
    }

    const delayed = isShipmentDelayed({
      transitStartedAt,
      delivered: false,
      thresholdHours: shipment.delayThresholdHours,
      now,
    });
    if (delayed) {
      this.db
        .prepare(
          `INSERT INTO delay_alerts (shipment_id, detected_at)
           VALUES (?, ?)
           ON CONFLICT (shipment_id) DO NOTHING`,
        )
        .run(shipment.id, nowIso);
    }
  }

  private toShipment(row: ShipmentRow): Shipment {
    return {
      id: row.id,
      trackingCode: row.tracking_code,
      carrier: row.carrier,
      delayThresholdHours: row.delay_threshold_hours,
      status: row.status,
      transitStartedAt: row.transit_started_at,
      deliveredAt: row.delivered_at,
      isDelayed: isShipmentDelayed({
        transitStartedAt: row.transit_started_at,
        delivered: row.status === 'DELIVERED',
        thresholdHours: row.delay_threshold_hours,
        now: this.clock.now(),
      }),
      lastSyncedAt: row.last_synced_at,
      createdAt: row.created_at,
    };
  }

  private toEvent(row: EventRow): TrackingEvent {
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(row.raw_payload);
    } catch {
      rawPayload = row.raw_payload;
    }
    return {
      eventKey: row.event_key,
      externalEventId: row.external_event_id,
      rawStatus: row.raw_status,
      normalizedStatus: row.normalized_status,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      description: row.description,
      rawPayload,
    };
  }
}
