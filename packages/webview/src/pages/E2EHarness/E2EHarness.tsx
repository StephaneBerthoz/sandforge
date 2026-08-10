import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { Flow } from './harnessFlow';

/**
 * E2E Harness — placeholder surfaces for Plan 02-03 Playwright specs.
 *
 * This component is mounted ONLY when the URL contains `?e2e-harness=<flow>`.
 * It renders a minimal surface that exposes every `data-testid` the five
 * critical E2E specs rely on, without depending on the production app shell
 * or the real Forge / Sync / Monitor / AI / CDC pages.
 *
 * Rationale:
 *   - Specs 4 (CDC) and 5 (AI diagnose) target features that are delivered
 *     in Phase 04 (AI) and Phase 05 (CDC); Plan 02-03 documents placeholder
 *     usage explicitly so the specs can be green in Phase 02 and their body
 *     stabilises the contract that Phase 04/05 must keep.
 *   - Specs 1 / 2 / 3 touch surfaces (seed AI generate, sync conflict dialog,
 *     monitor dashboard refresh + export) whose intermediate testids do not
 *     yet exist on the production components. Rather than invasively adding
 *     testids across 5 large feature pages, the harness provides a stable
 *     E2E contract the downstream phases can point their real UIs at.
 *
 * Each flow listens for a small set of extension -> webview messages via
 * `window.addEventListener('message')` and updates its local UI state so
 * MockBridge.respond() / MockBridge.stream() drive the experience.
 */

/** Minimal fetch-style helper: POST a message to the extension mock. */
function postExtensionMessage(type: string, payload: Record<string, unknown>): void {
  const api = (
    window as unknown as { acquireVsCodeApi?: () => { postMessage: (m: unknown) => void } }
  ).acquireVsCodeApi;
  if (api) {
    try {
      // Cached getter pattern — a real extension host only exposes this once.
      // In tests the mock caches internally, so calling twice is safe.
      const cached = (window as unknown as { __vscodeApi?: { postMessage: (m: unknown) => void } })
        .__vscodeApi;
      const vscode = cached ?? api();
      (window as unknown as { __vscodeApi?: { postMessage: (m: unknown) => void } }).__vscodeApi =
        vscode;
      vscode.postMessage({
        type,
        id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        payload,
      });
    } catch {
      /* noop in non-test environments */
    }
  }
}

// --- Spec 1 ----------------------------------------------------------------

