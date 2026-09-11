import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ApiLimit } from '@sandforge/shared';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { MonitorLimitsSection } from './MonitorLimitsSection';

/** True while the list for the org just entered is still in flight. */
let storageLoading = false;

/** Objects the org exposes through `monitor:storage` for the current test. */
let storageObjects: Array<{ objectName: string; label: string; recordCount: number }> = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:storage') {
      return {
        data: { success: true, objects: storageObjects, totalRecords: 0 },
        loading: storageLoading,
        error: null,
        refetch: vi.fn(),
      };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

const LIMITS: ApiLimit[] = [{ name: 'DailyApiRequests', max: 100, remaining: 20, usedPercent: 80 }];

/** The scan outcome a test puts on screen, if any. */
type ScanState = {
  data?: {
    success: boolean;
    anomalies?: Array<{ field: string; type: string; description: string; severity: string }>;
    error?: string;
  } | null;
  error?: string | null;
};

/** Minimal stand-in for the anomaly scan mutation the section receives. */
function anomalyScanStub(
  mutate: ReturnType<typeof vi.fn>,
  reset: ReturnType<typeof vi.fn>,
  state: ScanState = {},
) {
  return {
    mutate,
    data: state.data ?? null,
    loading: false,
    error: state.error ?? null,
    reset,
  } as unknown as Parameters<typeof MonitorLimitsSection>[0]['anomalyScan'];
}

function renderSection(state: ScanState = {}) {
  const mutate = vi.fn();
  const reset = vi.fn();
  const { rerender } = render(
    <MonitorLimitsSection
      sortedLimits={LIMITS}
      criticalLimits={LIMITS}
      isRefreshing={false}
      anomalyScan={anomalyScanStub(mutate, reset, state)}
    />,
  );
  return {
    mutate,
    reset,
    /** Re-render in place — the page never remounts this section on org change. */
    rerenderSection: () =>
      rerender(
        <MonitorLimitsSection
          sortedLimits={LIMITS}
          criticalLimits={LIMITS}
          isRefreshing={false}
          anomalyScan={anomalyScanStub(mutate, reset, state)}
        />,
      ),
  };
}

