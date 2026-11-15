import { afterEach, describe, expect, it } from 'vitest';
import {
  formatBogotaTimeExact,
  getBogotaNowParts,
  getOperationalDateStr,
  getPreviousDateStr,
  getServerNow,
  getServerTimeOffsetMs,
  setServerTimeOffsetMs,
  shiftDateStr,
} from '../date';

describe('date.ts (America/Bogota UTC-5)', () => {
  afterEach(() => {
    setServerTimeOffsetMs(0);
  });

  it('converts UTC timestamps accurately to America/Bogota local date and time', () => {
    // 2026-11-14 04:30 UTC === 2026-11-13 23:30 America/Bogota
    const utcLateNight = new Date('2026-11-14T04:30:00Z');
    const parts = getBogotaNowParts(utcLateNight);

    expect(parts.dateStr).toBe('2026-11-13');
    expect(parts.hour).toBe(23);
    expect(parts.minute).toBe(30);
    expect(parts.hhmm).toBe('23:30');
    expect(parts.totalMinutes).toBe(23 * 60 + 30);
  });

  it('assigns post-midnight times (00:00–05:59 AM Bogota) to the previous operational day and rolls over at 06:00 AM', () => {
    // 2026-11-13 23:59:59 Bogota === 2026-11-14 04:59:59 UTC -> still 2026-11-13
    expect(getOperationalDateStr(new Date('2026-11-14T04:59:59Z'))).toBe('2026-11-13');
    // 2026-11-14 00:01:00 Bogota === 2026-11-14 05:01:00 UTC -> post-midnight closing/notes stay on 2026-11-13
    expect(getOperationalDateStr(new Date('2026-11-14T05:01:00Z'))).toBe('2026-11-13');
    // 2026-11-14 01:45 Bogota === 2026-11-14 06:45 UTC
    expect(getOperationalDateStr(new Date('2026-11-14T06:45:00Z'))).toBe('2026-11-13');
    // 2026-11-14 05:59:59 Bogota === 2026-11-14 10:59:59 UTC
    expect(getOperationalDateStr(new Date('2026-11-14T10:59:59Z'))).toBe('2026-11-13');
    // 2026-11-14 06:00:00 Bogota === 2026-11-14 11:00:00 UTC -> rolls to 2026-11-14
    expect(getOperationalDateStr(new Date('2026-11-14T11:00:00Z'))).toBe('2026-11-14');
    // Month boundary after midnight: 2026-12-01 01:15 Bogota === 2026-12-01 06:15 UTC -> 2026-11-30
    expect(getOperationalDateStr(new Date('2026-12-01T06:15:00Z'))).toBe('2026-11-30');
  });

  it('formats exact Bogota 24h time HH:mm:ss for worker notes', () => {
    // 2026-11-14 05:07:09 UTC === 2026-11-14 00:07:09 Bogota
    expect(formatBogotaTimeExact(new Date('2026-11-14T05:07:09Z'))).toBe('00:07:09');
    // 2026-11-14 04:30:45 UTC === 2026-11-13 23:30:45 Bogota
    expect(formatBogotaTimeExact(new Date('2026-11-14T04:30:45Z'))).toBe('23:30:45');
  });

  it('shifts dates cleanly across month, leap-year, and year boundaries', () => {
    expect(getPreviousDateStr('2026-01-01')).toBe('2025-12-31');
    expect(getPreviousDateStr('2026-03-01')).toBe('2026-02-28');
    expect(getPreviousDateStr('2024-03-01')).toBe('2024-02-29');
    expect(shiftDateStr('2026-11-13', 2)).toBe('2026-11-15');
  });

  it('applies server time offset to compute authoritative getServerNow even if device clock is skewed', () => {
    const localSkewedMs = Date.parse('2026-11-13T15:00:00Z');
    setServerTimeOffsetMs(3600_000); // server is +1 hour ahead
    expect(getServerTimeOffsetMs()).toBe(3600_000);
    expect(getServerNow(localSkewedMs).toISOString()).toBe('2026-11-13T16:00:00.000Z');

    setServerTimeOffsetMs(Number.NaN);
    expect(getServerTimeOffsetMs()).toBe(0);
  });
});
