import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertEngine } from './AlertEngine';
import type { AlertNotifyFn } from './AlertEngine';
import type { AlertDefinition } from '@sandforge/shared';

function createDefinition(overrides?: Partial<AlertDefinition>): AlertDefinition {
  return {
    id: 'def-1',
    name: 'High API Usage',
    description: 'Triggers when API usage exceeds threshold',
    enabled: true,
    metric: 'api_usage',
    condition: { operator: 'gt', threshold: 80 },
    severity: 'warning',
    cooldownMinutes: 5,
    notificationChannels: ['toast'],
    ...overrides,
  };
}

describe('AlertEngine', () => {
  let engine: AlertEngine;
  let onNotify: AlertNotifyFn;

  beforeEach(() => {
    vi.useFakeTimers();
    onNotify = vi.fn();
    engine = new AlertEngine(onNotify);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('addDefinition / removeDefinition / getDefinitions', () => {
    it('should add and retrieve a definition', () => {
      engine.addDefinition(createDefinition());
      expect(engine.getDefinitions()).toHaveLength(1);
    });

    it('should remove a definition by id', () => {
      engine.addDefinition(createDefinition());
      engine.removeDefinition('def-1');
      expect(engine.getDefinitions()).toHaveLength(0);
    });

    it('should handle removing a non-existent definition', () => {
      engine.removeDefinition('non-existent');
      expect(engine.getDefinitions()).toHaveLength(0);
    });

    it('should support multiple definitions', () => {
      engine.addDefinition(createDefinition({ id: 'def-1' }));
      engine.addDefinition(createDefinition({ id: 'def-2', metric: 'storage' }));
      expect(engine.getDefinitions()).toHaveLength(2);
    });
  });

  describe('evaluate', () => {
    it('should trigger alert when condition is met (gt)', () => {
      engine.addDefinition(createDefinition());
      const result = engine.evaluate('api_usage', 90, 'org-1');

      expect(result).not.toBeNull();
      expect(result!.severity).toBe('warning');
      expect(result!.currentValue).toBe(90);
      expect(result!.threshold).toBe(80);
    });

    it('should not trigger when condition is not met', () => {
      engine.addDefinition(createDefinition());
      const result = engine.evaluate('api_usage', 50, 'org-1');
      expect(result).toBeNull();
    });

    it('should not trigger for a different metric', () => {
      engine.addDefinition(createDefinition());
      const result = engine.evaluate('storage', 90, 'org-1');
      expect(result).toBeNull();
    });

    it('should not trigger when definition is disabled', () => {
      engine.addDefinition(createDefinition({ enabled: false }));
      const result = engine.evaluate('api_usage', 90, 'org-1');
      expect(result).toBeNull();
    });

    it('should evaluate gte operator correctly', () => {
      engine.addDefinition(createDefinition({ condition: { operator: 'gte', threshold: 80 } }));

      expect(engine.evaluate('api_usage', 80, 'org-1')).not.toBeNull();
      expect(engine.evaluate('api_usage', 79, 'org-1')).toBeNull();
    });

    it('should evaluate lt operator correctly', () => {
      engine.addDefinition(createDefinition({ condition: { operator: 'lt', threshold: 20 } }));

      expect(engine.evaluate('api_usage', 10, 'org-1')).not.toBeNull();
      expect(engine.evaluate('api_usage', 30, 'org-1')).toBeNull();
    });

    it('should evaluate lte operator correctly', () => {
      engine.addDefinition(createDefinition({ condition: { operator: 'lte', threshold: 20 } }));

      expect(engine.evaluate('api_usage', 20, 'org-1')).not.toBeNull();
      expect(engine.evaluate('api_usage', 21, 'org-1')).toBeNull();
    });

    it('should evaluate eq operator correctly', () => {
      engine.addDefinition(createDefinition({ condition: { operator: 'eq', threshold: 50 } }));

      expect(engine.evaluate('api_usage', 50, 'org-1')).not.toBeNull();
      expect(engine.evaluate('api_usage', 51, 'org-1')).toBeNull();
    });

    it('should evaluate neq operator correctly', () => {
      engine.addDefinition(createDefinition({ condition: { operator: 'neq', threshold: 50 } }));

      expect(engine.evaluate('api_usage', 49, 'org-1')).not.toBeNull();
      expect(engine.evaluate('api_usage', 50, 'org-1')).toBeNull();
    });

    it('should call onNotify when an alert is triggered', () => {
      engine.addDefinition(createDefinition());
      engine.evaluate('api_usage', 90, 'org-1');
      expect(onNotify).toHaveBeenCalledTimes(1);
    });

    it('should not call onNotify when no alert is triggered', () => {
      engine.addDefinition(createDefinition());
      engine.evaluate('api_usage', 50, 'org-1');
      expect(onNotify).not.toHaveBeenCalled();
    });
  });

  describe('cooldown', () => {
    it('should not re-trigger the same alert within cooldown period', () => {
      engine.addDefinition(createDefinition({ cooldownMinutes: 5 }));

      engine.evaluate('api_usage', 90, 'org-1');
      const second = engine.evaluate('api_usage', 95, 'org-1');

      expect(second).toBeNull();
      expect(onNotify).toHaveBeenCalledTimes(1);
    });

    it('should re-trigger after cooldown period expires', () => {
      engine.addDefinition(createDefinition({ cooldownMinutes: 5 }));

      engine.evaluate('api_usage', 90, 'org-1');
      vi.advanceTimersByTime(5 * 60 * 1000);
      const second = engine.evaluate('api_usage', 95, 'org-1');

      expect(second).not.toBeNull();
      expect(onNotify).toHaveBeenCalledTimes(2);
    });
  });

  describe('getActiveAlerts', () => {
    it('should return alerts with active or acknowledged status', () => {
      engine.addDefinition(createDefinition());
      engine.evaluate('api_usage', 90, 'org-1');

      const active = engine.getActiveAlerts();
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('active');
    });

    it('should not include resolved alerts', () => {
      engine.addDefinition(createDefinition());
      const alert = engine.evaluate('api_usage', 90, 'org-1');
      engine.resolveAlert(alert!.id);

      expect(engine.getActiveAlerts()).toHaveLength(0);
    });

    it('should not include dismissed alerts', () => {
      engine.addDefinition(createDefinition());
      const alert = engine.evaluate('api_usage', 90, 'org-1');
      engine.dismissAlert(alert!.id);

      expect(engine.getActiveAlerts()).toHaveLength(0);
    });
  });

  describe('acknowledgeAlert', () => {
    it('should set status to acknowledged with timestamp', () => {
      engine.addDefinition(createDefinition());
      const alert = engine.evaluate('api_usage', 90, 'org-1');
      engine.acknowledgeAlert(alert!.id);

      const active = engine.getActiveAlerts();
      expect(active[0].status).toBe('acknowledged');
      expect(active[0].acknowledgedAt).toBeDefined();
    });

    it('should not throw for a non-existent alert', () => {
      expect(() => engine.acknowledgeAlert('non-existent')).not.toThrow();
    });
  });

  describe('resolveAlert', () => {
    it('should set status to resolved with timestamp', () => {
      engine.addDefinition(createDefinition());
      const alert = engine.evaluate('api_usage', 90, 'org-1');
      engine.resolveAlert(alert!.id);

      expect(engine.getActiveAlerts()).toHaveLength(0);
    });

    it('should not throw for a non-existent alert', () => {
      expect(() => engine.resolveAlert('non-existent')).not.toThrow();
    });
  });

  describe('dismissAlert', () => {
    it('should set status to dismissed', () => {
      engine.addDefinition(createDefinition());
      const alert = engine.evaluate('api_usage', 90, 'org-1');
      engine.dismissAlert(alert!.id);

      expect(engine.getActiveAlerts()).toHaveLength(0);
    });

    it('should not throw for a non-existent alert', () => {
      expect(() => engine.dismissAlert('non-existent')).not.toThrow();
    });
  });

  describe('restoreAlerts', () => {
    it('should restore active alerts into the engine', () => {
      engine.restoreAlerts([
        {
          id: 'restored-1',
          definitionId: 'def-1',
          severity: 'critical',
          status: 'active',
          message: 'Restored alert',
          currentValue: 92,
          threshold: 90,
          orgId: 'org-1',
          triggeredAt: '2026-03-20T10:00:00.000Z',
        },
      ]);

      const active = engine.getActiveAlerts();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('restored-1');
    });

    it('should restore acknowledged alerts', () => {
      engine.restoreAlerts([
        {
          id: 'ack-1',
          definitionId: 'def-1',
          severity: 'warning',
          status: 'acknowledged',
          message: 'Ack alert',
          currentValue: 85,
          threshold: 80,
          orgId: 'org-1',
          triggeredAt: '2026-03-20T10:00:00.000Z',
          acknowledgedAt: '2026-03-20T10:05:00.000Z',
        },
      ]);

      const active = engine.getActiveAlerts();
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('acknowledged');
    });

    it('should skip resolved and dismissed alerts', () => {
      engine.restoreAlerts([
        {
          id: 'resolved-1',
          definitionId: 'def-1',
          severity: 'critical',
          status: 'resolved',
          message: 'Resolved',
          currentValue: 92,
          threshold: 90,
          orgId: 'org-1',
          triggeredAt: '2026-03-20T10:00:00.000Z',
          resolvedAt: '2026-03-20T10:10:00.000Z',
        },
        {
          id: 'dismissed-1',
          definitionId: 'def-1',
          severity: 'critical',
          status: 'dismissed',
          message: 'Dismissed',
          currentValue: 92,
          threshold: 90,
          orgId: 'org-1',
          triggeredAt: '2026-03-20T10:00:00.000Z',
        },
      ]);

      expect(engine.getActiveAlerts()).toHaveLength(0);
    });

    it('should handle empty array', () => {
      engine.restoreAlerts([]);
      expect(engine.getActiveAlerts()).toHaveLength(0);
    });
  });
});
