import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { SankeyFlow } from './SankeyFlow';
import type { SankeyNode, SankeyLink } from './SankeyFlow';

const nodes: SankeyNode[] = [
  { id: 'src-account', label: 'Account', group: 'source' },
  { id: 'src-contact', label: 'Contact', group: 'source' },
  { id: 'tgt-account', label: 'Account', group: 'target' },
  { id: 'tgt-contact', label: 'Contact', group: 'target' },
];

const links: SankeyLink[] = [
  { sourceId: 'src-account', targetId: 'tgt-account', value: 1000 },
  { sourceId: 'src-contact', targetId: 'tgt-contact', value: 5000 },
];

describe('SankeyFlow', () => {
  it('should render the flow', () => {
    render(<SankeyFlow nodes={nodes} links={links} />);
    expect(screen.getByTestId('sankey-flow')).toBeDefined();
  });

  it('should render SVG', () => {
    render(<SankeyFlow nodes={nodes} links={links} />);
    expect(screen.getByTestId('sankey-svg')).toBeDefined();
  });

  it('should render source nodes', () => {
    render(<SankeyFlow nodes={nodes} links={links} />);
    expect(screen.getByTestId('node-src-account')).toBeDefined();
    expect(screen.getByTestId('node-src-contact')).toBeDefined();
  });

  it('should render target nodes', () => {
    render(<SankeyFlow nodes={nodes} links={links} />);
    expect(screen.getByTestId('node-tgt-account')).toBeDefined();
    expect(screen.getByTestId('node-tgt-contact')).toBeDefined();
  });

  it('should render links', () => {
    render(<SankeyFlow nodes={nodes} links={links} />);
    expect(screen.getByTestId('link-src-account-tgt-account')).toBeDefined();
    expect(screen.getByTestId('link-src-contact-tgt-contact')).toBeDefined();
  });

  it('should show empty state when no nodes', () => {
    render(<SankeyFlow nodes={[]} links={[]} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should show data flow label', () => {
    render(<SankeyFlow nodes={nodes} links={links} />);
    expect(screen.getByText('Data Flow')).toBeDefined();
  });

  it('should use custom dimensions', () => {
    render(<SankeyFlow nodes={nodes} links={links} width={800} height={400} />);
    const svg = screen.getByTestId('sankey-svg');
    expect(svg.getAttribute('width')).toBe('800');
    expect(svg.getAttribute('height')).toBe('400');
  });
});
