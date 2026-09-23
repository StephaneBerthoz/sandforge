import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { ConfigEntry } from '../../core/storage/ConfigStoreBackend.js';
import { AnonymizationTemplateStore } from './AnonymizationTemplateStore.js';
import type { SavedAnonymizationTemplate } from './AnonymizationTemplateStore.js';

/** A ConfigStore over a backend that keeps what it is given, as globalState would. */
function memoryConfigStore(): { store: ConfigStore; persisted: () => Record<string, ConfigEntry> } {
  let data: Record<string, ConfigEntry> = {};
  const store = new ConfigStore({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
  });
  store.initialize();
  return { store, persisted: () => data };
}

function template(
  id: string,
  overrides: Partial<SavedAnonymizationTemplate> = {},
): SavedAnonymizationTemplate {
  return {
    id,
    name: `Template ${id}`,
    description: '',
    complianceFramework: 'custom',
    rules: [{ fieldPattern: 'Contact.Email', ruleType: 'fake', description: '' }],
    saved: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('AnonymizationTemplateStore', () => {
  let configStore: ConfigStore;
  let persisted: () => Record<string, ConfigEntry>;
  let templates: AnonymizationTemplateStore;

  beforeEach(() => {
    ({ store: configStore, persisted } = memoryConfigStore());
    templates = new AnonymizationTemplateStore(configStore);
  });

  it('keeps a saved template under its own key and category, where the config store persists it', () => {
    templates.save(template('tpl-saved-1'));

    expect(persisted()['anonymization:template:tpl-saved-1']?.category).toBe(
      'anonymizationTemplates',
    );
    expect(templates.load('tpl-saved-1')).toEqual(template('tpl-saved-1'));
  });

  it('lists the saved templates in the order they were saved', () => {
    templates.save(template('b', { createdAt: '2026-09-02T00:00:00.000Z' }));
    templates.save(template('a', { createdAt: '2026-09-01T00:00:00.000Z' }));

    expect(templates.list().map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('deletes a saved template, and says whether there was one', () => {
    templates.save(template('tpl-saved-1'));

    expect(templates.delete('tpl-saved-1')).toBe(true);
    expect(templates.load('tpl-saved-1')).toBeUndefined();
    expect(templates.list()).toEqual([]);
    expect(templates.delete('tpl-saved-1')).toBe(false);
  });

  it('leaves out an entry that does not read as a saved template', () => {
    // A hash rule could never run from DataOps: it needs a salt nothing sets.
    configStore.set(
      'anonymization:template:bad',
      template('bad', {
        rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash' as 'fake', description: '' }],
      }),
      'anonymizationTemplates',
    );
    configStore.set('anonymization:template:junk', { id: 'junk' }, 'anonymizationTemplates');
    templates.save(template('good'));

    expect(templates.list().map((t) => t.id)).toEqual(['good']);
    expect(templates.load('bad')).toBeUndefined();
    expect(templates.load('junk')).toBeUndefined();
  });

  it('reads nothing of the other categories', () => {
    configStore.set('sync:config:cfg-1', { id: 'cfg-1' }, 'syncConfigs');

    expect(templates.list()).toEqual([]);
  });
});
