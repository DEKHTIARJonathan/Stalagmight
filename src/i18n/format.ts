import i18n from './index';

type RelativeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export function getCurrentLocale(explicitLocale?: string): string {
  if (explicitLocale && explicitLocale !== 'system') {
    return explicitLocale;
  }
  return i18n.resolvedLanguage || i18n.language || 'en';
}

export function formatNumber(
  value: number,
  locale?: string,
  options?: Intl.NumberFormatOptions
): string {
  const resolvedLocale = getCurrentLocale(locale);
  return new Intl.NumberFormat(resolvedLocale, options).format(value);
}

export function formatFixed(
  value: number,
  locale?: string,
  precision: number = 1
): string {
  const resolvedLocale = getCurrentLocale(locale);
  const clampedPrecision = Math.max(0, Math.min(6, Math.floor(precision)));
  return new Intl.NumberFormat(resolvedLocale, {
    minimumFractionDigits: clampedPrecision,
    maximumFractionDigits: clampedPrecision,
  }).format(value);
}

export function formatPercent(
  value: number,
  locale?: string,
  precision: number = 1
): string {
  const resolvedLocale = getCurrentLocale(locale);
  const clampedPrecision = Math.max(0, Math.min(6, Math.floor(precision)));
  const formatted = new Intl.NumberFormat(resolvedLocale, {
    minimumFractionDigits: clampedPrecision,
    maximumFractionDigits: clampedPrecision,
  }).format(value);
  return `${formatted}%`;
}

export function formatDate(
  date: Date,
  locale?: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const resolvedLocale = getCurrentLocale(locale);
  return new Intl.DateTimeFormat(resolvedLocale, options).format(date);
}

export function formatRelativeTime(
  date: Date,
  locale?: string,
  now: Date = new Date()
): string {
  const resolvedLocale = getCurrentLocale(locale);
  const diffMs = date.getTime() - now.getTime();
  const diffSeconds = Math.round(diffMs / 1000);
  const absSeconds = Math.abs(diffSeconds);

  let value = diffSeconds;
  let unit: RelativeUnit = 'second';

  if (absSeconds >= 60 && absSeconds < 3600) {
    value = Math.round(diffSeconds / 60);
    unit = 'minute';
  } else if (absSeconds >= 3600 && absSeconds < 86400) {
    value = Math.round(diffSeconds / 3600);
    unit = 'hour';
  } else if (absSeconds >= 86400 && absSeconds < 604800) {
    value = Math.round(diffSeconds / 86400);
    unit = 'day';
  } else if (absSeconds >= 604800 && absSeconds < 2629800) {
    value = Math.round(diffSeconds / 604800);
    unit = 'week';
  } else if (absSeconds >= 2629800 && absSeconds < 31557600) {
    value = Math.round(diffSeconds / 2629800);
    unit = 'month';
  } else if (absSeconds >= 31557600) {
    value = Math.round(diffSeconds / 31557600);
    unit = 'year';
  }

  const rtf = new Intl.RelativeTimeFormat(resolvedLocale, { numeric: 'auto' });
  return rtf.format(value, unit);
}
