import { describe, it, expect, beforeEach } from 'vitest';
import type { ForgeTemplate } from '@sandforge/shared';
import {
  IMPORTED_FORGE_TEMPLATES_KEY,
  MAX_WAITING_FOLDERS,
  dropImportedTemplates,
  importedTemplatesFor,
  isTemplateEntry,
  mergeTemplates,
  recordImportedTemplates,
} from './importedForgeTemplates.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';

/** A Forge template, down to what a merge matches and a test reads: its id and name. */
function template(id: string, name = `Recipe ${id}`): ForgeTemplate {
  return { id, name } as ForgeTemplate;
}

/** The templates as `id:name`, which is what these tests compare. */
function named(templates: readonly ForgeTemplate[] | undefined): string[] {
  return (templates ?? []).map((t) => `${t.id}:${t.name}`);
}

describe('isTemplateEntry', () => {
  it('takes an object with an id, whatever else it holds or lacks', () => {
    expect(isTemplateEntry({ id: 'tpl-1' })).toBe(true);
    expect(isTemplateEntry({ id: 'tpl-1', name: 'no config at all' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'tpl-1'],
    ['a list', [{ id: 'tpl-1' }]],
    ['an object with no id', { name: 'no id' }],
    ['an empty id', { id: '' }],
    ['an id that is no string', { id: 7 }],
  ])('refuses %s', (_what, entry) => {
    expect(isTemplateEntry(entry)).toBe(false);
  });
});

describe('mergeTemplates', () => {
  it('adds after the stored templates those whose id they do not hold', () => {
    expect(named(mergeTemplates([template('a')], [template('b')], new Set()))).toEqual([
      'a:Recipe a',
      'b:Recipe b',
    ]);
  });

  it('keeps the stored template on an id both hold, unless the id is replacing', () => {
    const stored = [template('a', 'stored'), template('b', 'stored')];
    const incoming = [template('a', 'incoming'), template('b', 'incoming')];

    expect(named(mergeTemplates(stored, incoming, new Set(['b'])))).toEqual([
      'a:stored',
      'b:incoming',
    ]);
  });

  it('takes the first of two incoming templates of one id', () => {
    const incoming = [template('b', 'first'), template('b', 'second')];

    expect(named(mergeTemplates([], incoming, new Set()))).toEqual(['b:first']);
    expect(named(mergeTemplates([template('b')], incoming, new Set(['b'])))).toEqual(['b:first']);
  });
});

describe('the templates an import leaves for a workspace', () => {
  let configStore: ConfigStore;

  beforeEach(() => {
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  });

  it('waits for the folder it was imported in, and for no other', () => {
    recordImportedTemplates(configStore, '/projects/one', [template('a')], []);

    expect(named(importedTemplatesFor(configStore, '/projects/one')?.templates)).toEqual([
      'a:Recipe a',
    ]);
    expect(importedTemplatesFor(configStore, '/projects/two')).toBeUndefined();
  });

  it('finds a folder named with a trailing separator', () => {
    recordImportedTemplates(configStore, '/projects/one', [template('a')], []);

    expect(importedTemplatesFor(configStore, '/projects/one/')).toBeDefined();
  });

  it('records nothing for an import that brought no template', () => {
    recordImportedTemplates(configStore, '/projects/one', [], []);

    expect(configStore.has(IMPORTED_FORGE_TEMPLATES_KEY)).toBe(false);
  });

  it('adds a second import into a folder to the set the first left, one template per id', () => {
    recordImportedTemplates(configStore, '/projects/one', [template('a'), template('b')], []);
    recordImportedTemplates(
      configStore,
      '/projects/one',
      [template('b', 'second'), template('c')],
      ['b'],
    );

    const waiting = importedTemplatesFor(configStore, '/projects/one');
    expect(named(waiting?.templates)).toEqual(['a:Recipe a', 'b:second', 'c:Recipe c']);
    expect(waiting?.replacing).toEqual(['b']);
    expect(configStore.get<unknown[]>(IMPORTED_FORGE_TEMPLATES_KEY)).toHaveLength(1);
  });

  it(`keeps the sets of the ${MAX_WAITING_FOLDERS} folders imported into last, and drops the one that waited longest`, () => {
    // A folder that is never opened again must not keep its set for ever.
    for (let i = 0; i <= MAX_WAITING_FOLDERS; i++) {
      recordImportedTemplates(configStore, `/projects/p${i}`, [template(`t${i}`)], []);
    }

    expect(importedTemplatesFor(configStore, '/projects/p0')).toBeUndefined();
    expect(importedTemplatesFor(configStore, '/projects/p1')).toBeDefined();
    expect(importedTemplatesFor(configStore, `/projects/p${MAX_WAITING_FOLDERS}`)).toBeDefined();
    expect(configStore.get<unknown[]>(IMPORTED_FORGE_TEMPLATES_KEY)).toHaveLength(
      MAX_WAITING_FOLDERS,
    );
  });

  it('counts a folder imported into again as the newest', () => {
    for (let i = 0; i < MAX_WAITING_FOLDERS; i++) {
      recordImportedTemplates(configStore, `/projects/p${i}`, [template(`t${i}`)], []);
    }
    recordImportedTemplates(configStore, '/projects/p0', [template('again')], []);
    recordImportedTemplates(configStore, '/projects/newcomer', [template('n')], []);

    expect(importedTemplatesFor(configStore, '/projects/p0')).toBeDefined();
    expect(importedTemplatesFor(configStore, '/projects/p1')).toBeUndefined();
  });

  it('drops the set of the folder that merged it, and leaves the others', () => {
    recordImportedTemplates(configStore, '/projects/one', [template('a')], []);
    recordImportedTemplates(configStore, '/projects/two', [template('b')], []);

    dropImportedTemplates(configStore, '/projects/one');

    expect(importedTemplatesFor(configStore, '/projects/one')).toBeUndefined();
    expect(importedTemplatesFor(configStore, '/projects/two')).toBeDefined();

    dropImportedTemplates(configStore, '/projects/two');
    expect(configStore.has(IMPORTED_FORGE_TEMPLATES_KEY)).toBe(false);
  });

  it('reads a stored value that is not a list of sets as no set', () => {
    // A bare list of templates names no folder: no window can tell it is its own.
    configStore.set(IMPORTED_FORGE_TEMPLATES_KEY, [template('a')], 'forge');
    expect(importedTemplatesFor(configStore, '/projects/one')).toBeUndefined();

    configStore.set(IMPORTED_FORGE_TEMPLATES_KEY, 'not a list', 'forge');
    recordImportedTemplates(configStore, '/projects/one', [template('b')], []);
    expect(named(importedTemplatesFor(configStore, '/projects/one')?.templates)).toEqual([
      'b:Recipe b',
    ]);
  });

  it('leaves out of a stored set what is not a template', () => {
    configStore.set(
      IMPORTED_FORGE_TEMPLATES_KEY,
      [
        {
          folder: '/projects/one',
          templates: [null, { name: 'no id' }, template('a')],
          replacing: [],
        },
      ],
      'forge',
    );

    expect(named(importedTemplatesFor(configStore, '/projects/one')?.templates)).toEqual([
      'a:Recipe a',
    ]);
  });
});
