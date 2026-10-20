import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Which of the Seed page's flows a panel loads. Each stand-in notes when its
 * module is evaluated: a page that imports its flows up front evaluates all
 * of them as it is imported, which is what every panel showing Seed paid
 * for — the wizard, the CSV parser and the clone flow — before its gallery.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(name: string) {
  evaluated.add(name);
  return { [name]: () => <div data-testid={`flow-${name}`}>{name}</div> };
}

vi.mock('./SeedGenerateFlow', () => stand('SeedGenerateFlow'));
vi.mock('./QuickSeedFlow', () => stand('QuickSeedFlow'));
vi.mock('./CsvUpload/CsvUploadWizard', () => stand('CsvUploadWizard'));
vi.mock('./Clone/CloneWizard', () => stand('CloneWizard'));
vi.mock('./SeedRunHistory', () => stand('SeedRunHistory'));

import * as flows from './seedFlows';

describe('seedFlows', () => {
  it('loads no flow until one is shown, then that flow only', async () => {
    expect([...evaluated]).toEqual([]);

    const { CsvUploadWizard } = flows as unknown as Record<string, React.FC>;
    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <CsvUploadWizard />
      </Suspense>,
    );

    expect(screen.getByTestId('loading')).toBeDefined();
    expect(await screen.findByTestId('flow-CsvUploadWizard')).toBeDefined();
    expect([...evaluated]).toEqual(['CsvUploadWizard']);
  });

  it('loads each flow under its own name', async () => {
    for (const name of ['SeedGenerateFlow', 'QuickSeedFlow', 'CloneWizard', 'SeedRunHistory']) {
      const Flow = (flows as unknown as Record<string, React.FC>)[name];
      const { unmount } = render(
        <Suspense fallback={null}>
          <Flow />
        </Suspense>,
      );
      expect(await screen.findByTestId(`flow-${name}`)).toBeDefined();
      unmount();
    }
  });
});
