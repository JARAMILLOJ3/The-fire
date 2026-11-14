import { DEFAULT_SHIFT_SCHEDULE, TIME_PATTERN } from '../constants';
import type { ShiftSchedule } from '../types';
import { getPreviousDateStr } from './inventory';

export type WorkerSchedulePhase = 'opening' | 'closing' | 'outside' | 'unrestricted';

export interface WorkerScheduleStatus {
  phase: WorkerSchedulePhase;
  operationalDate: string;
  schedule: ShiftSchedule;
  openingRangeLabel: string;
  closingRangeLabel: string;
  currentTimeLabel: string;
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

function formatDateLocal(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isTimeInWindow(
  nowMinutes: number,
  startHHMM: string,
  endHHMM: string,
): { inWindow: boolean; wrappedToPreviousDay: boolean } {
  const start = parseTimeToMinutes(startHHMM);
  const end = parseTimeToMinutes(endHHMM);

  if (start === end) {
    return { inWindow: true, wrappedToPreviousDay: false };
  }

  if (start < end) {
    // Same-day window (e.g. 16:00 -> 19:00)
    return {
      inWindow: nowMinutes >= start && nowMinutes <= end,
      wrappedToPreviousDay: false,
    };
  }

  // Overnight window (e.g. 23:00 -> 02:00)
  if (nowMinutes >= start) {
    return { inWindow: true, wrappedToPreviousDay: false };
  }
  if (nowMinutes <= end) {
    return { inWindow: true, wrappedToPreviousDay: true };
  }
  return { inWindow: false, wrappedToPreviousDay: false };
}

export function resolveWorkerScheduleStatus(
  now: Date,
  rawSchedule?: ShiftSchedule,
): WorkerScheduleStatus {
  const schedule = normalizeShiftSchedule(rawSchedule);
  const todayStr = formatDateLocal(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const openingRangeLabel = `${formatTime12h(schedule.openingStart)} – ${formatTime12h(schedule.openingEnd)}`;
  const closingRangeLabel = `${formatTime12h(schedule.closingStart)} – ${formatTime12h(schedule.closingEnd)}`;
  const currentTimeLabel = formatTime12h(nowHHMM);

  if (!schedule.enabled) {
    return {
      phase: 'unrestricted',
      operationalDate: todayStr,
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
  );
  if (openingCheck.inWindow) {
    return {
      phase: 'opening',
      operationalDate: openingCheck.wrappedToPreviousDay
        ? getPreviousDateStr(todayStr)
        : todayStr,
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
  );
  if (closingCheck.inWindow) {
    return {
      phase: 'closing',
      operationalDate: closingCheck.wrappedToPreviousDay
        ? getPreviousDateStr(todayStr)
        : todayStr,
      schedule,
      openingRangeLabel,
      closingRangeLabel,
      currentTimeLabel,
    };
  }

  // Outside both windows: if early morning before noon and closing ended earlier today, keep yesterday as reference if needed, or today
  return {
    phase: 'outside',
    operationalDate: todayStr,
    schedule,
    openingRangeLabel,
    closingRangeLabel,
    currentTimeLabel,
  };
}
