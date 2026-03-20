import { describe, it, expect } from 'vitest';
import { DEFAULT_ALERT_DEFINITIONS } from './defaultAlertDefinitions';

describe('DEFAULT_ALERT_DEFINITIONS', () => {
  it('exports exactly 5 definitions', () => {
    expect(DEFAULT_ALERT_DEFINITIONS).toHaveLength(5);
  });

  it('all definitions have enabled: true', () => {
    for (const def of DEFAULT_ALERT_DEFINITIONS) {
      expect(def.enabled).toBe(true);
    }
  });

  it('all IDs are unique', () => {
    const ids = DEFAULT_ALERT_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all definitions have positive cooldownMinutes', () => {
    for (const def of DEFAULT_ALERT_DEFINITIONS) {
      expect(def.cooldownMinutes).toBeGreaterThan(0);
    }
  });

  it('all definitions have vscode_notification channel', () => {
    for (const def of DEFAULT_ALERT_DEFINITIONS) {
      expect(def.notificationChannels).toContain('vscode_notification');
    }
  });

  it('alert-api-critical targets DailyApiRequests at 90% critical', () => {
    const def = DEFAULT_ALERT_DEFINITIONS.find((d) => d.id === 'alert-api-critical');
    expect(def).toBeDefined();
    expect(def!.metric).toBe('DailyApiRequests');
    expect(def!.condition.operator).toBe('gte');
    expect(def!.condition.threshold).toBe(90);
    expect(def!.severity).toBe('critical');
    expect(def!.cooldownMinutes).toBe(15);
  });

  it('alert-storage-critical targets DataStorageMB at 85% critical', () => {
    const def = DEFAULT_ALERT_DEFINITIONS.find((d) => d.id === 'alert-storage-critical');
    expect(def).toBeDefined();
    expect(def!.metric).toBe('DataStorageMB');
    expect(def!.condition.operator).toBe('gte');
    expect(def!.condition.threshold).toBe(85);
    expect(def!.severity).toBe('critical');
    expect(def!.cooldownMinutes).toBe(30);
  });

  it('alert-async-critical targets DailyAsyncApexExecutions at 90% critical', () => {
    const def = DEFAULT_ALERT_DEFINITIONS.find((d) => d.id === 'alert-async-critical');
    expect(def).toBeDefined();
    expect(def!.metric).toBe('DailyAsyncApexExecutions');
    expect(def!.condition.operator).toBe('gte');
    expect(def!.condition.threshold).toBe(90);
    expect(def!.severity).toBe('critical');
    expect(def!.cooldownMinutes).toBe(15);
  });

  it('alert-email-warning targets DailyWorkflowEmails at 80% warning', () => {
    const def = DEFAULT_ALERT_DEFINITIONS.find((d) => d.id === 'alert-email-warning');
    expect(def).toBeDefined();
    expect(def!.metric).toBe('DailyWorkflowEmails');
    expect(def!.condition.operator).toBe('gte');
    expect(def!.condition.threshold).toBe(80);
    expect(def!.severity).toBe('warning');
    expect(def!.cooldownMinutes).toBe(30);
  });

  it('alert-filestorage-critical targets FileStorageMB at 85% critical', () => {
    const def = DEFAULT_ALERT_DEFINITIONS.find((d) => d.id === 'alert-filestorage-critical');
    expect(def).toBeDefined();
    expect(def!.metric).toBe('FileStorageMB');
    expect(def!.condition.operator).toBe('gte');
    expect(def!.condition.threshold).toBe(85);
    expect(def!.severity).toBe('critical');
    expect(def!.cooldownMinutes).toBe(30);
  });

  it('all definitions have non-empty name and description', () => {
    for (const def of DEFAULT_ALERT_DEFINITIONS) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});
