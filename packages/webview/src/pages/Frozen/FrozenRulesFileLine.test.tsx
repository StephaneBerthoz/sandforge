import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { FrozenRulesFileInfo } from '@sandforge/shared';
import type { BridgeMutationState } from '../../hooks/useBridgeMutation';
import {
  CONFIGURATION_KEYS_URL,
  FrozenRulesFileLine,
  RULES_FORMAT_URL,
} from './FrozenRulesFileLine';

/** What the mutation answers, set by each test; `mutate` records what it is sent. */
const mutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  calls: [] as Array<{ requestType: string; options: unknown }>,
  state: { data: null, loading: false, error: null } as Pick<
    BridgeMutationState<unknown>,
    'data' | 'loading' | 'error'
  >,
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string, options: unknown) => {
    mutation.calls.push({ requestType, options });
    return {
      ...mutation.state,
      mutate: mutation.mutate,
      errorCode: null,
      reset: vi.fn(),
      requestId: null,
    };
  },
}));

const PATH = '/home/qa/.sandforge-sas/rules.json';
const MISSING: FrozenRulesFileInfo = { path: PATH, found: false };

/** The line, with the status read as `rules`, the reason's id given, and `onCreated` spied. */
function line(rules: FrozenRulesFileInfo | undefined, onCreated = vi.fn()) {
  return <FrozenRulesFileLine rules={rules} blockingId="rules-blocking" onCreated={onCreated} />;
}

describe('FrozenRulesFileLine', () => {
  beforeEach(() => {
    mutation.mutate.mockReset();
    mutation.calls = [];
    mutation.state = { data: null, loading: false, error: null };
  });

  // An extraction is refused without the file, and the card said nothing of
  // it: a first-time user was stuck after the selection.
  it('says where the missing file goes, under the id the run names its reason by, and writes it in one click', () => {
    render(line(MISSING));

    expect(document.getElementById('rules-blocking')?.textContent).toBe(
      `No rules file at ${PATH}: Run extraction needs one.`,
    );
    const create = screen.getByTestId('frozen-rules-create');
    expect(create.textContent).toBe('Create rules file');
    expect(
      document.getElementById(create.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(
      'Writes an empty file and opens it: every field without a rule is cleared, and the extraction then lists what it kept without one.',
    );
    fireEvent.click(create);

    expect(mutation.mutate).toHaveBeenCalledTimes(1);
    expect(mutation.mutate).toHaveBeenCalledWith();
    expect(mutation.calls[0]).toEqual({
      requestType: 'frozen:rules:create',
      options: { errorType: 'frozen:rules:create:error' },
    });
    expect(screen.queryByTestId('frozen-rules-open')).toBeNull();
  });

  it('reads the status again once the file is written, and says when no editor opened it', () => {
    const onCreated = vi.fn();
    mutation.state = {
      data: { rulesPath: PATH, created: true, opened: false },
      loading: false,
      error: null,
    };
    render(line(MISSING, onCreated));

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('frozen-rules-not-opened').textContent).toBe(
      `Written at ${PATH}; it could not be opened in an editor.`,
    );
  });

  it('says what the file there holds, offers to open it, and blocks nothing', () => {
    render(line({ path: PATH, found: true, rulesVersion: '1.2.0', ruleCount: 1 }));

    expect(screen.getByTestId('frozen-rules-found').textContent).toBe(
      `Rules file: ${PATH} (rules 1.2.0, 1 rule)`,
    );
    expect(document.getElementById('rules-blocking')).toBeNull();
    expect(screen.queryByTestId('frozen-rules-create')).toBeNull();
    fireEvent.click(screen.getByTestId('frozen-rules-open'));
    expect(mutation.mutate).toHaveBeenCalledTimes(1);
  });

  it('says why a file the extraction cannot read blocks it, and offers to open it', () => {
    render(line({ path: PATH, found: true, invalid: 'rulesVersion is required' }));

    expect(document.getElementById('rules-blocking')?.textContent).toBe(
      `The rules file at ${PATH} is not one the extraction can read: rulesVersion is required`,
    );
    expect(screen.getByTestId('frozen-rules-open')).toBeTruthy();
  });

  it('says a write that failed, in its own words', () => {
    mutation.state = { data: null, loading: false, error: 'EACCES: permission denied' };
    render(line(MISSING));
    expect(screen.getByTestId('frozen-rules-failed').textContent).toBe(
      'The rules file was not written: EACCES: permission denied',
    );
  });

  it('draws nothing before the status is read', () => {
    const { container } = render(line(undefined));
    expect(container.textContent).toBe('');
  });

  it('links the rules format and the configuration keys to sections the docs page has', () => {
    render(line(MISSING));
    expect(screen.getByTestId('frozen-rules-format').getAttribute('href')).toBe(RULES_FORMAT_URL);

    const docs = readFileSync(
      resolve(__dirname, '../../../../../docs/modules/frozen-dataset.md'),
      'utf8',
    );
    // GitHub's anchor of a heading: lower case, spaces as hyphens.
    const anchors = new Set(
      [...docs.matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
        m[1]
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N} -]/gu, '')
          .replace(/ /g, '-'),
      ),
    );
    for (const url of [RULES_FORMAT_URL, CONFIGURATION_KEYS_URL]) {
      expect(
        url.startsWith(
          'https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/frozen-dataset.md#',
        ),
      ).toBe(true);
      expect(anchors).toContain(url.split('#')[1]);
    }
  });
});
