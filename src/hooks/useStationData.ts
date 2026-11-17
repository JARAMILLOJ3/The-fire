import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  fetchReportEntriesOnce,
  fetchStationItemsOnce,
  loadWorkerStationFallback,
} from '../services/workerService';
import { getPacksItemsNeedingUnitMigration } from '../utils/inventory';
import { perfMetrics } from '../utils/perfMetrics';
import {
  chunkArray,
  computeManagerDateWindow,
  getReportVersionMs,
  planHistoricalEntryReportsToFetch,
  planHistoricalReportIdsToFetch,
} from '../utils/stationDataCache';
import {
  getTimestampMs,
  readStationCatalogCache,
  readWorkerSnapshotCache,
  writeStationCatalogCache,
  writeWorkerSnapshotCache,
} from '../utils/workerCache';
import { sortWorkerNotesNewestFirst } from '../utils/workerNotes';
import type {
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  Invite,
  PacksUnitMigrationRecord,
  StationId,
  StationLink,
  TeamMember,
  TeamStationId,
  WorkerNote,
  Workspace,
  Workstation,
} from '../types';
import { normalizeStationId, type OptimisticStationContext } from './useWorkspaceSession';

interface WorkerFallbackState {
  station: Workstation | null;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entries: Record<string, DailyReportEntry>;
}

export interface PacksMigrationState {
  status: 'idle' | 'running' | 'error';
  processed: number;
  total: number;
  errorMessage: string | null;
  remainingItems: InventoryItem[];
}

const IDLE_PACKS_MIGRATION: PacksMigrationState = {
  status: 'idle',
  processed: 0,
  total: 0,
  errorMessage: null,
  remainingItems: [],
};

const REPORT_FETCH_CHUNK_SIZE = 6;
const ENTRY_FETCH_CHUNK_SIZE = 6;

