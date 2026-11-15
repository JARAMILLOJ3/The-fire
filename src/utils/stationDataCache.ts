import type { DailyReport } from '../types';
import { shiftDateStr } from './date';

export interface ManagerDateWindow {
  liveDates: string[];
  historicalDates: string[];
  weekStart: string;
  lookbackStart: string;
}

export function computeManagerDateWindow(params: {
  todayStr: string;
  yesterdayStr: string;
  effectiveSelectedDate: string;
}): ManagerDateWindow {
  const { todayStr, yesterdayStr, effectiveSelectedDate } = params;
  const liveSet = new Set<string>([effectiveSelectedDate, todayStr]);
  const liveDates = Array.from(liveSet).sort();

  const weekStart = shiftDateStr(todayStr, -6);
  const lookbackStart = shiftDateStr(effectiveSelectedDate, -7);

  const histSet = new Set<string>();
  if (!liveSet.has(yesterdayStr)) {
    histSet.add(yesterdayStr);
  }
  for (let offset = -6; offset <= 0; offset += 1) {
    const d = shiftDateStr(todayStr, offset);
    if (!liveSet.has(d)) histSet.add(d);
  }
  for (let offset = -7; offset <= -1; offset += 1) {
    const d = shiftDateStr(effectiveSelectedDate, offset);
    if (!liveSet.has(d)) histSet.add(d);
  }

  return {
    liveDates,
    historicalDates: Array.from(histSet).sort(),
    weekStart,
    lookbackStart,
  };
}

export function planHistoricalReportIdsToFetch(params: {
  workspaceId: string;
  stationIds: string[];
  historicalDates: string[];
  yesterdayStr: string;
  liveReportsById: Record<string, DailyReport>;
  cachedReportsById: Record<string, DailyReport>;
  checkedMissingReportIds: Set<string>;
}): string[] {
  const {
    workspaceId,
    stationIds,
    historicalDates,
    yesterdayStr,
    liveReportsById,
    cachedReportsById,
    checkedMissingReportIds,
  } = params;

  const idsToFetch: string[] = [];
  for (const dateStr of historicalDates) {
    for (const stationId of stationIds) {
      const reportId = `${workspaceId}_${dateStr}_${stationId}`;
      if (liveReportsById[reportId]) continue;

      const cached = cachedReportsById[reportId];
      if (cached && cached.status === 'completed') continue;

      // For older missing dates beyond yesterday, avoid re-probing repeatedly on every date switch
      if (!cached && dateStr !== yesterdayStr && checkedMissingReportIds.has(reportId)) {
        continue;
      }

      idsToFetch.push(reportId);
    }
  }
  return idsToFetch;
}

export function getReportVersionMs(rep: DailyReport): number {
  return rep.updatedAt && typeof rep.updatedAt.toMillis === 'function'
    ? rep.updatedAt.toMillis()
    : 1;
}

export function planHistoricalEntryReportsToFetch(params: {
  allReports: DailyReport[];
  selectedDayReportIds: Set<string>;
  todayStr: string;
  effectiveSelectedDate: string;
  weekStart: string;
  lookbackStart: string;
  fetchedVersionById: Record<string, number>;
}): DailyReport[] {
  const {
    allReports,
    selectedDayReportIds,
    todayStr,
    effectiveSelectedDate,
    weekStart,
    lookbackStart,
    fetchedVersionById,
  } = params;

  return allReports.filter((rep) => {
    if (selectedDayReportIds.has(rep.id)) return false;
    const inWeeklyWindow = rep.date >= weekStart && rep.date <= todayStr;
    const inBaselineWindow = rep.date >= lookbackStart && rep.date < effectiveSelectedDate;
    if (!inWeeklyWindow && !inBaselineWindow) return false;
    const versionMs = getReportVersionMs(rep);
    return fetchedVersionById[rep.id] !== versionMs;
  });
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0 || items.length === 0) return items.length === 0 ? [] : [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
