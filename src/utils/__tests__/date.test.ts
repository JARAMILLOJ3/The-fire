import { describe, expect, it } from 'vitest';
import {
  getBogotaNowParts,
  getOperationalDateStr,
  getPreviousDateStr,
  shiftDateStr,
} from '../date';

describe('date.ts (America/Bogota UTC-5)', () => {
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

  it('assigns times before 06:00 AM Bogota to the previous operational day', () => {
    // 2026-11-14 01:45 Bogota === 2026-11-14 06:45 UTC
    expect(getOperationalDateStr(new Date('2026-11-14T06:45:00Z'))).toBe('2026-11-13');
    // 2026-11-14 05:59 Bogota === 2026-11-14 10:59 UTC
    expect(getOperationalDateStr(new Date('2026-11-14T10:59:00Z'))).toBe('2026-11-13');
    // 2026-11-14 06:00 Bogota === 2026-11-14 11:00 UTC
    expect(getOperationalDateStr(new Date('2026-11-14T11:00:00Z'))).toBe('2026-11-14');
  });

  it('shifts dates cleanly across month, leap-year, and year boundaries', () => {
    expect(getPreviousDateStr('2026-01-01')).toBe('2025-12-31');
    expect(getPreviousDateStr('2026-03-01')).toBe('2026-02-28');
    expect(getPreviousDateStr('2024-03-01')).toBe('2024-02-29');
    expect(shiftDateStr('2026-11-13', 2)).toBe('2026-11-15');
  });
});
