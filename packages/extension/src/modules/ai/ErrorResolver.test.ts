import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  ErrorResolver,
  normalizeErrorMessage,
  type AIProvider,
  type SalesforceError,
  type OperationContext,
  type ErrorResolution,
} from './ErrorResolver';

const BASE_CONTEXT: OperationContext = {
  module: 'seed',
  operation: 'insert',
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
  let mockProvider: Mock<AIProvider>;
  let resolver: ErrorResolver;

  beforeEach(() => {
    mockProvider = vi.fn<AIProvider>().mockResolvedValue(createMockAIResolution());
    resolver = new ErrorResolver(mockProvider);
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('should add batch size suggestion when batch is large', async () => {
      const largeContext: OperationContext = { ...BASE_CONTEXT, batchSize: 500 };
      const error: SalesforceError = {
        errorCode: 'UNABLE_TO_LOCK_ROW',
        message: 'lock contention',
      };

      const resolution = await resolver.resolveError(error, largeContext);

      const contextualSuggestion = resolution.suggestions.find(
        (s) => s.action === 'reduce_batch_size' && s.description.includes('500'),
      );
      expect(contextualSuggestion).toBeDefined();
    });

    it('should answer the ten most common error codes without calling AI', async () => {
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
      }
      expect(mockProvider).not.toHaveBeenCalled();
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
        objectName: 'Lead',
        batchSize: 100,
        recordCount: 5000,
      };

      await resolver.resolveError(error, context);

      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).toContain('Module: sync');
      expect(prompt).toContain('Operation: upsert');
      expect(prompt).toContain('Lead');
      expect(prompt).toContain('100');
      expect(prompt).toContain('5000');
    });

    it('should leave out the context lines nobody knows', async () => {
      // A failure reported through operation:failed names neither its module
      // nor its operation; "Module: unknown" told the model nothing and read
      // as a fact.
      await resolver.resolveError({ errorCode: 'UNKNOWN', message: 'Error' }, {});

      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).not.toContain('Operation context:');
      expect(prompt).not.toContain('Module:');
      expect(prompt).not.toContain('Operation:');
      expect(prompt).not.toContain('unknown');
      expect(prompt).toContain('Error code: UNKNOWN');
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

  // --- One model call per distinct failure ---

  describe('repeated failures', () => {
    const LOCKED = (recordId: string): SalesforceError => ({
      errorCode: 'SOME_EXOTIC_ERROR',
      message: `Record ${recordId} could not be processed by the org`,
    });

    it('shares one model call between failures in flight that differ only by record Id', async () => {
      let answer: (value: string) => void = () => undefined;
      mockProvider.mockReturnValue(
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
      );

      const first = resolver.resolveError(LOCKED('001000000000001AAA'), {});
      const second = resolver.resolveError(LOCKED('001000000000002AAA'), {});
      answer(createMockAIResolution({ explanation: 'shared' }));

      await expect(first).resolves.toMatchObject({ explanation: 'shared' });
      await expect(second).resolves.toMatchObject({ explanation: 'shared' });
      expect(mockProvider).toHaveBeenCalledTimes(1);
    });

    it('answers the same failure again from memory until the answer expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-15T10:00:00Z'));

      await resolver.resolveError(LOCKED('001000000000001'), {});
      await resolver.resolveError(LOCKED('001000000000009'), {});
      expect(mockProvider).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-09-15T10:11:00Z'));
      await resolver.resolveError(LOCKED('001000000000001'), {});
      expect(mockProvider).toHaveBeenCalledTimes(2);
    });

    it('asks again for a different failure', async () => {
      await resolver.resolveError(LOCKED('001000000000001'), {});
      await resolver.resolveError({ errorCode: 'OTHER_EXOTIC_ERROR', message: 'Other' }, {});
      await resolver.resolveError({ errorCode: 'SOME_EXOTIC_ERROR', message: 'Other' }, {});

      expect(mockProvider).toHaveBeenCalledTimes(3);
    });

    it('does not keep a failed model call, so the next failure asks again', async () => {
      mockProvider.mockRejectedValueOnce(new Error('AI offline'));

      await expect(resolver.resolveError(LOCKED('001000000000001'), {})).rejects.toThrow(
        'AI offline',
      );
      await expect(resolver.resolveError(LOCKED('001000000000001'), {})).resolves.toMatchObject({
        explanation: 'AI-generated explanation of the error.',
      });
      expect(mockProvider).toHaveBeenCalledTimes(2);
    });
  });
});

describe('normalizeErrorMessage', () => {
  it('replaces 15- and 18-character Salesforce Ids', () => {
    expect(
      normalizeErrorMessage(
        'Backup op-1 was taken from org 00D000000000001AAA and cannot be restored into org 00D000000000002.',
      ),
    ).toBe('Backup op-1 was taken from org <id> and cannot be restored into org <id>.');
  });

  it('leaves error codes, field names and ordinary words alone', () => {
    const message =
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: representations on External_Id__c are incomprehensible';

    expect(normalizeErrorMessage(message)).toBe(message);
  });
});
