import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import i18n from '../../../i18n';
import fr from '../../../i18n/locales/fr.json';
import { CloneResultsPanel } from './CloneResultsPanel';
import type { CloneExecutionResult } from '@sandforge/shared';

const mockSuccessResult: CloneExecutionResult = {
  status: 'success',
  totalSourceRecords: 200,
  totalInserted: 200,
  totalFailed: 0,
  durationMs: 12500,
  objectResults: [
    {
      objectApiName: 'Account',
      sourceCount: 50,
      insertedCount: 50,
      failedCount: 0,
      idMappings: [
        { sourceId: '001xx001', targetId: '001yy001' },
        { sourceId: '001xx002', targetId: '001yy002' },
      ],
      errors: [],
    },
    {
      objectApiName: 'Contact',
      sourceCount: 150,
      insertedCount: 150,
      failedCount: 0,
      idMappings: [{ sourceId: '003xx001', targetId: '003yy001' }],
      errors: [],
    },
  ],
};

const mockPartialResult: CloneExecutionResult = {
  status: 'partial',
  totalSourceRecords: 100,
  totalInserted: 80,
  totalFailed: 20,
  durationMs: 8000,
  objectResults: [
    {
      objectApiName: 'Account',
      sourceCount: 50,
      insertedCount: 50,
      failedCount: 0,
      idMappings: [{ sourceId: '001xx001', targetId: '001yy001' }],
      errors: [],
    },
    {
      objectApiName: 'Contact',
      sourceCount: 50,
      insertedCount: 30,
      failedCount: 20,
      idMappings: [{ sourceId: '003xx001', targetId: '003yy001' }],
      errors: [
        { sourceId: '003xx002', message: 'REQUIRED_FIELD_MISSING: LastName' },
        { sourceId: '003xx003', message: 'DUPLICATE_VALUE: Email' },
      ],
    },
  ],
};

/** 30 failures on a single object, no mappings, so only the errors table renders. */
const mockManyErrorsResult: CloneExecutionResult = {
  status: 'failure',
  totalSourceRecords: 30,
  totalInserted: 0,
  totalFailed: 30,
  durationMs: 3000,
  objectResults: [
    {
      objectApiName: 'Contact',
      sourceCount: 30,
      insertedCount: 0,
      failedCount: 30,
      idMappings: [],
      errors: Array.from({ length: 30 }, (_, i) => ({
        sourceId: `003xx${String(i).padStart(3, '0')}`,
        message: `REQUIRED_FIELD_MISSING: LastName #${i}`,
      })),
    },
  ],
};

/** Both tables overflow a page, so each needs its own pagination state. */
const mockBothOverflowResult: CloneExecutionResult = {
  status: 'partial',
  totalSourceRecords: 60,
  totalInserted: 30,
  totalFailed: 30,
  durationMs: 4000,
  objectResults: [
    {
      objectApiName: 'Contact',
      sourceCount: 60,
      insertedCount: 30,
      failedCount: 30,
      idMappings: Array.from({ length: 30 }, (_, i) => ({
        sourceId: `003src${String(i).padStart(3, '0')}`,
        targetId: `003tgt${String(i).padStart(3, '0')}`,
      })),
      errors: Array.from({ length: 30 }, (_, i) => ({
        sourceId: `003err${String(i).padStart(3, '0')}`,
        message: `DUPLICATE_VALUE: Email #${i}`,
      })),
    },
  ],
};

