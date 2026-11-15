import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { collection, doc, getDocs, limit, onSnapshot, query, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  ensureWorkstationsForExistingWorkspace,
  loadWorkerStationFallback,
  syncAuthorizedEmailsAcrossWorkspace,
} from '../services/inventoryService';
import { shiftDateStr } from '../utils/date';
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

const MANAGER_REPORTS_QUERY_LIMIT = 120;

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
  const [allReports, setAllReports] = useState<DailyReport[]>([]);
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

  // Reset state cleanly on sign-out
  useEffect(() => {
    if (user) return;
    setStations([]);
    setStationsLoaded(false);
    setItems([]);
    setItemsLoaded(false);
    setAllReports([]);
    setReportsLoaded(false);
    setReportHasPendingWrites(false);
    setEntriesByReportId({});
    setHistoricalEntriesByReportId({});
    fetchedHistoryVersionRef.current = {};
    setInvites([]);
    setMembers([]);
    setStationLinksByCode({});
    setWorkerFallback(null);
  }, [user]);

  // Listen to stations, items, and dailyReports
  useEffect(() => {
    if (!authReady || !user || !workspace?.id) return;
    setStationsLoaded(false);
    setItemsLoaded(false);
    setReportsLoaded(false);

    if (canManage && userEmail) {
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

      // Bounded reports query to prevent unbounded historical reads
      const reportsQuery = query(
        collection(db, 'dailyReports'),
        where('authorizedEmails', 'array-contains', userEmail),
        limit(MANAGER_REPORTS_QUERY_LIMIT),
      );
      const unsubReports = onSnapshot(
        reportsQuery,
        (snap) => {
          const list: DailyReport[] = [];
          snap.forEach((d) => {
            const raw = d.data() as Omit<DailyReport, 'id'>;
            const rep: DailyReport = {
              ...raw,
              id: d.id,
              station: normalizeStationId(raw.station),
            };
            if (rep.workspaceId === workspace.id) {
              list.push(rep);
            }
          });
          setAllReports(list);
          setReportHasPendingWrites(snap.metadata.hasPendingWrites);
          setReportsLoaded(true);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'dailyReports'),
      );

      return () => {
        unsubStations();
        unsubItems();
        unsubReports();
      };
    }

    // Worker mode: strict single-station document listeners (no collection list queries)
    if (role === 'jefe') return;
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

    const reportId = `${workspace.id}_${effectiveSelectedDate}_${role}`;
    const reportDocPath = `dailyReports/${reportId}`;
    const unsubReport = onSnapshot(
      doc(db, 'dailyReports', reportId),
      (snap) => {
        if (snap.exists()) {
          const raw = snap.data() as Omit<DailyReport, 'id'>;
          setAllReports([
            {
              ...raw,
              id: snap.id,
              station: normalizeStationId(raw.station),
            },
          ]);
        } else {
          setAllReports([]);
        }
        setReportHasPendingWrites(snap.metadata.hasPendingWrites);
        setReportsLoaded(true);
      },
      (err) => handleFirestoreError(err, OperationType.GET, reportDocPath),
    );

    return () => {
      unsubStation();
      unsubReport();
    };
  }, [authReady, user, workspace?.id, canManage, userEmail, role, effectiveSelectedDate]);

  // Worker mode: real-time document-level listeners on worker's own station items
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
    const unsubs: Array<() => void> = [];
    let resolvedCount = 0;

    itemIds.forEach((itemId) => {
      const unsub = onSnapshot(
        doc(db, 'items', itemId),
        (snap) => {
          resolvedCount += 1;
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
          const list = Array.from(itemsMap.values()).sort(
            (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
          );
          setItems(list);
          if (resolvedCount >= itemIds.length) {
            setItemsLoaded(true);
          }
        },
        (err) => handleFirestoreError(err, OperationType.GET, `items/${itemId}`),
      );
      unsubs.push(unsub);
    });

    const fallbackTimer = window.setTimeout(() => setItemsLoaded(true), 800);

    return () => {
      window.clearTimeout(fallbackTimer);
      unsubs.forEach((u) => u());
    };
  }, [authReady, user, workspace?.id, canManage, role, stationsLoaded, workerItemIdsKey]);

  // Auto-migrate legacy workspaces that predate dynamic Workstations (never re-seed reset workspaces)
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
    ensureWorkstationsForExistingWorkspace(workspace, stations, items).catch((err) => {
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

    // Worker mode: document-level entry listeners via allow get
    if (role === 'jefe') return;
    const targetReportId = reportIds[0];
    const itemIds = workerStationItemIdsKey ? workerStationItemIdsKey.split('|') : [];
    if (!targetReportId || itemIds.length === 0) return;

    const entryMap: Record<string, DailyReportEntry> = {};
    const unsubs = itemIds.map((itemId) =>
      onSnapshot(
        doc(db, 'dailyReports', targetReportId, 'entries', itemId),
        (snap) => {
          if (snap.exists()) {
            entryMap[itemId] = { id: snap.id, ...snap.data() } as DailyReportEntry;
          } else {
            delete entryMap[itemId];
          }
          setEntriesByReportId((prev) => ({
            ...prev,
            [targetReportId]: { ...entryMap },
          }));
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

  // Manager mode: load entries for recent 7-day history + selectedDate 7-day consumption average
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || !canManage || !userEmail || !reportsLoaded) {
      return;
    }

    if (allReports.length === 0) {
      setHistoricalEntriesByReportId({});
      fetchedHistoryVersionRef.current = {};
      return;
    }

    const weekStart = shiftDateStr(todayStr, -6);
    const lookbackStart = shiftDateStr(effectiveSelectedDate, -7);
    const selectedDayReportIds = new Set(existingReportIdsKey ? existingReportIdsKey.split('|') : []);

    const reportsToFetch = allReports.filter((rep) => {
      if (selectedDayReportIds.has(rep.id)) return false;
      const inWeeklyWindow = rep.date >= weekStart && rep.date <= todayStr;
      const inBaselineWindow = rep.date >= lookbackStart && rep.date < effectiveSelectedDate;
      if (!inWeeklyWindow && !inBaselineWindow) return false;
      const updatedMs =
        rep.updatedAt && typeof rep.updatedAt.toMillis === 'function'
          ? rep.updatedAt.toMillis()
          : 1;
      return fetchedHistoryVersionRef.current[rep.id] !== updatedMs;
    });

    if (reportsToFetch.length === 0) return;

    let cancelled = false;
    void (async () => {
      const updates: Record<string, Record<string, DailyReportEntry>> = {};
      await Promise.all(
        reportsToFetch.map(async (rep) => {
          const updatedMs =
            rep.updatedAt && typeof rep.updatedAt.toMillis === 'function'
              ? rep.updatedAt.toMillis()
              : 1;
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

  // Keep authorizedEmails limited strictly to owner + active co-admins ('jefe'), never workers
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

    syncAuthorizedEmailsAcrossWorkspace({
      workspace,
      coAdminEmails,
      stations,
      items,
      reports: allReports,
      entries: todayAllEntries,
    }).catch((err) => {
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
