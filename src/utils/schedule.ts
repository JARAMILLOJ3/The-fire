import { DEFAULT_SHIFT_SCHEDULE, TIME_PATTERN, WORKER_GRACE_MINUTES } from '../constants';
import type { ShiftSchedule } from '../types';
import { getBogotaNowParts, getOperationalDateStr, getPreviousDateStr } from './date';

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

export function normalizeShiftSchedule(raw?: Partial<ShiftSchedule> | null): ShiftSchedule {
  if (!raw) return { ...DEFAULT_SHIFT_SCHEDULE };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SHIFT_SCHEDULE.enabled,
    openingStart:
      raw.openingStart && TIME_PATTERN.test(raw.openingStart)
        ? raw.openingStart
        : DEFAULT_SHIFT_SCHEDULE.openingStart,
    openingEnd:
      raw.openingEnd && TIME_PATTERN.test(raw.openingEnd)
        ? raw.openingEnd
        : DEFAULT_SHIFT_SCHEDULE.openingEnd,
    closingStart:
      raw.closingStart && TIME_PATTERN.test(raw.closingStart)
        ? raw.closingStart
        : DEFAULT_SHIFT_SCHEDULE.closingStart,
    closingEnd:
      raw.closingEnd && TIME_PATTERN.test(raw.closingEnd)
        ? raw.closingEnd
        : DEFAULT_SHIFT_SCHEDULE.closingEnd,
  };
}

export function parseTimeToMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
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
