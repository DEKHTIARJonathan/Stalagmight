import { useTranslation } from 'react-i18next';
import { useTileAttribution } from '../../hooks/useTileAttribution';

/**
 * The half of the imagery provider's attribution that does NOT have to be on the
 * map.
 *
 * Esri asks for two separate things. The source names must stay visible wherever
 * the imagery is drawn - `MapAttribution` handles that. The "Powered by Esri"
 * notice only has to be "clearly displayed on the map, application, or in a
 * window that is accessible from a menu or button", and must be easily
 * discoverable and unobstructed. About, reached from Settings, is that window,
 * which keeps the notice off a map where every pixel is survey data. See
 * https://developers.arcgis.com/documentation/esri-and-data-attribution/interactive-maps/
 *
 * The source names are repeated here as well. Nothing requires that, but this is
 * the screen someone opens to find out where the imagery comes from, and Esri
 * asks for the list to be discoverable rather than merely present.
 */
export function AboutMapImagery({ provider = 'esri' }: { provider?: string }) {
  const { t } = useTranslation();
  const { text, notice, noticeUrl } = useTileAttribution(provider);

  // A provider with neither a notice nor source names has nothing to credit.
  if (!notice && !text) return null;

  return (
    <div className="border-t border-border pt-2 space-y-1" data-testid="about-map-imagery">
      <p className="text-sm font-medium">{t('dialogs.about.mapImagery.title')}</p>
      {notice && (
        <p>
          {noticeUrl ? (
            <a
              href={noticeUrl}
              data-testid="about-imagery-notice-link"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent hover:underline"
              onClick={(e) => {
                // Same handling as the website link above it: the webview would
                // otherwise navigate the app window itself.
                e.preventDefault();
                window.open(noticeUrl, '_blank');
              }}
            >
              {notice}
            </a>
          ) : (
            <span className="text-sm">{notice}</span>
          )}
        </p>
      )}
      {text && (
        <p className="text-xs text-text-secondary" data-testid="about-imagery-sources">
          {t('dialogs.about.mapImagery.sources', { sources: text })}
        </p>
      )}
    </div>
  );
}

export default AboutMapImagery;
