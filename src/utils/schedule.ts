import { DEFAULT_SHIFT_SCHEDULE, TIME_PATTERN, WORKER_GRACE_MINUTES } from '../constants';
import type { ShiftSchedule } from '../types';
import {
  getBogotaNowParts,
  getOperationalDateStr,
  getPreviousDateStr,
  OPERATIONAL_DAY_CUTOFF_HOUR,
} from './date';

export type WorkerSchedulePhase = 'opening' | 'closing' | 'outside' | 'unrestricted';

export interface WorkerScheduleStatus {
  phase: WorkerSchedulePhase;
  inGracePeriod: boolean;
  graceRemainingMinutes: number | null;
  operationalDate: string;
  schedule: ShiftSchedule;
  openingRangeLabel: string;
  closingRangeLabel: string;
  currentTimeLabel: string;
}

export interface ShiftScheduleValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const FLEXIBLE_TIME_PATTERN = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;

export function normalizeTimeHHMM(raw?: string | null, fallback = '00:00'): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (TIME_PATTERN.test(trimmed)) return trimmed;
  const match = FLEXIBLE_TIME_PATTERN.exec(trimmed);
  if (match) {
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }
  return fallback;
}

export function normalizeShiftSchedule(raw?: Partial<ShiftSchedule> | null): ShiftSchedule {
  if (!raw) return { ...DEFAULT_SHIFT_SCHEDULE };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SHIFT_SCHEDULE.enabled,
    openingStart: normalizeTimeHHMM(raw.openingStart, DEFAULT_SHIFT_SCHEDULE.openingStart),
    openingEnd: normalizeTimeHHMM(raw.openingEnd, DEFAULT_SHIFT_SCHEDULE.openingEnd),
    closingStart: normalizeTimeHHMM(raw.closingStart, DEFAULT_SHIFT_SCHEDULE.closingStart),
    closingEnd: normalizeTimeHHMM(raw.closingEnd, DEFAULT_SHIFT_SCHEDULE.closingEnd),
  };
}

export function parseTimeToMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.trim().split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

export function formatTime12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h >= 12 ? 'p. m.' : 'a. m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mPad = String(m).padStart(2, '0');
  return `${h12}:${mPad} ${period}`;
}

export function isTimeInWindow(
  nowMinutes: number,
  startHHMM: string,
  endHHMM: string,
  graceMinutes = 0,
): {
  inWindow: boolean;
  inGrace: boolean;
  wrappedToPreviousDay: boolean;
  graceRemainingMinutes: number | null;
} {
  const start = parseTimeToMinutes(startHHMM);
  const end = parseTimeToMinutes(endHHMM);

  if (start === end) {
    return { inWindow: false, inGrace: false, wrappedToPreviousDay: false, graceRemainingMinutes: null };
  }

  const span = (end - start + 1440) % 1440;
  const elapsed = (nowMinutes - start + 1440) % 1440;

  if (elapsed < span) {
    const wrappedToPreviousDay = start > end && nowMinutes < end;
    return { inWindow: true, inGrace: false, wrappedToPreviousDay, graceRemainingMinutes: null };
  }

  if (graceMinutes > 0 && elapsed < span + graceMinutes) {
    const endWithGrace = (end + graceMinutes) % 1440;
    const wrappedToPreviousDay =
      (start > end && nowMinutes < endWithGrace) ||
      (start < end && end + graceMinutes >= 1440 && nowMinutes < endWithGrace);
    return {
      inWindow: true,
      inGrace: true,
      wrappedToPreviousDay,
      graceRemainingMinutes: span + graceMinutes - elapsed,
    };
  }

  return { inWindow: false, inGrace: false, wrappedToPreviousDay: false, graceRemainingMinutes: null };
}

