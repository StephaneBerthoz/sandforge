import { describe, it, expect, beforeEach } from 'vitest';
import type { PersonaMsg } from '@sandforge/shared';
import { useSeedWizardStore } from './useSeedWizardStore';

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
    expect(state.personaMatchedFields).toBe(0);
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

  it('should add an empty relation with default parentField Id', () => {
    useSeedWizardStore.getState().handleAddRelation();

    const state = useSeedWizardStore.getState();
    expect(state.relations).toHaveLength(1);
    expect(state.relations[0]).toEqual({
      childObject: '',
      childField: '',
      parentObject: '',
      parentField: 'Id',
    });
  });

  it('should remove a relation by index', () => {
    useSeedWizardStore.getState().handleAddRelation();
    useSeedWizardStore.getState().handleAddRelation();
    useSeedWizardStore.getState().handleChangeRelation(0, 'childObject', 'Contact');
    useSeedWizardStore.getState().handleChangeRelation(1, 'childObject', 'Opportunity');

    useSeedWizardStore.getState().handleRemoveRelation(0);

    const state = useSeedWizardStore.getState();
    expect(state.relations).toHaveLength(1);
    expect(state.relations[0].childObject).toBe('Opportunity');
  });

  it('should update a single field of a relation by index', () => {
    useSeedWizardStore.getState().handleAddRelation();
    useSeedWizardStore.getState().handleAddRelation();

    useSeedWizardStore.getState().handleChangeRelation(1, 'parentField', 'AccountId');

    const state = useSeedWizardStore.getState();
    expect(state.relations[0].parentField).toBe('Id');
    expect(state.relations[1].parentField).toBe('AccountId');
  });

  it('should set and clear the page-level error', () => {
    useSeedWizardStore.getState().setError('Something failed');
    expect(useSeedWizardStore.getState().error).toBe('Something failed');

    useSeedWizardStore.getState().setError(null);
    expect(useSeedWizardStore.getState().error).toBeNull();
  });

  it('should set the selected persona and matched fields count', () => {
    const persona = makeMockPersona('p-1');
    useSeedWizardStore.getState().setSelectedPersona(persona);
    useSeedWizardStore.getState().setPersonaMatchedFields(7);

    const state = useSeedWizardStore.getState();
    expect(state.selectedPersona).toEqual(persona);
    expect(state.personaMatchedFields).toBe(7);

    useSeedWizardStore.getState().setSelectedPersona(null);
    expect(useSeedWizardStore.getState().selectedPersona).toBeNull();
  });

  it('should reset all slices to initial values', () => {
    useSeedWizardStore.getState().handleOrgSelect('org-1');
    useSeedWizardStore.getState().handleToggleObject('Account');
    useSeedWizardStore.getState().handleAddRelation();
    useSeedWizardStore.getState().setError('boom');
    useSeedWizardStore.getState().setSelectedPersona(makeMockPersona('p-1'));
    useSeedWizardStore.getState().setPersonaMatchedFields(3);

    useSeedWizardStore.getState().resetSeedWizard();

    const state = useSeedWizardStore.getState();
    expect(state.selectedOrgId).toBe('');
    expect(state.selectedObjects).toEqual([]);
    expect(state.relations).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.selectedPersona).toBeNull();
    expect(state.personaMatchedFields).toBe(0);
  });
});
