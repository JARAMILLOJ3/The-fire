import { useEffect, useMemo, useState } from 'react';
import type { ShiftSchedule } from '../types';
import { getPreviousDateStr, getTodayDateStr } from '../utils/inventory';
import { resolveWorkerScheduleStatus, type WorkerScheduleStatus } from '../utils/schedule';

export interface ShiftClockState {
  scheduleStatus: WorkerScheduleStatus;
  todayStr: string;
  yesterdayStr: string;
}

export function useShiftClock(shiftSchedule?: ShiftSchedule): ShiftClockState {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(new Date());
    }, 30000);
    return () => window.clearInterval(id);
  }, []);

  const rawStatus = resolveWorkerScheduleStatus(now, shiftSchedule);
  const todayStr = getTodayDateStr(now);
  const yesterdayStr = getPreviousDateStr(todayStr);

  const scheduleKey = [
    rawStatus.phase,
    rawStatus.inGracePeriod ? '1' : '0',
    rawStatus.graceRemainingMinutes ?? '',
    rawStatus.operationalDate,
    rawStatus.openingRangeLabel,
    rawStatus.closingRangeLabel,
    rawStatus.currentTimeLabel,
    rawStatus.schedule.enabled ? '1' : '0',
  ].join('|');

  const scheduleStatus = useMemo(
    () => rawStatus,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduleKey],
  );

  return useMemo(
    () => ({
      scheduleStatus,
      todayStr,
      yesterdayStr,
    }),
    [scheduleStatus, todayStr, yesterdayStr],
  );
}
