import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineMarketplace } from './PipelineMarketplace';
import type { PipelineTemplate } from './PipelineMarketplace';

describe('PipelineMarketplace', () => {
  let marketplace: PipelineMarketplace;

  beforeEach(() => {
    marketplace = new PipelineMarketplace();
  });

  describe('getTemplates', () => {
    it('should return all 15 built-in templates', () => {
      const templates = marketplace.getTemplates();
      expect(templates).toHaveLength(15);
    });

    it('should return templates with required properties', () => {
      const templates = marketplace.getTemplates();
      for (const template of templates) {
        expect(template.id).toBeDefined();
        expect(template.name).toBeTruthy();
        expect(template.description).toBeTruthy();
        expect(template.category).toBeTruthy();
        expect(typeof template.rating).toBe('number');
        expect(template.steps.length).toBeGreaterThan(0);
        expect(Array.isArray(template.tags)).toBe(true);
      }
    });

    it('should return templates with unique IDs', () => {
      const templates = marketplace.getTemplates();
      const ids = new Set(templates.map((t) => t.id));
      expect(ids.size).toBe(15);
    });
  });

  describe('getByCategory', () => {
    it('should return templates for the environment category', () => {
      const templates = marketplace.getByCategory('environment');
      expect(templates.length).toBeGreaterThan(0);
      for (const template of templates) {
        expect(template.category).toBe('environment');
      }
    });

    it('should return templates for the migration category', () => {
      const templates = marketplace.getByCategory('migration');
      expect(templates.length).toBeGreaterThan(0);
      for (const template of templates) {
        expect(template.category).toBe('migration');
      }
    });

    it('should return templates for the maintenance category', () => {
      const templates = marketplace.getByCategory('maintenance');
      expect(templates.length).toBeGreaterThan(0);
      for (const template of templates) {
        expect(template.category).toBe('maintenance');
      }
    });

    it('should return templates for the compliance category', () => {
      const templates = marketplace.getByCategory('compliance');
      expect(templates.length).toBeGreaterThan(0);
    });

    it('should return templates for the monitoring category', () => {
      const templates = marketplace.getByCategory('monitoring');
      expect(templates.length).toBeGreaterThan(0);
    });

    it('should return empty array for unknown category', () => {
      const templates = marketplace.getByCategory('unknown');
      expect(templates).toEqual([]);
    });
  });

  describe('getById', () => {
    it('should return a template by its ID', () => {
      const template = marketplace.getById('tpl-sandbox-refresh');
      expect(template).toBeDefined();
      expect(template!.name).toBe('Sandbox Refresh Post-Processing');
    });

    it('should return undefined for unknown ID', () => {
      expect(marketplace.getById('non-existent')).toBeUndefined();
    });
  });

  describe('importTemplate', () => {
    it('should import a valid template JSON', () => {
      const json = JSON.stringify({
        name: 'Custom Template',
        description: 'A custom pipeline template',
        category: 'environment',
        rating: 4.0,
        steps: [{ name: 'Step 1', type: 'seed', config: {}, description: 'First step' }],
        tags: ['custom'],
      });

      const template = marketplace.importTemplate(json);

      expect(template.id).toBeDefined();
      expect(template.name).toBe('Custom Template');
      expect(template.category).toBe('environment');
      expect(template.steps).toHaveLength(1);
    });

    it('should assign a new unique ID to the imported template', () => {
      const json = JSON.stringify({
        id: 'original-id',
        name: 'Custom Template',
        description: 'Desc',
        category: 'maintenance',
        steps: [{ name: 'S1', type: 'backup', config: {}, description: 'backup' }],
      });

      const template = marketplace.importTemplate(json);
      expect(template.id).not.toBe('original-id');
    });

    it('should make the imported template retrievable', () => {
      const json = JSON.stringify({
        name: 'Importable',
        description: 'Imported template',
        category: 'migration',
        steps: [{ name: 'S1', type: 'sync', config: {}, description: 'sync' }],
      });

      const imported = marketplace.importTemplate(json);
      const retrieved = marketplace.getById(imported.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Importable');
    });

    it('should throw on invalid JSON', () => {
      expect(() => marketplace.importTemplate('not json')).toThrow('Invalid JSON format');
    });

    it('should throw if name is missing', () => {
      const json = JSON.stringify({ description: 'No name', category: 'maintenance', steps: [{}] });
      expect(() => marketplace.importTemplate(json)).toThrow('name');
    });

    it('should throw if category is invalid', () => {
      const json = JSON.stringify({
        name: 'Test',
        description: 'Desc',
        category: 'invalid-category',
        steps: [{ name: 'S1', type: 'seed', config: {}, description: 'step' }],
      });
      expect(() => marketplace.importTemplate(json)).toThrow('category');
    });

    it('should throw if steps array is empty', () => {
      const json = JSON.stringify({
        name: 'Test',
        description: 'Desc',
        category: 'maintenance',
        steps: [],
      });
      expect(() => marketplace.importTemplate(json)).toThrow('at least one step');
    });

    it('should throw if input is not an object', () => {
      expect(() => marketplace.importTemplate('"just a string"')).toThrow('JSON object');
    });

    it('should default rating to 0 when not provided', () => {
      const json = JSON.stringify({
        name: 'No Rating',
        description: 'Desc',
        category: 'maintenance',
        steps: [{ name: 'S1', type: 'backup', config: {}, description: 'step' }],
      });

      const template = marketplace.importTemplate(json);
      expect(template.rating).toBe(0);
    });
  });

  describe('exportTemplate', () => {
    it('should export a template as valid JSON', () => {
      const json = marketplace.exportTemplate('tpl-sandbox-refresh');
      const parsed = JSON.parse(json) as PipelineTemplate;

      expect(parsed.id).toBe('tpl-sandbox-refresh');
      expect(parsed.name).toBe('Sandbox Refresh Post-Processing');
    });

    it('should throw for unknown template ID', () => {
      expect(() => marketplace.exportTemplate('non-existent')).toThrow('Template not found');
    });

    it('should produce JSON that can be re-imported', () => {
      const exported = marketplace.exportTemplate('tpl-nightly-backup');
      const reimported = marketplace.importTemplate(exported);

      expect(reimported.name).toBe('Nightly Data Backup');
      expect(reimported.id).not.toBe('tpl-nightly-backup');
    });
  });

  describe('search', () => {
    it('should find templates by name', () => {
      const results = marketplace.search('Sandbox Refresh');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((t) => t.id === 'tpl-sandbox-refresh')).toBe(true);
    });

    it('should find templates by description content', () => {
      const results = marketplace.search('governor limits');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should find templates by tag', () => {
      const results = marketplace.search('gdpr');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((t) => t.id === 'tpl-gdpr-compliance')).toBe(true);
    });

    it('should be case-insensitive', () => {
      const upper = marketplace.search('BACKUP');
      const lower = marketplace.search('backup');
      expect(upper.length).toBe(lower.length);
    });

    it('should return empty array for no matches', () => {
      const results = marketplace.search('xyznonexistent');
      expect(results).toEqual([]);
    });

    it('should match partial terms', () => {
      const results = marketplace.search('anon');
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
