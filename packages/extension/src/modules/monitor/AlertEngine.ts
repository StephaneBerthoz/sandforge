import type {
  AlertCondition,
  AlertDefinition,
  AlertInstance,
  AlertStatus,
} from '@sandforge/shared';

/** Callback invoked when an alert is triggered */
export type AlertNotifyFn = (alert: AlertInstance) => void;

/**
 * Evaluates metric values against alert definitions and manages alert lifecycle.
 * Supports cooldown periods to prevent alert storms, and provides methods
 * for acknowledging, resolving, and dismissing alerts.
 */
export class AlertEngine {
  private readonly onNotify: AlertNotifyFn;
  private readonly definitions: Map<string, AlertDefinition> = new Map();
  private readonly activeAlerts: Map<string, AlertInstance> = new Map();
  private readonly lastTriggered: Map<string, number> = new Map();
  private idCounter = 0;

  constructor(onNotify: AlertNotifyFn) {
    this.onNotify = onNotify;
  }

  /** Register a new alert definition */
  addDefinition(def: AlertDefinition): void {
    this.definitions.set(def.id, def);
  }

  /** Remove an alert definition by ID */
  removeDefinition(id: string): void {
    this.definitions.delete(id);
  }

  /** Return all registered alert definitions */
  getDefinitions(): AlertDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * Evaluate a metric value against all matching alert definitions.
   * Returns a new AlertInstance if triggered, or null if no alert fires.
   */
  evaluate(metric: string, value: number, orgId: string): AlertInstance | null {
    for (const def of this.definitions.values()) {
      if (!def.enabled || def.metric !== metric) {
        continue;
      }

      if (!evaluateCondition(def.condition, value)) {
        continue;
      }

      if (this.isInCooldown(def.id)) {
        continue;
      }

      const alert = this.createAlert(def, value, orgId);
      this.activeAlerts.set(alert.id, alert);
      this.lastTriggered.set(def.id, Date.now());
      this.onNotify(alert);
      return alert;
    }

    return null;
  }

  /** Return all alerts that have not been resolved or dismissed */
  getActiveAlerts(): AlertInstance[] {
    return [...this.activeAlerts.values()].filter(
      (a) => a.status === 'active' || a.status === 'acknowledged'
    );
  }

  /** Mark an alert as acknowledged */
  acknowledgeAlert(id: string): void {
    const alert = this.activeAlerts.get(id);
    if (alert) {
      alert.status = 'acknowledged';
      alert.acknowledgedAt = new Date().toISOString();
    }
  }

  /** Mark an alert as resolved */
  resolveAlert(id: string): void {
    const alert = this.activeAlerts.get(id);
    if (alert) {
      alert.status = 'resolved';
      alert.resolvedAt = new Date().toISOString();
    }
  }

  /** Mark an alert as dismissed */
  dismissAlert(id: string): void {
    const alert = this.activeAlerts.get(id);
    if (alert) {
      alert.status = 'dismissed';
    }
  }

  private isInCooldown(definitionId: string): boolean {
    const lastTime = this.lastTriggered.get(definitionId);
    if (lastTime === undefined) {
      return false;
    }
    const def = this.definitions.get(definitionId);
    if (!def) {
      return false;
    }
    const cooldownMs = def.cooldownMinutes * 60 * 1000;
    return Date.now() - lastTime < cooldownMs;
  }

  private createAlert(
    def: AlertDefinition,
    value: number,
    orgId: string
  ): AlertInstance {
    this.idCounter++;
    return {
      id: `alert-${this.idCounter}`,
      definitionId: def.id,
      severity: def.severity,
      status: 'active' as AlertStatus,
      message: `${def.name}: ${def.metric} is ${value} (threshold: ${def.condition.threshold})`,
      currentValue: value,
      threshold: def.condition.threshold,
      orgId,
      triggeredAt: new Date().toISOString(),
    };
  }
}

/** Evaluate whether a value satisfies an alert condition */
function evaluateCondition(condition: AlertCondition, value: number): boolean {
  switch (condition.operator) {
    case 'gt':
      return value > condition.threshold;
    case 'gte':
      return value >= condition.threshold;
    case 'lt':
      return value < condition.threshold;
    case 'lte':
      return value <= condition.threshold;
    case 'eq':
      return value === condition.threshold;
    case 'neq':
      return value !== condition.threshold;
  }
}
