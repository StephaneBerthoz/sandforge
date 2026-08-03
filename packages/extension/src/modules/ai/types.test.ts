import { describe, it, expect } from 'vitest';

import type { AIProvider } from './types.js';
import type { AIProvider as NL2SOQLProvider } from './NL2SOQL.js';
import type { AIProvider as ErrorResolverProvider } from './ErrorResolver.js';
import type { AIProvider as PersonaManagerProvider } from './AIPersonaManager.js';
import type { AIProvider as SmartSuggestionsProvider } from './SmartSuggestions.js';

describe('modules/ai/types', () => {
  it('exposes a single AIProvider type re-exported identically by all AI modules', async () => {
    const provider: AIProvider = async (prompt) => `echo:${prompt}`;

    // Compile-time contract: every module's re-export is the same type, so
    // assignments are bidirectional without casts.
    const viaNL2SOQL: NL2SOQLProvider = provider;
    const viaErrorResolver: ErrorResolverProvider = viaNL2SOQL;
    const viaPersonaManager: PersonaManagerProvider = viaErrorResolver;
    const viaSmartSuggestions: SmartSuggestionsProvider = viaPersonaManager;
    const backToBase: AIProvider = viaSmartSuggestions;

    await expect(backToBase('ping')).resolves.toBe('echo:ping');
  });
});
