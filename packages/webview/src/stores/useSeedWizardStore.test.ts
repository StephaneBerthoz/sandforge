import { describe, it, expect, beforeEach } from 'vitest';
import type { PersonaMsg } from '@sandforge/shared';
import { useSeedWizardStore } from './useSeedWizardStore';
import type { SeedRelationDraft } from './useSeedWizardStore';

/** A relation row filling a lookup of `childObject`, parents from this run. */
function row(key: string, childObject: string, parentObject = 'Account'): SeedRelationDraft {
  return {
    key,
    childObject,
    lookupField: 'AccountId',
    parentObject,
    source: 'generated',
    where: '',
    limit: 10,
    mode: 'perParent',
    count: 3,
    min: 1,
    max: 3,
    ratio: 0.5,
  };
}

/** Create a mock PersonaMsg with sensible defaults. */
function makeMockPersona(id: string): PersonaMsg {
  return {
    id,
    name: `Persona ${id}`,
    description: 'Mock persona',
    industry: 'tech',
    locale: 'en_US',
    dataPatterns: {},
  };
}

describe('useSeedWizardStore', () => {
  beforeEach(() => {
    useSeedWizardStore.getState().resetSeedWizard();
  });

  it('should start with initial state', () => {
    const state = useSeedWizardStore.getState();
    expect(state.selectedOrgId).toBe('');
    expect(state.selectedObjects).toEqual([]);
    expect(state.relations).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.selectedPersona).toBeNull();
  });

  it('should update selected org via handleOrgSelect', () => {
    useSeedWizardStore.getState().handleOrgSelect('org-1');
    expect(useSeedWizardStore.getState().selectedOrgId).toBe('org-1');
  });

  it('should toggle objects in/out of the selection', () => {
    useSeedWizardStore.getState().handleToggleObject('Account');
    useSeedWizardStore.getState().handleToggleObject('Contact');

    expect(useSeedWizardStore.getState().selectedObjects).toEqual(['Account', 'Contact']);

    // Toggling an already-selected object removes it
    useSeedWizardStore.getState().handleToggleObject('Account');
    expect(useSeedWizardStore.getState().selectedObjects).toEqual(['Contact']);
  });

  it('appends the relation row it is given', () => {
    useSeedWizardStore.getState().handleAddRelation(row('r1', 'Contact'));

    expect(useSeedWizardStore.getState().relations).toEqual([row('r1', 'Contact')]);
  });

  it('should remove a relation by index', () => {
    useSeedWizardStore.getState().handleAddRelation(row('r1', 'Contact'));
    useSeedWizardStore.getState().handleAddRelation(row('r2', 'Opportunity'));

    useSeedWizardStore.getState().handleRemoveRelation(0);

    const state = useSeedWizardStore.getState();
    expect(state.relations.map((r) => r.key)).toEqual(['r2']);
  });

  it('changes the settings of one row and keeps its key', () => {
    useSeedWizardStore.getState().handleAddRelation(row('r1', 'Contact'));
    useSeedWizardStore.getState().handleAddRelation(row('r2', 'Opportunity'));

    useSeedWizardStore.getState().handleChangeRelation(1, { mode: 'range', min: 0, max: 4 });

    const [first, second] = useSeedWizardStore.getState().relations;
    expect(first).toEqual(row('r1', 'Contact'));
    expect(second).toEqual({ ...row('r2', 'Opportunity'), mode: 'range', min: 0, max: 4 });
  });

  it('drops the relations on an object taken out of the selection, and those drawing from its records', () => {
    // Nothing is left for them to act on: the child is not seeded, or the
    // parents they were given would never be written.
    const store = useSeedWizardStore.getState();
    for (const name of ['Account', 'Contact', 'Opportunity', 'Case'])
      store.handleToggleObject(name);
    store.handleAddRelation(row('contacts', 'Contact'));
    store.handleAddRelation(row('cases', 'Case', 'Contact'));
    store.handleAddRelation({ ...row('opportunities', 'Opportunity'), source: 'existing' });

    useSeedWizardStore.getState().handleToggleObject('Account');
    useSeedWizardStore.getState().handleToggleObject('Case');

    // Opportunity reads its accounts from the org: taking Account out of the
    // run leaves it whole.
    expect(useSeedWizardStore.getState().relations.map((r) => r.key)).toEqual(['opportunities']);
  });

  it('should set and clear the page-level error', () => {
    useSeedWizardStore.getState().setError('Something failed');
    expect(useSeedWizardStore.getState().error).toBe('Something failed');

    useSeedWizardStore.getState().setError(null);
    expect(useSeedWizardStore.getState().error).toBeNull();
  });

  it('should set the selected persona', () => {
    const persona = makeMockPersona('p-1');
    useSeedWizardStore.getState().setSelectedPersona(persona);

    const state = useSeedWizardStore.getState();
    expect(state.selectedPersona).toEqual(persona);

    useSeedWizardStore.getState().setSelectedPersona(null);
    expect(useSeedWizardStore.getState().selectedPersona).toBeNull();
  });

  it('should reset all slices to initial values', () => {
    useSeedWizardStore.getState().handleOrgSelect('org-1');
    useSeedWizardStore.getState().handleToggleObject('Account');
    useSeedWizardStore.getState().handleAddRelation(row('r1', 'Contact'));
    useSeedWizardStore.getState().setError('boom');
    useSeedWizardStore.getState().setSelectedPersona(makeMockPersona('p-1'));

    useSeedWizardStore.getState().resetSeedWizard();

    const state = useSeedWizardStore.getState();
    expect(state.selectedOrgId).toBe('');
    expect(state.selectedObjects).toEqual([]);
    expect(state.relations).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.selectedPersona).toBeNull();
    expect(state).not.toHaveProperty('personaMatchedFields');
  });
});
