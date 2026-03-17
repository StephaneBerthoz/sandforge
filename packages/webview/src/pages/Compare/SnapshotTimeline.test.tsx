import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { OrgSnapshot } from '@sandforge/shared';
import { SnapshotTimeline } from './SnapshotTimeline';

const mockSnapshots: OrgSnapshot[] = [
  {
    id: 'snap-1',
    orgId: 'org-1',
    name: 'Before Release',
    componentTypes: ['ApexClass', 'CustomField'],
    componentCount: 42,
    createdAt: '2024-01-15T10:00:00Z',
  },
  {
    id: 'snap-2',
    orgId: 'org-1',
    name: 'After Release',
    componentTypes: ['ApexClass', 'CustomField', 'Flow'],
    componentCount: 55,
    createdAt: '2024-01-20T14:00:00Z',
  },
  {
    id: 'snap-3',
    orgId: 'org-1',
    name: 'Hotfix',
    componentTypes: ['ApexClass'],
    componentCount: 60,
    createdAt: '2024-01-25T08:00:00Z',
  },
];

describe('SnapshotTimeline', () => {
  it('should render the snapshots card', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    expect(screen.getByText('Snapshots')).toBeDefined();
  });

  it('should render all snapshots', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    expect(screen.getByTestId('snapshot-snap-1')).toBeDefined();
    expect(screen.getByTestId('snapshot-snap-2')).toBeDefined();
    expect(screen.getByTestId('snapshot-snap-3')).toBeDefined();
  });

  it('should show snapshot names', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    expect(screen.getByText('Before Release')).toBeDefined();
    expect(screen.getByText('After Release')).toBeDefined();
  });

  it('should show component counts', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    expect(screen.getByText(/42 components/)).toBeDefined();
  });

  it('should sort snapshots by date descending', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    const timeline = screen.getByTestId('snapshot-timeline');
    const items = timeline.querySelectorAll('[data-testid^="snapshot-snap"]');
    expect(items[0].getAttribute('data-testid')).toBe('snapshot-snap-3');
  });

  it('should show create button when handler provided', () => {
    const handler = vi.fn();
    render(<SnapshotTimeline snapshots={mockSnapshots} onCreateSnapshot={handler} />);
    const btn = screen.getByTestId('create-snapshot-btn');
    fireEvent.click(btn);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should call onSelectSnapshot when clicking a snapshot', () => {
    const handler = vi.fn();
    render(<SnapshotTimeline snapshots={mockSnapshots} onSelectSnapshot={handler} />);
    fireEvent.click(screen.getByText('Before Release'));
    expect(handler).toHaveBeenCalledWith(mockSnapshots[0]);
  });

  it('should show delete button when handler provided', () => {
    const handler = vi.fn();
    render(<SnapshotTimeline snapshots={mockSnapshots} onDeleteSnapshot={handler} />);
    fireEvent.click(screen.getByTestId('delete-snapshot-snap-1'));
    expect(handler).toHaveBeenCalledWith('snap-1');
  });

  it('should show empty state when no snapshots', () => {
    render(<SnapshotTimeline snapshots={[]} />);
    expect(screen.getByText('No snapshots available')).toBeDefined();
  });

  it('should toggle selection when clicking a snapshot', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    fireEvent.click(screen.getByTestId('snapshot-select-snap-1'));
    expect(screen.getByTestId('snapshot-selected-badge-snap-1')).toBeDefined();
  });

  it('should allow selecting up to 2 snapshots', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    fireEvent.click(screen.getByTestId('snapshot-select-snap-1'));
    fireEvent.click(screen.getByTestId('snapshot-select-snap-2'));
    expect(screen.getByTestId('snapshot-selected-badge-snap-1')).toBeDefined();
    expect(screen.getByTestId('snapshot-selected-badge-snap-2')).toBeDefined();
  });

  it('should deselect when clicking a selected snapshot', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    fireEvent.click(screen.getByTestId('snapshot-select-snap-1'));
    expect(screen.getByTestId('snapshot-selected-badge-snap-1')).toBeDefined();
    fireEvent.click(screen.getByTestId('snapshot-select-snap-1'));
    expect(screen.queryByTestId('snapshot-selected-badge-snap-1')).toBeNull();
  });

  it('should replace oldest selection when selecting a third snapshot', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    fireEvent.click(screen.getByTestId('snapshot-select-snap-1'));
    fireEvent.click(screen.getByTestId('snapshot-select-snap-2'));
    fireEvent.click(screen.getByTestId('snapshot-select-snap-3'));
    // snap-1 should be dropped, snap-2 and snap-3 remain
    expect(screen.queryByTestId('snapshot-selected-badge-snap-1')).toBeNull();
    expect(screen.getByTestId('snapshot-selected-badge-snap-2')).toBeDefined();
    expect(screen.getByTestId('snapshot-selected-badge-snap-3')).toBeDefined();
  });

  it('should show compare button when exactly 2 snapshots are selected', () => {
    render(<SnapshotTimeline snapshots={mockSnapshots} />);
    // No compare button yet
    expect(screen.queryByTestId('compare-snapshots-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('snapshot-select-snap-1'));
    // Still only 1 selected
    expect(screen.queryByTestId('compare-snapshots-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('snapshot-select-snap-2'));
    // Now 2 selected
    expect(screen.getByTestId('compare-snapshots-btn')).toBeDefined();
  });

  it('should call onCompareSnapshots with selected ids', () => {
    const handler = vi.fn();
    render(<SnapshotTimeline snapshots={mockSnapshots} onCompareSnapshots={handler} />);
    fireEvent.click(screen.getByTestId('snapshot-select-snap-1'));
    fireEvent.click(screen.getByTestId('snapshot-select-snap-2'));
    fireEvent.click(screen.getByTestId('compare-snapshots-btn'));
    expect(handler).toHaveBeenCalledWith(['snap-1', 'snap-2']);
  });
});
