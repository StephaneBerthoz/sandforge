import type { PipelineTrigger } from '@sandforge/shared';

/**
 * Evaluates and manages pipeline triggers.
 * Supports cron-based scheduling, event matching, and general trigger
 * eligibility checks.
 */
export class TriggerEngine {
  /**
   * Check whether a trigger should fire right now.
   * A trigger fires if it is enabled and its type-specific conditions are met.
   * @param trigger - The trigger to evaluate
   * @returns true if the trigger should fire
   */
  evaluateTrigger(trigger: PipelineTrigger): boolean {
    if (!trigger.enabled) {
      return false;
    }

    switch (trigger.type) {
      case 'manual':
        return true;
      case 'schedule':
        return trigger.config.cron
          ? this.matchesCron(trigger.config.cron, new Date())
          : false;
      case 'event':
        return false;
      case 'webhook':
        return false;
      case 'sandbox_refresh':
        return false;
      case 'deployment_complete':
        return false;
    }
  }

  /**
   * Check whether a cron expression matches the given date.
   * Supports simple 5-field cron: minute hour day-of-month month day-of-week.
   * Each field may be `*` (any) or a numeric literal.
   * @param cron - A 5-field cron expression
   * @param date - The date to test against
   * @returns true if the cron matches the date
   */
  matchesCron(cron: string, date: Date): boolean {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) {
      return false;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    return (
      this.matchesCronField(minute, date.getMinutes()) &&
      this.matchesCronField(hour, date.getHours()) &&
      this.matchesCronField(dayOfMonth, date.getDate()) &&
      this.matchesCronField(month, date.getMonth() + 1) &&
      this.matchesCronField(dayOfWeek, date.getDay())
    );
  }

  /**
   * Check whether a trigger matches a specific event type.
   * Only triggers of type 'event' with a matching eventType in their config
   * will return true.
   * @param trigger - The trigger to check
   * @param eventType - The event type string to match against
   * @returns true if the trigger matches the event
   */
  matchesEvent(trigger: PipelineTrigger, eventType: string): boolean {
    if (trigger.type !== 'event') {
      return false;
    }
    if (!trigger.enabled) {
      return false;
    }
    return trigger.config.eventType === eventType;
  }

  /**
   * Calculate the next fire time for a schedule trigger.
   * For non-schedule triggers, returns undefined.
   * @param trigger - The trigger to compute the next fire time for
   * @returns The next Date at which the trigger should fire, or undefined
   */
  getNextFireTime(trigger: PipelineTrigger): Date | undefined {
    if (trigger.type !== 'schedule' || !trigger.config.cron || !trigger.enabled) {
      return undefined;
    }

    const now = new Date();
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    const maxAttempts = 1440;
    for (let i = 0; i < maxAttempts; i++) {
      if (this.matchesCron(trigger.config.cron, candidate)) {
        return candidate;
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return undefined;
  }

  /**
   * Return all enabled triggers from the provided array.
   * @param triggers - Array of triggers to filter
   * @returns Only the triggers that are enabled
   */
  getActiveTriggers(triggers: PipelineTrigger[]): PipelineTrigger[] {
    return triggers.filter((t) => t.enabled);
  }

  private matchesCronField(field: string, value: number): boolean {
    if (field === '*') {
      return true;
    }
    const parsed = parseInt(field, 10);
    if (isNaN(parsed)) {
      return false;
    }
    return parsed === value;
  }
}
