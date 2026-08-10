import { describe, it, expect } from 'vitest';
import { QuickSyncConfigSchema } from './quickSync.schema.js';

describe('QuickSyncConfigSchema', () => {
  it('accepts a valid config', () => {
    const result = QuickSyncConfigSchema.safeParse({
      sourceOrgId: 'org-src-001',
      targetOrgId: 'org-tgt-002',
      selectedObjects: ['Account', 'Contact'],
      parentObjects: ['User'],
    });
    expect(result.success).toBe(true);
  });

  it('defaults parentObjects to empty array when omitted', () => {
    const result = QuickSyncConfigSchema.safeParse({
      sourceOrgId: 'org-src-001',
      targetOrgId: 'org-tgt-002',
      selectedObjects: ['Account'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentObjects).toEqual([]);
    }
  });

  it('rejects config with empty selectedObjects', () => {
    const result = QuickSyncConfigSchema.safeParse({
      sourceOrgId: 'org-src-001',
      targetOrgId: 'org-tgt-002',
      selectedObjects: [],
      parentObjects: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects config with missing sourceOrgId', () => {
    const result = QuickSyncConfigSchema.safeParse({
      sourceOrgId: '',
      targetOrgId: 'org-tgt-002',
      selectedObjects: ['Account'],
      parentObjects: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects config with missing targetOrgId', () => {
    const result = QuickSyncConfigSchema.safeParse({
      targetOrgId: '',
      sourceOrgId: 'org-src-001',
      selectedObjects: ['Account'],
      parentObjects: [],
    });
    expect(result.success).toBe(false);
  });
});
