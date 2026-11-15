// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPerfTracker } from '../perfMetrics';

describe('perfMetrics tracker', () => {
  it('tracks reads, writes, listener lifecycle, and milestones when enabled', () => {
    const tracker = createPerfTracker(true);

    tracker.recordRead('stationLinks');
    tracker.recordRead('items', 12);
    tracker.recordWrite('teamMembers', 1);

    const stopWs = tracker.onListenerStart('workspaces');
    const stopSt = tracker.onListenerStart('stations');
    const stopRep = tracker.onListenerStart('dailyReports');

    tracker.mark('authReady');
    tracker.mark('firstSheetPaint', { paintSource: 'cache' });

    const beforeStop = tracker.getSummary();
    expect(beforeStop.totalReads).toBe(13);
    expect(beforeStop.readsByTag).toEqual({ stationLinks: 1, items: 12 });
    expect(beforeStop.totalWrites).toBe(1);
    expect(beforeStop.listenersOpened).toBe(3);
    expect(beforeStop.activeListenersTotal).toBe(3);
    expect(beforeStop.paintSource).toBe('cache');
    expect(typeof beforeStop.timingsMs.authReady).toBe('number');
    expect(typeof beforeStop.timingsMs.firstSheetPaint).toBe('number');

    // Stopping a listener twice is idempotent and cleans up zeroed tags
    stopSt();
    stopSt();
    const afterOneStop = tracker.getSummary();
    expect(afterOneStop.activeListenersTotal).toBe(2);
    expect(afterOneStop.activeListenersByTag.stations).toBeUndefined();

    stopWs();
    stopRep();
    expect(tracker.getSummary().activeListenersTotal).toBe(0);
    expect(tracker.getSummary().listenersOpened).toBe(3);
  });

  it('acts as a zero-cost no-op when disabled (production build)', () => {
    const tracker = createPerfTracker(false);
    tracker.recordRead('items', 10);
    tracker.recordWrite('teamMembers', 2);
    const stop = tracker.onListenerStart('workspaces');
    tracker.mark('firstSheetPaint', { paintSource: 'network' });
    stop();

    const summary = tracker.getSummary();
    expect(summary.totalReads).toBe(0);
    expect(summary.totalWrites).toBe(0);
    expect(summary.listenersOpened).toBe(0);
    expect(summary.activeListenersTotal).toBe(0);
    expect(summary.paintSource).toBe('unknown');
  });
});
