import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Download,
  GitCompareArrows,
  History,
  MessageSquareText,
  Package,
  Printer,
  QrCode,
  Search,
  Settings,
  ShoppingBag,
  TrendingUp,
  Users,
} from 'lucide-react';
import { WORKER_GRACE_MINUTES } from '../constants';
import type {
  ConsolidatedItemRow,
  DailyReport,
  DailyReportEntry,
  InventoryItem,
  ShiftSchedule,
  StationId,
  Workstation,
} from '../types';
import {
  buildConsolidatedRows,
  buildWeeklyStationHistory,
  buildWhatsAppShoppingList,
  detectDashboardConsumptionAnomalies,
  downloadDailyCsvReport,
  formatDateHuman,
  formatTimeShort,
  getStockLevelMeta,
  hasTargetBelowMin,
} from '../utils/inventory';
import { BOGOTA_TIME_ZONE, getBogotaNowParts } from '../utils/date';
import {
  formatTime12h,
  hasClosingDeadlinePassed,
  normalizeShiftSchedule,
} from '../utils/schedule';

interface BossDashboardProps {
  workspaceName: string;
  ownerName?: string;
  shiftSchedule?: ShiftSchedule;
  selectedDate: string;
  todayStr: string;
  yesterdayStr: string;
  yesterdayHasReports: boolean;
  autoSelectedYesterday?: boolean;
  stations: Workstation[];
  items: InventoryItem[];
  reportsByStation: Record<string, DailyReport | undefined>;
  entriesByItemId: Record<string, DailyReportEntry>;
  allReports: DailyReport[];
  entriesByReportId: Record<string, Record<string, DailyReportEntry>>;
  onSelectDate: (dateStr: string) => void;
  onOpenStation: (stationId: StationId) => void;
  onGoToWorkstations: () => void;
  onGoToCatalog: () => void;
  onGoToTeam: () => void;
  onOpenScheduleModal: () => void;
}

type ViewTab = 'compras' | 'completo';
type StockFilter = 'todos' | 'comprar' | 'medio' | 'suficiente' | 'sin_dato';

interface OpeningDiffItem {
  itemId: string;
  itemName: string;
  unit: string;
  stationId: StationId;
  stationName: string;
  previousClosing: number;
  opening: number;
  delta: number;
}

interface GroupedShoppingSection {
  stationId: string;
  stationName: string;
  workerName: string;
  rows: ConsolidatedItemRow[];
}

