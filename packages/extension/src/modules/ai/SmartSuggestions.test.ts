import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmartSuggestions, type AIProvider } from './SmartSuggestions';

describe('SmartSuggestions', () => {
  let engine: SmartSuggestions;

  beforeEach(() => {
    engine = new SmartSuggestions();
  });

  // --- Compare module rules ---

  it('should suggest deployment order when multiple objects exist', async () => {
    const suggestions = await engine.suggest('compare', {
      objects: ['Account', 'Contact', 'Opportunity'],
    });
    const titles = suggestions.map((s) => s.title);
    expect(titles).toContain('Optimize deployment order');
  });

  it('should suggest dry-run when changes are detected', async () => {
    const suggestions = await engine.suggest('compare', {
      objects: ['Account'],
      hasChanges: true,
    });
    const titles = suggestions.map((s) => s.title);
    expect(titles).toContain('Estimate impact before deploying');
  });

  // --- Seed module rules ---

  it('should suggest template fixes when errors occurred', async () => {
    const suggestions = await engine.suggest('seed', { errorCount: 5 });
    const match = suggestions.find((s) => s.title === 'Improve template based on errors');
    expect(match).toBeDefined();
    expect(match?.impact).toBe('high');
  });

  it('should suggest adding defaults for missing required fields', async () => {
    const suggestions = await engine.suggest('seed', {
      missingRequired: ['Industry', 'BillingCity'],
    });
    expect(suggestions.some((s) => s.action === 'add_defaults')).toBe(true);
  });

  // --- Sync module rules ---

  it('should suggest increasing batch size for large record sets', async () => {
    const suggestions = await engine.suggest('sync', {
      batchSize: 50,
      recordCount: 10000,
    });
    expect(suggestions.some((s) => s.action === 'increase_batch')).toBe(true);
  });

  it('should suggest reviewing mapping when type mismatches exist', async () => {
    const suggestions = await engine.suggest('sync', { typeMismatches: 3 });
    expect(suggestions.some((s) => s.title === 'Review field mapping')).toBe(true);
  });

  // --- Monitor module rules ---

  it('should suggest resolving critical alerts', async () => {
    const suggestions = await engine.suggest('monitor', { criticalAlerts: 2 });
    const match = suggestions.find((s) => s.action === 'resolve_alerts');
    expect(match).toBeDefined();
    expect(match?.confidence).toBe(0.95);
  });

  // --- DataOps module rules ---

  it('should suggest anonymization for sensitive fields', async () => {
    const suggestions = await engine.suggest('dataops', {
      sensitiveFields: ['Email', 'Phone'],
    });
    expect(suggestions.some((s) => s.action === 'add_anonymization')).toBe(true);
  });

  it('should suggest enabling audit logging', async () => {
    const suggestions = await engine.suggest('dataops', {
      sensitiveFields: [],
      auditEnabled: false,
    });
    expect(suggestions.some((s) => s.action === 'enable_audit')).toBe(true);
  });

  // --- Empty and unknown modules ---

  it('should return empty suggestions for unknown module without AI', async () => {
    const suggestions = await engine.suggest('unknown_module', { data: true });
    expect(suggestions).toEqual([]);
  });

  it('should return empty suggestions when no rules match', async () => {
    const suggestions = await engine.suggest('compare', { objects: [] });
    expect(suggestions).toEqual([]);
  });

  // --- Dismissal ---

  it('should dismiss a suggestion by title', async () => {
    await engine.suggest('seed', { errorCount: 5 });
    engine.dismissSuggestion('Improve template based on errors');

    const after = await engine.suggest('seed', { errorCount: 5 });
    expect(after.some((s) => s.title === 'Improve template based on errors')).toBe(false);
  });

  it('should track dismissed suggestions', () => {
    engine.dismissSuggestion('A');
    engine.dismissSuggestion('B');
    expect(engine.getDismissed()).toEqual(['A', 'B']);
  });

  it('should clear dismissed suggestions', () => {
    engine.dismissSuggestion('Test');
    engine.clearDismissed();
    expect(engine.getDismissed()).toEqual([]);
  });

  it('should not return dismissed suggestions after clearing', async () => {
    engine.dismissSuggestion('Improve template based on errors');
    engine.clearDismissed();
    const suggestions = await engine.suggest('seed', { errorCount: 5 });
    expect(suggestions.some((s) => s.title === 'Improve template based on errors')).toBe(true);
  });

  // --- Suggestion shape ---

  it('should produce suggestions with correct shape', async () => {
    const suggestions = await engine.suggest('compare', {
      objects: ['A', 'B'],
      hasChanges: true,
    });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(s).toHaveProperty('title');
      expect(s).toHaveProperty('description');
      expect(s).toHaveProperty('impact');
      expect(s).toHaveProperty('confidence');
      expect(s).toHaveProperty('action');
      expect(s).toHaveProperty('dismissable');
      expect(s).toHaveProperty('module');
      expect(s.module).toBe('compare');
      expect(s.dismissable).toBe(true);
    }
  });

  // --- AI fallback ---

  it('should fall back to AI provider when no rules match', async () => {
    const mockProvider = vi
      .fn<AIProvider>()
      .mockResolvedValue(
        JSON.stringify([
          {
            title: 'AI Suggestion',
            description: 'From AI',
            impact: 'high',
            confidence: 0.7,
            action: 'ai_action',
          },
        ]),
      );

    const engineWithAI = new SmartSuggestions(mockProvider);
    const suggestions = await engineWithAI.suggest('unknown', { custom: true });

    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].title).toBe('AI Suggestion');
    expect(suggestions[0].module).toBe('unknown');
  });

  it('should handle AI provider returning invalid JSON gracefully', async () => {
    const mockProvider = vi.fn<AIProvider>().mockResolvedValue('not valid json');
    const engineWithAI = new SmartSuggestions(mockProvider);
    const suggestions = await engineWithAI.suggest('unknown', {});
    expect(suggestions).toEqual([]);
  });

  it('should not call AI provider when built-in rules match', async () => {
    const mockProvider = vi.fn<AIProvider>().mockResolvedValue('[]');
    const engineWithAI = new SmartSuggestions(mockProvider);
    await engineWithAI.suggest('seed', { errorCount: 1 });
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('should apply dismissals to AI-generated suggestions', async () => {
    const mockProvider = vi
      .fn<AIProvider>()
      .mockResolvedValue(JSON.stringify([{ title: 'AI Tip', description: 'desc' }]));

    const engineWithAI = new SmartSuggestions(mockProvider);
    engineWithAI.dismissSuggestion('AI Tip');

    const suggestions = await engineWithAI.suggest('unknown', {});
    expect(suggestions).toEqual([]);
  });

  it('should default AI suggestion fields when missing', async () => {
    const mockProvider = vi
      .fn<AIProvider>()
      .mockResolvedValue(
        JSON.stringify([{ title: 'Minimal', description: 'Just title and desc' }]),
      );

    const engineWithAI = new SmartSuggestions(mockProvider);
    const suggestions = await engineWithAI.suggest('unknown', {});
    expect(suggestions[0].impact).toBe('low');
    expect(suggestions[0].confidence).toBe(0.5);
    expect(suggestions[0].action).toBe('review');
  });
});
