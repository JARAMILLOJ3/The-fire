import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { loadWorkerStationFallback } from '../services/workerService';
import {
  chunkArray,
  computeManagerDateWindow,
  getReportVersionMs,
  planHistoricalEntryReportsToFetch,
  planHistoricalReportIdsToFetch,
} from '../utils/stationDataCache';
import type {
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  Invite,
  StationLink,
  TeamMember,
  TeamStationId,
  Workspace,
  Workstation,
} from '../types';
import { normalizeStationId } from './useWorkspaceSession';

interface WorkerFallbackState {
  station: Workstation | null;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entries: Record<string, DailyReportEntry>;
}

const REPORT_FETCH_CHUNK_SIZE = 6;
const ENTRY_FETCH_CHUNK_SIZE = 6;

export function useStationData(params: {
  authReady: boolean;
  user: User | null;
  workspace: Workspace | null;
  canManage: boolean;
  role: TeamStationId;
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
    effectiveSelectedDate,
    todayStr,
    yesterdayStr,
  } = params;

  const userEmail = (user?.email ?? '').trim().toLowerCase();

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
  const [workerFallback, setWorkerFallback] = useState<WorkerFallbackState | null>(null);

  const migrationAttemptedRef = useRef<string | null>(null);
  const syncingEmailsKeyRef = useRef<string>('');
  const fetchedHistoryVersionRef = useRef<Record<string, number>>({});
  const historicalReportsRef = useRef<Record<string, DailyReport>>({});
  const checkedMissingReportsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    historicalReportsRef.current = historicalReportsById;
  }, [historicalReportsById]);

  // Reset state cleanly on sign-out or workspace change
  useEffect(() => {
    if (user && workspace?.id) return;
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
    setInvites([]);
    setMembers([]);
    setStationLinksByCode({});
    setWorkerFallback(null);
  }, [user, workspace?.id]);

  // Effect 1A: Static workspace collections for managers (never torn down on date switch)
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || !canManage || !userEmail) return;
    setStationsLoaded(false);
    setItemsLoaded(false);

    const stationsQuery = query(
      collection(db, 'stations'),
      where('authorizedEmails', 'array-contains', userEmail),
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

    const itemsQuery = query(
      collection(db, 'items'),
      where('authorizedEmails', 'array-contains', userEmail),
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
      unsubStations();
      unsubItems();
    };
  }, [authReady, user, workspace?.id, canManage, userEmail]);

  // Effect 1B: Worker static station listener (independent of date selection)
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || canManage || role === 'jefe') return;
    setStationsLoaded(false);

    const stationDocPath = `stations/${role}`;
    const unsubStation = onSnapshot(
      doc(db, 'stations', role),
      (snap) => {
        if (snap.exists()) {
          const st = { id: snap.id, ...snap.data() } as Workstation;
          setStations(st.workspaceId === workspace.id && st.active ? [st] : []);
        } else {
          setStations([]);
        }
        setStationsLoaded(true);
      },
      (err) => handleFirestoreError(err, OperationType.GET, stationDocPath),
    );

    return () => {
      unsubStation();
    };
  }, [authReady, user, workspace?.id, canManage, role]);

  // Effect 1C: Worker single-date report listener (date change does NOT reset stations/items)
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || canManage || role === 'jefe') return;

    const reportId = `${workspace.id}_${effectiveSelectedDate}_${role}`;
    const reportDocPath = `dailyReports/${reportId}`;
    const unsubReport = onSnapshot(
      doc(db, 'dailyReports', reportId),
      (snap) => {
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
      (err) => handleFirestoreError(err, OperationType.GET, reportDocPath),
    );

    return () => {
      unsubReport();
    };
  }, [authReady, user, workspace?.id, canManage, role, effectiveSelectedDate]);

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
    if (!authReady || !user || !workspace?.id || !canManage || !stationsLoaded) return;

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
    user,
    workspace?.id,
    canManage,
    stationsLoaded,
    stationIdsKey,
    managerWindow.liveDates,
  ]);

  // Effect 2B: Manager cached historical dailyReports (7-day weekly + 7-day lookback + yesterday)
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || !canManage || !stationsLoaded) return;
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
    user,
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

  // Worker mode: real-time document-level listeners on worker's own station items (micro-batched)
  const workerItemIdsKey = useMemo(() => {
    if (canManage || role === 'jefe' || !stationsLoaded) return '';
    const st = stations.find((s) => s.id === role);
    if (!st) return '';
    if (Array.isArray(st.assignedItemIds)) {
      return st.assignedItemIds.filter(Boolean).join('|');
    }
    const nextSlot = Math.min(200, Math.max(1, st.nextItemSlot));
    const legacyIds: string[] = [];
    for (let slot = 1; slot < nextSlot; slot++) {
      legacyIds.push(`${role}_${slot}`);
    }
    return legacyIds.join('|');
  }, [canManage, role, stationsLoaded, stations]);

  useEffect(() => {
    if (!authReady || !user || !workspace?.id || canManage || role === 'jefe' || !stationsLoaded) {
      return;
    }

    const itemIds = workerItemIdsKey ? workerItemIdsKey.split('|').filter(Boolean) : [];

    if (itemIds.length === 0) {
      setItems([]);
      setItemsLoaded(true);
      return;
    }

    const itemsMap = new Map<string, InventoryItem>();
    const resolvedIds = new Set<string>();
    let flushScheduled = false;
    let unmounted = false;

    const flushItems = () => {
      flushScheduled = false;
      if (unmounted) return;
      const list = Array.from(itemsMap.values()).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );
      setItems(list);
      if (resolvedIds.size >= itemIds.length) {
        setItemsLoaded(true);
      }
    };

    const scheduleFlush = () => {
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flushItems);
      }
    };

    const unsubs = itemIds.map((itemId) =>
      onSnapshot(
        doc(db, 'items', itemId),
        (snap) => {
          resolvedIds.add(itemId);
          if (snap.exists()) {
            const raw = snap.data() as Omit<InventoryItem, 'id'>;
            if (raw.workspaceId === workspace.id && normalizeStationId(raw.station) === role) {
              itemsMap.set(itemId, {
                ...raw,
                id: snap.id,
                station: normalizeStationId(raw.station),
              });
            } else {
              itemsMap.delete(itemId);
            }
          } else {
            itemsMap.delete(itemId);
          }
          scheduleFlush();
        },
        (err) => handleFirestoreError(err, OperationType.GET, `items/${itemId}`),
      ),
    );

    const fallbackTimer = window.setTimeout(() => {
      if (!unmounted) setItemsLoaded(true);
    }, 800);

    return () => {
      unmounted = true;
      window.clearTimeout(fallbackTimer);
      unsubs.forEach((u) => u());
    };
  }, [authReady, user, workspace?.id, canManage, role, stationsLoaded, workerItemIdsKey]);

  // Auto-migrate legacy workspaces that predate dynamic Workstations (lazy-loaded bossService)
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

  const refreshWorkerFallback = useCallback(async () => {
    if (!workspace?.id || canManage || role === 'jefe') return;
    try {
      const fb = await loadWorkerStationFallback({
        workspaceId: workspace.id,
        stationId: role,
        dateStr: effectiveSelectedDate,
      });
      setWorkerFallback(fb);
    } catch (err) {
      console.error('Error loading station fallback:', err);
    }
  }, [workspace?.id, canManage, role, effectiveSelectedDate]);

  const effectiveStations = useMemo(() => {
    if (stations.length > 0) return stations;
    if (!canManage && workerFallback?.station) return [workerFallback.station];
    return stations;
  }, [stations, canManage, workerFallback?.station]);

  const effectiveItems = useMemo(() => {
    if (items.length > 0) return items;
    if (!canManage && workerFallback?.items.length) return workerFallback.items;
    return items;
  }, [items, canManage, workerFallback?.items]);

  const reportsForSelectedDate = useMemo(() => {
    const map: Record<string, DailyReport | undefined> = {};
    allReports.forEach((rep) => {
      if (rep.date === effectiveSelectedDate) {
        map[rep.station] = rep;
      }
    });
    if (
      !canManage &&
      role !== 'jefe' &&
      !map[role] &&
      workerFallback?.report?.date === effectiveSelectedDate
    ) {
      map[role] = workerFallback.report;
    }
    return map;
  }, [allReports, effectiveSelectedDate, canManage, role, workerFallback?.report]);

  const existingReportIdsKey = useMemo(() => {
    return Object.values(reportsForSelectedDate)
      .map((r) => r?.id ?? '')
      .filter(Boolean)
      .sort()
      .join('|');
  }, [reportsForSelectedDate]);

  const workerStationItemIdsKey = useMemo(() => {
    if (canManage || role === 'jefe') return '';
    return effectiveItems
      .filter((it) => it.station === role)
      .map((it) => it.id)
      .join('|');
  }, [canManage, role, effectiveItems]);

  // Listen to entries subcollections for existing reports on effectiveSelectedDate
  useEffect(() => {
    if (!authReady || !user || !workspace?.id) return;
    const reportIds = existingReportIdsKey ? existingReportIdsKey.split('|') : [];
    if (reportIds.length === 0) {
      setEntriesByReportId({});
      return;
    }

    if (canManage && userEmail) {
      const unsubs = reportIds.map((repId) => {
        const entriesPath = `dailyReports/${repId}/entries`;
        const q = query(
          collection(db, 'dailyReports', repId, 'entries'),
          where('authorizedEmails', 'array-contains', userEmail),
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
        unsubs.forEach((u) => u());
      };
    }

    // Worker mode: document-level entry listeners via allow get (micro-batched commits)
    if (role === 'jefe') return;
    const targetReportId = reportIds[0];
    const itemIds = workerStationItemIdsKey ? workerStationItemIdsKey.split('|') : [];
    if (!targetReportId || itemIds.length === 0) return;

    const entryMap: Record<string, DailyReportEntry> = {};
    let flushScheduled = false;
    let unmounted = false;

    const flushEntries = () => {
      flushScheduled = false;
      if (unmounted) return;
      setEntriesByReportId((prev) => ({
        ...prev,
        [targetReportId]: { ...entryMap },
      }));
    };

    const scheduleFlush = () => {
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flushEntries);
      }
    };

    const unsubs = itemIds.map((itemId) =>
      onSnapshot(
        doc(db, 'dailyReports', targetReportId, 'entries', itemId),
        (snap) => {
          if (snap.exists()) {
            entryMap[itemId] = { id: snap.id, ...snap.data() } as DailyReportEntry;
          } else {
            delete entryMap[itemId];
          }
          scheduleFlush();
        },
        (err) =>
          handleFirestoreError(
            err,
            OperationType.GET,
            `dailyReports/${targetReportId}/entries/${itemId}`,
          ),
      ),
    );

    return () => {
      unmounted = true;
      unsubs.forEach((u) => u());
    };
  }, [
    authReady,
    user,
    userEmail,
    workspace?.id,
    canManage,
    role,
    existingReportIdsKey,
    workerStationItemIdsKey,
  ]);

  // Manager mode: load cached entries for 7-day history + selectedDate 7-day consumption average
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || !canManage || !userEmail || !reportsLoaded) {
      return;
    }

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
                where('authorizedEmails', 'array-contains', userEmail),
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
    user,
    workspace?.id,
    canManage,
    userEmail,
    reportsLoaded,
    allReports,
    todayStr,
    effectiveSelectedDate,
    managerWindow.weekStart,
    managerWindow.lookbackStart,
    existingReportIdsKey,
  ]);

  // Listen to invites, teamMembers, and stationLinks for managers
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || !canManage) return;

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
      unsubInvites();
      unsubMembers();
      unsubLinks();
    };
  }, [authReady, user, workspace?.id, workspace?.ownerUid, canManage]);

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
        }),
      )
      .catch((err) => {
        console.error('Error syncing co-admin access emails:', err);
        syncingEmailsKeyRef.current = '';
      });
  }, [canManage, workspace, stationsLoaded, itemsLoaded, members, stations, items, allReports, todayAllEntries]);

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
    yesterdayHasReports,
    refreshWorkerFallback,
  };
}
