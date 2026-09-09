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

  it('should not offer an "Add relation" button', () => {
    renderStep();
    // The button appended an empty row nobody could fill in: the relation
    // editor is never mounted and handleExecute drops relations anyway.
    expect(screen.queryByTestId('add-relation-btn')).toBeNull();
  });

  it('should say relation configuration is not wired yet', () => {
    renderStep();
    expect(screen.getByTestId('seed-relations-soon')).toBeDefined();
    expect(screen.getByText('Coming soon')).toBeDefined();
  });

  it('should never render a blank relation row, even for a relation left in the store', () => {
    useSeedWizardStore.setState({
      relations: [{ childObject: '', childField: '', parentObject: '', parentField: 'Id' }],
    });
    renderStep();
    expect(screen.queryByTestId('remove-relation-0')).toBeNull();
  });
});
