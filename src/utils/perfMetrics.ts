export interface PerfSnapshotSummary {
  paintSource: 'cache' | 'network' | 'unknown';
  timingsMs: {
    authReady?: number;
    linkPreview?: number;
    sessionResolved?: number;
    firstSheetPaint?: number;
    liveSyncComplete?: number;
  };
  totalReads: number;
  readsByTag: Record<string, number>;
  totalWrites: number;
  writesByTag: Record<string, number>;
  listenersOpened: number;
  activeListenersTotal: number;
  activeListenersByTag: Record<string, number>;
}

export interface PerfTracker {
  readonly enabled: boolean;
  reset: () => void;
  mark: (
    milestone: 'authReady' | 'linkPreview' | 'sessionResolved' | 'firstSheetPaint' | 'liveSyncComplete',
    options?: { paintSource?: 'cache' | 'network' },
  ) => void;
  recordRead: (tag: string, count?: number) => void;
  recordWrite: (tag: string, count?: number) => void;
  onListenerStart: (tag: string) => () => void;
  getSummary: () => PerfSnapshotSummary;
  logSummary: (reason?: string) => void;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function createPerfTracker(enabled: boolean): PerfTracker {
  let bootTimeMs = nowMs();
  let paintSource: 'cache' | 'network' | 'unknown' = 'unknown';
  let timingsMs: PerfSnapshotSummary['timingsMs'] = {};
  let readsByTag: Record<string, number> = {};
  let writesByTag: Record<string, number> = {};
  let totalReads = 0;
  let totalWrites = 0;
  let listenersOpened = 0;
  let activeListenersByTag: Record<string, number> = {};
  let loggedReason: string | null = null;

  const reset = () => {
    bootTimeMs = nowMs();
    paintSource = 'unknown';
    timingsMs = {};
    readsByTag = {};
    writesByTag = {};
    totalReads = 0;
    totalWrites = 0;
    listenersOpened = 0;
    activeListenersByTag = {};
    loggedReason = null;
  };

  const mark: PerfTracker['mark'] = (milestone, options) => {
    if (!enabled) return;
    if (timingsMs[milestone] === undefined) {
      timingsMs[milestone] = Math.max(0, Math.round(nowMs() - bootTimeMs));
    }
    if (milestone === 'firstSheetPaint' && options?.paintSource && paintSource === 'unknown') {
      paintSource = options.paintSource;
    }
  };

  const recordRead: PerfTracker['recordRead'] = (tag, count = 1) => {
    if (!enabled || count <= 0) return;
    totalReads += count;
    readsByTag[tag] = (readsByTag[tag] ?? 0) + count;
  };

  const recordWrite: PerfTracker['recordWrite'] = (tag, count = 1) => {
    if (!enabled || count <= 0) return;
    totalWrites += count;
    writesByTag[tag] = (writesByTag[tag] ?? 0) + count;
  };

  const onListenerStart: PerfTracker['onListenerStart'] = (tag) => {
    if (!enabled) return () => {};
    listenersOpened += 1;
    activeListenersByTag[tag] = (activeListenersByTag[tag] ?? 0) + 1;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const next = (activeListenersByTag[tag] ?? 0) - 1;
      if (next <= 0) {
        delete activeListenersByTag[tag];
      } else {
        activeListenersByTag[tag] = next;
      }
    };
  };

  const getSummary = (): PerfSnapshotSummary => {
    const activeListenersTotal = Object.values(activeListenersByTag).reduce((a, b) => a + b, 0);
    return {
      paintSource,
      timingsMs: { ...timingsMs },
      totalReads,
      readsByTag: { ...readsByTag },
      totalWrites,
      writesByTag: { ...writesByTag },
      listenersOpened,
      activeListenersTotal,
      activeListenersByTag: { ...activeListenersByTag },
    };
  };

  const logSummary: PerfTracker['logSummary'] = (reason = 'worker-ready') => {
    if (!enabled || loggedReason === reason) return;
    loggedReason = reason;
    const summary = getSummary();
    console.info(`[Perf Audit:${reason}]`, summary);
  };

  return {
    enabled,
    reset,
    mark,
    recordRead,
    recordWrite,
    onListenerStart,
    getSummary,
    logSummary,
  };
}

export const perfMetrics = createPerfTracker(Boolean(import.meta.env?.DEV));
