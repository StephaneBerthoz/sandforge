import type { z } from 'zod';
import type { AIUsage } from '@sandforge/shared';

export type AIProviderType = 'anthropic' | 'openai' | 'custom';

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

export interface AIClient {
  readonly provider: AIProviderType;
  chat(opts: AIChatOpts): Promise<AIChatResult>;
  complete<T extends z.ZodTypeAny>(opts: AICompleteOpts<T>): Promise<AICompleteResult<T>>;
  countTokens(opts: AICountTokensOpts): Promise<AICountTokensResult>;
  dispose(): void;
}

export class AINotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AINotImplementedError';
  }
}
