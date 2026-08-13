import { describe, it, expect } from 'vitest';
import {
  BUILTIN_FORGE_TEMPLATES,
  BUILTIN_TEMPLATE_OBJECTS,
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
});
