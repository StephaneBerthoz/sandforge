import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TelemetryService,
  telemetryEventSchema,
} from './TelemetryService';
import type {
  TelemetryStorage,
  TelemetrySender,
  TelemetryEvent,
} from './TelemetryService';

function createEvent(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    eventName: 'sync_executed',
    module: 'sync',
    action: 'execute',
    properties: {},
    duration: 1500,
    recordCount: 100,
    success: true,
    timestamp: '2026-02-20T10:00:00Z',
    ...overrides,
  };
}

function createMockStorage(
  initialEnabled: boolean = false,
  initialEvents: TelemetryEvent[] = []
): TelemetryStorage {
  let enabled = initialEnabled;
  let events = [...initialEvents];

  return {
    getEnabled: vi.fn().mockImplementation(async () => enabled),
    setEnabled: vi.fn().mockImplementation(async (val: boolean) => {
      enabled = val;
    }),
    getEvents: vi.fn().mockImplementation(async () => [...events]),
    appendEvent: vi.fn().mockImplementation(async (event: TelemetryEvent) => {
      events.push(event);
    }),
    clearEvents: vi.fn().mockImplementation(async () => {
      events = [];
    }),
  };
}

function createMockSender(success: boolean = true): TelemetrySender {
  return {
    send: vi.fn().mockResolvedValue(success),
  };
}

