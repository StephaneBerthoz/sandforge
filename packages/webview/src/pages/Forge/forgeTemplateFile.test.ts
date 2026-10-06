import { describe, it, expect } from 'vitest';
import type { ForgeTemplate } from '@sandforge/shared';
import {
  TEMPLATE_FILE_MAX_BYTES,
  readTemplateFile,
  templateFileContent,
  templateFileName,
} from './forgeTemplateFile';

const TEMPLATE: ForgeTemplate = {
  id: 'tpl-1',
  name: 'Comptes clôturés — QA',
  description: '',
  config: {
    inputMode: 'record',
    recordId: '001000000000001AAA',
    depth: 'direct',
    anonymizePII: true,
    skipEmpty: false,
    batchSize: 'auto',
    excludedObjects: ['Task'],
    picklistValueMappings: [{ object: 'Case', field: 'Reason__c', from: 'Other', to: null }],
  },
  targetOrgId: 'org-target',
  anonymization: {
    rules: { email: 'hash' },
    fields: [{ objectApiName: 'Contact', fieldNames: [] }],
  },
  files: { maxFileSizeMB: 15 },
  objectCount: 4,
  recordCount: 80,
  createdAt: '2026-10-01T08:00:00.000Z',
  lastUsedAt: '2026-10-01T08:00:00.000Z',
};

describe('templateFileName', () => {
  it('offers the file under the template’s name, made safe for a path', () => {
    expect(templateFileName(TEMPLATE)).toBe('forge-template-comptes-clotures-qa.json');
    expect(templateFileName({ ...TEMPLATE, name: '***' })).toBe('forge-template-tpl-1.json');
  });
});

describe('readTemplateFile', () => {
  it('reads back the file a template was exported to, as it was', () => {
    const reading = readTemplateFile(templateFileContent(TEMPLATE));

    expect(reading).toEqual({ ok: true, template: TEMPLATE });
  });

  it('reads a file saved with a byte order mark', () => {
    expect(readTemplateFile(`\uFEFF${templateFileContent(TEMPLATE)}`).ok).toBe(true);
  });

  it('refuses a file that is not JSON', () => {
    expect(readTemplateFile('id: tpl-1')).toEqual({ ok: false, reason: 'not_json' });
  });

  it('refuses a template the schema refuses, naming the part it refused', () => {
    const forged = { ...TEMPLATE, config: { ...TEMPLATE.config, excludedObjects: ['Task; DROP'] } };

    expect(readTemplateFile(JSON.stringify(forged))).toEqual({
      ok: false,
      reason: 'not_template',
      where: 'config.excludedObjects.0',
    });
    expect(readTemplateFile('[]')).toEqual({ ok: false, reason: 'not_template', where: '' });
  });

  it('refuses a file larger than any template', () => {
    expect(readTemplateFile(' '.repeat(TEMPLATE_FILE_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
});
