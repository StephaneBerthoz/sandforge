import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ErrorResolver,
  type AIProvider,
  type SalesforceError,
  type OperationContext,
  type ErrorResolution,
} from './ErrorResolver';

const BASE_CONTEXT: OperationContext = {
  module: 'seed',
  operation: 'insert',
  orgId: '00D000000000001',
  objectName: 'Account',
  batchSize: 200,
  recordCount: 1000,
};

function createMockAIResolution(overrides?: Partial<ErrorResolution>): string {
  const resolution: ErrorResolution = {
    explanation: 'AI-generated explanation of the error.',
    suggestions: [
      {
        title: 'AI Suggestion',
        description: 'Try this approach.',
        probability: 0.7,
        action: 'ai_fix',
      },
    ],
    autoFixable: false,
    confidence: 0.6,
    relatedDocs: ['https://developer.salesforce.com/docs'],
    ...overrides,
  };
  return JSON.stringify(resolution);
}

describe('ErrorResolver', () => {
  let mockProvider: ReturnType<typeof vi.fn<AIProvider>>;
  let resolver: ErrorResolver;

  beforeEach(() => {
    mockProvider = vi.fn<AIProvider>().mockResolvedValue(createMockAIResolution());
    resolver = new ErrorResolver(mockProvider);
  });

  // --- Knowledge base resolution ---

  describe('known error resolution', () => {
    it('should resolve REQUIRED_FIELD_MISSING from knowledge base without calling AI', async () => {
      const error: SalesforceError = {
        errorCode: 'REQUIRED_FIELD_MISSING',
        message: 'Required fields are missing: [Name]',
        fields: ['Name'],
        objectName: 'Account',
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(mockProvider).not.toHaveBeenCalled();
      expect(resolution.explanation).toContain('required field');
      expect(resolution.confidence).toBe(0.95);
      expect(resolution.suggestions.length).toBeGreaterThan(0);
    });

    it('should resolve UNABLE_TO_LOCK_ROW as auto-fixable', async () => {
      const error: SalesforceError = {
        errorCode: 'UNABLE_TO_LOCK_ROW',
        message: 'unable to obtain exclusive access to this record',
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.autoFixable).toBe(true);
      expect(resolution.autoFixAction).toBe('retry');
    });

    it('should resolve DUPLICATE_VALUE from knowledge base', async () => {
      const error: SalesforceError = {
        errorCode: 'DUPLICATE_VALUE',
        message: 'duplicate value found',
        fields: ['External_Id__c'],
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.explanation).toContain('duplicate');
      expect(resolution.explanation).toContain('External_Id__c');
    });

    it('should resolve STRING_TOO_LONG as auto-fixable', async () => {
      const error: SalesforceError = {
        errorCode: 'STRING_TOO_LONG',
        message: 'value too long',
        fields: ['Description'],
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.autoFixable).toBe(true);
      expect(resolution.autoFixAction).toBe('truncate_fields');
    });

    it('should resolve REQUEST_LIMIT_EXCEEDED with retry suggestion', async () => {
      const error: SalesforceError = {
        errorCode: 'REQUEST_LIMIT_EXCEEDED',
        message: 'TotalRequests Limit exceeded.',
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.autoFixable).toBe(true);
      const retryAction = resolution.suggestions.find((s) => s.action === 'retry');
      expect(retryAction).toBeDefined();
    });

    it('should resolve INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY as not auto-fixable', async () => {
      const error: SalesforceError = {
        errorCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
        message: 'insufficient access rights on cross-reference id',
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.autoFixable).toBe(false);
      expect(resolution.suggestions.length).toBeGreaterThanOrEqual(2);
    });

    it('should enrich explanation with affected fields', async () => {
      const error: SalesforceError = {
        errorCode: 'REQUIRED_FIELD_MISSING',
        message: 'Missing fields',
        fields: ['Name', 'Email'],
        objectName: 'Contact',
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.explanation).toContain('Name, Email');
      expect(resolution.explanation).toContain('Contact');
    });

    it('should add batch size suggestion when batch is large', async () => {
      const largeContext: OperationContext = { ...BASE_CONTEXT, batchSize: 500 };
      const error: SalesforceError = {
        errorCode: 'UNABLE_TO_LOCK_ROW',
        message: 'lock contention',
      };

      const resolution = await resolver.resolveError(error, largeContext);

      const batchSuggestions = resolution.suggestions.filter((s) => s.action === 'reduce_batch_size');
      expect(batchSuggestions.length).toBeGreaterThanOrEqual(1);
      const contextualSuggestion = batchSuggestions.find((s) => s.description.includes('500'));
      expect(contextualSuggestion).toBeDefined();
    });
  });

  // --- AI fallback resolution ---

  describe('AI fallback', () => {
    it('should fall back to AI for unknown error codes', async () => {
      const error: SalesforceError = {
        errorCode: 'SOME_EXOTIC_ERROR',
        message: 'Something very specific went wrong.',
      };

      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(mockProvider).toHaveBeenCalledTimes(1);
      expect(resolution.explanation).toBe('AI-generated explanation of the error.');
    });

    it('should include error details in the AI prompt', async () => {
      const error: SalesforceError = {
        errorCode: 'CUSTOM_ERROR',
        message: 'Custom error message',
        fields: ['FieldA'],
        objectName: 'CustomObject__c',
      };

      await resolver.resolveError(error, BASE_CONTEXT);

      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).toContain('CUSTOM_ERROR');
      expect(prompt).toContain('Custom error message');
      expect(prompt).toContain('FieldA');
      expect(prompt).toContain('CustomObject__c');
    });

    it('should include operation context in the AI prompt', async () => {
      const error: SalesforceError = { errorCode: 'UNKNOWN', message: 'Error' };
      const context: OperationContext = {
        module: 'sync',
        operation: 'upsert',
        orgId: '00Dtest',
        objectName: 'Lead',
        batchSize: 100,
        recordCount: 5000,
      };

      await resolver.resolveError(error, context);

      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).toContain('sync');
      expect(prompt).toContain('upsert');
      expect(prompt).toContain('Lead');
      expect(prompt).toContain('100');
      expect(prompt).toContain('5000');
    });

    it('should handle AI response wrapped in markdown code blocks', async () => {
      const json = createMockAIResolution({ explanation: 'Wrapped response' });
      mockProvider.mockResolvedValue(`\`\`\`json\n${json}\n\`\`\``);

      const error: SalesforceError = { errorCode: 'UNKNOWN', message: 'Error' };
      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.explanation).toBe('Wrapped response');
    });

    it('should propagate AI provider errors', async () => {
      mockProvider.mockRejectedValue(new Error('AI offline'));
      const error: SalesforceError = { errorCode: 'UNKNOWN', message: 'Error' };

      await expect(resolver.resolveError(error, BASE_CONTEXT)).rejects.toThrow('AI offline');
    });
  });

  // --- History ---

  describe('resolution history', () => {
    it('should start with empty history', () => {
      expect(resolver.getResolutionHistory()).toHaveLength(0);
    });

    it('should record resolution in history', async () => {
      const error: SalesforceError = { errorCode: 'DUPLICATE_VALUE', message: 'dup' };
      await resolver.resolveError(error, BASE_CONTEXT);

      const history = resolver.getResolutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].error.errorCode).toBe('DUPLICATE_VALUE');
      expect(history[0].resolution).toBeDefined();
      expect(history[0].timestamp).toBeDefined();
    });

    it('should accumulate multiple entries', async () => {
      const error1: SalesforceError = { errorCode: 'DUPLICATE_VALUE', message: 'dup' };
      const error2: SalesforceError = { errorCode: 'UNKNOWN', message: 'err' };

      await resolver.resolveError(error1, BASE_CONTEXT);
      await resolver.resolveError(error2, BASE_CONTEXT);

      expect(resolver.getResolutionHistory()).toHaveLength(2);
    });

    it('should return a copy of history', async () => {
      const error: SalesforceError = { errorCode: 'DUPLICATE_VALUE', message: 'dup' };
      await resolver.resolveError(error, BASE_CONTEXT);

      const history = resolver.getResolutionHistory();
      history.length = 0;

      expect(resolver.getResolutionHistory()).toHaveLength(1);
    });
  });

  // --- Learning ---

  describe('learnFromSuccess', () => {
    it('should prioritize learned resolution over knowledge base', async () => {
      const learnedResolution: ErrorResolution = {
        explanation: 'Learned fix: re-map the field.',
        suggestions: [{ title: 'Remap', description: 'Remap the field.', probability: 0.99 }],
        autoFixable: true,
        autoFixAction: 'remap',
        confidence: 1.0,
        relatedDocs: [],
      };

      resolver.learnFromSuccess('REQUIRED_FIELD_MISSING', learnedResolution);

      const error: SalesforceError = { errorCode: 'REQUIRED_FIELD_MISSING', message: 'missing' };
      const resolution = await resolver.resolveError(error, BASE_CONTEXT);

      expect(resolution.explanation).toBe('Learned fix: re-map the field.');
      expect(mockProvider).not.toHaveBeenCalled();
    });

    it('should increment success count for repeated successful resolutions', async () => {
      const resolution: ErrorResolution = {
        explanation: 'Fixed it.',
        suggestions: [],
        autoFixable: false,
        confidence: 0.9,
        relatedDocs: [],
      };

      resolver.learnFromSuccess('CUSTOM_ERR', resolution);
      resolver.learnFromSuccess('CUSTOM_ERR', resolution);

      const error: SalesforceError = { errorCode: 'CUSTOM_ERR', message: 'err' };
      const result = await resolver.resolveError(error, BASE_CONTEXT);

      expect(result.explanation).toBe('Fixed it.');
    });

    it('should prefer the resolution with the highest success count', async () => {
      const resolutionA: ErrorResolution = {
        explanation: 'Resolution A',
        suggestions: [],
        autoFixable: false,
        confidence: 0.8,
        relatedDocs: [],
      };
      const resolutionB: ErrorResolution = {
        explanation: 'Resolution B',
        suggestions: [],
        autoFixable: false,
        confidence: 0.9,
        relatedDocs: [],
      };

      resolver.learnFromSuccess('TEST_ERR', resolutionA);
      resolver.learnFromSuccess('TEST_ERR', resolutionB);
      resolver.learnFromSuccess('TEST_ERR', resolutionB);
      resolver.learnFromSuccess('TEST_ERR', resolutionB);

      const error: SalesforceError = { errorCode: 'TEST_ERR', message: 'test' };
      const result = await resolver.resolveError(error, BASE_CONTEXT);

      expect(result.explanation).toBe('Resolution B');
    });
  });

  // --- Knowledge base ---

  describe('knowledge base', () => {
    it('should have at least 25 entries', () => {
      expect(resolver.getKnowledgeBaseSize()).toBeGreaterThanOrEqual(25);
    });

    it('should handle all 10 required error codes', async () => {
      const requiredCodes = [
        'FIELD_CUSTOM_VALIDATION_EXCEPTION',
        'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
        'DUPLICATE_VALUE',
        'REQUIRED_FIELD_MISSING',
        'STRING_TOO_LONG',
        'INVALID_CROSS_REFERENCE_KEY',
        'ENTITY_IS_DELETED',
        'DELETE_FAILED',
        'UNABLE_TO_LOCK_ROW',
        'REQUEST_LIMIT_EXCEEDED',
      ];

      for (const code of requiredCodes) {
        const error: SalesforceError = { errorCode: code, message: `${code} test` };
        const resolution = await resolver.resolveError(error, BASE_CONTEXT);

        expect(resolution.confidence).toBe(0.95);
        expect(resolution.suggestions.length).toBeGreaterThan(0);
        expect(mockProvider).not.toHaveBeenCalled();
      }
    });
  });
});
