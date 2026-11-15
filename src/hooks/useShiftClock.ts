import { useEffect, useMemo, useState } from 'react';
import type { ShiftSchedule } from '../types';
import { getServerNow, syncServerClockOffset } from '../utils/date';
import { getPreviousDateStr, getTodayDateStr } from '../utils/inventory';
import {
  getNextScheduleTransitionMs,
  resolveWorkerScheduleStatus,
  type WorkerScheduleStatus,
} from '../utils/schedule';

export interface ShiftClockState {
  scheduleStatus: WorkerScheduleStatus;
  todayStr: string;
  yesterdayStr: string;
  now: Date;
}

export function useShiftClock(shiftSchedule?: ShiftSchedule): ShiftClockState {
  const [now, setNow] = useState<Date>(() => getServerNow());

  useEffect(() => {
    let active = true;
    const refreshFromServer = (force = false) => {
      void syncServerClockOffset(force).then(() => {
        if (active) {
          setNow(getServerNow());
        }
      });
    };

    refreshFromServer(true);

    const handleFocusOrOnline = () => {
      setNow(getServerNow());
      refreshFromServer(false);
    };

    window.addEventListener('focus', handleFocusOrOnline);
    window.addEventListener('online', handleFocusOrOnline);

    const intervalId = window.setInterval(() => {
      setNow(getServerNow());
    }, 15000);

    return () => {
      active = false;
      window.removeEventListener('focus', handleFocusOrOnline);
      window.removeEventListener('online', handleFocusOrOnline);
      window.clearInterval(intervalId);
    };
  }, []);

  // Re-evaluate automatically at the exact next schedule phase transition boundary
  useEffect(() => {
    const delayMs = getNextScheduleTransitionMs(now, shiftSchedule);
    const timeoutId = window.setTimeout(() => {
      setNow(getServerNow());
    }, delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [now, shiftSchedule]);

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
      now,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduleStatus, todayStr, yesterdayStr],
  );
}
