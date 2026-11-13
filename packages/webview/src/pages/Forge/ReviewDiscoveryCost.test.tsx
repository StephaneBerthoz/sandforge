import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ReviewDiscoveryCost } from './ReviewDiscoveryCost';

describe('ReviewDiscoveryCost', () => {
  it('says what discovery sent each org before any row was read, as the command line says it', () => {
    render(
      <ReviewDiscoveryCost
        graph={{ discoveryRequests: { source: 240, target: 6 } }}
        source="SRC"
        target="TGT"
      />,
    );
    expect(screen.getByTestId('review-discovery-cost').textContent).toBe(
      'Discovery sent 246 API requests, before any row was read: 240 to SRC, 6 to TGT.',
    );
  });

  it('says one request in the singular', () => {
    render(
      <ReviewDiscoveryCost
        graph={{ discoveryRequests: { source: 1, target: 0 } }}
        source="SRC"
        target="TGT"
      />,
    );
    expect(screen.getByTestId('review-discovery-cost').textContent).toBe(
      'Discovery sent 1 API request, before any row was read: 1 to SRC, 0 to TGT.',
    );
  });

  it('says nothing of a graph the session’s cache served, or one a run carries', () => {
    const { container } = render(
      <>
        <ReviewDiscoveryCost graph={{}} source="SRC" target="TGT" />
        <ReviewDiscoveryCost
          graph={{ discoveryRequests: { source: 0, target: 0 } }}
          source="SRC"
          target="TGT"
        />
      </>,
    );
    expect(container.textContent).toBe('');
  });
});
