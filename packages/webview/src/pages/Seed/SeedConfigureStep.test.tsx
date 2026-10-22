import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedConfigureStep } from './SeedConfigureStep';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

/** The object lists the field rules were drawn with, one a draw. */
const drawnWith = vi.hoisted(() => [] as unknown[]);
vi.mock('./Step3_ConfigureFields', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Step3_ConfigureFields')>();
  return {
    ...actual,
    Step3ConfigureFields: (props: React.ComponentProps<typeof actual.Step3ConfigureFields>) => {
      drawnWith.push(props.objectConfigs);
      return <actual.Step3ConfigureFields {...props} />;
    },
  };
});

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

  it('hands the field rules the same object list while the fields and the choices stay the same', () => {
    // Mapped anew at every draw, a batch size typed handed every object and
    // field row a new list, and each was drawn again.
    const props = {
      fieldConfigs,
      onChangeRule: vi.fn(),
      onChangeConfig: vi.fn(),
      onChangeBatchSize: vi.fn(),
    };
    const { rerender } = render(
      <SeedConfigureStep {...props} volumes={{ Account: { count: 100, batchSize: 200 } }} />,
    );
    drawnWith.length = 0;

    rerender(<SeedConfigureStep {...props} volumes={{ Account: { count: 100, batchSize: 50 } }} />);

    expect(drawnWith).toHaveLength(1);
    expect(drawnWith[0]).toEqual([fieldConfigs[0]]);
    rerender(<SeedConfigureStep {...props} volumes={{ Account: { count: 100, batchSize: 75 } }} />);
    expect(drawnWith[1]).toBe(drawnWith[0]);
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

  describe("an account's fields, by the kind of account its record types write", () => {
    const field = (fieldApiName: string, required = false) => ({
      fieldApiName,
      label: fieldApiName,
      type: 'string',
      required,
      ruleType: 'faker' as const,
      config: {},
    });
    /** An Account of an org with person accounts, as its describe lists it. */
    const account: ObjectFieldConfig = {
      objectApiName: 'Account',
      objectLabel: 'Account',
      fields: ['Name', 'Phone', 'FirstName', 'LastName', 'PersonEmail', 'Region__pc'].map((f) =>
        field(f),
      ),
      recordTypes: [
        {
          recordTypeId: '012000000000001AAA',
          developerName: 'PersonAccount',
          label: 'Person Account',
          person: true,
          isDefault: false,
        },
        {
          recordTypeId: '012000000000002AAA',
          developerName: 'Business',
          label: 'Business',
          person: false,
          isDefault: true,
        },
      ],
    };
    const renderAccount = () =>
      render(
        <SeedConfigureStep
          fieldConfigs={[account]}
          onChangeRule={vi.fn()}
          onChangeConfig={vi.fn()}
          volumes={{ Account: { count: 10, batchSize: 200 } }}
          onChangeBatchSize={vi.fn()}
        />,
      );
    const listed = (): string[] =>
      within(screen.getByTestId('step-configure-fields'))
        .queryAllByTestId(/^field-Account-/)
        .map((row) => row.getAttribute('data-testid')!.replace('field-Account-', ''));
    const required = (name: string): boolean =>
      within(screen.getByTestId(`field-Account-${name}`)).queryByText('*') !== null;

    it('lists a person account without Name, its first and last names among its fields, the last name required', () => {
      renderAccount();
      fireEvent.click(screen.getByTestId('seed-record-type-Account-PersonAccount'));

      // The extension drops Name before the run: a rule set on it here went nowhere.
      expect(listed()).toEqual(['Phone', 'FirstName', 'LastName', 'PersonEmail', 'Region__pc']);
      expect(required('LastName')).toBe(true);
    });

    it("lists a business account without a person account's fields, Name required", () => {
      renderAccount();
      fireEvent.click(screen.getByTestId('seed-record-type-Account-Business'));

      expect(listed()).toEqual(['Name', 'Phone']);
      expect(required('Name')).toBe(true);
    });

    it('lists a business account so with no record type chosen, as the run writes one', () => {
      renderAccount();

      expect(listed()).toEqual(['Name', 'Phone']);
    });

    it('lists every field while the two kinds are mixed, which the run refuses', () => {
      renderAccount();
      fireEvent.click(screen.getByTestId('seed-record-type-Account-PersonAccount'));
      fireEvent.click(screen.getByTestId('seed-record-type-Account-Business'));

      expect(screen.getByTestId('seed-record-types-mixed-Account')).toBeDefined();
      expect(listed()).toEqual([
        'Name',
        'Phone',
        'FirstName',
        'LastName',
        'PersonEmail',
        'Region__pc',
      ]);
    });
  });
});
