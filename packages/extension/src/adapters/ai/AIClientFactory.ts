import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter, Logger } from '../telemetry/TelemetryAdapter.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { AINotImplementedError, type AIClient, type AIProviderType } from './AIClient.js';

export interface AIClientFactoryDeps {
  storage: StorageAdapter;
  telemetry?: TelemetryAdapter;
  logger?: Logger;
  /** Reads the current provider from VSCode settings. */
  getProvider: () => AIProviderType;
  /** Reads the current model override from VSCode settings. */
  getModel?: () => string | undefined;
}

/**
 * Build a memoised, provider-keyed factory for AI clients.
 *
 * Each provider gets ONE adapter instance per factory lifetime so that
 * per-provider state (CircuitBreaker in 04-02, in-flight registry, etc.)
 * persists across calls. Switching the provider in Settings returns a
 * different cached instance — both stay alive for the session.
 *
 * The Anthropic-only branch is shipped today; openai / custom throw
 * AINotImplementedError until 04-07 lands the stubs.
 */
export function createAIClientFactory(
  deps: AIClientFactoryDeps,
): (provider?: AIProviderType) => AIClient {
  const cache = new Map<AIProviderType, AIClient>();

  return function aiClientFactory(explicitProvider?: AIProviderType): AIClient {
    const provider = explicitProvider ?? deps.getProvider();
    const cached = cache.get(provider);
    if (cached) return cached;

    let instance: AIClient;
    switch (provider) {
      case 'anthropic':
        instance = new AnthropicAdapter({
          storage: deps.storage,
          telemetry: deps.telemetry,
          logger: deps.logger,
          model: deps.getModel?.(),
        });
        break;
      case 'openai':
        throw new AINotImplementedError('OpenAIAdapter ships in Plan 04-07.');
      case 'custom':
        throw new AINotImplementedError('CustomAdapter ships in Plan 04-07.');
      default:
        throw new AINotImplementedError(`Unknown AI provider: ${provider as string}`);
    }
    cache.set(provider, instance);
    return instance;
  };
}
