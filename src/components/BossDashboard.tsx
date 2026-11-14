import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  MessageSquareText,
  Printer,
  QrCode,
  Search,
  ShoppingBag,
} from 'lucide-react';
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
  buildWhatsAppShoppingList,
  downloadDailyCsvReport,
  formatDateHuman,
  formatTimeShort,
  getStockLevelMeta,
} from '../utils/inventory';
import { formatTime12h, normalizeShiftSchedule } from '../utils/schedule';

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
  onSelectDate: (dateStr: string) => void;
  onOpenStation: (stationId: StationId) => void;
  onGoToWorkstations: () => void;
  onGoToCatalog: () => void;
  onOpenScheduleModal: () => void;
}

type ViewTab = 'compras' | 'completo';
type StockFilter = 'todos' | 'comprar' | 'medio' | 'suficiente';

function getTimeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
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
  onSelectDate,
  onOpenStation,
  onGoToWorkstations,
  onGoToCatalog,
  onOpenScheduleModal,
}: BossDashboardProps) {
  const [viewTab, setViewTab] = useState<ViewTab>('compras');
  const [stationFilter, setStationFilter] = useState<'all' | StationId>('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('todos');
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedToast, setCopiedToast] = useState(false);

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
    const anyReportedStations = stations.filter((s) => Boolean(reportsByStation[s.id])).length;
    const toBuy = consolidatedRows.filter(
      (r) => r.stockLevel === 'agotado' || r.stockLevel === 'comprar',
    ).length;
    const lowSoon = consolidatedRows.filter((r) => r.stockLevel === 'medio').length;
    const outOfStock = consolidatedRows.filter((r) => r.stockLevel === 'agotado').length;
    const sufficient = consolidatedRows.filter((r) => r.stockLevel === 'suficiente').length;

    return {
      completedStations,
      anyReportedStations,
      toBuy,
      lowSoon,
      outOfStock,
      sufficient,
    };
  }, [consolidatedRows, reportsByStation, stations]);

  const stationNotes = useMemo(() => {
    return stations
      .map((st) => {
        const rep = reportsByStation[st.id];
        if (!rep?.notes?.trim()) return null;
        return { stationName: st.name, workerName: st.workerName, notes: rep.notes.trim() };
      })
      .filter((n): n is { stationName: string; workerName: string; notes: string } => Boolean(n));
  }, [stations, reportsByStation]);

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
    };
    return [...filteredRows].sort((a, b) => {
      if (priority[a.stockLevel] !== priority[b.stockLevel]) {
        return priority[a.stockLevel] - priority[b.stockLevel];
      }
      return a.item.station.localeCompare(b.item.station) || a.item.sortOrder - b.item.sortOrder;
    });
  }, [filteredRows]);

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
            className="min-h-[42px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedToast ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedToast ? 'Lista copiada' : 'Copiar lista WhatsApp'}
          </button>
          <button
            type="button"
            onClick={onOpenScheduleModal}
            className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-stone-800 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Clock className="w-4 h-4 text-orange-600" />
            Horarios
          </button>
          <button
            type="button"
            onClick={onGoToWorkstations}
            className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-stone-800 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <QrCode className="w-4 h-4 text-orange-600" />
            Puestos y QR
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            aria-label="Exportar CSV"
            className="min-h-[42px] inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>CSV</span>
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            aria-label="Imprimir reporte"
            className="min-h-[42px] inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            <span className="hidden sm:inline">Imprimir</span>
          </button>
        </div>
      </div>

      {/* Compact Worker Schedule Bar */}
      <div className="bg-white border border-stone-200 rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm no-print">
        <div className="flex items-center gap-2 text-stone-700 min-w-0">
          <Clock className="w-4 h-4 text-orange-600 shrink-0" />
          <span className="font-medium truncate">
            Horario trabajadoras: <strong className="text-stone-900">{scheduleSummaryLabel}</strong>
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenScheduleModal}
          className="text-xs font-semibold text-orange-600 hover:text-orange-700 whitespace-nowrap shrink-0 cursor-pointer"
        >
          Configurar horarios
        </button>
      </div>

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

      {/* Pixel-Perfect KPI Summary Strip using gap-px */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-stone-200 border border-stone-200 rounded-2xl overflow-hidden"
      >
        <div className="bg-white p-4 sm:p-5">
          <p className="text-xs font-semibold text-stone-500">Puestos cerrados</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-stone-900 mt-1">
            {metrics.completedStations} / {stations.length}
          </p>
          <p className="text-xs text-stone-500 mt-1">
            {metrics.completedStations === stations.length && stations.length > 0
              ? 'Todos cerraron turno'
              : 'Esperando cierre final'}
          </p>
        </div>
        <div className="bg-white p-4 sm:p-5">
          <p className="text-xs font-semibold text-stone-500">Para comprar</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-red-700 mt-1">
            {metrics.toBuy}
          </p>
          <p className="text-xs text-stone-500 mt-1">
            {metrics.outOfStock > 0
              ? `${metrics.outOfStock} agotados · bajo mínimo`
              : 'Bajo stock mínimo'}
          </p>
        </div>
        <div className="bg-white p-4 sm:p-5">
          <p className="text-xs font-semibold text-stone-500">Pronto a acabarse</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-amber-700 mt-1">
            {metrics.lowSoon}
          </p>
          <p className="text-xs text-stone-500 mt-1">Vigilar para reponer</p>
        </div>
        <div className="bg-white p-4 sm:p-5">
          <p className="text-xs font-semibold text-stone-500">Stock suficiente</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-emerald-700 mt-1">
            {metrics.sufficient}
          </p>
          <p className="text-xs text-stone-500 mt-1">Sin compra urgente</p>
        </div>
      </motion.section>

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
                  <span className="font-normal text-stone-500">· {item.workerName}</span>
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
            className="text-xs sm:text-sm font-semibold text-orange-600 hover:text-orange-700 whitespace-nowrap cursor-pointer"
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
                  ) : report?.status === 'opening_saved' ? (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 pt-1">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>Apertura guardada{draftTime ? ` · ${draftTime}` : ''}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs font-medium text-stone-500 pt-1">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>Pendiente por reportar</span>
                    </div>
                  )}

                  {report?.notes && (
                    <p className="text-xs text-stone-600 bg-stone-50 rounded-xl px-2.5 py-1.5 line-clamp-2 border border-stone-100">
                      &ldquo;{report.notes}&rdquo;
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-stone-100 flex items-center justify-between gap-2">
                  <span className="text-xs">
                    {lowCount > 0 ? (
                      <span className="text-red-700 font-semibold">
                        {lowCount} por comprar
                      </span>
                    ) : (
                      <span className="text-stone-600">Stock en orden</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenStation(station.id)}
                    className="min-h-[36px] inline-flex items-center gap-1 text-xs font-semibold text-orange-600 hover:text-orange-700 whitespace-nowrap cursor-pointer"
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
              className={`min-h-[38px] px-3.5 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
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
              className={`min-h-[38px] px-3.5 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
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
                className="w-full sm:w-44 min-h-[40px] pl-9 pr-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white"
              />
            </div>

            <select
              aria-label="Filtrar por puesto"
              value={stationFilter}
              onChange={(e) => setStationFilter(e.target.value as 'all' | StationId)}
              className="flex-1 sm:flex-initial min-h-[40px] px-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 max-w-full sm:max-w-[190px]"
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
              className="flex-1 sm:flex-initial min-h-[40px] px-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="todos">Todos los estados</option>
              <option value="comprar">Solo para comprar</option>
              <option value="medio">Pronto a acabarse</option>
              <option value="suficiente">Stock suficiente</option>
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
        ) : (
          <>
            {/* Mobile Clean Card List (< md) */}
            <div className="md:hidden divide-y divide-stone-200">
              {sortedShoppingRows.map((row) => {
                const meta = getStockLevelMeta(row.stockLevel);
                const stName = stationMap[row.item.station]?.name ?? row.item.station;
                return (
                  <div key={row.item.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-semibold text-stone-900 truncate">
                          {row.item.name}
                        </p>
                        <p className="text-xs text-stone-500 truncate">{stName}</p>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-semibold shrink-0 pt-0.5 ${meta.textClass}`}
                      >
                        {(row.stockLevel === 'agotado' || row.stockLevel === 'comprar') && (
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        )}
                        {meta.label}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-4 pt-1 text-sm font-mono tabular-nums">
                      <span className="text-stone-700">
                        Quedan:{' '}
                        <strong className="text-stone-900">
                          {row.hasCountedClosing
                            ? `${row.currentStock} ${row.item.unit}`
                            : row.entry?.hasOpening
                              ? `${row.currentStock}* ${row.item.unit}`
                              : 'Sin conteo'}
                        </strong>
                        <span className="text-stone-500 text-xs"> (Mín {row.item.minStock})</span>
                      </span>

                      {row.suggestedBuy > 0 && (
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
                    {viewTab === 'completo' && (
                      <>
                        <th className="py-3.5 px-4 text-right">Base / Inicio</th>
                        <th className="py-3.5 px-4 text-right">Surtido</th>
                      </>
                    )}
                    <th className="py-3.5 px-4 text-right">Quedan al cierre</th>
                    {viewTab === 'completo' && <th className="py-3.5 px-4 text-right">Consumo</th>}
                    <th className="py-3.5 px-4 text-right">Mínimo</th>
                    <th className="py-3.5 px-4 text-right">Pedir</th>
                    <th className="py-3.5 px-5">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-sm">
                  {sortedShoppingRows.map((row) => {
                    const meta = getStockLevelMeta(row.stockLevel);
                    const stName = stationMap[row.item.station]?.name ?? row.item.station;
                    return (
                      <tr key={row.item.id} className="hover:bg-stone-50/80 transition-colors">
                        <td className="py-3.5 px-5">
                          <div className="font-semibold text-stone-900">{row.item.name}</div>
                          <div className="text-xs text-stone-500">{row.item.unit}</div>
                        </td>
                        <td className="py-3.5 px-4 text-stone-600 whitespace-nowrap max-w-[200px] truncate">
                          {stName}
                        </td>
                        {viewTab === 'completo' && (
                          <>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-700">
                              {row.entry?.hasOpening ? row.entry.opening : '—'}
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-500">
                              {row.entry && row.entry.added > 0 ? `+${row.entry.added}` : '0'}
                            </td>
                          </>
                        )}
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-stone-900">
                          {row.hasCountedClosing ? (
                            row.currentStock
                          ) : row.entry?.hasOpening ? (
                            <span
                              className="text-stone-500 font-normal"
                              title="Cierre aún pendiente"
                            >
                              {row.currentStock}*
                            </span>
                          ) : (
                            <span className="text-stone-400 font-normal">Sin conteo</span>
                          )}
                        </td>
                        {viewTab === 'completo' && (
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-700">
                            {row.consumed !== null ? row.consumed : '—'}
                          </td>
                        )}
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-600">
                          {row.item.minStock}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold">
                          {row.suggestedBuy > 0 ? (
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
                            {meta.label}
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
            Nota: Los valores marcados con &ldquo;Sin conteo&rdquo; o * corresponden a puestos que aún no envían su cierre del día seleccionado.
          </div>
        )}
      </section>
    </div>
  );
}
