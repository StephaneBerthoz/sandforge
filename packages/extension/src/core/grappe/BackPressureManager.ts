import type { BackPressureConfig, BackPressureLevel } from '@sandforge/shared';

/** Delay constants for throttling in milliseconds */
const WARNING_DELAY_MS = 500;
const CRITICAL_DELAY_MS = 2000;

/**
 * Monitors and controls back-pressure for grappe operations.
 * Evaluates queue depth and API usage to determine whether processing should
 * pause, throttle, or continue normally.
 */
export class BackPressureManager {
  private readonly config: BackPressureConfig;
  private currentLevel: BackPressureLevel = 'normal';

  /**
   * Create a new BackPressureManager.
   * @param config - Back-pressure configuration defining thresholds and strategy
   */
  constructor(config: BackPressureConfig) {
    this.config = config;
  }

  /**
   * Evaluate current conditions and determine the back-pressure level.
   * Updates internal state and returns the new level.
   * @param queueDepth - Current number of items in the processing queue
   * @param apiUsagePercent - Current Salesforce API usage percentage (0-100)
   * @returns The computed back-pressure level
   */
  evaluate(queueDepth: number, apiUsagePercent: number): BackPressureLevel {
    if (!this.config.enabled) {
      this.currentLevel = 'normal';
      return 'normal';
    }

    if (queueDepth >= this.config.maxQueueDepth || apiUsagePercent >= this.config.highWaterMark) {
      this.currentLevel = 'critical';
      return 'critical';
    }

    if (
      queueDepth >= this.config.maxQueueDepth * 0.7 ||
      apiUsagePercent >= this.config.lowWaterMark
    ) {
      this.currentLevel = 'warning';
      return 'warning';
    }

    this.currentLevel = 'normal';
    return 'normal';
  }

  /**
   * Check whether processing should be paused entirely.
   * Returns true when pressure is critical and strategy is 'pause'.
   * @returns True if processing should pause
   */
  shouldPause(): boolean {
    if (!this.config.enabled) {
      return false;
    }
    return this.currentLevel === 'critical' && this.config.strategy === 'pause';
  }

  /**
   * Check whether processing should be throttled (slowed down).
   * Returns true when pressure is at warning or critical level and strategy is 'throttle'.
   * @returns True if processing should be throttled
   */
  shouldThrottle(): boolean {
    if (!this.config.enabled) {
      return false;
    }
    return (
      (this.currentLevel === 'warning' || this.currentLevel === 'critical') &&
      this.config.strategy === 'throttle'
    );
  }

  /**
   * Get the recommended delay in milliseconds based on current pressure level.
   * Returns 0 for normal, a moderate delay for warning, and a longer delay for critical.
   * @returns Delay in milliseconds
   */
  getDelay(): number {
    if (!this.config.enabled) {
      return 0;
    }

    switch (this.currentLevel) {
      case 'normal':
        return 0;
      case 'warning':
        return WARNING_DELAY_MS;
      case 'critical':
        return CRITICAL_DELAY_MS;
    }
  }

  /**
   * Get the current back-pressure level.
   * @returns The current back-pressure level
   */
  getLevel(): BackPressureLevel {
    return this.currentLevel;
  }

  /**
   * Reset the manager to normal state.
   */
  reset(): void {
    this.currentLevel = 'normal';
  }
}
