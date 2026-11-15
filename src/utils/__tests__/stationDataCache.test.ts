import { describe, expect, it } from 'vitest';
import type { DailyReport } from '../../types';
import {
  chunkArray,
  computeManagerDateWindow,
  planHistoricalEntryReportsToFetch,
  planHistoricalReportIdsToFetch,
} from '../stationDataCache';

function makeReport(partial: Partial<DailyReport> & { id: string; date: string }): DailyReport {
  return {
    workspaceId: 'ws_1',
    ownerUid: 'owner_1',
    authorizedEmails: ['boss@test.com'],
    station: 'mesera',
    status: 'completed',
    reportedByUid: 'u1',
    reportedByName: 'Ana',
    notes: '',
    ...partial,
  };
}

describe('stationDataCache', () => {
  it('computes disjoint liveDates and historicalDates covering yesterday, 7-day week, and 7-day baseline', () => {
    const win = computeManagerDateWindow({
      todayStr: '2026-11-15',
      yesterdayStr: '2026-11-14',
      effectiveSelectedDate: '2026-11-10',
    });

    expect(win.liveDates).toEqual(['2026-11-10', '2026-11-15']);
    expect(win.weekStart).toBe('2026-11-09');
    expect(win.lookbackStart).toBe('2026-11-03');
    // Live dates must not be duplicated in historicalDates
    win.liveDates.forEach((d) => {
      expect(win.historicalDates).not.toContain(d);
    });
    expect(win.historicalDates).toContain('2026-11-14');
    expect(win.historicalDates).toContain('2026-11-03');
    expect(win.historicalDates).toContain('2026-11-09');
  });

  it('skips completed historical reports and previously checked missing older dates', () => {
    const completedRep = makeReport({
      id: 'ws_1_2026-11-12_mesera',
      date: '2026-11-12',
      status: 'completed',
    });
    const openRep = makeReport({
      id: 'ws_1_2026-11-13_mesera',
      date: '2026-11-13',
      status: 'opening_saved',
    });
    const liveRep = makeReport({
      id: 'ws_1_2026-11-14_mesera',
      date: '2026-11-14',
      status: 'completed',
    });

    const ids = planHistoricalReportIdsToFetch({
      workspaceId: 'ws_1',
      stationIds: ['mesera'],
      historicalDates: ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'],
      yesterdayStr: '2026-11-14',
      liveReportsById: { [liveRep.id]: liveRep },
      cachedReportsById: {
        [completedRep.id]: completedRep,
        [openRep.id]: openRep,
      },
      checkedMissingReportIds: new Set(['ws_1_2026-11-11_mesera']),
    });

    // 2026-11-11 skipped (older missing), 2026-11-12 skipped (completed),
    // 2026-11-13 kept (not completed yet), 2026-11-14 skipped (live listener active)
    expect(ids).toEqual(['ws_1_2026-11-13_mesera']);
  });

  it('always allows re-checking yesterday missing reports until closed or created', () => {
    const ids = planHistoricalReportIdsToFetch({
      workspaceId: 'ws_1',
      stationIds: ['cocina'],
      historicalDates: ['2026-11-14'],
      yesterdayStr: '2026-11-14',
      liveReportsById: {},
      cachedReportsById: {},
      checkedMissingReportIds: new Set(['ws_1_2026-11-14_cocina']),
    });

    expect(ids).toEqual(['ws_1_2026-11-14_cocina']);
  });

  it('skips entry fetches for selected-day live reports and matching cached versions', () => {
    const repOld = makeReport({ id: 'r1', date: '2026-11-12' });
    const repSelected = makeReport({ id: 'r2', date: '2026-11-15' });
    const repNew = makeReport({ id: 'r3', date: '2026-11-13' });

    const toFetch = planHistoricalEntryReportsToFetch({
      allReports: [repOld, repSelected, repNew],
      selectedDayReportIds: new Set(['r2']),
      todayStr: '2026-11-15',
      effectiveSelectedDate: '2026-11-15',
      weekStart: '2026-11-09',
      lookbackStart: '2026-11-08',
      fetchedVersionById: { r1: 1 },
    });

    expect(toFetch.map((r) => r.id)).toEqual(['r3']);
  });

  it('chunks arrays cleanly for bounded parallel reads', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 4)).toEqual([]);
  });
});
