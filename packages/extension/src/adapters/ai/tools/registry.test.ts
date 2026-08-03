import { describe, it, expect } from 'vitest';

import { buildAllReadOnlyTools, READ_ONLY_TOOL_NAMES, type ToolDeps } from './readOnlyTools.js';
import { READ_ONLY_NAME_REGEX } from './wrapTool.js';

const fakeDeps: ToolDeps = { orgId: 'org-1' };

describe('AI tool registry — Pitfall #4 read-only fence', () => {
  it('every registered tool name passes the read-only regex', () => {
    const tools = buildAllReadOnlyTools(fakeDeps);
    for (const tool of tools) {
      expect(tool.name).toMatch(READ_ONLY_NAME_REGEX);
    }
  });

  it('exports exactly 10 tools (within the 10-15 surface CONTEXT lock)', () => {
    const tools = buildAllReadOnlyTools(fakeDeps);
    expect(tools.length).toBe(10);
    expect(tools.length).toBeGreaterThanOrEqual(10);
    expect(tools.length).toBeLessThanOrEqual(15);
  });

  it('READ_ONLY_TOOL_NAMES static array matches the names of built tools', () => {
    const tools = buildAllReadOnlyTools(fakeDeps);
    const built = tools.map((t) => t.name).sort();
    const declared = [...READ_ONLY_TOOL_NAMES].sort();
    expect(built).toEqual(declared);
  });

  it('NO tool name contains a write verb (apply / update / delete / deploy / create / insert / merge / upsert / undelete / remove / drop / truncate / set / put / post)', () => {
    const tools = buildAllReadOnlyTools(fakeDeps);
    const writeVerbs =
      /\b(apply|update|delete|deploy|create|insert|merge|upsert|undelete|remove|drop|truncate|set|put|post)\b/i;
    for (const tool of tools) {
      expect(tool.name).not.toMatch(writeVerbs);
    }
  });

  it('every tool description contains the literal substring READ-ONLY', () => {
    const tools = buildAllReadOnlyTools(fakeDeps);
    for (const tool of tools) {
      expect(tool.description).toContain('READ-ONLY');
    }
  });

  it('validate_soql refuses DML keywords (DML_FORBIDDEN)', async () => {
    const tools = buildAllReadOnlyTools({
      orgId: 'org-1',
      validateSoql: async () => ({
        valid: true,
        errors: [],
        warnings: [],
        detectedAntipatterns: [],
      }),
    });
    const validate = tools.find((t) => t.name === 'validate_soql')!;
    const result = JSON.parse(
      await validate.run({ soql: "UPDATE Account SET Name='X' WHERE Id='001'" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DML_FORBIDDEN');
  });

  it('query_records also refuses DML keywords (DML_FORBIDDEN)', async () => {
    const tools = buildAllReadOnlyTools({
      orgId: 'org-1',
      query: async () => ({ totalSize: 0, records: [], done: true }),
    });
    const query = tools.find((t) => t.name === 'query_records')!;
    const result = JSON.parse(
      await query.run({ soql: 'DELETE FROM Account WHERE Id=null', limit: 50 }),
    );
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DML_FORBIDDEN');
  });
});
