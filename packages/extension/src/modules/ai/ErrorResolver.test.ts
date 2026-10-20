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

  // --- The catalogue answers first ---

  it('asks the model even of a code the error catalogue explains: the catalogue is asked before it', async () => {
    // The resolver read its own table first; the host asks the catalogue every
    // panel reads before it reaches the resolver (resolveFailedOperation).
    const error: SalesforceError = {
      errorCode: 'REQUIRED_FIELD_MISSING',
      message: 'Required fields are missing: [Name]',
    };

    await resolver.resolveError(error, BASE_CONTEXT);

    expect(mockProvider).toHaveBeenCalledTimes(1);
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

    it('strips the Salesforce Ids of a message the fixed list does not cover', async () => {
      // The list of messages SandForge writes itself is matched on its own
      // wordings; a message outside it can still name an org or a record, and
      // the model has no use for the Id.
      const error: SalesforceError = {
        errorCode: 'UNKNOWN',
        message: 'Secret storage did not answer within 10000 ms for org "00D000000000001AAA"',
      };

      await resolver.resolveError(error, {});

      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).not.toContain('00D000000000001AAA');
      // The wrapper escapes what it carries, so the placeholder reads escaped too.
      expect(prompt).toContain('for org "&lt;id&gt;"');
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

    it.each([
      ['a fence around something that is not JSON', '```json\nsorry, no idea\n```'],
      ['a plain sentence', 'I cannot help with that.'],
    ])('answers %s with the message every reader gives', async (_case, reply) => {
      mockProvider.mockResolvedValue(reply);
      const error: SalesforceError = { errorCode: 'UNKNOWN', message: 'Error' };

      const thrown = await resolver.resolveError(error, BASE_CONTEXT).catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(SyntaxError);
      expect((thrown as Error).message).toBe('The AI reply is not valid JSON.');
    });
  });

  // --- The language the answer is written in ---

  describe('host language', () => {
    it('asks for the answer in the language the host runs in', async () => {
      const french = new ErrorResolver(mockProvider, 'fr');

      await french.resolveError({ errorCode: 'UNKNOWN', message: 'Error' }, {});

      expect(mockProvider.mock.calls[0][0]).toContain('Answer in fr');
    });

    it('asks for no language in particular when the host names none', async () => {
      await resolver.resolveError({ errorCode: 'UNKNOWN', message: 'Error' }, {});

      expect(mockProvider.mock.calls[0][0]).not.toContain('Answer in');
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

  it('replaces an Id joined to a name by an underscore', () => {
    expect(normalizeErrorMessage('Cannot restore backup_001xx000003DGb2AAG_tmp')).toBe(
      'Cannot restore backup_<id>_tmp',
    );
  });

  it('leaves a custom field API name alone when one of its segments is Id-shaped', () => {
    const message =
      'INVALID_FIELD: Q_Region2024Budge__c and A_Region2024Budge_B__c are not writable';

    expect(normalizeErrorMessage(message)).toBe(message);
  });

  it('keeps an Id that sits inside a name ending in a `__` suffix, like any segment of it', () => {
    // Nothing tells `001xx000003DGb2AAG_Account__c` from `A_Region2024Budge_B__c`:
    // both are a run of 18 inside a name that goes on to `__c`.
    const message = 'Id 001xx000003DGb2AAG_Account__c and ns_00D000000000001AAA__x';

    expect(normalizeErrorMessage(message)).toBe(message);
  });

  it('leaves a longer run of letters and digits alone', () => {
    const message = 'Token 001xx000003DGb2AAGZ is not an Id';

    expect(normalizeErrorMessage(message)).toBe(message);
  });

  it('leaves error codes, field names and ordinary words alone', () => {
    const message =
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: representations on External_Id__c are incomprehensible';

    expect(normalizeErrorMessage(message)).toBe(message);
  });
});
