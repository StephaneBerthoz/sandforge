import React, { useState, useCallback } from 'react';
import { useReactFlow } from 'reactflow';
import { useTranslation } from 'react-i18next';

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
  const [isHovered, setIsHovered] = useState(false);

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
    'flex h-8 w-8 items-center justify-center rounded text-gray-300 hover:bg-gray-600 hover:text-white transition-colors';

  return (
    <div
      data-testid="graph-controls"
      className="absolute right-3 top-3 z-10 flex flex-col gap-1 rounded-md border border-gray-600 bg-[var(--vscode-editor-background,#1e1e1e)] p-1 shadow-lg"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
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
      <div className="mx-1 border-t border-gray-600" />
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
        className={`${buttonClass} ${minimapVisible ? 'bg-gray-600 text-white' : ''}`}
        onClick={onToggleMinimap}
        title={t('autopilot.graph.controls.minimap')}
        aria-label={t('autopilot.graph.controls.minimap')}
      >
        {isHovered ? '\u25A3' : '\u25A1'}
      </button>
    </div>
  );
};
