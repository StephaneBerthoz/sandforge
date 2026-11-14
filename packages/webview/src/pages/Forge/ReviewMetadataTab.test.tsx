import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { buildSyntheticForgeGraph } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import ja from '../../i18n/locales/ja.json';
import { ReviewMetadataTab } from './ReviewMetadataTab';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';

/* ---- Mocks ---- */

let mockDiffs: MetadataDiffEntry[] = [];
let mockConfig: ForgeConfig | null = null;
let mockGraph: ForgeGraph | null = null;
const mockUpdateConfig = vi.fn();
const mockSetNodesIncluded = vi.fn();

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get metadataDiffs() {
          return mockDiffs;
        },
        get config() {
          return mockConfig;
        },
        get graph() {
          return mockGraph;
        },
        updateConfig: mockUpdateConfig,
        setNodesIncluded: mockSetNodesIncluded,
      }),
    {
      getState: () => ({
        metadataDiffs: mockDiffs,
      }),
    },
  );
  return { useForgeStore: store };
});

/* ---- Tests ---- */

describe('ReviewMetadataTab', () => {
  it('should render with data-testid', () => {
    mockDiffs = [];
    render(<ReviewMetadataTab />);
    expect(screen.getByTestId('review-metadata-tab')).toBeDefined();
  });

  it('should show "no diffs" message when diffs list is empty', () => {
    mockDiffs = [];
    render(<ReviewMetadataTab />);
    expect(screen.getByTestId('no-diffs')).toBeDefined();
  });

  it('says in the interface language that Execute skips an object the target user may not create', () => {
    // Each field read "createable in source but not in target", in English.
    mockDiffs = [
      {
        objectApiName: 'Case',
        fieldApiName: '',
        issue: 'object_not_createable',
        severity: 'error',
        details: 'Case is in the target org, but the user the clone writes as may not create it',
      },
    ];
    render(<ReviewMetadataTab />);

    expect(screen.getByTestId('diff-0').textContent).toContain(
      'Case is in the target org, but the user the clone writes as may not create its records ' +
        'there: Execute skips it, after the objects written before it. Leave it out in Gaps, or ' +
        'give that user Create on it.',
    );
  });

  it('says of an object no user can create that none can, and never to give the user Create on it', () => {
    // The tab said of a report, which a scratch org's administrator holding
    // Modify All Data may not create either, to give that user Create on it.
    mockDiffs = [
      {
        objectApiName: 'Report',
        fieldApiName: '',
        issue: 'object_not_createable',
        severity: 'info',
        details: 'Report is in the target org, but no user can create its records there',
        notCreatableBy: 'setup',
      },
      {
        objectApiName: 'Invoice',
        fieldApiName: '',
        issue: 'object_not_createable',
        severity: 'error',
        details: 'Invoice is in the target org',
        notCreatableBy: 'feature',
      },
      {
        objectApiName: 'OpportunityLineItem',
        fieldApiName: '',
        issue: 'object_not_createable',
        severity: 'error',
        details: 'OpportunityLineItem is in the target org',
        notCreatableBy: 'parent',
      },
    ];
    render(<ReviewMetadataTab />);

    expect(screen.getByTestId('diff-0').textContent).toContain(
      'Report is in the target org, but no user can create its records there, not even one with ' +
        'Modify All Data: Execute skips it, and no grant would open it.',
    );
    expect(screen.getByTestId('diff-0-severity').textContent).toBe('Info');
    expect(screen.getByTestId('diff-1').textContent).toContain(
      'a feature or licence the target has not turned on keeps it closed',
    );
    expect(screen.getByTestId('diff-2').textContent).toContain(
      'no permission set gives Create on it: Edit on the records it hangs from may open it',
    );
    for (const at of [0, 1, 2]) {
      expect(screen.getByTestId(`diff-${at}`).textContent).not.toContain('give that user Create');
    }
  });

  it('should render diff entries with severity badges when diffs exist', () => {
    mockDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'CustomField__c',
        issue: 'missing',
        severity: 'error',
        details: 'Field does not exist in target org',
      },
      {
        objectApiName: 'Contact',
        fieldApiName: 'Phone',
        issue: 'type_mismatch',
        severity: 'warning',
        details: 'Field type differs: Text vs Number',
      },
      {
        objectApiName: 'Lead',
        fieldApiName: 'Status',
        issue: 'permission_denied',
        severity: 'info',
        details: 'Field is not createable in target',
      },
    ];
    render(<ReviewMetadataTab />);
    expect(screen.queryByTestId('no-diffs')).toBeNull();
    expect(screen.getByTestId('diff-0')).toBeDefined();
    expect(screen.getByTestId('diff-1')).toBeDefined();
    expect(screen.getByTestId('diff-2')).toBeDefined();
  });

  it('should display object and field names in diff entries', () => {
    mockDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'CustomField__c',
        issue: 'missing',
        severity: 'error',
        details: 'Field does not exist in target org',
      },
    ];
    render(<ReviewMetadataTab />);
    const diff0 = screen.getByTestId('diff-0');
    expect(diff0.textContent).toContain('Account.CustomField__c');
  });

  // An object the target lacks has no field to name: it read "Invoice__c.".
  it('names an object the target lacks by itself, with no field after it', () => {
    mockDiffs = [
      {
        objectApiName: 'Invoice__c',
        fieldApiName: '',
        issue: 'object_missing',
        severity: 'error',
        details: 'Invoice__c does not exist in the target org',
      },
    ];
    render(<ReviewMetadataTab />);
    const title = screen.getByTestId('diff-0').querySelector('span');
    expect(title?.textContent).toBe('Invoice__c');
  });

  it("says each difference's severity in the page's language, not as the code's English", async () => {
    const severities: Array<MetadataDiffEntry['severity']> = ['info', 'warning', 'error'];
    mockDiffs = severities.map((severity, i) => ({
      objectApiName: 'Account',
      fieldApiName: `Field${i}__c`,
      issue: 'missing',
      severity,
      details: 'Missing field',
    }));
    const { unmount } = render(<ReviewMetadataTab />);
    expect(severities.map((_, i) => screen.getByTestId(`diff-${i}-severity`).textContent)).toEqual([
      'Info',
      'Warning',
      'Error',
    ]);
    unmount();

    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    i18n.addResourceBundle('ja', 'translation', ja, true, true);
    try {
      await act(async () => {
        await i18n.changeLanguage('fr');
      });
      const french = render(<ReviewMetadataTab />);
      expect(
        severities.map((_, i) => screen.getByTestId(`diff-${i}-severity`).textContent),
      ).toEqual(['Info', 'Avertissement', 'Erreur']);
      french.unmount();

      await act(async () => {
        await i18n.changeLanguage('ja');
      });
      render(<ReviewMetadataTab />);
      expect(
        severities.map((_, i) => screen.getByTestId(`diff-${i}-severity`).textContent),
      ).toEqual(['情報', '警告', 'エラー']);
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('should display diff count in summary text', () => {
    mockDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'A',
        issue: 'missing',
        severity: 'error',
        details: 'x',
      },
      {
        objectApiName: 'Contact',
        fieldApiName: 'B',
        issue: 'type_mismatch',
        severity: 'warning',
        details: 'y',
      },
    ];
    render(<ReviewMetadataTab />);
    const tab = screen.getByTestId('review-metadata-tab');
    expect(tab.textContent).toContain('2');
  });

  describe('what each difference asks, and what the page does about it', () => {
    const CONFIG: ForgeConfig = {
      inputMode: 'record',
      recordId: '001000000000001AAA',
      depth: 'direct',
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    };

    beforeEach(() => {
      mockConfig = { ...CONFIG };
      mockGraph = buildSyntheticForgeGraph(['Account', 'Invoice__c']);
      mockUpdateConfig.mockClear();
      mockSetNodesIncluded.mockClear();
    });

    it("says each code in the page's words, with the types of both orgs and the org that would not describe", () => {
      // Each said what Execute does in the extension's English.
      mockDiffs = [
        {
          objectApiName: 'Contact',
          fieldApiName: 'Score__c',
          issue: 'type_mismatch',
          severity: 'warning',
          details: 'English of the host',
          sourceType: 'double',
          targetType: 'string',
        },
        {
          objectApiName: 'Case',
          fieldApiName: '',
          issue: 'unreadable',
          severity: 'warning',
          details: 'English of the host',
          unreadIn: 'target',
          orgError: 'REQUEST_LIMIT_EXCEEDED',
        },
      ];
      render(<ReviewMetadataTab />);

      const type = screen.getByTestId('diff-0').textContent ?? '';
      expect(type).toContain('double');
      expect(type).toContain('string');
      expect(type).not.toContain('English of the host');
      const unread = screen.getByTestId('diff-1').textContent ?? '';
      expect(unread).toContain('target org');
      expect(unread).toContain('REQUEST_LIMIT_EXCEEDED');
      expect(unread).not.toContain('English of the host');
    });

    it("leaves a field out of its object's rows, and keeps it again", () => {
      mockDiffs = [
        {
          objectApiName: 'Account',
          fieldApiName: 'Region__c',
          issue: 'missing',
          severity: 'error',
          details: 'x',
        },
      ];
      const { unmount } = render(<ReviewMetadataTab />);
      fireEvent.click(screen.getByTestId('diff-0-leave-field'));

      const change = mockUpdateConfig.mock.calls[0]?.[0] as (c: ForgeConfig) => ForgeConfig;
      expect(change(CONFIG).fieldExclusions).toEqual({ Account: ['Region__c'] });
      unmount();

      mockConfig = { ...CONFIG, fieldExclusions: { Account: ['Region__c'] } };
      render(<ReviewMetadataTab />);
      expect(screen.getByTestId('diff-0-left-out')).toBeDefined();
      fireEvent.click(screen.getByTestId('diff-0-leave-field'));
      const back = mockUpdateConfig.mock.calls[1]?.[0] as (c: ForgeConfig) => ForgeConfig;
      expect(back(mockConfig).fieldExclusions).toBeUndefined();
    });

    it('leaves out of the clone an object the target lacks', () => {
      mockDiffs = [
        {
          objectApiName: 'Invoice__c',
          fieldApiName: '',
          issue: 'object_missing',
          severity: 'error',
          details: 'x',
        },
      ];
      render(<ReviewMetadataTab />);

      expect(screen.getByTestId('diff-0').textContent).toContain('Deploy from Diff');
      fireEvent.click(screen.getByTestId('diff-0-leave-object'));
      expect(mockSetNodesIncluded).toHaveBeenCalledWith(['Invoice__c'], false);
    });

    it('compares again an object an org would not describe', () => {
      const again = vi.fn();
      mockDiffs = [
        {
          objectApiName: 'Case',
          fieldApiName: '',
          issue: 'unreadable',
          severity: 'warning',
          details: 'x',
          unreadIn: 'source',
          orgError: 'timeout',
        },
      ];
      render(<ReviewMetadataTab onCompareAgain={again} />);

      fireEvent.click(screen.getByTestId('diff-0-compare-again'));
      expect(again).toHaveBeenCalledTimes(1);
    });

    it("copies for the target's admin the grants the differences ask", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      mockDiffs = [
        {
          objectApiName: 'Lead',
          fieldApiName: 'Status',
          issue: 'permission_denied',
          severity: 'warning',
          details: 'x',
        },
        {
          objectApiName: 'Case',
          fieldApiName: '',
          issue: 'object_not_createable',
          severity: 'error',
          details: 'x',
        },
        {
          objectApiName: 'Report',
          fieldApiName: '',
          issue: 'object_not_createable',
          severity: 'info',
          details: 'x',
          notCreatableBy: 'setup',
        },
      ];
      try {
        render(<ReviewMetadataTab />);
        await act(async () => {
          fireEvent.click(screen.getByTestId('metadata-admin-copy'));
        });

        const copied = String(writeText.mock.calls[0]?.[0]);
        expect(copied).toContain('Edit on Status of Lead');
        expect(copied).toContain('Create on Case');
        // No user creates a report: no grant to ask.
        expect(copied).not.toContain('Report');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