export function useStationData(params: {
  authReady: boolean;
  user: User | null;
  workspace: Workspace | null;
  canManage: boolean;
  role: TeamStationId;
  optimisticStationContext?: OptimisticStationContext | null;
  effectiveSelectedDate: string;
  todayStr: string;
  yesterdayStr: string;
}) {
  const {
    authReady,
    user,
    workspace,
    canManage,
    role,
    optimisticStationContext = null,
    effectiveSelectedDate,
    todayStr,
    yesterdayStr,
  } = params;

  const userUid = user?.uid ?? null;
  const userEmail = (user?.email ?? '').trim().toLowerCase();

  // In worker mode, allow station/report listeners to start in parallel with resolveUserWorkspace
  // as soon as optimisticStationContext (from QR link) is known.
  const targetWorkspaceId = workspace?.id ?? optimisticStationContext?.workspaceId ?? null;
  const targetRole: TeamStationId = workspace
    ? role
    : optimisticStationContext?.stationId ?? 'jefe';
  const targetCanManage = workspace ? canManage : false;
  const isWorkerTarget = !targetCanManage && targetRole !== 'jefe';

  const [stations, setStations] = useState<Workstation[]>([]);
  const [stationsLoaded, setStationsLoaded] = useState(false);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);

  const [liveReportsById, setLiveReportsById] = useState<Record<string, DailyReport>>({});
  const [historicalReportsById, setHistoricalReportsById] = useState<Record<string, DailyReport>>(
    {},
  );
  const [reportsLoaded, setReportsLoaded] = useState(false);
  const [reportHasPendingWrites, setReportHasPendingWrites] = useState(false);

  const [entriesByReportId, setEntriesByReportId] = useState<
    Record<string, Record<string, DailyReportEntry>>
  >({});
  const [historicalEntriesByReportId, setHistoricalEntriesByReportId] = useState<
    Record<string, Record<string, DailyReportEntry>>
  >({});
  const [invites, setInvites] = useState<Invite[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [stationLinksByCode, setStationLinksByCode] = useState<Record<string, StationLink>>({});
  const [workerNotes, setWorkerNotes] = useState<WorkerNote[]>([]);
  const [workerFallback, setWorkerFallback] = useState<WorkerFallbackState | null>(null);
  const [migratedPacksNotice, setMigratedPacksNotice] = useState<PacksUnitMigrationRecord[]>([]);
  const [packsMigrationState, setPacksMigrationState] = useState<PacksMigrationState>(IDLE_PACKS_MIGRATION);
  const [migratedPacksIds, setMigratedPacksIds] = useState<string[]>([]);

  const isWorkspaceOwner = Boolean(workspace?.ownerUid && userUid && workspace.ownerUid === userUid);

  const migrationAttemptedRef = useRef<string | null>(null);
  const packsUnitMigratedIdsRef = useRef<Set<string>>(new Set());
  const packsUnitMigrationWorkspaceRef = useRef<string | null>(null);
  const syncingEmailsKeyRef = useRef<string>('');
  const fetchedHistoryVersionRef = useRef<Record<string, number>>({});
  const historicalReportsRef = useRef<Record<string, DailyReport>>({});
  const checkedMissingReportsRef = useRef<Set<string>>(new Set());

  const isWorkspaceConfirmed = Boolean(workspace?.id);
  const workspaceConfirmedRef = useRef(isWorkspaceConfirmed);
  workspaceConfirmedRef.current = isWorkspaceConfirmed;

  const optimisticStationFailedRef = useRef(false);
  const optimisticReportFailedRef = useRef(false);
  const optimisticNotesFailedRef = useRef(false);
  const optimisticItemsFailedRef = useRef(false);
  const [optimisticRetryTick, setOptimisticRetryTick] = useState(0);

  useEffect(() => {
    if (!isWorkspaceConfirmed) return;
    if (
      optimisticStationFailedRef.current ||
      optimisticReportFailedRef.current ||
      optimisticNotesFailedRef.current ||
      optimisticItemsFailedRef.current
    ) {
      optimisticStationFailedRef.current = false;
      optimisticReportFailedRef.current = false;
      optimisticNotesFailedRef.current = false;
      optimisticItemsFailedRef.current = false;
      setOptimisticRetryTick((c) => c + 1);
    }
  }, [isWorkspaceConfirmed]);

  const workerHydratedKeyRef = useRef<string>('');
  const syncedWorkerItemsKeyRef = useRef<string>('');
  const syncedWorkerEntriesKeyRef = useRef<string>('');
  const itemsRef = useRef<InventoryItem[]>([]);
  const entriesByReportIdRef = useRef<Record<string, Record<string, DailyReportEntry>>>({});

  useEffect(() => {
    historicalReportsRef.current = historicalReportsById;
  }, [historicalReportsById]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    entriesByReportIdRef.current = entriesByReportId;
  }, [entriesByReportId]);

  // Reset state cleanly on sign-out or missing target workspace
  useEffect(() => {
    if (userUid && targetWorkspaceId) return;
    setStations([]);
    setStationsLoaded(false);
    setItems([]);
    setItemsLoaded(false);
    setLiveReportsById({});
    setHistoricalReportsById({});
    setReportsLoaded(false);
    setReportHasPendingWrites(false);
    setEntriesByReportId({});
    setHistoricalEntriesByReportId({});
    fetchedHistoryVersionRef.current = {};
    historicalReportsRef.current = {};
    checkedMissingReportsRef.current = new Set();
    workerHydratedKeyRef.current = '';
    syncedWorkerItemsKeyRef.current = '';
    syncedWorkerEntriesKeyRef.current = '';
    setInvites([]);
    setMembers([]);
    setStationLinksByCode({});
    setWorkerNotes([]);
    setWorkerFallback(null);
    setMigratedPacksNotice([]);
    setPacksMigrationState(IDLE_PACKS_MIGRATION);
    setMigratedPacksIds([]);
    packsUnitMigratedIdsRef.current = new Set();
    packsUnitMigrationWorkspaceRef.current = null;
  }, [userUid, targetWorkspaceId]);

  // Effect 0: Instant worker local cache hydration (0ms sheet paint while live listeners sync)
  useEffect(() => {
    if (!authReady || !userUid || !targetWorkspaceId || !isWorkerTarget) return;
    const hydrateKey = `${userUid}:${targetWorkspaceId}:${targetRole}:${effectiveSelectedDate}`;
    if (workerHydratedKeyRef.current === hydrateKey) return;

    const cached = readWorkerSnapshotCache(userUid);
    if (cached && cached.workspace.id === targetWorkspaceId && cached.role === targetRole) {
      workerHydratedKeyRef.current = hydrateKey;

      if (cached.station) {
        setStations([cached.station]);
        setStationsLoaded(true);
      }
      if (cached.items.length > 0 || cached.station) {
        setItems(cached.items);
        setItemsLoaded(true);
      }
      if (cached.dateStr === effectiveSelectedDate) {
        if (cached.todayReport) {
          setLiveReportsById({ [cached.todayReport.id]: cached.todayReport });
          setEntriesByReportId({ [cached.todayReport.id]: cached.todayEntries });
          const repUpdatedMs = cached.todayReportUpdatedAtMs;
          const cachedItemIdsKey = cached.items.map((i) => i.id).join('|');
          if (repUpdatedMs !== null) {
            syncedWorkerEntriesKeyRef.current = `${cached.todayReport.id}:${repUpdatedMs}:${cachedItemIdsKey}`;
          }
        } else {
          setLiveReportsById({});
          setEntriesByReportId({});
        }
        setReportsLoaded(true);
      }
      if (cached.workerNotes.length > 0) {
        setWorkerNotes(cached.workerNotes);
      }
      return;
    }

    const catalogCached = readStationCatalogCache(targetWorkspaceId, targetRole);
    if (catalogCached) {
      workerHydratedKeyRef.current = hydrateKey;
      if (catalogCached.station) {
        setStations([catalogCached.station]);
        setStationsLoaded(true);
      }
      if (catalogCached.items.length > 0 || catalogCached.station) {
        setItems(catalogCached.items);
        setItemsLoaded(true);
      }
    }
  }, [authReady, userUid, targetWorkspaceId, isWorkerTarget, targetRole, effectiveSelectedDate]);

  // Effect 1A: Static workspace collections for managers ONLY (never run for workers)
  useEffect(() => {
    if (!authReady || !userUid || !workspace?.id || !canManage) return;
    if (!isWorkspaceOwner && !userEmail) return;
    setStationsLoaded(false);
    setItemsLoaded(false);

    const stopStationsMetric = perfMetrics.onListenerStart('stations_list');
    const stationsQuery = query(
      collection(db, 'stations'),
      isWorkspaceOwner
        ? where('ownerUid', '==', userUid)
        : where('authorizedEmails', 'array-contains', userEmail),
    );
    const unsubStations = onSnapshot(
      stationsQuery,
      (snap) => {
        const list: Workstation[] = [];
        snap.forEach((d) => {
          const st = { id: d.id, ...d.data() } as Workstation;
          if (st.workspaceId === workspace.id && st.active) {
            list.push(st);
          }
        });
        list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        setStations(list);
        setStationsLoaded(true);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'stations'),
    );

    const stopItemsMetric = perfMetrics.onListenerStart('items_list');
    const itemsQuery = query(
      collection(db, 'items'),
      isWorkspaceOwner
        ? where('ownerUid', '==', userUid)
        : where('authorizedEmails', 'array-contains', userEmail),
    );
    const unsubItems = onSnapshot(
      itemsQuery,
      (snap) => {
        const list: InventoryItem[] = [];
        snap.forEach((d) => {
          const raw = d.data() as Omit<InventoryItem, 'id'>;
          const item: InventoryItem = {
            ...raw,
            id: d.id,
            station: normalizeStationId(raw.station),
          };
          if (item.workspaceId === workspace.id) {
            list.push(item);
          }
        });
        list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        setItems(list);
        setItemsLoaded(true);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'items'),
    );

    return () => {
      stopStationsMetric();
      stopItemsMetric();
      unsubStations();
      unsubItems();
    };
  }, [authReady, userUid, workspace?.id, canManage, isWorkspaceOwner, userEmail]);

  // Effect 1B: Worker static station listener (single doc, never torn down on date switch)
  useEffect(() => {
    if (!authReady || !userUid || !targetWorkspaceId || !isWorkerTarget) return;

    const stopMetric = perfMetrics.onListenerStart('stations');
    const unsubStation = onSnapshot(
      doc(db, 'stations', targetRole),
      (snap) => {
        optimisticStationFailedRef.current = false;
        if (snap.exists()) {
          const st = { id: snap.id, ...snap.data() } as Workstation;
          setStations(st.workspaceId === targetWorkspaceId && st.active ? [st] : []);
        } else {
          setStations([]);
        }
        setStationsLoaded(true);
      },
      (err) => {
        if (!workspaceConfirmedRef.current) {
          // Optimistic listener started before teamMembers/{uid} finished creating in resolveUserWorkspace
          optimisticStationFailedRef.current = true;
          return;
        }
        console.warn('[Firestore] Station listener fallback activated:', err);
        setStationsLoaded(true);
        void loadWorkerStationFallback({
          workspaceId: targetWorkspaceId,
          stationId: targetRole,
          dateStr: effectiveSelectedDate,
        })
          .then((fb) => {
            setWorkerFallback(fb);
            if (fb.station) {
              setStations([fb.station]);
            }
            if (fb.items.length > 0) {
              setItems(fb.items);
            }
            setItemsLoaded(true);
          })
          .catch(() => {
            setItemsLoaded(true);
          });
      },
    );

    return () => {
      stopMetric();
      unsubStation();
    };
  }, [
    authReady,
    userUid,
    targetWorkspaceId,
    isWorkerTarget,
    targetRole,
    effectiveSelectedDate,
    optimisticRetryTick,
  ]);

  // Effect 1C: Worker single-date report listener
  useEffect(() => {
    if (!authReady || !userUid || !targetWorkspaceId || !isWorkerTarget) return;

    const reportId = `${targetWorkspaceId}_${effectiveSelectedDate}_${targetRole}`;
    const stopMetric = perfMetrics.onListenerStart('dailyReports');
    const unsubReport = onSnapshot(
      doc(db, 'dailyReports', reportId),
      (snap) => {
        optimisticReportFailedRef.current = false;
        if (snap.exists()) {
          const raw = snap.data() as Omit<DailyReport, 'id'>;
          const rep: DailyReport = {
            ...raw,
            id: snap.id,
            station: normalizeStationId(raw.station),
          };
          setLiveReportsById({ [rep.id]: rep });
        } else {
          setLiveReportsById({});
        }
        setReportHasPendingWrites(snap.metadata.hasPendingWrites);
        setReportsLoaded(true);
      },
      (err) => {
        if (!workspaceConfirmedRef.current) {
          optimisticReportFailedRef.current = true;
          return;
        }
        console.warn('[Firestore] Report listener fallback activated:', err);
        setReportsLoaded(true);
      },
    );

    return () => {
      stopMetric();
      unsubReport();
    };
  }, [
    authReady,
    userUid,
    targetWorkspaceId,
    isWorkerTarget,
    targetRole,
    effectiveSelectedDate,
    optimisticRetryTick,
  ]);

  const managerWindow = useMemo(
    () =>
      computeManagerDateWindow({
        todayStr,
        yesterdayStr,
        effectiveSelectedDate,
      }),
    [todayStr, yesterdayStr, effectiveSelectedDate],
  );

  const stationIdsKey = useMemo(
    () => stations.map((s) => s.id).sort().join('|'),
    [stations],
  );

  // Effect 2A: Manager live listeners ONLY for active station docs on selectedDate (+ today)
  useEffect(() => {
    if (!authReady || !userUid || !workspace?.id || !canManage || !stationsLoaded) return;

    const activeStationIds = stationIdsKey ? stationIdsKey.split('|') : [];
    if (activeStationIds.length === 0) {
      setLiveReportsById({});
      setReportHasPendingWrites(false);
      setReportsLoaded(true);
      return;
    }

    const targetIds: string[] = [];
    managerWindow.liveDates.forEach((dateStr) => {
      activeStationIds.forEach((stId) => {
        targetIds.push(`${workspace.id}_${dateStr}_${stId}`);
      });
    });

    const nextLiveMap: Record<string, DailyReport> = {};
    const pendingSet = new Set<string>();
    const resolvedSet = new Set<string>();
    let flushScheduled = false;
    let unmounted = false;

    const flush = () => {
      flushScheduled = false;
      if (unmounted) return;
      setLiveReportsById({ ...nextLiveMap });
      setReportHasPendingWrites(pendingSet.size > 0);
      if (resolvedSet.size >= targetIds.length) {
        setReportsLoaded(true);
      }
    };

    const scheduleFlush = () => {
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    };

    const unsubs = targetIds.map((repId) =>
      onSnapshot(
        doc(db, 'dailyReports', repId),
        (snap) => {
          resolvedSet.add(repId);
          if (snap.exists()) {
            const raw = snap.data() as Omit<DailyReport, 'id'>;
            const rep: DailyReport = {
              ...raw,
              id: snap.id,
              station: normalizeStationId(raw.station),
            };
            if (rep.workspaceId === workspace.id) {
              nextLiveMap[rep.id] = rep;
            }
          } else {
            delete nextLiveMap[repId];
          }
          if (snap.metadata.hasPendingWrites) {
            pendingSet.add(repId);
          } else {
            pendingSet.delete(repId);
          }
          scheduleFlush();
        },
        (err) => {
          resolvedSet.add(repId);
          const code = (err as { code?: string } | null)?.code;
          if (code === 'permission-denied') {
            scheduleFlush();
            return;
          }
          handleFirestoreError(err, OperationType.GET, `dailyReports/${repId}`);
        },
      ),
    );

    const fallbackTimer = window.setTimeout(() => {
      if (!unmounted) setReportsLoaded(true);
    }, 900);

    return () => {
      unmounted = true;
      window.clearTimeout(fallbackTimer);
      unsubs.forEach((u) => u());
    };
  }, [
    authReady,
    userUid,
    workspace?.id,
    canManage,
    stationsLoaded,
    stationIdsKey,
    managerWindow.liveDates,
  ]);

  // Effect 2B: Manager cached historical dailyReports (7-day weekly + 7-day lookback + yesterday)
  useEffect(() => {
    if (!authReady || !userUid || !workspace?.id || !canManage || !stationsLoaded) return;
    const activeStationIds = stationIdsKey ? stationIdsKey.split('|') : [];
    if (activeStationIds.length === 0) return;

    const idsToFetch = planHistoricalReportIdsToFetch({
      workspaceId: workspace.id,
      stationIds: activeStationIds,
      historicalDates: managerWindow.historicalDates,
      yesterdayStr,
      liveReportsById,
      cachedReportsById: historicalReportsRef.current,
      checkedMissingReportIds: checkedMissingReportsRef.current,
    });

    if (idsToFetch.length === 0) return;

    let cancelled = false;
    void (async () => {
      const fetched: Record<string, DailyReport> = {};
      const chunks = chunkArray(idsToFetch, REPORT_FETCH_CHUNK_SIZE);

      for (const chunk of chunks) {
        if (cancelled) return;
        await Promise.all(
          chunk.map(async (repId) => {
            try {
              const snap = await getDoc(doc(db, 'dailyReports', repId));
              if (snap.exists()) {
                const raw = snap.data() as Omit<DailyReport, 'id'>;
                const rep: DailyReport = {
                  ...raw,
                  id: snap.id,
                  station: normalizeStationId(raw.station),
                };
                if (rep.workspaceId === workspace.id) {
                  fetched[rep.id] = rep;
                }
              } else {
                checkedMissingReportsRef.current.add(repId);
              }
            } catch {
              checkedMissingReportsRef.current.add(repId);
            }
          }),
        );
      }

      if (!cancelled && Object.keys(fetched).length > 0) {
        setHistoricalReportsById((prev) => ({
          ...prev,
          ...fetched,
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authReady,
    userUid,
    workspace?.id,
    canManage,
    stationsLoaded,
    stationIdsKey,
    managerWindow.historicalDates,
    yesterdayStr,
    liveReportsById,
  ]);

  const allReports = useMemo(() => {
    if (!canManage) {
      return Object.values(liveReportsById);
    }
    const merged: Record<string, DailyReport> = {
      ...historicalReportsById,
      ...liveReportsById,
    };
    return Object.values(merged);
  }, [canManage, historicalReportsById, liveReportsById]);

  const workerStationObj = useMemo(
    () => (isWorkerTarget ? stations.find((s) => s.id === targetRole) ?? null : null),
    [isWorkerTarget, stations, targetRole],
  );
  const workerStationUpdatedAtMs = getTimestampMs(workerStationObj?.updatedAt);

  // Worker mode: item IDs from active station (replaces N per-item onSnapshot listeners!)
  const workerItemIdsKey = useMemo(() => {
    if (!isWorkerTarget || !stationsLoaded || !workerStationObj) return '';
    if (Array.isArray(workerStationObj.assignedItemIds)) {
      return workerStationObj.assignedItemIds.filter(Boolean).join('|');
    }
    const nextSlot = Math.min(200, Math.max(1, workerStationObj.nextItemSlot));
    const legacyIds: string[] = [];
    for (let slot = 1; slot < nextSlot; slot++) {
      legacyIds.push(`${targetRole}_${slot}`);
    }
    return legacyIds.join('|');
  }, [isWorkerTarget, targetRole, stationsLoaded, workerStationObj]);

  // Effect 1D (Worker): Fast parallel Promise.all item sync triggered by stations/{role} updates & focus.
  useEffect(() => {
    if (
      !authReady ||
      !userUid ||
      !targetWorkspaceId ||
      !isWorkerTarget ||
      !stationsLoaded
    ) {
      return;
    }

    const itemIds = workerItemIdsKey ? workerItemIdsKey.split('|').filter(Boolean) : [];
    if (itemIds.length === 0) {
      setItems([]);
      setItemsLoaded(true);
      return;
    }

    const syncKey = `${targetWorkspaceId}:${targetRole}:${workerItemIdsKey}:${workerStationUpdatedAtMs ?? 'init'}`;
    let cancelled = false;
    let lastServerFetchMs = 0;

    const runSync = (force: boolean) => {
      if (!force && syncedWorkerItemsKeyRef.current === syncKey && itemsRef.current.length > 0) {
        setItemsLoaded(true);
        return;
      }
      const nowMs = Date.now();
      if (force && nowMs - lastServerFetchMs < 12000) {
        return;
      }
      lastServerFetchMs = nowMs;

      // On initial mount (force === false), use default getDoc for fast shared-channel resolution;
      // on focus/visibility revalidation (force === true), force server check.
      void fetchStationItemsOnce(targetWorkspaceId, targetRole, itemIds, { fromServer: force })
        .then((fetched) => {
          if (cancelled) return;
          if (fetched.length === 0 && itemIds.length > 0 && !workspaceConfirmedRef.current) {
            // Optimistic item read ran before teamMembers/{uid} finished creating; retry once workspace confirms
            optimisticItemsFailedRef.current = true;
            return;
          }
          optimisticItemsFailedRef.current = false;
          syncedWorkerItemsKeyRef.current = syncKey;
          setItems(fetched);
          setItemsLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          if (!workspaceConfirmedRef.current) {
            optimisticItemsFailedRef.current = true;
            return;
          }
          setItemsLoaded(true);
        });
    };

    runSync(false);

    const handleVisibilityOrFocus = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      runSync(true);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleVisibilityOrFocus);
      window.addEventListener('online', handleVisibilityOrFocus);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    }

    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleVisibilityOrFocus);
        window.removeEventListener('online', handleVisibilityOrFocus);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      }
    };
  }, [
    authReady,
    userUid,
    targetWorkspaceId,
    isWorkerTarget,
    targetRole,
    stationsLoaded,
    workerItemIdsKey,
    workerStationUpdatedAtMs,
    optimisticRetryTick,
  ]);

  const applyServerStationItems = useCallback(
    (stationId: StationId, freshStationItems: InventoryItem[]) => {
      setItems((prev) => {
        const nextForStation = freshStationItems.filter(
          (it) => it.active && it.station === stationId,
        );
        const otherStations = prev.filter((it) => it.station !== stationId);
        const merged = [...otherStations, ...nextForStation];
        merged.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        return merged;
      });
    },
    [],
  );

  // Auto-migrate legacy workspaces that predate dynamic Workstations (manager-only, lazy-loaded bossService)
  useEffect(() => {
    if (
      !canManage ||
      !workspace?.id ||
      workspace.seeded ||
      !stationsLoaded ||
      !itemsLoaded ||
      stations.length > 0 ||
      migrationAttemptedRef.current === workspace.id
    ) {
      return;
    }
    migrationAttemptedRef.current = workspace.id;
    void import('../services/bossService')
      .then(({ ensureWorkstationsForExistingWorkspace }) =>
        ensureWorkstationsForExistingWorkspace(workspace, stations, items),
      )
      .catch((err) => {
        console.error('Error migrating workstations:', err);
      });
  }, [canManage, workspace, stationsLoaded, itemsLoaded, stations, items]);

  const runPacksMigration = useCallback(async (candidates: InventoryItem[]) => {
    if (candidates.length === 0) return;
    candidates.forEach((it) => packsUnitMigratedIdsRef.current.add(it.id));
    setPacksMigrationState({
      status: 'running',
      processed: 0,
      total: candidates.length,
      errorMessage: null,
      remainingItems: candidates,
    });

    try {
      const { migratePacksItemUnits, PacksMigrationPartialError } = await import(
        '../services/bossService'
      );
      try {
        const records = await migratePacksItemUnits(candidates, {
          onProgress: (processed, total) => {
            setPacksMigrationState((prev) => ({
              ...prev,
              status: 'running',
              processed,
              total,
            }));
          },
        });
        if (records.length > 0) {
          setMigratedPacksNotice((prev) => {
            const byId = new Map(prev.map((r) => [r.id, r]));
            records.forEach((r) => byId.set(r.id, r));
            return Array.from(byId.values());
          });
          setMigratedPacksIds((prev) =>
            Array.from(new Set([...prev, ...records.map((r) => r.id)])),
          );
        }
        setPacksMigrationState(IDLE_PACKS_MIGRATION);
      } catch (err) {
        if (err instanceof PacksMigrationPartialError) {
          if (err.migratedRecords.length > 0) {
            setMigratedPacksNotice((prev) => {
              const byId = new Map(prev.map((r) => [r.id, r]));
              err.migratedRecords.forEach((r) => byId.set(r.id, r));
              return Array.from(byId.values());
            });
            setMigratedPacksIds((prev) =>
              Array.from(new Set([...prev, ...err.migratedRecords.map((r) => r.id)])),
            );
          }
          setPacksMigrationState({
            status: 'error',
            processed: err.processedCount,
            total: err.totalCount,
            errorMessage: err.message,
            remainingItems: err.remainingItems,
          });
          return;
        }
        setPacksMigrationState({
          status: 'error',
          processed: 0,
          total: candidates.length,
          errorMessage:
            err instanceof Error
              ? err.message
              : 'No se pudo completar la actualización en lotes pequeños.',
          remainingItems: candidates,
        });
      }
    } catch (err) {
      candidates.forEach((it) => packsUnitMigratedIdsRef.current.delete(it.id));
      setPacksMigrationState(IDLE_PACKS_MIGRATION);
      console.error('Error migrando unidad de insumos por paquetes:', err);
    }
  }, []);

  // Auto-migrate packs items whose stored unit differs from unitLabel (manager-only)
  useEffect(() => {
    if (!canManage || !workspace?.id || !itemsLoaded) return;
    if (packsUnitMigrationWorkspaceRef.current !== workspace.id) {
      packsUnitMigrationWorkspaceRef.current = workspace.id;
      packsUnitMigratedIdsRef.current = new Set();
      setMigratedPacksNotice([]);
      setPacksMigrationState(IDLE_PACKS_MIGRATION);
      setMigratedPacksIds([]);
    }

    const candidates = getPacksItemsNeedingUnitMigration(items).filter(
      (it) => !packsUnitMigratedIdsRef.current.has(it.id),
    );
    if (candidates.length === 0) return;

    void runPacksMigration(candidates);
  }, [canManage, workspace?.id, itemsLoaded, items, runPacksMigration]);

  const retryPacksMigration = useCallback(() => {
    if (packsMigrationState.remainingItems.length === 0) return;
    void runPacksMigration(packsMigrationState.remainingItems);
  }, [packsMigrationState.remainingItems, runPacksMigration]);

  const dismissMigratedPacksNotice = useCallback(() => {
    setMigratedPacksNotice([]);
  }, []);

  const refreshWorkerFallback = useCallback(async () => {
    if (!targetWorkspaceId || !isWorkerTarget) return;
    try {
      const fb = await loadWorkerStationFallback({
        workspaceId: targetWorkspaceId,
        stationId: targetRole,
        dateStr: effectiveSelectedDate,
      });
      setWorkerFallback(fb);
      if (fb.station) {
        setStations([fb.station]);
        setStationsLoaded(true);
      }
      if (fb.items.length > 0) {
        setItems(fb.items);
        setItemsLoaded(true);
      }
      if (fb.report) {
        const rep = fb.report;
        setLiveReportsById({ [rep.id]: rep });
        setEntriesByReportId((prev) => ({
          ...prev,
          [rep.id]: fb.entries,
        }));
      }
    } catch (err) {
      console.error('Error loading station fallback:', err);
    }
  }, [targetWorkspaceId, isWorkerTarget, targetRole, effectiveSelectedDate]);

  const effectiveStations = useMemo(() => {
    if (stations.length > 0) return stations;
    if (isWorkerTarget && workerFallback?.station) return [workerFallback.station];
    return stations;
  }, [stations, isWorkerTarget, workerFallback?.station]);

  const effectiveItems = useMemo(() => {
    if (items.length > 0) return items;
    if (isWorkerTarget && workerFallback?.items.length) return workerFallback.items;
    return items;
  }, [items, isWorkerTarget, workerFallback?.items]);

  const reportsForSelectedDate = useMemo(() => {
    const map: Record<string, DailyReport | undefined> = {};
    allReports.forEach((rep) => {
      if (rep.date === effectiveSelectedDate) {
        map[rep.station] = rep;
      }
    });
    if (
      isWorkerTarget &&
      !map[targetRole] &&
      workerFallback?.report?.date === effectiveSelectedDate
    ) {
      map[targetRole] = workerFallback.report;
    }
    return map;
  }, [allReports, effectiveSelectedDate, isWorkerTarget, targetRole, workerFallback?.report]);

  const existingReportIdsKey = useMemo(() => {
    return Object.values(reportsForSelectedDate)
      .map((r) => r?.id ?? '')
      .filter(Boolean)
      .sort()
      .join('|');
  }, [reportsForSelectedDate]);

  const workerStationItemIdsKey = useMemo(() => {
    if (!isWorkerTarget) return '';
    return effectiveItems
      .filter((it) => it.station === targetRole)
      .map((it) => it.id)
      .join('|');
  }, [isWorkerTarget, targetRole, effectiveItems]);

  const workerSelectedReport = isWorkerTarget
    ? reportsForSelectedDate[targetRole]
    : undefined;
  const workerSelectedReportUpdatedAtMs = getTimestampMs(workerSelectedReport?.updatedAt);

  // Effect 3: Load entries for selectedDate
  // - Manager mode: real-time collection queries per report (requires authorizedEmails)
  // - Worker mode: conditional parallel fetch triggered by dailyReports/{today} listener (replaces N entry listeners)
  useEffect(() => {
    if (!authReady || !userUid || !targetWorkspaceId) return;

    if (canManage && (isWorkspaceOwner || userEmail)) {
      const reportIds = existingReportIdsKey ? existingReportIdsKey.split('|') : [];
      if (reportIds.length === 0) {
        setEntriesByReportId({});
        return;
      }

      const stopEntriesMetric = perfMetrics.onListenerStart('entries_list');
      const unsubs = reportIds.map((repId) => {
        const entriesPath = `dailyReports/${repId}/entries`;
        const q = query(
          collection(db, 'dailyReports', repId, 'entries'),
          isWorkspaceOwner
            ? where('ownerUid', '==', userUid)
            : where('authorizedEmails', 'array-contains', userEmail),
        );
        return onSnapshot(
          q,
          (snap) => {
            const map: Record<string, DailyReportEntry> = {};
            snap.forEach((d) => {
              const entry = { id: d.id, ...d.data() } as DailyReportEntry;
              map[entry.itemId] = entry;
            });
            setEntriesByReportId((prev) => ({
              ...prev,
              [repId]: map,
            }));
          },
          (err) => handleFirestoreError(err, OperationType.LIST, entriesPath),
        );
      });

      return () => {
        stopEntriesMetric();
        unsubs.forEach((u) => u());
      };
    }

    if (!isWorkerTarget) return;

    if (!workerSelectedReport) {
      setEntriesByReportId({});
      return;
    }

    const targetReportId = workerSelectedReport.id;
    const itemIds = workerStationItemIdsKey ? workerStationItemIdsKey.split('|') : [];
    if (itemIds.length === 0) return;

    // Wait for server timestamp resolution when local pending write just flushed
    if (reportHasPendingWrites && workerSelectedReportUpdatedAtMs === null) {
      return;
    }

    const syncKey = `${targetReportId}:${workerSelectedReportUpdatedAtMs ?? 'init'}:${workerStationItemIdsKey}`;
    if (
      syncedWorkerEntriesKeyRef.current === syncKey &&
      entriesByReportIdRef.current[targetReportId]
    ) {
      return;
    }

    let cancelled = false;
    void fetchReportEntriesOnce(targetReportId, itemIds)
      .then((entryMap) => {
        if (cancelled) return;
        syncedWorkerEntriesKeyRef.current = syncKey;
        setEntriesByReportId((prev) => ({
          ...prev,
          [targetReportId]: entryMap,
        }));
      })
      .catch((err) => {
        console.warn('No se pudieron cargar las entradas de la planilla:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [
    authReady,
    userUid,
    userEmail,
    targetWorkspaceId,
    canManage,
    isWorkerTarget,
    existingReportIdsKey,
    workerSelectedReport,
    workerSelectedReportUpdatedAtMs,
    workerStationItemIdsKey,
    reportHasPendingWrites,
  ]);

  // Manager mode: load cached entries for 7-day history + selectedDate 7-day consumption average
  useEffect(() => {
    if (!authReady || !userUid || !workspace?.id || !canManage || !reportsLoaded) {
      return;
    }
    if (!isWorkspaceOwner && !userEmail) return;

    if (allReports.length === 0) {
      setHistoricalEntriesByReportId({});
      fetchedHistoryVersionRef.current = {};
      return;
    }

    const selectedDayReportIds = new Set(existingReportIdsKey ? existingReportIdsKey.split('|') : []);
    const reportsToFetch = planHistoricalEntryReportsToFetch({
      allReports,
      selectedDayReportIds,
      todayStr,
      effectiveSelectedDate,
      weekStart: managerWindow.weekStart,
      lookbackStart: managerWindow.lookbackStart,
      fetchedVersionById: fetchedHistoryVersionRef.current,
    });

    if (reportsToFetch.length === 0) return;

    let cancelled = false;
    void (async () => {
      const updates: Record<string, Record<string, DailyReportEntry>> = {};
      const chunks = chunkArray(reportsToFetch, ENTRY_FETCH_CHUNK_SIZE);

      for (const chunk of chunks) {
        if (cancelled) return;
        await Promise.all(
          chunk.map(async (rep) => {
            const updatedMs = getReportVersionMs(rep);
            try {
              const q = query(
                collection(db, 'dailyReports', rep.id, 'entries'),
                isWorkspaceOwner
                  ? where('ownerUid', '==', userUid)
                  : where('authorizedEmails', 'array-contains', userEmail),
              );
              const snap = await getDocs(q);
              const map: Record<string, DailyReportEntry> = {};
              snap.forEach((d) => {
                const entry = { id: d.id, ...d.data() } as DailyReportEntry;
                map[entry.itemId] = entry;
              });
              updates[rep.id] = map;
              fetchedHistoryVersionRef.current[rep.id] = updatedMs;
            } catch (err) {
              console.warn(`No se pudieron leer entradas históricas de ${rep.id}:`, err);
            }
          }),
        );
      }

      if (!cancelled && Object.keys(updates).length > 0) {
        setHistoricalEntriesByReportId((prev) => ({
          ...prev,
          ...updates,
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authReady,
    userUid,
    workspace?.id,
    canManage,
    isWorkspaceOwner,
    userEmail,
    reportsLoaded,
    allReports,
    todayStr,
    effectiveSelectedDate,
    managerWindow.weekStart,
    managerWindow.lookbackStart,
    existingReportIdsKey,
  ]);

  // Listen to invites, teamMembers, and stationLinks for managers ONLY
  useEffect(() => {
    if (!authReady || !userUid || !workspace?.id || !canManage) return;

    const stopTeamMetrics = perfMetrics.onListenerStart('manager_team');
    const invitesQuery = query(
      collection(db, 'invites'),
      where('ownerUid', '==', workspace.ownerUid),
    );
    const unsubInvites = onSnapshot(
      invitesQuery,
      (snap) => {
        const list: Invite[] = [];
        snap.forEach((d) => {
          const inv = { id: d.id, ...d.data() } as Invite;
          if (inv.workspaceId === workspace.id) list.push(inv);
        });
        setInvites(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'invites'),
    );

    const membersQuery = query(
      collection(db, 'teamMembers'),
      where('ownerUid', '==', workspace.ownerUid),
    );
    const unsubMembers = onSnapshot(
      membersQuery,
      (snap) => {
        const list: TeamMember[] = [];
        snap.forEach((d) => {
          const mem = { id: d.id, ...d.data() } as TeamMember;
          if (mem.workspaceId === workspace.id) list.push(mem);
        });
        setMembers(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'teamMembers'),
    );

    const linksQuery = query(
      collection(db, 'stationLinks'),
      where('ownerUid', '==', workspace.ownerUid),
    );
    const unsubLinks = onSnapshot(
      linksQuery,
      (snap) => {
        const map: Record<string, StationLink> = {};
        snap.forEach((d) => {
          const link = { id: d.id, ...d.data() } as StationLink;
          if (link.workspaceId === workspace.id) {
            map[d.id] = link;
          }
        });
        setStationLinksByCode(map);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'stationLinks'),
    );

    return () => {
      stopTeamMetrics();
      unsubInvites();
      unsubMembers();
      unsubLinks();
    };
  }, [authReady, userUid, workspace?.id, workspace?.ownerUid, canManage]);

  // Listen to real-time workerNotes (single filtered query)
  useEffect(() => {
    if (!authReady || !userUid || !targetWorkspaceId) return;
    if (canManage && !isWorkspaceOwner && !userEmail) return;
    if (!canManage && targetRole === 'jefe') return;

    const stopNotesMetric = perfMetrics.onListenerStart('workerNotes');
    const notesQuery = canManage
      ? query(
          collection(db, 'workerNotes'),
          isWorkspaceOwner
            ? where('ownerUid', '==', userUid)
            : where('authorizedEmails', 'array-contains', userEmail),
        )
      : query(collection(db, 'workerNotes'), where('authorUid', '==', userUid));

    const unsubNotes = onSnapshot(
      notesQuery,
      (snap) => {
        optimisticNotesFailedRef.current = false;
        const list: WorkerNote[] = [];
        snap.forEach((d) => {
          const raw = d.data() as Omit<WorkerNote, 'id'>;
          const note: WorkerNote = {
            ...raw,
            id: d.id,
            station: normalizeStationId(raw.station),
          };
          if (note.workspaceId === targetWorkspaceId) {
            if (canManage || note.station === targetRole) {
              list.push(note);
            }
          }
        });
        setWorkerNotes(sortWorkerNotesNewestFirst(list));
      },
      (err) => {
        if (!canManage && !workspaceConfirmedRef.current) {
          optimisticNotesFailedRef.current = true;
          return;
        }
        handleFirestoreError(err, OperationType.LIST, 'workerNotes');
      },
    );

    return () => {
      stopNotesMetric();
      unsubNotes();
    };
  }, [
    authReady,
    userUid,
    userEmail,
    targetWorkspaceId,
    canManage,
    isWorkspaceOwner,
    targetRole,
    optimisticRetryTick,
  ]);

  const effectiveEntriesByReportId = useMemo(() => {
    if (canManage || !workerFallback?.report) return entriesByReportId;
    const repId = workerFallback.report.id;
    const live = entriesByReportId[repId];
    if (live && Object.keys(live).length > 0) return entriesByReportId;
    return {
      ...entriesByReportId,
      [repId]: workerFallback.entries,
    };
  }, [canManage, entriesByReportId, workerFallback]);

  const dashboardEntriesByReportId = useMemo(() => {
    if (!canManage) return effectiveEntriesByReportId;
    return {
      ...historicalEntriesByReportId,
      ...effectiveEntriesByReportId,
    };
  }, [canManage, historicalEntriesByReportId, effectiveEntriesByReportId]);

  const consolidatedEntriesByItemId = useMemo(() => {
    const merged: Record<string, DailyReportEntry> = {};
    Object.values(reportsForSelectedDate).forEach((rep) => {
      if (!rep) return;
      const entries = effectiveEntriesByReportId[rep.id];
      if (!entries) return;
      Object.values(entries).forEach((entry) => {
        merged[entry.itemId] = entry;
      });
    });
    return merged;
  }, [reportsForSelectedDate, effectiveEntriesByReportId]);

  const todayAllEntries = useMemo(() => {
    return Object.values(consolidatedEntriesByItemId);
  }, [consolidatedEntriesByItemId]);

  // Write-through station catalog cache as soon as station + items are loaded (even before reports finish)
  useEffect(() => {
    if (
      !authReady ||
      !userUid ||
      !targetWorkspaceId ||
      !isWorkerTarget ||
      !stationsLoaded ||
      !itemsLoaded
    ) {
      return;
    }
    const activeStation = effectiveStations.find((st) => st.id === targetRole) ?? null;
    if (!activeStation && effectiveItems.length === 0) return;

    writeStationCatalogCache({
      workspaceId: targetWorkspaceId,
      role: targetRole,
      station: activeStation,
      stationUpdatedAtMs: getTimestampMs(activeStation?.updatedAt),
      items: effectiveItems,
    });
  }, [
    authReady,
    userUid,
    targetWorkspaceId,
    isWorkerTarget,
    targetRole,
    stationsLoaded,
    itemsLoaded,
    effectiveStations,
    effectiveItems,
  ]);

  // Write-through snapshot cache update + dev live sync metric for worker sessions
  useEffect(() => {
    if (
      !authReady ||
      !userUid ||
      !workspace?.id ||
      canManage ||
      role === 'jefe' ||
      !stationsLoaded ||
      !itemsLoaded
    ) {
      return;
    }

    const activeStation = effectiveStations.find((st) => st.id === role) ?? null;
    const activeReport = reportsForSelectedDate[role] ?? null;
    const activeEntries = activeReport
      ? effectiveEntriesByReportId[activeReport.id] ?? {}
      : {};

    writeWorkerSnapshotCache(userUid, {
      workspace,
      workspaceUpdatedAtMs: getTimestampMs(workspace.updatedAt),
      role,
      isOwner: false,
      station: activeStation,
      stationUpdatedAtMs: getTimestampMs(activeStation?.updatedAt),
      items: effectiveItems,
      dateStr: effectiveSelectedDate,
      ...(reportsLoaded
        ? {
            todayReport: activeReport,
            todayReportUpdatedAtMs: getTimestampMs(activeReport?.updatedAt),
            todayEntries: activeEntries,
          }
        : {}),
      workerNotes,
    });

    if (reportsLoaded) {
      perfMetrics.mark('liveSyncComplete');
      perfMetrics.logSummary('worker-live-sync');
    }
  }, [
    authReady,
    userUid,
    workspace,
    canManage,
    role,
    stationsLoaded,
    itemsLoaded,
    reportsLoaded,
    effectiveStations,
    effectiveItems,
    effectiveSelectedDate,
    reportsForSelectedDate,
    effectiveEntriesByReportId,
    workerNotes,
  ]);

  // Keep authorizedEmails limited strictly to owner + active co-admins ('jefe')
  useEffect(() => {
    if (!canManage || !workspace || !stationsLoaded || !itemsLoaded) return;
    const coAdminEmails = members
      .filter((m) => m.active && m.station === 'jefe' && m.email)
      .map((m) => m.email.trim().toLowerCase());
    const desiredEmails = Array.from(
      new Set([workspace.ownerEmail.trim().toLowerCase(), ...coAdminEmails]),
    )
      .filter(Boolean)
      .slice(0, 15);

    const unchanged =
      desiredEmails.length === workspace.authorizedEmails.length &&
      desiredEmails.every((e, i) => workspace.authorizedEmails[i] === e);
    if (unchanged) return;

    const syncKey = `${workspace.id}:${desiredEmails.sort().join(',')}`;
    if (syncingEmailsKeyRef.current === syncKey) return;
    syncingEmailsKeyRef.current = syncKey;

    void import('../services/bossService')
      .then(({ syncAuthorizedEmailsAcrossWorkspace }) =>
        syncAuthorizedEmailsAcrossWorkspace({
          workspace,
          coAdminEmails,
          stations,
          items,
          reports: allReports,
          entries: todayAllEntries,
          workerNotes,
        }),
      )
      .catch((err) => {
        console.error('Error syncing co-admin access emails:', err);
        syncingEmailsKeyRef.current = '';
      });
  }, [
    canManage,
    workspace,
    stationsLoaded,
    itemsLoaded,
    members,
    stations,
    items,
    allReports,
    todayAllEntries,
    workerNotes,
  ]);

  const yesterdayHasReports = useMemo(
    () => allReports.some((r) => r.date === yesterdayStr),
    [allReports, yesterdayStr],
  );

  return {
    stationsLoaded,
    itemsLoaded,
    reportsLoaded,
    reportHasPendingWrites,
    allReports,
    effectiveStations,
    effectiveItems,
    reportsForSelectedDate,
    effectiveEntriesByReportId,
    dashboardEntriesByReportId,
    consolidatedEntriesByItemId,
    todayAllEntries,
    invites,
    members,
    stationLinksByCode,
    workerNotes,
    yesterdayHasReports,
    migratedPacksNotice,
    migratedPacksIds,
    packsMigrationState,
    retryPacksMigration,
    dismissMigratedPacksNotice,
    refreshWorkerFallback,
    applyServerStationItems,
  };
}
