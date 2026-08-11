import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AIPersonaManager, type AIProvider, type AIPersona } from './AIPersonaManager';

function createMockPersonaResponse(overrides?: Partial<AIPersona>): string {
  const persona: Omit<AIPersona, 'id'> = {
    name: 'Custom Veterinary Clinic',
    description: 'Veterinary clinic with patients, owners, and appointments.',
    industry: 'Veterinary',
    locale: 'en-US',
    dataPatterns: {
      Pet_Name__c: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'animal.petName' },
        examples: ['Buddy', 'Luna', 'Max'],
      },
      Species__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Dog', 'Cat', 'Bird', 'Rabbit'] },
        examples: ['Dog', 'Cat', 'Bird'],
      },
      Owner_Name__c: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'person.fullName' },
        examples: ['John Smith', 'Jane Doe', 'Bob Wilson'],
      },
      Visit_Reason__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Checkup', 'Vaccination', 'Surgery', 'Emergency'] },
        examples: ['Checkup', 'Vaccination', 'Emergency'],
      },
      Visit_Cost__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: 50, max: 2000, currency: 'USD' },
        examples: ['75.00', '250.00', '1500.00'],
      },
    },
    ...overrides,
  };
  return JSON.stringify(persona);
}

describe('AIPersonaManager', () => {
  let manager: AIPersonaManager;

  beforeEach(() => {
    manager = new AIPersonaManager();
  });

  // --- Built-in personas ---

  describe('getBuiltInPersonas', () => {
    it('should return exactly 10 built-in personas', () => {
      const personas = manager.getBuiltInPersonas();
      expect(personas).toHaveLength(10);
    });

    it('should include all required persona IDs', () => {
      const personas = manager.getBuiltInPersonas();
      const ids = personas.map((p) => p.id);

      expect(ids).toContain('assureur-fr');
      expect(ids).toContain('hospital-us');
      expect(ids).toContain('ecommerce-b2c');
      expect(ids).toContain('banque-eu');
      expect(ids).toContain('startup-saas');
      expect(ids).toContain('immobilier');
      expect(ids).toContain('education');
      expect(ids).toContain('logistique');
      expect(ids).toContain('rh');
      expect(ids).toContain('ong');
    });

    it('should have non-empty dataPatterns for every persona', () => {
      const personas = manager.getBuiltInPersonas();

      for (const persona of personas) {
        const patternCount = Object.keys(persona.dataPatterns).length;
        expect(patternCount).toBeGreaterThan(0);
      }
    });

    it('should have examples for every field pattern', () => {
      const personas = manager.getBuiltInPersonas();

      for (const persona of personas) {
        for (const [fieldName, pattern] of Object.entries(persona.dataPatterns)) {
          expect(
            pattern.examples.length,
            `Missing examples for ${persona.id}/${fieldName}`,
          ).toBeGreaterThan(0);
        }
      }
    });

    it('should return a copy of the built-in personas array', () => {
      const personas = manager.getBuiltInPersonas();
      personas.length = 0;

      expect(manager.getBuiltInPersonas()).toHaveLength(10);
    });

    it('should have locale set for every persona', () => {
      const personas = manager.getBuiltInPersonas();

      for (const persona of personas) {
        expect(persona.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      }
    });
  });

  // --- getPersona ---

  describe('getPersona', () => {
    it('should find a built-in persona by ID', () => {
      const persona = manager.getPersona('assureur-fr');

      expect(persona).toBeDefined();
      expect(persona?.name).toBe('Assureur français');
      expect(persona?.industry).toBe('Insurance');
    });

    it('should return undefined for an unknown ID', () => {
      expect(manager.getPersona('nonexistent')).toBeUndefined();
    });

    it('should find a custom persona by ID after creation', async () => {
      const mockProvider = vi
        .fn<AIProvider>()
        .mockResolvedValue(createMockPersonaResponse());
      const created = await manager.createCustomPersona('Vet clinic', mockProvider);

      const found = manager.getPersona(created.id);
      expect(found).toBeDefined();
      expect(found?.name).toBe('Custom Veterinary Clinic');
    });
  });

  // --- createCustomPersona ---

  describe('createCustomPersona', () => {
    let mockProvider: Mock<AIProvider>;

    beforeEach(() => {
      mockProvider = vi
        .fn<AIProvider>()
        .mockResolvedValue(createMockPersonaResponse());
    });

    it('should call the AI provider with the description', async () => {
      await manager.createCustomPersona('A veterinary clinic in Texas', mockProvider);

      expect(mockProvider).toHaveBeenCalledTimes(1);
      const prompt = mockProvider.mock.calls[0][0];
      expect(prompt).toContain('A veterinary clinic in Texas');
    });

    it('should return a persona with a generated ID', async () => {
      const persona = await manager.createCustomPersona('Vet clinic', mockProvider);

      expect(persona.id).toMatch(/^custom-/);
      expect(persona.name).toBe('Custom Veterinary Clinic');
      expect(persona.industry).toBe('Veterinary');
    });

    it('should assign unique IDs to multiple custom personas', async () => {
      const p1 = await manager.createCustomPersona('Clinic A', mockProvider);
      const p2 = await manager.createCustomPersona('Clinic B', mockProvider);

      expect(p1.id).not.toBe(p2.id);
    });

    it('should parse data patterns from AI response', async () => {
      const persona = await manager.createCustomPersona('Vet clinic', mockProvider);

      expect(Object.keys(persona.dataPatterns).length).toBeGreaterThan(0);
      expect(persona.dataPatterns['Pet_Name__c']).toBeDefined();
      expect(persona.dataPatterns['Pet_Name__c'].generator).toBe('faker');
    });

    it('should handle AI response wrapped in markdown code blocks', async () => {
      const json = createMockPersonaResponse();
      mockProvider.mockResolvedValue(`\`\`\`json\n${json}\n\`\`\``);

      const persona = await manager.createCustomPersona('Vet clinic', mockProvider);
      expect(persona.name).toBe('Custom Veterinary Clinic');
    });

    it('should propagate AI provider errors', async () => {
      mockProvider.mockRejectedValue(new Error('AI service unavailable'));

      await expect(manager.createCustomPersona('Vet clinic', mockProvider)).rejects.toThrow(
        'AI service unavailable',
      );
    });

    it('should throw on invalid JSON response', async () => {
      mockProvider.mockResolvedValue('not valid json at all');

      await expect(manager.createCustomPersona('Vet clinic', mockProvider)).rejects.toThrow();
    });

    it('should provide defaults for missing fields in AI response', async () => {
      mockProvider.mockResolvedValue(JSON.stringify({ dataPatterns: {} }));

      const persona = await manager.createCustomPersona('Minimal', mockProvider);
      expect(persona.name).toBe('Custom Persona');
      expect(persona.industry).toBe('General');
      expect(persona.locale).toBe('en-US');
    });
  });

  // --- applyPersona ---

  describe('applyPersona', () => {
    it('should return the matching field pattern', () => {
      const persona = manager.getPersona('assureur-fr');
      expect(persona).toBeDefined();

      const pattern = manager.applyPersona(persona!, 'Account', 'SIRET__c');

      expect(pattern).toBeDefined();
      expect(pattern?.fieldType).toBe('string');
      expect(pattern?.generator).toBe('pattern');
    });

    it('should return undefined for non-matching field names', () => {
      const persona = manager.getPersona('assureur-fr');
      expect(persona).toBeDefined();

      const pattern = manager.applyPersona(persona!, 'Account', 'NonExistentField__c');
      expect(pattern).toBeUndefined();
    });

    it('should work with different personas and fields', () => {
      const persona = manager.getPersona('hospital-us');
      expect(persona).toBeDefined();

      const pattern = manager.applyPersona(persona!, 'Case', 'ICD10_Code__c');

      expect(pattern).toBeDefined();
      expect(pattern?.generator).toBe('random_pick');
    });

    it('should return pattern with examples populated', () => {
      const persona = manager.getPersona('ecommerce-b2c');
      expect(persona).toBeDefined();

      const pattern = manager.applyPersona(persona!, 'Product2', 'Product_Name__c');

      expect(pattern).toBeDefined();
      expect(pattern?.examples.length).toBeGreaterThan(0);
    });
  });

  // --- getCustomPersonas ---

  describe('getCustomPersonas', () => {
    it('should start with empty custom personas', () => {
      expect(manager.getCustomPersonas()).toHaveLength(0);
    });

    it('should include created custom personas', async () => {
      const mockProvider = vi
        .fn<AIProvider>()
        .mockResolvedValue(createMockPersonaResponse());
      await manager.createCustomPersona('Test', mockProvider);

      expect(manager.getCustomPersonas()).toHaveLength(1);
    });

    it('should accumulate multiple custom personas', async () => {
      const mockProvider = vi
        .fn<AIProvider>()
        .mockResolvedValue(createMockPersonaResponse());
      await manager.createCustomPersona('Test A', mockProvider);
      await manager.createCustomPersona('Test B', mockProvider);

      expect(manager.getCustomPersonas()).toHaveLength(2);
    });
  });
});
