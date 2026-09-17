import React from 'react';
import { Spinner } from '../../components/ui/Spinner';

/** Semi-transparent overlay shown on each panel during refresh. */
export function PanelOverlay({
  isRefreshing,
  children,
}: {
  isRefreshing: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      {children}
      {isRefreshing && (
        <div
          className="absolute inset-0 bg-[color-mix(in_srgb,var(--sf-bg-primary)_50%,transparent)] flex items-center justify-center z-10 rounded-lg"
          data-testid="panel-overlay"
        >
          <Spinner size="sm" />
        </div>
      )}
    </div>
  );
}
