import { useTranslation } from 'react-i18next';
import { formatFixed, formatNumber } from '../../i18n/format';
import { formatBytes, getNetworkIndicator, type MapDevStatsData } from './useMapDevStats';

interface MapStatsPanelProps {
  data: MapDevStatsData;
}

/**
 * Map Stats panel: map/tile load state, canvas size and center coordinates,
 * WebGL info, satellite tile-fetch stats, network status, and tile-cache
 * stats. One of the three panels driven by useMapDevStats - see
 * MapDevStatsPanels for how they're composed.
 */
export function MapStatsPanel({ data }: MapStatsPanelProps) {
  const { t } = useTranslation();
  const {
    mapLoaded,
    tilesLoaded,
    center,
    canvasSize,
    webglInfo,
    networkStatus,
    tileFetchStats,
    cacheStats,
  } = data;

  const networkIndicator = getNetworkIndicator(t, networkStatus);

  // Shorten GPU renderer name for display
  const shortRenderer = webglInfo?.renderer
    ? webglInfo.renderer.replace(/ANGLE \(|, .*?\)$/g, '').substring(0, 30)
    : null;

  return (
    <div
      className="relative bg-panel-90 text-text-primary text-xs font-mono p-2 rounded border border-border select-none"
      style={{ minWidth: '200px', maxWidth: '280px' }}
      data-testid="map-stats-panel"
    >
      {/* Map state */}
      <div className="mb-1">
        <span className="text-text-secondary">{t('map.devStats.map')}:</span>{' '}
        <span className={mapLoaded ? 'text-success' : 'text-warning'}>
          {mapLoaded ? t('map.devStats.loaded') : t('map.devStats.loading')}
        </span>
        <span className="text-text-secondary opacity-80 mx-1">|</span>
        <span className={tilesLoaded ? 'text-success' : 'text-warning'}>
          {tilesLoaded ? t('map.devStats.tilesReady') : t('map.devStats.tilesLoading')}
        </span>
      </div>

      {/* Canvas size and center */}
      <div className="mb-1 text-text-secondary opacity-80 text-[10px]">
        {t('map.devStats.canvasSize', {
          width: formatNumber(canvasSize.width),
          height: formatNumber(canvasSize.height),
        })}
      </div>
      <div className="mb-1 text-text-secondary opacity-80 text-[10px]">
        {formatFixed(center.lng, undefined, 6)}, {formatFixed(center.lat, undefined, 6)}
      </div>

      {/* WebGL Info */}
      {webglInfo && (
        <div className="border-t border-border pt-1 mt-1">
          <div className="text-text-secondary mb-0.5">{t('map.devStats.webgl')}:</div>
          <div
            className="pl-2 text-[10px] text-text-secondary opacity-80 truncate"
            title={webglInfo.renderer}
          >
            {webglInfo.webglVersion} - {shortRenderer}
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">{t('map.devStats.maxTexture')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(webglInfo.maxTextureSize)}</span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.textureUnits')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(webglInfo.maxTextureUnits)}</span>
          </div>
          <div className="pl-2 text-[10px]">
            <span className="text-text-secondary opacity-80">{t('map.devStats.colorBits')}:</span>{' '}
            <span className="text-text-primary">
              {webglInfo.colorBits.r}/{webglInfo.colorBits.g}/{webglInfo.colorBits.b}/{webglInfo.colorBits.a}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.depthBits')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(webglInfo.depthBits)}</span>
            {webglInfo.samples > 0 && (
              <>
                <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.msaa')}:</span>{' '}
                <span className="text-success">
                  {t('map.devStats.msaaValue', {
                    count: webglInfo.samples,
                    countFormatted: formatNumber(webglInfo.samples),
                  })}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tile fetch stats */}
      {tileFetchStats && (
        <div className="border-t border-border pt-1 mt-1">
          <div className="text-text-secondary mb-0.5">{t('map.devStats.satelliteTiles')}:</div>
          <div className="pl-2">
            <span className="text-text-secondary opacity-80">{t('map.devStats.inFlight')}:</span>{' '}
            <span className={tileFetchStats.inFlight > 0 ? 'text-warning' : 'text-success'}>
              {formatNumber(tileFetchStats.inFlight)}
            </span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.latency')}:</span>{' '}
            <span className={tileFetchStats.avgLatencyMs > 500 ? 'text-warning' : 'text-text-primary'}>
              {t('map.devStats.durationMs', { ms: formatNumber(tileFetchStats.avgLatencyMs) })}
            </span>
          </div>
          <div className="pl-2">
            <span className="text-text-secondary opacity-80">{t('map.devStats.fetched')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(tileFetchStats.totalFetched)}</span>
            {tileFetchStats.totalErrors > 0 && (
              <span className="text-error ml-1">
                {t('map.devStats.errors', {
                  count: tileFetchStats.totalErrors,
                  countFormatted: formatNumber(tileFetchStats.totalErrors),
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Network status */}
      <div className="border-t border-border pt-1 mt-1">
        <span className="text-text-secondary">{t('map.devStats.network.label')}:</span>{' '}
        <span className={networkIndicator.color}>{networkIndicator.text}</span>
      </div>

      {/* Cache stats */}
      {cacheStats && (
        <div className="border-t border-border pt-1 mt-1">
          <div className="text-text-secondary mb-0.5">{t('map.devStats.cache')}:</div>
          <div className="pl-2">
            <span className="text-text-secondary opacity-80">{t('map.devStats.tiles')}:</span>{' '}
            <span className="text-text-primary">{formatNumber(Number(cacheStats.total_tiles))}</span>
            <span className="text-text-secondary opacity-80 ml-2">{t('map.devStats.size')}:</span>{' '}
            <span className="text-text-primary">{formatBytes(t, cacheStats.total_bytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
