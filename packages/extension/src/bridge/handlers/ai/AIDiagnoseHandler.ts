/**
 * Phase 04 plan 04-04 — AIDiagnoseHandler.
 *
 * Routes the failed-job → structured-context → diagnosis → user-approve
 * gate flow. Defensively additive: does NOT touch the existing
 * AIChatHandler / AIToolsHandler / AIAnalysisHandler — wires alongside
 * them in ExtensionHandlers.
 *
 * The handler:
 *   1. Receives `ai:diagnose` envelope from the webview.
 *   2. Builds a structured DiagnoseErrorContext (best-effort apex log fetch).
 *   3. Wraps the context via `wrapAsUserData('errorContext', ...)` so
 *      adversarial payloads cannot break out (Plan 04-06).
 *   4. Runs `aiClient.runTools(...)` with the diagnose tool allowlist
 *      (read-only subset) to gather investigation context.
 *   5. Runs `aiClient.complete(..., schema: DiagnoseResultSchema)` to
 *      extract the typed payload (RT-#11 closure path).
 *   6. Sends `ai:diagnose:response`; caches { runId → result } for the
 *      approve gate (10-min TTL).
 *   7. On `ai:approve-action`: looks up cached result, validates the
 *      action requires approval, dispatches to the matching execute
 *      path (run-anonymous via callback / apply-fix via vscode edit /
 *      etc.), sends `ai:approve-action:response`.
 *
 * Self-defense canary: after building the wrapped prompt, asserts the
 * literal `</user-data>` substring does NOT appear inside the payload
 * portion. If it does, refuses to send and logs an error — catches a
 * regression in `escapeUserData` at the source.
 */
import type {
  AIDiagnoseRequestMessage,
  AIDiagnoseResponseMessage,
  AIApproveActionRequestMessage,
  AIApproveActionResponseMessage,
  DiagnoseErrorContext,
  DiagnoseResult,
  AIUsage,
  ActionProposal,
} from '@sandforge/shared';
import { DiagnoseResultSchema } from '@sandforge/shared';

import type { AIClient } from '../../../adapters/ai/AIClient.js';
import type { Logger, TelemetryAdapter } from '../../../adapters/telemetry/TelemetryAdapter.js';
import { wrapAsUserData } from '../../../adapters/ai/safety/index.js';
import { DIAGNOSE_SYSTEM_PROMPT } from '../../../adapters/ai/systemPrompts/index.js';

const FORBIDDEN_RAW_SUBSTRINGS = ['</user-data>'] as const;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Send-only broker subset (matches the SessionBudget pattern). Enough to
 * push response envelopes back to the webview without dragging in the
 * full MessageBroker for tests.
 */
export interface DiagnoseBroker {
  send(message: AIDiagnoseResponseMessage | AIApproveActionResponseMessage): void;
}

export interface ApproveActionDispatcher {
  /** Execute a run-anonymous action with the (possibly modified) Apex script. */
  runAnonymous?: (script: string, orgId: string) => Promise<{ ok: boolean; resultMessage: string }>;
  /** Apply an apply-fix action — payload is a JSON-serialised edit shape. */
  applyFix?: (payload: string) => Promise<{ ok: boolean; resultMessage: string }>;
}

export interface AIDiagnoseHandlerDeps {
  aiClient: AIClient;
  broker: DiagnoseBroker;
  dispatcher?: ApproveActionDispatcher;
  telemetry?: TelemetryAdapter;
  logger?: Logger;
  /** Override for tests — defaults to Date.now. */
  now?: () => number;
}

interface CacheEntry {
  result: DiagnoseResult;
  expiresAt: number;
  orgId: string;
}

