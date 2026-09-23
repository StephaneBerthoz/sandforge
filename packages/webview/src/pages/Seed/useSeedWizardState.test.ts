import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { useSeedWizardState } from './useSeedWizardState';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockMutate = vi.fn();

/** The describe and execute mutations, which the tests below drive. */
const seedBridge = vi.hoisted(() => ({
  describe: vi.fn(),
  /* seed:describe-object answer replayed by the field rules' mapping effect */
  described: null as unknown,
  execute: vi.fn(),
  running: false,
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'seed:describe-object') {
      return {
        mutate: seedBridge.describe,
        data: seedBridge.described,
        loading: false,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    }
    if (type === 'seed:execute') {
      return {
        mutate: seedBridge.execute,
        data: null,
        loading: seedBridge.running,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    }
    return {
      mutate: mockMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  },
}));

/** The describe of an object whose only field is its name. */
function describeOf(objectApiName: string): Record<string, unknown> {
  return {
    objectApiName,
    objectLabel: objectApiName,
    fields: [
      {
        fieldApiName: 'Name',
        label: 'Name',
        type: 'string',
        required: true,
        picklistValues: [],
        referenceTo: [],
        length: 80,
      },
    ],
  };
}

vi.mock('../../hooks/useAIFeatures', () => ({
  useNL2SOQL: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
  }),
}));

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: () => vi.fn(),
}));

const mockT: TFunction = ((key: string) => key) as unknown as TFunction;

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

describe('useSeedWizardState', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    mockMutate.mockClear();
    seedBridge.describe.mockClear();
    seedBridge.described = null;
    seedBridge.execute.mockClear();
    seedBridge.running = false;
  });

  describe('a run below five objects, which skips the configure step', () => {
    const THREE = ['Account', 'Contact', 'Case'];

    /** The wizard on org-1 with `THREE` picked, moved on to the execute step. */
    function onExecuteStep() {
      const view = renderHook(() => useSeedWizardState(mockT));
      act(() => {
        view.result.current.handleOrgSelect('org-1');
        for (const name of THREE) view.result.current.handleToggleObject(name);
      });
      act(() => {
        view.result.current.setCurrentStep(2);
      });
      return view;
    }

    it('asks for the fields of every selected object on the execute step', () => {
      onExecuteStep();

      const asked = seedBridge.describe.mock.calls.map(
        (call) => (call[0] as { objectApiName: string }).objectApiName,
      );
      expect([...new Set(asked)]).toEqual(THREE);
    });

    it('holds the run until every selected object is described', () => {
      const { result, rerender } = onExecuteStep();
      expect(result.current.canGoNext).toBe(false);

      for (const name of THREE.slice(0, 2)) {
        seedBridge.described = describeOf(name);
        rerender();
      }
      expect(result.current.canGoNext).toBe(false);

      seedBridge.described = describeOf('Case');
      rerender();
      expect(result.current.fieldsReady).toBe(true);
      expect(result.current.canGoNext).toBe(true);

      act(() => {
        result.current.setCurrentStep(3);
      });
      expect(result.current.canGoNext).toBe(true);
    });

    it('holds the button of the last step while the run it sent is in flight', () => {
      // It stayed live: a second press sent the whole template again.
      const { result, rerender } = onExecuteStep();
      for (const name of THREE) {
        seedBridge.described = describeOf(name);
        rerender();
      }
      act(() => {
        result.current.setCurrentStep(3);
      });

      seedBridge.running = true;
      rerender();

      expect(result.current.canGoNext).toBe(false);
    });
  });

  it('should initialize with step 0 and empty selections', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    expect(result.current.currentStep).toBe(0);
    expect(result.current.selectedOrgId).toBe('');
    expect(result.current.selectedObjects).toEqual([]);
    expect(result.current.canGoNext).toBe(false);
  });

  it('should update selectedOrgId when handleOrgSelect is called', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleOrgSelect('org-1');
    });

    expect(result.current.selectedOrgId).toBe('org-1');
  });

  it('should toggle objects in selectedObjects', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleToggleObject('Account');
    });
    expect(result.current.selectedObjects).toEqual(['Account']);

    act(() => {
      result.current.handleToggleObject('Contact');
    });
    expect(result.current.selectedObjects).toEqual(['Account', 'Contact']);

    act(() => {
      result.current.handleToggleObject('Account');
    });
    expect(result.current.selectedObjects).toEqual(['Contact']);
  });

  it('should require org and objects to enable next on step 0', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    expect(result.current.canGoNext).toBe(false);

    act(() => {
      result.current.handleOrgSelect('org-1');
    });
    expect(result.current.canGoNext).toBe(false);

    act(() => {
      result.current.handleToggleObject('Account');
    });
    expect(result.current.canGoNext).toBe(true);
  });

  it('should update volumes when handleChangeVolume is called', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleChangeVolume('Account', 500);
    });

    expect(result.current.volumes['Account']?.count).toBe(500);
    expect(result.current.volumes['Account']?.batchSize).toBe(200);
  });

  it('should update batch size when handleChangeBatchSize is called', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleChangeBatchSize('Account', 500);
    });

    expect(result.current.volumes['Account']?.batchSize).toBe(500);
  });

  it('adds no relation while no selected object has a lookup to fill', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleAddRelation();
    });
    expect(result.current.relations).toEqual([]);
  });

  it('holds the wizard while a relation row cannot be sent, and lets it go once removed', () => {
    // A row with a problem is left out of the payload: moving on would seed
    // its child with parents drawn at random, or none.
    const { result } = renderHook(() => useSeedWizardState(mockT));
    act(() => {
      result.current.setCurrentStep(1);
      useSeedWizardStore.setState({
        relations: [
          {
            key: 'r1',
            childObject: 'Contact',
            lookupField: 'AccountId',
            parentObject: 'Account',
            source: 'generated',
            where: '',
            limit: 10,
            mode: 'perParent',
            count: 3,
            min: 1,
            max: 3,
            ratio: 0.5,
          },
        ],
      });
    });

    expect(result.current.checked[0].problem).toBe('incomplete');
    expect(result.current.canGoNext).toBe(false);

    act(() => {
      result.current.handleRemoveRelation(0);
    });
    expect(result.current.canGoNext).toBe(true);
  });

  it('should update step via setCurrentStep', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.setCurrentStep(2);
    });
    expect(result.current.currentStep).toBe(2);
  });

  it('should manage error state', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.setError('Something went wrong');
    });
    expect(result.current.error).toBe('Something went wrong');

    act(() => {
      result.current.setError(null);
    });
    expect(result.current.error).toBeNull();
  });

  it('should not be finished on step 3 without execution result', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.setCurrentStep(3);
    });
    expect(result.current.isFinished).toBe(false);
  });

  it('should initialize with no selected persona', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));
    expect(result.current.selectedPersona).toBeNull();
  });

  it('should set selected persona via setSelectedPersona', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    const persona = {
      id: 'test-persona',
      name: 'Test',
      description: 'Test persona',
      industry: 'tech',
      locale: 'en_US',
      dataPatterns: {},
    };

    act(() => {
      result.current.setSelectedPersona(persona);
    });

    expect(result.current.selectedPersona).toEqual(persona);
  });

  it('should expose applySelectedPersona that returns 0 when no persona set', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    let count = 0;
    act(() => {
      count = result.current.applySelectedPersona();
    });

    expect(count).toBe(0);
  });
});
