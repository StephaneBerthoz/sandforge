import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NL2SOQL,
  type AIProvider,
  type SchemaContext,
  type NL2SOQLResult,
} from './NL2SOQL';

const MOCK_SCHEMA: SchemaContext = {
  objects: [
    {
      apiName: 'Account',
      label: 'Account',
      fields: [
        { apiName: 'Id', label: 'Account ID', type: 'id' },
        { apiName: 'Name', label: 'Account Name', type: 'string' },
        { apiName: 'Industry', label: 'Industry', type: 'picklist' },
        { apiName: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency' },
        { apiName: 'NumberOfEmployees', label: 'Employees', type: 'int' },
      ],
    },
    {
      apiName: 'Contact',
      label: 'Contact',
      fields: [
        { apiName: 'Id', label: 'Contact ID', type: 'id' },
        { apiName: 'FirstName', label: 'First Name', type: 'string' },
        { apiName: 'LastName', label: 'Last Name', type: 'string' },
        { apiName: 'Email', label: 'Email', type: 'email' },
        { apiName: 'AccountId', label: 'Account ID', type: 'reference' },
      ],
    },
  ],
};

function createMockAIResponse(overrides?: Partial<NL2SOQLResult>): string {
  const result: NL2SOQLResult = {
    soql: 'SELECT Id, Name FROM Account',
    explanation: 'Fetches all accounts with their names.',
    confidence: 0.95,
    ...overrides,
  };
  return JSON.stringify(result);
}

describe('NL2SOQL', () => {
  let mockProvider: ReturnType<typeof vi.fn<AIProvider>>;
  let converter: NL2SOQL;

  beforeEach(() => {
    mockProvider = vi.fn<AIProvider>().mockResolvedValue(createMockAIResponse());
    converter = new NL2SOQL(mockProvider);
  });

  // --- generateSOQL ---

  describe('generateSOQL', () => {
    it('should call the AI provider with schema and query', async () => {
      await converter.generateSOQL('Show me all accounts', MOCK_SCHEMA);

      expect(mockProvider).toHaveBeenCalledTimes(1);
      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).toContain('Show me all accounts');
      expect(prompt).toContain('Account');
      expect(prompt).toContain('Name');
    });

    it('should parse the AI response into a structured result', async () => {
      const result = await converter.generateSOQL('Get all accounts', MOCK_SCHEMA);

      expect(result.soql).toBe('SELECT Id, Name FROM Account');
      expect(result.explanation).toBe('Fetches all accounts with their names.');
      expect(result.confidence).toBe(0.95);
    });

    it('should include alternatives when confidence is below 0.8', async () => {
      mockProvider.mockResolvedValue(
        createMockAIResponse({
          confidence: 0.6,
          alternatives: ['SELECT Name FROM Account WHERE Industry = \'Tech\''],
        }),
      );

      const result = await converter.generateSOQL('Maybe find tech accounts', MOCK_SCHEMA);

      expect(result.confidence).toBe(0.6);
      expect(result.alternatives).toBeDefined();
      expect(result.alternatives).toHaveLength(1);
    });

    it('should not include alternatives when confidence is above 0.8', async () => {
      mockProvider.mockResolvedValue(
        createMockAIResponse({ confidence: 0.9 }),
      );

      const result = await converter.generateSOQL('Get all accounts', MOCK_SCHEMA);

      expect(result.confidence).toBe(0.9);
      expect(result.alternatives).toBeUndefined();
    });

    it('should add result to history', async () => {
      await converter.generateSOQL('Get accounts', MOCK_SCHEMA);

      const history = converter.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].soql).toBe('SELECT Id, Name FROM Account');
    });

    it('should handle AI response wrapped in markdown code blocks', async () => {
      const json = createMockAIResponse();
      mockProvider.mockResolvedValue(`\`\`\`json\n${json}\n\`\`\``);

      const result = await converter.generateSOQL('Get accounts', MOCK_SCHEMA);
      expect(result.soql).toBe('SELECT Id, Name FROM Account');
    });

    it('should propagate AI provider errors', async () => {
      mockProvider.mockRejectedValue(new Error('AI service unavailable'));

      await expect(converter.generateSOQL('Get accounts', MOCK_SCHEMA)).rejects.toThrow(
        'AI service unavailable',
      );
    });

    it('should throw on invalid JSON response', async () => {
      mockProvider.mockResolvedValue('not valid json');

      await expect(converter.generateSOQL('Get accounts', MOCK_SCHEMA)).rejects.toThrow();
    });

    it('should handle missing fields in AI response gracefully', async () => {
      mockProvider.mockResolvedValue(JSON.stringify({ soql: 'SELECT Id FROM Account' }));

      const result = await converter.generateSOQL('Get accounts', MOCK_SCHEMA);
      expect(result.soql).toBe('SELECT Id FROM Account');
      expect(result.explanation).toBe('');
      expect(result.confidence).toBe(0);
    });

    it('should include all schema objects in the prompt', async () => {
      await converter.generateSOQL('Show contacts', MOCK_SCHEMA);

      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).toContain('Account');
      expect(prompt).toContain('Contact');
      expect(prompt).toContain('Email');
    });
  });

  // --- validateSOQL ---

  describe('validateSOQL', () => {
    it('should validate a correct SOQL query', () => {
      const result = converter.validateSOQL('SELECT Id, Name FROM Account', MOCK_SCHEMA);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject an empty query', () => {
      const result = converter.validateSOQL('', MOCK_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SOQL query is empty');
    });

    it('should detect missing FROM clause', () => {
      const result = converter.validateSOQL('SELECT Id, Name', MOCK_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('FROM');
    });

    it('should detect unknown objects', () => {
      const result = converter.validateSOQL('SELECT Id FROM UnknownObject', MOCK_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('UnknownObject');
    });

    it('should detect unknown fields', () => {
      const result = converter.validateSOQL('SELECT Id, FakeField FROM Account', MOCK_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('FakeField');
    });

    it('should reject wildcard SELECT', () => {
      const result = converter.validateSOQL('SELECT * FROM Account', MOCK_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Wildcard');
    });

    it('should validate case-insensitively for object names', () => {
      const result = converter.validateSOQL('SELECT Id FROM account', MOCK_SCHEMA);
      expect(result.valid).toBe(true);
    });

    it('should validate case-insensitively for field names', () => {
      const result = converter.validateSOQL('SELECT id, name FROM Account', MOCK_SCHEMA);
      expect(result.valid).toBe(true);
    });

    it('should skip validation for relationship fields', () => {
      const result = converter.validateSOQL('SELECT Account.Name FROM Contact', MOCK_SCHEMA);
      expect(result.valid).toBe(true);
    });

    it('should skip validation for aggregate functions', () => {
      const result = converter.validateSOQL('SELECT COUNT(Id) FROM Account', MOCK_SCHEMA);
      expect(result.valid).toBe(true);
    });

    it('should report multiple invalid fields', () => {
      const result = converter.validateSOQL('SELECT Fake1, Fake2 FROM Account', MOCK_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  // --- History ---

  describe('history', () => {
    it('should start with empty history', () => {
      expect(converter.getHistory()).toHaveLength(0);
    });

    it('should accumulate multiple results in history', async () => {
      await converter.generateSOQL('Query 1', MOCK_SCHEMA);
      await converter.generateSOQL('Query 2', MOCK_SCHEMA);

      expect(converter.getHistory()).toHaveLength(2);
    });

    it('should clear history', async () => {
      await converter.generateSOQL('Query', MOCK_SCHEMA);
      converter.clearHistory();

      expect(converter.getHistory()).toHaveLength(0);
    });

    it('should return a copy of history', async () => {
      await converter.generateSOQL('Query', MOCK_SCHEMA);
      const history = converter.getHistory();
      history.length = 0;

      expect(converter.getHistory()).toHaveLength(1);
    });
  });

  // --- Favorites ---

  describe('favorites', () => {
    it('should start with empty favorites', () => {
      expect(converter.getFavorites()).toHaveLength(0);
    });

    it('should add a favorite', () => {
      converter.addToFavorites('SELECT Id FROM Account', 'All Account IDs');

      const favorites = converter.getFavorites();
      expect(favorites).toHaveLength(1);
      expect(favorites[0].soql).toBe('SELECT Id FROM Account');
      expect(favorites[0].label).toBe('All Account IDs');
    });

    it('should add multiple favorites', () => {
      converter.addToFavorites('SELECT Id FROM Account', 'Accounts');
      converter.addToFavorites('SELECT Email FROM Contact', 'Emails');

      expect(converter.getFavorites()).toHaveLength(2);
    });

    it('should return a copy of favorites', () => {
      converter.addToFavorites('SELECT Id FROM Account', 'Test');
      const favorites = converter.getFavorites();
      favorites.length = 0;

      expect(converter.getFavorites()).toHaveLength(1);
    });
  });
});
