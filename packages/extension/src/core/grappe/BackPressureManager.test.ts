import { describe, it, expect, beforeEach } from 'vitest';
import { BackPressureManager } from './BackPressureManager';
import type { BackPressureConfig } from '@sandforge/shared';

function createConfig(overrides: Partial<BackPressureConfig> = {}): BackPressureConfig {
  return {
    enabled: true,
    maxQueueDepth: 100,
    highWaterMark: 80,
    lowWaterMark: 60,
    strategy: 'pause',
    monitoringInterval: 1000,
    ...overrides,
  };
}

describe('BackPressureManager', () => {
  let manager: BackPressureManager;

  beforeEach(() => {
    manager = new BackPressureManager(createConfig());
  });

  describe('evaluate', () => {
    it('should return normal when both metrics are low', () => {
      const level = manager.evaluate(10, 20);
      expect(level).toBe('normal');
    });

    it('should return warning when queue depth is at 70% of max', () => {
      const level = manager.evaluate(70, 20);
      expect(level).toBe('warning');
    });

    it('should return warning when API usage reaches low water mark', () => {
      const level = manager.evaluate(10, 60);
      expect(level).toBe('warning');
    });

    it('should return critical when queue depth reaches max', () => {
      const level = manager.evaluate(100, 20);
      expect(level).toBe('critical');
    });

    it('should return critical when API usage reaches high water mark', () => {
      const level = manager.evaluate(10, 80);
      expect(level).toBe('critical');
    });

    it('should always return normal when disabled', () => {
      const disabled = new BackPressureManager(createConfig({ enabled: false }));
      expect(disabled.evaluate(200, 95)).toBe('normal');
    });
  });

  describe('shouldPause', () => {
    it('should return true when critical and strategy is pause', () => {
      manager.evaluate(100, 90);
      expect(manager.shouldPause()).toBe(true);
    });

    it('should return false when strategy is throttle', () => {
      const throttle = new BackPressureManager(createConfig({ strategy: 'throttle' }));
      throttle.evaluate(100, 90);
      expect(throttle.shouldPause()).toBe(false);
    });

    it('should return false when level is normal', () => {
      manager.evaluate(10, 10);
      expect(manager.shouldPause()).toBe(false);
    });

    it('should return false when disabled', () => {
      const disabled = new BackPressureManager(createConfig({ enabled: false }));
      disabled.evaluate(200, 95);
      expect(disabled.shouldPause()).toBe(false);
    });
  });

  describe('shouldThrottle', () => {
    it('should return true when warning and strategy is throttle', () => {
      const throttle = new BackPressureManager(createConfig({ strategy: 'throttle' }));
      throttle.evaluate(70, 20);
      expect(throttle.shouldThrottle()).toBe(true);
    });

    it('should return true when critical and strategy is throttle', () => {
      const throttle = new BackPressureManager(createConfig({ strategy: 'throttle' }));
      throttle.evaluate(100, 90);
      expect(throttle.shouldThrottle()).toBe(true);
    });

    it('should return false when strategy is pause', () => {
      manager.evaluate(70, 20);
      expect(manager.shouldThrottle()).toBe(false);
    });

    it('should return false when disabled', () => {
      const disabled = new BackPressureManager(
        createConfig({ enabled: false, strategy: 'throttle' }),
      );
      disabled.evaluate(200, 95);
      expect(disabled.shouldThrottle()).toBe(false);
    });
  });

  describe('getDelay', () => {
    it('should return 0 for normal level', () => {
      manager.evaluate(10, 10);
      expect(manager.getDelay()).toBe(0);
    });

    it('should return 500ms for warning level', () => {
      manager.evaluate(70, 20);
      expect(manager.getDelay()).toBe(500);
    });

    it('should return 2000ms for critical level', () => {
      manager.evaluate(100, 90);
      expect(manager.getDelay()).toBe(2000);
    });

    it('should return 0 when disabled', () => {
      const disabled = new BackPressureManager(createConfig({ enabled: false }));
      disabled.evaluate(200, 95);
      expect(disabled.getDelay()).toBe(0);
    });
  });

  describe('getLevel', () => {
    it('should return the current level after evaluation', () => {
      expect(manager.getLevel()).toBe('normal');
      manager.evaluate(100, 90);
      expect(manager.getLevel()).toBe('critical');
    });
  });

  describe('reset', () => {
    it('should reset the level to normal', () => {
      manager.evaluate(100, 90);
      expect(manager.getLevel()).toBe('critical');

      manager.reset();
      expect(manager.getLevel()).toBe('normal');
    });
  });
});