describe('CloneResultsPanel', () => {
  it('should render success status with counts', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    expect(screen.getByTestId('clone-results-panel')).toBeDefined();
    expect(screen.getByTestId('clone-results-summary')).toBeDefined();

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('success');

    const counts = screen.getByTestId('clone-results-counts');
    expect(counts.textContent).toContain('200');
  });

  it('should show duration', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('12.5');
  });

  it('should show per-object results in accordion', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    const panel = screen.getByTestId('clone-results-panel');
    expect(panel.textContent).toContain('Account');
    expect(panel.textContent).toContain('Contact');
  });

  it('sets each object apart from its counts with a dash, not two hyphens', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    const panel = screen.getByTestId('clone-results-panel');
    expect(panel.textContent).toContain('Account — 50/50');
    expect(panel.textContent).not.toContain(' -- ');
  });

  it('should show failed count for partial results', () => {
    render(<CloneResultsPanel result={mockPartialResult} onDone={vi.fn()} />);

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('partial');

    const counts = screen.getByTestId('clone-results-counts');
    expect(counts.textContent).toContain('80');
  });

  it('counts the records linked to ones the target already held apart from the inserted ones', () => {
    const result: CloneExecutionResult = {
      ...mockSuccessResult,
      totalInserted: 150,
      totalLinked: 50,
      objectResults: [
        { ...mockSuccessResult.objectResults[0], insertedCount: 0, linkedCount: 50 },
        mockSuccessResult.objectResults[1],
      ],
    };
    render(<CloneResultsPanel result={result} onDone={vi.fn()} />);

    const counts = screen.getByTestId('clone-results-counts');
    expect(counts.textContent).toContain('Inserted: 150');
    expect(screen.getByTestId('clone-results-linked').textContent).toBe('Linked to existing: 50');
  });

  it('shows no linked count for a clone the target held nothing of', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    expect(screen.queryByTestId('clone-results-linked')).toBeNull();
  });

  it('counts apart the records left out because the platform writes them, or what they depend on, itself', () => {
    // A tracked change is never sent — the platform refuses one from a copy —
    // and neither inserted nor failed, it would count nowhere else.
    const result: CloneExecutionResult = {
      ...mockSuccessResult,
      totalSourceRecords: 203,
      totalLeftToThePlatform: 3,
      objectResults: [
        { ...mockSuccessResult.objectResults[0], sourceCount: 53, leftToThePlatform: 3 },
        mockSuccessResult.objectResults[1],
      ],
    };
    render(<CloneResultsPanel result={result} onDone={vi.fn()} />);

    expect(screen.getByTestId('clone-results-left-to-the-platform').textContent).toBe(
      'Left out (the platform writes them, or what they depend on, itself): 3',
    );
  });

  it('shows no such count for a clone that left nothing to the platform', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    expect(screen.queryByTestId('clone-results-left-to-the-platform')).toBeNull();
  });

  it('says how many lookups the second pass filled in', () => {
    const result: CloneExecutionResult = {
      ...mockSuccessResult,
      secondPass: { owed: 3, filled: 3, samples: [] },
    };
    render(<CloneResultsPanel result={result} onDone={vi.fn()} />);

    expect(screen.getByTestId('clone-results-second-pass').textContent).toBe(
      'Second pass — lookups filled in once the record they point at was in: 3/3',
    );
  });

  it('says why the second pass could not fill in a lookup', () => {
    const result: CloneExecutionResult = {
      ...mockSuccessResult,
      secondPass: {
        owed: 2,
        filled: 1,
        samples: [
          {
            record: 'Account source=001xx002 target=001yy002 Key_Contact__c=<source 003xx009>',
            messages: [
              "Cycle FK 'Key_Contact__c' could not be resolved — referenced parent (source 003xx009) was not cloned",
            ],
          },
        ],
      },
    };
    render(<CloneResultsPanel result={result} onDone={vi.fn()} />);

    const pass = screen.getByTestId('clone-results-second-pass');
    expect(pass.querySelector('p')?.textContent).toBe(
      'Second pass — lookups filled in once the record they point at was in: 1/2',
    );
    expect(pass.querySelector('li')?.textContent).toBe(
      'Account source=001xx002 target=001yy002 Key_Contact__c=<source 003xx009> — ' +
        "Cycle FK 'Key_Contact__c' could not be resolved — referenced parent (source 003xx009) was not cloned",
    );
  });

  it('names, per object, the fields left out because the target does not have them', () => {
    const result: CloneExecutionResult = {
      ...mockSuccessResult,
      objectResults: [
        { ...mockSuccessResult.objectResults[0], fieldsNotInTarget: ['Legacy__c', 'Region__c'] },
        mockSuccessResult.objectResults[1],
      ],
    };
    render(<CloneResultsPanel result={result} onDone={vi.fn()} />);

    const fields = screen.getByTestId('clone-results-fields-not-in-target');
    expect(fields.querySelector('p')?.textContent).toBe(
      'Left out of every record: the target org does not have these fields.',
    );
    expect([...fields.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Account — Legacy__c, Region__c',
    ]);
  });

  describe('a clone a cancel stopped', () => {
    /** Cancelled once the accounts were in: the contacts were never read. */
    const cancelled: CloneExecutionResult = {
      status: 'partial',
      cancelled: true,
      totalSourceRecords: 16,
      totalInserted: 16,
      totalFailed: 0,
      durationMs: 2100,
      objectResults: [
        { ...mockSuccessResult.objectResults[0], sourceCount: 16, insertedCount: 16 },
      ],
    };

    /** The pass it never ran: three lookups owed, and why they stay empty, as the host words it. */
    const beforeItsSecondPass: CloneExecutionResult = {
      ...cancelled,
      secondPass: {
        owed: 3,
        filled: 0,
        cancelledBefore: true,
        samples: [
          {
            record: 'Account: 3 lookups not sent',
            messages: ['The run was cancelled before they were filled in: they stay empty.'],
          },
        ],
      },
    };

    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('reads as cancelled, not as partially done, and says what it created before it stopped', () => {
      // A cancelled clone showed the badge of one that had run to its end
      // with failures, and nothing said the records it wrote stay in the org.
      render(<CloneResultsPanel result={cancelled} onDone={vi.fn()} />);

      const summary = screen.getByTestId('clone-results-summary');
      expect(summary.textContent).toContain('Cancelled');
      expect(summary.textContent).not.toContain('partial');
      expect(screen.getByTestId('clone-results-cancelled').textContent).toBe(
        'The clone was cancelled before it finished. By then it had created 16 records in the target org; they stay there.',
      );
    });

    it('says so when it was cancelled before it created any record', () => {
      render(
        <CloneResultsPanel
          result={{ ...cancelled, totalInserted: 0, objectResults: [] }}
          onDone={vi.fn()}
        />,
      );

      expect(screen.getByTestId('clone-results-cancelled').textContent).toBe(
        'The clone was cancelled before it created any record in the target org.',
      );
    });

    it('says the lookups it owed stay empty when the cancel came before its second pass', () => {
      render(<CloneResultsPanel result={beforeItsSecondPass} onDone={vi.fn()} />);

      const pass = screen.getByTestId('clone-results-second-pass');
      expect([...pass.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
        'Second pass — lookups filled in once the record they point at was in: 0/3',
        'The clone was cancelled before this pass: the 3 lookups it owed stay empty.',
      ]);
      // The host's sample says the same, in English only: not listed again.
      expect(pass.querySelector('li')).toBeNull();
    });

    it('says it in the language the panel is set to', async () => {
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await i18n.changeLanguage('fr');
      render(<CloneResultsPanel result={beforeItsSecondPass} onDone={vi.fn()} />);

      expect(screen.getByTestId('clone-results-summary').textContent).toContain(
        fr.home.opStatus.cancelled,
      );
      expect(screen.getByTestId('clone-results-cancelled').textContent).toBe(
        fr.seed.clone.results.cancelled_other.replace('{{count}}', '16'),
      );
      expect(screen.getByTestId('clone-results-second-pass').textContent).toContain(
        fr.seed.clone.results.secondPassCancelled_other.replace('{{count}}', '3'),
      );
    });

    it('says nothing of a cancel for a clone that ran to its end', () => {
      render(<CloneResultsPanel result={mockPartialResult} onDone={vi.fn()} />);

      expect(screen.queryByTestId('clone-results-cancelled')).toBeNull();
      expect(screen.getByTestId('clone-results-summary').textContent).not.toContain('Cancelled');
    });
  });

  it('says nothing of a second pass or of missing fields when the clone had neither', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    expect(screen.queryByTestId('clone-results-second-pass')).toBeNull();
    expect(screen.queryByTestId('clone-results-fields-not-in-target')).toBeNull();
  });

  it('should call onDone when clicking Done button', () => {
    const onDone = vi.fn();
    render(<CloneResultsPanel result={mockSuccessResult} onDone={onDone} />);

    fireEvent.click(screen.getByTestId('clone-results-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('should have export mapping button', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    expect(screen.getByTestId('clone-export-mapping')).toBeDefined();
  });

  it('should render errors for failed objects in partial results', () => {
    render(<CloneResultsPanel result={mockPartialResult} onDone={vi.fn()} />);

    const panel = screen.getByTestId('clone-results-panel');
    // The accordion content contains error info for Contact
    expect(panel.textContent).toContain('Contact');
  });

  it('should paginate the errors table instead of rendering every failure', () => {
    render(<CloneResultsPanel result={mockManyErrorsResult} onDone={vi.fn()} />);

    expect(screen.getAllByTestId(/^table-row-/)).toHaveLength(25);
    expect(screen.getByTestId('pagination-summary').textContent).toContain('30');
    expect(screen.getByText('REQUIRED_FIELD_MISSING: LastName #24')).toBeDefined();
    expect(screen.queryByText('REQUIRED_FIELD_MISSING: LastName #25')).toBeNull();
  });

  it('should show the remaining errors on the next page', () => {
    render(<CloneResultsPanel result={mockManyErrorsResult} onDone={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(screen.getAllByTestId(/^table-row-/)).toHaveLength(5);
    expect(screen.getByText('REQUIRED_FIELD_MISSING: LastName #25')).toBeDefined();
    expect(screen.queryByText('REQUIRED_FIELD_MISSING: LastName #24')).toBeNull();
  });

  it('should page the errors table without moving the mappings table', () => {
    render(<CloneResultsPanel result={mockBothOverflowResult} onDone={vi.fn()} />);

    const [mappingsTable, errorsTable] = screen.getAllByTestId('data-table');
    const errorsNext = screen.getAllByRole('button', { name: 'Next page' })[1];
    fireEvent.click(errorsNext);

    expect(within(errorsTable).getByText('DUPLICATE_VALUE: Email #25')).toBeDefined();
    expect(within(mappingsTable).getAllByTestId(/^table-row-/)).toHaveLength(25);
    expect(within(mappingsTable).getByText('003src000')).toBeDefined();
  });
});
