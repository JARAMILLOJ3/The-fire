import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIFT_SCHEDULE } from '../../constants';
import {
  formatTime12h,
  isTimeInWindow,
  resolveWorkerScheduleStatus,
  validateShiftSchedule,
} from '../schedule';

describe('schedule.ts (ventanas, medianoche y gracia de 10 min)', () => {
  it('treats upper window boundary as start of 10-min grace and closes at +10 min', () => {
    // Opening 16:00 - 18:00 (960 - 1080), grace 10 min -> closes at 18:10 (1090)
    expect(isTimeInWindow(16 * 60, '16:00', '18:00', 10)).toEqual({
      inWindow: true,
      inGrace: false,
      wrappedToPreviousDay: false,
      graceRemainingMinutes: null,
    });

    expect(isTimeInWindow(17 * 60 + 59, '16:00', '18:00', 10)).toEqual({
      inWindow: true,
      inGrace: false,
      wrappedToPreviousDay: false,
      graceRemainingMinutes: null,
    });

    // 18:00 enters grace with 10 min left
    expect(isTimeInWindow(18 * 60, '16:00', '18:00', 10)).toEqual({
      inWindow: true,
      inGrace: true,
      wrappedToPreviousDay: false,
      graceRemainingMinutes: 10,
    });

    // 18:09 still inside grace with 1 min left
    expect(isTimeInWindow(18 * 60 + 9, '16:00', '18:00', 10)).toEqual({
      inWindow: true,
      inGrace: true,
      wrappedToPreviousDay: false,
      graceRemainingMinutes: 1,
    });

    // 18:10 outside
    expect(isTimeInWindow(18 * 60 + 10, '16:00', '18:00', 10).inWindow).toBe(false);
  });

  it('handles overnight closing window (23:00 - 02:00 + 10 min grace) and wraps operational day after midnight', () => {
    // 23:30 Bogota = 04:30Z next UTC day
    const at2330 = resolveWorkerScheduleStatus(
      new Date('2026-11-14T04:30:00Z'),
      DEFAULT_SHIFT_SCHEDULE,
    );
    expect(at2330.phase).toBe('closing');
    expect(at2330.inGracePeriod).toBe(false);
    expect(at2330.operationalDate).toBe('2026-11-13');

    // 01:45 Bogota = 06:45Z -> counts toward operational day 2026-11-13
    const at0145 = resolveWorkerScheduleStatus(
      new Date('2026-11-14T06:45:00Z'),
      DEFAULT_SHIFT_SCHEDULE,
    );
    expect(at0145.phase).toBe('closing');
    expect(at0145.inGracePeriod).toBe(false);
    expect(at0145.operationalDate).toBe('2026-11-13');

    // 02:05 Bogota = 07:05Z -> 5 min into grace, still operational day 2026-11-13
    const at0205 = resolveWorkerScheduleStatus(
      new Date('2026-11-14T07:05:00Z'),
      DEFAULT_SHIFT_SCHEDULE,
    );
    expect(at0205.phase).toBe('closing');
    expect(at0205.inGracePeriod).toBe(true);
    expect(at0205.graceRemainingMinutes).toBe(5);
    expect(at0205.operationalDate).toBe('2026-11-13');

    // 02:10 Bogota = 07:10Z -> outside window
    const at0210 = resolveWorkerScheduleStatus(
      new Date('2026-11-14T07:10:00Z'),
      DEFAULT_SHIFT_SCHEDULE,
    );
    expect(at0210.phase).toBe('outside');
    expect(at0210.inGracePeriod).toBe(false);
    expect(at0210.graceRemainingMinutes).toBeNull();
  });

  it('supports opening phase and unrestricted mode', () => {
    // 16:30 Bogota = 21:30Z
    const at1630 = resolveWorkerScheduleStatus(
      new Date('2026-11-13T21:30:00Z'),
      DEFAULT_SHIFT_SCHEDULE,
    );
    expect(at1630.phase).toBe('opening');
    expect(at1630.operationalDate).toBe('2026-11-13');

    const unrestricted = resolveWorkerScheduleStatus(new Date('2026-11-13T15:00:00Z'), {
      ...DEFAULT_SHIFT_SCHEDULE,
      enabled: false,
    });
    expect(unrestricted.phase).toBe('unrestricted');
    expect(unrestricted.inGracePeriod).toBe(false);
  });

  it('validates shift schedules against overlaps, identical boundaries, and early closing warnings', () => {
    const validDefault = validateShiftSchedule(DEFAULT_SHIFT_SCHEDULE);
    expect(validDefault.valid).toBe(true);
    expect(validDefault.errors).toHaveLength(0);
    expect(validDefault.warnings).toHaveLength(0);

    const equalBounds = validateShiftSchedule({
      ...DEFAULT_SHIFT_SCHEDULE,
      openingStart: '16:00',
      openingEnd: '16:00',
    });
    expect(equalBounds.valid).toBe(false);
    expect(equalBounds.errors.length).toBeGreaterThan(0);

    const overlapping = validateShiftSchedule({
      enabled: true,
      openingStart: '16:00',
      openingEnd: '23:30',
      closingStart: '23:00',
      closingEnd: '02:00',
    });
    expect(overlapping.valid).toBe(false);
    expect(overlapping.errors[0]).toContain('cruzarse');

    const earlyClosing = validateShiftSchedule({
      enabled: true,
      openingStart: '10:00',
      openingEnd: '12:00',
      closingStart: '15:00',
      closingEnd: '17:00',
    });
    expect(earlyClosing.valid).toBe(true);
    expect(earlyClosing.warnings.length).toBe(1);
  });

  it('formats 24h strings to es-CO 12h labels', () => {
    expect(formatTime12h('16:00')).toBe('4:00 p. m.');
    expect(formatTime12h('02:00')).toBe('2:00 a. m.');
    expect(formatTime12h('00:05')).toBe('12:05 a. m.');
  });
});
