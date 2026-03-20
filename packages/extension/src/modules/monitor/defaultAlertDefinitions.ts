import type { AlertDefinition } from '@sandforge/shared';

/**
 * Default alert definitions covering the five most critical Salesforce org limits.
 *
 * These are registered into the AlertEngine on first launch when no persisted
 * definitions exist. Each threshold represents a percentage usage level (usedPercent)
 * that triggers the alert.
 */
export const DEFAULT_ALERT_DEFINITIONS: AlertDefinition[] = [
  {
    id: 'alert-api-critical',
    name: 'API Requests Critical',
    description: 'Fires when daily API request usage reaches 90% of the org limit',
    enabled: true,
    metric: 'DailyApiRequests',
    condition: { operator: 'gte', threshold: 90 },
    severity: 'critical',
    cooldownMinutes: 15,
    notificationChannels: ['vscode_notification'],
  },
  {
    id: 'alert-storage-critical',
    name: 'Data Storage Critical',
    description: 'Fires when data storage usage reaches 85% of the org limit',
    enabled: true,
    metric: 'DataStorageMB',
    condition: { operator: 'gte', threshold: 85 },
    severity: 'critical',
    cooldownMinutes: 30,
    notificationChannels: ['vscode_notification'],
  },
  {
    id: 'alert-async-critical',
    name: 'Async Apex Critical',
    description: 'Fires when daily async Apex execution usage reaches 90% of the org limit',
    enabled: true,
    metric: 'DailyAsyncApexExecutions',
    condition: { operator: 'gte', threshold: 90 },
    severity: 'critical',
    cooldownMinutes: 15,
    notificationChannels: ['vscode_notification'],
  },
  {
    id: 'alert-email-warning',
    name: 'Workflow Emails Warning',
    description: 'Fires when daily workflow email usage reaches 80% of the org limit',
    enabled: true,
    metric: 'DailyWorkflowEmails',
    condition: { operator: 'gte', threshold: 80 },
    severity: 'warning',
    cooldownMinutes: 30,
    notificationChannels: ['vscode_notification'],
  },
  {
    id: 'alert-filestorage-critical',
    name: 'File Storage Critical',
    description: 'Fires when file storage usage reaches 85% of the org limit',
    enabled: true,
    metric: 'FileStorageMB',
    condition: { operator: 'gte', threshold: 85 },
    severity: 'critical',
    cooldownMinutes: 30,
    notificationChannels: ['vscode_notification'],
  },
];
