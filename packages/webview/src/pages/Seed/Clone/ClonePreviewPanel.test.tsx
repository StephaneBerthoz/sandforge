import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import en from '../../../i18n/locales/en.json';
import { ClonePreviewPanel } from './ClonePreviewPanel';
import type { ClonePreviewResult } from '@sandforge/shared';

const mockPreview: ClonePreviewResult = {
  insertOrder: ['Account', 'Contact', 'Opportunity'],
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 50,
      sampleRecords: [
        { Id: '001xx001', Name: 'Acme Corp', Industry: 'Technology' },
        { Id: '001xx002', Name: 'Globex', Industry: 'Manufacturing' },
      ],
      relationships: [],
    },
    {
      objectApiName: 'Contact',
      recordCount: 120,
      sampleRecords: [{ Id: '003xx001', FirstName: 'John', LastName: 'Doe' }],
      relationships: [{ field: 'AccountId', referenceTo: 'Account' }],
    },
    {
      objectApiName: 'Opportunity',
      recordCount: 30,
      sampleRecords: [],
      relationships: [{ field: 'AccountId', referenceTo: 'Account' }],
    },
  ],
};

const largeMockPreview: ClonePreviewResult = {
  insertOrder: ['Account'],
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 15000,
      sampleRecords: [],
      relationships: [],
    },
  ],
};

describe('ClonePreviewPanel', () => {
  it('should render insert order list', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-preview-panel')).toBeDefined();
    expect(screen.getByTestId('clone-insert-order')).toBeDefined();

    const orderItems = screen.getByTestId('clone-insert-order');
    expect(orderItems.textContent).toContain('Account');
    expect(orderItems.textContent).toContain('Contact');
    expect(orderItems.textContent).toContain('Opportunity');
  });

  it('should render record counts per object', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    const counts = screen.getByTestId('clone-record-counts');
    expect(counts.textContent).toContain('50');
    expect(counts.textContent).toContain('120');
    expect(counts.textContent).toContain('30');
  });

  it('should show total record count', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    const totalEl = screen.getByTestId('clone-total-records');
    expect(totalEl.textContent).toContain('200');
  });

  it('counts apart the rows the clone leaves to the platform, and not in the total', () => {
    // Forty of forty-four feed items were tracked changes, which the clone
    // never sends: the preview counted them among the records to clone.
    const feed: ClonePreviewResult = {
      insertOrder: ['FeedItem'],
      objects: [
        {
          objectApiName: 'FeedItem',
          recordCount: 4,
          leftToThePlatform: 40,
          sampleRecords: [],
          relationships: [],
        },
      ],
    };
    render(<ClonePreviewPanel previewResult={feed} onExecute={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-preview-left-to-the-platform').textContent).toBe(
      'Not sent (the platform writes them, or what they depend on, itself): 40',
    );
    expect(screen.getByTestId('clone-total-records').textContent).toContain('4 records');
  });

  it('names the lookups a second pass fills in, under the insert order', () => {
    // An account's key contact against a contact's account used to stop the
    // clone on a cycle; the accounts now go in without it, filled in once the
    // contacts are in, as each account's parent is once every account is.
    const cycle: ClonePreviewResult = {
      ...mockPreview,
      insertOrder: ['Account', 'Contact'],
      filledAfterInsert: [
        { objectApiName: 'Account', field: 'ParentId', referenceTo: 'Account' },
        { objectApiName: 'Account', field: 'Key_Contact__c', referenceTo: 'Contact' },
      ],
    };
    render(<ClonePreviewPanel previewResult={cycle} onExecute={vi.fn()} onBack={vi.fn()} />);

    const filled = screen.getByTestId('clone-preview-filled-after');
    expect(filled.textContent).toContain(
      'Written empty, then filled in once the record they point at is in (second pass):',
    );
    expect([...filled.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Account.ParentId → Account',
      'Account.Key_Contact__c → Contact',
    ]);
  });

  it('names the lookups only the source org has, whose values the clone will not write', () => {
    // A key contact deployed to the source alone: the run leaves it out of
    // every record, and its order does not go by it.
    const sourceOnly: ClonePreviewResult = {
      ...mockPreview,
      sourceOnlyLookups: [
        { objectApiName: 'Account', field: 'Key_Contact__c', referenceTo: 'Contact' },
      ],
    };
    render(<ClonePreviewPanel previewResult={sourceOnly} onExecute={vi.fn()} onBack={vi.fn()} />);

    const lookups = screen.getByTestId('clone-preview-source-only');
    expect(lookups.textContent).toContain(
      'Only in the source org — the target org does not have these lookups, so their values will not be written:',
    );
    expect([...lookups.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Account.Key_Contact__c → Contact',
    ]);
  });

  it('names no lookup of the source alone when the two orgs have the same', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByTestId('clone-preview-source-only')).toBeNull();
  });

  it('names, before Execute, the lookups the target requires and the source lacks, whose records the target will refuse', () => {
    // A contact's region, required in the target and never deployed to the
    // source: the target refused every contact after a preview that said
    // nothing of it.
    const required: ClonePreviewResult = {
      ...mockPreview,
      targetOnlyRequiredLookups: [
        { objectApiName: 'Contact', field: 'Region__c', referenceTo: 'Region__c' },
      ],
    };
    render(<ClonePreviewPanel previewResult={required} onExecute={vi.fn()} onBack={vi.fn()} />);

    const warning = screen.getByTestId('clone-preview-target-only-required');
    expect(warning.textContent).toContain(en.seed.clone.preview.targetOnlyRequired);
    expect([...warning.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Contact.Region__c → Region__c',
    ]);
    // Placed before Execute, and read out with it.
    const execute = screen.getByTestId('clone-preview-execute');
    expect(warning.compareDocumentPosition(execute) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(execute.getAttribute('aria-describedby')).toBe(warning.id);
  });

  it('warns of no lookup the target requires when the source has every one', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByTestId('clone-preview-target-only-required')).toBeNull();
    expect(screen.getByTestId('clone-preview-execute').hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  it('names no lookup when the clone leaves none to a second pass', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByTestId('clone-preview-filled-after')).toBeNull();
  });

  it('says nothing left out for a clone that sends every row its filters match', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByTestId('clone-preview-left-to-the-platform')).toBeNull();
  });

  it('should show large clone warning when records exceed threshold', () => {
    render(
      <ClonePreviewPanel previewResult={largeMockPreview} onExecute={vi.fn()} onBack={vi.fn()} />,
    );

    expect(screen.getByTestId('clone-large-warning')).toBeDefined();
  });

  it('should not show large clone warning for small clones', () => {
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={vi.fn()} />);

    expect(screen.queryByTestId('clone-large-warning')).toBeNull();
  });

  it('should call onExecute when clicking Execute button', () => {
    const onExecute = vi.fn();
    render(
      <ClonePreviewPanel previewResult={mockPreview} onExecute={onExecute} onBack={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('clone-preview-execute'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('should call onBack when clicking Back button', () => {
    const onBack = vi.fn();
    render(<ClonePreviewPanel previewResult={mockPreview} onExecute={vi.fn()} onBack={onBack} />);

    fireEvent.click(screen.getByTestId('clone-preview-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