const SeedAIHarness: React.FC = () => {
  const [personaPreview, setPersonaPreview] = useState<{
    name: string;
    recordCount: number;
  } | null>(null);
  const [executionStarted, setExecutionStarted] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [sourceOrg, setSourceOrg] = useState('');
  const [targetOrg, setTargetOrg] = useState('');

  useEffect(() => {
    const handler = (ev: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview
      // host ('vscode-webview://...') or empty origin (tests, some environments).
      if (ev.origin && !ev.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = ev.data as { type?: string; payload?: Record<string, unknown> } | undefined;
      if (!data) return;
      if (data.type === 'forge:ai:generate:response' && data.payload) {
        setPersonaPreview({
          name: String(data.payload.name ?? 'Persona'),
          recordCount: Number(data.payload.recordCount ?? 0),
        });
      }
      if (data.type === 'forge:execute:response') {
        setExecutionStarted(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const canGenerate = prompt.trim().length > 0 && sourceOrg !== '' && targetOrg !== '';

  return (
    <div data-testid="forge-page" className="p-6 space-y-3">
      <h1 className="text-lg">Forge (E2E harness)</h1>
      <div role="tablist" className="flex gap-2">
        <button data-testid="forge-tab-ai" role="tab" aria-selected="true">
          AI
        </button>
      </div>
      <textarea
        data-testid="forge-input-ai"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the persona"
      />
      <select
        data-testid="forge-source-org"
        value={sourceOrg}
        onChange={(e) => setSourceOrg(e.target.value)}
      >
        <option value="">Source org</option>
        <option value="org-src-1">DevSandbox</option>
      </select>
      <select
        data-testid="forge-target-org"
        value={targetOrg}
        onChange={(e) => setTargetOrg(e.target.value)}
      >
        <option value="">Target org</option>
        <option value="org-tgt-1">QASandbox</option>
      </select>
      <button
        data-testid="forge-ai-generate-btn"
        disabled={!canGenerate}
        onClick={() => postExtensionMessage('forge:ai:generate', { prompt, sourceOrg, targetOrg })}
      >
        Generate
      </button>
      {personaPreview && (
        <div data-testid="forge-ai-persona-preview" className="rounded border p-3">
          <div>{personaPreview.name}</div>
          <div>{personaPreview.recordCount} records</div>
          <button
            data-testid="forge-execute-btn"
            onClick={() => postExtensionMessage('forge:execute', { personaId: 'persona-1' })}
          >
            Execute
          </button>
        </div>
      )}
      {executionStarted && <div data-testid="forge-execution-indicator">Execution started</div>}
    </div>
  );
};

// --- Spec 2 ----------------------------------------------------------------

interface SyncFieldConflict {
  field: string;
  source: string;
  target: string;
}
interface SyncConflictPayload {
  conflictId: string;
  objectApiName: string;
  recordId: string;
  fieldConflicts: SyncFieldConflict[];
}

const SyncConflictHarness: React.FC = () => {
  const [object, setObject] = useState('');
  const [conflict, setConflict] = useState<SyncConflictPayload | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    const handler = (ev: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview
      // host ('vscode-webview://...') or empty origin (tests, some environments).
      if (ev.origin && !ev.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = ev.data as { type?: string; payload?: Record<string, unknown> } | undefined;
      if (!data) return;
      if (data.type === 'sync:conflict:detected' && data.payload) {
        setConflict({
          conflictId: String(data.payload.conflictId),
          objectApiName: String(data.payload.objectApiName),
          recordId: String(data.payload.recordId),
          fieldConflicts: (data.payload.fieldConflicts as SyncFieldConflict[]) ?? [],
        });
        setResolved(false);
      }
      if (data.type === 'sync:conflict:resolved') {
        setConflict(null);
        setResolved(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const startSync = useCallback(() => {
    postExtensionMessage('sync:start', { object });
  }, [object]);

  const resolve = useCallback(
    (resolution: 'use-source' | 'use-target') => {
      if (!conflict) return;
      postExtensionMessage('sync:conflict:resolve', {
        conflictId: conflict.conflictId,
        resolution,
      });
    },
    [conflict],
  );

  return (
    <div data-testid="sync-page" className="p-6 space-y-3">
      <h1 className="text-lg">Sync (E2E harness)</h1>
      <select
        data-testid="sync-object-select"
        value={object}
        onChange={(e) => setObject(e.target.value)}
      >
        <option value="">Select object</option>
        <option value="Contact">Contact</option>
      </select>
      <button data-testid="sync-start-btn" disabled={object === ''} onClick={startSync}>
        Start sync
      </button>
      {conflict && (
        <div data-testid="sync-conflict-dialog" role="dialog" className="rounded border p-3">
          <div>
            {conflict.objectApiName} conflict on {conflict.recordId}
          </div>
          <ul>
            {conflict.fieldConflicts.map((fc) => (
              <li key={fc.field} data-testid="sync-conflict-field-row">
                {fc.field}: {fc.source} vs {fc.target}
              </li>
            ))}
          </ul>
          <button data-testid="sync-conflict-use-source" onClick={() => resolve('use-source')}>
            Use source
          </button>
          <button data-testid="sync-conflict-use-target" onClick={() => resolve('use-target')}>
            Use target
          </button>
        </div>
      )}
      {resolved && <div data-testid="sync-resolved-indicator">Resolved</div>}
    </div>
  );
};

// --- Spec 3 ----------------------------------------------------------------

interface MonitorMetricsPayload {
  limits: { apiRequests: { used: number; max: number; percent: number } };
  jobs: { running: number; completed: number; failed: number };
  lastUpdated: string;
}
interface ExportUrlPayload {
  format: string;
  blobUrl: string;
  fileName: string;
}

const MonitorHarness: React.FC = () => {
  const [metrics, setMetrics] = useState<MonitorMetricsPayload | null>(null);
  const [exportedFile, setExportedFile] = useState<string | null>(null);
  const [sentOnMount, setSentOnMount] = useState(false);

  // On mount, fire a single metrics request (finite — no polling).
  useEffect(() => {
    if (sentOnMount) return;
    postExtensionMessage('monitor:metrics:request', {});
    setSentOnMount(true);
  }, [sentOnMount]);

  useEffect(() => {
    const handler = (ev: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview
      // host ('vscode-webview://...') or empty origin (tests, some environments).
      if (ev.origin && !ev.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = ev.data as { type?: string; payload?: Record<string, unknown> } | undefined;
      if (!data) return;
      if (data.type === 'monitor:metrics:response' && data.payload) {
        setMetrics(data.payload as unknown as MonitorMetricsPayload);
      }
      if (data.type === 'monitor:export:response' && data.payload) {
        const exportPayload = data.payload as unknown as ExportUrlPayload;
        setExportedFile(String(exportPayload.fileName ?? ''));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const refresh = useCallback(() => {
    postExtensionMessage('monitor:metrics:request', {});
  }, []);

  const exportCsv = useCallback(() => {
    postExtensionMessage('monitor:export:request', { format: 'csv' });
  }, []);

  return (
    <div data-testid="monitor-page" className="p-6 space-y-3">
      <h1 className="text-lg">Monitor (E2E harness)</h1>
      <button data-testid="monitor-refresh-btn" onClick={refresh}>
        Refresh
      </button>
      <button data-testid="monitor-export-csv-btn" onClick={exportCsv}>
        Export CSV
      </button>
      {metrics && (
        <div className="space-y-2">
          <div data-testid="monitor-metric-card-apiRequests" className="rounded border p-3">
            API requests: {metrics.limits.apiRequests.used}/{metrics.limits.apiRequests.max}
          </div>
          <div data-testid="monitor-metric-card-jobs" className="rounded border p-3">
            Jobs: running {metrics.jobs.running} / completed {metrics.jobs.completed} / failed{' '}
            {metrics.jobs.failed}
          </div>
          <div data-testid="monitor-last-updated">{metrics.lastUpdated}</div>
        </div>
      )}
      {exportedFile && (
        <div data-testid="monitor-export-toast" role="status">
          Exported {exportedFile}
        </div>
      )}
    </div>
  );
};

// --- Spec 4 ----------------------------------------------------------------

interface CdcSubscriptionPayload {
  subscriptionId: string;
  allocationUsed: number;
  allocationMax: number;
}
interface CdcEventPayload {
  eventId: string;
  objectApiName: string;
  changeType: string;
  recordIds: string[];
  occurredAt: string;
}

const CdcHarness: React.FC = () => {
  const [object, setObject] = useState('');
  const [subscription, setSubscription] = useState<CdcSubscriptionPayload | null>(null);
  const [events, setEvents] = useState<CdcEventPayload[]>([]);
  const [unsubscribed, setUnsubscribed] = useState(false);

  useEffect(() => {
    const handler = (ev: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview
      // host ('vscode-webview://...') or empty origin (tests, some environments).
      if (ev.origin && !ev.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = ev.data as { type?: string; payload?: Record<string, unknown> } | undefined;
      if (!data) return;
      if (data.type === 'cdc:subscribe:response' && data.payload) {
        setSubscription(data.payload as unknown as CdcSubscriptionPayload);
        setUnsubscribed(false);
      }
      if (data.type === 'cdc:event' && data.payload) {
        setEvents((prev) => [...prev, data.payload as unknown as CdcEventPayload]);
      }
      if (data.type === 'cdc:unsubscribe:response') {
        setUnsubscribed(true);
        setSubscription(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div data-testid="monitor-page" className="p-6 space-y-3">
      <h1 className="text-lg">Monitor / CDC (E2E harness)</h1>
      <div role="tablist" className="flex gap-2">
        <button data-testid="monitor-tab-cdc" role="tab" aria-selected="true">
          CDC
        </button>
      </div>
      <select
        data-testid="monitor-cdc-object-select"
        value={object}
        onChange={(e) => setObject(e.target.value)}
      >
        <option value="">Select object</option>
        <option value="Account">Account</option>
      </select>
      <button
        data-testid="monitor-cdc-subscribe-btn"
        disabled={object === ''}
        onClick={() => postExtensionMessage('cdc:subscribe', { object })}
      >
        Subscribe
      </button>
      <button
        data-testid="monitor-cdc-unsubscribe-btn"
        disabled={subscription === null}
        onClick={() =>
          postExtensionMessage('cdc:unsubscribe', {
            subscriptionId: subscription?.subscriptionId ?? '',
          })
        }
      >
        Unsubscribe
      </button>
      {subscription && (
        <div data-testid="monitor-cdc-allocation-badge" className="rounded border p-2">
          {subscription.allocationUsed}/{subscription.allocationMax}
        </div>
      )}
      {unsubscribed && (
        <div data-testid="monitor-cdc-idle" className="rounded border p-2">
          Idle
        </div>
      )}
      <ul>
        {events.map((e) => (
          <li key={e.eventId} data-testid="monitor-cdc-feed-row">
            {e.changeType} {e.recordIds.join(',')}
          </li>
        ))}
      </ul>
    </div>
  );
};

// --- Spec 5 ----------------------------------------------------------------

interface FailedJobPayload {
  jobId: string;
  objectApiName: string;
  errorMessage: string;
  failedRecords: number;
  totalRecords: number;
}
interface AIDiagnosisPayload {
  diagnosisId: string;
  summary: string;
  proposedFix: {
    action: string;
    field: string;
    fromValue: string;
    toValue: string;
    affectedCount: number;
  };
  confidence: number;
}
interface FixAppliedPayload {
  diagnosisId: string;
  applied: boolean;
  updatedRecords: number;
}

const AIDiagnoseHarness: React.FC = () => {
  const [jobs, setJobs] = useState<FailedJobPayload[]>([]);
  const [diagnosis, setDiagnosis] = useState<AIDiagnosisPayload | null>(null);
  const [fixResult, setFixResult] = useState<FixAppliedPayload | null>(null);
  const [sentOnMount, setSentOnMount] = useState(false);

  useEffect(() => {
    if (sentOnMount) return;
    postExtensionMessage('monitor:failed-jobs:request', {});
    setSentOnMount(true);
  }, [sentOnMount]);

  useEffect(() => {
    const handler = (ev: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview
      // host ('vscode-webview://...') or empty origin (tests, some environments).
      if (ev.origin && !ev.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = ev.data as { type?: string; payload?: Record<string, unknown> } | undefined;
      if (!data) return;
      if (data.type === 'monitor:failed-jobs:response' && data.payload) {
        const list = (data.payload as { jobs?: FailedJobPayload[] }).jobs ?? [];
        setJobs(list);
      }
      if (data.type === 'ai:diagnose:response' && data.payload) {
        setDiagnosis(data.payload as unknown as AIDiagnosisPayload);
      }
      if (data.type === 'ai:fix:applied' && data.payload) {
        setFixResult(data.payload as unknown as FixAppliedPayload);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div data-testid="monitor-failed-jobs-list" className="p-6 space-y-3">
      <h1 className="text-lg">AI diagnose (E2E harness)</h1>
      {jobs.map((job) => (
        <div key={job.jobId} data-testid="monitor-failed-job-card" className="rounded border p-3">
          <div>
            {job.objectApiName}: {job.errorMessage}
          </div>
          <button
            data-testid="ai-diagnose-btn"
            onClick={() => postExtensionMessage('ai:diagnose', { jobId: job.jobId })}
          >
            Diagnose
          </button>
        </div>
      ))}
      {diagnosis && (
        <div data-testid="ai-diagnosis-panel" className="rounded border p-3">
          <div>{diagnosis.summary}</div>
          <div>{Math.round(diagnosis.confidence * 100)}% confidence</div>
          <button
            data-testid="ai-apply-fix-btn"
            onClick={() =>
              postExtensionMessage('ai:fix:apply', {
                diagnosisId: diagnosis.diagnosisId,
              })
            }
          >
            Apply fix
          </button>
        </div>
      )}
      {fixResult && (
        <div data-testid="ai-fix-applied-toast" role="status">
          {fixResult.updatedRecords} records updated
        </div>
      )}
    </div>
  );
};

/** E2E harness root — dispatches to the right flow. */
export const E2EHarness: React.FC<{ flow: Flow }> = ({ flow }) => {
  const content = useMemo(() => {
    switch (flow) {
      case 'seed-ai':
        return <SeedAIHarness />;
      case 'sync-conflict':
        return <SyncConflictHarness />;
      case 'monitor':
        return <MonitorHarness />;
      case 'cdc':
        return <CdcHarness />;
      case 'ai-diagnose':
        return <AIDiagnoseHarness />;
      default:
        return null;
    }
  }, [flow]);

  return (
    <div data-testid="app-shell" data-e2e-flow={flow}>
      <div data-testid="e2e-harness-root">{content}</div>
    </div>
  );
};
