import { describe, it, expect } from 'vitest';
import type {
  AlertDefinition,
  AlertInstance,
  DashboardWidget,
  OrgHealthStatus,
  TrendData,
  OrgTrendPayload,
} from './monitor.types.js';

describe('monitor.types', () => {
  describe('AlertDefinition', () => {
    it('should accept a valid AlertDefinition with all required fields', () => {
      const alert: AlertDefinition = {
        id: 'alert-def-001',
        name: 'API Limit Warning',
        description: 'Fires when API usage exceeds 80% of daily limit',
        enabled: true,
        metric: 'api_usage_percent',
        condition: {
          operator: 'gte',
          threshold: 80,
          sustainedSeconds: 60,
        },
        severity: 'warning',
        cooldownMinutes: 30,
        notificationChannels: ['toast', 'vscode_notification'],
      };

      expect(alert.id).toBe('alert-def-001');
      expect(alert.enabled).toBe(true);
      expect(alert.condition.operator).toBe('gte');
      expect(alert.condition.threshold).toBe(80);
      expect(alert.severity).toBe('warning');
      expect(alert.notificationChannels).toHaveLength(2);
    });

    it('should accept a critical alert without sustainedSeconds', () => {
      const alert: AlertDefinition = {
        id: 'alert-def-002',
        name: 'Storage Critical',
        description: 'Storage above 95% capacity',
        enabled: true,
        metric: 'storage_usage_percent',
        condition: {
          operator: 'gt',
          threshold: 95,
        },
        severity: 'critical',
        cooldownMinutes: 5,
        notificationChannels: ['toast', 'vscode_notification', 'sound'],
      };

      expect(alert.severity).toBe('critical');
      expect(alert.condition.sustainedSeconds).toBeUndefined();
      expect(alert.cooldownMinutes).toBe(5);
    });
  });

  describe('AlertInstance', () => {
    it('should accept a triggered alert instance', () => {
      const instance: AlertInstance = {
        id: 'alert-inst-001',
        definitionId: 'alert-def-001',
        severity: 'warning',
        status: 'active',
        message: 'API usage at 85% (threshold: 80%)',
        currentValue: 85,
        threshold: 80,
        orgId: 'org-001',
        triggeredAt: '2026-02-15T14:30:00Z',
      };

      expect(instance.status).toBe('active');
      expect(instance.currentValue).toBe(85);
      expect(instance.acknowledgedAt).toBeUndefined();
      expect(instance.resolvedAt).toBeUndefined();
    });

    it('should accept an acknowledged and resolved alert instance', () => {
      const instance: AlertInstance = {
        id: 'alert-inst-002',
        definitionId: 'alert-def-002',
        severity: 'critical',
        status: 'resolved',
        message: 'Storage at 97% capacity',
        currentValue: 97,
        threshold: 95,
        orgId: 'org-002',
        triggeredAt: '2026-02-15T10:00:00Z',
        acknowledgedAt: '2026-02-15T10:05:00Z',
        resolvedAt: '2026-02-15T11:00:00Z',
      };

      expect(instance.status).toBe('resolved');
      expect(instance.acknowledgedAt).toBe('2026-02-15T10:05:00Z');
      expect(instance.resolvedAt).toBeDefined();
    });
  });

  describe('DashboardWidget', () => {
    it('should accept a valid DashboardWidget with position and config', () => {
      const widget: DashboardWidget = {
        id: 'widget-001',
        type: 'gauge',
        title: 'API Usage',
        metric: 'api_usage_percent',
        position: { x: 0, y: 0, width: 4, height: 3 },
        config: {
          refreshInterval: 30,
          thresholds: { warning: 70, critical: 90 },
        },
      };

      expect(widget.type).toBe('gauge');
      expect(widget.position.width).toBe(4);
      expect(widget.config.thresholds).toEqual({ warning: 70, critical: 90 });
    });

    it('should accept different widget types with minimal config', () => {
      const tableWidget: DashboardWidget = {
        id: 'widget-002',
        type: 'table',
        title: 'Recent Apex Logs',
        metric: 'apex_logs',
        position: { x: 4, y: 0, width: 8, height: 6 },
        config: {
          timeRange: '24h',
          orgIds: ['org-001', 'org-002'],
        },
      };

      expect(tableWidget.type).toBe('table');
      expect(tableWidget.config.orgIds).toHaveLength(2);
      expect(tableWidget.config.soqlQuery).toBeUndefined();
    });
  });

  describe('OrgHealthStatus', () => {
    it('should accept a healthy org status', () => {
      const health: OrgHealthStatus = {
        orgId: 'org-001',
        overall: 'healthy',
        apiLimitsStatus: 'ok',
        storageStatus: 'ok',
        activeJobs: 2,
        recentErrors: 0,
        lastChecked: '2026-02-15T16:00:00Z',
      };

      expect(health.overall).toBe('healthy');
      expect(health.apiLimitsStatus).toBe('ok');
      expect(health.recentErrors).toBe(0);
    });

    it('should accept a degraded org status with warnings', () => {
      const health: OrgHealthStatus = {
        orgId: 'org-002',
        overall: 'degraded',
        apiLimitsStatus: 'warning',
        storageStatus: 'critical',
        activeJobs: 15,
        recentErrors: 42,
        lastChecked: '2026-02-15T16:05:00Z',
      };

      expect(health.overall).toBe('degraded');
      expect(health.storageStatus).toBe('critical');
      expect(health.activeJobs).toBe(15);
      expect(health.recentErrors).toBe(42);
    });
  });

  describe('TrendData', () => {
    it('should accept a valid TrendData with increasing direction', () => {
      const trend: TrendData = {
        limitName: 'DailyApiRequests',
        direction: 'up',
        changePercent: 12.5,
        predictedTimeToLimit: 4.2,
        sparklineData: [40, 45, 52, 60, 65],
      };

      expect(trend.limitName).toBe('DailyApiRequests');
      expect(trend.direction).toBe('up');
      expect(trend.changePercent).toBe(12.5);
      expect(trend.predictedTimeToLimit).toBe(4.2);
      expect(trend.sparklineData).toHaveLength(5);
    });

    it('should accept a stable TrendData without predictedTimeToLimit', () => {
      const trend: TrendData = {
        limitName: 'DataStorageMB',
        direction: 'stable',
        changePercent: 0,
        sparklineData: [30, 30, 31, 30, 30],
      };

      expect(trend.direction).toBe('stable');
      expect(trend.predictedTimeToLimit).toBeUndefined();
    });

    it('should accept a decreasing TrendData', () => {
      const trend: TrendData = {
        limitName: 'DailySoqlQueries',
        direction: 'down',
        changePercent: -5.3,
        sparklineData: [80, 75, 70, 68, 65],
      };

      expect(trend.direction).toBe('down');
      expect(trend.changePercent).toBe(-5.3);
    });
  });

  describe('OrgTrendPayload', () => {
    it('should accept a valid OrgTrendPayload with multiple trends', () => {
      const payload: OrgTrendPayload = {
        orgId: 'org-001',
        trends: {
          DailyApiRequests: {
            limitName: 'DailyApiRequests',
            direction: 'up',
            changePercent: 10,
            predictedTimeToLimit: 6,
            sparklineData: [50, 55, 60],
          },
          DataStorageMB: {
            limitName: 'DataStorageMB',
            direction: 'stable',
            changePercent: 0,
            sparklineData: [30, 30, 30],
          },
        },
        periodLabel: '24h',
      };

      expect(payload.orgId).toBe('org-001');
      expect(Object.keys(payload.trends)).toHaveLength(2);
      expect(payload.periodLabel).toBe('24h');
    });

    it('should accept an empty trends record', () => {
      const payload: OrgTrendPayload = {
        orgId: 'org-002',
        trends: {},
        periodLabel: '7d',
      };

      expect(Object.keys(payload.trends)).toHaveLength(0);
    });
  });
});
