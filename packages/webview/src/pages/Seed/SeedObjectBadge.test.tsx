import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { SeedObjectResult } from '@sandforge/shared';
import { SeedObjectBadge, wasSkipped } from './SeedObjectBadge';

function result(over: Partial<SeedObjectResult>): SeedObjectResult {
  return {
    objectApiName: 'Knowledge__kav',
    recordsCreated: 0,
    recordsFailed: 0,
    createdIds: [],
    errors: [],
    ...over,
  };
}

const SKIP =
  'Skipped: this org has no Knowledge__kav object (Salesforce Knowledge is not turned on in it).';

describe('SeedObjectBadge', () => {
  it('counts what an object wrote of what it sent', () => {
    render(<SeedObjectBadge result={result({ recordsCreated: 48, recordsFailed: 2 })} />);
    expect(screen.getByText('48/50')).toBeTruthy();
  });

  it('says an object the run wrote nothing of was skipped, not 0/0', () => {
    render(<SeedObjectBadge result={result({ errors: [SKIP], optional: true })} />);
    expect(screen.getByText('Skipped')).toBeTruthy();
    expect(screen.queryByText('0/0')).toBeNull();
  });

  it('reads an object as skipped only when it wrote and failed nothing and says why', () => {
    expect(wasSkipped(result({ errors: [SKIP] }))).toBe(true);
    expect(wasSkipped(result({}))).toBe(false);
    expect(wasSkipped(result({ recordsFailed: 3, errors: ['REQUIRED_FIELD_MISSING'] }))).toBe(
      false,
    );
  });
});
