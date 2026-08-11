import type { z } from 'zod';
import type { AIUsage } from '@sandforge/shared';
import type { AIErrorVerdict } from './errorClassifier.js';

export type AIProviderType = 'anthropic' | 'openai' | 'custom';

/** Circuit-breaker state for an AI provider. */
export type BreakerState = 'closed' | 'open' | 'half-open';

/** Emitted when an adapter's breaker transitions (or an overloaded incident recurs). */
export interface BreakerStateChangeEvent {
  state: BreakerState;
  lastErrorVerdict?: AIErrorVerdict;
  cooldownEndsAt?: string; // ISO
}

export interface AIChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIChatOpts {
  messages: AIChatMessage[];
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AIChatResult {
  text: string;
  usage: AIUsage;
  model: string;
  stopReason: string | null;
}

export interface AICompleteOpts<T extends z.ZodTypeAny> {
  prompt: string;
  system?: string;
  schema: T;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AICompleteResult<T extends z.ZodTypeAny> {
  payload: z.infer<T>;
  usage: AIUsage;
  model: string;
  stopReason: string | null;
}

export interface AICountTokensOpts {
  messages: AIChatMessage[];
  system?: string;
  tools?: unknown[];
}

export interface AICountTokensResult {
  inputTokens: number;
}

export interface AIRunToolsOpts {
  prompt: string;
  system?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[];
  signal?: AbortSignal;
  maxTokens?: number;
  maxIterations?: number;
}

export interface AIRunToolsResult {
  text: string;
  usage: AIUsage;
  model: string;
  stopReason: string | null;
  runId: string;
  toolCalls: number;
}

export interface AIClient {
  readonly provider: AIProviderType;
  chat(opts: AIChatOpts): Promise<AIChatResult>;
  complete<T extends z.ZodTypeAny>(opts: AICompleteOpts<T>): Promise<AICompleteResult<T>>;
  countTokens(opts: AICountTokensOpts): Promise<AICountTokensResult>;
  /** Plan 04-03 — multi-step tool conversation. */
  runTools(opts: AIRunToolsOpts): Promise<AIRunToolsResult>;
  /**
   * Optional breaker state-change feed — present on the Anthropic adapter,
   * absent on the stub adapters. Structural subset of Node's EventEmitter:
   * just enough to subscribe (the extension forwards these to the webview as
   * `ai:provider:status`).
   */
  readonly breakerEvents?: {
    on(event: 'state-change', listener: (event: BreakerStateChangeEvent) => void): void;
    off(event: 'state-change', listener: (event: BreakerStateChangeEvent) => void): void;
  };
  dispose(): void;
}

export class AINotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AINotImplementedError';
  }
}
