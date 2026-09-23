import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedConfigureStep } from './SeedConfigureStep';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

const fieldConfigs: ObjectFieldConfig[] = [
  {
    objectApiName: 'Account',
    objectLabel: 'Account',
    fields: [
      {
        fieldApiName: 'Name',
        label: 'Name',
        type: 'String',
        required: true,
        ruleType: 'faker',
        config: { fakerMethod: 'company.name' },
      },
    ],
  },
];

/** Render the step with the minimum viable props. */
const renderStep = (): ReturnType<typeof render> =>
  render(
    <SeedConfigureStep
      fieldConfigs={fieldConfigs}
      onChangeRule={vi.fn()}
      onChangeConfig={vi.fn()}
      volumes={{ Account: { count: 100, batchSize: 200 } }}
      onChangeBatchSize={vi.fn()}
      piiLoading={false}
      hasPiiWarnings={false}
      piiResults={[]}
    />,
  );

describe('SeedConfigureStep', () => {
  beforeEach(() => {
    useSeedWizardStore.getState().resetSeedWizard();
    useSeedWizardStore.setState({ selectedObjects: ['Account'] });
  });

  it('should render the configure step content', () => {
    renderStep();
    expect(screen.getByTestId('seed-step-configure-content')).toBeDefined();
    expect(screen.getByTestId('batch-Account')).toBeDefined();
  });

  it('names each batch-size field after its object', () => {
    // One field per selected object under a single "Batch size" heading: the
    // heading names the list, not the twelfth field in it.
    renderStep();
    expect(screen.getByTestId('batch-Account').getAttribute('aria-label')).toContain('Account');
  });

  it('puts the relation editor where relations were announced as coming soon', () => {
    renderStep();
    expect(screen.getByTestId('seed-relations')).toBeDefined();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('shows a relation left in the store as a row that can be removed', () => {
    useSeedWizardStore.setState({
      relations: [
        {
          key: 'r1',
          childObject: 'Account',
          lookupField: 'ParentId',
          parentObject: 'Account',
          source: 'existing',
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
    renderStep();
    expect(screen.getByTestId('remove-relation-0')).toBeDefined();
  });
});
