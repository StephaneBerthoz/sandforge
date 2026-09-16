import { describe, it, expect } from 'vitest';
import {
  BUILTIN_FORGE_TEMPLATES,
  BUILTIN_TEMPLATE_OBJECTS,
  buildSyntheticForgeGraph,
  getBuiltinTemplateObjects,
  isBuiltinForgeTemplate,
} from './forge-builtin-templates';

/**
 * Objects whose payload is a base64 blob. Forge queries every queryable field
 * of a node and routes >200 records through Bulk API 2.0, which rejects
 * base64 — so a starter template listing one of these promises a transfer the
 * engine silently drops.
 */
const BLOB_OBJECTS = ['Attachment', 'ContentVersion', 'Document'];

describe('builtin forge templates', () => {
  it('lists an object set for every shipped template', () => {
    for (const template of BUILTIN_FORGE_TEMPLATES) {
      expect(isBuiltinForgeTemplate(template.id)).toBe(true);
      expect(getBuiltinTemplateObjects(template.id).length).toBeGreaterThan(0);
    }
  });

  it('never promises a blob object while Forge has no file-transfer stage', () => {
    const offenders: string[] = [];
    for (const [id, objects] of Object.entries(BUILTIN_TEMPLATE_OBJECTS)) {
      for (const object of objects) {
        if (BLOB_OBJECTS.includes(object)) offenders.push(`${id} -> ${object}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps Case Workflow on the transferable objects only', () => {
    expect(BUILTIN_TEMPLATE_OBJECTS['builtin:case-workflow']).toEqual([
      'Account',
      'Contact',
      'Case',
      'EmailMessage',
      'CaseComment',
    ]);
  });

  it('returns an empty list for an unknown template id', () => {
    expect(getBuiltinTemplateObjects('builtin:nope')).toEqual([]);
  });

  it('does not mistake a saved template for a builtin one', () => {
    // A user template is stored under a generated id; treating it as a
    // builtin would skip discovery and forge an empty synthetic graph.
    expect(isBuiltinForgeTemplate('a1b2c3d4-user-template')).toBe(false);
    expect(isBuiltinForgeTemplate('my-builtin:copy')).toBe(false);
  });
});

describe('synthetic forge graph for a starter template', () => {
  it('lays the objects out one per level, in the order given', () => {
    const graph = buildSyntheticForgeGraph(['Account', 'Contact', 'Case']);

    expect(graph.nodes.map((n) => n.objectApiName)).toEqual(['Account', 'Contact', 'Case']);
    expect(graph.nodes.map((n) => n.level)).toEqual([0, 1, 2]);
  });

  it('starts every node idle, included and empty, awaiting the real counts', () => {
    const [node] = buildSyntheticForgeGraph(['Account']).nodes;

    expect(node).toEqual({
      objectApiName: 'Account',
      recordCount: 0,
      fieldCount: 0,
      status: 'idle',
      progress: 0,
      // Included, so the user deselects in Review instead of hunting for a
      // hidden object to add back.
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto',
    });
  });

  it('draws no edges and promises no volume before the executor has queried', () => {
    const graph = buildSyntheticForgeGraph(['Account', 'Contact']);

    expect(graph.edges).toEqual([]);
    expect(graph.totalRecords).toBe(0);
    expect(graph.estimatedSizeMB).toBe(0);
    expect(graph.estimatedDurationSeconds).toBe(0);
  });

  it('builds an empty graph for an empty object list', () => {
    const graph = buildSyntheticForgeGraph([]);

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('builds a graph for every shipped template', () => {
    for (const template of BUILTIN_FORGE_TEMPLATES) {
      const objects = getBuiltinTemplateObjects(template.id);
      expect(buildSyntheticForgeGraph(objects).nodes).toHaveLength(objects.length);
    }
  });
});
