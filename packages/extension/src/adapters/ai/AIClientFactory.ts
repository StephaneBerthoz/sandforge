import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter, Logger } from '../telemetry/TelemetryAdapter.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { OpenAIAdapter } from './OpenAIAdapter.js';
import { CustomAdapter } from './CustomAdapter.js';
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
 * Memoised, provider-keyed AI client factory.
 *
 * Call it like a function to get the (cached) client for a provider; call
 * `invalidate()` to dispose and drop every cached adapter so the next call
 * rebuilds from current settings (provider/model) and re-reads secrets
 * lazily. Used when `sandforge.ai.*` settings change.
 */
export interface AIClientFactory {
  (explicitProvider?: AIProviderType): AIClient;
  /** Dispose and drop every memoised adapter. */
  invalidate(): void;
}

/**
 * Build a memoised, provider-keyed factory for AI clients.
 *
 * Each provider gets ONE adapter instance per factory lifetime so that
 * per-provider state (CircuitBreaker in 04-02, in-flight registry, etc.)
 * persists across calls. Switching the provider in Settings returns a
 * different cached instance — both stay alive for the session (until
 * `invalidate()` is called).
 *
 * Only the Anthropic adapter is functional today; the openai / custom
 * branches construct STUB adapters whose methods throw AINotImplementedError
 * at call time (see OpenAIAdapter / CustomAdapter).
 */
export function createAIClientFactory(deps: AIClientFactoryDeps): AIClientFactory {
  const cache = new Map<AIProviderType, AIClient>();

  const factory = (explicitProvider?: AIProviderType): AIClient => {
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
        instance = new OpenAIAdapter({
          storage: deps.storage,
          telemetry: deps.telemetry,
          logger: deps.logger,
          model: deps.getModel?.(),
        });
        break;
      case 'custom':
        instance = new CustomAdapter({
          storage: deps.storage,
          telemetry: deps.telemetry,
          logger: deps.logger,
          model: deps.getModel?.(),
        });
        break;
      default:
        throw new AINotImplementedError(`Unknown AI provider: ${provider as string}`);
    }
    cache.set(provider, instance);
    return instance;
  };

  factory.invalidate = (): void => {
    for (const instance of cache.values()) {
      try {
        instance.dispose();
      } catch {
        // best-effort — disposal must not block reconfiguration
      }
    }
    cache.clear();
  };

  return factory;
}
