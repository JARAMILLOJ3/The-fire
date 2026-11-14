import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import {
  Calendar,
  Citrus,
  ClipboardList,
  CupSoda,
  Flame,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  QrCode,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { BossDashboard } from './components/BossDashboard';
import { BrandLogo } from './components/BrandLogo';
import { CatalogManager } from './components/CatalogManager';
import { StationShiftView } from './components/StationShiftView';
import { TeamManager } from './components/TeamManager';
import { WorkstationsManager } from './components/WorkstationsManager';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from './firebase';
import {
  ensureWorkstationsForExistingWorkspace,
  fetchStationLinkPreview,
  loadWorkerStationFallback,
  resolveUserWorkspace,
  syncAuthorizedEmailsAcrossWorkspace,
} from './services/inventoryService';
import type {
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  Invite,
  StationId,
  StationLink,
  TeamMember,
  TeamStationId,
  Workspace,
  Workstation,
} from './types';
import { getPreviousDateStr, getTodayDateStr } from './utils/inventory';

type ActiveSection = 'jefe' | 'puestos' | 'catalogo' | 'equipo' | StationId;

function getStationIcon(stationId: string) {
  switch (stationId) {
    case 'mesera':
      return CupSoda;
    case 'salchipapas':
      return Citrus;
    case 'comida_rapida':
      return UtensilsCrossed;
    case 'asados':
      return Flame;
    default:
      return ClipboardList;
  }
}

function normalizeStation(raw: string): StationId {
  if (raw === 'hamburguesas') return 'comida_rapida';
  return raw;
}

function normalizeTeamRole(raw: string): TeamStationId {
  if (raw === 'jefe') return 'jefe';
  return normalizeStation(raw);
}

interface WorkerFallbackState {
  station: Workstation | null;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entries: Record<string, DailyReportEntry>;
}

export default function App() {
  const [linkParams] = useState(() => {
    if (typeof window === 'undefined') {
      return { stationId: null as string | null, accessCode: null as string | null };
    }
    const sp = new URLSearchParams(window.location.search);
    return {
      stationId: sp.get('puesto'),
      accessCode: sp.get('codigo'),
    };
  });

  const [pendingLink, setPendingLink] = useState<StationLink | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [role, setRole] = useState<TeamStationId>('jefe');
  const [isOwner, setIsOwner] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<ActiveSection>('jefe');
  const [catalogFilterStation, setCatalogFilterStation] = useState<string>('all');
  const [selectedDate, setSelectedDate] = useState<string>(() => getTodayDateStr());
  const [autoSelectedYesterday, setAutoSelectedYesterday] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [stations, setStations] = useState<Workstation[]>([]);
  const [stationsLoaded, setStationsLoaded] = useState(false);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [allReports, setAllReports] = useState<DailyReport[]>([]);
  const [reportsLoaded, setReportsLoaded] = useState(false);
  const [entriesByReportId, setEntriesByReportId] = useState<
    Record<string, Record<string, DailyReportEntry>>
  >({});
  const [invites, setInvites] = useState<Invite[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workerFallback, setWorkerFallback] = useState<WorkerFallbackState | null>(null);

  const migrationAttemptedRef = useRef<string | null>(null);
  const syncingEmailsKeyRef = useRef<string>('');
  const manualDatePickedRef = useRef(false);
  const autoDateCheckedRef = useRef<string | null>(null);

  const canManage = isOwner || role === 'jefe';
  const userEmail = (user?.email ?? '').trim().toLowerCase();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setWorkspace(null);
        setStations([]);
        setStationsLoaded(false);
        setItems([]);
        setItemsLoaded(false);
        setAllReports([]);
        setReportsLoaded(false);
        setAutoSelectedYesterday(false);
        manualDatePickedRef.current = false;
        autoDateCheckedRef.current = null;
        setEntriesByReportId({});
        setInvites([]);
        setMembers([]);
        setWorkerFallback(null);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || user || !linkParams.accessCode) return;
    let cancelled = false;
    fetchStationLinkPreview(linkParams.accessCode).then((preview) => {
      if (!cancelled && preview) {
        setPendingLink(preview);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, user, linkParams.accessCode]);

  useEffect(() => {
    if (!authReady || !user) return;
    let cancelled = false;
    setSessionLoading(true);
    setSessionError(null);

    resolveUserWorkspace(user, linkParams)
      .then((resolved) => {
        if (cancelled) return;
        const normalizedRole = normalizeTeamRole(resolved.role);
        setWorkspace(resolved.workspace);
        setRole(normalizedRole);
        setIsOwner(resolved.isOwner);
        if (resolved.stationLinkInfo) {
          setPendingLink(resolved.stationLinkInfo);
        }
        if (resolved.initialStation) {
          setActiveSection(normalizeStation(resolved.initialStation));
        } else {
          setActiveSection(
            resolved.isOwner || normalizedRole === 'jefe' ? 'jefe' : normalizedRole,
          );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        setSessionError(
          'No se pudo inicializar el espacio del restaurante. Verifica tu sesión e intenta nuevamente.',
        );
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authReady, user, linkParams]);

  // Listen to workspace document
  useEffect(() => {
    if (!authReady || !user || !workspace?.id) return;
    const wsPath = `workspaces/${workspace.id}`;
    const unsub = onSnapshot(
      doc(db, 'workspaces', workspace.id),
      (snap) => {
        if (snap.exists()) {
          setWorkspace({ id: snap.id, ...snap.data() } as Workspace);
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, wsPath),
    );
    return () => unsub();
  }, [authReady, user, workspace?.id]);

  // Listen to workstations, inventory items, and dailyReports
  useEffect(() => {
    if (!authReady || !user || !workspace?.id || !userEmail) return;
    setStationsLoaded(false);
    setItemsLoaded(false);
    setReportsLoaded(false);

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
            station: normalizeStation(raw.station),
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

    const reportsQuery = query(
      collection(db, 'dailyReports'),
      where('authorizedEmails', 'array-contains', userEmail),
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
            station: normalizeStation(raw.station),
          };
          if (rep.workspaceId === workspace.id) {
            list.push(rep);
          }
        });
        setAllReports(list);
        setReportsLoaded(true);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'dailyReports'),
    );

    return () => {
      unsubStations();
      unsubItems();
      unsubReports();
    };
  }, [authReady, user, workspace?.id, userEmail]);

  // Smart morning review: if Boss logs in when today has 0 reports and yesterday has reports, auto-show yesterday
  useEffect(() => {
    if (
      !canManage ||
      !workspace?.id ||
      !reportsLoaded ||
      manualDatePickedRef.current ||
      autoDateCheckedRef.current === workspace.id
    ) {
      return;
    }
    autoDateCheckedRef.current = workspace.id;
    const today = getTodayDateStr();
    const yesterday = getPreviousDateStr(today);
    const hasToday = allReports.some((r) => r.date === today);
    const hasYesterday = allReports.some((r) => r.date === yesterday);
    if (!hasToday && hasYesterday) {
      setSelectedDate(yesterday);
      setAutoSelectedYesterday(true);
    }
  }, [canManage, workspace?.id, reportsLoaded, allReports]);

  // Auto-migrate existing workspace without stations doc into dynamic Workstations
  useEffect(() => {
    if (
      !canManage ||
      !workspace?.id ||
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
        dateStr: selectedDate,
      });
      setWorkerFallback(fb);
    } catch (err) {
      console.error('Error loading station fallback:', err);
    }
  }, [workspace?.id, canManage, role, selectedDate]);

  // Fallback for QR-linked workers before Boss syncs authorizedEmails
  useEffect(() => {
    if (canManage || !workspace?.id || role === 'jefe' || !stationsLoaded || !itemsLoaded) {
      return;
    }
    const hasStationViaQuery = stations.some((s) => s.id === role);
    const hasItemsViaQuery = items.some((i) => i.station === role);
    if (!hasStationViaQuery || !hasItemsViaQuery) {
      refreshWorkerFallback();
    }
  }, [canManage, workspace?.id, role, stationsLoaded, itemsLoaded, stations, items, selectedDate, refreshWorkerFallback]);

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
      if (rep.date === selectedDate) {
        map[rep.station] = rep;
      }
    });
    if (!canManage && role !== 'jefe' && !map[role] && workerFallback?.report?.date === selectedDate) {
      map[role] = workerFallback.report;
    }
    return map;
  }, [allReports, selectedDate, canManage, role, workerFallback?.report]);

  // Listen to entries subcollections for existing reports on selectedDate
  const existingReportIdsKey = useMemo(() => {
    return Object.values(reportsForSelectedDate)
      .map((r) => r?.id ?? '')
      .filter(Boolean)
      .sort()
      .join('|');
  }, [reportsForSelectedDate]);

  useEffect(() => {
    if (!authReady || !user || !userEmail || !workspace?.id) return;
    const reportIds = existingReportIdsKey ? existingReportIdsKey.split('|') : [];
    if (reportIds.length === 0) {
      setEntriesByReportId({});
      return;
    }

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
  }, [authReady, user, userEmail, workspace?.id, existingReportIdsKey]);

  // Listen to invites and teamMembers for managers
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

    return () => {
      unsubInvites();
      unsubMembers();
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

  // Automatically sync authorizedEmails when a QR-linked worker registers in teamMembers
  useEffect(() => {
    if (!canManage || !workspace || !stationsLoaded || !itemsLoaded || members.length === 0) return;
    const activeEmails = members
      .filter((m) => m.active && m.email)
      .map((m) => m.email.trim().toLowerCase());
    const missingEmails = activeEmails.filter(
      (em) => !workspace.authorizedEmails.includes(em),
    );
    if (missingEmails.length === 0) return;

    const syncKey = `${workspace.id}:${missingEmails.sort().join(',')}`;
    if (syncingEmailsKeyRef.current === syncKey) return;
    syncingEmailsKeyRef.current = syncKey;

    syncAuthorizedEmailsAcrossWorkspace({
      workspace,
      emailsToInclude: activeEmails,
      stations,
      items,
      reports: allReports,
      entries: todayAllEntries,
    }).catch((err) => {
      console.error('Error syncing member access emails:', err);
      syncingEmailsKeyRef.current = '';
    });
  }, [canManage, workspace, stationsLoaded, itemsLoaded, members, stations, items, allReports, todayAllEntries]);

  const todayStr = getTodayDateStr();
  const yesterdayStr = getPreviousDateStr(todayStr);
  const yesterdayHasReports = useMemo(
    () => allReports.some((r) => r.date === yesterdayStr),
    [allReports, yesterdayStr],
  );

  const handleSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error(error);
      setAuthError('No se pudo completar el inicio de sesión con Google.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm font-medium text-slate-600">Iniciando The Fire Inventario...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onSignIn={handleSignIn}
        loading={authLoading}
        errorMessage={authError}
        pendingLink={pendingLink}
        hasLinkParams={Boolean(linkParams.accessCode)}
      />
    );
  }

  if (sessionLoading || !workspace) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 gap-4">
        {sessionError ? (
          <div className="max-w-md bg-white border border-red-200 rounded-xl p-6 text-center space-y-4">
            <p className="text-sm text-red-700">{sessionError}</p>
            <button
              type="button"
              onClick={handleSignOut}
              className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg cursor-pointer"
            >
              Cerrar sesión
            </button>
          </div>
        ) : (
          <div className="w-full max-w-md space-y-3">
            <div className="h-5 w-40 bg-slate-200 rounded animate-pulse mx-auto" />
            <div className="h-3 w-64 bg-slate-200 rounded animate-pulse mx-auto" />
          </div>
        )}
      </div>
    );
  }

  const dataLoading = !stationsLoaded || !itemsLoaded;

  const handleSelectDate = (nextDate: string) => {
    if (!nextDate) return;
    manualDatePickedRef.current = true;
    setAutoSelectedYesterday(false);
    setSelectedDate(nextDate);
  };

  const visibleStations = canManage
    ? effectiveStations
    : effectiveStations.filter((st) => st.id === role);

  const currentStation =
    effectiveStations.find((st) => st.id === activeSection) ?? visibleStations[0] ?? null;

  const sectionBreadcrumb =
    activeSection === 'jefe'
      ? 'Panel del Jefe'
      : activeSection === 'puestos'
        ? 'Puestos de Trabajo y QR'
        : activeSection === 'catalogo'
          ? 'Catálogo de Insumos'
          : activeSection === 'equipo'
            ? 'Equipo y Accesos'
            : currentStation?.name ?? 'Puesto de trabajo';

  const navigateTo = (section: ActiveSection) => {
    setActiveSection(section);
    setMobileNavOpen(false);
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200">
      <div className="px-5 py-4 border-b border-slate-200">
        <BrandLogo subtitle={workspace.name} size="sm" />
      </div>

      <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
        {canManage && (
          <div className="space-y-1">
            <p className="px-3 text-xs font-semibold text-slate-500 mb-1.5">Dirección</p>
            <button
              type="button"
              onClick={() => navigateTo('jefe')}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                activeSection === 'jefe'
                  ? 'bg-teal-50 text-teal-800 font-semibold'
                  : 'text-slate-800 hover:bg-slate-100'
              }`}
            >
              <LayoutDashboard className="w-4 h-4 shrink-0" />
              <span className="truncate">Resumen y Compras</span>
            </button>
          </div>
        )}

        <div className="space-y-1">
          <p className="px-3 text-xs font-semibold text-slate-500 mb-1.5">
            Puestos de trabajo
          </p>
          {visibleStations.map((st) => {
            const Icon = getStationIcon(st.id);
            const rep = reportsForSelectedDate[st.id];
            return (
              <button
                key={st.id}
                type="button"
                onClick={() => navigateTo(st.id)}
                className={`w-full min-h-[44px] flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                  activeSection === st.id
                    ? 'bg-teal-50 text-teal-800 font-semibold'
                    : 'text-slate-800 hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{st.name}</span>
                </span>
                <span className="text-xs font-mono text-slate-500 shrink-0">
                  {rep?.status === 'completed'
                    ? 'Listo'
                    : rep?.status === 'opening_saved'
                      ? 'Avance'
                      : '—'}
                </span>
              </button>
            );
          })}
        </div>

        {canManage && (
          <div className="space-y-1">
            <p className="px-3 text-xs font-semibold text-slate-500 mb-1.5">
              Administración
            </p>
            <button
              type="button"
              onClick={() => navigateTo('puestos')}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                activeSection === 'puestos'
                  ? 'bg-teal-50 text-teal-800 font-semibold'
                  : 'text-slate-800 hover:bg-slate-100'
              }`}
            >
              <QrCode className="w-4 h-4 shrink-0" />
              <span className="truncate">Puestos y Códigos QR</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setCatalogFilterStation('all');
                navigateTo('catalogo');
              }}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                activeSection === 'catalogo'
                  ? 'bg-teal-50 text-teal-800 font-semibold'
                  : 'text-slate-800 hover:bg-slate-100'
              }`}
            >
              <Package className="w-4 h-4 shrink-0" />
              <span className="truncate">Catálogo de Insumos</span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo('equipo')}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                activeSection === 'equipo'
                  ? 'bg-teal-50 text-teal-800 font-semibold'
                  : 'text-slate-800 hover:bg-slate-100'
              }`}
            >
              <Users className="w-4 h-4 shrink-0" />
              <span className="truncate">Equipo y Accesos</span>
            </button>
          </div>
        )}
      </nav>

      <div className="p-4 border-t border-slate-200 space-y-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 truncate">
            {user.displayName || user.email}
          </p>
          <p className="text-xs text-slate-500 truncate">
            {canManage
              ? 'Jefe / Administrador'
              : currentStation?.name ?? 'Trabajadora de puesto'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Cerrar sesión
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen no-print">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] h-full z-10">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              aria-label="Cerrar menú"
              className="absolute top-4 right-3 p-1.5 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            {sidebarContent}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Header */}
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Abrir navegación"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
                {workspace.name}
              </span>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <span className="font-semibold text-slate-900 truncate">
                {sectionBreadcrumb}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => handleSelectDate(yesterdayStr)}
                className={`min-h-[34px] px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedDate === yesterdayStr
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Ayer
              </button>
              <button
                type="button"
                onClick={() => handleSelectDate(todayStr)}
                className={`min-h-[34px] px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedDate === todayStr
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Hoy
              </button>
            </div>

            <div className="relative flex items-center">
              <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500 absolute left-2 sm:left-2.5 pointer-events-none" />
              <input
                type="date"
                aria-label="Seleccionar fecha del reporte"
                value={selectedDate}
                onChange={(e) => e.target.value && handleSelectDate(e.target.value)}
                className="min-h-[38px] pl-7 sm:pl-8 pr-1.5 sm:pr-2.5 py-1 text-xs sm:text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 w-[114px] sm:w-auto"
              />
            </div>
          </div>
        </header>

        {/* Workspace Viewport */}
        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8">
          {dataLoading ? (
            <div className="space-y-4">
              <div className="h-8 w-64 bg-slate-200 rounded animate-pulse" />
              <div className="h-28 w-full bg-white border border-slate-200 rounded-xl animate-pulse" />
              <div className="h-64 w-full bg-white border border-slate-200 rounded-xl animate-pulse" />
            </div>
          ) : activeSection === 'jefe' && canManage ? (
            <BossDashboard
              workspaceName={workspace.name}
              selectedDate={selectedDate}
              todayStr={todayStr}
              yesterdayStr={yesterdayStr}
              yesterdayHasReports={yesterdayHasReports}
              autoSelectedYesterday={autoSelectedYesterday}
              stations={effectiveStations}
              items={effectiveItems}
              reportsByStation={reportsForSelectedDate}
              entriesByItemId={consolidatedEntriesByItemId}
              onSelectDate={handleSelectDate}
              onOpenStation={(stId) => navigateTo(stId)}
              onGoToWorkstations={() => navigateTo('puestos')}
              onGoToCatalog={() => {
                setCatalogFilterStation('all');
                navigateTo('catalogo');
              }}
            />
          ) : activeSection === 'puestos' && canManage ? (
            <WorkstationsManager
              workspace={workspace}
              stations={effectiveStations}
              items={effectiveItems}
              onOpenStationSheet={(stId) => navigateTo(stId)}
              onOpenStationCatalog={(stId) => {
                setCatalogFilterStation(stId);
                navigateTo('catalogo');
              }}
            />
          ) : activeSection === 'catalogo' && canManage ? (
            <CatalogManager
              workspace={workspace}
              stations={effectiveStations}
              items={effectiveItems}
              initialFilterStation={catalogFilterStation}
            />
          ) : activeSection === 'equipo' && canManage ? (
            <TeamManager
              workspace={workspace}
              stations={effectiveStations}
              items={effectiveItems}
              todayReports={Object.values(reportsForSelectedDate).filter(
                (r): r is DailyReport => Boolean(r),
              )}
              todayEntries={todayAllEntries}
              invites={invites}
              members={members}
            />
          ) : currentStation ? (
            <StationShiftView
              workspace={workspace}
              user={user}
              canManage={canManage}
              station={currentStation}
              selectedDate={selectedDate}
              items={effectiveItems}
              report={reportsForSelectedDate[currentStation.id]}
              entriesByItemId={
                effectiveEntriesByReportId[reportsForSelectedDate[currentStation.id]?.id ?? ''] ??
                {}
              }
              onSaved={() => {
                if (!canManage) {
                  refreshWorkerFallback();
                }
              }}
            />
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
              <p className="font-display text-lg font-semibold text-slate-900">
                No hay puestos de trabajo disponibles
              </p>
              <p className="text-sm text-slate-600 max-w-md mx-auto">
                {canManage
                  ? 'Crea un puesto de trabajo para comenzar a gestionar los insumos y generar su código QR.'
                  : 'Solicita al jefe que te comparta el enlace o código QR de tu puesto de trabajo.'}
              </p>
              {canManage && (
                <button
                  type="button"
                  onClick={() => navigateTo('puestos')}
                  className="px-4 py-2 text-sm font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 cursor-pointer"
                >
                  Ir a Puestos de Trabajo
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
