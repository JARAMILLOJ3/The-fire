import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import {
  Calendar,
  Citrus,
  ClipboardList,
  Clock,
  CupSoda,
  Flame,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  QrCode,
  Users,
  UtensilsCrossed,
  WifiOff,
  X,
} from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { BrandLogo } from './components/BrandLogo';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useShiftClock } from './hooks/useShiftClock';
import { useStationData } from './hooks/useStationData';
import { useWorkspaceSession } from './hooks/useWorkspaceSession';
import type { DailyReport, DailyReportEntry, StationId } from './types';

// Lazy-load role-specific views so worker QR sessions skip boss dashboards, QR generators & modals
const StationShiftView = lazy(() =>
  import('./components/StationShiftView').then((m) => ({ default: m.StationShiftView })),
);
const BossDashboard = lazy(() =>
  import('./components/BossDashboard').then((m) => ({ default: m.BossDashboard })),
);
const WorkstationsManager = lazy(() =>
  import('./components/WorkstationsManager').then((m) => ({ default: m.WorkstationsManager })),
);
const CatalogManager = lazy(() =>
  import('./components/CatalogManager').then((m) => ({ default: m.CatalogManager })),
);
const TeamManager = lazy(() =>
  import('./components/TeamManager').then((m) => ({ default: m.TeamManager })),
);
const BossWelcomeModal = lazy(() =>
  import('./components/BossWelcomeModal').then((m) => ({ default: m.BossWelcomeModal })),
);
const ShiftScheduleModal = lazy(() =>
  import('./components/ShiftScheduleModal').then((m) => ({ default: m.ShiftScheduleModal })),
);

type ActiveSection = 'jefe' | 'puestos' | 'catalogo' | 'equipo' | StationId;

const EMPTY_ENTRIES: Record<string, DailyReportEntry> = {};

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

function ViewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-64 bg-stone-200 rounded-xl animate-pulse" />
      <div className="h-28 w-full bg-white border border-stone-200 rounded-2xl animate-pulse" />
      <div className="h-64 w-full bg-white border border-stone-200 rounded-2xl animate-pulse" />
    </div>
  );
}

