import { describe, it, expect } from 'vitest';
import {
  MONITOR_KEY_LIMITS,
  SANDBOX_PROCESS_STATUSES,
  isSandboxRefreshInProgress,
} from './monitor.js';

/**
 * Every limit name a real org's `/limits` answered with, at v62.0 (an
 * Enterprise Edition sandbox, 2026-09). Names only: the values are the org's.
 */
const LIMITS_A_REAL_ORG_RETURNS: ReadonlySet<string> = new Set([
  'AnalyticsExternalDataSizeMB',
  'CdpAiInferenceApiMonthlyLimit',
  'ConcurrentAsyncGetReportInstances',
  'ConcurrentEinsteinDataInsightsStoryCreation',
  'ConcurrentEinsteinDiscoveryStoryCreation',
  'ConcurrentSyncReportRuns',
  'ContentDistBandwidthLimitMB',
  'ContentDistViewLimit',
  'ContentPublicationLimit',
  'DailyAnalyticsDataflowJobExecutions',
  'DailyAnalyticsUploadedFilesSizeMB',
  'DailyApexCursorLimit',
  'DailyApexCursorRowsLimit',
  'DailyApexPCursorLimit',
  'DailyApiRequests',
  'DailyAsyncApexExecutions',
  'DailyAsyncApexTests',
  'DailyBulkApiBatches',
  'DailyBulkV2QueryFileStorageMB',
  'DailyBulkV2QueryJobs',
  'DailyDataCloudCursorLimit',
  'DailyDataCloudCursorRowsLimit',
  'DailyDataCloudFlexCredits',
  'DailyDeliveredPlatformEvents',
  'DailyDurableGenericStreamingApiEvents',
  'DailyDurableStreamingApiEvents',
  'DailyEinsteinDataInsightsStoryCreation',
  'DailyEinsteinDiscoveryOptimizationJobRuns',
  'DailyEinsteinDiscoveryPredictAPICalls',
  'DailyEinsteinDiscoveryPredictionsByCDC',
  'DailyEinsteinDiscoveryStoryCreation',
  'DailyFunctionsApiCallLimit',
  'DailyGenericStreamingApiEvents',
  'DailyMetadataRetrievesWithDependencies',
  'DailyServiceEmailAgentforceCalls',
  'DailyStandardVolumePlatformEvents',
  'DailyStreamingApiEvents',
  'DailyWorkflowEmails',
  'DataStorageMB',
  'DurableStreamingApiConcurrentClients',
  'ExternalServicesActiveObjects',
  'ExternalServicesActiveOperations',
  'ExternalServicesObjectProperties',
  'ExternalServicesObjects',
  'ExternalServicesOperations',
  'ExternalServicesRegistrations',
  'FileStorageMB',
  'HourlyAsyncReportRuns',
  'HourlyDashboardRefreshes',
  'HourlyDashboardResults',
  'HourlyDashboardStatuses',
  'HourlyElevateAsyncReportRuns',
  'HourlyElevateSyncReportRuns',
  'HourlyLongTermIdMapping',
  'HourlyManagedContentPublicRequests',
  'HourlyODataCallout',
  'HourlyPublishedPlatformEvents',
  'HourlyPublishedStandardVolumePlatformEvents',
  'HourlyShortTermIdMapping',
  'HourlySyncReportRuns',
  'HourlyTimeBasedWorkflow',
  'MassEmail',
  'MaxContentDocumentsLimit',
  'MonthlyEinsteinDiscoveryStoryCreation',
  'Package2VersionCreates',
  'Package2VersionCreatesWithoutValidation',
  'PermissionSets',
  'PlatformEventTriggersWithParallelProcessing',
  'PrivateConnectOutboundCalloutHourlyLimitMB',
  'PublishCallbackUsageInApex',
  'ScheduledFlowRunLimit',
  'ScheduledPathRunLimit',
  'SingleEmail',
  'StreamingApiConcurrentClients',
]);

describe('MONITOR_KEY_LIMITS', () => {
  it('should contain no duplicate entries', () => {
    const unique = new Set(MONITOR_KEY_LIMITS);
    expect(unique.size).toBe(MONITOR_KEY_LIMITS.length);
  });

  it('should only contain non-empty strings', () => {
    for (const key of MONITOR_KEY_LIMITS) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('names only limits an org returns, so every trend it asks for can gather points', () => {
    expect(MONITOR_KEY_LIMITS.filter((name) => !LIMITS_A_REAL_ORG_RETURNS.has(name))).toEqual([]);
  });
});

describe('a sandbox refresh under way', () => {
  it('is a copy that has not replaced the sandbox yet, and nothing else', () => {
    expect(SANDBOX_PROCESS_STATUSES.filter(isSandboxRefreshInProgress)).toEqual([
      'Sampling',
      'Pending',
      'Processing',
      'Suspended',
      'Pending Activation',
      'Activating',
    ]);
  });

  it('is never a status Salesforce does not document', () => {
    // `Failed` is not one: a copy that ends without replacing the sandbox is Stopped.
    expect(isSandboxRefreshInProgress('Failed')).toBe(false);
    expect(isSandboxRefreshInProgress('Unknown')).toBe(false);
  });
});