describe('TelemetryService', () => {
  let storage: TelemetryStorage;
  let sender: TelemetrySender;
  let service: TelemetryService;

  beforeEach(async () => {
    storage = createMockStorage(false);
    sender = createMockSender(true);
    service = new TelemetryService(storage, sender, '1.0.0', 5);
    await service.initialize();
  });

  describe('initialize', () => {
    it('should load enabled state from storage', async () => {
      const enabledStorage = createMockStorage(true);
      const svc = new TelemetryService(enabledStorage, sender, '1.0.0');
      await svc.initialize();

      expect(svc.isEnabled()).toBe(true);
      expect(enabledStorage.getEnabled).toHaveBeenCalledTimes(1);
    });

    it('should load existing events when enabled', async () => {
      const existingEvents = [createEvent()];
      const enabledStorage = createMockStorage(true, existingEvents);
      const svc = new TelemetryService(enabledStorage, sender, '1.0.0');
      await svc.initialize();

      expect(svc.getBufferSize()).toBe(1);
    });

    it('should not load events when disabled', async () => {
      const existingEvents = [createEvent()];
      const disabledStorage = createMockStorage(false, existingEvents);
      const svc = new TelemetryService(disabledStorage, sender, '1.0.0');
      await svc.initialize();

      expect(svc.getBufferSize()).toBe(0);
    });
  });

  describe('trackEvent', () => {
    it('should silently drop events when disabled', async () => {
      await service.trackEvent(createEvent());

      expect(service.getBufferSize()).toBe(0);
      expect(storage.appendEvent).not.toHaveBeenCalled();
    });

    it('should store events when enabled', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent());

      expect(service.getBufferSize()).toBe(1);
      expect(storage.appendEvent).toHaveBeenCalledTimes(1);
    });

    it('should validate event data', async () => {
      await service.setEnabled(true);

      await expect(
        service.trackEvent({
          eventName: '',
          module: 'sync',
          action: 'execute',
          success: true,
          timestamp: '2026-01-01',
          properties: {},
        })
      ).rejects.toThrow();
    });

    it('should auto-flush when batch size is reached', async () => {
      await service.setEnabled(true);

      for (let i = 0; i < 5; i++) {
        await service.trackEvent(
          createEvent({ timestamp: `2026-02-20T10:0${i}:00Z` })
        );
      }

      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    it('should not auto-flush before batch size', async () => {
      await service.setEnabled(true);

      for (let i = 0; i < 4; i++) {
        await service.trackEvent(
          createEvent({ timestamp: `2026-02-20T10:0${i}:00Z` })
        );
      }

      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('isEnabled', () => {
    it('should return false by default', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('should return true after enabling', async () => {
      await service.setEnabled(true);
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('should persist enabled state', async () => {
      await service.setEnabled(true);
      expect(storage.setEnabled).toHaveBeenCalledWith(true);
    });

    it('should clear buffer and storage when disabling', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent());
      expect(service.getBufferSize()).toBe(1);

      await service.setEnabled(false);
      expect(service.getBufferSize()).toBe(0);
      expect(storage.clearEvents).toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should send buffered events as a batch', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent());
      await service.trackEvent(createEvent({ module: 'seed', action: 'generate' }));

      const result = await service.flush();

      expect(result).toBe(true);
      expect(sender.send).toHaveBeenCalledTimes(1);
      const batch = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(batch.events).toHaveLength(2);
      expect(batch.extensionVersion).toBe('1.0.0');
      expect(batch.batchId).toBeDefined();
    });

    it('should clear buffer after successful send', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent());

      await service.flush();

      expect(service.getBufferSize()).toBe(0);
      expect(storage.clearEvents).toHaveBeenCalled();
    });

    it('should retain buffer after failed send', async () => {
      const failSender = createMockSender(false);
      const svc = new TelemetryService(storage, failSender, '1.0.0');
      await svc.initialize();
      await svc.setEnabled(true);
      await svc.trackEvent(createEvent());

      const result = await svc.flush();

      expect(result).toBe(false);
      expect(svc.getBufferSize()).toBe(1);
    });

    it('should return true for empty buffer', async () => {
      const result = await service.flush();
      expect(result).toBe(true);
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('getSummary', () => {
    it('should aggregate events by module', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent({ module: 'sync' }));
      await service.trackEvent(createEvent({ module: 'sync' }));
      await service.trackEvent(createEvent({ module: 'seed' }));

      const summary = service.getSummary();

      expect(summary.totalEvents).toBe(3);
      expect(summary.eventsByModule['sync']).toBe(2);
      expect(summary.eventsByModule['seed']).toBe(1);
    });

    it('should aggregate events by action', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent({ action: 'execute' }));
      await service.trackEvent(createEvent({ action: 'execute' }));
      await service.trackEvent(createEvent({ action: 'preview' }));

      const summary = service.getSummary();

      expect(summary.eventsByAction['execute']).toBe(2);
      expect(summary.eventsByAction['preview']).toBe(1);
    });

    it('should count errors and group by type', async () => {
      await service.setEnabled(true);
      await service.trackEvent(
        createEvent({ success: false, errorType: 'auth' })
      );
      await service.trackEvent(
        createEvent({ success: false, errorType: 'limit' })
      );
      await service.trackEvent(
        createEvent({ success: false, errorType: 'auth' })
      );
      await service.trackEvent(createEvent({ success: true }));

      const summary = service.getSummary();

      expect(summary.errorCount).toBe(3);
      expect(summary.errorsByType['auth']).toBe(2);
      expect(summary.errorsByType['limit']).toBe(1);
    });

    it('should calculate average duration', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent({ duration: 1000 }));
      await service.trackEvent(createEvent({ duration: 3000 }));

      const summary = service.getSummary();

      expect(summary.averageDuration).toBe(2000);
    });

    it('should sum total records processed', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent({ recordCount: 100 }));
      await service.trackEvent(createEvent({ recordCount: 250 }));

      const summary = service.getSummary();

      expect(summary.totalRecordsProcessed).toBe(350);
    });

    it('should set period start and end from timestamps', async () => {
      await service.setEnabled(true);
      await service.trackEvent(createEvent({ timestamp: '2026-02-20T08:00:00Z' }));
      await service.trackEvent(createEvent({ timestamp: '2026-02-20T12:00:00Z' }));

      const summary = service.getSummary();

      expect(summary.periodStart).toBe('2026-02-20T08:00:00Z');
      expect(summary.periodEnd).toBe('2026-02-20T12:00:00Z');
    });

    it('should handle empty buffer', () => {
      const summary = service.getSummary();

      expect(summary.totalEvents).toBe(0);
      expect(summary.errorCount).toBe(0);
      expect(summary.averageDuration).toBe(0);
      expect(summary.totalRecordsProcessed).toBe(0);
      expect(summary.periodStart).toBe('');
      expect(summary.periodEnd).toBe('');
    });
  });

  describe('telemetryEventSchema', () => {
    it('should validate a correct event', () => {
      const event = createEvent();
      const result = telemetryEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('should reject empty eventName', () => {
      const result = telemetryEventSchema.safeParse(
        createEvent({ eventName: '' })
      );
      expect(result.success).toBe(false);
    });

    it('should reject invalid module', () => {
      const result = telemetryEventSchema.safeParse({
        ...createEvent(),
        module: 'invalid_module',
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative duration', () => {
      const result = telemetryEventSchema.safeParse(
        createEvent({ duration: -1 })
      );
      expect(result.success).toBe(false);
    });

    it('should apply default empty properties', () => {
      const event = {
        eventName: 'test',
        module: 'sync',
        action: 'execute',
        success: true,
        timestamp: '2026-01-01T00:00:00Z',
      };
      const result = telemetryEventSchema.parse(event);
      expect(result.properties).toEqual({});
    });

    it('should allow all valid modules', () => {
      const modules = ['seed', 'sync', 'monitor', 'compare', 'dataops', 'automation', 'migration', 'plugins'] as const;
      for (const mod of modules) {
        const result = telemetryEventSchema.safeParse(
          createEvent({ module: mod })
        );
        expect(result.success).toBe(true);
      }
    });
  });
});
