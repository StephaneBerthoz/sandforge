import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { AIUsage } from '@sandforge/shared';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter, Logger } from '../telemetry/TelemetryAdapter.js';
import type {
  AIChatOpts,
  AIChatResult,
  AIClient,
  AICompleteOpts,
  AICompleteResult,
  AICountTokensOpts,
  AICountTokensResult,
  AIProviderType,
} from './AIClient.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const SECRET_KEY = 'sandforge.ai.anthropic.key';

export interface AnthropicAdapterDeps {
  storage: StorageAdapter;
  telemetry?: TelemetryAdapter;
  logger?: Logger;
  model?: string;
}

/**
 * AnthropicAdapter — happy-path implementation of AIClient.
 *
 * Lazy: SecretStorage is read on first call, never at construction.
 * Each public method allocates the SDK call options with the caller's signal.
 *
 * The CircuitBreaker + per-request AbortController + budget wiring lands in
 * Plans 04-02 and 04-05. This file is the foundation.
 */
export class AnthropicAdapter implements AIClient {
  public readonly provider: AIProviderType = 'anthropic';
  private client: Anthropic | null = null;
  private readonly storage: StorageAdapter;
  private readonly telemetry?: TelemetryAdapter;
  private readonly logger?: Logger;
  private readonly model: string;

  constructor(deps: AnthropicAdapterDeps) {
    this.storage = deps.storage;
    this.telemetry = deps.telemetry;
    this.logger = deps.logger;
    this.model = deps.model ?? DEFAULT_MODEL;
  }

  async chat(opts: AIChatOpts): Promise<AIChatResult> {
    const client = await this.getClient();
    try {
      const resp = await client.messages.create(
        {
          model: this.model,
          max_tokens: opts.maxTokens ?? 4096,
          system: opts.system,
          messages: opts.messages,
        },
        { signal: opts.signal },
      );
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const usage = this.buildUsage(resp.usage);
      this.breadcrumb('chat', usage);
      return {
        text,
        usage,
        model: resp.model,
        stopReason: resp.stop_reason,
      };
    } catch (err) {
      throw this.rewrapError(err);
    }
  }

  async complete<T extends z.ZodTypeAny>(
    opts: AICompleteOpts<T>,
  ): Promise<AICompleteResult<T>> {
    const client = await this.getClient();
    try {
      const resp = await client.messages.parse(
        {
          model: this.model,
          max_tokens: opts.maxTokens ?? 4096,
          system: opts.system,
          messages: [{ role: 'user', content: opts.prompt }],
          output_config: { format: zodOutputFormat(opts.schema) },
        },
        { signal: opts.signal },
      );
      const usage = this.buildUsage(resp.usage);
      this.breadcrumb('complete', usage);
      return {
        payload: resp.parsed_output as z.infer<T>,
        usage,
        model: resp.model,
        stopReason: resp.stop_reason,
      };
    } catch (err) {
      throw this.rewrapError(err);
    }
  }

  async countTokens(opts: AICountTokensOpts): Promise<AICountTokensResult> {
    const client = await this.getClient();
    try {
      const resp = await client.messages.countTokens({
        model: this.model,
        system: opts.system,
        messages: opts.messages,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: opts.tools as any,
      });
      return { inputTokens: resp.input_tokens };
    } catch (err) {
      throw this.rewrapError(err);
    }
  }

  dispose(): void {
    this.client = null;
  }

  // ── internals ──────────────────────────────────────────────

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const apiKey = await this.storage.getSecret(SECRET_KEY);
    if (!apiKey) {
      throw new Error(
        'Anthropic API key not configured. Set it in Command Palette → SandForge: Configure AI Key.',
      );
    }
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  private buildUsage(raw: Anthropic.Usage | undefined | null): AIUsage {
    const input = raw?.input_tokens ?? 0;
    const output = raw?.output_tokens ?? 0;
    const cacheRead = raw?.cache_read_input_tokens ?? 0;
    const cacheCreate = raw?.cache_creation_input_tokens ?? 0;
    return {
      input,
      output,
      cacheRead,
      cacheCreate,
      total: input + output + cacheRead + cacheCreate,
    };
  }

  private rewrapError(err: unknown): Error {
    if (err instanceof APIUserAbortError) return err;
    const msg = this.extractAndRedactErrorMessage(err);
    return new Error(msg);
  }

  /**
   * Strip API-key-shaped substrings from an SDK error message before
   * surfacing it to logs / handlers (P-04.7).
   *
   * Anthropic keys look like `sk-ant-…` followed by a 95+ char base64-ish
   * payload. We replace any 32+ contiguous run of `[A-Za-z0-9_-]` with
   * `***REDACTED***`, which catches the literal key, JWT-like tokens, and
   * Bearer headers without false-positives on natural language.
   */
  private extractAndRedactErrorMessage(err: unknown): string {
    const raw =
      err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
    return raw.replace(/[A-Za-z0-9_-]{32,}/g, '***REDACTED***');
  }

  private breadcrumb(method: 'chat' | 'complete' | 'countTokens', usage: AIUsage): void {
    if (!this.telemetry) return;
    try {
      this.telemetry.addBreadcrumb(
        `anthropic_call method=${method} model=${this.model} total=${usage.total}`,
        'ai',
        'info',
      );
    } catch {
      // telemetry is best-effort
    }
    if (this.logger) {
      this.logger.debug({ method, model: this.model, totalTokens: usage.total }, 'anthropic call');
    }
  }
}
