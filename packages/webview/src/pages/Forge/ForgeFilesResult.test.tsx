import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgeFilesReport } from '@sandforge/shared';
import '../../i18n';
import { ForgeFilesResult } from './ForgeFilesResult';

const MB = 1_048_576;

const REPORT: ForgeFilesReport = {
  maxFileBytes: 10 * MB,
  objects: [
    { objectApiName: 'ContentDocument', planned: 3, plannedBytes: 3 * 1024, copied: 2, failed: 1 },
    { objectApiName: 'Attachment', planned: 1, plannedBytes: 512, copied: 1, failed: 0 },
  ],
  links: 2,
  leftOut: [
    {
      objectApiName: 'ContentDocument',
      sourceId: '069000000000001AAA',
      name: 'Survey.mov',
      bytes: 48 * MB,
      reason: 'too-large',
    },
    {
      objectApiName: 'ContentDocument',
      sourceId: '069000000000002AAA',
      name: 'Shared drive link',
      bytes: 0,
      reason: 'external',
    },
    {
      objectApiName: 'Attachment',
      sourceId: '00P000000000001AAA',
      name: 'old.txt',
      bytes: 10,
      reason: 'record-not-created',
    },
  ],
};

describe('ForgeFilesResult', () => {
  it('says per object how many files the run copied of the ones it set out to copy', () => {
    render(<ForgeFilesResult files={REPORT} />);

    expect(screen.getByRole('heading', { name: 'Files' })).toBeDefined();
    expect(screen.getByTestId('forge-results-files-ContentDocument').textContent).toBe(
      'Salesforce Files — 2 of 3 copied (3 KB) — 1 not copied, see the errors below',
    );
    expect(screen.getByTestId('forge-results-files-Attachment').textContent).toBe(
      'Attachments — 1 of 1 copied (512 B)',
    );
    expect(screen.getByText('2 links to other cloned records')).toBeDefined();
  });

  it('lists every file left out, with its size and why, never cut short', () => {
    render(<ForgeFilesResult files={REPORT} />);

    expect(screen.getByText('3 files left out:')).toBeDefined();
    const items = [...screen.getByTestId('forge-results-files-left-out').querySelectorAll('li')];
    expect(items.map((li) => li.textContent)).toEqual([
      'Survey.mov (48 MB) — larger than the 10 MB set for the run',
      'Shared drive link (0 B) — kept outside Salesforce',
      'old.txt (10 B) — its records were not created by this run',
    ]);
  });

  it('says when the cloned records had no file to copy', () => {
    render(<ForgeFilesResult files={{ ...REPORT, objects: [], links: 0, leftOut: [] }} />);

    expect(screen.getByText('No file to copy hangs on the cloned records.')).toBeDefined();
    expect(screen.queryByTestId('forge-results-files-left-out')).toBeNull();
  });
});
