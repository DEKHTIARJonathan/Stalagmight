/**
 * sdk#7: SpeleoDB sends revision `authored_date` as New York wall time with no
 * zone (`YYYY/MM/DD HH:MM`). It must become the right instant (DST-aware), be
 * shown in the viewer's zone with its GMT offset, and give correct relative times.
 */
import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../../i18n/format';
import { formatRevisionTime, gmtOffsetLabel, parseRevisionDate } from '../speleoRevisionTime';

const iso = (raw: string) => parseRevisionDate(raw)?.toISOString() ?? null;

describe('parseRevisionDate', () => {
  it('reads the server wall time as New York time, standard and daylight', () => {
    expect(iso('2026/11/09 04:15')).toBe('2026-11-09T09:15:00.000Z'); // EST, UTC-5
    expect(iso('2026/07/03 06:00')).toBe('2026-07-03T10:00:00.000Z'); // EDT, UTC-4
    expect(iso('2026/01/01 00:00')).toBe('2026-01-01T05:00:00.000Z');
  });

  it('follows the US DST switch dates, not the viewer zone', () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT.
    expect(iso('2026/03/08 01:30')).toBe('2026-03-08T06:30:00.000Z');
    expect(iso('2026/03/08 03:30')).toBe('2026-03-08T07:30:00.000Z');
    // Between the US (Mar 8) and EU (Mar 29) switches New York is already on EDT.
    expect(iso('2026/03/20 12:00')).toBe('2026-03-20T16:00:00.000Z');
    // 2026-11-01: 01:00-02:00 happens twice; the earlier (EDT) instant is used.
    expect(iso('2026/11/01 01:30')).toBe('2026-11-01T05:30:00.000Z');
    expect(iso('2026/11/01 02:30')).toBe('2026-11-01T07:30:00.000Z');
  });

  it('keeps an explicit offset as sent and rejects what it cannot place', () => {
    expect(iso('2026-07-03T10:00:00+00:00')).toBe('2026-07-03T10:00:00.000Z');
    expect(iso('2026-07-03T12:00:00+02:00')).toBe('2026-07-03T10:00:00.000Z');
    expect(iso('2026-07-03T10:00:00Z')).toBe('2026-07-03T10:00:00.000Z');
    expect(iso('2026/07/03 06:00:30')).toBe('2026-07-03T10:00:30.000Z');
    expect(parseRevisionDate('yesterday')).toBeNull();
    expect(parseRevisionDate('')).toBeNull();
  });
});

describe('gmtOffsetLabel', () => {
  it('states the offset of the zone the time is shown in', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');
    expect(gmtOffsetLabel(winter, 'Europe/Paris')).toBe('GMT+1');
    expect(gmtOffsetLabel(summer, 'Europe/Paris')).toBe('GMT+2');
    expect(gmtOffsetLabel(winter, 'America/New_York')).toBe('GMT-5');
    expect(gmtOffsetLabel(winter, 'Asia/Kolkata')).toBe('GMT+5:30');
    expect(gmtOffsetLabel(winter, 'America/St_Johns')).toBe('GMT-3:30');
    expect(gmtOffsetLabel(winter, 'UTC')).toBe('GMT+0');
  });

  it('defaults to the viewer zone', () => {
    const date = new Date('2026-01-15T12:00:00Z');
    const minutes = -date.getTimezoneOffset();
    const label = gmtOffsetLabel(date);
    expect(label.startsWith(minutes < 0 ? 'GMT-' : 'GMT+')).toBe(true);
  });
});

describe('formatRevisionTime', () => {
  it('shows a just-made commit at the viewer local time, with the offset', () => {
    // 04:15 in New York is 10:15 in Paris (CET) on 9 November.
    const date = parseRevisionDate('2026/11/09 04:15');
    expect(date).not.toBeNull();
    const text = formatRevisionTime(date as Date, 'Europe/Paris');
    expect(text).toContain('Nov 9, 2026');
    expect(text).toContain('10:15');
    expect(text.endsWith(' GMT+1')).toBe(true);
    // March 20: New York is on EDT, Paris still on CET.
    const spring = formatRevisionTime(parseRevisionDate('2026/03/20 12:00') as Date, 'Europe/Paris');
    expect(spring).toContain('05:00');
    expect(spring.endsWith(' GMT+1')).toBe(true);
  });

  it('gives a correct relative time for a just-made commit', () => {
    // The bug: parsed as viewer-local, a commit made a minute ago read hours off
    // (in the future for a viewer west of New York). As an instant it is "now".
    const date = parseRevisionDate('2026/11/09 04:15') as Date;
    const now = new Date('2026-11-09T09:30:00Z');
    expect(formatRelativeTime(date, 'en', now)).toBe('15 minutes ago');
  });
});