export default function App() {
  const isOnline = useOnlineStatus();
  const {
    linkParams,
    pendingLink,
    user,
    authReady,
    authLoading,
    authError,
    workspace,
    role,
    isOwner,
    canManage,
    sessionLoading,
    sessionError,
    initialActiveSection,
    handleSignIn,
    handleSignOut,
  } = useWorkspaceSession();

  const { scheduleStatus: workerScheduleStatus, todayStr, yesterdayStr } = useShiftClock(
    workspace?.shiftSchedule,
  );

  const [activeSection, setActiveSection] = useState<ActiveSection>('jefe');
  const [catalogFilterStation, setCatalogFilterStation] = useState<string>('all');
  const [selectedDate, setSelectedDate] = useState<string>(() => todayStr);
  const [autoSelectedYesterday, setAutoSelectedYesterday] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);

  const manualDatePickedRef = useRef(false);
  const autoDateCheckedRef = useRef<string | null>(null);
  const prevTodayRef = useRef<string>(todayStr);

  useEffect(() => {
    if (initialActiveSection) {
      setActiveSection(initialActiveSection);
    }
  }, [initialActiveSection]);

  // Reset date selection cleanly on sign-out
  useEffect(() => {
    if (user) return;
    setAutoSelectedYesterday(false);
    manualDatePickedRef.current = false;
    autoDateCheckedRef.current = null;
  }, [user]);

  // Recalculate dashboard "today" cleanly across midnight / 6 AM operational cutoff
  useEffect(() => {
    if (prevTodayRef.current === todayStr) return;
    prevTodayRef.current = todayStr;
    if (!manualDatePickedRef.current) {
      autoDateCheckedRef.current = null;
      setSelectedDate(todayStr);
      setAutoSelectedYesterday(false);
    }
  }, [todayStr]);

  const effectiveSelectedDate = canManage
    ? selectedDate
    : workerScheduleStatus.operationalDate;

  const {
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
  } = useStationData({
    authReady,
    user,
    workspace,
    canManage,
    role,
    effectiveSelectedDate,
    todayStr,
    yesterdayStr,
  });

  // Smart morning review: if Boss logs in when today has 0 reports and yesterday has reports, auto-show yesterday
  useEffect(() => {
    if (
      !canManage ||
      !workspace?.id ||
      !reportsLoaded ||
      manualDatePickedRef.current ||
      autoDateCheckedRef.current === `${workspace.id}:${todayStr}`
    ) {
      return;
    }
    autoDateCheckedRef.current = `${workspace.id}:${todayStr}`;
    const hasToday = allReports.some((r) => r.date === todayStr);
    const hasYesterday = allReports.some((r) => r.date === yesterdayStr);
    if (!hasToday && hasYesterday) {
      setSelectedDate(yesterdayStr);
      setAutoSelectedYesterday(true);
    }
  }, [canManage, workspace?.id, reportsLoaded, allReports, todayStr, yesterdayStr]);

  const visibleStations = useMemo(
    () =>
      canManage
        ? effectiveStations
        : effectiveStations.filter((st) => st.id === role),
    [canManage, effectiveStations, role],
  );

  const currentStation = useMemo(
    () => effectiveStations.find((st) => st.id === activeSection) ?? visibleStations[0] ?? null,
    [effectiveStations, activeSection, visibleStations],
  );

  const currentStationReportId = currentStation
    ? reportsForSelectedDate[currentStation.id]?.id ?? ''
    : '';

  const currentStationEntries = useMemo(
    () =>
      currentStationReportId
        ? effectiveEntriesByReportId[currentStationReportId] ?? EMPTY_ENTRIES
        : EMPTY_ENTRIES,
    [currentStationReportId, effectiveEntriesByReportId],
  );

  const handleStationSaved = useCallback(() => {
    if (!canManage) {
      void refreshWorkerFallback();
    }
  }, [canManage, refreshWorkerFallback]);

  const handleSelectDate = useCallback((nextDate: string) => {
    if (!nextDate) return;
    manualDatePickedRef.current = true;
    setAutoSelectedYesterday(false);
    setSelectedDate(nextDate);
  }, []);

  const navigateTo = useCallback((section: ActiveSection) => {
    setActiveSection(section);
    setMobileNavOpen(false);
  }, []);

  const handleResetComplete = useCallback(() => {
    manualDatePickedRef.current = false;
    autoDateCheckedRef.current = null;
    setAutoSelectedYesterday(false);
    setSelectedDate(todayStr);
  }, [todayStr]);

  if (!authReady) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
          <div className="flex items-center gap-3 text-sm font-medium text-stone-600">
            <Flame className="w-5 h-5 text-orange-600 animate-pulse" />
            <span>Iniciando The Fire Inventario...</span>
          </div>
        </div>
      </MotionConfig>
    );
  }

  if (!user) {
    return (
      <MotionConfig reducedMotion="user">
        <AuthScreen
          onSignIn={handleSignIn}
          loading={authLoading}
          errorMessage={authError}
          pendingLink={pendingLink}
          hasLinkParams={Boolean(linkParams.accessCode)}
        />
      </MotionConfig>
    );
  }

  if (sessionLoading || !workspace) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center p-6 gap-4">
          {sessionError ? (
            <div className="max-w-md bg-white border border-red-200 rounded-2xl p-6 text-center space-y-4">
              <p className="text-sm text-red-700">{sessionError}</p>
              <button
                type="button"
                onClick={handleSignOut}
                className="px-4 py-2 text-sm font-semibold text-white bg-stone-950 rounded-xl cursor-pointer"
              >
                Cerrar sesión
              </button>
            </div>
          ) : (
            <div className="w-full max-w-md space-y-3">
              <div className="h-5 w-44 bg-stone-200 rounded-lg animate-pulse mx-auto" />
              <div className="h-3 w-64 bg-stone-200 rounded-lg animate-pulse mx-auto" />
            </div>
          )}
        </div>
      </MotionConfig>
    );
  }

  const dataLoading = !stationsLoaded || !itemsLoaded;
  const needsOwnerNameOnboarding = canManage && !workspace.ownerName?.trim();

  const sectionBreadcrumb =
    activeSection === 'jefe'
      ? 'Resumen y Compras'
      : activeSection === 'puestos'
        ? 'Puestos y QR'
        : activeSection === 'catalogo'
          ? 'Insumos'
          : activeSection === 'equipo'
            ? 'Equipo'
            : currentStation?.name ?? 'Puesto';

  const displayAccountName =
    canManage && workspace.ownerName?.trim()
      ? workspace.ownerName.trim()
      : user.displayName || user.email;

  const sidebarContent = (
    <div className="flex flex-col h-full bg-stone-950 text-stone-100 border-r border-stone-800/80">
      <div className="px-5 py-4 border-b border-stone-800/80">
        <BrandLogo subtitle={workspace.name} size="sm" theme="dark" />
      </div>

      <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
        {canManage && (
          <div className="space-y-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-stone-500 mb-1.5">
              Dirección
            </p>
            <button
              type="button"
              onClick={() => navigateTo('jefe')}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-xl transition-colors cursor-pointer ${
                activeSection === 'jefe'
                  ? 'bg-orange-600/15 text-orange-400 font-semibold'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <LayoutDashboard className="w-4 h-4 shrink-0" />
              <span className="truncate">Resumen y Compras</span>
            </button>
          </div>
        )}

        <div className="space-y-1">
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-stone-500 mb-1.5">
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
                className={`w-full min-h-[44px] flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-xl transition-colors cursor-pointer ${
                  activeSection === st.id
                    ? 'bg-orange-600/15 text-orange-400 font-semibold'
                    : 'text-stone-300 hover:bg-stone-900 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{st.name}</span>
                </span>
                {(canManage || workerScheduleStatus.phase !== 'outside') && (
                  <span
                    className={`text-xs font-mono shrink-0 ${
                      rep?.status === 'completed'
                        ? 'text-emerald-400'
                        : rep?.status === 'opening_saved'
                          ? 'text-amber-400'
                          : 'text-stone-500'
                    }`}
                  >
                    {rep?.status === 'completed'
                      ? 'Listo'
                      : rep?.status === 'opening_saved'
                        ? 'Avance'
                        : '—'}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {canManage && (
          <div className="space-y-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-stone-500 mb-1.5">
              Administración
            </p>
            <button
              type="button"
              onClick={() => {
                setCatalogFilterStation('all');
                navigateTo('catalogo');
              }}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-xl transition-colors cursor-pointer ${
                activeSection === 'catalogo'
                  ? 'bg-orange-600/15 text-orange-400 font-semibold'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <Package className="w-4 h-4 shrink-0" />
              <span className="truncate">Insumos</span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo('puestos')}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-xl transition-colors cursor-pointer ${
                activeSection === 'puestos'
                  ? 'bg-orange-600/15 text-orange-400 font-semibold'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <QrCode className="w-4 h-4 shrink-0" />
              <span className="truncate">Puestos y Códigos QR</span>
            </button>
            <button
              type="button"
              onClick={() => navigateTo('equipo')}
              className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-xl transition-colors cursor-pointer ${
                activeSection === 'equipo'
                  ? 'bg-orange-600/15 text-orange-400 font-semibold'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <Users className="w-4 h-4 shrink-0" />
              <span className="truncate">Equipo y Perfil</span>
            </button>
          </div>
        )}
      </nav>

      <div className="p-4 border-t border-stone-800/80 space-y-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{displayAccountName}</p>
          <p className="text-xs text-stone-400 truncate">
            {canManage
              ? 'Jefe / Administrador'
              : currentStation?.name ?? 'Trabajadora de puesto'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full min-h-[38px] inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-stone-200 bg-stone-900 border border-stone-800 rounded-xl hover:bg-stone-800 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Cerrar sesión
        </button>
      </div>
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen overflow-x-hidden bg-stone-50 text-stone-900 flex">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen no-print">
          {sidebarContent}
        </aside>

        {/* Mobile Drawer */}
        <AnimatePresence>
          {mobileNavOpen && (
            <div className="fixed inset-0 z-50 lg:hidden flex no-print">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 bg-stone-950/60 backdrop-blur-xs"
                onClick={() => setMobileNavOpen(false)}
              />
              <motion.div
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="relative w-72 max-w-[85vw] h-full z-10"
              >
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Cerrar menú"
                  className="absolute top-4 right-3 z-20 p-1.5 text-stone-400 hover:text-white rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
                {sidebarContent}
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Main Content Area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top Header */}
          <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-stone-200 px-3.5 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-2 sm:gap-4 no-print">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Abrir navegación"
                className="lg:hidden p-2 -ml-1 text-stone-600 hover:text-stone-900 rounded-xl shrink-0 cursor-pointer"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2 text-sm min-w-0">
                <span className="text-stone-400 hidden sm:inline whitespace-nowrap">
                  {workspace.name}
                </span>
                <span className="text-stone-300 hidden sm:inline">/</span>
                <span className="font-semibold text-stone-900 truncate">
                  {sectionBreadcrumb}
                </span>
              </div>
            </div>

            {canManage ? (
              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                {!isOnline && (
                  <span
                    role="status"
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg"
                  >
                    <WifiOff className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden sm:inline">Sin señal</span>
                  </span>
                )}
                <div className="flex items-center gap-0.5 p-0.5 sm:p-1 bg-stone-100 rounded-xl">
                  <button
                    type="button"
                    onClick={() => handleSelectDate(yesterdayStr)}
                    className={`min-h-[32px] px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      selectedDate === yesterdayStr
                        ? 'bg-white text-stone-900 shadow-sm'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    Ayer
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectDate(todayStr)}
                    className={`min-h-[32px] px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      selectedDate === todayStr
                        ? 'bg-white text-stone-900 shadow-sm'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    Hoy
                  </button>
                </div>

                <div className="relative flex items-center">
                  <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-stone-500 absolute left-2 sm:left-2.5 pointer-events-none" />
                  <input
                    type="date"
                    aria-label="Seleccionar fecha del reporte"
                    value={selectedDate}
                    onChange={(e) => e.target.value && handleSelectDate(e.target.value)}
                    className="min-h-[36px] pl-7 sm:pl-8 pr-1.5 sm:pr-2.5 py-1 text-xs sm:text-sm font-mono tabular-nums bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 w-[112px] sm:w-auto"
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 shrink-0">
                {!isOnline && (
                  <span
                    role="status"
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg"
                  >
                    <WifiOff className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden sm:inline">Sin señal</span>
                  </span>
                )}
                <div
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border ${
                    workerScheduleStatus.phase === 'opening'
                      ? 'bg-orange-50 text-orange-800 border-orange-200'
                      : workerScheduleStatus.phase === 'closing'
                        ? 'bg-stone-950 text-white border-stone-950'
                        : workerScheduleStatus.phase === 'unrestricted'
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          : 'bg-stone-100 text-stone-600 border-stone-200'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  <span className="whitespace-nowrap">
                    {workerScheduleStatus.phase === 'opening'
                      ? 'Horario: Apertura'
                      : workerScheduleStatus.phase === 'closing'
                        ? 'Horario: Cierre'
                        : workerScheduleStatus.phase === 'unrestricted'
                          ? 'Acceso activo'
                          : 'Fuera de horario'}
                  </span>
                </div>
              </div>
            )}
          </header>

          {/* Workspace Viewport */}
          <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 min-w-0">
            {dataLoading ? (
              <ViewSkeleton />
            ) : (
              <Suspense fallback={<ViewSkeleton />}>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeSection}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="min-w-0"
                  >
                    {activeSection === 'jefe' && canManage ? (
                      <BossDashboard
                        workspace={workspace}
                        callerUid={user.uid}
                        isOwner={isOwner}
                        workspaceName={workspace.name}
                        ownerName={workspace.ownerName}
                        shiftSchedule={workspace.shiftSchedule}
                        selectedDate={selectedDate}
                        todayStr={todayStr}
                        yesterdayStr={yesterdayStr}
                        yesterdayHasReports={yesterdayHasReports}
                        autoSelectedYesterday={autoSelectedYesterday}
                        stations={effectiveStations}
                        items={effectiveItems}
                        reportsByStation={reportsForSelectedDate}
                        entriesByItemId={consolidatedEntriesByItemId}
                        allReports={allReports}
                        entriesByReportId={dashboardEntriesByReportId}
                        onSelectDate={handleSelectDate}
                        onOpenStation={(stId) => navigateTo(stId)}
                        onGoToWorkstations={() => navigateTo('puestos')}
                        onGoToCatalog={() => {
                          setCatalogFilterStation('all');
                          navigateTo('catalogo');
                        }}
                        onGoToTeam={() => navigateTo('equipo')}
                        onOpenScheduleModal={() => setScheduleModalOpen(true)}
                        onResetComplete={handleResetComplete}
                      />
                    ) : activeSection === 'puestos' && canManage ? (
                      <WorkstationsManager
                        workspace={workspace}
                        isOwner={isOwner}
                        stations={effectiveStations}
                        items={effectiveItems}
                        stationLinksByCode={stationLinksByCode}
                        onOpenStationSheet={(stId) => navigateTo(stId)}
                        onOpenStationCatalog={(stId) => {
                          setCatalogFilterStation(stId);
                          navigateTo('catalogo');
                        }}
                        onGoToCatalog={() => {
                          setCatalogFilterStation('all');
                          navigateTo('catalogo');
                        }}
                      />
                    ) : activeSection === 'catalogo' && canManage ? (
                      <CatalogManager
                        workspace={workspace}
                        stations={effectiveStations}
                        items={effectiveItems}
                        initialFilterStation={catalogFilterStation}
                        onGoToWorkstations={() => navigateTo('puestos')}
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
                        scheduleStatus={workerScheduleStatus}
                        station={currentStation}
                        selectedDate={effectiveSelectedDate}
                        items={effectiveItems}
                        report={reportsForSelectedDate[currentStation.id]}
                        entriesByItemId={currentStationEntries}
                        isOnline={isOnline}
                        hasPendingWrites={reportHasPendingWrites}
                        onSaved={handleStationSaved}
                      />
                    ) : (
                      <div className="bg-white border border-stone-200 rounded-2xl p-10 text-center space-y-3">
                        <p className="font-display text-lg font-semibold text-stone-900">
                          No hay puestos de trabajo disponibles
                        </p>
                        <p className="text-sm text-stone-600 max-w-md mx-auto">
                          {canManage
                            ? 'Crea un puesto de trabajo para comenzar a gestionar los insumos y generar su código QR.'
                            : 'Solicita al jefe que te comparta el enlace o código QR de tu puesto de trabajo.'}
                        </p>
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => navigateTo('puestos')}
                            className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 cursor-pointer"
                          >
                            Ir a Puestos de Trabajo
                          </button>
                        )}
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </Suspense>
            )}
          </main>
        </div>

        {/* First-Time Boss Onboarding Name Prompt */}
        {needsOwnerNameOnboarding && (
          <Suspense fallback={null}>
            <BossWelcomeModal workspace={workspace} suggestedName={user.displayName} />
          </Suspense>
        )}

        {/* Boss Shift Schedule Config Modal */}
        {canManage && scheduleModalOpen && (
          <Suspense fallback={null}>
            <ShiftScheduleModal
              workspace={workspace}
              open={scheduleModalOpen}
              onClose={() => setScheduleModalOpen(false)}
            />
          </Suspense>
        )}
      </div>
    </MotionConfig>
  );
}
