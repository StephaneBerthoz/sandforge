import React, { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../theme';

/**
 * GraphControls — Overlay panel providing zoom controls, fit-view button,
 * and a minimap toggle for the AutopilotGraph canvas.
 */
export const GraphControls: React.FC<{
  /** Whether the minimap is currently visible */
  minimapVisible: boolean;
  /** Callback to toggle minimap visibility */
  onToggleMinimap: () => void;
}> = ({ minimapVisible, onToggleMinimap }) => {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const handleZoomIn = useCallback(() => {
    void zoomIn({ duration: 200 });
  }, [zoomIn]);

  const handleZoomOut = useCallback(() => {
    void zoomOut({ duration: 200 });
  }, [zoomOut]);

  const handleFitView = useCallback(() => {
    void fitView({ duration: 300, padding: 0.2 });
  }, [fitView]);

  const buttonClass =
    'flex h-8 w-8 items-center justify-center rounded-sm text-text-secondary hover:bg-(--sf-bg-hover) hover:text-text-primary transition-colors';

  return (
    // `group` rather than a hover handler: the state it kept drove one glyph
    // and nothing else, so CSS can have it. That also takes the mouse
    // listeners off a plain div, which is what made this container look
    // interactive to anything reading the markup. `border-subtle` replaces a
    // raw grey that did not survive a light theme.
    <div
      data-testid="graph-controls"
      className="group absolute right-3 top-3 z-10 flex flex-col gap-1 rounded-md border border-subtle bg-(--sf-bg-primary) p-1 shadow-lg"
    >
      <button
        data-testid="zoom-in-btn"
        className={buttonClass}
        onClick={handleZoomIn}
        title={t('autopilot.graph.controls.zoomIn')}
        aria-label={t('autopilot.graph.controls.zoomIn')}
      >
        +
      </button>
      <button
        data-testid="zoom-out-btn"
        className={buttonClass}
        onClick={handleZoomOut}
        title={t('autopilot.graph.controls.zoomOut')}
        aria-label={t('autopilot.graph.controls.zoomOut')}
      >
        &#x2212;
      </button>
      <div className="mx-1 border-t border-subtle" />
      <button
        data-testid="fit-view-btn"
        className={buttonClass}
        onClick={handleFitView}
        title={t('autopilot.graph.controls.fitView')}
        aria-label={t('autopilot.graph.controls.fitView')}
      >
        &#x2922;
      </button>
      <button
        data-testid="minimap-toggle-btn"
        className={cn(buttonClass, minimapVisible && 'bg-(--sf-bg-hover) text-text-primary')}
        onClick={onToggleMinimap}
        title={t('autopilot.graph.controls.minimap')}
        aria-label={t('autopilot.graph.controls.minimap')}
      >
        <span className="group-hover:hidden">{'\u25A1'}</span>
        <span className="hidden group-hover:inline">{'\u25A3'}</span>
      </button>
    </div>
  );
};