function getTimeGreeting(): string {
  const hour = getBogotaNowParts().hour;
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function formatQty(val: number): string {
  const rounded = Math.round(val * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatSignedDelta(delta: number): string {
  const rounded = Math.round(delta * 100) / 100;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function formatShortDayHeader(dateStr: string): { weekday: string; dayNum: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return { weekday: '', dayNum: dateStr };
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const weekday = new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    weekday: 'short',
  })
    .format(dt)
    .replace('.', '');
  return { weekday, dayNum: String(d) };
}

export function BossDashboard({
  workspaceName,
  ownerName,
  shiftSchedule,
  selectedDate,
  todayStr,
  yesterdayStr,
  yesterdayHasReports,
  autoSelectedYesterday = false,
  stations,
  items,
  reportsByStation,
  entriesByItemId,
  allReports,
  entriesByReportId,
  onSelectDate,
  onOpenStation,
  onGoToWorkstations,
  onGoToCatalog,
  onGoToTeam,
  onOpenScheduleModal,
}: BossDashboardProps) {
  const [viewTab, setViewTab] = useState<ViewTab>('compras');
  const [stationFilter, setStationFilter] = useState<'all' | StationId>('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('todos');
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedToast, setCopiedToast] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const normalizedSchedule = useMemo(
    () => normalizeShiftSchedule(shiftSchedule),
    [shiftSchedule],
  );

  const stationMap = useMemo(() => {
    const map: Record<string, Workstation> = {};
    stations.forEach((s) => {
      map[s.id] = s;
    });
    return map;
  }, [stations]);

  const consolidatedRows = useMemo(
    () => buildConsolidatedRows(items, entriesByItemId, reportsByStation),
    [items, entriesByItemId, reportsByStation],
  );

  const metrics = useMemo(() => {
    const completedStations = stations.filter(
      (s) => reportsByStation[s.id]?.status === 'completed',
    ).length;
    const missingStations = Math.max(0, stations.length - completedStations);
    const anyReportedStations = stations.filter((s) => Boolean(reportsByStation[s.id])).length;
    const toBuy = consolidatedRows.filter(
      (r) => r.hasCountedClosing && (r.stockLevel === 'agotado' || r.stockLevel === 'comprar'),
    ).length;
    const lowSoon = consolidatedRows.filter(
      (r) => r.hasCountedClosing && r.stockLevel === 'medio',
    ).length;
    const outOfStock = consolidatedRows.filter(
      (r) => r.hasCountedClosing && r.stockLevel === 'agotado',
    ).length;
    const sufficient = consolidatedRows.filter(
      (r) => r.hasCountedClosing && r.stockLevel === 'suficiente',
    ).length;
    const pendingCount = consolidatedRows.filter((r) => r.stockLevel === 'sin_dato').length;

    return {
      completedStations,
      missingStations,
      anyReportedStations,
      toBuy,
      lowSoon,
      outOfStock,
      sufficient,
      pendingCount,
    };
  }, [consolidatedRows, reportsByStation, stations]);

  const openingAudit = useMemo(() => {
    let confirmedMatchCount = 0;
    const adjustedItems: OpeningDiffItem[] = [];
    const byStation: Record<string, { confirmedMatch: number; adjusted: number }> = {};

    consolidatedRows.forEach((row) => {
      const entry = row.entry;
      if (!entry || !entry.hasOpening || entry.notApplicable) return;

      if (!byStation[row.item.station]) {
        byStation[row.item.station] = { confirmedMatch: 0, adjusted: 0 };
      }

      const hasPrev = typeof entry.previousClosing === 'number';
      const isAdjusted =
        entry.openingStatus === 'adjusted' ||
        (hasPrev && entry.opening !== entry.previousClosing);
      const isConfirmedMatch =
        entry.openingStatus === 'confirmed_match' ||
        (hasPrev && entry.opening === entry.previousClosing);

      if (isAdjusted && hasPrev) {
        const prev = entry.previousClosing as number;
        byStation[row.item.station].adjusted += 1;
        adjustedItems.push({
          itemId: row.item.id,
          itemName: row.item.name,
          unit: row.item.unit,
          stationId: row.item.station,
          stationName: stationMap[row.item.station]?.name ?? row.item.station,
          previousClosing: prev,
          opening: entry.opening,
          delta: Math.round((entry.opening - prev) * 100) / 100,
        });
      } else if (isConfirmedMatch) {
        confirmedMatchCount += 1;
        byStation[row.item.station].confirmedMatch += 1;
      }
    });

    return {
      confirmedMatchCount,
      adjustedItems,
      byStation,
      hasAuditData: confirmedMatchCount > 0 || adjustedItems.length > 0,
    };
  }, [consolidatedRows, stationMap]);

  const stationNotes = useMemo(() => {
    return stations
      .map((st) => {
        const rep = reportsByStation[st.id];
        if (!rep?.notes?.trim()) return null;
        return { stationName: st.name, workerName: st.workerName, notes: rep.notes.trim() };
      })
      .filter((n): n is { stationName: string; workerName: string; notes: string } => Boolean(n));
  }, [stations, reportsByStation]);

  const closingDeadlinePassed = useMemo(
    () =>
      hasClosingDeadlinePassed(
        new Date(),
        selectedDate,
        normalizedSchedule,
        WORKER_GRACE_MINUTES,
      ),
    [selectedDate, normalizedSchedule],
  );

  const overdueStations = useMemo(() => {
    if (!closingDeadlinePassed) return [];
    return stations.filter((st) => reportsByStation[st.id]?.status !== 'completed');
  }, [closingDeadlinePassed, stations, reportsByStation]);

  const consumptionAnomalies = useMemo(
    () =>
      detectDashboardConsumptionAnomalies({
        selectedDate,
        rows: consolidatedRows,
        stations,
        allReports,
        entriesByReportId,
      }),
    [selectedDate, consolidatedRows, stations, allReports, entriesByReportId],
  );

  const consumptionAnomalyByItemId = useMemo(() => {
    const map: Record<string, (typeof consumptionAnomalies)[number]> = {};
    consumptionAnomalies.forEach((a) => {
      map[a.itemId] = a;
    });
    return map;
  }, [consumptionAnomalies]);

  const weeklyHistory = useMemo(
    () =>
      buildWeeklyStationHistory({
        endDateStr: todayStr,
        stations,
        items,
        allReports,
        entriesByReportId,
        schedule: normalizedSchedule,
      }),
    [todayStr, stations, items, allReports, entriesByReportId, normalizedSchedule],
  );

  const targetBelowMinCount = useMemo(
    () => items.filter((it) => it.active && hasTargetBelowMin(it.minStock, it.targetStock)).length,
    [items],
  );

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return consolidatedRows.filter((row) => {
      if (stationFilter !== 'all' && row.item.station !== stationFilter) return false;
      if (term && !row.item.name.toLowerCase().includes(term)) return false;

      if (viewTab === 'compras') {
        if (stockFilter === 'todos') {
          return (
            row.stockLevel === 'agotado' ||
            row.stockLevel === 'comprar' ||
            row.stockLevel === 'medio'
          );
        }
        if (stockFilter === 'comprar') {
          return row.stockLevel === 'agotado' || row.stockLevel === 'comprar';
        }
        return row.stockLevel === stockFilter;
      } else {
        if (stockFilter === 'comprar') {
          return row.stockLevel === 'agotado' || row.stockLevel === 'comprar';
        }
        if (stockFilter !== 'todos' && row.stockLevel !== stockFilter) return false;
        return true;
      }
    });
  }, [consolidatedRows, stationFilter, stockFilter, searchTerm, viewTab]);

  const sortedShoppingRows = useMemo(() => {
    const priority: Record<ConsolidatedItemRow['stockLevel'], number> = {
      agotado: 0,
      comprar: 1,
      medio: 2,
      suficiente: 3,
      sin_dato: 4,
    };
    return [...filteredRows].sort((a, b) => {
      if (priority[a.stockLevel] !== priority[b.stockLevel]) {
        return priority[a.stockLevel] - priority[b.stockLevel];
      }
      return a.item.station.localeCompare(b.item.station) || a.item.sortOrder - b.item.sortOrder;
    });
  }, [filteredRows]);

  const groupedShoppingSections = useMemo<GroupedShoppingSection[]>(() => {
    const byStation = new Map<string, ConsolidatedItemRow[]>();
    sortedShoppingRows.forEach((row) => {
      const list = byStation.get(row.item.station) ?? [];
      list.push(row);
      byStation.set(row.item.station, list);
    });

    const priority: Record<ConsolidatedItemRow['stockLevel'], number> = {
      agotado: 0,
      comprar: 1,
      medio: 2,
      suficiente: 3,
      sin_dato: 4,
    };

    const sections: GroupedShoppingSection[] = [];
    const seen = new Set<string>();

    stations.forEach((st) => {
      const rows = byStation.get(st.id);
      if (!rows || rows.length === 0) return;
      seen.add(st.id);
      sections.push({
        stationId: st.id,
        stationName: st.name,
        workerName: st.workerName,
        rows: [...rows].sort(
          (a, b) =>
            priority[a.stockLevel] - priority[b.stockLevel] || a.item.sortOrder - b.item.sortOrder,
        ),
      });
    });

    byStation.forEach((rows, stId) => {
      if (seen.has(stId) || rows.length === 0) return;
      sections.push({
        stationId: stId,
        stationName: stationMap[stId]?.name ?? stId,
        workerName: stationMap[stId]?.workerName ?? 'Equipo',
        rows,
      });
    });

    return sections;
  }, [sortedShoppingRows, stations, stationMap]);

  const handleCopyWhatsApp = async () => {
    const text = buildWhatsAppShoppingList(selectedDate, consolidatedRows, stations);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedToast(true);
      setTimeout(() => setCopiedToast(false), 2500);
    } catch {
      // Clipboard blocked
    }
  };

  const handleExportCsv = () => {
    downloadDailyCsvReport(selectedDate, consolidatedRows, stations);
  };

  const showSwitchToYesterday =
    selectedDate === todayStr && metrics.anyReportedStations === 0 && yesterdayHasReports;

  const greetingTitle = ownerName?.trim()
    ? `${getTimeGreeting()}, ${ownerName.trim()}`
    : `${getTimeGreeting()} · ${workspaceName}`;

  const scheduleSummaryLabel = normalizedSchedule.enabled
    ? `Apertura ${formatTime12h(normalizedSchedule.openingStart)}–${formatTime12h(normalizedSchedule.openingEnd)} · Cierre ${formatTime12h(normalizedSchedule.closingStart)}–${formatTime12h(normalizedSchedule.closingEnd)}`
    : 'Horarios sin restricción';

  return (
    <div className="space-y-6 sm:space-y-7 print-full min-w-0">
      {/* Clean Personalized Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            {workspaceName} · {formatDateHuman(selectedDate)}
            {selectedDate === yesterdayStr ? ' (Cierre de ayer)' : ''}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-1 [text-wrap:balance]">
            {greetingTitle}
          </h1>
          <p className="text-sm text-stone-600 mt-1">
            Control de apertura, cierres del día y lista de compras.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 no-print">
          <button
            type="button"
            onClick={handleCopyWhatsApp}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedToast ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedToast ? 'Lista copiada' : 'Copiar lista WhatsApp'}
          </button>
          <button
            type="button"
            onClick={onOpenScheduleModal}
            className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-stone-800 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Clock className="w-4 h-4 text-orange-600" />
            <span>Horarios</span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            aria-label="Exportar CSV"
            className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>CSV</span>
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            aria-label="Imprimir reporte"
            className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            <span className="hidden sm:inline">Imprimir</span>
          </button>
        </div>
      </div>

      {/* Visible Late-Closing Warning */}
      {overdueStations.length > 0 && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-2xl px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-3 text-sm text-red-950 min-w-0">
            <AlertOctagon className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-bold">
                {overdueStations.length === 1
                  ? '1 puesto no ha cerrado pasada la hora límite'
                  : `${overdueStations.length} puestos no han cerrado pasada la hora límite`}
              </p>
              <p className="text-xs text-red-800 leading-relaxed">
                Pasó la hora de cierre ({formatTime12h(normalizedSchedule.closingEnd)} +{WORKER_GRACE_MINUTES} min). Faltan:{' '}
                <strong>{overdueStations.map((s) => s.name).join(', ')}</strong>.
              </p>
            </div>
          </div>
          {overdueStations.length === 1 && (
            <button
              type="button"
              onClick={() => onOpenStation(overdueStations[0].id)}
              className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Revisar planilla
            </button>
          )}
        </div>
      )}

      {/* Catalog threshold warning if any item has targetStock < minStock */}
      {targetBelowMinCount > 0 && (
        <div
          role="status"
          className="bg-amber-50 border border-amber-200 rounded-2xl px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-amber-950 no-print"
        >
          <div className="flex items-start sm:items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5 sm:mt-0" />
            <span>
              Hay <strong>{targetBelowMinCount}</strong>{' '}
              {targetBelowMinCount === 1 ? 'insumo' : 'insumos'} en el catálogo con{' '}
              <strong>stock ideal menor que el stock mínimo</strong>.
            </span>
          </div>
          <button
            type="button"
            onClick={onGoToCatalog}
            className="text-xs font-semibold text-amber-900 underline hover:text-amber-700 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Ajustar en catálogo
          </button>
        </div>
      )}

      {/* Single Clean Contextual Date Banner (only shown when helpful) */}
      {showSwitchToYesterday ? (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-stone-950 text-white rounded-2xl px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 no-print"
        >
          <div className="flex items-start sm:items-center gap-3 text-sm min-w-0">
            <CalendarClock className="w-5 h-5 text-orange-400 shrink-0 mt-0.5 sm:mt-0" />
            <span>
              Aún no hay cierres hoy. Puedes revisar el cierre de anoche ({formatDateHuman(yesterdayStr)}) para planear las compras.
            </span>
          </div>
          <button
            type="button"
            onClick={() => onSelectDate(yesterdayStr)}
            className="min-h-[40px] px-4 py-2 text-xs font-semibold text-stone-950 bg-white rounded-xl hover:bg-stone-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Ver cierre de anoche
          </button>
        </motion.div>
      ) : autoSelectedYesterday && selectedDate === yesterdayStr ? (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-orange-50 border border-orange-200 rounded-2xl px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-sm text-orange-950 no-print"
        >
          <span>
            Mostrando el cierre de anoche ({formatDateHuman(yesterdayStr)}) para revisar tus compras de hoy.
          </span>
          <button
            type="button"
            onClick={() => onSelectDate(todayStr)}
            className="text-xs font-semibold text-orange-700 underline hover:text-orange-900 cursor-pointer"
          >
            Ir a hoy
          </button>
        </motion.div>
      ) : null}

      {/* Semáforo KPI Summary Strip using gap-px */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        aria-label="Resumen semáforo del día"
        className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-stone-200 border border-stone-200 rounded-2xl overflow-hidden"
      >
        <div className="bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-stone-600">
              {metrics.missingStations > 0 ? 'Faltan por cerrar' : 'Puestos cerrados'}
            </p>
            <span
              aria-hidden="true"
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                metrics.missingStations === 0 && stations.length > 0
                  ? 'bg-emerald-500'
                  : 'bg-amber-500'
              }`}
            />
          </div>
          <p
            className={`font-mono tabular-nums text-2xl sm:text-3xl font-bold mt-1 ${
              metrics.missingStations === 0 && stations.length > 0
                ? 'text-emerald-700'
                : 'text-stone-900'
            }`}
          >
            {metrics.missingStations > 0
              ? `${metrics.missingStations} de ${stations.length}`
              : `${metrics.completedStations} / ${stations.length}`}
          </p>
          <p className="text-xs text-stone-600 mt-1">
            {metrics.missingStations === 0 && stations.length > 0
              ? 'Todos cerraron turno'
              : `${metrics.completedStations} cerrados · en espera`}
          </p>
        </div>

        <div className="bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-stone-600">Comprar</p>
            <span
              aria-hidden="true"
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                metrics.toBuy > 0 ? 'bg-red-600' : 'bg-stone-300'
              }`}
            />
          </div>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-red-700 mt-1">
            {metrics.toBuy}
          </p>
          <p className="text-xs text-stone-600 mt-1">
            {metrics.outOfStock > 0
              ? `${metrics.outOfStock} agotados · cierres reales`
              : 'Solo cierres completados'}
          </p>
        </div>

        <div className="bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-stone-600">Pronto a acabarse</p>
            <span
              aria-hidden="true"
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                metrics.lowSoon > 0 ? 'bg-amber-500' : 'bg-stone-300'
              }`}
            />
          </div>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-amber-700 mt-1">
            {metrics.lowSoon}
          </p>
          <p className="text-xs text-stone-600 mt-1">Vigilar para reponer</p>
        </div>

        <div className="bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-stone-600">Stock suficiente</p>
            <span
              aria-hidden="true"
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                metrics.sufficient > 0 ? 'bg-emerald-500' : 'bg-stone-300'
              }`}
            />
          </div>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-emerald-700 mt-1">
            {metrics.sufficient}
          </p>
          <p className="text-xs text-stone-600 mt-1">
            {metrics.pendingCount > 0
              ? `${metrics.pendingCount} sin dato aún`
              : 'Sin compra urgente'}
          </p>
        </div>
      </motion.section>

      {/* Opening Audit: Yesterday's Closing vs Today's Opening Differences */}
      {openingAudit.hasAuditData && (
        <section className="bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-stone-900">
              <GitCompareArrows className="w-4 h-4 text-orange-600 shrink-0" />
              <span>Revisión de apertura (Ayer vs. Inicio hoy)</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium">
              <span className="text-emerald-700 font-semibold font-mono tabular-nums">
                {openingAudit.confirmedMatchCount} coincidieron con ayer
              </span>
              <span
                className={`font-semibold font-mono tabular-nums ${
                  openingAudit.adjustedItems.length > 0 ? 'text-amber-700' : 'text-stone-500'
                }`}
              >
                {openingAudit.adjustedItems.length}{' '}
                {openingAudit.adjustedItems.length === 1 ? 'corregido' : 'corregidos'} al abrir
              </span>
            </div>
          </div>

          {openingAudit.adjustedItems.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {openingAudit.adjustedItems.map((diff) => (
                <div
                  key={diff.itemId}
                  className="bg-amber-50/70 border border-amber-200 rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-stone-900 truncate">
                      {diff.itemName}
                    </p>
                    <p className="text-xs text-stone-600 truncate">
                      {diff.stationName} · Ayer quedó{' '}
                      <span className="font-mono tabular-nums font-semibold text-stone-800">
                        {formatQty(diff.previousClosing)}
                      </span>{' '}
                      → Hoy abrió{' '}
                      <span className="font-mono tabular-nums font-semibold text-stone-900">
                        {formatQty(diff.opening)} {diff.unit}
                      </span>
                    </p>
                  </div>
                  <span
                    className={`font-mono tabular-nums text-xs font-bold shrink-0 ${
                      diff.delta < 0 ? 'text-red-700' : 'text-amber-800'
                    }`}
                  >
                    {formatSignedDelta(diff.delta)} {diff.unit}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-stone-600">
              Todos los insumos confirmados al abrir coincidieron exactamente con el cierre de ayer.
            </p>
          )}
        </section>
      )}

      {/* Anomalous Consumption Items */}
      {consumptionAnomalies.length > 0 && (
        <section className="bg-red-50/70 border border-red-200 rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-red-950">
              <TrendingUp className="w-4 h-4 text-red-600 shrink-0" />
              <span>Insumos con consumo anómalo ({consumptionAnomalies.length})</span>
            </div>
            <span className="text-xs text-red-800">
              Cierre mayor a inicio + surtido o muy por encima del promedio (7 días)
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {consumptionAnomalies.map((anomaly) => (
              <div
                key={`${anomaly.itemId}-${anomaly.kind}`}
                className="bg-white border border-red-200/80 rounded-xl px-3.5 py-2.5 flex items-start justify-between gap-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-stone-900">{anomaly.itemName}</p>
                    <span className="text-[11px] font-semibold text-red-700">
                      {anomaly.kind === 'closing_exceeds_available'
                        ? 'Sobra al cierre'
                        : 'Consumo alto vs. promedio'}
                    </span>
                  </div>
                  <p className="text-xs text-stone-500 truncate">{anomaly.stationName}</p>
                  <p className="text-xs text-stone-700 leading-relaxed">{anomaly.summary}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenStation(anomaly.stationId)}
                  className="text-xs font-semibold text-orange-700 hover:text-orange-800 whitespace-nowrap shrink-0 pt-0.5 cursor-pointer"
                >
                  Ver puesto
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Actionable Daily Highlights: Notes & Things to Keep in Mind */}
      {stationNotes.length > 0 && (
        <section className="bg-amber-50/70 border border-amber-200 rounded-2xl p-4 sm:p-5 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-bold text-amber-950">
            <MessageSquareText className="w-4 h-4 text-amber-700 shrink-0" />
            <span>Novedades y notas dejadas por las trabajadoras</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {stationNotes.map((item) => (
              <div
                key={item.stationName}
                className="bg-white/90 border border-amber-200/80 rounded-xl px-3.5 py-2.5 text-sm"
              >
                <p className="text-xs font-semibold text-stone-900">
                  {item.stationName}{' '}
                  <span className="font-normal text-stone-600">· {item.workerName}</span>
                </p>
                <p className="text-xs text-stone-700 mt-0.5">&ldquo;{item.notes}&rdquo;</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Dynamic Stations Overview */}
      <section className="space-y-3 no-print">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-stone-900">
            Estado de los puestos
          </h2>
          <button
            type="button"
            onClick={onGoToWorkstations}
            className="min-h-[36px] text-xs sm:text-sm font-semibold text-orange-700 hover:text-orange-800 whitespace-nowrap cursor-pointer"
          >
            + Administrar puestos
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5 sm:gap-4">
          {stations.map((station, index) => {
            const report = reportsByStation[station.id];
            const stationRows = consolidatedRows.filter((r) => r.item.station === station.id);
            const lowCount = stationRows.filter(
              (r) => r.stockLevel === 'agotado' || r.stockLevel === 'comprar',
            ).length;
            const stAudit = openingAudit.byStation[station.id];

            const closeTime =
              report?.status === 'completed' ? formatTimeShort(report?.updatedAt) : null;
            const draftTime =
              report?.status === 'opening_saved' ? formatTimeShort(report?.updatedAt) : null;

            return (
              <motion.div
                key={station.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.2) }}
                whileHover={{ y: -2 }}
                className="min-w-0 bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-4 transition-shadow hover:shadow-md"
              >
                <div className="space-y-2 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-display text-base font-bold text-stone-900 leading-snug truncate">
                      {station.name}
                    </h3>
                    <span className="font-mono tabular-nums text-xs font-medium text-stone-500 shrink-0 pt-0.5">
                      {stationRows.length} ins.
                    </span>
                  </div>

                  <p className="text-xs text-stone-600 truncate">
                    Encargada:{' '}
                    <span className="font-medium text-stone-900">{station.workerName}</span>
                  </p>

                  {report?.status === 'completed' ? (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 pt-1">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>Cerrado{closeTime ? ` · ${closeTime}` : ''}</span>
                    </div>
                  ) : closingDeadlinePassed ? (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 pt-1">
                      <AlertOctagon className="w-4 h-4 shrink-0" />
                      <span>
                        {report?.status === 'opening_saved'
                          ? 'Sin cierre · Pasada la hora'
                          : 'Sin reporte · Pasada la hora'}
                      </span>
                    </div>
                  ) : report?.status === 'opening_saved' ? (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 pt-1">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>Apertura guardada{draftTime ? ` · ${draftTime}` : ''}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs font-medium text-stone-600 pt-1">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>Pendiente por reportar</span>
                    </div>
                  )}

                  {stAudit && (stAudit.confirmedMatch > 0 || stAudit.adjusted > 0) && (
                    <p className="text-xs text-stone-600 font-mono tabular-nums">
                      Apertura: {stAudit.confirmedMatch} igual
                      {stAudit.adjusted > 0 ? (
                        <span className="text-amber-700 font-semibold">
                          {' '}
                          · {stAudit.adjusted} corregidos
                        </span>
                      ) : null}
                    </p>
                  )}

                  {report?.notes && (
                    <p className="text-xs text-stone-600 bg-stone-50 rounded-xl px-2.5 py-1.5 line-clamp-2 border border-stone-100">
                      &ldquo;{report.notes}&rdquo;
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-stone-100 flex items-center justify-between gap-2">
                  <span className="text-xs">
                    {report?.status !== 'completed' ? (
                      <span className="text-stone-600">Sin cierre aún</span>
                    ) : lowCount > 0 ? (
                      <span className="text-red-700 font-semibold">
                        {lowCount} por comprar
                      </span>
                    ) : (
                      <span className="text-emerald-700 font-medium">Stock en orden</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenStation(station.id)}
                    className="min-h-[40px] inline-flex items-center gap-1 text-xs font-semibold text-orange-700 hover:text-orange-800 whitespace-nowrap cursor-pointer"
                  >
                    Ver planilla
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Main Consolidated Shopping & Stock List */}
      <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-stone-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3.5 no-print">
          <div className="flex items-center gap-1 p-1 bg-stone-100 rounded-xl w-full sm:w-fit overflow-x-auto">
            <button
              type="button"
              onClick={() => setViewTab('compras')}
              className={`min-h-[40px] px-3.5 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                viewTab === 'compras'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Qué comprar ({metrics.toBuy + metrics.lowSoon})
            </button>
            <button
              type="button"
              onClick={() => setViewTab('completo')}
              className={`min-h-[40px] px-3.5 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                viewTab === 'completo'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Todo el inventario ({consolidatedRows.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <div className="relative flex-1 min-w-[160px] sm:flex-initial">
              <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Buscar insumo..."
                aria-label="Buscar insumo"
                className="w-full sm:w-44 min-h-[42px] pl-9 pr-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white"
              />
            </div>

            <select
              aria-label="Filtrar por puesto"
              value={stationFilter}
              onChange={(e) => setStationFilter(e.target.value as 'all' | StationId)}
              className="flex-1 sm:flex-initial min-h-[42px] px-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 max-w-full sm:max-w-[190px]"
            >
              <option value="all">Todos los puestos</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filtrar por estado"
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as StockFilter)}
              className="flex-1 sm:flex-initial min-h-[42px] px-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="todos">Todos los estados</option>
              <option value="comprar">Solo para comprar</option>
              <option value="medio">Pronto a acabarse</option>
              <option value="suficiente">Stock suficiente</option>
              <option value="sin_dato">Pendiente de contar</option>
            </select>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <ShoppingBag className="w-8 h-8 text-stone-400 mx-auto" />
            <h3 className="font-display text-lg font-semibold text-stone-900">
              Aún no hay insumos registrados
            </h3>
            <p className="text-sm text-stone-600 max-w-md mx-auto">
              Agrega insumos a tus puestos de trabajo en el catálogo para ver aquí el cierre diario y la lista de compras.
            </p>
            <button
              type="button"
              onClick={onGoToCatalog}
              className="mt-2 min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-stone-950 rounded-xl hover:bg-stone-800 transition-colors cursor-pointer"
            >
              Ir al catálogo de insumos
            </button>
          </div>
        ) : sortedShoppingRows.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-base font-semibold text-stone-800">
              {viewTab === 'compras'
                ? 'Todo al día: no hay insumos urgentes para comprar.'
                : 'No hay insumos que coincidan con tu búsqueda.'}
            </p>
            <p className="text-sm text-stone-600">
              Cambia a &ldquo;Todo el inventario&rdquo; o ajusta los filtros para revisar todos los productos.
            </p>
          </div>
        ) : viewTab === 'compras' ? (
          /* Station-Grouped Shopping List */
          <div className="divide-y divide-stone-200">
            {groupedShoppingSections.map((group) => {
              const urgentInGroup = group.rows.filter(
                (r) => r.stockLevel === 'agotado' || r.stockLevel === 'comprar',
              ).length;
              return (
                <div key={group.stationId} className="min-w-0">
                  <div className="px-4 sm:px-5 py-3 bg-stone-50 border-b border-stone-200/80 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-display text-sm sm:text-base font-bold text-stone-900 truncate">
                        {group.stationName}
                      </h3>
                      <p className="text-xs text-stone-600 truncate">
                        Encargada: {group.workerName}
                      </p>
                    </div>
                    <span className="text-xs font-semibold font-mono tabular-nums text-stone-700 whitespace-nowrap">
                      {urgentInGroup > 0
                        ? `${urgentInGroup} para comprar`
                        : `${group.rows.length} por vigilar`}
                    </span>
                  </div>

                  <div className="divide-y divide-stone-100">
                    {group.rows.map((row) => {
                      const meta = getStockLevelMeta(row.stockLevel);
                      return (
                        <div
                          key={row.item.id}
                          className="px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 hover:bg-stone-50/70 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm sm:text-base font-semibold text-stone-900">
                                {row.item.name}
                              </p>
                              <span
                                className={`inline-flex items-center gap-1 text-xs font-semibold ${meta.textClass}`}
                              >
                                {(row.stockLevel === 'agotado' ||
                                  row.stockLevel === 'comprar') && (
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                )}
                                {meta.label}
                              </span>
                            </div>
                            <p className="text-xs text-stone-600 font-mono tabular-nums mt-0.5">
                              Queda:{' '}
                              <strong className="text-stone-900">
                                {row.currentStock} {row.item.unit}
                              </strong>{' '}
                              · Mínimo: {row.item.minStock} {row.item.unit}
                            </p>
                          </div>

                          <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 font-mono tabular-nums">
                            {row.suggestedBuy > 0 ? (
                              <span className="text-sm font-bold text-red-700 whitespace-nowrap">
                                Pedir +{row.suggestedBuy} {row.item.unit}
                              </span>
                            ) : hasTargetBelowMin(row.item.minStock, row.item.targetStock) ? (
                              <span className="text-xs font-semibold text-amber-800 whitespace-nowrap">
                                Stock ideal &lt; mínimo
                              </span>
                            ) : (
                              <span className="text-xs font-medium text-amber-800 whitespace-nowrap">
                                Vigilar reposición
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {/* Mobile Clean Card List (< md) */}
            <div className="md:hidden divide-y divide-stone-200">
              {sortedShoppingRows.map((row) => {
                const meta = getStockLevelMeta(row.stockLevel);
                const stName = stationMap[row.item.station]?.name ?? row.item.station;
                const statusText = row.isNotApplicable
                  ? 'No aplica hoy'
                  : row.isProvisional
                    ? 'Provisional (apertura)'
                    : meta.label;
                const hasOpeningDiff =
                  row.entry?.hasOpening &&
                  !row.isNotApplicable &&
                  typeof row.entry.previousClosing === 'number' &&
                  row.entry.opening !== row.entry.previousClosing;

                return (
                  <div key={row.item.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-semibold text-stone-900 truncate">
                          {row.item.name}
                        </p>
                        <p className="text-xs text-stone-600 truncate">{stName}</p>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-semibold shrink-0 pt-0.5 ${meta.textClass}`}
                      >
                        {(row.stockLevel === 'agotado' || row.stockLevel === 'comprar') && (
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        )}
                        {statusText}
                      </span>
                    </div>

                    {hasOpeningDiff && row.entry && (
                      <p className="text-xs text-amber-800 font-mono tabular-nums">
                        Apertura corregida: ayer {formatQty(row.entry.previousClosing as number)} → hoy{' '}
                        {formatQty(row.entry.opening)}
                      </p>
                    )}

                    <div className="flex items-center justify-between gap-4 pt-1 text-sm font-mono tabular-nums">
                      <span className="text-stone-700">
                        Quedan:{' '}
                        <strong className="text-stone-900">
                          {row.isNotApplicable
                            ? 'No aplica'
                            : row.hasCountedClosing && row.currentStock !== null
                              ? `${row.currentStock} ${row.item.unit}`
                              : row.isProvisional && row.provisionalStock !== null
                                ? `${row.provisionalStock} ${row.item.unit} (Provisional)`
                                : 'Pendiente de contar'}
                        </strong>
                        <span className="text-stone-500 text-xs"> (Mín {row.item.minStock})</span>
                      </span>

                      {row.hasCountedClosing && row.suggestedBuy > 0 && (
                        <span className="font-bold text-red-700 shrink-0">
                          Pedir +{row.suggestedBuy} {row.item.unit}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop Table (md+) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th className="py-3.5 px-5">Insumo</th>
                    <th className="py-3.5 px-4">Puesto</th>
                    <th className="py-3.5 px-4 text-right">Base / Inicio</th>
                    <th className="py-3.5 px-4 text-right">Surtido</th>
                    <th className="py-3.5 px-4 text-right">Quedan al cierre</th>
                    <th className="py-3.5 px-4 text-right">Consumo</th>
                    <th className="py-3.5 px-4 text-right">Mínimo</th>
                    <th className="py-3.5 px-4 text-right">Pedir</th>
                    <th className="py-3.5 px-5">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-sm">
                  {sortedShoppingRows.map((row) => {
                    const meta = getStockLevelMeta(row.stockLevel);
                    const stName = stationMap[row.item.station]?.name ?? row.item.station;
                    const statusText = row.isNotApplicable
                      ? 'No aplica hoy'
                      : row.isProvisional
                        ? 'Provisional'
                        : meta.label;
                    const hasPrev = typeof row.entry?.previousClosing === 'number';
                    const isAdjustedOpening =
                      row.entry?.hasOpening &&
                      !row.isNotApplicable &&
                      hasPrev &&
                      (row.entry.openingStatus === 'adjusted' ||
                        row.entry.opening !== row.entry.previousClosing);

                    return (
                      <tr key={row.item.id} className="hover:bg-stone-50/80 transition-colors">
                        <td className="py-3.5 px-5">
                          <div className="font-semibold text-stone-900">{row.item.name}</div>
                          <div className="text-xs text-stone-500">{row.item.unit}</div>
                        </td>
                        <td className="py-3.5 px-4 text-stone-600 whitespace-nowrap max-w-[200px] truncate">
                          {stName}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-700">
                          {row.entry?.hasOpening && !row.isNotApplicable ? (
                            <div>
                              <span>{row.entry.opening}</span>
                              {isAdjustedOpening && hasPrev && (
                                <div className="text-[11px] font-semibold text-amber-700">
                                  Ayer: {row.entry.previousClosing}
                                </div>
                              )}
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-600">
                          {row.entry && !row.isNotApplicable && row.entry.added > 0
                            ? `+${row.entry.added}`
                            : '—'}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-stone-900">
                          {row.isNotApplicable ? (
                            <span className="text-stone-500 font-normal">No aplica</span>
                          ) : row.hasCountedClosing && row.currentStock !== null ? (
                            row.currentStock
                          ) : row.isProvisional && row.provisionalStock !== null ? (
                            <span
                              className="text-amber-700 font-medium"
                              title="Valor provisional de apertura; no entra en alertas de compra"
                            >
                              {row.provisionalStock} (prov.)
                            </span>
                          ) : (
                            <span className="text-stone-500 font-normal">Pendiente de contar</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-700">
                          {consumptionAnomalyByItemId[row.item.id]?.kind ===
                          'closing_exceeds_available' ? (
                            <span
                              className="text-red-700 font-semibold"
                              title={consumptionAnomalyByItemId[row.item.id].summary}
                            >
                              Anómalo (sobra)
                            </span>
                          ) : row.consumed !== null ? (
                            <span
                              className={
                                consumptionAnomalyByItemId[row.item.id]
                                  ? 'text-red-700 font-semibold'
                                  : undefined
                              }
                            >
                              {row.consumed}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-600">
                          <div>{row.item.minStock}</div>
                          {hasTargetBelowMin(row.item.minStock, row.item.targetStock) && (
                            <div className="text-[10px] font-semibold text-amber-700">
                              Ideal {row.item.targetStock} &lt; mín
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold">
                          {row.hasCountedClosing && row.suggestedBuy > 0 ? (
                            <span className="text-red-700">
                              +{row.suggestedBuy} {row.item.unit}
                            </span>
                          ) : (
                            <span className="text-stone-400 font-normal">—</span>
                          )}
                        </td>
                        <td className="py-3.5 px-5 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.textClass}`}
                          >
                            {(row.stockLevel === 'agotado' || row.stockLevel === 'comprar') && (
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            )}
                            {statusText}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {sortedShoppingRows.some((r) => !r.hasCountedClosing) && (
          <div className="px-5 py-3 bg-stone-50 border-t border-stone-200 text-xs text-stone-600">
            Nota: Los insumos sin cierre definitivo figuran como &ldquo;Pendiente de contar&rdquo; o &ldquo;Provisional&rdquo; y no generan alertas falsas de compra ni entran al WhatsApp.
          </div>
        )}
      </section>

      {/* 7-Day Station History */}
      {stations.length > 0 && (
        <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden no-print">
          <div className="px-4 sm:px-5 py-4 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-orange-600 shrink-0" />
              <div>
                <h2 className="font-display text-base font-bold text-stone-900">
                  Historial de los últimos 7 días por puesto
                </h2>
                <p className="text-xs text-stone-500">
                  Toca cualquier día para abrir su reporte completo
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-stone-600">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                Cerrado
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                Solo apertura
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                Sin cierre
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                  <th className="py-3 px-4 sm:px-5 min-w-[160px]">Puesto</th>
                  {weeklyHistory.dates.map((date) => {
                    const { weekday, dayNum } = formatShortDayHeader(date);
                    const isSelected = date === selectedDate;
                    return (
                      <th key={date} className="py-2.5 px-2 text-center min-w-[64px]">
                        <button
                          type="button"
                          onClick={() => onSelectDate(date)}
                          className={`px-2 py-1 rounded-lg transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-orange-600 text-white'
                              : 'hover:bg-stone-200/70 text-stone-700'
                          }`}
                        >
                          <div className="text-[10px] uppercase leading-none opacity-80">
                            {date === todayStr ? 'Hoy' : weekday}
                          </div>
                          <div className="font-mono tabular-nums text-xs font-bold mt-0.5">
                            {dayNum}
                          </div>
                        </button>
                      </th>
                    );
                  })}
                  <th className="py-3 px-4 text-right whitespace-nowrap">Cumplimiento</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 text-xs">
                {weeklyHistory.rows.map((stRow) => (
                  <tr key={stRow.station.id} className="hover:bg-stone-50/70">
                    <td className="py-3 px-4 sm:px-5">
                      <p className="font-semibold text-stone-900 truncate max-w-[180px]">
                        {stRow.station.name}
                      </p>
                      <p className="text-[11px] text-stone-500 truncate max-w-[180px]">
                        {stRow.station.workerName}
                      </p>
                    </td>
                    {stRow.days.map((cell) => {
                      const isSelected = cell.date === selectedDate;
                      const label =
                        cell.status === 'completed'
                          ? 'Listo'
                          : cell.status === 'opening_saved'
                            ? cell.isLate
                              ? 'Sin cierre'
                              : 'Apertura'
                            : cell.isLate
                              ? 'Faltó'
                              : 'Pend.';
                      const tone =
                        cell.status === 'completed'
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          : cell.isLate
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : cell.status === 'opening_saved'
                              ? 'bg-amber-50 text-amber-800 border-amber-200'
                              : 'bg-stone-100 text-stone-600 border-stone-200';
                      return (
                        <td key={cell.date} className="py-2.5 px-1.5 text-center">
                          <button
                            type="button"
                            onClick={() => onSelectDate(cell.date)}
                            title={
                              cell.anomalyCount > 0
                                ? `${cell.anomalyCount} anomalía(s) de consumo`
                                : formatDateHuman(cell.date)
                            }
                            className={`w-full px-2 py-1.5 rounded-lg border font-semibold transition-all cursor-pointer ${tone} ${
                              isSelected ? 'ring-2 ring-orange-500 ring-offset-1' : ''
                            }`}
                          >
                            <div className="leading-tight">{label}</div>
                            {cell.anomalyCount > 0 && (
                              <div className="text-[10px] text-red-700 font-mono leading-tight mt-0.5">
                                {cell.anomalyCount} anom.
                              </div>
                            )}
                          </button>
                        </td>
                      );
                    })}
                    <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                      <span
                        className={`font-bold ${
                          stRow.completedCount >= 6
                            ? 'text-emerald-700'
                            : stRow.lateCount > 0
                              ? 'text-red-700'
                              : 'text-stone-800'
                        }`}
                      >
                        {stRow.completedCount}/7
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Collapsible Bottom Configuration Section */}
      <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden no-print">
        <button
          type="button"
          onClick={() => setConfigOpen((prev) => !prev)}
          aria-expanded={configOpen}
          className="w-full min-h-[54px] px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-stone-50 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Settings className="w-4 h-4 text-stone-600 shrink-0" />
            <div className="min-w-0">
              <span className="font-display text-sm sm:text-base font-bold text-stone-900">
                Configuración del restaurante
              </span>
              <p className="text-xs text-stone-600 truncate">
                {scheduleSummaryLabel} · Catálogo, equipo y códigos QR
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-stone-600 shrink-0 transition-transform duration-200 ${
              configOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        <AnimatePresence initial={false}>
          {configOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden border-t border-stone-200"
            >
              <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-3 gap-3 bg-stone-50/70">
                <button
                  type="button"
                  onClick={onGoToCatalog}
                  className="min-h-[64px] bg-white border border-stone-200 rounded-xl p-3.5 text-left hover:border-orange-300 hover:bg-orange-50/40 transition-colors flex items-start gap-3 cursor-pointer"
                >
                  <Package className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-stone-900">Catálogo de insumos</p>
                    <p className="text-xs text-stone-600 mt-0.5">
                      Editar unidades, mínimos y stock objetivo
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={onGoToTeam}
                  className="min-h-[64px] bg-white border border-stone-200 rounded-xl p-3.5 text-left hover:border-orange-300 hover:bg-orange-50/40 transition-colors flex items-start gap-3 cursor-pointer"
                >
                  <Users className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-stone-900">Equipo y perfil</p>
                    <p className="text-xs text-stone-600 mt-0.5">
                      Accesos de trabajadoras y datos del jefe
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={onGoToWorkstations}
                  className="min-h-[64px] bg-white border border-stone-200 rounded-xl p-3.5 text-left hover:border-orange-300 hover:bg-orange-50/40 transition-colors flex items-start gap-3 cursor-pointer"
                >
                  <QrCode className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-stone-900">Puestos y códigos QR</p>
                    <p className="text-xs text-stone-600 mt-0.5">
                      Enlaces por puesto e impresión de QR
                    </p>
                  </div>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