describe('MonitorLimitsSection anomaly scan target', () => {
  beforeEach(() => {
    storageObjects = [
      { objectName: 'Account', label: 'Account', recordCount: 500 },
      { objectName: 'Contact', label: 'Contact', recordCount: 400 },
      { objectName: 'Custom_Thing__c', label: 'Custom Thing', recordCount: 12 },
    ];
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('names the object the scan will sample on the button', () => {
    renderSection();
    expect(screen.getByTestId('anomaly-scan-btn').textContent).toContain('Account');
  });

  it('offers the org objects that hold records as scan targets', () => {
    renderSection();
    const picker = screen.getByTestId('anomaly-scan-object') as HTMLSelectElement;
    const values = Array.from(picker.options).map((o) => o.value);
    expect(values).toEqual(['Account', 'Contact', 'Custom_Thing__c']);
  });

  it('scans the object picked, not a hard-coded Account', () => {
    const { mutate } = renderSection();
    fireEvent.change(screen.getByTestId('anomaly-scan-object'), {
      target: { value: 'Custom_Thing__c' },
    });
    fireEvent.click(screen.getByTestId('anomaly-scan-btn'));
    expect(mutate).toHaveBeenCalledWith({ orgId: 'org-1', objectName: 'Custom_Thing__c' });
  });

  it('keeps the picked object visible on the button after the switch', () => {
    renderSection();
    fireEvent.change(screen.getByTestId('anomaly-scan-object'), { target: { value: 'Contact' } });
    expect(screen.getByTestId('anomaly-scan-btn').textContent).toContain('Contact');
  });

  it('still offers the default target when the org reports no object with records', () => {
    storageObjects = [];
    const { mutate } = renderSection();
    const picker = screen.getByTestId('anomaly-scan-object') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['Account']);
    fireEvent.click(screen.getByTestId('anomaly-scan-btn'));
    expect(mutate).toHaveBeenCalledWith({ orgId: 'org-1', objectName: 'Account' });
  });

  it('drops the report of the previous target when the object changes', () => {
    const { reset } = renderSection();
    fireEvent.change(screen.getByTestId('anomaly-scan-object'), { target: { value: 'Contact' } });
    expect(reset).toHaveBeenCalled();
  });

  it('does not fire a scan with no org selected', () => {
    useOrgStore.setState({ selectedOrgId: null, orgs: [] });
    renderSection();
    expect((screen.getByTestId('anomaly-scan-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the default target first, then the objects that hold records', () => {
    storageObjects = [
      { objectName: 'Contact', label: 'Contact', recordCount: 400 },
      { objectName: 'Custom_Thing__c', label: 'Custom Thing', recordCount: 12 },
    ];
    renderSection();
    const picker = screen.getByTestId('anomaly-scan-object') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual([
      'Account',
      'Contact',
      'Custom_Thing__c',
    ]);
  });
});

describe('MonitorLimitsSection across an org switch', () => {
  beforeEach(() => {
    storageObjects = [
      { objectName: 'Account', label: 'Account', recordCount: 500 },
      { objectName: 'Custom_Thing__c', label: 'Custom Thing', recordCount: 12 },
    ];
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
    storageLoading = false;
  });

  it('scans the new org on the default object, not the target picked in the previous one', () => {
    const { mutate, rerenderSection } = renderSection();
    fireEvent.change(screen.getByTestId('anomaly-scan-object'), {
      target: { value: 'Custom_Thing__c' },
    });

    // The page keeps this section mounted across an org switch, so nothing
    // resets the target unless the section does it itself.
    act(() => {
      useOrgStore.setState({ selectedOrgId: 'org-2', orgs: [] });
    });
    rerenderSection();
    fireEvent.click(screen.getByTestId('anomaly-scan-btn'));

    expect(mutate).toHaveBeenCalledWith({ orgId: 'org-2', objectName: 'Account' });
  });

  it('does not keep offering the previous org target once the org changed', () => {
    const { rerenderSection } = renderSection();
    fireEvent.change(screen.getByTestId('anomaly-scan-object'), {
      target: { value: 'Custom_Thing__c' },
    });

    storageObjects = [{ objectName: 'Account', label: 'Account', recordCount: 7 }];
    act(() => {
      useOrgStore.setState({ selectedOrgId: 'org-2', orgs: [] });
    });
    rerenderSection();

    const picker = screen.getByTestId('anomaly-scan-object') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['Account']);
    expect(picker.value).toBe('Account');
  });

  /**
   * The query hook keeps its last answer while the next one is in flight, so
   * between the switch and the new list the objects on screen are the previous
   * org's. Offering them is how a scan goes out for an object that does not
   * exist in the org now selected.
   */
  it('offers nothing but the default while the new org list is still in flight', () => {
    const { rerenderSection } = renderSection();
    fireEvent.change(screen.getByTestId('anomaly-scan-object'), {
      target: { value: 'Custom_Thing__c' },
    });

    storageLoading = true;
    act(() => {
      useOrgStore.setState({ selectedOrgId: 'org-2', orgs: [] });
    });
    rerenderSection();

    const picker = screen.getByTestId('anomaly-scan-object') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['Account']);
    storageLoading = false;
  });

  it('drops the previous org report when the org changes', () => {
    const { reset, rerenderSection } = renderSection();
    reset.mockClear();

    act(() => {
      useOrgStore.setState({ selectedOrgId: 'org-2', orgs: [] });
    });
    rerenderSection();

    expect(reset).toHaveBeenCalled();
  });
});

describe('MonitorLimitsSection scan outcome', () => {
  beforeEach(() => {
    storageObjects = [{ objectName: 'Account', label: 'Account', recordCount: 500 }];
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('shows the reason a scan failed instead of dropping it', () => {
    renderSection({
      data: { success: false, error: "sObject type 'Custom_Thing__c' is not supported." },
    });

    const failure = screen.getByTestId('anomaly-scan-error');
    expect(failure.textContent).toContain('Custom_Thing__c');
  });

  it('shows a transport failure the same way', () => {
    renderSection({ error: 'Request timed out' });

    expect(screen.getByTestId('anomaly-scan-error').textContent).toContain('Request timed out');
  });

  it('says a finished scan found nothing rather than showing nothing', () => {
    renderSection({ data: { success: true, anomalies: [] } });

    expect(screen.getByTestId('anomaly-scan-empty')).toBeDefined();
    expect(screen.queryByTestId('anomaly-scan-error')).toBeNull();
  });

  it('stays quiet when the scan found anomalies — the page lists them', () => {
    renderSection({
      data: {
        success: true,
        anomalies: [
          { field: 'Name', type: 'duplicate', description: 'two identical', severity: 'medium' },
        ],
      },
    });

    expect(screen.queryByTestId('anomaly-scan-empty')).toBeNull();
    expect(screen.queryByTestId('anomaly-scan-error')).toBeNull();
  });
});
