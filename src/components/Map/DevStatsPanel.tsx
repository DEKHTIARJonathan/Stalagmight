import { useTranslation } from 'react-i18next';
import { formatFixed, formatNumber } from '../../i18n/format';
import { getFpsColor, type MapDevStatsData } from './useMapDevStats';

interface DevStatsPanelProps {
  data: MapDevStatsData;
}

/**
 * Dev Stats panel: frame rate, render-pipeline profile (draw calls,
 * triangles, layers, source feature counts), and the MapLibre built-in
 * debug-layer toggle buttons. One of the three panels driven by
 * useMapDevStats - see MapDevStatsPanels for how they're composed.
 */
export function DevStatsPanel({ data }: DevStatsPanelProps) {
  const { t } = useTranslation();
  const {
    fps,
    frameTime,
    isZooming,
    renderProfile,
    showTileBoundaries,
    showCollisionBoxes,
    showOverdraw,
    hideSymbols,
    hideAllLayers,
    toggleTileBoundaries,
    toggleCollisionBoxes,
    toggleOverdraw,
    toggleSymbols,
    toggleAllLayers,
  } = data;

  return (
    <div
      className="relative bg-panel-90 text-text-primary text-xs font-mono p-2 rounded border border-border select-none"
      style={{ minWidth: '200px', maxWidth: '280px' }}
      data-testid="map-dev-stats"
    >
      {/* Performance */}
      <div className="mb-1">
        <span className="text-text-secondary">{t('map.devStats.fps')}:</span>{' '}
        <span className={getFpsColor(fps)}>{formatNumber(fps)}</span>
        <span className="text-text-secondary opacity-80 ml-2">
          {t('map.devStats.frameTime', { ms: formatNumber(frameTime) })}
        </span>
        {isZooming && <span className="text-warning ml-2">{t('map.devStats.zooming')}</span>}
      </div>

      {/* Render pipeline profile */}
      {renderProfile && (
        <div className="pt-1">
          <div className="text-text-secondary mb-0.5">Render:</div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">Draw calls:</span>{' '}
            <span className={renderProfile.drawCalls > 100 ? 'text-warning' : 'text-text-primary'}>
              {formatNumber(renderProfile.drawCalls)}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">Render:</span>{' '}
            <span className={renderProfile.renderMs > 16 ? 'text-error' : renderProfile.renderMs > 8 ? 'text-warning' : 'text-text-primary'}>
              {formatFixed(renderProfile.renderMs, undefined, 1)}ms
            </span>
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">Tris:</span>{' '}
            <span className="text-text-primary">{formatNumber(renderProfile.triangles)}</span>
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">Layers:</span>{' '}
            <span className="text-text-primary">
              {formatNumber(renderProfile.layers.visible)}/{formatNumber(renderProfile.layers.total)}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">
              ({Object.entries(renderProfile.layers.byType)
                .map(([type, count]) => `${count}${type[0]}`)
                .join(' ')})
            </span>
          </div>
          {renderProfile.sources.length > 0 && (
            <div className="pl-2 text-[10px]">
              <span className="text-text-secondary opacity-80">Features:</span>{' '}
              <span className="text-text-primary">
                {formatNumber(renderProfile.sources.reduce((sum, s) => sum + s.features, 0))}
              </span>
              <span className="text-text-secondary opacity-80 ml-1">
                ({renderProfile.sources
                  .filter((s) => s.features > 0)
                  .map((s) => `${s.name}:${s.features}`)
                  .join(' ')})
              </span>
            </div>
          )}
        </div>
      )}

      {/* Debug toggles */}
      <div className="border-t border-border pt-1 mt-1 pointer-events-auto">
        <div className="text-text-secondary mb-0.5">{t('map.devStats.debug')}:</div>
        <div className="pl-2 flex flex-wrap gap-1">
          <button
            onClick={toggleTileBoundaries}
            data-testid="map-dev-toggle-tile-boundaries"
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showTileBoundaries
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.tiles')}
          >
            {t('map.devStats.tiles')}
          </button>
          <button
            onClick={toggleCollisionBoxes}
            data-testid="map-dev-toggle-collision-boxes"
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showCollisionBoxes
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.collision')}
          >
            {t('map.devStats.collision')}
          </button>
          <button
            onClick={toggleOverdraw}
            data-testid="map-dev-toggle-overdraw"
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              showOverdraw
                ? 'bg-accent-30 border-accent text-accent'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.overdraw')}
          >
            {t('map.devStats.overdraw')}
          </button>
          <button
            onClick={toggleSymbols}
            data-testid="map-dev-toggle-symbols"
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              hideSymbols
                ? 'bg-error-20 border-error text-error'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.labels')}
          >
            {hideSymbols ? t('map.devStats.labelsOff') : t('map.devStats.labels')}
          </button>
          <button
            onClick={toggleAllLayers}
            data-testid="map-dev-toggle-all-layers"
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              hideAllLayers
                ? 'bg-error-20 border-error text-error'
                : 'bg-panel border-border text-text-secondary hover:border-accent'
            }`}
            title={t('map.devStats.titles.allLayers')}
          >
            {hideAllLayers ? t('map.devStats.allLayersOff') : t('map.devStats.allLayers')}
          </button>
        </div>
      </div>
    </div>
  );
}
