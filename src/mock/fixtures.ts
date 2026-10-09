export interface MockCarrierEvent {
  id?: string;
  code: string;
  description?: string;
  timestamp: string;
}

export interface MockTracking {
  tracking_number: string;
  carrier: string;
  events: MockCarrierEvent[];
}

export function createDefaultMockTrackings(): Map<string, MockTracking> {
  const entries: MockTracking[] = [
    {
      tracking_number: 'DEMO-DELIVERED',
      carrier: 'mock_express',
      events: [
        { id: 'exp-1', code: 'OBJ_POSTED', description: 'Pacote postado', timestamp: '2025-08-01T08:00:00Z' },
        { id: 'exp-2', code: 'MOVING', description: 'Em trânsito', timestamp: '2025-08-02T08:00:00Z' },
        { id: 'exp-3', code: 'POD_OK', description: 'Entregue', timestamp: '2025-08-04T08:00:00Z' },
      ],
    },
    {
      tracking_number: 'DEMO-OUT-OF-ORDER',
      carrier: 'mock_express',
      events: [
        { id: 'order-3', code: 'ON_ROUTE', description: 'Saiu para entrega', timestamp: '2025-08-03T09:00:00Z' },
        { id: 'order-1', code: 'OBJ_POSTED', description: 'Pacote postado', timestamp: '2025-08-01T08:00:00Z' },
        { id: 'order-2', code: 'MOVING', description: 'Em trânsito', timestamp: '2025-08-02T08:00:00Z' },
      ],
    },
    {
      tracking_number: 'DEMO-UNKNOWN',
      carrier: 'mock_express',
      events: [
        { id: 'unknown-1', code: 'OBJ_POSTED', description: 'Pacote postado', timestamp: '2025-08-01T08:00:00Z' },
        { id: 'unknown-2', code: 'AWAITING_DRONE_PICKUP', description: 'Novo código da transportadora', timestamp: '2025-08-02T08:00:00Z' },
      ],
    },
    {
      tracking_number: 'DEMO-DELAYED',
      carrier: 'mock_express',
      events: [
        { id: 'delay-1', code: 'OBJ_POSTED', description: 'Pacote postado', timestamp: '2025-08-01T08:00:00Z' },
        { id: 'delay-2', code: 'MOVING', description: 'Em trânsito', timestamp: '2025-08-02T08:00:00Z' },
      ],
    },
    {
      tracking_number: 'DEMO-POSTAL',
      carrier: 'mock_postal',
      events: [
        { id: 'postal-1', code: 'POSTAGEM_CONFIRMADA', description: 'Objeto postado', timestamp: '2025-08-01T08:00:00Z' },
        { id: 'postal-2', code: 'EM_TRANSFERENCIA', description: 'Objeto em transferência', timestamp: '2025-08-02T08:00:00Z' },
        { id: 'postal-3', code: 'SAIU_PARA_ENTREGA', description: 'Saiu para entrega', timestamp: '2025-08-03T08:00:00Z' },
        { id: 'postal-4', code: 'ENTREGA_REALIZADA', description: 'Entrega realizada', timestamp: '2025-08-04T08:00:00Z' },
      ],
    },
  ];

  return new Map(entries.map((entry) => [key(entry.carrier, entry.tracking_number), entry]));
}

export function key(carrier: string, trackingNumber: string): string {
  return JSON.stringify([carrier, trackingNumber]);
}