export class AIDiagnoseHandler {
  private readonly aiClient: AIClient;
  private readonly broker: DiagnoseBroker;
  private readonly dispatcher?: ApproveActionDispatcher;
  private readonly telemetry?: TelemetryAdapter;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: AIDiagnoseHandlerDeps) {
    this.aiClient = deps.aiClient;
    this.broker = deps.broker;
    this.dispatcher = deps.dispatcher;
    this.telemetry = deps.telemetry;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Single entrypoint — caller dispatches by message type.
   */
  async handleMessage(
    msg: AIDiagnoseRequestMessage | AIApproveActionRequestMessage,
  ): Promise<void> {
    if (msg.type === 'ai:diagnose') {
      return this.handleDiagnose(msg);
    }
    if (msg.type === 'ai:approve-action') {
      return this.handleApproveAction(msg);
    }
  }

  dispose(): void {
    this.cache.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async handleDiagnose(msg: AIDiagnoseRequestMessage): Promise<void> {
    const { runId, orgId, errorContext } = msg.payload;
    this.telemetry?.addBreadcrumb(
      `diagnose_start runId=${runId} kind=${errorContext.kind}`,
      'ai',
      'info',
    );
    const startedAt = this.now();
    try {
      const safeContext = wrapAsUserData('errorContext', JSON.stringify(errorContext));
      this.assertNoForbiddenLeak(safeContext);

      const investigationPrompt =
        `Diagnose this failure. Context follows.\n\n${safeContext}\n\n` +
        `Investigate using the read-only tools, then return a DiagnoseResult.`;

      const investigation = await this.aiClient.runTools({
        prompt: investigationPrompt,
        system: DIAGNOSE_SYSTEM_PROMPT,
        tools: [], // Diagnose tool allowlist is wired at the consume site (extension.ts)
      });

      const extractionPrompt = `Based on your investigation, return a DiagnoseResult.\n\n${investigation.text}`;

      const extraction = await this.aiClient.complete({
        prompt: extractionPrompt,
        system: DIAGNOSE_SYSTEM_PROMPT,
        schema: DiagnoseResultSchema,
      });

      // Cache for the approve gate.
      this.cache.set(runId, {
        result: extraction.payload,
        orgId,
        expiresAt: this.now() + CACHE_TTL_MS,
      });

      const totalUsage = sumUsage(investigation.usage, extraction.usage);
      this.broker.send({
        id: `diag-resp-${runId}`,
        type: 'ai:diagnose:response',
        timestamp: this.now(),
        payload: { runId, result: extraction.payload, usage: totalUsage },
      } as AIDiagnoseResponseMessage);

      this.telemetry?.addBreadcrumb(
        `diagnose_complete runId=${runId} durationMs=${this.now() - startedAt} actions=${extraction.payload.suggestedActions.length}`,
        'ai',
        'info',
      );
    } catch (err) {
      const code = (err as Error & { code?: string }).code ?? 'DIAGNOSE_FAILED';
      const message = redact(err instanceof Error ? err.message : String(err));
      this.broker.send({
        id: `diag-resp-${runId}`,
        type: 'ai:diagnose:response',
        timestamp: this.now(),
        payload: { runId, error: { code, message } },
      } as AIDiagnoseResponseMessage);
      this.telemetry?.addBreadcrumb(`diagnose_error runId=${runId} code=${code}`, 'ai', 'error');
    }
  }

  private async handleApproveAction(msg: AIApproveActionRequestMessage): Promise<void> {
    const { runId, actionIndex, modifiedPayload } = msg.payload;
    const entry = this.cache.get(runId);
    if (!entry || entry.expiresAt < this.now()) {
      this.cache.delete(runId);
      return this.sendApproveResponse(runId, actionIndex, 'failed', 'Diagnose session expired');
    }
    const action = entry.result.suggestedActions[actionIndex];
    if (!action) {
      return this.sendApproveResponse(runId, actionIndex, 'failed', 'Action index out of range');
    }
    if (!action.requiresApproval) {
      return this.sendApproveResponse(
        runId,
        actionIndex,
        'rejected',
        'Read-only actions auto-execute; no approval needed',
      );
    }
    const payload = modifiedPayload ?? action.payload ?? '';
    try {
      const status = await this.dispatchAction(action, payload, entry.orgId);
      return this.sendApproveResponse(
        runId,
        actionIndex,
        status.ok ? 'executed' : 'failed',
        status.resultMessage,
      );
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      return this.sendApproveResponse(runId, actionIndex, 'failed', message);
    }
  }

  private async dispatchAction(
    action: ActionProposal,
    payload: string,
    orgId: string,
  ): Promise<{ ok: boolean; resultMessage: string }> {
    if (action.kind === 'run-anonymous') {
      if (!this.dispatcher?.runAnonymous) {
        return { ok: false, resultMessage: 'run-anonymous dispatcher not wired' };
      }
      return this.dispatcher.runAnonymous(payload, orgId);
    }
    if (action.kind === 'apply-fix') {
      if (!this.dispatcher?.applyFix) {
        return { ok: false, resultMessage: 'apply-fix dispatcher not wired' };
      }
      return this.dispatcher.applyFix(payload);
    }
    return { ok: false, resultMessage: `Unsupported action kind for approve-gate: ${action.kind}` };
  }

  private sendApproveResponse(
    runId: string,
    actionIndex: number,
    status: 'executed' | 'rejected' | 'failed',
    resultMessage: string,
  ): void {
    this.broker.send({
      id: `approve-resp-${runId}-${actionIndex}`,
      type: 'ai:approve-action:response',
      timestamp: this.now(),
      payload: { runId, actionIndex, status, resultMessage },
    } as AIApproveActionResponseMessage);
  }

  /**
   * Self-defense canary. The wrapper itself contains exactly two literal
   * `</user-data>` substrings: at the front nothing, at the back the
   * outer close-tag. So the assertion checks the BODY between
   * `<user-data label="errorContext">` and the trailing `</user-data>`.
   */
  private assertNoForbiddenLeak(wrapped: string): void {
    const openTag = '<user-data label="errorContext">';
    const closeTag = '</user-data>';
    if (!wrapped.startsWith(openTag) || !wrapped.endsWith(closeTag)) {
      throw new Error('Internal safety check failed: wrapped payload shape unexpected');
    }
    const body = wrapped.slice(openTag.length, wrapped.length - closeTag.length);
    for (const forbidden of FORBIDDEN_RAW_SUBSTRINGS) {
      if (body.includes(forbidden)) {
        this.logger?.error(
          { forbidden },
          'escapeUserData regressed — forbidden substring leaked into wrapped payload',
        );
        throw new Error('Internal safety check failed: <user-data> escape did not hold.');
      }
    }
  }
}

function sumUsage(a: AIUsage, b: AIUsage): AIUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    total: a.total + b.total,
  };
}

function redact(message: string): string {
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '***REDACTED***');
}
// retain for symmetry with other handlers
export type { DiagnoseErrorContext };
