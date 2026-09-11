import type { AIUsage } from '@sandforge/shared';
import type { AIErrorVerdict } from './errorClassifier.js';
import type { SessionBudget } from './tokenBudget/SessionBudget.js';

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

export interface AIClient {
  readonly provider: AIProviderType;
  /**
   * Token budget for the current AI session, attached by the composition root
   * once the stack is initialised (see `initAIComposition`). Every adapter
   * declares the field; only the Anthropic one enforces it (the others are
   * stubs that never reach an SDK). Left undefined, the adapter is unmetered.
   */
  budget?: SessionBudget;
  chat(opts: AIChatOpts): Promise<AIChatResult>;
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
