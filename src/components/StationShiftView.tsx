import { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  History,
  Lock,
  Minus,
  Plus,
  RotateCcw,
  Save,
  Search,
} from 'lucide-react';
import { MAX_NOTES_LENGTH, MAX_STOCK_VALUE } from '../constants';
import {
  fetchStationEntriesOnce,
  reopenStationReport,
  saveStationReportBatch,
} from '../services/inventoryService';
import type {
  DailyReport,
  DailyReportEntry,
  DraftEntryRow,
  InventoryItem,
  Workspace,
  Workstation,
} from '../types';
import {
  formatDateHuman,
  formatTimeShort,
  getPreviousDateStr,
  getStockLevel,
  getStockLevelMeta,
  getSuggestedPurchase,
} from '../utils/inventory';

interface StationShiftViewProps {
  workspace: Workspace;
  user: User;
  canManage: boolean;
  station: Workstation;
  selectedDate: string;
  items: InventoryItem[];
  report: DailyReport | undefined;
  entriesByItemId: Record<string, DailyReportEntry>;
  onSaved?: () => void;
}

type ItemFilter = 'todos' | 'pendientes' | 'bajos';

export function StationShiftView({
  workspace,
  user,
  canManage,
  station,
  selectedDate,
  items,
  report,
  entriesByItemId,
  onSaved,
}: StationShiftViewProps) {
  const stationItems = useMemo(
    () => items.filter((it) => it.active && it.station === station.id),
    [items, station.id],
  );

  const [drafts, setDrafts] = useState<Record<string, DraftEntryRow>>({});
  const [notes, setNotes] = useState('');
  const [savingMode, setSavingMode] = useState<'opening' | 'closing' | null>(null);
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [autoLoadedPrevDate, setAutoLoadedPrevDate] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [showOpeningDetails, setShowOpeningDetails] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [itemFilter, setItemFilter] = useState<ItemFilter>('todos');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const autoPreloadKeyRef = useRef<string>('');

  const isCompleted = report?.status === 'completed';
  const isLocked = isCompleted && !canManage;

  useEffect(() => {
    const nextDrafts: Record<string, DraftEntryRow> = {};
    stationItems.forEach((item) => {
      const existing = entriesByItemId[item.id];
      nextDrafts[item.id] = {
        itemId: item.id,
        itemName: item.name,
        unit: item.unit,
        minStock: item.minStock,
        targetStock: item.targetStock,
        opening: existing ? existing.opening : 0,
        added: existing ? existing.added : 0,
        closing: existing ? existing.closing : 0,
        hasOpening: existing ? existing.hasOpening : false,
        hasClosing: existing ? existing.hasClosing : false,
      };
    });
    setDrafts(nextDrafts);
    setNotes(report?.notes ?? '');
    setFeedback(null);
    setAutoLoadedPrevDate(null);
  }, [stationItems, entriesByItemId, report?.id, report?.notes, selectedDate, station.id]);

  // Auto-preload yesterday's closing as today's opening if today has no report yet
  useEffect(() => {
    if (report || stationItems.length === 0) return;
    const key = `${workspace.id}_${selectedDate}_${station.id}_${stationItems.length}`;
    if (autoPreloadKeyRef.current === key) return;
    autoPreloadKeyRef.current = key;

    let cancelled = false;
    const prevDate = getPreviousDateStr(selectedDate);
    fetchStationEntriesOnce(
      workspace.id,
      prevDate,
      station.id,
      stationItems.map((i) => i.id),
    )
      .then((prevEntries) => {
        if (cancelled) return;
        if (Object.keys(prevEntries).length === 0) return;
        setDrafts((prev) => {
          const updated = { ...prev };
          Object.keys(updated).forEach((itemId) => {
            const prevEntry = prevEntries[itemId];
            if (prevEntry && !updated[itemId].hasOpening) {
              updated[itemId] = {
                ...updated[itemId],
                opening: prevEntry.hasClosing ? prevEntry.closing : prevEntry.opening,
                hasOpening: true,
              };
            }
          });
          return updated;
        });
        setAutoLoadedPrevDate(prevDate);
      })
      .catch(() => {
        // Silent auto-preload fallback
      });

    return () => {
      cancelled = true;
    };
  }, [report, workspace.id, selectedDate, station.id, stationItems]);

  const updateField = (
    itemId: string,
    field: 'opening' | 'added' | 'closing',
    rawValue: number,
  ) => {
    const clamped = Number.isFinite(rawValue)
      ? Math.max(0, Math.min(MAX_STOCK_VALUE, Math.round(rawValue * 100) / 100))
      : 0;
    setDrafts((prev) => {
      const current = prev[itemId];
      if (!current) return prev;
      return {
        ...prev,
        [itemId]: {
          ...current,
          [field]: clamped,
          hasOpening: field === 'opening' ? true : current.hasOpening,
          hasClosing: field === 'closing' ? true : current.hasClosing,
        },
      };
    });
  };

  const stepField = (itemId: string, field: 'opening' | 'added' | 'closing', delta: number) => {
    const currentVal = drafts[itemId]?.[field] ?? 0;
    updateField(itemId, field, currentVal + delta);
  };

  const handleLoadYesterdayClosing = async () => {
    if (stationItems.length === 0) return;
    setLoadingPrev(true);
    setFeedback(null);
    try {
      const prevDate = getPreviousDateStr(selectedDate);
      const prevEntries = await fetchStationEntriesOnce(
        workspace.id,
        prevDate,
        station.id,
        stationItems.map((i) => i.id),
      );
      const countFound = Object.keys(prevEntries).length;
      if (countFound === 0) {
        setFeedback({
          type: 'error',
          text: `No se encontró un cierre guardado para ${formatDateHuman(prevDate)}.`,
        });
        return;
      }

      setDrafts((prev) => {
        const updated = { ...prev };
        Object.keys(updated).forEach((itemId) => {
          const prevEntry = prevEntries[itemId];
          if (prevEntry) {
            updated[itemId] = {
              ...updated[itemId],
              opening: prevEntry.hasClosing ? prevEntry.closing : prevEntry.opening,
              hasOpening: true,
            };
          }
        });
        return updated;
      });
      setAutoLoadedPrevDate(prevDate);
      setFeedback({
        type: 'success',
        text: `Se cargó el cierre del ${formatDateHuman(prevDate)} como base inicial.`,
      });
    } catch {
      setFeedback({
        type: 'error',
        text: 'No se pudo consultar el reporte del día anterior.',
      });
    } finally {
      setLoadingPrev(false);
    }
  };

  const handleSave = async (mode: 'opening' | 'closing') => {
    if (stationItems.length === 0) return;
    setSavingMode(mode);
    setFeedback(null);
    try {
      const rows = stationItems.map((it) => drafts[it.id]).filter(Boolean);
      await saveStationReportBatch({
        workspace,
        user,
        date: selectedDate,
        station: station.id,
        mode,
        notes,
        rows,
        existingReport: report,
        existingEntries: entriesByItemId,
      });
      setFeedback({
        type: 'success',
        text:
          mode === 'opening'
            ? 'Avance guardado. Puedes seguir contando cuando quieras.'
            : '¡Excelente! Tu cierre fue enviado y el jefe ya puede verlo.',
      });
      onSaved?.();
    } catch {
      setFeedback({
        type: 'error',
        text: 'Ocurrió un error al guardar el inventario. Verifica tu conexión.',
      });
    } finally {
      setSavingMode(null);
    }
  };

  const handleReopen = async () => {
    if (!report) return;
    setReopening(true);
    setFeedback(null);
    try {
      await reopenStationReport(report.id, user);
      setFeedback({
        type: 'success',
        text: 'Planilla reabierta para ajustes.',
      });
      onSaved?.();
    } catch {
      setFeedback({
        type: 'error',
        text: 'No se pudo reabrir la planilla.',
      });
    } finally {
      setReopening(false);
    }
  };

  const countedCount = stationItems.filter((it) => {
    const row = drafts[it.id];
    return Boolean(row?.hasClosing || isCompleted);
  }).length;

  const lowCount = stationItems.filter((it) => {
    const row = drafts[it.id];
    if (!row) return false;
    const lvl = getStockLevel(row.closing, it.minStock);
    return (row.hasClosing || isCompleted) && (lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio');
  }).length;

  const progressPct =
    stationItems.length > 0 ? Math.round((countedCount / stationItems.length) * 100) : 0;

  const filteredItems = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return stationItems.filter((item) => {
      if (q && !item.name.toLowerCase().includes(q)) return false;
      const row = drafts[item.id];
      if (itemFilter === 'pendientes') {
        return !row?.hasClosing && !isCompleted;
      }
      if (itemFilter === 'bajos') {
        const lvl = getStockLevel(row?.closing ?? 0, item.minStock);
        return lvl === 'agotado' || lvl === 'comprar' || lvl === 'medio';
      }
      return true;
    });
  }, [stationItems, searchTerm, itemFilter, drafts, isCompleted]);

  const closingTime = report?.status === 'completed' ? formatTimeShort(report?.updatedAt) : null;
  const draftTime = report?.status === 'opening_saved' ? formatTimeShort(report?.updatedAt) : null;

  return (
    <div className="space-y-5 pb-8 min-w-0">
      {/* Friendly Personalized Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-orange-600">
            ¡Hola, {station.workerName}! · {station.area || 'Tu puesto'} ·{' '}
            {formatDateHuman(selectedDate)}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-stone-900 mt-1 [text-wrap:balance]">
            {station.name}
          </h1>
          <p className="text-sm text-stone-600 mt-1">
            Toca + o − en cada insumo para anotar cuánto quedó al terminar el turno.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowOpeningDetails((v) => !v)}
            className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium text-stone-700 bg-white border border-stone-200 rounded-xl hover:bg-stone-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {showOpeningDetails ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
            {showOpeningDetails ? 'Ocultar inicio y surtido' : 'Ajustar inicio / surtido'}
          </button>

          {isCompleted && canManage && (
            <button
              type="button"
              onClick={handleReopen}
              disabled={reopening}
              className="min-h-[42px] inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-xl hover:bg-amber-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              {reopening ? 'Reabriendo...' : 'Reabrir cierre'}
            </button>
          )}
        </div>
      </div>

      {/* Progress & Status Card */}
      <div
        className={`rounded-2xl border p-4 sm:p-5 space-y-3 transition-colors ${
          isCompleted
            ? 'bg-emerald-50/70 border-emerald-200'
            : 'bg-white border-stone-200'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 text-sm min-w-0">
            {report?.status === 'completed' ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                <span className="font-semibold text-emerald-900">
                  ¡Cierre enviado al jefe!{closingTime ? ` (${closingTime})` : ''}
                </span>
              </>
            ) : report?.status === 'opening_saved' ? (
              <>
                <Save className="w-5 h-5 text-amber-600 shrink-0" />
                <span className="font-semibold text-amber-900">
                  Avance guardado{draftTime ? ` (${draftTime})` : ''} · Falta enviar cierre
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5 text-orange-600 shrink-0" />
                <span className="font-semibold text-stone-900">
                  Tu conteo de cierre de hoy
                </span>
              </>
            )}
          </div>

          <div className="text-sm font-mono tabular-nums font-bold text-stone-800 shrink-0">
            {countedCount} / {stationItems.length} contados
          </div>
        </div>

        <div className="w-full h-2.5 bg-stone-200/80 rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className={`h-full rounded-full ${
              isCompleted ? 'bg-emerald-600' : 'bg-orange-600'
            }`}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-600">
          <span>
            {autoLoadedPrevDate
              ? `Base inicial lista con el cierre de ${formatDateHuman(autoLoadedPrevDate)}.`
              : 'Cuando termines de contar, toca el botón verde/naranja de abajo para enviárselo al jefe.'}
          </span>
          {!isLocked && stationItems.length > 0 && (
            <button
              type="button"
              onClick={handleLoadYesterdayClosing}
              disabled={loadingPrev}
              className="inline-flex items-center gap-1.5 font-semibold text-orange-600 hover:text-orange-700 cursor-pointer"
            >
              <History className="w-3.5 h-3.5" />
              {loadingPrev ? 'Consultando...' : 'Cargar cierre de ayer'}
            </button>
          )}
        </div>
      </div>

      {isLocked && (
        <div className="flex items-center gap-3 px-4 py-3.5 text-sm text-stone-800 bg-stone-100 border border-stone-200 rounded-2xl">
          <Lock className="w-4 h-4 text-stone-600 shrink-0" />
          <span>
            Este cierre ya fue enviado al jefe. Si necesitas cambiar un dato, pídele que reabra el reporte.
          </span>
        </div>
      )}

      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            role="status"
            className={`px-4 py-3.5 text-sm font-medium rounded-2xl border ${
              feedback.type === 'success'
                ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                : 'bg-red-50 text-red-900 border-red-200'
            }`}
          >
            {feedback.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quick Search & Filter Toolbar */}
      {stationItems.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-stone-200/70 rounded-xl w-full sm:w-auto overflow-x-auto">
            <button
              type="button"
              onClick={() => setItemFilter('todos')}
              className={`min-h-[38px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'todos'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              Todos ({stationItems.length})
            </button>
            <button
              type="button"
              onClick={() => setItemFilter('pendientes')}
              className={`min-h-[38px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'pendientes'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              Faltan ({Math.max(0, stationItems.length - countedCount)})
            </button>
            <button
              type="button"
              onClick={() => setItemFilter('bajos')}
              className={`min-h-[38px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                itemFilter === 'bajos'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-700 hover:text-stone-900'
              }`}
            >
              Bajos ({lowCount})
            </button>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar insumo..."
              className="w-full min-h-[44px] pl-10 pr-3 py-2 text-sm bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>
      )}

      {/* Main Inventory List */}
      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        {stationItems.length === 0 ? (
          <div className="p-10 text-center text-sm text-stone-600">
            No hay insumos activos en este puesto. El jefe puede agregarlos desde &ldquo;Catálogo de Insumos&rdquo;.
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-semibold text-stone-800">
              No hay insumos que coincidan con este filtro.
            </p>
            <button
              type="button"
              onClick={() => {
                setSearchTerm('');
                setItemFilter('todos');
              }}
              className="text-sm font-semibold text-orange-600 hover:text-orange-700 cursor-pointer"
            >
              Ver todos los insumos
            </button>
          </div>
        ) : (
          <>
            {/* Mobile / Tablet Touch-First List */}
            <div className="lg:hidden divide-y divide-stone-200">
              {filteredItems.map((item) => {
                const row = drafts[item.id] ?? {
                  itemId: item.id,
                  itemName: item.name,
                  unit: item.unit,
                  minStock: item.minStock,
                  targetStock: item.targetStock,
                  opening: 0,
                  added: 0,
                  closing: 0,
                  hasOpening: false,
                  hasClosing: false,
                };
                const hasValue = row.hasClosing || isCompleted;
                const level = getStockLevel(row.closing, item.minStock);
                const meta = getStockLevelMeta(level);
                const suggestBuy = getSuggestedPurchase(
                  row.closing,
                  item.minStock,
                  item.targetStock,
                );

                const inputBorderClass = !hasValue
                  ? 'bg-stone-50 border-stone-300 text-stone-800'
                  : level === 'agotado' || level === 'comprar'
                    ? 'bg-red-50/40 border-red-400 text-stone-900'
                    : level === 'medio'
                      ? 'bg-amber-50/40 border-amber-400 text-stone-900'
                      : 'bg-emerald-50/40 border-emerald-500 text-stone-900';

                return (
                  <div
                    key={item.id}
                    className={`p-4 sm:p-5 space-y-3.5 transition-colors ${
                      hasValue ? 'bg-white' : 'bg-stone-50/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-base font-bold text-stone-900 leading-snug">
                          {item.name}
                        </h3>
                        <p className="text-xs text-stone-500 mt-0.5 font-mono tabular-nums">
                          {item.unit} · Mínimo: {item.minStock}
                          {row.hasOpening && !showOpeningDetails
                            ? ` · Base: ${row.opening + row.added}`
                            : ''}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        {!hasValue ? (
                          <span className="text-xs font-semibold text-stone-400">
                            Por contar
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-semibold ${meta.textClass}`}
                          >
                            {(level === 'agotado' || level === 'comprar') && (
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            )}
                            {suggestBuy > 0 ? `Pedir +${suggestBuy}` : meta.label}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Big Thumb-Friendly Closing Stepper */}
                    <div className="space-y-1.5">
                      <label
                        htmlFor={`mobile-close-${item.id}`}
                        className="block text-xs font-semibold text-stone-600"
                      >
                        ¿Cuánto quedó hoy al cerrar? ({item.unit})
                      </label>
                      <div className="flex items-center gap-2">
                        <motion.button
                          whileTap={{ scale: 0.93 }}
                          type="button"
                          disabled={isLocked}
                          onClick={() => stepField(item.id, 'closing', -1)}
                          aria-label={`Restar ${item.name}`}
                          className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                        >
                          <Minus className="w-5 h-5" />
                        </motion.button>
                        <input
                          id={`mobile-close-${item.id}`}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="any"
                          disabled={isLocked}
                          value={row.closing}
                          onChange={(e) =>
                            updateField(item.id, 'closing', parseFloat(e.target.value))
                          }
                          className={`min-w-0 flex-1 h-12 text-center font-mono tabular-nums text-xl font-bold rounded-xl border focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60 transition-colors ${inputBorderClass}`}
                        />
                        <motion.button
                          whileTap={{ scale: 0.93 }}
                          type="button"
                          disabled={isLocked}
                          onClick={() => stepField(item.id, 'closing', 1)}
                          aria-label={`Sumar ${item.name}`}
                          className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                        >
                          <Plus className="w-5 h-5" />
                        </motion.button>
                      </div>
                    </div>

                    {/* Optional Opening & Restock Adjusters */}
                    <AnimatePresence initial={false}>
                      {showOpeningDetails && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="pt-2.5 border-t border-stone-100 grid grid-cols-2 gap-3">
                            <div className="min-w-0">
                              <label className="block text-xs font-medium text-stone-600 mb-1">
                                Inicio del día
                              </label>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'opening', -1)}
                                  aria-label={`Restar inicio ${item.name}`}
                                  className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                >
                                  <Minus className="w-3.5 h-3.5" />
                                </button>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min={0}
                                  step="any"
                                  disabled={isLocked}
                                  value={row.opening}
                                  onChange={(e) =>
                                    updateField(item.id, 'opening', parseFloat(e.target.value))
                                  }
                                  className="min-w-0 w-full h-10 text-center font-mono tabular-nums text-sm font-semibold bg-stone-50 border border-stone-200 rounded-lg"
                                />
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'opening', 1)}
                                  aria-label={`Sumar inicio ${item.name}`}
                                  className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            <div className="min-w-0">
                              <label className="block text-xs font-medium text-stone-600 mb-1">
                                Surtido hoy (+)
                              </label>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'added', -1)}
                                  aria-label={`Restar surtido ${item.name}`}
                                  className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                >
                                  <Minus className="w-3.5 h-3.5" />
                                </button>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min={0}
                                  step="any"
                                  disabled={isLocked}
                                  value={row.added}
                                  onChange={(e) =>
                                    updateField(item.id, 'added', parseFloat(e.target.value))
                                  }
                                  className="min-w-0 w-full h-10 text-center font-mono tabular-nums text-sm font-semibold bg-stone-50 border border-stone-200 rounded-lg"
                                />
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'added', 1)}
                                  aria-label={`Sumar surtido ${item.name}`}
                                  className="w-9 h-10 shrink-0 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 disabled:opacity-40 cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>

            {/* Desktop Spacious Table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th className="py-3.5 px-5 min-w-[220px]">Insumo</th>
                    {showOpeningDetails && (
                      <>
                        <th className="py-3.5 px-3 text-center">Inicio</th>
                        <th className="py-3.5 px-3 text-center">Surtido (+)</th>
                      </>
                    )}
                    <th className="py-3.5 px-4 text-center">¿Cuánto quedó hoy? (Cierre)</th>
                    {showOpeningDetails && <th className="py-3.5 px-4 text-right">Consumo</th>}
                    <th className="py-3.5 px-5">Estado / Alerta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-sm">
                  {filteredItems.map((item) => {
                    const row = drafts[item.id] ?? {
                      itemId: item.id,
                      itemName: item.name,
                      unit: item.unit,
                      minStock: item.minStock,
                      targetStock: item.targetStock,
                      opening: 0,
                      added: 0,
                      closing: 0,
                      hasOpening: false,
                      hasClosing: false,
                    };
                    const hasValue = row.hasClosing || isCompleted;
                    const consumed = Math.max(0, row.opening + row.added - row.closing);
                    const level = getStockLevel(row.closing, item.minStock);
                    const meta = getStockLevelMeta(level);
                    const suggestBuy = getSuggestedPurchase(
                      row.closing,
                      item.minStock,
                      item.targetStock,
                    );

                    return (
                      <tr key={item.id} className="hover:bg-stone-50/70 transition-colors">
                        <td className="py-4 px-5">
                          <div className="text-base font-semibold text-stone-900">
                            {item.name}
                          </div>
                          <div className="text-xs text-stone-500 font-mono tabular-nums mt-0.5">
                            {item.unit} · Mínimo: {item.minStock}
                            {!showOpeningDetails && row.hasOpening
                              ? ` · Base día: ${row.opening + row.added}`
                              : ''}
                          </div>
                        </td>

                        {showOpeningDetails && (
                          <>
                            <td className="py-4 px-3">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'opening', -1)}
                                  aria-label={`Restar inicio de ${item.name}`}
                                  className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                                >
                                  <Minus className="w-3.5 h-3.5" />
                                </button>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  disabled={isLocked}
                                  aria-label={`Inicio de ${item.name}`}
                                  value={row.opening}
                                  onChange={(e) =>
                                    updateField(item.id, 'opening', parseFloat(e.target.value))
                                  }
                                  className="w-16 h-10 text-center font-mono tabular-nums text-sm font-medium bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white disabled:opacity-60"
                                />
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'opening', 1)}
                                  aria-label={`Sumar inicio de ${item.name}`}
                                  className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>

                            <td className="py-4 px-3">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'added', -1)}
                                  aria-label={`Restar surtido de ${item.name}`}
                                  className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                                >
                                  <Minus className="w-3.5 h-3.5" />
                                </button>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  disabled={isLocked}
                                  aria-label={`Surtido de ${item.name}`}
                                  value={row.added}
                                  onChange={(e) =>
                                    updateField(item.id, 'added', parseFloat(e.target.value))
                                  }
                                  className="w-16 h-10 text-center font-mono tabular-nums text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white disabled:opacity-60"
                                />
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => stepField(item.id, 'added', 1)}
                                  aria-label={`Sumar surtido de ${item.name}`}
                                  className="w-9 h-10 flex items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </>
                        )}

                        <td className="py-4 px-4">
                          <div className="flex items-center justify-center gap-1.5">
                            <motion.button
                              whileTap={{ scale: 0.93 }}
                              type="button"
                              disabled={isLocked}
                              onClick={() => stepField(item.id, 'closing', -1)}
                              aria-label={`Restar cierre de ${item.name}`}
                              className="w-11 h-11 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Minus className="w-4 h-4" />
                            </motion.button>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              disabled={isLocked}
                              aria-label={`Cierre de ${item.name}`}
                              value={row.closing}
                              onChange={(e) =>
                                updateField(item.id, 'closing', parseFloat(e.target.value))
                              }
                              className={`w-20 h-11 text-center font-mono tabular-nums text-base font-bold rounded-xl border focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60 transition-colors ${
                                hasValue
                                  ? 'bg-white border-orange-500 text-stone-900'
                                  : 'bg-stone-50 border-stone-300 text-stone-800'
                              }`}
                            />
                            <motion.button
                              whileTap={{ scale: 0.93 }}
                              type="button"
                              disabled={isLocked}
                              onClick={() => stepField(item.id, 'closing', 1)}
                              aria-label={`Sumar cierre de ${item.name}`}
                              className="w-11 h-11 flex items-center justify-center rounded-xl border border-stone-300 bg-stone-50 text-stone-800 hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
                            >
                              <Plus className="w-4 h-4" />
                            </motion.button>
                          </div>
                        </td>

                        {showOpeningDetails && (
                          <td className="py-4 px-4 text-right font-mono tabular-nums text-stone-700">
                            {consumed} {item.unit}
                          </td>
                        )}

                        <td className="py-4 px-5 whitespace-nowrap">
                          {!hasValue ? (
                            <span className="text-xs font-medium text-stone-400">
                              Por contar
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <span
                                className={`inline-flex items-center gap-1.5 text-sm font-semibold ${meta.textClass}`}
                              >
                                {(level === 'agotado' || level === 'comprar') && (
                                  <AlertTriangle className="w-4 h-4 shrink-0" />
                                )}
                                {meta.label}
                              </span>
                              {suggestBuy > 0 && (
                                <p className="text-xs font-mono tabular-nums text-red-700">
                                  Sugerido pedir: +{suggestBuy} {item.unit}
                                </p>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Notes & Primary Save Footer */}
      {stationItems.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 space-y-4">
          <div>
            <label
              htmlFor={`notes-${station.id}`}
              className="block text-sm font-semibold text-stone-800 mb-1.5"
            >
              Notas del cierre para el jefe (opcional)
            </label>
            <textarea
              id={`notes-${station.id}`}
              rows={2}
              maxLength={MAX_NOTES_LENGTH}
              disabled={isLocked}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ej: Llegó pedido de gaseosas hoy, o falta comprar hielo urgente..."
              className="w-full px-3.5 py-2.5 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 focus:bg-white disabled:opacity-60"
            />
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-end gap-3">
            <button
              type="button"
              disabled={isLocked || savingMode !== null}
              onClick={() => handleSave('opening')}
              className="min-h-[48px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-xl hover:bg-stone-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {savingMode === 'opening' ? 'Guardando avance...' : 'Guardar avance'}
            </button>

            <button
              type="button"
              disabled={isLocked || savingMode !== null}
              onClick={() => handleSave('closing')}
              className="min-h-[48px] inline-flex items-center justify-center gap-2 px-6 py-3 text-sm sm:text-base font-semibold text-white bg-orange-600 rounded-xl hover:bg-orange-700 active:scale-[0.99] disabled:opacity-50 transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              <CheckCircle2 className="w-5 h-5" />
              {savingMode === 'closing' ? 'Enviando cierre...' : 'Enviar cierre del día al jefe'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
