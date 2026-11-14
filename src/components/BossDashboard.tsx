import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
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

interface BossDashboardProps {
  workspaceName: string;
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
}

type ViewTab = 'compras' | 'completo';
type StockFilter = 'todos' | 'comprar' | 'medio' | 'suficiente';

export function BossDashboard({
  workspaceName,
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
}: BossDashboardProps) {
  const [viewTab, setViewTab] = useState<ViewTab>('compras');
  const [stationFilter, setStationFilter] = useState<'all' | StationId>('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('todos');
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedToast, setCopiedToast] = useState(false);

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

  return (
    <div className="space-y-7 print-full">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-slate-600">
            {workspaceName} · Resumen de compras · {formatDateHuman(selectedDate)}
            {selectedDate === yesterdayStr ? ' (Cierre de ayer)' : ''}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mt-1 [text-wrap:balance]">
            Panel del Jefe y Lista de Compras
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Revisa qué puestos cerraron al terminar la jornada y qué insumos debes comprar.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 no-print">
          <button
            type="button"
            onClick={handleCopyWhatsApp}
            className="min-h-[42px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-700 rounded-xl hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedToast ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedToast ? 'Lista copiada' : 'Copiar lista WhatsApp'}
          </button>
          <button
            type="button"
            onClick={onGoToWorkstations}
            className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <QrCode className="w-4 h-4 text-teal-700" />
            Puestos y QR
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            Imprimir
          </button>
        </div>
      </div>

      {/* Contextual Morning / Yesterday Switch Banner */}
      {showSwitchToYesterday && (
        <div className="bg-slate-900 text-white rounded-xl px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 no-print">
          <div className="flex items-start sm:items-center gap-3 text-sm">
            <CalendarClock className="w-5 h-5 text-teal-300 shrink-0 mt-0.5 sm:mt-0" />
            <span>
              Los puestos aún no envían su cierre de hoy. ¿Quieres ver el cierre de anoche (
              {formatDateHuman(yesterdayStr)}) para planear las compras?
            </span>
          </div>
          <button
            type="button"
            onClick={() => onSelectDate(yesterdayStr)}
            className="min-h-[40px] px-4 py-2 text-xs font-semibold text-slate-900 bg-white rounded-lg hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Ver cierre de anoche
          </button>
        </div>
      )}

      {autoSelectedYesterday && selectedDate === yesterdayStr && (
        <div className="bg-teal-50 border border-teal-200 rounded-xl px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-sm text-teal-900 no-print">
          <span>
            Mostrando el cierre de anoche ({formatDateHuman(yesterdayStr)}) listo para revisar tus compras de hoy.
          </span>
          <button
            type="button"
            onClick={() => onSelectDate(todayStr)}
            className="text-xs font-semibold text-teal-800 underline hover:text-teal-950 cursor-pointer"
          >
            Cambiar a hoy
          </button>
        </div>
      )}

      {/* KPI Summary Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl divide-y lg:divide-y-0 divide-x divide-slate-200">
        <div className="p-5">
          <p className="text-xs font-semibold text-slate-600">Puestos cerrados</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-slate-900 mt-1">
            {metrics.completedStations} / {stations.length}
          </p>
          <p className="text-xs text-slate-600 mt-1">
            {metrics.completedStations === stations.length && stations.length > 0
              ? 'Todos cerraron turno'
              : 'Esperando cierre final'}
          </p>
        </div>
        <div className="p-5">
          <p className="text-xs font-semibold text-slate-600">Para comprar</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-red-700 mt-1">
            {metrics.toBuy}
          </p>
          <p className="text-xs text-slate-600 mt-1">
            {metrics.outOfStock > 0
              ? `${metrics.outOfStock} agotados · bajo mínimo`
              : 'Bajo stock mínimo'}
          </p>
        </div>
        <div className="p-5">
          <p className="text-xs font-semibold text-slate-600">Pronto a acabarse</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-amber-700 mt-1">
            {metrics.lowSoon}
          </p>
          <p className="text-xs text-slate-600 mt-1">Vigilar para reponer</p>
        </div>
        <div className="p-5">
          <p className="text-xs font-semibold text-slate-600">Stock suficiente</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-emerald-700 mt-1">
            {metrics.sufficient}
          </p>
          <p className="text-xs text-slate-600 mt-1">Sin compra urgente</p>
        </div>
      </section>

      {/* Dynamic Stations Overview */}
      <section className="space-y-3 no-print">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-slate-900">
            ¿Cómo cerraron los puestos?
          </h2>
          <button
            type="button"
            onClick={onGoToWorkstations}
            className="text-xs sm:text-sm font-semibold text-teal-700 hover:text-teal-800 cursor-pointer"
          >
            + Administrar puestos
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {stations.map((station) => {
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
              <div
                key={station.id}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-display text-base font-bold text-slate-900 leading-snug">
                      {station.name}
                    </h3>
                    <span className="font-mono tabular-nums text-xs font-medium text-slate-500 shrink-0 pt-0.5">
                      {stationRows.length} ins.
                    </span>
                  </div>

                  <p className="text-xs text-slate-600 truncate">
                    Encargada: <span className="font-medium text-slate-800">{station.workerName}</span>
                  </p>

                  {report?.status === 'completed' ? (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 pt-1">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>Cerrado{closeTime ? ` · ${closeTime}` : ''}</span>
                    </div>
                  ) : report?.status === 'opening_saved' ? (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 pt-1">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>Avance guardado{draftTime ? ` · ${draftTime}` : ''}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 pt-1">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>Aún no envía cierre</span>
                    </div>
                  )}

                  {report?.notes && (
                    <p className="text-xs text-slate-600 bg-slate-50 rounded-lg px-2.5 py-1.5 line-clamp-2">
                      &ldquo;{report.notes}&rdquo;
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                  <span className="text-xs">
                    {lowCount > 0 ? (
                      <span className="text-red-700 font-semibold">
                        {lowCount} por comprar
                      </span>
                    ) : (
                      <span className="text-slate-600">Stock en orden</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenStation(station.id)}
                    className="min-h-[36px] inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 hover:text-teal-800 whitespace-nowrap cursor-pointer"
                  >
                    Ver planilla
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Main Consolidated Shopping & Stock List */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl self-start">
            <button
              type="button"
              onClick={() => setViewTab('compras')}
              className={`min-h-[38px] px-3.5 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewTab === 'compras'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Qué comprar y alertas ({metrics.toBuy + metrics.lowSoon})
            </button>
            <button
              type="button"
              onClick={() => setViewTab('completo')}
              className={`min-h-[38px] px-3.5 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewTab === 'completo'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Todo el inventario ({consolidatedRows.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 sm:flex-initial">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Buscar insumo..."
                className="w-full sm:w-48 min-h-[40px] pl-9 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600 focus:bg-white"
              />
            </div>

            <select
              aria-label="Filtrar por puesto"
              value={stationFilter}
              onChange={(e) => setStationFilter(e.target.value as 'all' | StationId)}
              className="min-h-[40px] px-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600 max-w-[200px]"
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
              className="min-h-[40px] px-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600"
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
            <ShoppingBag className="w-8 h-8 text-slate-400 mx-auto" />
            <h3 className="font-display text-lg font-semibold text-slate-900">
              Aún no hay insumos registrados
            </h3>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              Agrega insumos a tus puestos de trabajo en el catálogo para ver aquí el cierre diario y la lista de compras.
            </p>
            <button
              type="button"
              onClick={onGoToCatalog}
              className="mt-2 min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Ir al catálogo de insumos
            </button>
          </div>
        ) : sortedShoppingRows.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-base font-semibold text-slate-800">
              {viewTab === 'compras'
                ? 'Todo al día: no hay insumos urgentes para comprar.'
                : 'No hay insumos que coincidan con tu búsqueda.'}
            </p>
            <p className="text-sm text-slate-600">
              Cambia a &ldquo;Todo el inventario&rdquo; o ajusta los filtros para revisar todos los productos.
            </p>
          </div>
        ) : (
          <>
            {/* Mobile Clean Card List (< md) */}
            <div className="md:hidden divide-y divide-slate-200">
              {sortedShoppingRows.map((row) => {
                const meta = getStockLevelMeta(row.stockLevel);
                const stName = stationMap[row.item.station]?.name ?? row.item.station;
                return (
                  <div key={row.item.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-semibold text-slate-900">{row.item.name}</p>
                        <p className="text-xs text-slate-600 truncate">{stName}</p>
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
                      <span className="text-slate-700">
                        Quedan:{' '}
                        <strong className="text-slate-900">
                          {row.hasCountedClosing
                            ? `${row.currentStock} ${row.item.unit}`
                            : row.entry?.hasOpening
                              ? `${row.currentStock}* ${row.item.unit}`
                              : 'Sin conteo'}
                        </strong>
                        <span className="text-slate-500 text-xs"> (Mín {row.item.minStock})</span>
                      </span>

                      {row.suggestedBuy > 0 && (
                        <span className="font-bold text-red-700">
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
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
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
                <tbody className="divide-y divide-slate-100 text-sm">
                  {sortedShoppingRows.map((row) => {
                    const meta = getStockLevelMeta(row.stockLevel);
                    const stName = stationMap[row.item.station]?.name ?? row.item.station;
                    return (
                      <tr key={row.item.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3.5 px-5">
                          <div className="font-semibold text-slate-900">{row.item.name}</div>
                          <div className="text-xs text-slate-500">{row.item.unit}</div>
                        </td>
                        <td className="py-3.5 px-4 text-slate-600 whitespace-nowrap max-w-[200px] truncate">
                          {stName}
                        </td>
                        {viewTab === 'completo' && (
                          <>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700">
                              {row.entry?.hasOpening ? row.entry.opening : '—'}
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-500">
                              {row.entry && row.entry.added > 0 ? `+${row.entry.added}` : '0'}
                            </td>
                          </>
                        )}
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {row.hasCountedClosing ? (
                            row.currentStock
                          ) : row.entry?.hasOpening ? (
                            <span
                              className="text-slate-500 font-normal"
                              title="Cierre aún pendiente"
                            >
                              {row.currentStock}*
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">Sin conteo</span>
                          )}
                        </td>
                        {viewTab === 'completo' && (
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700">
                            {row.consumed !== null ? row.consumed : '—'}
                          </td>
                        )}
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-600">
                          {row.item.minStock}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold">
                          {row.suggestedBuy > 0 ? (
                            <span className="text-red-700">
                              +{row.suggestedBuy} {row.item.unit}
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">—</span>
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
          <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 text-xs text-slate-600">
            Nota: Los valores marcados con &ldquo;Sin conteo&rdquo; o * corresponden a puestos que aún no envían su cierre del día seleccionado.
          </div>
        )}
      </section>
    </div>
  );
}
