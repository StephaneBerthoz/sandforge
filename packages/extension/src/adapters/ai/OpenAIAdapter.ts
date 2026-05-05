import type { z } from 'zod';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter, Logger } from '../telemetry/TelemetryAdapter.js';
import { CircuitBreaker } from '../../core/connection/CircuitBreaker.js';
import { AINotImplementedError } from './AIClient.js';
import type {
  AIChatOpts,
  AIChatResult,
  AIClient,
  AICompleteOpts,
  AICompleteResult,
  AICountTokensOpts,
  AICountTokensResult,
  AIProviderType,
  AIRunToolsOpts,
  AIRunToolsResult,
} from './AIClient.js';
import type { SessionBudget } from './tokenBudget/SessionBudget.js';

const NOT_IMPLEMENTED_MESSAGE =
  'OpenAI provider ships in a future SandForge milestone. ' +
  'Switch sandforge.ai.provider back to "anthropic" or remove the setting to use the default.';

export interface OpenAIAdapterDeps {
  storage: StorageAdapter;
  telemetry?: TelemetryAdapter;
  logger?: Logger;
  model?: string;
  budget?: SessionBudget;
  breaker?: CircuitBreaker;
}

/**
 * OpenAIAdapter — STUB. Construction succeeds (so the factory can dispatch
 * safely); every method throws AINotImplementedError at call time so the
 * user sees a helpful message instead of a silent factory crash.
 *
 * Per-provider CircuitBreaker is allocated per-instance (NOT shared with
 * AnthropicAdapter) so the multi-provider isolation contract holds even
 * for stubs.
 */
export class OpenAIAdapter implements AIClient {
  public readonly provider: AIProviderType = 'openai';
  public readonly breaker: CircuitBreaker;
  public budget?: SessionBudget;

  private readonly telemetry?: TelemetryAdapter;

  constructor(deps: OpenAIAdapterDeps) {
    this.telemetry = deps.telemetry;
    this.breaker =
      deps.breaker ??
      new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 300_000,
        halfOpenRequests: 1,
      });
    this.budget = deps.budget;
    void deps.storage;
    void deps.logger;
    void deps.model;
  }

  async chat(_opts: AIChatOpts): Promise<AIChatResult> {
    this.notifyStub('chat');
    throw new AINotImplementedError(`OpenAIAdapter.chat() — ${NOT_IMPLEMENTED_MESSAGE}`);
  }

  async complete<T extends z.ZodTypeAny>(
    _opts: AICompleteOpts<T>,
  ): Promise<AICompleteResult<T>> {
    this.notifyStub('complete');
    throw new AINotImplementedError(`OpenAIAdapter.complete() — ${NOT_IMPLEMENTED_MESSAGE}`);
  }

  async countTokens(_opts: AICountTokensOpts): Promise<AICountTokensResult> {
    this.notifyStub('countTokens');
    throw new AINotImplementedError(
      `OpenAIAdapter.countTokens() — ${NOT_IMPLEMENTED_MESSAGE}`,
    );
  }

  async runTools(_opts: AIRunToolsOpts): Promise<AIRunToolsResult> {
    this.notifyStub('runTools');
    throw new AINotImplementedError(`OpenAIAdapter.runTools() — ${NOT_IMPLEMENTED_MESSAGE}`);
  }

  dispose(): void {
    // no-op — constructor was no-op too
  }

  private notifyStub(method: string): void {
    try {
      this.telemetry?.addBreadcrumb(`openai_stub_called method=${method}`, 'ai', 'info');
    } catch {
      // best-effort
    }
  }
}