export function validateShiftSchedule(schedule: ShiftSchedule): ShiftScheduleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (
    !TIME_PATTERN.test(schedule.openingStart) ||
    !TIME_PATTERN.test(schedule.openingEnd) ||
    !TIME_PATTERN.test(schedule.closingStart) ||
    !TIME_PATTERN.test(schedule.closingEnd)
  ) {
    errors.push('Todas las horas deben tener un formato válido (HH:MM).');
    return { valid: false, errors, warnings };
  }

  if (!schedule.enabled) {
    return { valid: true, errors, warnings };
  }

  const openStart = parseTimeToMinutes(schedule.openingStart);
  const openEnd = parseTimeToMinutes(schedule.openingEnd);
  const closeStart = parseTimeToMinutes(schedule.closingStart);
  const closeEnd = parseTimeToMinutes(schedule.closingEnd);

  if (openStart === openEnd) {
    errors.push('La hora de inicio y fin de apertura no pueden ser iguales.');
  }
  if (closeStart === closeEnd) {
    errors.push('La hora de inicio y fin de cierre no pueden ser iguales.');
  }

  if (errors.length === 0) {
    const openSpan = (openEnd - openStart + 1440) % 1440;
    const closeSpan = (closeEnd - closeStart + 1440) % 1440;
    let overlaps = false;
    for (let m = 0; m < 1440; m++) {
      const inOpen = (m - openStart + 1440) % 1440 < openSpan;
      const inClose = (m - closeStart + 1440) % 1440 < closeSpan;
      if (inOpen && inClose) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) {
      errors.push('El horario de apertura y el horario de cierre no pueden cruzarse.');
    }
  }

  // Non-blocking warning if closing starts during daytime before 6:00 PM
  if (closeStart >= 6 * 60 && closeStart < 18 * 60) {
    warnings.push(
      'El horario de cierre inicia antes de las 6:00 p. m. Confirma si deseas permitir cierres tan temprano.',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function resolveWorkerScheduleStatus(
  now: Date,
  rawSchedule?: ShiftSchedule,
): WorkerScheduleStatus {
  const schedule = normalizeShiftSchedule(rawSchedule);
  const bogota = getBogotaNowParts(now);
  const operationalToday = getOperationalDateStr(now);
  const nowMinutes = bogota.totalMinutes;

  const openingRangeLabel = `${formatTime12h(schedule.openingStart)} – ${formatTime12h(schedule.openingEnd)}`;
  const closingRangeLabel = `${formatTime12h(schedule.closingStart)} – ${formatTime12h(schedule.closingEnd)}`;
  const currentTimeLabel = formatTime12h(bogota.hhmm);

  if (!schedule.enabled) {
    return {
      phase: 'unrestricted',
      inGracePeriod: false,
      graceRemainingMinutes: null,
      operationalDate: operationalToday,
      schedule,
      openingRangeLabel,
      closingRangeLabel,
      currentTimeLabel,
    };
  }

  const openingCheck = isTimeInWindow(
    nowMinutes,
    schedule.openingStart,
    schedule.openingEnd,
    WORKER_GRACE_MINUTES,
  );
  if (openingCheck.inWindow) {
    return {
      phase: 'opening',
      inGracePeriod: openingCheck.inGrace,
      graceRemainingMinutes: openingCheck.graceRemainingMinutes,
      operationalDate: openingCheck.wrappedToPreviousDay
        ? getPreviousDateStr(bogota.dateStr)
        : operationalToday,
      schedule,
      openingRangeLabel,
      closingRangeLabel,
      currentTimeLabel,
    };
  }

  const closingCheck = isTimeInWindow(
    nowMinutes,
    schedule.closingStart,
    schedule.closingEnd,
    WORKER_GRACE_MINUTES,
  );
  if (closingCheck.inWindow) {
    return {
      phase: 'closing',
      inGracePeriod: closingCheck.inGrace,
      graceRemainingMinutes: closingCheck.graceRemainingMinutes,
      operationalDate: closingCheck.wrappedToPreviousDay
        ? getPreviousDateStr(bogota.dateStr)
        : operationalToday,
      schedule,
      openingRangeLabel,
      closingRangeLabel,
      currentTimeLabel,
    };
  }

  return {
    phase: 'outside',
    inGracePeriod: false,
    graceRemainingMinutes: null,
    operationalDate: operationalToday,
    schedule,
    openingRangeLabel,
    closingRangeLabel,
    currentTimeLabel,
  };
}

export function getNextScheduleWindowInfo(
  now: Date,
  rawSchedule?: ShiftSchedule,
): {
  windowName: 'Apertura' | 'Cierre';
  startLabel: string;
  dayLabel: 'Hoy' | 'Mañana';
  minutesUntil: number;
} {
  const schedule = normalizeShiftSchedule(rawSchedule);
  const bogota = getBogotaNowParts(now);
  const nowMinutes = bogota.totalMinutes;

  const openStartMin = parseTimeToMinutes(schedule.openingStart);
  const closeStartMin = parseTimeToMinutes(schedule.closingStart);

  const deltaOpen = (openStartMin - nowMinutes + 1440) % 1440 || 1440;
  const deltaClose = (closeStartMin - nowMinutes + 1440) % 1440 || 1440;

  if (deltaOpen <= deltaClose) {
    return {
      windowName: 'Apertura',
      startLabel: formatTime12h(schedule.openingStart),
      dayLabel: nowMinutes + deltaOpen >= 1440 ? 'Mañana' : 'Hoy',
      minutesUntil: deltaOpen,
    };
  }

  return {
    windowName: 'Cierre',
    startLabel: formatTime12h(schedule.closingStart),
    dayLabel: nowMinutes + deltaClose >= 1440 ? 'Mañana' : 'Hoy',
    minutesUntil: deltaClose,
  };
}

export function hasClosingDeadlinePassed(
  now: Date,
  targetOperationalDate: string,
  rawSchedule?: ShiftSchedule,
  graceMinutes: number = WORKER_GRACE_MINUTES,
): boolean {
  const schedule = normalizeShiftSchedule(rawSchedule);
  if (!schedule.enabled) return false;

  const operationalToday = getOperationalDateStr(now);
  if (targetOperationalDate > operationalToday) return false;
  if (targetOperationalDate < operationalToday) return true;

  const bogota = getBogotaNowParts(now);
  const cutoffMin = OPERATIONAL_DAY_CUTOFF_HOUR * 60;
  const toOpOffset = (min: number) => (min - cutoffMin + 1440) % 1440;

  const nowOffset = toOpOffset(bogota.totalMinutes);
  const closeStartOffset = toOpOffset(parseTimeToMinutes(schedule.closingStart));
  let closeEndOffset = toOpOffset(parseTimeToMinutes(schedule.closingEnd));
  if (closeEndOffset <= closeStartOffset) {
    closeEndOffset += 1440;
  }

  return nowOffset >= closeEndOffset + graceMinutes;
}

export function isClosingWindowStarted(
  now: Date,
  targetOperationalDate: string,
  rawSchedule?: ShiftSchedule,
): boolean {
  const schedule = normalizeShiftSchedule(rawSchedule);
  if (!schedule.enabled) return true;

  const operationalToday = getOperationalDateStr(now);
  if (targetOperationalDate < operationalToday) return true;
  if (targetOperationalDate > operationalToday) return false;

  const bogota = getBogotaNowParts(now);
  const cutoffMin = OPERATIONAL_DAY_CUTOFF_HOUR * 60;
  const toOpOffset = (min: number) => (min - cutoffMin + 1440) % 1440;

  const nowOffset = toOpOffset(bogota.totalMinutes);
  const closeStartOffset = toOpOffset(parseTimeToMinutes(schedule.closingStart));
  return nowOffset >= closeStartOffset;
}

export function getNextScheduleTransitionMs(
  now: Date,
  rawSchedule?: ShiftSchedule,
  graceMinutes: number = WORKER_GRACE_MINUTES,
): number {
  const schedule = normalizeShiftSchedule(rawSchedule);
  const bogota = getBogotaNowParts(now);
  const nowSecInDay = bogota.totalMinutes * 60 + now.getUTCSeconds();

  const boundariesMin = [OPERATIONAL_DAY_CUTOFF_HOUR * 60];
  if (schedule.enabled) {
    boundariesMin.push(
      parseTimeToMinutes(schedule.openingStart),
      (parseTimeToMinutes(schedule.openingEnd) + graceMinutes) % 1440,
      parseTimeToMinutes(schedule.closingStart),
      (parseTimeToMinutes(schedule.closingEnd) + graceMinutes) % 1440,
    );
  }

  let minDeltaSec = 86400;
  boundariesMin.forEach((bMin) => {
    const bSec = ((bMin % 1440) + 1440) % 1440 * 60;
    const delta = (bSec - nowSecInDay + 86400) % 86400 || 86400;
    if (delta < minDeltaSec) {
      minDeltaSec = delta;
    }
  });

  const deltaMs = minDeltaSec * 1000 - now.getUTCMilliseconds() + 150;
  return Math.max(500, deltaMs);
}

