import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIDataGenerator, buildPrompt, parseAIResponse } from './AIDataGenerator';
import type { CallAIFn } from './AIDataGenerator';
import type { FieldRule } from '@sandforge/shared';

function createFieldRule(overrides?: Partial<FieldRule>): FieldRule {
  return {
    fieldApiName: 'Name',
    ruleType: 'ai_generate',
    config: { aiPrompt: 'Generate a realistic company name' },
    ...overrides,
  };
}

describe('AIDataGenerator', () => {
  let callAI: CallAIFn;
  let generator: AIDataGenerator;

  beforeEach(() => {
    callAI = vi.fn<CallAIFn>().mockResolvedValue(
      JSON.stringify([{ Name: 'Acme Corp' }, { Name: 'Globex Inc' }])
    );
    generator = new AIDataGenerator(callAI);
  });

  describe('generate', () => {
    it('should return empty array for zero count', async () => {
      const result = await generator.generate([createFieldRule()], 0);
      expect(result).toEqual([]);
    });

    it('should return empty array for empty field rules', async () => {
      const result = await generator.generate([], 5);
      expect(result).toEqual([]);
    });

    it('should call AI and parse response', async () => {
      const rules = [createFieldRule()];
      const result = await generator.generate(rules, 2);

      expect(callAI).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ Name: 'Acme Corp' });
    });

    it('should truncate results to requested count', async () => {
      vi.mocked(callAI).mockResolvedValue(
        JSON.stringify([{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }])
      );
      const result = await generator.generate([createFieldRule()], 2);
      expect(result).toHaveLength(2);
    });

    it('should batch large requests into multiple AI calls', async () => {
      let callCount = 0;
      vi.mocked(callAI).mockImplementation(async () => {
        callCount++;
        const records = Array.from({ length: 50 }, (_, i) => ({ Name: `Record ${i}` }));
        return JSON.stringify(records);
      });

      const result = await generator.generate([createFieldRule()], 100);

      expect(callCount).toBe(2);
      expect(result).toHaveLength(100);
    });

    it('should include persona in the prompt when provided', async () => {
      await generator.generate([createFieldRule()], 1, 'Healthcare startup CEO');

      const promptArg = vi.mocked(callAI).mock.calls[0][0];
      expect(promptArg).toContain('Persona: Healthcare startup CEO');
    });

    it('should not include persona when not provided', async () => {
      await generator.generate([createFieldRule()], 1);

      const promptArg = vi.mocked(callAI).mock.calls[0][0];
      expect(promptArg).not.toContain('Persona:');
    });

    it('should handle AI returning a single object instead of array', async () => {
      vi.mocked(callAI).mockResolvedValue(JSON.stringify({ Name: 'Solo Corp' }));

      const result = await generator.generate([createFieldRule()], 1);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ Name: 'Solo Corp' });
    });

    it('should handle negative count gracefully', async () => {
      const result = await generator.generate([createFieldRule()], -5);
      expect(result).toEqual([]);
    });

    it('should propagate AI call errors', async () => {
      vi.mocked(callAI).mockRejectedValue(new Error('AI service unavailable'));

      await expect(generator.generate([createFieldRule()], 1)).rejects.toThrow(
        'AI service unavailable'
      );
    });
  });

  describe('buildPrompt', () => {
    it('should include field descriptions', () => {
      const rules = [createFieldRule({ fieldApiName: 'Email', config: { aiPrompt: 'business email' } })];
      const prompt = buildPrompt(rules, 5);

      expect(prompt).toContain('Email');
      expect(prompt).toContain('business email');
      expect(prompt).toContain('5');
    });

    it('should include range constraints when present', () => {
      const rules = [createFieldRule({
        fieldApiName: 'Revenue',
        config: { minValue: 1000, maxValue: 50000 },
      })];
      const prompt = buildPrompt(rules, 3);

      expect(prompt).toContain('1000');
      expect(prompt).toContain('50000');
    });

    it('should include length constraints when present', () => {
      const rules = [createFieldRule({
        fieldApiName: 'Code',
        config: { minLength: 3, maxLength: 10 },
      })];
      const prompt = buildPrompt(rules, 2);

      expect(prompt).toContain('3');
      expect(prompt).toContain('10');
    });

    it('should include persona when provided', () => {
      const prompt = buildPrompt([createFieldRule()], 5, 'Tech startup');
      expect(prompt).toContain('Persona: Tech startup');
    });

    it('should request JSON array output format', () => {
      const prompt = buildPrompt([createFieldRule()], 1);
      expect(prompt).toContain('JSON array');
    });
  });

  describe('parseAIResponse', () => {
    it('should parse a valid JSON array', () => {
      const result = parseAIResponse('[{"name": "Alice"}, {"name": "Bob"}]');
      expect(result).toHaveLength(2);
    });

    it('should handle markdown code blocks', () => {
      const response = '```json\n[{"name": "Alice"}]\n```';
      const result = parseAIResponse(response);
      expect(result).toHaveLength(1);
    });

    it('should handle a single JSON object', () => {
      const result = parseAIResponse('{"name": "Solo"}');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ name: 'Solo' });
    });

    it('should filter out non-object items in array', () => {
      const result = parseAIResponse('[{"name": "Alice"}, 42, "string", null]');
      expect(result).toHaveLength(1);
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseAIResponse('not json')).toThrow();
    });
  });
});
